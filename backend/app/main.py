"""Gaze backend — FastAPI app.

Pipeline: detect language -> expand query to English medical terms ->
retrieve from PubMed + Semantic Scholar -> dedupe -> DeepSeek synthesis with
strict citations -> return answer + display-safe source cards.
"""
from __future__ import annotations

import asyncio
import os
import re

import httpx
from pathlib import Path
from urllib.parse import quote

from collections import OrderedDict
from time import monotonic
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .auth import current_user, optional_user
from .config import MAX_RESULTS, has_llm_key, redact
from .routers import library
from .schemas import (
    ArticleBlock,
    ConversationMessage,
    ResumeResponse,
    ArticleResponse,
    AskRequest,
    AskResponse,
    ChatRequest,
    ConnectedResponse,
    DeepRead,
    GraphEvidenceRequest,
    GraphEvidenceResponse,
    PaperReadResponse,
    PaperRequest,
    ResolveResponse,
    ChatResponse,
    DeepResearchRequest,
    DeepResearchResponse,
    SubQuestion,
    SearchRequest,
    SearchResponse,
    SourceCard,
    TrialsRequest,
    TrialsResponse,
    UploadResponse,
)
from .services import llm_service, sessions, uploads
from .services.models import Paper
from .services.openalex import _norm_title, connected_papers, resolve_work
from .services.openalex import take_notes as oa_notes
from .services.openalex import _to_paper as _oa_to_paper
from .services.pubmed import (
    _pmcid_from,
    fetch_article,
    fetch_by_doi,
    fetch_by_title,
    fetch_full_text,
    text_from_blocks,
)
from .services.retrieval import dedupe, looks_like_known_item, retrieve
from .services.trials import find_trials

app = FastAPI(title="Gaze API", version="0.1.0")


@app.on_event("startup")
def _startup() -> None:
    # Search works without a database; only the library needs one, so a
    # missing/unreachable DB must not stop the app from booting.
    try:
        db.init_db()
    except Exception as exc:  # noqa: BLE001
        print(redact(f"[startup] database unavailable: {type(exc).__name__}: {exc}"))


app.include_router(library.router)

# Local dev: Vite runs on 5173. Loosen as needed for your setup.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "llm_key": has_llm_key()}


def _save_search_thread(
    user: str,
    conversation_id: int | None,
    query: str,
    answer: str,
    cards: list,
    state: dict,
) -> int | None:
    """Store a search result, updating the open thread rather than adding one.

    Switching mode or databases re-runs the same question, and filing each run
    separately leaves a rail full of entries that all say the same thing. The
    thread is only reused when the caller passes its id, which it does exactly
    when the question has not changed.
    """
    sources = [c.model_dump() for c in cards]
    try:
        if conversation_id is not None and db.replace_conversation_result(
            user, conversation_id, query, answer, sources, state
        ):
            return conversation_id
        new_id = db.create_conversation(
            user, "search", query, seed_query=query, sources=sources, state=state
        )
        db.append_messages(
            user,
            new_id,
            [{"role": "user", "content": query},
             {"role": "assistant", "content": answer}],
        )
        return new_id
    except Exception:  # noqa: BLE001 - saving must never lose the answer
        return conversation_id


@app.post("/api/search", response_model=SearchResponse)
async def search(
    req: SearchRequest, user: str | None = Depends(optional_user)
) -> SearchResponse:
    query = req.query.strip()
    lang = req.lang or llm_service.detect_language(query)

    # 1. Expand/translate to an English search string.
    english_query = await llm_service.expand_query(query, lang)

    # 2. Retrieve + dedupe across sources, then cap to the requested set size so
    #    the synthesis prompt stays bounded. Honor the caller's limit within a
    #    safe range; fall back to MAX_RESULTS when unset.
    limit = max(3, min(req.limit or MAX_RESULTS, 40))
    sort = req.sort if req.sort in ("relevance", "date") else "relevance"
    # A pasted title or DOI is a request for one specific paper, so search the
    # user's exact words too — expansion alone finds the topic, not the paper.
    exact = query if looks_like_known_item(query) else None
    papers = (
        await retrieve(
            english_query,
            limit=limit,
            include_preprints=req.include_preprints,
            sort=sort,
            exact_query=exact,
            sources=req.sources,
        )
    )[:limit]

    # 3. Synthesize a cited answer (or a clear message if no key / no hits).
    warning = None
    if not has_llm_key():
        # Without a key we can neither translate the query nor synthesize. For a
        # Chinese query this also means PubMed/S2 (English-only) likely returned
        # nothing, so explain the real cause rather than showing a mysterious 0.
        untranslated_zh = lang == "zh" and not papers
        if untranslated_zh:
            warning = (
                "未配置 DEEPSEEK_API_KEY：中文提问需要先将其翻译成英文医学术语才能检索 "
                "PubMed / Semantic Scholar（英文数据库），因此当前无检索结果。请配置密钥后重试。"
            )
        else:
            warning = (
                "未配置 DEEPSEEK_API_KEY，仅返回检索结果，未生成综合回答。"
                if lang == "zh"
                else "DEEPSEEK_API_KEY is not configured; returning search results without a synthesized answer."
            )
        answer = ""
    else:
        try:
            result = await llm_service.synthesize(query, lang, papers)
            answer = result["answer"]
        except Exception:  # noqa: BLE001 - keep the API responsive on LLM errors
            answer = ""
            warning = (
                "综合回答生成失败（可能是密钥无效、额度不足或网络问题）。已返回检索结果，请稍后重试。"
                if lang == "zh"
                else "Failed to generate the synthesized answer (invalid key, quota, or network). Search results are shown; please retry."
            )

    cards = [SourceCard(**p.to_card()) for p in papers]

    # Record the search so it can be revisited from the history list. Only
    # signed-in users have a history; anonymous searches are not stored.
    if user:
        try:
            db.add_history(user, query, lang, english_query, len(cards))
        except Exception:  # noqa: BLE001 - history is non-critical
            pass

    # Seed a research session so the user can ask follow-up questions that keep
    # this corpus (papers hold abstracts, kept server-side only).
    seed_messages = [{"role": "user", "content": query}]
    if answer:
        seed_messages.append({"role": "assistant", "content": answer})
    session_id = sessions.create_session(
        papers,
        seed_messages,
        lang,
        include_preprints=req.include_preprints,
        sources=req.sources,
    )

    # Saved with its papers, so opening it later shows what you already have
    # instead of running the same search again and filing a second copy of it.
    conversation_id = req.conversation_id
    if user and answer:
        state = {
            "mode": "quick",
            "lang": lang,
            "limit": limit,
            "sort": sort,
            "databases": req.sources,
            "english_query": english_query,
            "warning": warning,
        }
        conversation_id = _save_search_thread(
            user, conversation_id, query, answer, cards, state
        )

    return SearchResponse(
        conversation_id=conversation_id,
        original_query=query,
        detected_lang=lang,
        english_query=english_query,
        answer=answer,
        sources=cards,
        session_id=session_id,
        warning=warning,
    )


