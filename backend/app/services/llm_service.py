"""LLM-powered query understanding and citation-strict synthesis.

Provider: DeepSeek via its OpenAI-compatible Chat Completions API (using the
`openai` SDK pointed at DeepSeek's base URL).

Three responsibilities:
  1. detect_language  — decide whether the user wrote Chinese or English.
  2. expand_query     — turn the NL question into an English search string with
                        medical terminology (PubMed/S2 are English-only).
  3. synthesize       — answer ONLY from retrieved abstracts, cite every claim,
                        and reply in the user's language.

Guardrail: the model is instructed never to invent findings or citations. If
the abstracts don't support an answer it must say so explicitly.
"""
from __future__ import annotations

import asyncio
import json
import re

from openai import AsyncOpenAI

from ..config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL,
    has_llm_key,
)
from .models import Paper

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)
    return _client


async def _chat(system: str, user: str, max_tokens: int) -> tuple[str, str]:
    """One chat-completion round-trip.

    Returns (text, finish_reason). A finish_reason of "length" means the model
    was cut off by max_tokens and the output is likely truncated.
    """
    resp = await _get_client().chat.completions.create(
        model=DEEPSEEK_MODEL,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    choice = resp.choices[0]
    return (choice.message.content or "").strip(), (choice.finish_reason or "")


# CJK Unified Ideographs range — cheap, deterministic, no API call needed.
_CJK = re.compile(r"[一-鿿]")


def detect_language(query: str) -> str:
    """Return 'zh' if the query contains Chinese characters, else 'en'."""
    return "zh" if _CJK.search(query or "") else "en"


def _extract_json(text: str) -> dict:
    """Pull the first JSON object out of a model response, tolerating fences."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).rstrip("`").strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1:
        return json.loads(text[start : end + 1])
    raise ValueError("No JSON object found in model response")


async def expand_query(query: str, lang: str) -> str:
    """Produce an English PubMed/S2 search string from the user's question."""
    if not has_llm_key():
        # Offline fallback: search with the raw query (works for English).
        return query

    instruction = (
        "You convert a researcher's biomedical question into a concise English "
        "search query for PubMed and Semantic Scholar. Use standard English "
        "medical terminology and relevant MeSH-style terms. Return ONLY the "
        "search string — no quotes, no explanation, no boolean operators unless "
        "essential. Keep it under 20 words."
    )
    prompt = (
        f"The user's question (language: {lang}):\n{query}\n\n"
        "Give the English search string now."
    )
    # Retry transient API failures before giving up: for a Chinese query the
    # raw-query fallback searches English-only databases with Chinese text and
    # returns near-useless results, so it's worth a couple of extra attempts.
    for attempt in range(3):
        try:
            out, _ = await _chat(instruction, prompt, max_tokens=200)
            if out:
                return out
        except Exception:  # noqa: BLE001 - retry, then fall back below
            pass
        if attempt < 2:
            await asyncio.sleep(0.5 * (attempt + 1))
    # All attempts failed — fall back to the raw query as a last resort.
    return query


def _format_sources_for_prompt(papers: list[Paper]) -> str:
    # NOTE: deliberately avoid wrapping the source number in [brackets] — the
    # model tends to copy a bracketed number as the citation marker. The only
    # bracketed token shown is the exact [citation_key] it must cite with.
    blocks = []
    for i, p in enumerate(papers, 1):
        flag = ""
        if p.retraction_status == "retracted":
            flag = "\n    ⚠ INTEGRITY: this paper has been RETRACTED."
        elif p.retraction_status == "concern":
            flag = "\n    ⚠ INTEGRITY: this paper carries an editorial expression of concern."
        blocks.append(
            f"Source {i} (index={i}) — cite this source as [{p.citation_key()}]{flag}\n"
            f"    title: {p.title}\n"
            f"    authors: {', '.join(p.authors[:6])}\n"
            f"    year: {p.year}\n"
            f"    venue: {p.venue}\n"
            f"    abstract: {p.abstract}"
        )
    return "\n\n".join(blocks)


_SYNTH_SYSTEM = """You are Gaze, a biomedical literature research assistant.

You are given a researcher's question and a numbered list of source papers with \
their abstracts. Follow these rules WITHOUT EXCEPTION:

1. Answer ONLY using information found in the provided abstracts. Do not use \
outside knowledge and never invent findings, numbers, or conclusions.
2. Cite every substantive claim inline using the exact [citation_key] given for \
that source, e.g. [Smith, 2021]. NEVER cite by number such as [1] or [[3]]; \
always use the [Surname, Year] token shown for the source. Only cite sources \
from the provided list.
3. If the provided abstracts do not contain enough information to answer, say so \
explicitly in the answer rather than guessing.
4. Write the answer in the RESPONSE LANGUAGE stated in the user message (Chinese \
or English). Write naturally and fluently in that language directly — do NOT \
translate a literal draft from the other language.
Keep it SHORT: 2-3 tight paragraphs, roughly 150-250 words. This is a quick
orientation, not a review — a reader who wants depth runs deep research, and
padding this out only makes the two modes read the same.
5. Do NOT reproduce abstract text verbatim — paraphrase in your own words.
6b. Set "relevant": false for any source that does not bear on the question.
Retrieval casts a wide net and pulls in strays; anything marked false is removed
before the reader sees it, so marking one costs nothing, while leaving a stray
marked true puts an unrelated paper in a list someone is trusting.
6. A source marked RETRACTED or with an expression of concern must NOT be used
to support a claim as if it were sound evidence. If you mention it at all, say
plainly that it has been retracted (or questioned) and advise against relying
on it.

Then, for EACH source, provide (ALL in the RESPONSE LANGUAGE):
  - title_localized: the paper's title translated into the response language. If \
    the title is ALREADY in the response language, return an empty string "".
  - relevance: one short sentence in the response language on why this paper is \
    relevant to the question (your own paraphrase, not copied text).

Return ONLY a JSON object of this exact shape and nothing else:
{
  "answer": "<the synthesized answer in the response language>",
  "sources": [
    {"index": 1, "title_localized": "...", "relevance": "...", "relevant": true},
    ...
  ]
}"""


async def synthesize(query: str, lang: str, papers: list[Paper]) -> dict:
    """Return {'answer': str} and enrich each Paper with zh fields.

    Raises RuntimeError if no LLM key is configured (caller handles it).
    """
    if not has_llm_key():
        raise RuntimeError("DEEPSEEK_API_KEY not configured")
    if not papers:
        no_hits = (
            "未能检索到相关文献，无法给出有依据的回答。请尝试调整或细化你的问题。"
            if lang == "zh"
            else "No relevant literature was retrieved, so no grounded answer can be given. Try refining your question."
        )
        return {"answer": no_hits, "sources": []}

    response_language = "Chinese" if lang == "zh" else "English"
    user_msg = (
        f"RESPONSE LANGUAGE: {response_language} — write the answer, "
        f"title_localized, and relevance fields entirely in {response_language}.\n\n"
        f"User question:\n{query}\n\n"
        f"Source papers:\n{_format_sources_for_prompt(papers)}"
    )
    # Budget generously: a Chinese answer + title_zh/relevance_zh for up to ~18
    # sources as JSON can be large, and a truncated response breaks JSON parsing.
    # Retry once on truncation or a malformed/partial JSON payload.
    data = None
    last_err: Exception | None = None
    for max_tokens in (4096, 6000):
        raw, finish = await _chat(_SYNTH_SYSTEM, user_msg, max_tokens=max_tokens)
        try:
            candidate = _extract_json(raw)
        except (ValueError, json.JSONDecodeError) as e:
            last_err = e
            continue  # likely truncated JSON — retry with a larger budget
        if finish == "length":
            # Parsed, but the model was cut off; a bigger budget may complete it.
            data = candidate
            continue
        data = candidate
        break
    if data is None:
        # Both attempts failed to yield valid JSON.
        raise last_err or RuntimeError("synthesis returned no parseable JSON")

    # Enrich papers with the per-source localized fields (in the response
    # language), matched by 1-based index. The Paper/DB field names keep their
    # historical *_zh suffix but now hold response-language text.
    for s in data.get("sources", []):
        idx = s.get("index", 0) - 1
        if 0 <= idx < len(papers):
            localized = (s.get("title_localized") or "").strip()
            # Drop the translated title when it just duplicates the original
            # (paper already in the response language) so the card shows it once.
            if localized.lower() == papers[idx].title.strip().lower():
                localized = ""
            papers[idx].title_zh = localized
            papers[idx].relevance_zh = s.get("relevance", "")
            if s.get("relevant") is False:
                papers[idx].irrelevant = True

    return {"answer": data.get("answer", "").strip()}


# --- Multi-turn research agent ---------------------------------------------


def _lang_name(lang: str) -> str:
    return "Chinese" if lang == "zh" else "English"


def _set_localized(paper: Paper, localized: str, relevance: str) -> None:
    localized = (localized or "").strip()
    if localized.lower() == paper.title.strip().lower():
        localized = ""  # already in the response language — avoid duplicate title
    paper.title_zh = localized
    paper.relevance_zh = (relevance or "").strip()


_DECIDE_SYSTEM = """You are the retrieval controller for a biomedical research \
assistant in a multi-turn conversation.

Given the conversation, the user's new follow-up question, and the TITLES of \
papers already gathered, decide whether answering well requires searching for \
NEW literature beyond what is already gathered.
- If the gathered papers plausibly cover the follow-up, no search is needed.
- If the follow-up shifts to a new sub-topic, mechanism, drug, population, or \
asks for evidence not implied by the gathered titles, a search IS needed.
When a search is needed, produce a concise ENGLISH search query using medical \
terminology (under 20 words) suitable for PubMed / OpenAlex.

Return ONLY a JSON object and nothing else:
{"need_search": true|false, "search_query": "<english terms, or empty string>"}"""


async def decide_search(
    question: str, corpus_titles: list[str]
) -> tuple[bool, str]:
    """Decide whether a follow-up needs new literature, and if so the query."""
    if not has_llm_key():
        return False, ""
    titles = "\n".join(f"- {t}" for t in corpus_titles[:40]) or "(none)"
    user = (
        f"Follow-up question:\n{question}\n\n"
        f"Titles already gathered:\n{titles}"
    )
    try:
        raw, _ = await _chat(_DECIDE_SYSTEM, user, max_tokens=200)
        data = _extract_json(raw)
    except Exception:  # noqa: BLE001 - on any failure, answer from what we have
        return False, ""
    need = bool(data.get("need_search"))
    query = (data.get("search_query") or "").strip()
    return (need and bool(query)), query


_CHAT_ANSWER_SYSTEM = """You are Gaze, a biomedical literature research \
assistant in a multi-turn research conversation.

If the gathered papers do not cover the question, say briefly what is missing
and STOP — do not pad the answer. Do not tell the reader the corpus is
insufficient as though that ends it: the interface offers to go and search for
the missing topic, so your job is to name the gap in one sentence, not to
apologise for it.

You are given the conversation so far, the researcher's NEW question, and a \
numbered list of source papers (the accumulated corpus) with abstracts. Follow \
these rules WITHOUT EXCEPTION:

1. Answer ONLY using information found in the provided abstracts. Do not use \
outside knowledge and never invent findings, numbers, or conclusions.
2. Cite every substantive claim inline using the exact [citation_key] token \
shown for that source, e.g. [Smith, 2021]. NEVER cite by number like [1]. Only \
cite sources from the provided list.
3. If the provided abstracts do not contain enough information to answer, say so \
explicitly rather than guessing.
4. Write in the RESPONSE LANGUAGE stated in the user message. Directly address \
the new question, building on the conversation. Be focused: 1-4 paragraphs.
5. Do NOT reproduce abstract text verbatim — paraphrase in your own words.

Return ONLY the answer text — no JSON, no preamble."""


def _format_history(history: list[dict]) -> str:
    if not history:
        return ""
    lines = []
    for m in history[-8:]:
        role = "Researcher" if m.get("role") == "user" else "Assistant"
        content = (m.get("content") or "")[:1200]
        lines.append(f"{role}: {content}")
    return "Conversation so far (most recent last):\n" + "\n".join(lines) + "\n\n"


async def answer_from_corpus(
    history: list[dict], question: str, lang: str, papers: list[Paper]
) -> str:
    """Citation-strict answer to a follow-up, grounded in the accumulated corpus."""
    if not has_llm_key():
        raise RuntimeError("DEEPSEEK_API_KEY not configured")
    if not papers:
        return (
            "尚未检索到可用于回答的文献。请先进行一次检索。"
            if lang == "zh"
            else "No literature is available yet to answer from. Try a search first."
        )
    user = (
        f"RESPONSE LANGUAGE: {_lang_name(lang)} — write the answer entirely in "
        f"{_lang_name(lang)}.\n\n"
        f"{_format_history(history)}"
        f"New question:\n{question}\n\n"
        f"Source papers (the corpus):\n{_format_sources_for_prompt(papers)}"
    )
    answer, _ = await _chat(_CHAT_ANSWER_SYSTEM, user, max_tokens=2000)
    return answer.strip()


_LIBRARY_CHAT_SYSTEM = """You are Gaze, helping a researcher interrogate their \
OWN saved library.

IMPORTANT — what evidence you have: for privacy and copyright reasons the \
library stores only each paper's METADATA (title, authors, year, venue), a one- \
line relevance note written earlier by Gaze, the researcher's own notes, and \
tags. You do NOT have the abstracts or full text. Work within that limit:

1. Ground every statement in the listed papers only. Never invent papers, \
findings, numbers or details that the metadata does not support.
2. Cite papers inline using the exact [citation_key] token shown, e.g. \
[Smith, 2021]. Only cite papers from the list.
3. You CAN answer well: which saved papers relate to a topic, how the library \
breaks down by theme/year/venue, what the researcher's own notes say, and what \
is missing or thin in the collection.
4. When a question needs findings that only an abstract or full text would give, \
say so plainly and point to which saved papers would likely answer it — do NOT \
guess at their contents.
5. Write in the RESPONSE LANGUAGE stated in the user message, naturally and \
directly. Be concise: 1-4 short paragraphs, using a list when it helps.

Return ONLY the answer text — no JSON, no preamble."""


def _format_library_for_prompt(papers: list[dict]) -> str:
    blocks = []
    for i, p in enumerate(papers, 1):
        authors = ", ".join((p.get("authors") or [])[:6])
        parts = [
            f"[{i}] cite as [{p.get('citation_key', '')}]",
            f"    title: {p.get('title', '')}",
        ]
        if p.get("title_zh"):
            parts.append(f"    title (translated): {p['title_zh']}")
        parts.append(f"    authors: {authors}")
        parts.append(f"    year: {p.get('year')}    venue: {p.get('venue', '')}")
        if p.get("relevance_zh"):
            parts.append(f"    gaze relevance note: {p['relevance_zh']}")
        if p.get("notes"):
            parts.append(f"    RESEARCHER'S OWN NOTE: {p['notes']}")
        if p.get("tags"):
            parts.append(f"    tags: {', '.join(p['tags'])}")
        blocks.append("\n".join(parts))
    return "\n\n".join(blocks)


async def answer_from_library(
    papers: list[dict], question: str, lang: str, history: list[dict] | None = None
) -> str:
    """Answer a question grounded in the user's saved-paper metadata."""
    if not has_llm_key():
        raise RuntimeError("DEEPSEEK_API_KEY not configured")
    if not papers:
        return (
            "你的文库中还没有文献，无法作答。请先在检索结果中保存一些文献。"
            if lang == "zh"
            else "Your library is empty, so there is nothing to answer from. Save some papers first."
        )
    user = (
        f"RESPONSE LANGUAGE: {_lang_name(lang)} — write the answer entirely in "
        f"{_lang_name(lang)}.\n\n"
        f"{_format_history(history or [])}"
        f"Question:\n{question}\n\n"
        f"The researcher's saved papers ({len(papers)} total):\n"
        f"{_format_library_for_prompt(papers)}"
    )
    answer, _ = await _chat(_LIBRARY_CHAT_SYSTEM, user, max_tokens=2000)
    return answer.strip()


_LOCALIZE_SYSTEM = """For each numbered source paper, provide, in the RESPONSE \
LANGUAGE stated in the user message:
  - title_localized: the paper's title translated into the response language; \
return an empty string "" if the title is already in that language.
  - relevance: one short sentence in the response language on why this paper is \
relevant to the user's question (your own paraphrase, not copied text).

Return ONLY a JSON object of this exact shape and nothing else:
{"sources": [{"index": 1, "title_localized": "...", "relevance": "..."}, ...]}"""


async def localize_papers(papers: list[Paper], question: str, lang: str) -> None:
    """Populate title_zh/relevance_zh (in the response language) for the papers."""
    if not papers or not has_llm_key():
        return
    user = (
        f"RESPONSE LANGUAGE: {_lang_name(lang)}.\n"
        f"User's question:\n{question}\n\n"
        f"Source papers:\n{_format_sources_for_prompt(papers)}"
    )
    try:
        raw, _ = await _chat(_LOCALIZE_SYSTEM, user, max_tokens=3000)
        data = _extract_json(raw)
    except Exception:  # noqa: BLE001 - localization is non-critical, skip on failure
        return
    for s in data.get("sources", []):
        idx = s.get("index", 0) - 1
        if 0 <= idx < len(papers):
            _set_localized(papers[idx], s.get("title_localized", ""), s.get("relevance", ""))
            # An explicit "no" is worth more than parsing the prose note for
            # the word "irrelevant" in two languages.
            if s.get("relevant") is False:
                papers[idx].irrelevant = True


# --- Deep research: plan, evidence typing, contradictions ------------------


_PLAN_SYSTEM = """You plan a biomedical literature review.

Given one research question, break it into 3-5 focused sub-questions that
together cover it, the way a careful reviewer would: mechanism, evidence in
humans, comparative effectiveness, safety, gaps — whichever actually apply.
A complex question searched as one keyword string misses most of the literature.

For each sub-question also give a concise ENGLISH search string (medical
terminology, MeSH-style where natural, under 20 words) — PubMed and OpenAlex are
English-only.

Return ONLY a JSON object of this exact shape:
{"sub_questions": [{"question": "<in the response language>",
                    "search": "<english search string>"}]}"""


async def plan_subquestions(query: str, lang: str) -> list[dict]:
    """Decompose a research question into searchable sub-questions."""
    if not has_llm_key():
        return [{"question": query, "search": query}]
    user = (
        f"RESPONSE LANGUAGE: {_lang_name(lang)}.\n\n"
        f"Research question:\n{query}"
    )
    try:
        raw, _ = await _chat(_PLAN_SYSTEM, user, max_tokens=800)
        data = _extract_json(raw)
    except Exception:  # noqa: BLE001 - fall back to a single pass
        return [{"question": query, "search": await expand_query(query, lang)}]
    subs = []
    for s in data.get("sub_questions", [])[:5]:
        q = (s.get("question") or "").strip()
        search = (s.get("search") or "").strip()
        if q and search:
            subs.append({"question": q, "search": search})
    return subs or [{"question": query, "search": await expand_query(query, lang)}]


def _format_evidence_for_prompt(papers: list[Paper]) -> str:
    """Like the synthesis block, but prefers full text when we have it."""
    blocks = []
    for i, p in enumerate(papers, 1):
        flag = ""
        if p.retraction_status == "retracted":
            flag = "\n    ⚠ INTEGRITY: RETRACTED — do not treat as evidence."
        elif p.retraction_status == "concern":
            flag = "\n    ⚠ INTEGRITY: expression of concern."
        body = p.full_text or p.abstract
        kind = "FULL TEXT" if p.full_text else "ABSTRACT ONLY"
        blocks.append(
            f"--- Source {i} of {len(papers)} — cite this ONLY as "
            f"[{p.citation_key()}]{flag}\n"
            f"    title: {p.title}\n"
            f"    authors: {', '.join(p.authors[:6])}\n"
            f"    year: {p.year}    venue: {p.venue}\n"
            f"    evidence available: {kind}\n"
            f"    text: {body[:9000]}"
        )
    return "\n\n".join(blocks)


_DEEP_SYSTEM = """You are Gaze, writing a research brief for a biomedical
researcher who is accountable for getting it right.

You are given the researcher's question, the sub-questions it was broken into,
and numbered sources. Some sources include FULL TEXT (methods, sample sizes,
limitations); others are ABSTRACT ONLY. Follow these rules WITHOUT EXCEPTION:

1. Use ONLY the provided sources. Never invent findings, numbers or papers.
1b. Set "relevant": false for any source that does not bear on the question.
Sub-question searches drag in strays — a paper about a different organ, field or
organism — and the honest response is to mark it, not to write a polite note
explaining why it does not fit. Anything marked false is removed before the
reader sees it, so marking generously costs nothing; leaving a stray marked true
puts an unrelated paper in front of someone trusting the list.
2. Cite every substantive claim inline using the exact [citation_key] token
shown for that source, e.g. [Smith, 2021]. NEVER cite by number such as [1],
[3], [1,2,7] or [[3]] — the source numbers are for your reference only and a
numeric citation is unusable. Always write the [Surname, Year] token. This
applies inside contradictions and gaps as well as the answer.
3. Where a source is ABSTRACT ONLY, do not assert methodological detail (sample
size, design specifics) you cannot see. Say what is unknown.
4. A source flagged RETRACTED must not support a claim; if mentioned, state
plainly that it is retracted.
4b. Full text carries its own reference list. Studies mentioned INSIDE a source
are not sources you may cite — you have not seen them. Attribute such a claim to
the source you were actually given ("[Tribble, 2021] reports a completed trial"),
never to the study it cites ("[Hui et al., 2020]").
5. Write in the RESPONSE LANGUAGE stated in the user message, naturally.
5b. LENGTH — this is the difference between the two modes and it is not
optional. The answer must run to AT LEAST SIX substantial paragraphs. Work
through: what is established and how firmly; where the evidence is strong and
where it is thin; how the study designs differ and what that does to
comparability; what the clinical or experimental implications are; and what a
reader planning work should do next. A reader chose deep research over the quick
summary precisely because they wanted this. A short answer here is a failure of
the task, not concision — the quick mode already exists for brevity.
6. Do not reproduce source text verbatim — paraphrase.

Produce a structured brief. For evidence_type use exactly one of:
"rct" (randomised trial), "cohort" (observational/cohort/case-control),
"case" (case report/series), "preclinical" (animal/in vivo model),
"invitro" (cell/molecular), "review" (review/meta-analysis/synthesis),
"guideline", or "other".

Return ONLY a JSON object of this exact shape:
{
  "answer": "<the full brief, in the response language, at the length rule 5b requires>",
  "contradictions": ["<where studies disagree, with citations>"],
  "gaps": ["<what the evidence does not yet answer>"],
  "sources": [
    {"index": 1, "title_localized": "...", "relevance": "...",
     "relevant": true,
     "evidence_type": "rct"}
  ]
}
contradictions and gaps may be empty lists, but only if genuinely none apply."""


async def synthesize_deep(
    query: str, lang: str, papers: list[Paper], sub_questions: list[dict]
) -> dict:
    """Write the structured brief: answer, contradictions, gaps, typed sources."""
    if not has_llm_key():
        raise RuntimeError("DEEPSEEK_API_KEY not configured")
    if not papers:
        return {
            "answer": (
                "未能检索到相关文献，无法给出有依据的回答。"
                if lang == "zh"
                else "No relevant literature was retrieved, so no grounded answer can be given."
            ),
            "contradictions": [],
            "gaps": [],
        }
    subs = "\n".join(f"- {s['question']}" for s in sub_questions)
    # The citation rule is repeated here, not only in the system prompt: with a
    # Chinese response the model otherwise drifts into prose citations like
    # "Tribble 等人（2021）", which the UI cannot turn into a clickable link.
    user = (
        f"RESPONSE LANGUAGE: {_lang_name(lang)} — write everything in "
        f"{_lang_name(lang)}.\n"
        "CITATION FORMAT: cite only with the exact bracketed tokens shown below, "
        "e.g. [Tribble, 2021]. Never write a citation as prose "
        "(not 'Tribble 等人（2021）', not 'Tribble et al. (2021)') and never by "
        "number.\n\n"
        f"Research question:\n{query}\n\n"
        f"Sub-questions investigated:\n{subs}\n\n"
        f"Sources:\n{_format_evidence_for_prompt(papers)}"
    )
    data = None
    last_err: Exception | None = None
    for max_tokens in (5000, 7000):
        raw, finish = await _chat(_DEEP_SYSTEM, user, max_tokens=max_tokens)
        try:
            candidate = _extract_json(raw)
        except (ValueError, json.JSONDecodeError) as e:
            last_err = e
            continue
        data = candidate
        if finish != "length":
            break
    if data is None:
        raise last_err or RuntimeError("deep synthesis returned no parseable JSON")

    for s in data.get("sources", []):
        idx = s.get("index", 0) - 1
        if 0 <= idx < len(papers):
            _set_localized(papers[idx], s.get("title_localized", ""), s.get("relevance", ""))
            # An explicit "no" is worth more than parsing the prose note for
            # the word "irrelevant" in two languages.
            if s.get("relevant") is False:
                papers[idx].irrelevant = True
            papers[idx].evidence_type = (s.get("evidence_type") or "").strip().lower()

    return {
        "answer": (data.get("answer") or "").strip(),
        "contradictions": [c for c in data.get("contradictions", []) if c],
        "gaps": [g for g in data.get("gaps", []) if g],
    }


# --- Single-paper deep read (文章精读) --------------------------------------


_READ_SYSTEM = """You are Gaze, reading ONE paper closely for a researcher.

You are given the paper's text. It is either FULL TEXT (methods, results,
limitations visible) or ABSTRACT ONLY. Follow these rules WITHOUT EXCEPTION:

1. Report only what the provided text supports. Never infer a sample size, a
statistic or a method that is not stated.
2. When the text is ABSTRACT ONLY, say so in the fields you cannot fill, using
the response language — do not guess at methodology.
3. If the paper is marked retracted, lead with that.
4. Write in the RESPONSE LANGUAGE stated in the user message.
5. Your prose must be your own — paraphrase, never summarise by quoting.
6. Each finding, limitation and not-established item carries a "quote": the ONE
sentence from the provided text that the item rests on, copied EXACTLY as it
appears, in the paper's own language (do not translate it). This is a locator —
the reader has the article open beside your reading and the quote is used to
highlight the sentence you drew from. Copy it character for character or the
highlight will miss; never invent or stitch together a sentence. Use "" if the
item rests on the paper as a whole rather than any one sentence.

Return ONLY a JSON object of this exact shape:
{
  "question": "<what the paper set out to answer>",
  "design": "<study design and setting; 'not stated' if absent>",
  "sample": "<population/sample size/model; 'not stated' if absent>",
  "findings": [{"text": "<key finding, with the number if the text gives one>", "quote": "<exact source sentence>"}],
  "limitations": [{"text": "<limitation the authors state, or that is evident>", "quote": "<exact source sentence>"}],
  "not_established": [{"text": "<what this paper does NOT show, that a reader might wrongly infer>", "quote": ""}],
  "evidence_type": "rct|cohort|case|preclinical|invitro|review|guideline|other",
  "takeaway": "<2-3 sentences: what a researcher should take from this>"
}"""


# Require a sentence to start with a capital or bracket, so numbered section
# headings ("3.1 Protective effects…") are not split at the "3.".
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\[])")
_WORD = re.compile(r"[a-z0-9]+")


