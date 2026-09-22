"""Library endpoints: saved papers, tagging, and search history."""
from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from .. import db
from ..auth import current_user
from ..schemas import (
    FolderMove,
    FolderWatch,
    WatchChecked,
    WatchCreate,
    WatchHit,
    WatchUpdate,
    MemberRole,
    Conversation,
    ConversationRename,
    ConversationSummary,
    Folder,
    FolderCreate,
    HistoryItem,
    LibraryChatRequest,
    LibraryChatResponse,
    LibrarianApplied,
    LibrarianApply,
    LibrarianRequest,
    LibrarianResponse,
    LibraryUndone,
    NoteVersion,
    UndoBatch,
    ReadState,
    LocalMatch,
    LocalMatchRequest,
    LocalMatchResponse,
    Assistant,
    AssistantCreate,
    AssistantUpdate,
    Record,
    RecordCreate,
    RecordDraft,
    RecordDraftRequest,
    RecordUpdate,
    Skill,
    SkillCreate,
    SkillDraft,
    SkillDraftRequest,
    SkillUpdate,
    MoveToFolder,
    NotesUpdate,
    SavedPaper,
    SavePaperRequest,
    TagCount,
    TagUpdate,
    Team,
    TeamCreate,
    TeamJoin,
    TeamMember,
)
from ..services import librarian, llm_service, watches

router = APIRouter(prefix="/api", tags=["library"])


def _guard(fn, *args, **kwargs):
    """Run a db call, turning a non-member team access into a clean 403."""
    try:
        return fn(*args, **kwargs)
    except db.NotAMember:
        raise HTTPException(status_code=403, detail="Not a member of this team")
    except db.NotPermitted as exc:
        raise HTTPException(status_code=403, detail=str(exc))


# --- Saved papers ---------------------------------------------------------


@router.post("/library/save", response_model=SavedPaper)
def save_paper(
    req: SavePaperRequest, user: str = Depends(current_user)
) -> SavedPaper:
    card = req.model_dump()
    tags = card.pop("tags", [])
    folder_id = card.pop("folder_id", None)
    team_id = card.pop("team_id", None)
    saved = _guard(db.save_paper, user, card, tags, folder_id, team_id)
    return SavedPaper(**saved)


@router.get("/library", response_model=list[SavedPaper])
def list_library(
    tag: str | None = None,
    folder: str | None = None,
    q: str | None = None,
    team: int | None = None,
    state: str | None = None,
    user: str = Depends(current_user),
) -> list[SavedPaper]:
    """List saved papers.

    `folder` is a folder id or "unfiled", `q` is free text, and `state` filters
    by reading state — "unset" for the pile nobody has triaged yet.
    """
    return [
        SavedPaper(**p)
        for p in _guard(db.list_saved, user, tag, folder, q, team, state)
    ]