def _cited_keys(*texts: object) -> set[str]:
    """Every [Surname, Year] token the brief actually used."""
    found: set[str] = set()
    for text in texts:
        blob = " ".join(text) if isinstance(text, list) else str(text or "")
        for inner in re.findall(r"\[([^\]]{2,60})\]", blob):
            for token in re.split(r"[;；]", inner):
                token = token.strip()
                if token:
                    found.add(token)
    return found


@app.post("/api/deep-research", response_model=DeepResearchResponse)
async def deep_research(
    req: DeepResearchRequest, user: str | None = Depends(optional_user)
) -> DeepResearchResponse:
    """A planned, multi-step review rather than a single keyword search.

    Plan sub-questions -> search each -> dedupe -> read open-access full text
    -> write a brief with evidence types, contradictions and gaps. Returns an
    auditable notebook of what was searched and read.
    """
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=422, detail="Empty query")
    lang = req.lang or llm_service.detect_language(query)

    if not has_llm_key():
        return DeepResearchResponse(
            original_query=query,
            detected_lang=lang,
            answer="",
            warning=(
                "未配置 DEEPSEEK_API_KEY，无法进行深度研究。"
                if lang == "zh"
                else "DEEPSEEK_API_KEY is not configured; deep research is unavailable."
            ),
        )

    # 1. Plan.
    subs = await llm_service.plan_subquestions(query, lang)

    # 2. Search every sub-question concurrently, then merge into one corpus.
    per_q = max(3, min(req.per_question, 15))
    results = await asyncio.gather(
        *[
            retrieve(
                s["search"],
                limit=per_q,
                include_preprints=req.include_preprints,
                sources=req.sources,
            )
            for s in subs
        ],
        return_exceptions=True,
    )
    notebook: list[SubQuestion] = []
    collected: list = []
    for sub, res in zip(subs, results):
        found = res if isinstance(res, list) else []
        collected.extend(found)
        notebook.append(
            SubQuestion(question=sub["question"], search=sub["search"], found=len(found))
        )
    # Enough to write from, but the reader's chosen count decides what they are
    # finally shown — see the trim after synthesis.
    wanted = max(3, min(req.limit or MAX_RESULTS, 40))
    papers = dedupe(collected)[: max(wanted, 24)]  # bound the synthesis prompt

    # 3. Read open-access full text where it exists — methods and sample sizes
    #    are what an abstract cannot give.
    read = 0
    try:
        read = await fetch_full_text(papers, limit=8)
    except Exception:  # noqa: BLE001 - abstracts still give a usable brief
        read = 0

    # 4. Write the brief.
    warning = None
    contradictions: list[str] = []
    gaps: list[str] = []
    try:
        brief = await llm_service.synthesize_deep(query, lang, papers, subs)
        answer = brief["answer"]
        contradictions = brief["contradictions"]
        gaps = brief["gaps"]
    except Exception:  # noqa: BLE001
        answer = ""
        warning = (
            "深度研究生成失败（可能是密钥无效、额度不足或网络问题），请稍后重试。"
            if lang == "zh"
            else "Deep research failed (invalid key, quota, or network). Please retry."
        )

    # Searching several sub-questions gathers more than any one of them needed,
    # and a sub-question about proteomics methods can legitimately surface a
    # paper about marine ecology. Keep what the brief actually cited, fill up to
    # the requested count with the rest, and drop the tail — showing a paper the
    # brief never used, with a note explaining that it is irrelevant, is worse
    # than not showing it.
    cited = {key for key in _cited_keys(answer, contradictions, gaps)}
    ranked = sorted(papers, key=lambda p: 0 if p.citation_key() in cited else 1)
    papers = ranked[:wanted]

    cards = [SourceCard(**p.to_card()) for p in papers]
    if user:
        try:
            db.add_history(user, query, lang, "; ".join(s["search"] for s in subs), len(cards))
        except Exception:  # noqa: BLE001
            pass

    seed = [{"role": "user", "content": query}]
    if answer:
        seed.append({"role": "assistant", "content": answer})
    session_id = sessions.create_session(
        papers, seed, lang, include_preprints=req.include_preprints, sources=req.sources
    )

    conversation_id = req.conversation_id
    if user and answer:
        state = {
            "mode": "deep",
            "lang": lang,
            "databases": req.sources,
            "contradictions": contradictions,
            "gaps": gaps,
            "sub_questions": [q.model_dump() for q in notebook],
            "full_text_read": read,
            "warning": warning,
        }
        conversation_id = _save_search_thread(
            user, conversation_id, query, answer, cards, state
        )

    return DeepResearchResponse(
        conversation_id=conversation_id,
        original_query=query,
        detected_lang=lang,
        answer=answer,
        contradictions=contradictions,
        gaps=gaps,
        sources=cards,
        sub_questions=notebook,
        full_text_read=read,
        session_id=session_id,
        warning=warning,
    )


