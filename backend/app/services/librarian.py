"""An agent that can actually tidy the library, not just talk about it.

The library chat could already answer questions about saved papers. This lets
it act: create folders, file papers into them, tag things, and write the note
that says why a paper was kept. That last one is the point — a shelf of three
hundred references nobody annotated is a pile, and writing the annotation is
exactly the chore that gets skipped.

**Nothing is applied without being shown first.** Read tools run immediately;
every tool that would change something is *staged* and comes back as a
proposal the reader accepts or ignores. This is not timidity — an agent that
silently re-files someone's library is unusable even when it is right, because
the one time it is wrong there is no way to know what it touched. Staging also
makes the model's plan legible: you see "create 青光眼, move these 8 papers"
before it happens, which is a better explanation than any prose summary.

Folders in a plan are referenced by name rather than id, because a plan
routinely creates a folder and fills it in the same breath, and the id does
not exist until the plan is applied.
"""
from __future__ import annotations

import json

from .. import db
from .llm_service import _get_client, _lang_name, has_llm_key
from ..config import DEEPSEEK_MODEL_PRO

MAX_ROUNDS = 6
MAX_ACTIONS = 200

_SYSTEM = """You are the librarian for a biomedical researcher's reference \
library. You can look at what they have saved and propose changes to how it is \
organised.

RULES
1. Look before you act. Call list_folders and list_papers to see the real \
library before proposing anything — never invent a paper, a folder or an id.
2. Only use paper ids returned by list_papers. Never guess an id.
3. Changes are proposals shown to the user for approval, not edits you have \
made. Say what you propose, not what you have done. Never claim a folder now \
exists or a paper has been moved.
4. Group by research topic, not by year or journal, unless asked otherwise. A \
folder with one paper in it is rarely worth creating.
5. When you write a note for a paper, write what a colleague would need: what \
the study did, what it found, and why this paper is worth keeping. Two or \
three sentences. Never invent findings — you have the title, authors, journal, \
year and the user's own notes, and nothing else. If that is not enough to say \
anything specific, say what the paper appears to be about and no more.
6. `integrity` is "retracted", "concern", or "ok". A retracted paper is not \
evidence. Never recommend reading or keeping one without saying it is \
retracted, and when asked about problem papers, name them. Do not say the \
library is clean unless every paper reads "ok".
7. Reading state (toread / reading / read / cited) says where a paper is in \
the reading of it. Use it when asked what to read next, or to triage a pile: \
propose marking, do not guess that something has been read.
8. If the request is a question rather than a task, just answer it. Not every \
message needs a tool call.
9. Reply in RESPONSE LANGUAGE. Keep it short: the proposed changes are listed \
in the interface, so do not repeat them all in prose."""

# Read tools run for real; write tools are recorded and answered with a stub.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_folders",
            "description": "List the folders in the library, with how many papers each holds.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_papers",
            "description": (
                "List saved papers with their ids. Optionally filter to one folder "
                "or to a text match across title, authors, journal and notes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "Folder name, or 'unfiled' for papers in no folder.",
                    },
                    "q": {"type": "string", "description": "Text to match."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_folder",
            "description": "Propose creating a folder.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "parent": {
                        "type": "string",
                        "description": "Name of the parent folder, for a sub-folder.",
                    },
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_papers",
            "description": (
                "Propose filing papers into a folder. The folder may be one you "
                "proposed creating in this same plan; refer to it by name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "paper_ids": {"type": "array", "items": {"type": "integer"}},
                    "folder": {
                        "type": "string",
                        "description": "Folder name, or 'unfiled' to take them out of all folders.",
                    },
                },
                "required": ["paper_ids", "folder"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_tags",
            "description": "Propose tagging papers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "paper_ids": {"type": "array", "items": {"type": "integer"}},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["paper_ids", "tags"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_note",
            "description": (
                "Propose a note on one paper, summarising it and why it is worth "
                "keeping. Replaces any existing note, so include what matters."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "paper_id": {"type": "integer"},
                    "note": {"type": "string"},
                },
                "required": ["paper_id", "note"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_reading_state",
            "description": (
                "Propose marking where papers are in the reading of them: "
                "toread, reading, read, cited, or empty to clear the mark."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "paper_ids": {"type": "array", "items": {"type": "integer"}},
                    "state": {
                        "type": "string",
                        "enum": ["toread", "reading", "read", "cited", ""],
                    },
                },
                "required": ["paper_ids", "state"],
            },
        },
    },
]