def _snap_quote(body: str, quote: str) -> str:
    """Replace a locator quote with the real sentence it refers to.

    Asking a model to copy a sentence exactly works most of the time and
    paraphrases the rest, and the reader cannot tell the difference — the
    highlight simply fails to appear, at random, on a different subset of
    findings every run. So the quote is treated as a search key, not as text:
    find the sentence in the body it best matches and return that verbatim.
    A quote matching nothing well enough returns "" and is shown without a
    highlight, which is the honest outcome for a claim we cannot locate.
    """
    q = set(_WORD.findall(quote.lower()))
    if len(q) < 4:
        return ""
    best, best_score = "", 0.0
    for sent in _SENT_SPLIT.split(body):
        sent = sent.strip()
        if len(sent) < 25:
            continue
        w = set(_WORD.findall(sent.lower()))
        if not w:
            continue
        # Containment, not Jaccard: a faithful quote of part of a long sentence
        # should still match the sentence that contains it.
        score = len(q & w) / len(q)
        if score > best_score:
            best, best_score = sent, score
    if best_score < 0.6:
        return ""
    # The prompt text prefixes each section's first sentence with its heading
    # ("Results: In diabetic animals…"), which never appears in the rendered
    # article. Strip it or the highlight misses exactly those sentences.
    # Cap is generous because section headings run long. Over-stripping is
    # safe: what remains is still a substring of the rendered paragraph, so
    # the highlight lands either way — under-stripping is what breaks it.
    return re.sub(r"^[0-9A-Z][A-Za-z0-9 \-.,()]{0,120}: (?=[A-Z(])", "", best)