_RESOLVE_CACHE: "OrderedDict[str, tuple[float, tuple]]" = OrderedDict()
_RESOLVE_INFLIGHT: dict[str, asyncio.Task] = {}
_RESOLVE_TTL = 1800.0
_RESOLVE_MAX = 64


async def _resolve_cached(identifier: str):
    """`_resolve_with_text`, shared between concurrent callers.

    精读模式 asks for the article and the close reading at the same instant and
    both resolve the same paper — several rate-limited NCBI calls each. When one
    side lost that race it silently produced an abstract-only reading with no
    highlights. Callers that arrive while a resolution is in flight await the
    same task instead of starting a second one.
    """
    key = (identifier or "").strip().lower()
    hit = _RESOLVE_CACHE.get(key)
    if hit and monotonic() - hit[0] <= _RESOLVE_TTL:
        _RESOLVE_CACHE.move_to_end(key)
        return hit[1]
    _RESOLVE_CACHE.pop(key, None)

    running = _RESOLVE_INFLIGHT.get(key)
    if running is not None:
        return await running

    task = asyncio.ensure_future(_resolve_with_text(identifier))
    _RESOLVE_INFLIGHT[key] = task
    try:
        result = await task
    finally:
        _RESOLVE_INFLIGHT.pop(key, None)
    # Only worth caching a resolution that actually found the paper.
    if result[1] is not None:
        _RESOLVE_CACHE[key] = (monotonic(), result)
        _RESOLVE_CACHE.move_to_end(key)
        while len(_RESOLVE_CACHE) > _RESOLVE_MAX:
            _RESOLVE_CACHE.popitem(last=False)
    return result


async def _resolve_with_text(identifier: str):
    """Resolve an identifier to a Paper, preferring a version with full text.

    OpenAlex resolves almost anything and gives the graph fields; PubMed is then
    asked for the same DOI because it carries curated abstracts and the PMC link
    that makes open-access full text reachable.

    An "upload:<id>" identifier is a PDF the reader supplied. Treating it as
    just another identifier means the close reading, the entities and the
    paper-scoped agent all work on it without knowing where the text came from.
    """
    if identifier.startswith(UPLOAD_PREFIX):
        record = uploads.get(identifier[len(UPLOAD_PREFIX):])
        if record is None:
            return None, None
        card = record.get("card") or {}
        paper = Paper(
            source="upload",
            source_id=record["id"],
            title=card.get("title") or record["title"],
            authors=card.get("authors") or [],
            year=card.get("year"),
            venue=card.get("venue") or "",
            doi=card.get("doi") or record.get("doi", ""),
            url=card.get("url") or "",
            retraction_status=card.get("retraction_status") or "",
            full_text=record["text"][:20000],
        )
        return None, paper

    work = await resolve_work(identifier)
    if work is None:
        # One index refusing us is not the paper failing to exist. PubMed can
        # answer a DOI or a title too, so the reader still gets their paper —
        # only the citation map, which needs OpenAlex, is unavailable.
        fallback = (
            await fetch_by_doi(identifier)
            if identifier.lower().startswith("10.")
            else await fetch_by_title(identifier)
        )
        if fallback is None:
            return None, None
        article = await fetch_article(_pmcid_from(fallback))
        if article.get("blocks"):
            fallback.full_text = text_from_blocks(article["blocks"])[:20000]
        else:
            await fetch_full_text([fallback], limit=1)
        return None, fallback
    paper = _oa_to_paper(work)
    if paper.doi:
        pm = await fetch_by_doi(paper.doi)
        if pm is not None:
            if not paper.abstract and pm.abstract:
                paper.abstract = pm.abstract
            if pm.oa_url and not paper.oa_url.startswith("https://pmc."):
                paper.oa_url = pm.oa_url
            if pm.retraction_status and not paper.retraction_status:
                paper.retraction_status = pm.retraction_status
    # Prefer the article the reading pane renders, so a sentence the model
    # quotes is a sentence that exists on screen — and so the two requests
    # 精读模式 fires in parallel share one PMC fetch instead of racing for it.
    article = await fetch_article(_pmcid_from(paper))
    if article.get("blocks"):
        paper.full_text = text_from_blocks(article["blocks"])[:20000]
    else:
        await fetch_full_text([paper], limit=1)
    return work, paper