_WRITES = {"create_folder", "move_papers", "add_tags", "write_note", "set_reading_state"}


def _papers_for_prompt(rows: list[dict]) -> list[dict]:
    """What the model sees of a paper: enough to sort it, no abstract."""
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "authors": (r.get("authors") or [])[:3],
            "year": r.get("year"),
            "journal": r.get("venue", ""),
            "tags": r.get("tags") or [],
            "folder_id": r.get("folder_id"),
            "read_state": r.get("read_state") or "unset",
            # Whether the paper has been retracted or had concern expressed.
            # The library has carried this since integrity screening was added
            # and the agent could not see it — so it recommended keeping a
            # retracted paper "as evidence", marked it for reading, and told a
            # reader asking about integrity that the shelf was clean.
            "integrity": r.get("retraction_status") or "ok",
            "note": (r.get("notes") or "")[:300],
        }
        for r in rows
    ]


def _run_read(name: str, args: dict, user: str, team_id: int | None) -> dict:
    if name == "list_folders":
        folders = db.list_folders(user, team_id)
        return {
            "folders": [
                {"id": f["id"], "name": f["name"], "papers": f["count"],
                 "parent_id": f.get("parent_id")}
                for f in folders
            ]
        }
    if name == "list_papers":
        folder = (args.get("folder") or "").strip()
        folder_arg = None
        if folder.lower() == "unfiled":
            folder_arg = "unfiled"
        elif folder:
            match = next(
                (f for f in db.list_folders(user, team_id)
                 if f["id"] is not None and f["name"].lower() == folder.lower()),
                None,
            )
            # An unknown folder name means the model guessed. Say so rather
            # than silently listing the whole library as if it were that folder.
            if match is None:
                return {"error": f"no folder named {folder!r}"}
            folder_arg = str(match["id"])
        rows = db.list_saved(user, folder=folder_arg, q=args.get("q") or None,
                             team_id=team_id)
        return {"papers": _papers_for_prompt(rows[:120]), "total": len(rows)}
    return {"error": f"unknown tool {name}"}


def _stage(name: str, args: dict) -> dict | None:
    """Turn a write call into a proposed action, or None if it is unusable."""
    if name == "create_folder":
        folder_name = (args.get("name") or "").strip()
        return (
            {"kind": "create_folder", "name": folder_name,
             "parent": (args.get("parent") or "").strip() or None}
            if folder_name
            else None
        )
    if name == "move_papers":
        ids = [int(i) for i in (args.get("paper_ids") or []) if str(i).lstrip("-").isdigit()]
        folder = (args.get("folder") or "").strip()
        return {"kind": "move_papers", "paper_ids": ids, "folder": folder} if ids and folder else None
    if name == "add_tags":
        ids = [int(i) for i in (args.get("paper_ids") or []) if str(i).lstrip("-").isdigit()]
        tags = [str(t).strip() for t in (args.get("tags") or []) if str(t).strip()]
        return {"kind": "add_tags", "paper_ids": ids, "tags": tags} if ids and tags else None
    if name == "set_reading_state":
        ids = [int(i) for i in (args.get("paper_ids") or []) if str(i).lstrip("-").isdigit()]
        state = (args.get("state") or "").strip()
        return (
            {"kind": "set_reading_state", "paper_ids": ids, "state": state}
            if ids and state in db.READ_STATES
            else None
        )
    if name == "write_note":
        note = (args.get("note") or "").strip()
        paper_id = args.get("paper_id")
        return (
            {"kind": "write_note", "paper_id": int(paper_id), "note": note}
            if note and isinstance(paper_id, int)
            else None
        )
    return None


