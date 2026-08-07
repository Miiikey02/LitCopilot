"""Library endpoints: saved papers, tagging, and search history."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import db
from ..schemas import (
    Folder,
    FolderCreate,
    HistoryItem,
    MoveToFolder,
    SavedPaper,
    SavePaperRequest,
    TagCount,
    TagUpdate,
)

router = APIRouter(prefix="/api", tags=["library"])


# --- Saved papers ---------------------------------------------------------


@router.post("/library/save", response_model=SavedPaper)
def save_paper(req: SavePaperRequest) -> SavedPaper:
    card = req.model_dump()
    tags = card.pop("tags", [])
    folder_id = card.pop("folder_id", None)
    saved = db.save_paper(card, tags, folder_id)
    return SavedPaper(**saved)


@router.get("/library", response_model=list[SavedPaper])
def list_library(
    tag: str | None = None, folder: str | None = None
) -> list[SavedPaper]:
    """List saved papers; `folder` is a folder id or "unfiled"."""
    return [SavedPaper(**p) for p in db.list_saved(tag, folder)]


@router.delete("/library/{paper_id}")
def delete_paper(paper_id: int) -> dict:
    if not db.delete_saved(paper_id):
        raise HTTPException(status_code=404, detail="Paper not found")
    return {"ok": True}


@router.post("/library/{paper_id}/tags")
def add_tag(paper_id: int, body: TagUpdate) -> dict:
    if not db.add_tag(paper_id, body.tag):
        raise HTTPException(status_code=404, detail="Paper not found or empty tag")
    return {"ok": True}


@router.delete("/library/{paper_id}/tags/{tag}")
def remove_tag(paper_id: int, tag: str) -> dict:
    if not db.remove_tag(paper_id, tag):
        raise HTTPException(status_code=404, detail="Tag not found on paper")
    return {"ok": True}


@router.get("/library/tags", response_model=list[TagCount])
def list_tags() -> list[TagCount]:
    return [TagCount(**t) for t in db.list_tags()]


# --- Folders --------------------------------------------------------------


@router.post("/folders", response_model=Folder)
def create_folder(req: FolderCreate) -> Folder:
    created = db.create_folder(req.name)
    if created is None:
        raise HTTPException(
            status_code=409, detail="Folder name is empty or already exists"
        )
    return Folder(**created)


@router.get("/folders", response_model=list[Folder])
def list_folders() -> list[Folder]:
    return [Folder(**f) for f in db.list_folders()]


@router.patch("/folders/{folder_id}")
def rename_folder(folder_id: int, req: FolderCreate) -> dict:
    if not db.rename_folder(folder_id, req.name):
        raise HTTPException(
            status_code=409, detail="Folder not found, or name empty/taken"
        )
    return {"ok": True}


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int) -> dict:
    """Delete a folder; its papers are kept and become unfiled."""
    if not db.delete_folder(folder_id):
        raise HTTPException(status_code=404, detail="Folder not found")
    return {"ok": True}


@router.put("/library/{paper_id}/folder")
def move_paper(paper_id: int, req: MoveToFolder) -> dict:
    if not db.set_paper_folder(paper_id, req.folder_id):
        raise HTTPException(status_code=404, detail="Paper or folder not found")
    return {"ok": True}


# --- Search history -------------------------------------------------------


@router.get("/history", response_model=list[HistoryItem])
def list_history(limit: int = 30) -> list[HistoryItem]:
    return [HistoryItem(**h) for h in db.list_history(limit)]


@router.delete("/history")
def clear_history() -> dict:
    db.clear_history()
    return {"ok": True}
