"""Request/response models for the API."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class SearchRequest(BaseModel):
    query: str
    # Optional override; if omitted we auto-detect from the query text.
    lang: Optional[str] = None
    # How many papers to retrieve/synthesize this search. Clamped server-side;
    # defaults to MAX_RESULTS when omitted.
    limit: Optional[int] = None
    # Whether to include bioRxiv preprints (not peer-reviewed) in retrieval.
    include_preprints: bool = True
    # "relevance" (default) or "date" (newest first). Applied at the source
    # query, not just to the returned page.
    sort: Optional[str] = None


class SourceCard(BaseModel):
    source: str
    source_id: str
    title: str
    title_zh: str
    authors: list[str]
    year: Optional[int]
    venue: str
    url: str
    doi: str
    citation_key: str
    relevance_zh: str
    # "YYYY", "YYYY-MM" or "YYYY-MM-DD" when the source resolves it; drives
    # date sorting in the UI. Defaulted so older saved-library rows still parse.
    pub_date: str = ""
    # Direct link to a legally free full text, when one exists.
    oa_url: str = ""


class SearchResponse(BaseModel):
    original_query: str
    detected_lang: str
    english_query: str  # what we actually searched with
    answer: str
    sources: list[SourceCard]
    session_id: str = ""  # research-conversation handle for follow-ups
    warning: Optional[str] = None  # e.g. LLM key missing


class ChatRequest(BaseModel):
    session_id: str
    message: str
    lang: Optional[str] = None  # response language; defaults to session's


class ChatResponse(BaseModel):
    answer: str
    sources: list[SourceCard]  # full, updated corpus (metadata only)
    searched: bool  # whether the agent pulled new literature this turn
    search_query: str = ""  # the English query it searched, if any
    warning: Optional[str] = None


# --- Library (saved papers, tags, history) ---


class SavePaperRequest(SourceCard):
    """A SourceCard plus optional initial tags and destination folder."""

    tags: list[str] = []
    folder_id: Optional[int] = None


class SavedPaper(SourceCard):
    id: int
    tags: list[str] = []
    folder_id: Optional[int] = None  # None = unfiled
    created_at: str


class TagUpdate(BaseModel):
    tag: str


class TagCount(BaseModel):
    tag: str
    count: int


class FolderCreate(BaseModel):
    name: str


class Folder(BaseModel):
    id: Optional[int] = None  # None is the synthetic "unfiled" bucket
    name: str
    count: int


class MoveToFolder(BaseModel):
    folder_id: Optional[int] = None  # None moves the paper out of all folders


class HistoryItem(BaseModel):
    id: int
    query: str
    detected_lang: str
    english_query: str
    result_count: int
    created_at: str


# --- Clinical trials ---


class TrialsRequest(BaseModel):
    query: str


class Trial(BaseModel):
    nct_id: str
    title: str
    status: str
    phases: list[str]
    conditions: list[str]
    url: str


class TrialsResponse(BaseModel):
    term: str  # English term actually searched on ClinicalTrials.gov
    trials: list[Trial]