@app.post("/api/paper/read", response_model=PaperReadResponse)
async def paper_read(
    req: PaperRequest, user: str | None = Depends(optional_user)
) -> PaperReadResponse:
    """A close reading of one paper, from its full text where that is open."""
    if req.identifier.startswith(UPLOAD_PREFIX) and not uploads.may_read(
        req.identifier[len(UPLOAD_PREFIX):], user
    ):
        raise HTTPException(status_code=404, detail="Upload not found or expired")
    work, paper = await _resolve_cached(req.identifier)
    if paper is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    lang = req.lang or llm_service.detect_language(req.identifier)

    if not has_llm_key():
        return PaperReadResponse(
            paper=SourceCard(**paper.to_card()),
            has_full_text=bool(paper.full_text),
            warning=(
                "未配置 DEEPSEEK_API_KEY，无法生成精读。"
                if lang == "zh"
                else "DEEPSEEK_API_KEY is not configured; deep read is unavailable."
            ),
        )
    read = None
    warning = None
    try:
        read = DeepRead(**await llm_service.read_paper(paper, lang))
    except Exception:  # noqa: BLE001
        warning = (
            "精读生成失败，请稍后重试。"
            if lang == "zh"
            else "Could not generate the deep read. Please retry."
        )
    entities = await llm_service.extract_entities(paper)
    # A session scoped to this one paper, so the reader's follow-up questions
    # answer from the article they are looking at and not a fresh search.
    session_id = sessions.create_session([paper], [], lang)
    return PaperReadResponse(
        paper=SourceCard(**paper.to_card()),
        has_full_text=bool(paper.full_text),
        read=read,
        entities=entities,
        session_id=session_id,
        warning=warning,
    )


@app.post("/api/paper/resolve", response_model=ResolveResponse)
async def paper_resolve(req: PaperRequest) -> ResolveResponse:
    """Find one specific paper from a DOI, PMID, PMC id, URL or exact title.

    Separate from search because it answers a different question: not "what is
    known about X" but "is this the paper, and can I read it". Resolving here
    also warms the cache the reader uses, so 精读模式 opens without repeating
    the lookup.
    """
    lang = req.lang or llm_service.detect_language(req.identifier)
    _work, paper = await _resolve_cached(req.identifier)
    if paper is None:
        notes = "; ".join(oa_notes())
        raise HTTPException(
            status_code=404,
            detail=f"Paper not found ({notes})" if notes else "Paper not found",
        )
    warning = None
    # A title lookup that lands on a different paper is worse than no result:
    # the reader would go on to read the wrong article believing it was theirs.
    looks_like_title = " " in req.identifier.strip() and not req.identifier.strip().lower().startswith("10.")
    if looks_like_title and _norm_title(paper.title) != _norm_title(req.identifier):
        return ResolveResponse(
            paper=SourceCard(**paper.to_card()),
            has_full_text=bool(paper.full_text),
            exact=False,
            warning=(
                "没有找到标题完全匹配的文献。以下是最接近的结果，请确认是否是你要找的那一篇。"
                if lang == "zh"
                else "No exact title match. This is the closest result — check it is the paper you meant."
            ),
        )
    if not paper.full_text:
        warning = (
            "这篇文献没有开放获取全文，精读将只基于摘要。你可以在精读模式中上传自己有权限的 PDF。"
            if lang == "zh"
            else "No open-access full text; the close reading will use the abstract only. "
            "You can upload a PDF you have access to inside close-reading mode."
        )
    return ResolveResponse(
        paper=SourceCard(**paper.to_card()),
        has_full_text=bool(paper.full_text),
        warning=warning,
    )


