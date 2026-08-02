"""Library endpoints: saved papers, tagging, and search history."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import db
from ..schemas import HistoryItem, SavedPaper, SavePaperRequest, TagCount, TagUpdate

router = APIRouter(prefix="/api", tags=["library"])


# --- Saved papers ---------------------------------------------------------


@router.post("/library/save", response_model=SavedPaper)
def save_paper(req: SavePaperRequest) -> SavedPaper:
    card = req.model_dump()
    tags = card.pop("tags", [])
    saved = db.save_paper(card, tags)
    return SavedPaper(**saved)


@router.get("/library", response_model=list[SavedPaper])
def list_library(tag: str | None = None) -> list[SavedPaper]:
    return [SavedPaper(**p) for p in db.list_saved(tag)]


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


# --- Search history -------------------------------------------------------


@router.get("/history", response_model=list[HistoryItem])
def list_history(limit: int = 30) -> list[HistoryItem]:
    return [HistoryItem(**h) for h in db.list_history(limit)]


@router.delete("/history")
def clear_history() -> dict:
    db.clear_history()
    return {"ok": True}
