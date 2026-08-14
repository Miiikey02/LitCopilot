"""Library endpoints: saved papers, tagging, and search history."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..auth import current_user
from ..schemas import (
    FolderMove,
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
    LocalMatch,
    LocalMatchRequest,
    LocalMatchResponse,
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
from ..services import librarian, llm_service

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
    user: str = Depends(current_user),
) -> list[SavedPaper]:
    """List saved papers; `folder` is a folder id or "unfiled", `q` free text."""
    return [SavedPaper(**p) for p in _guard(db.list_saved, user, tag, folder, q, team)]


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
        result = await librarian.converse(
            user, message, lang, req.history, req.team_id
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