@app.post("/api/paper/article", response_model=ArticleResponse)
async def paper_article(
    req: PaperRequest, user: str | None = Depends(optional_user)
) -> ArticleResponse:
    """The original article as reading blocks, for the left pane of 精读模式.

    Deliberately separate from /api/paper/read: this returns in a couple of
    seconds and the close reading takes far longer, so the reader can start
    reading the paper while the appraisal is still being written.
    """
    if req.identifier.startswith(UPLOAD_PREFIX):
        uid = req.identifier[len(UPLOAD_PREFIX):]
        if not uploads.may_read(uid, user):
            raise HTTPException(status_code=404, detail="Upload not found or expired")
        record = uploads.get(uid)
        if record is None:
            raise HTTPException(status_code=404, detail="Upload not found or expired")
        card = record.get("card") or Paper(
            source="upload",
            source_id=f"{UPLOAD_PREFIX}{record['id']}",
            title=record["title"],
        ).to_card()
        return ArticleResponse(
            paper=SourceCard(**card),
            blocks=[ArticleBlock(**b) for b in record["blocks"]],
            has_full_text=True,
            # The only PDF we can reliably display is one the reader gave us.
            has_pdf=True,
            # The map and cross-paper evidence need an indexed identifier.
            has_neighbours=bool((record.get("card") or {}).get("doi")),
            pdf_embed=(
                f"/api/paper/upload/{record['id']}/file"
                f"?g={uploads.make_grant(record['id'])}"
            ),
        )

    _work, paper = await _resolve_cached(req.identifier)
    if paper is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    article = await fetch_article(_pmcid_from(paper))
    lang = req.lang or "zh"
    if not article:
        # No open-access full text. Show the abstract and say why, rather than
        # an empty pane that looks broken.
        blocks = (
            [{"id": "b0", "type": "heading", "text": "Abstract", "level": 1},
             {"id": "b1", "type": "p", "text": paper.abstract}]
            if paper.abstract
            else []
        )
        return ArticleResponse(
            paper=SourceCard(**paper.to_card()),
            blocks=blocks,
            has_full_text=False,
            has_neighbours=True,
            has_pdf=await _serves_a_pdf(_pdf_url_for(paper)),
            pdf_link=_pdf_url_for(paper),
            warning=(
                "这篇文献没有开放获取全文，此处仅显示摘要。可点击标题前往出版方阅读原文。"
                if lang == "zh"
                else "No open-access full text for this paper; showing the abstract only. Use the title link to read it at the publisher."
            ),
        )
    return ArticleResponse(
        paper=SourceCard(**paper.to_card()),
        blocks=article["blocks"],
        license=article.get("license", ""),
        has_full_text=True,
        has_pdf=await _serves_a_pdf(_pdf_url_for(paper)),
        has_neighbours=True,
        pdf_link=_pdf_url_for(paper),
        pdf_embed=f"/api/paper/pdf?id={quote(req.identifier, safe='')}",
    )


# A browser renders a PDF far better than anything we would build, but it will
# not render one from another origin inside our page, so the file is streamed
# through here. Only ever an open-access copy — this proxies what the publisher
# already gives away free, never anything behind a paywall.
_PDF_UA = "Gaze/1.0 (biomedical literature reader; +https://litcopilot-1.onrender.com)"
_MAX_PDF_BYTES = 40 * 1024 * 1024


def _pdf_url_for(paper) -> str:
    """The open-access PDF for this paper, or "" when there isn't one.

    Deliberately NOT PMC's /articles/<id>/pdf/ route: that returns a
    "Preparing to download" interstitial guarded by a proof-of-work anti-bot
    challenge. Passing that challenge would mean writing a bot-detection
    bypass, which we don't do even for content that is free to read — so the
    PDF comes from the publisher's own open-access copy instead, and papers
    without one simply have no PDF view.
    """
    direct = paper.pdf_url or ""
    if direct:
        return direct
    oa = paper.oa_url or ""
    return oa if ".pdf" in oa.lower() else ""


async def _serves_a_pdf(url: str) -> bool:
    """Whether that URL really returns a PDF, asked in about a kilobyte.

    Publishers and PMC both put automated PDF fetches behind bot checks, and
    they answer with a perfectly ordinary 200 carrying an HTML challenge page.
    Trusting the status code meant labelling that HTML `application/pdf` and
    handing the reader an empty frame, so the bytes are checked instead. A
    ranged request keeps the cost of being sure to a rounding error.
    """
    if not url:
        return False
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=25) as client:
            r = await client.get(
                url,
                headers={
                    "User-Agent": _PDF_UA,
                    "Accept": "application/pdf",
                    "Range": "bytes=0-1023",
                },
            )
            return r.status_code < 400 and r.content[:5] == b"%PDF-"
    except httpx.HTTPError:
        return False


UPLOAD_PREFIX = "upload:"


def _indexed_identifier(identifier: str) -> str | None:
    """The identifier to look this paper up in a citation index with.

    An upload is addressed by its upload id, which no index knows. What the
    index does know is the DOI it resolved to when it was uploaded, so anything
    that needs the literature around a paper — the map, the evidence across it —
    asks with that instead. Returns None when the upload matched nothing.
    """
    if not identifier.startswith(UPLOAD_PREFIX):
        return identifier
    record = uploads.get(identifier[len(UPLOAD_PREFIX):]) or {}
    card = record.get("card") or {}
    doi = card.get("doi") or record.get("doi") or ""
    return doi or None


async def _card_for_upload(record: dict) -> dict:
    """Bibliographic metadata for an uploaded PDF.

    A PDF's front matter is a layout, not a record: authors wrap across lines,
    the journal is a logo, and the year hides in a footer. So the DOI printed on
    page one is resolved against the same index the search uses, and the upload
    comes back with the authors, journal, year and citation key a search result
    has. Falling back to the title catches papers that print no DOI; falling
    back to the filename-derived title keeps something readable when neither
    lands.
    """
    work = None
    for probe in (record.get("doi"), record.get("title")):
        if not probe or len(str(probe)) < 6:
            continue
        try:
            work = await resolve_work(str(probe))
        except Exception:  # noqa: BLE001 - metadata is a bonus, never a blocker
            work = None
        if work is not None:
            break

    if work is not None:
        paper = _oa_to_paper(work)
        card = paper.to_card()
    else:
        card = Paper(
            source="upload",
            source_id=record["id"],
            title=record["title"],
            doi=record.get("doi", ""),
        ).to_card()

    # However it resolved, the library and the reader address it as the upload.
    card["source"] = "upload"
    card["source_id"] = f"{UPLOAD_PREFIX}{record['id']}"
    card["has_full_text"] = True
    if not card.get("title"):
        card["title"] = record["title"]
    return card