async def read_paper(paper: Paper, lang: str) -> dict:
    """A close structured reading of a single paper."""
    if not has_llm_key():
        raise RuntimeError("DEEPSEEK_API_KEY not configured")
    body = paper.full_text or paper.abstract
    if not body:
        raise ValueError("no text available for this paper")
    kind = "FULL TEXT" if paper.full_text else "ABSTRACT ONLY"
    flag = ""
    if paper.retraction_status == "retracted":
        flag = "\nNOTE: This paper has been RETRACTED."
    elif paper.retraction_status == "concern":
        flag = "\nNOTE: This paper carries an expression of concern."
    user = (
        f"RESPONSE LANGUAGE: {_lang_name(lang)}.{flag}\n\n"
        f"Title: {paper.title}\n"
        f"Authors: {', '.join(paper.authors[:8])}\n"
        f"Year: {paper.year}    Venue: {paper.venue}\n"
        f"Text available: {kind}\n\n"
        f"{body[:24000]}"
    )
    raw, _ = await _chat(_READ_SYSTEM, user, max_tokens=2500)
    data = _extract_json(raw)
    # The model is asked for {text, quote} but sometimes returns bare strings.
    # Normalise to the object shape so the reader has one thing to render, and
    # snap every quote onto a real sentence so the highlight cannot miss.
    for key in ("findings", "limitations", "not_established"):
        items = []
        for x in data.get(key) or []:
            if isinstance(x, str) and x.strip():
                items.append({"text": x.strip(), "quote": ""})
            elif isinstance(x, dict) and (x.get("text") or "").strip():
                raw = (x.get("quote") or "").strip()
                items.append(
                    {"text": x["text"].strip(), "quote": _snap_quote(body, raw) if raw else ""}
                )
        data[key] = items
    return data


