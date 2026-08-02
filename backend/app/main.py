"""Gaze backend — FastAPI app.

Pipeline: detect language -> expand query to English medical terms ->
retrieve from PubMed + Semantic Scholar -> dedupe -> DeepSeek synthesis with
strict citations -> return answer + display-safe source cards.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .config import MAX_RESULTS, has_llm_key
from .routers import library
from .schemas import (
    ChatRequest,
    ChatResponse,
    SearchRequest,
    SearchResponse,
    SourceCard,
    TrialsRequest,
    TrialsResponse,
)
from .services import llm_service, sessions
from .services.retrieval import retrieve
from .services.trials import find_trials

app = FastAPI(title="Gaze API", version="0.1.0")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


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


@app.post("/api/search", response_model=SearchResponse)
async def search(req: SearchRequest) -> SearchResponse:
    query = req.query.strip()
    lang = req.lang or llm_service.detect_language(query)

    # 1. Expand/translate to an English search string.
    english_query = await llm_service.expand_query(query, lang)

    # 2. Retrieve + dedupe across sources, then cap to the requested set size so
    #    the synthesis prompt stays bounded. Honor the caller's limit within a
    #    safe range; fall back to MAX_RESULTS when unset.
    limit = max(3, min(req.limit or MAX_RESULTS, 40))
    papers = (
        await retrieve(english_query, limit=limit, include_preprints=req.include_preprints)
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

    # Record the search so it can be revisited from the history list.
    db.add_history(query, lang, english_query, len(cards))

    # Seed a research session so the user can ask follow-up questions that keep
    # this corpus (papers hold abstracts, kept server-side only).
    seed_messages = [{"role": "user", "content": query}]
    if answer:
        seed_messages.append({"role": "assistant", "content": answer})
    session_id = sessions.create_session(
        papers, seed_messages, lang, include_preprints=req.include_preprints
    )

    return SearchResponse(
        original_query=query,
        detected_lang=lang,
        english_query=english_query,
        answer=answer,
        sources=cards,
        session_id=session_id,
        warning=warning,
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
async def chat(req: ChatRequest) -> ChatResponse:
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

    return ChatResponse(
        answer=answer,
        sources=_cards(),
        searched=searched,
        search_query=search_query if searched else "",
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
