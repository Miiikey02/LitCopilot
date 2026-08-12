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
    # Which databases to search. None searches all of them.
    sources: Optional[list[str]] = None
    # Re-running the same question (a mode or database switch) updates this
    # thread instead of filing another one for the same piece of work.
    conversation_id: Optional[int] = None


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
    # "" | "retracted" | "concern" — research-integrity warning for the card.
    retraction_status: str = ""
    # Study design assigned during deep research ("rct", "cohort", ...).
    evidence_type: str = ""
    # Whether the brief was written from this paper's full text or its abstract.
    has_full_text: bool = False


class SearchResponse(BaseModel):
    conversation_id: Optional[int] = None  # the saved, reopenable thread
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
    # Set when the reader accepts the offer to go and find more literature.
    force_search: bool = False
    lang: Optional[str] = None  # response language; defaults to session's
    # Continue an existing saved thread; omitted starts a new one.
    conversation_id: Optional[int] = None


class ChatResponse(BaseModel):
    answer: str
    sources: list[SourceCard]  # full, updated corpus (metadata only)
    searched: bool  # whether the agent pulled new literature this turn
    search_query: str = ""  # the English query it searched, if any
    # Non-empty when the corpus did not cover the question: what we would
    # search for if the reader says yes.
    suggest_search: str = ""
    conversation_id: Optional[int] = None  # saved thread this turn belongs to
    warning: Optional[str] = None


# --- Library (saved papers, tags, history) ---


class SavePaperRequest(SourceCard):
    """A SourceCard plus optional initial tags, folder and destination team."""

    tags: list[str] = []
    folder_id: Optional[int] = None
    team_id: Optional[int] = None  # None saves to the personal library


class SavedPaper(SourceCard):
    id: int
    tags: list[str] = []
    notes: str = ""  # the user's own note on this paper
    folder_id: Optional[int] = None  # None = unfiled
    added_by: str = ""  # email of whoever saved it (shown in team libraries)
    created_at: str


# --- Teams (shared lab workspaces) ---


class TeamCreate(BaseModel):
    name: str


class TeamJoin(BaseModel):
    invite_code: str


class Team(BaseModel):
    id: int
    name: str
    invite_code: str
    role: str  # "owner" | "member"
    member_count: int


class TeamMember(BaseModel):
    user_id: str
    email: str
    role: str
    papers_added: int = 0  # what this person has contributed to the shelf


class MemberRole(BaseModel):
    role: str  # "owner" | "member"


class NotesUpdate(BaseModel):
    notes: str = ""


class LibraryChatRequest(BaseModel):
    message: str
    # Continue an existing saved thread; omitted starts a new one.
    conversation_id: Optional[int] = None
    folder: Optional[str] = None  # folder id, "unfiled", or None for the whole library
    team_id: Optional[int] = None  # None chats with the personal library
    lang: Optional[str] = None
    history: list[dict] = []  # prior [{role, content}] turns, newest last


class LibraryChatResponse(BaseModel):
    answer: str
    paper_count: int  # how many saved papers the answer was grounded in
    conversation_id: Optional[int] = None  # saved thread this turn belongs to
    warning: Optional[str] = None


# --- Saved conversations ---


class ConversationSummary(BaseModel):
    id: int
    kind: str  # "search" | "library"
    title: str
    seed_query: str = ""
    team_id: Optional[int] = None
    message_count: int
    updated_at: str


class ConversationMessage(BaseModel):
    role: str
    content: str


class Conversation(BaseModel):
    id: int
    kind: str
    title: str
    seed_query: str = ""
    team_id: Optional[int] = None
    updated_at: str
    messages: list[ConversationMessage]


class FeedbackRequest(BaseModel):
    message: str
    email: str = ""  # optional; only so they can be replied to
    context: str = ""  # which screen it came from, to make it reproducible


class FeedbackResponse(BaseModel):
    ok: bool = True


class ResumeResponse(BaseModel):
    """A saved thread, restored: its answer, its papers and a live session."""

    id: int
    kind: str
    title: str
    seed_query: str = ""
    answer: str = ""
    sources: list[SourceCard] = []
    messages: list[ConversationMessage] = []
    # Mode, filters and — for a deep brief — its sub-questions, contradictions
    # and gaps, so reopening restores the view and not just the text.
    state: dict = {}
    session_id: str = ""


class ConversationRename(BaseModel):
    title: str


class TagUpdate(BaseModel):
    tag: str


class TagCount(BaseModel):
    tag: str
    count: int


class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None  # None creates it at the top level


class Folder(BaseModel):
    id: Optional[int] = None  # None is the synthetic "unfiled" bucket
    name: str
    parent_id: Optional[int] = None
    count: int


class FolderMove(BaseModel):
    parent_id: Optional[int] = None  # None moves it back to the top level