_ASK_SYSTEM = """You are Gaze, sitting beside a researcher who is reading one
paper. They have selected a word, a sentence, or a figure caption and asked
about it. You can see the selection and the paper it came from.

This is reading help, not literature synthesis. Rules:

1. Answer the selection in front of you. Use the paper for context — what the
study did, what the abbreviation stands for, what the figure shows — but never
import findings from other papers as if this one showed them.
2. When you draw on general biomedical background rather than this paper, say
which is which. "本文中…" versus "一般而言…" (or "In this paper…" / "In general…").
3. If the selection is a figure or table caption, explain what is being measured,
what the comparison is, and what the reader should look for.
4. If the paper does not settle the question, say so plainly. Do not fill a gap
with a plausible-sounding guess — a wrong explanation of a method costs the
reader more than an admitted gap.
5. Be brief: 1-3 short paragraphs. No preamble, no restating the question.
6. Write in the RESPONSE LANGUAGE stated in the user message. For a translation
request, give the translation first, then a one-line note on any term of art.
7. Plain prose. No citation brackets — there is only one paper here."""


_ASK_INTENTS = {
    "translate": {
        "zh": "把这段文字翻译成中文，并简要说明其中的专业术语。",
        "en": "Translate this passage into English and briefly gloss any terms of art.",
    },
    "explain": {
        "zh": "用通俗的语言解释这段文字的意思。",
        "en": "Explain what this passage means in plain language.",
    },
    "biology": {
        "zh": "这段文字的生物学意义是什么？为什么重要？",
        "en": "What is the biological meaning of this passage, and why does it matter?",
    },
}