def describe(action: dict) -> str:
    """A one-line English label. The UI localises; this is for logs and tests."""
    kind = action.get("kind")
    if kind == "create_folder":
        parent = action.get("parent")
        return f"Create folder “{action['name']}”" + (f" inside “{parent}”" if parent else "")
    if kind == "move_papers":
        return f"File {len(action['paper_ids'])} paper(s) into “{action['folder']}”"
    if kind == "add_tags":
        return f"Tag {len(action['paper_ids'])} paper(s): {', '.join(action['tags'])}"
    if kind == "set_reading_state":
        return f"Mark {len(action['paper_ids'])} paper(s) as {action['state'] or 'unmarked'}"
    if kind == "write_note":
        return f"Write a note on paper {action['paper_id']}"
    return kind or "?"


async def converse(
    user: str,
    message: str,
    lang: str,
    history: list[dict],
    team_id: int | None = None,
) -> dict:
    """One turn. Returns {answer, actions} — actions are proposals, not edits."""
    if not has_llm_key():
        raise RuntimeError("DEEPSEEK_API_KEY not configured")

    messages: list[dict] = [
        {"role": "system", "content": f"{_SYSTEM}\n\nRESPONSE LANGUAGE: {_lang_name(lang)}."}
    ]
    for turn in history[-8:]:
        role = turn.get("role")
        if role in ("user", "assistant") and turn.get("content"):
            messages.append({"role": role, "content": turn["content"]})
    messages.append({"role": "user", "content": message})

    actions: list[dict] = []
    answer = ""
    client = _get_client()

    for _round in range(MAX_ROUNDS):
        resp = await client.chat.completions.create(
            model=DEEPSEEK_MODEL_PRO,
            # Generous, because the pro model's reasoning is billed against
            # this budget — see llm_service._REASONING_HEADROOM.
            max_tokens=16000,
            tools=TOOLS,
            messages=messages,
        )
        choice = resp.choices[0]
        reply = choice.message
        calls = reply.tool_calls or []
        if reply.content:
            answer = reply.content.strip()
        if not calls:
            break

        messages.append(
            {
                "role": "assistant",
                "content": reply.content or "",
                "tool_calls": [
                    {"id": c.id, "type": "function",
                     "function": {"name": c.function.name, "arguments": c.function.arguments}}
                    for c in calls
                ],
            }
        )
        for call in calls:
            name = call.function.name
            try:
                args = json.loads(call.function.arguments or "{}")
            except ValueError:
                args = {}
            if name in _WRITES:
                staged = _stage(name, args)
                if staged and len(actions) < MAX_ACTIONS:
                    actions.append(staged)
                    result = {"staged": True, "note": "shown to the user for approval"}
                else:
                    result = {"staged": False, "error": "incomplete or too many actions"}
            else:
                try:
                    result = _run_read(name, args, user, team_id)
                except Exception as exc:  # noqa: BLE001 - the model can recover
                    result = {"error": f"{type(exc).__name__}"}
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result, ensure_ascii=False)[:12000],
                }
            )

    return {"answer": answer, "actions": actions}