@app.post("/api/paper/upload", response_model=UploadResponse)
async def paper_upload(
    request: Request,
    background: BackgroundTasks,
    user: str | None = Depends(optional_user),
) -> UploadResponse:
    """Take a PDF the reader already has and open 精读模式 on it.

    The route exists because most biomedical PDFs cannot be fetched by a
    server — publishers answer automated requests with a bot check — while the
    reader's own institutional access has no such problem.

    The file comes as the raw request body: there is one field, and parsing it
    as multipart costs seconds of pure-Python work per megabyte on a slow
    instance for no benefit.
    """
    try:
        record = await uploads.save_stream(request.stream())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    record["card"] = await _card_for_upload(record)
    background.add_task(uploads.persist, record, user)
    return UploadResponse(
        identifier=f"{UPLOAD_PREFIX}{record['id']}",
        title=record["card"].get("title") or record["title"],
        pages=record["pages"],
        blocks=[ArticleBlock(**b) for b in record["blocks"]],
        paper=SourceCard(**record["card"]),
    )


@app.get("/api/paper/upload/{uid}/file")
async def paper_upload_file(
    uid: str, g: str = "", user: str | None = Depends(optional_user)
):
    """The uploaded PDF itself — this is the one PDF the reader can display.

    A frame cannot send an Authorization header, so access is proven either by
    the short-lived grant the article response issued, or by the owner's own
    token when something other than a frame asks.
    """
    if not (uploads.check_grant(uid, g) or uploads.may_read(uid, user)):
        raise HTTPException(status_code=404, detail="Upload not found or expired")
    data = uploads.file_bytes(uid)
    if data is None:
        raise HTTPException(status_code=404, detail="Upload not found or expired")
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="paper.pdf"'},
    )


@app.get("/api/paper/pdf")
async def paper_pdf(id: str, g: str = "", user: str | None = Depends(optional_user)):
    """Stream the paper's open-access PDF, so it can be shown in the reader."""
    if id.startswith(UPLOAD_PREFIX):
        return await paper_upload_file(id[len(UPLOAD_PREFIX):], g=g, user=user)
    _work, paper = await _resolve_cached(id)
    if paper is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    url = _pdf_url_for(paper)
    if not url:
        raise HTTPException(status_code=404, detail="No open-access PDF for this paper")

    async def body():
        sent = 0
        async with httpx.AsyncClient(follow_redirects=True, timeout=90) as client:
            async with client.stream(
                "GET", url, headers={"User-Agent": _PDF_UA, "Accept": "application/pdf"}
            ) as r:
                r.raise_for_status()
                first = True
                async for chunk in r.aiter_bytes():
                    # Never pass off a bot-check page as a PDF.
                    if first:
                        first = False
                        if chunk[:5] != b"%PDF-":
                            return
                    sent += len(chunk)
                    if sent > _MAX_PDF_BYTES:
                        return
                    yield chunk

    return StreamingResponse(
        body(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'inline; filename="paper.pdf"',
            "Cache-Control": "public, max-age=3600",
        },
    )


def _asked_with_context(req: AskRequest) -> str:
    """The question as the reader will want to see it again.

    A selection question makes no sense on its own once reopened — "翻译" tells
    you nothing — so the passage it was about is stored with it.
    """
    question = req.question.strip() or {
        "translate": "翻译这段文字",
        "biology": "这段文字的生物学意义是什么？",
        "explain": "解释这段文字",
    }.get(req.intent, "这段文字是什么意思？")
    selection = req.selection.strip()
    return f"「{selection[:400]}」\n\n{question}" if selection else question


@app.post("/api/paper/ask", response_model=AskResponse)
async def paper_ask(
    req: AskRequest, user: str | None = Depends(optional_user)
) -> AskResponse:
    """Answer a question about a passage the reader selected in the article."""
    if not req.selection.strip() and not req.question.strip():
        raise HTTPException(status_code=400, detail="Nothing to ask about")
    lang = req.lang or llm_service.detect_language(req.question or req.selection)
    if not has_llm_key():
        return AskResponse(warning="DEEPSEEK_API_KEY is not configured.")
    if req.identifier.startswith(UPLOAD_PREFIX) and not uploads.may_read(
        req.identifier[len(UPLOAD_PREFIX):], user
    ):
        raise HTTPException(status_code=404, detail="Upload not found or expired")
    _work, paper = await _resolve_cached(req.identifier)
    if paper is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    try:
        answer = await llm_service.explain_selection(
            paper, req.selection, req.question, req.intent, lang
        )
    except Exception:  # noqa: BLE001
        return AskResponse(
            warning="回答失败，请重试。" if lang == "zh" else "Could not answer. Please retry."
        )

    # Keep the thread, so reopening a paper does not lose what you already
    # asked of it. Stored under its own kind and tagged with the paper, so a
    # reading conversation is not mixed in with search history.
    conversation_id = req.conversation_id
    asked = req.question.strip() or req.selection.strip()
    if user and answer and asked:
        try:
            if conversation_id is None:
                conversation_id = db.create_conversation(
                    user, "paper", asked, seed_query=req.identifier
                )
            db.append_messages(
                user,
                conversation_id,
                [
                    {"role": "user", "content": _asked_with_context(req)},
                    {"role": "assistant", "content": answer},
                ],
            )
        except Exception:  # noqa: BLE001 - saving must not lose the answer
            pass
    return AskResponse(answer=answer, conversation_id=conversation_id)