class MoveToFolder(BaseModel):
    folder_id: Optional[int] = None  # None moves the paper out of all folders


class HistoryItem(BaseModel):
    id: int
    query: str
    detected_lang: str
    english_query: str
    result_count: int
    created_at: str


# --- Deep research ---


class DeepResearchRequest(BaseModel):
    query: str
    lang: Optional[str] = None
    include_preprints: bool = True
    sources: Optional[list[str]] = None
    conversation_id: Optional[int] = None
    # How many papers to show. Deep research gathers more than this across its
    # sub-questions; this is what survives into the result.
    limit: Optional[int] = None
    # Papers to retrieve per sub-question; the merged set is capped separately.
    per_question: int = 8


class SubQuestion(BaseModel):
    question: str
    search: str
    found: int = 0  # papers retrieved for this sub-question


class DeepResearchResponse(BaseModel):
    conversation_id: Optional[int] = None
    original_query: str
    detected_lang: str
    answer: str
    contradictions: list[str] = []
    gaps: list[str] = []
    sources: list[SourceCard] = []
    # The auditable notebook: what was asked, searched and read.
    sub_questions: list[SubQuestion] = []
    full_text_read: int = 0
    session_id: str = ""
    warning: Optional[str] = None


# --- Single paper: deep read, graph, entities ---


class PaperRequest(BaseModel):
    # DOI, PMID, OpenAlex id, or an exact title.
    identifier: str
    lang: Optional[str] = None


class ReadItem(BaseModel):
    """One appraisal point, plus the source sentence it was drawn from.

    `quote` is a locator: the reader highlights it in the article shown beside
    the reading, so a claim can be traced to the sentence behind it. Empty when
    the point rests on the paper as a whole.
    """

    text: str = ""
    quote: str = ""


class DeepRead(BaseModel):
    question: str = ""
    design: str = ""
    sample: str = ""
    findings: list[ReadItem] = []
    limitations: list[ReadItem] = []
    not_established: list[ReadItem] = []
    evidence_type: str = ""
    takeaway: str = ""


class ArticleBlock(BaseModel):
    """One renderable piece of the original article."""

    id: str = ""
    type: str = "p"  # heading | p | figure | table
    text: str = ""
    label: str = ""
    level: int = 1
    image: str = ""  # figure artwork, served by PMC
    rows: list[list[str]] = []  # table cells, so a table reads as a table


class ArticleResponse(BaseModel):
    paper: SourceCard
    blocks: list[ArticleBlock] = []
    license: str = ""
    has_full_text: bool = False
    has_pdf: bool = False  # a PDF that can actually be displayed inline
    has_neighbours: bool = True  # whether a citation index knows this paper
    pdf_link: str = ""  # publisher's PDF, for opening in a new tab
    pdf_embed: str = ""  # our own URL for the PDF pane; never a foreign origin
    warning: Optional[str] = None


class ResolveResponse(BaseModel):
    paper: SourceCard
    has_full_text: bool = False
    exact: bool = True  # False when the title did not match and this is a guess
    warning: Optional[str] = None


class UploadResponse(BaseModel):
    identifier: str  # pass this back as a normal paper identifier
    title: str = ""
    pages: int = 0
    blocks: list[ArticleBlock] = []
    paper: Optional[SourceCard] = None  # resolved authors, journal, year, DOI


class AskRequest(BaseModel):
    identifier: str
    selection: str = ""
    question: str = ""
    intent: str = ""  # translate | explain | biology | free
    lang: Optional[str] = None
    # Continue an existing reading thread; omitted starts a new one.
    conversation_id: Optional[int] = None


class AskResponse(BaseModel):
    answer: str = ""
    conversation_id: Optional[int] = None  # the thread this turn belongs to
    warning: Optional[str] = None


class PaperReadResponse(BaseModel):
    paper: SourceCard
    has_full_text: bool = False
    read: Optional[DeepRead] = None
    session_id: str = ""
    entities: dict = {}
    warning: Optional[str] = None


class GraphNode(BaseModel):
    id: str
    title: str
    authors: list[str] = []
    year: Optional[int] = None
    venue: str = ""
    doi: str = ""
    url: str = ""
    citations: int = 0
    is_seed: bool = False
    retraction_status: str = ""
    similarity: float = 0.0


class GraphEdge(BaseModel):
    source: str
    target: str
    weight: float


class ConnectedResponse(BaseModel):
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    warning: Optional[str] = None


class GraphEvidenceRequest(BaseModel):
    identifier: str
    lang: Optional[str] = None
    # Restrict the synthesis to a question, e.g. clinical evidence only.
    focus: Optional[str] = None


class GraphEvidenceResponse(BaseModel):
    answer: str = ""
    sources: list[SourceCard] = []
    session_id: str = ""
    warning: Optional[str] = None


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