def apply(user: str, actions: list[dict], team_id: int | None = None) -> dict:
    """Carry out approved actions, recording what would put them back.

    Folder names are resolved here rather than in the plan, and creations run
    first, so "make a folder and put these in it" works as one approval. Every
    call is scoped to the user by the db layer, so an action naming someone
    else's paper id fails rather than reaching across libraries.

    The inverse is built from what was actually there a moment before each
    change, not from what the action assumed — a paper the plan thought was
    unfiled may have been moved since, and putting it back where it really was
    is the only undo worth having. A folder is only removed on undo if this run
    is what created it.
    """
    done: list[str] = []
    failed: list[str] = []
    inverse: list[dict] = []

    def folder_id_for(name: str) -> int | None:
        if not name or name.lower() == "unfiled":
            return None
        for folder in db.list_folders(user, team_id):
            if folder["id"] is not None and folder["name"].lower() == name.lower():
                return folder["id"]
        return None

    ordered = (
        [a for a in actions if a.get("kind") == "create_folder"]
        + [a for a in actions if a.get("kind") != "create_folder"]
    )

    for action in ordered[:MAX_ACTIONS]:
        kind = action.get("kind")
        label = describe(action)
        try:
            if kind == "create_folder":
                parent = action.get("parent")
                existed = folder_id_for(action["name"])
                created = db.create_folder(
                    user, action["name"], team_id, folder_id_for(parent) if parent else None
                )
                if created and not existed:
                    inverse.append({"op": "rmfolder", "folder_id": created["id"]})
                # A name already in use is the desired end state, not a failure.
                (done if created or existed else failed).append(label)

            elif kind == "move_papers":
                target = action["folder"]
                fid = folder_id_for(target)
                if fid is None and target.lower() != "unfiled":
                    failed.append(label)
                    continue
                before = db.paper_snapshot(user, action["paper_ids"], team_id)
                moved = 0
                for pid in action["paper_ids"]:
                    if db.set_paper_folder(user, int(pid), fid, team_id):
                        moved += 1
                        was = before.get(int(pid), {})
                        inverse.append(
                            {"op": "folder", "paper_id": int(pid),
                             "folder_id": was.get("folder_id")}
                        )
                (done if moved else failed).append(label)

            elif kind == "add_tags":
                before = db.paper_snapshot(user, action["paper_ids"], team_id)
                added = 0
                for pid in action["paper_ids"]:
                    had = set(before.get(int(pid), {}).get("tags") or [])
                    for tag in action["tags"]:
                        if db.add_tag(user, int(pid), tag, team_id):
                            added += 1
                            # Only remove on undo what was not already there.
                            if tag not in had:
                                inverse.append(
                                    {"op": "untag", "paper_id": int(pid), "tag": tag}
                                )
                (done if added else failed).append(label)

            elif kind == "write_note":
                pid = int(action["paper_id"])
                before = db.paper_snapshot(user, [pid], team_id).get(pid, {})
                ok = db.set_notes(user, pid, action["note"], team_id)
                if ok:
                    inverse.append(
                        {"op": "note", "paper_id": pid, "note": before.get("notes", "")}
                    )
                (done if ok else failed).append(label)

            elif kind == "set_reading_state":
                before = db.paper_snapshot(user, action["paper_ids"], team_id)
                marked = 0
                for pid in action["paper_ids"]:
                    if db.set_read_state(user, int(pid), action["state"], team_id):
                        marked += 1
                        inverse.append(
                            {"op": "state", "paper_id": int(pid),
                             "state": before.get(int(pid), {}).get("read_state", "")}
                        )
                (done if marked else failed).append(label)

            else:
                failed.append(label)
        except Exception:  # noqa: BLE001 - one bad action is not the plan
            failed.append(label)

    undo_id = None
    if inverse:
        try:
            undo_id = db.record_undo(
                user, team_id, "; ".join(done)[:200] or "library changes", inverse
            )
        except Exception:  # noqa: BLE001 - the changes landed; the undo is a bonus
            undo_id = None

    return {
        "applied": len(done),
        "failed": len(failed),
        "details": done + failed,
        "undo_id": undo_id,
    }


def undo(user: str, undo_id: int) -> dict:
    """Put the library back. Returns how much of it went back.

    Applied in reverse, so a folder created and filled in one plan is emptied
    before it is removed — a folder still holding papers would refuse to go, or
    worse, take them with it.
    """
    record = db.get_undo(user, undo_id)
    if record is None:
        return {"reverted": 0, "failed": 0, "missing": True}
    if record.get("undone_at"):
        return {"reverted": 0, "failed": 0, "already": True}

    team_id = record.get("team_id")
    reverted = 0
    failed = 0
    for op in reversed(record["inverse"]):
        kind = op.get("op")
        try:
            if kind == "folder":
                ok = db.set_paper_folder(user, op["paper_id"], op["folder_id"], team_id)
            elif kind == "note":
                ok = db.set_notes(user, op["paper_id"], op["note"], team_id)
            elif kind == "untag":
                ok = db.remove_tag(user, op["paper_id"], op["tag"], team_id)
            elif kind == "state":
                ok = db.set_read_state(user, op["paper_id"], op["state"], team_id)
            elif kind == "rmfolder":
                ok = db.delete_folder(user, op["folder_id"], team_id)
            else:
                ok = False
        except Exception:  # noqa: BLE001
            ok = False
        reverted += bool(ok)
        failed += not ok

    db.mark_undone(user, undo_id)
    return {"reverted": reverted, "failed": failed}