@app.post("/api/paper/connected", response_model=ConnectedResponse)
async def paper_connected(req: PaperRequest) -> ConnectedResponse:
    """The similarity graph around one paper (bibliographic coupling)."""
    # An upload has no record of its own, but it usually resolved to a real
    # paper on the way in — so the map is built from that paper's DOI. Only a
    # PDF that matched nothing has no neighbourhood to show.
    identifier = _indexed_identifier(req.identifier)
    if identifier is None:
        return ConnectedResponse(nodes=[], edges=[], warning="upload has no citation record")
    work = await resolve_work(identifier)
    if work is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    try:
        graph = await connected_papers(work)
    except Exception:  # noqa: BLE001
        return ConnectedResponse(nodes=[], edges=[], warning="graph unavailable")
    return ConnectedResponse(**graph)


@app.post("/api/paper/evidence", response_model=GraphEvidenceResponse)
async def paper_evidence(
    req: GraphEvidenceRequest, user: str | None = Depends(optional_user)
) -> GraphEvidenceResponse:
    """Synthesise what the papers around this one actually establish.

    The corpus is the seed plus its graph neighbours, so the answer is about
    this line of work rather than a fresh topical search.
    """
    work, seed = await _resolve_cached(req.identifier)
    if seed is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    lang = req.lang or "zh"

    # For an upload, the neighbourhood comes from the DOI it resolved to; a PDF
    # that matched nothing simply has no neighbours and the appraisal falls back
    # to the paper itself.
    if work is None:
        indexed = _indexed_identifier(req.identifier)
        work = await resolve_work(indexed) if indexed else None
    graph = await connected_papers(work, limit=18) if work else {"nodes": []}
    ids = [n["id"] for n in graph["nodes"] if not n["is_seed"]][:14]
    neighbours = []
    if ids:
        from .services.openalex import _batch_works  # local: graph-only helper

        import httpx as _httpx

        try:
            async with _httpx.AsyncClient() as client:
                neighbours = [_oa_to_paper(w) for w in await _batch_works(client, ids)]
        except Exception:  # noqa: BLE001
            neighbours = []

    papers = dedupe([seed] + neighbours)
    await fetch_full_text(papers, limit=4)

    if not has_llm_key():
        return GraphEvidenceResponse(
            sources=[SourceCard(**p.to_card()) for p in papers],
            warning="DEEPSEEK_API_KEY is not configured.",
        )

    focus = req.focus or (
        "这些文献中有哪些临床证据（人体研究/随机对照试验），哪些仍停留在临床前？"
        if lang == "zh"
        else "What clinical evidence (human studies/RCTs) exists across these papers, and what remains preclinical?"
    )
    warning = None
    try:
        brief = await llm_service.synthesize_deep(
            focus, lang, papers, [{"question": focus, "search": ""}]
        )
        answer = brief["answer"]
    except Exception:  # noqa: BLE001
        answer = ""
        warning = (
            "证据综合失败，请稍后重试。"
            if lang == "zh"
            else "Could not synthesise the evidence. Please retry."
        )

    seed_msgs = [{"role": "user", "content": focus}]
    if answer:
        seed_msgs.append({"role": "assistant", "content": answer})
    session_id = sessions.create_session(papers, seed_msgs, lang)

    return GraphEvidenceResponse(
        answer=answer,
        sources=[SourceCard(**p.to_card()) for p in papers],
        session_id=session_id,
        warning=warning,
    )


def _card_to_paper(card: dict) -> Paper:
    """Rebuild a Paper from a stored card. Abstracts were never saved, so a
    resumed thread reasons from titles and the answer already written — the
    agent re-fetches anything it needs."""
    return Paper(
        source=card.get("source", ""),
        source_id=card.get("source_id", ""),
        title=card.get("title", ""),
        authors=card.get("authors") or [],
        year=card.get("year"),
        venue=card.get("venue", ""),
        url=card.get("url", ""),
        doi=card.get("doi", ""),
        pub_date=card.get("pub_date", ""),
        oa_url=card.get("oa_url", ""),
        retraction_status=card.get("retraction_status", ""),
        evidence_type=card.get("evidence_type", ""),
        title_zh=card.get("title_zh", ""),
        relevance_zh=card.get("relevance_zh", ""),
    )