async def explain_selection(
    paper: Paper, selection: str, question: str, intent: str, lang: str
) -> str:
    """Answer a question about a selected passage of the paper being read."""
    if not has_llm_key():
        raise RuntimeError("DEEPSEEK_API_KEY not configured")
    ask = question.strip() or _ASK_INTENTS.get(intent, {}).get(
        lang, _ASK_INTENTS["explain"]["en"]
    )
    # Send the whole paper as context where we have it: the answer to "what does
    # ERK5 mean here" usually lives in a different section from the selection.
    body = paper.full_text or paper.abstract or ""
    # A question typed into the bar has no selection attached. Showing the model
    # an empty quotation would imply the reader highlighted nothing on purpose,
    # so the block is simply left out and the question stands on its own.
    quoted = (
        f"THE READER SELECTED:\n\"\"\"{selection[:2000]}\"\"\"\n\n" if selection.strip() else ""
    )
    user = (
        f"RESPONSE LANGUAGE: {_lang_name(lang)}.\n\n"
        f"Paper: {paper.title} ({paper.year}, {paper.venue})\n\n"
        f"{quoted}"
        f"THEIR QUESTION:\n{ask}\n\n"
        f"PAPER TEXT FOR CONTEXT:\n{body[:18000]}"
    )
    out, _ = await _chat(_ASK_SYSTEM, user, max_tokens=900)
    return out