@router.patch("/library/{paper_id}/state")
def set_read_state(
    paper_id: int,
    body: ReadState,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    """Mark where this paper is in the reading of it."""
    if not _guard(db.set_read_state, user, paper_id, body.state, team):
        raise HTTPException(status_code=404, detail="Paper not found or bad state")
    return {"ok": True}


@router.get("/library/states")
def read_state_counts(
    team: int | None = None, user: str = Depends(current_user)
) -> dict:
    return _guard(db.read_state_counts, user, team)


@router.patch("/library/{paper_id}/notes")
def set_notes(
    paper_id: int,
    body: NotesUpdate,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    if not _guard(db.set_notes, user, paper_id, body.notes, team):
        raise HTTPException(status_code=404, detail="Paper not found")
    return {"ok": True}


@router.get("/library/{paper_id}/notes/history", response_model=list[NoteVersion])
def note_history(
    paper_id: int, team: int | None = None, user: str = Depends(current_user)
) -> list[NoteVersion]:
    """Every change to this paper's note, newest first, and who made it."""
    rows = _guard(db.note_history, user, paper_id, team)
    if rows is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    return [NoteVersion(**r) for r in rows]


@router.delete("/library/{paper_id}")
def delete_paper(
    paper_id: int, team: int | None = None, user: str = Depends(current_user)
) -> dict:
    if not _guard(db.delete_saved, user, paper_id, team):
        raise HTTPException(status_code=404, detail="Paper not found")
    return {"ok": True}


@router.post("/library/{paper_id}/tags")
def add_tag(
    paper_id: int,
    body: TagUpdate,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    if not _guard(db.add_tag, user, paper_id, body.tag, team):
        raise HTTPException(status_code=404, detail="Paper not found or empty tag")
    return {"ok": True}


@router.delete("/library/{paper_id}/tags/{tag}")
def remove_tag(
    paper_id: int,
    tag: str,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    if not _guard(db.remove_tag, user, paper_id, tag, team):
        raise HTTPException(status_code=404, detail="Tag not found on paper")
    return {"ok": True}


@router.get("/library/tags", response_model=list[TagCount])
def list_tags(
    team: int | None = None, user: str = Depends(current_user)
) -> list[TagCount]:
    return [TagCount(**t) for t in _guard(db.list_tags, user, team)]


# --- Chat with your library -----------------------------------------------


@router.post("/library/chat", response_model=LibraryChatResponse)
async def library_chat(
    req: LibraryChatRequest, user: str = Depends(current_user)
) -> LibraryChatResponse:
    """Answer a question grounded only in this user's saved papers.

    Optionally scoped to one folder. Note that saved rows hold metadata and
    notes, never abstract text, so the model is told to work within that.
    """
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Empty message")

    lang = req.lang or llm_service.detect_language(message)
    papers = _guard(db.list_saved, user, None, req.folder, None, req.team_id)

    if not llm_service.has_llm_key():
        return LibraryChatResponse(
            answer="",
            paper_count=len(papers),
            warning=(
                "未配置 DEEPSEEK_API_KEY，无法与文库对话。"
                if lang == "zh"
                else "DEEPSEEK_API_KEY is not configured; library chat is unavailable."
            ),
        )
    try:
        answer = await llm_service.answer_from_library(
            papers, message, lang, req.history
        )
    except Exception:  # noqa: BLE001 - keep the API responsive on LLM errors
        return LibraryChatResponse(
            answer="",
            paper_count=len(papers),
            conversation_id=req.conversation_id,
            warning=(
                "回答生成失败（可能是密钥无效、额度不足或网络问题），请稍后重试。"
                if lang == "zh"
                else "Failed to generate a reply (invalid key, quota, or network). Please retry."
            ),
        )

    # Persist the exchange so the thread can be reopened later. Failing to save
    # must not lose the answer the user is waiting for.
    conversation_id = req.conversation_id
    try:
        if conversation_id is None:
            conversation_id = db.create_conversation(
                user, "library", message, team_id=req.team_id
            )
        db.append_messages(
            user,
            conversation_id,
            [{"role": "user", "content": message},
             {"role": "assistant", "content": answer}],
        )
    except Exception:  # noqa: BLE001
        pass

    return LibraryChatResponse(
        answer=answer, paper_count=len(papers), conversation_id=conversation_id
    )


# --- Matching a local folder of PDFs against the library -------------------

# Titles are compared with punctuation, case and spacing removed. Publishers
# disagree about hyphens, capitalisation and trailing full stops for the same
# paper, and a PDF's own metadata title is often the copy-editor's version.
_TITLE_NOISE = re.compile(r"[^a-z0-9\u4e00-\u9fff]+")


def _norm(title: str) -> str:
    return _TITLE_NOISE.sub("", (title or "").lower())[:120]


@router.post("/library/match-local", response_model=LocalMatchResponse)
def match_local(
    req: LocalMatchRequest, user: str = Depends(current_user)
) -> LocalMatchResponse:
    """Say which of these local PDFs are papers the library already holds.

    Only what the browser could read out of each file is sent — a DOI and a
    title. No path, no bytes: the folder stays on the reader's machine and the
    server is told nothing about where it is.
    """
    papers = _guard(db.list_saved, user, team_id=req.team_id)
    folders = {
        f["id"]: f["name"] for f in _guard(db.list_folders, user, req.team_id)
        if f["id"] is not None
    }
    by_doi = {(p.get("doi") or "").lower(): p for p in papers if p.get("doi")}
    by_title = {_norm(p.get("title")): p for p in papers if p.get("title")}

    def card(paper: dict, key: str = "", matched_on: str = "") -> LocalMatch:
        return LocalMatch(
            key=key,
            paper_id=paper["id"],
            citation_key=paper.get("citation_key") or "",
            title=paper.get("title") or "",
            year=paper.get("year"),
            folder=folders.get(paper.get("folder_id"), ""),
            matched_on=matched_on,
        )

    matches: list[LocalMatch] = []
    accounted: set[int] = set()
    for f in req.files:
        paper = by_doi.get((f.doi or "").lower()) if f.doi else None
        how = "doi" if paper else ""
        if paper is None and f.title:
            paper = by_title.get(_norm(f.title))
            how = "title" if paper else ""
        if paper is None:
            matches.append(LocalMatch(key=f.key))
            continue
        accounted.add(paper["id"])
        matches.append(card(paper, f.key, how))

    missing = [card(p) for p in papers if p["id"] not in accounted]
    return LocalMatchResponse(matches=matches, missing=missing)


# --- The librarian agent --------------------------------------------------


@router.post("/library/agent", response_model=LibrarianResponse)
async def library_agent(
    req: LibrarianRequest, user: str = Depends(current_user)
) -> LibrarianResponse:
    """Ask the agent to organise or annotate the library.

    It returns proposals, never edits. Applying them is a second, explicit
    call — see /library/agent/apply.
    """
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Nothing to do")
    lang = req.lang or llm_service.detect_language(message)
    if not llm_service.has_llm_key():
        return LibrarianResponse(
            warning=(
                "未配置 DEEPSEEK_API_KEY，整理助手不可用。"
                if lang == "zh"
                else "DEEPSEEK_API_KEY is not configured; the librarian is unavailable."
            )
        )
    try:
        skill = (
            db.get_skill(user, req.skill_id, req.team_id) if req.skill_id else None
        )
        result = await librarian.converse(
            user, message, lang, req.history, req.team_id, skill, req.assistant
        )
    except db.NotAMember:
        raise HTTPException(status_code=403, detail="Not a member of this team")
    except Exception:  # noqa: BLE001
        return LibrarianResponse(
            warning=(
                "整理助手暂时不可用，请稍后重试。"
                if lang == "zh"
                else "The librarian is unavailable right now. Please retry."
            )
        )
    return LibrarianResponse(**result)


@router.post("/library/agent/apply", response_model=LibrarianApplied)
def library_agent_apply(
    req: LibrarianApply, user: str = Depends(current_user)
) -> LibrarianApplied:
    """Carry out the proposals the reader approved."""
    actions = [a.model_dump() for a in req.actions]
    if not actions:
        return LibrarianApplied()
    return LibrarianApplied(**_guard(librarian.apply, user, actions, req.team_id))


@router.get("/library/undo", response_model=list[UndoBatch])
def list_undo(team: int | None = None, user: str = Depends(current_user)) -> list[UndoBatch]:
    """Recent agent changes the caller may reverse — everyone's, for a 负责人."""
    return [UndoBatch(**b) for b in _guard(db.list_undo, user, team)]


@router.post("/library/undo/{undo_id}", response_model=LibraryUndone)
def library_undo(undo_id: int, user: str = Depends(current_user)) -> LibraryUndone:
    """Put the library back as it was before that batch of changes."""
    return LibraryUndone(**_guard(librarian.undo, user, undo_id))


# --- Assistants -----------------------------------------------------------


@router.get("/assistants", response_model=list[Assistant])
def list_assistants(
    team: int | None = None, lang: str | None = None,
    user: str = Depends(current_user),
) -> list[Assistant]:
    """The three built in, then any this person made or was shared."""
    built = [Assistant(**a) for a in librarian.builtin_list(lang or "zh")]
    mine = [
        Assistant(
            id=a["id"], name=a["name"], description=a["description"],
            toolsets=a["toolsets"], builtin=False,
            instructions=a["instructions"], shared=a["shared"],
        )
        for a in _guard(db.list_assistants, user, team)
    ]
    return built + mine


@router.post("/assistants", response_model=Assistant)
def create_assistant(req: AssistantCreate, user: str = Depends(current_user)) -> Assistant:
    made = _guard(
        db.create_assistant, user, req.name, req.description, req.instructions,
        req.toolsets, req.team_id, req.shared,
    )
    if made is None:
        raise HTTPException(
            status_code=400, detail="助手需要名称和说明，且最多创建 20 个。"
        )
    return Assistant(**made)


@router.patch("/assistants/{assistant_id}")
def update_assistant(
    assistant_id: int, req: AssistantUpdate, user: str = Depends(current_user)
) -> dict:
    if not _guard(db.update_assistant, user, assistant_id,
                  **req.model_dump(exclude_none=True)):
        raise HTTPException(status_code=404, detail="Assistant not found")
    return {"ok": True}


@router.delete("/assistants/{assistant_id}")
def delete_assistant(assistant_id: int, user: str = Depends(current_user)) -> dict:
    if not _guard(db.delete_assistant, user, assistant_id):
        raise HTTPException(status_code=404, detail="Assistant not found")
    return {"ok": True}


# --- Experiment records ---------------------------------------------------


@router.get("/records", response_model=list[Record])
def list_records(
    team: int | None = None, q: str | None = None,
    user: str = Depends(current_user),
) -> list[Record]:
    return [Record(**r) for r in _guard(db.list_records, user, team, q)]


@router.post("/records", response_model=Record)
def create_record(req: RecordCreate, user: str = Depends(current_user)) -> Record:
    made = _guard(db.create_record, user, req.team_id,
                  **req.model_dump(exclude={"team_id"}))
    if made is None:
        raise HTTPException(status_code=400, detail="A record needs a title")
    return Record(**made)


@router.post("/records/draft", response_model=RecordDraft)
async def draft_record(
    req: RecordDraftRequest, user: str = Depends(current_user)
) -> RecordDraft:
    """Turn a rough note into a complete record, without inventing anything."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to write from")
    lang = req.lang or llm_service.detect_language(text)
    try:
        return RecordDraft(**await librarian.draft_record(user, text, lang, req.team_id))
    except db.NotAMember:
        raise HTTPException(status_code=403, detail="Not a member of this team")
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="Could not draft a record")


@router.patch("/records/{record_id}")
def update_record(
    record_id: int, req: RecordUpdate, user: str = Depends(current_user)
) -> dict:
    if not _guard(db.update_record, user, record_id, **req.model_dump(exclude_none=True)):
        raise HTTPException(status_code=404, detail="Record not found")
    return {"ok": True}


@router.delete("/records/{record_id}")
def delete_record(record_id: int, user: str = Depends(current_user)) -> dict:
    if not _guard(db.delete_record, user, record_id):
        raise HTTPException(status_code=404, detail="Record not found")
    return {"ok": True}


# --- Skills: the lab's own conventions, written down ------------------------


@router.get("/skills", response_model=list[Skill])
def list_skills(
    team: int | None = None, user: str = Depends(current_user)
) -> list[Skill]:
    return [Skill(**s) for s in _guard(db.list_skills, user, team)]


@router.post("/skills", response_model=Skill)
def create_skill(req: SkillCreate, user: str = Depends(current_user)) -> Skill:
    made = _guard(
        db.create_skill, user, req.name, req.description, req.instructions,
        req.team_id, req.shared,
    )
    if made is None:
        raise HTTPException(
            status_code=400,
            detail="技能需要名称和内容，且最多保存 40 个。",
        )
    return Skill(**made)


@router.patch("/skills/{skill_id}")
def update_skill(
    skill_id: int, req: SkillUpdate, user: str = Depends(current_user)
) -> dict:
    if not _guard(db.update_skill, user, skill_id, **req.model_dump(exclude_none=True)):
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"ok": True}


@router.delete("/skills/{skill_id}")
def delete_skill(skill_id: int, user: str = Depends(current_user)) -> dict:
    if not _guard(db.delete_skill, user, skill_id):
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"ok": True}


@router.post("/skills/draft", response_model=SkillDraft)
async def draft_skill(
    req: SkillDraftRequest, user: str = Depends(current_user)
) -> SkillDraft:
    """Turn a description — or a transcript of what just worked — into a skill."""
    text = req.description.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to draft from")
    lang = req.lang or llm_service.detect_language(text)
    try:
        return SkillDraft(**await librarian.draft_skill(text, lang))
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="Could not draft a skill")


# --- Saved conversations ---------------------------------------------------


@router.patch("/teams/{team_id}/members/{member_id}")
def set_member_role(
    team_id: int, member_id: str, body: MemberRole, user: str = Depends(current_user)
) -> dict:
    """Promote or demote a member. Owners only."""
    ok = _guard(db.set_member_role, user, team_id, member_id, body.role)
    if not ok:
        raise HTTPException(status_code=404, detail="Member not found")
    return {"ok": True}


@router.get("/conversations", response_model=list[ConversationSummary])
def list_conversations(
    kind: str | None = None,
    team: int | None = None,
    scope: str | None = None,
    q: str | None = None,
    user: str = Depends(current_user),
) -> list[ConversationSummary]:
    """Saved threads. `scope=workspace` narrows to the given workspace.

    `q` searches within them — the question asked, every message, and the
    papers cited — rather than only the titles shown in the rail.
    """
    return [
        ConversationSummary(**c)
        for c in db.list_conversations(
            user, kind, team_id=team, scope_team=(scope == "workspace"), q=q
        )
    ]


@router.get("/conversations/{conversation_id}", response_model=Conversation)
def get_conversation(
    conversation_id: int, user: str = Depends(current_user)
) -> Conversation:
    found = db.get_conversation(user, conversation_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return Conversation(**found)


@router.patch("/conversations/{conversation_id}")
def rename_conversation(
    conversation_id: int, body: ConversationRename, user: str = Depends(current_user)
) -> dict:
    if not db.rename_conversation(user, conversation_id, body.title):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"ok": True}


@router.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: int, user: str = Depends(current_user)
) -> dict:
    if not db.delete_conversation(user, conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"ok": True}


# --- Folders --------------------------------------------------------------


@router.post("/folders", response_model=Folder)
def create_folder(
    req: FolderCreate, team: int | None = None, user: str = Depends(current_user)
) -> Folder:
    created = _guard(db.create_folder, user, req.name, team, req.parent_id)
    if created is None:
        raise HTTPException(
            status_code=409, detail="Folder name is empty or already exists"
        )
    return Folder(**created)


@router.put("/folders/{folder_id}/parent")
def move_folder(
    folder_id: int,
    body: FolderMove,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    """Nest a folder under another, or move it back to the top level."""
    if not _guard(db.move_folder, user, folder_id, body.parent_id, team):
        raise HTTPException(status_code=404, detail="Folder not found")
    return {"ok": True}


@router.get("/folders", response_model=list[Folder])
def list_folders(
    team: int | None = None, user: str = Depends(current_user)
) -> list[Folder]:
    return [Folder(**f) for f in _guard(db.list_folders, user, team)]


@router.patch("/folders/{folder_id}")
def rename_folder(
    folder_id: int,
    req: FolderCreate,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    if not _guard(db.rename_folder, user, folder_id, req.name, team):
        raise HTTPException(
            status_code=409, detail="Folder not found, or name empty/taken"
        )
    return {"ok": True}


@router.delete("/folders/{folder_id}")
def delete_folder(
    folder_id: int, team: int | None = None, user: str = Depends(current_user)
) -> dict:
    """Delete a folder; its papers are kept and become unfiled."""
    if not _guard(db.delete_folder, user, folder_id, team):
        raise HTTPException(status_code=404, detail="Folder not found")
    return {"ok": True}


@router.put("/library/{paper_id}/folder")
def move_paper(
    paper_id: int,
    req: MoveToFolder,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    if not _guard(db.set_paper_folder, user, paper_id, req.folder_id, team):
        raise HTTPException(status_code=404, detail="Paper or folder not found")
    return {"ok": True}


# --- Folder watches -----------------------------------------------------


@router.post("/folders/{folder_id}/watch", response_model=FolderWatch)
async def watch_folder(
    folder_id: int,
    body: WatchCreate,
    team: int | None = None,
    user: str = Depends(current_user),
) -> FolderWatch:
    """Start following a folder's field, and look for the first time now.

    The first check runs before answering, so switching it on shows either
    papers or an honest "nothing this month" — not a promise to look later.
    """
    ctx = await asyncio.to_thread(_guard, db.folder_context, user, folder_id, team)
    if ctx is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    query = body.query.strip()
    if not query:
        try:
            query = await llm_service.watch_query(ctx["name"], ctx["titles"])
        except Exception:  # noqa: BLE001 - the name is still a search
            query = ctx["name"]
    made = await asyncio.to_thread(
        _guard, db.create_watch, user, folder_id, team, query, body.lang, body.every_days
    )
    claimed = await asyncio.to_thread(db.claim_watch, user, made["id"], team)
    try:
        await watches.check(claimed)
    except Exception:  # noqa: BLE001 - recorded as last_error, shown in the panel
        pass
    return FolderWatch(
        **next(w for w in db.list_watches(user, team) if w["id"] == made["id"])
    )


@router.get("/watches", response_model=list[FolderWatch])
def list_watches(
    background: BackgroundTasks,
    team: int | None = None,
    user: str = Depends(current_user),
) -> list[FolderWatch]:
    # Opening the library is also the timer's backup: a server that slept
    # through the night catches up the moment someone looks.
    background.add_task(watches.run_due)
    return [FolderWatch(**w) for w in _guard(db.list_watches, user, team)]


@router.patch("/watches/{watch_id}")
def update_watch(
    watch_id: int,
    body: WatchUpdate,
    team: int | None = None,
    user: str = Depends(current_user),
) -> dict:
    query = body.query.strip() if body.query else None
    if not query and not body.every_days:
        raise HTTPException(status_code=422, detail="Nothing to change")
    if not _guard(db.update_watch, user, watch_id, team, query, body.every_days):
        raise HTTPException(status_code=404, detail="Watch not found")
    return {"ok": True}


@router.delete("/watches/{watch_id}")
def delete_watch(
    watch_id: int, team: int | None = None, user: str = Depends(current_user)
) -> dict:
    if not _guard(db.delete_watch, user, watch_id, team):
        raise HTTPException(status_code=404, detail="Watch not found")
    return {"ok": True}


@router.post("/watches/{watch_id}/check", response_model=WatchChecked)
async def check_watch(
    watch_id: int, team: int | None = None, user: str = Depends(current_user)
) -> WatchChecked:
    claimed = await asyncio.to_thread(_guard, db.claim_watch, user, watch_id, team)
    if claimed is None:
        raise HTTPException(status_code=404, detail="Watch not found")
    try:
        return WatchChecked(added=await watches.check(claimed))
    except Exception as exc:  # noqa: BLE001
        return WatchChecked(added=0, error=type(exc).__name__)


@router.get("/watches/{watch_id}/hits", response_model=list[WatchHit])
def list_watch_hits(
    watch_id: int,
    order: str = "score",
    team: int | None = None,
    user: str = Depends(current_user),
) -> list[WatchHit]:
    """`order` is "score" (fit and quality, best first) or "date"."""
    hits = _guard(
        db.list_watch_hits, user, watch_id, team, "date" if order == "date" else "score"
    )
    if hits is None:
        raise HTTPException(status_code=404, detail="Watch not found")
    return [WatchHit(**h) for h in hits]


@router.get("/watches/{watch_id}/history", response_model=list[WatchHit])
def watch_history(
    watch_id: int,
    offset: int = 0,
    team: int | None = None,
    user: str = Depends(current_user),
) -> list[WatchHit]:
    hits = _guard(db.watch_history, user, watch_id, team, max(0, offset))
    if hits is None:
        raise HTTPException(status_code=404, detail="Watch not found")
    return [WatchHit(**h) for h in hits]


@router.post("/watches/hits/{hit_id}/save", response_model=SavedPaper)
def save_watch_hit(
    hit_id: int, team: int | None = None, user: str = Depends(current_user)
) -> SavedPaper:
    """File a finding into the folder that found it."""
    hit = _guard(db.settle_watch_hit, user, hit_id, "saved", team)
    if hit is None:
        raise HTTPException(status_code=404, detail="Finding not found")
    return SavedPaper(**_guard(db.save_paper, user, hit["card"], [], hit["folder_id"], team))


@router.delete("/watches/hits/{hit_id}")
def dismiss_watch_hit(
    hit_id: int, team: int | None = None, user: str = Depends(current_user)
) -> dict:
    if _guard(db.settle_watch_hit, user, hit_id, "dismissed", team) is None:
        raise HTTPException(status_code=404, detail="Finding not found")
    return {"ok": True}


# --- Teams (shared lab workspaces) ----------------------------------------


@router.post("/teams", response_model=Team)
def create_team(req: TeamCreate, user: str = Depends(current_user)) -> Team:
    created = db.create_team(user, req.name)
    if created is None:
        raise HTTPException(status_code=422, detail="Team name is required")
    return Team(**created)


@router.get("/teams", response_model=list[Team])
def list_teams(user: str = Depends(current_user)) -> list[Team]:
    return [Team(**t) for t in db.list_teams(user)]


@router.post("/teams/join", response_model=Team)
def join_team(req: TeamJoin, user: str = Depends(current_user)) -> Team:
    joined = db.join_team(user, req.invite_code)
    if joined is None:
        raise HTTPException(status_code=404, detail="No team with that invite code")
    return Team(**joined)


@router.get("/teams/{team_id}/members", response_model=list[TeamMember])
def list_members(team_id: int, user: str = Depends(current_user)) -> list[TeamMember]:
    return [TeamMember(**m) for m in _guard(db.list_members, user, team_id)]


@router.patch("/teams/{team_id}")
def rename_team(
    team_id: int, req: TeamCreate, user: str = Depends(current_user)
) -> dict:
    if not db.rename_team(user, team_id, req.name):
        raise HTTPException(status_code=403, detail="Only the owner can rename a team")
    return {"ok": True}


@router.delete("/teams/{team_id}")
def delete_team(team_id: int, user: str = Depends(current_user)) -> dict:
    """Disband a team. Its shared papers and folders go with it."""
    if not db.delete_team(user, team_id):
        raise HTTPException(status_code=403, detail="Only the owner can delete a team")
    return {"ok": True}


@router.delete("/teams/{team_id}/members/{member_id}")
def remove_member(
    team_id: int, member_id: str, user: str = Depends(current_user)
) -> dict:
    """Leave a team, or (as owner) remove someone. Pass "me" to leave."""
    target = None if member_id == "me" else member_id
    if not db.leave_team(user, team_id, target):
        raise HTTPException(
            status_code=403,
            detail="Not permitted (the owner must delete the team instead of leaving)",
        )
    return {"ok": True}


# --- Search history -------------------------------------------------------


@router.get("/history", response_model=list[HistoryItem])
def list_history(
    limit: int = 30, user: str = Depends(current_user)
) -> list[HistoryItem]:
    return [HistoryItem(**h) for h in db.list_history(user, limit)]


@router.delete("/history")
def clear_history(user: str = Depends(current_user)) -> dict:
    db.clear_history(user)
    return {"ok": True}