@app.post("/api/conversations/{conversation_id}/resume", response_model=ResumeResponse)
def resume_conversation(
    conversation_id: int, user: str = Depends(current_user)
) -> ResumeResponse:
    """Reopen a saved thread with its answer, its papers and a live session.

    Re-running the original query would be a different search — new results, a
    new answer, and a second history entry for the same piece of work. The
    stored corpus is put back into a session instead, so follow-up questions
    continue the thread rather than starting another one.
    """
    conv = db.get_conversation(user, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    stored = conv.get("sources") or []
    papers = [_card_to_paper(c) for c in stored]
    session_id = sessions.create_session(papers, conv["messages"], "zh")

    answer = ""
    for msg in conv["messages"]:
        if msg["role"] == "assistant":
            answer = msg["content"]
            break
    return ResumeResponse(
        id=conv["id"],
        kind=conv["kind"],
        title=conv["title"],
        seed_query=conv["seed_query"],
        answer=answer,
        sources=[SourceCard(**c) for c in stored],
        messages=[ConversationMessage(**m) for m in conv["messages"]],
        state=conv.get("state") or {},
        session_id=session_id,
    )


@app.post("/api/trials", response_model=TrialsResponse)
async def trials(req: TrialsRequest) -> TrialsResponse:
    """Find ClinicalTrials.gov studies related to the query.

    ClinicalTrials.gov is English-only, so a Chinese query is first translated
    to an English search term (same expansion used for literature search).
    """
    query = req.query.strip()
    lang = llm_service.detect_language(query)
    term = await llm_service.expand_query(query, lang)
    found = await find_trials(term)
    return TrialsResponse(term=term, trials=found)


@app.post("/api/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest, user: str | None = Depends(optional_user)
) -> ChatResponse:
    """One turn of the multi-turn research agent.

    The agent decides whether the follow-up needs new literature; if so it
    searches, grows the session corpus, and localizes the new papers. It then
    answers the follow-up citation-strictly from the accumulated corpus.
    """
    sess = sessions.get_session(req.session_id)
    if sess is None:
        raise HTTPException(
            status_code=404,
            detail="Session not found or expired; run a new search to start one.",
        )
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Empty message")

    lang = req.lang or sess["lang"]
    sess["lang"] = lang  # follow the current UI language

    def _cards() -> list[SourceCard]:
        return [SourceCard(**p.to_card()) for p in sess["papers"]]

    if not llm_service.has_llm_key():
        return ChatResponse(
            answer="",
            sources=_cards(),
            searched=False,
            warning=(
                "未配置 DEEPSEEK_API_KEY，无法进行对话式深挖。"
                if lang == "zh"
                else "DEEPSEEK_API_KEY is not configured; conversational research is unavailable."
            ),
        )

    # 1. Agent decides whether to pull in new literature for this follow-up.
    corpus_titles = [p.title for p in sess["papers"]]
    need_search, search_query = await llm_service.decide_search(message, corpus_titles)

    searched = False
    if need_search and search_query:
        new_papers = await retrieve(
            search_query,
            limit=8,
            include_preprints=sess.get("include_preprints", True),
            sources=sess.get("sources"),
        )
        added = sessions.add_papers(req.session_id, new_papers)
        if added:
            searched = True
            await llm_service.localize_papers(added, message, lang)

    sess = sessions.get_session(req.session_id)  # refresh after any growth

    # 2. Answer the follow-up from the (possibly grown) corpus.
    warning = None
    try:
        answer = await llm_service.answer_from_corpus(
            sess["messages"], message, lang, sess["papers"]
        )
    except Exception:  # noqa: BLE001 - surface a graceful message, keep corpus
        answer = ""
        warning = (
            "回答生成失败（可能是密钥无效、额度不足或网络问题），请稍后重试。"
            if lang == "zh"
            else "Failed to generate a reply (invalid key, quota, or network). Please retry."
        )

    if answer:
        sessions.add_message(req.session_id, "user", message)
        sessions.add_message(req.session_id, "assistant", answer)

    # Persist the exchange so this deep-dive can be reopened later. Only the
    # messages are stored — the paper corpus (which holds abstracts) is not, so
    # a resumed thread re-runs its seed query to rebuild it.
    conversation_id = req.conversation_id
    if user and answer:
        try:
            if conversation_id is None:
                seed = sess["messages"][0]["content"] if sess["messages"] else message
                conversation_id = db.create_conversation(
                    user, "search", message, seed_query=seed
                )
            db.append_messages(
                user,
                conversation_id,
                [{"role": "user", "content": message},
                 {"role": "assistant", "content": answer}],
            )
            if searched:
                db.set_conversation_sources(
                    user, conversation_id, [c.model_dump() for c in _cards()]
                )
        except Exception:  # noqa: BLE001 - saving must not lose the answer
            pass

    return ChatResponse(
        answer=answer,
        sources=_cards(),
        searched=searched,
        search_query=search_query if searched else "",
        conversation_id=conversation_id,
        warning=warning,
    )


# --- Serve the built frontend (single-service deployment) -----------------
# When `frontend/dist` exists (i.e. after `npm run build`), FastAPI serves the
# React app from the same origin as the API — one URL, one port. In dev you can
# still run Vite on :5173 with its /api proxy; this block is simply inactive
# until a build is present. Registered LAST so it never shadows /api routes.
_DEFAULT_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
FRONTEND_DIST = Path(os.getenv("FRONTEND_DIST", str(_DEFAULT_DIST)))

if (FRONTEND_DIST / "index.html").is_file():
    if (FRONTEND_DIST / "assets").is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=FRONTEND_DIST / "assets"),
            name="assets",
        )

    _INDEX = FRONTEND_DIST / "index.html"

    @app.get("/{full_path:path}")
    async def spa(full_path: str) -> FileResponse:
        """Serve static files, falling back to index.html for client routes."""
        # Never hijack the API surface (also lets unknown /api paths 404 cleanly).
        if full_path.startswith("api"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_INDEX)