_ENTITY_SYSTEM = """Extract the biomedical entities this paper actually
discusses. Only entities named in the text — never inferred or expanded.

Return ONLY a JSON object of this exact shape:
{
  "genes": ["<official symbol where possible, e.g. TP53>"],
  "proteins": ["..."],
  "pathways": ["<named pathway or signalling cascade>"],
  "drugs": ["..."],
  "diseases": ["..."],
  "methods": ["<key experimental method>"]
}
Every list may be empty. Cap each list at 12 of the most central entities."""


async def extract_entities(paper: Paper) -> dict:
    """Genes/proteins/pathways/drugs named in the paper.

    Extraction only — this is NOT statistical pathway enrichment, and the UI
    says so. It gives a researcher fast links into the reference databases.
    """
    if not has_llm_key():
        return {}
    body = paper.full_text or paper.abstract
    if not body:
        return {}
    try:
        raw, _ = await _chat(
            _ENTITY_SYSTEM,
            f"Title: {paper.title}\n\n{body[:18000]}",
            max_tokens=1200,
        )
        data = _extract_json(raw)
    except Exception:  # noqa: BLE001 - entities are a bonus, never fatal
        return {}
    keys = ("genes", "proteins", "pathways", "drugs", "diseases", "methods")
    return {k: [x for x in (data.get(k) or []) if x][:12] for k in keys}
