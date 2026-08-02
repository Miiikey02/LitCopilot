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
        blocks.append(
            f"Source {i} (index={i}) — cite this source as [{p.citation_key()}]\n"
            f"    title: {p.title}\n"
            f"    authors: {', '.join(p.authors[:6])}\n"
            f"    year: {p.year}\n"
            f"    venue: {p.venue}\n"
            f"    abstract: {p.abstract}"
        )
    return "\n\n".join(blocks)


_SYNTH_SYSTEM = """You are LitCopilot, a biomedical literature research assistant.

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
translate a literal draft from the other language. 3-5 paragraphs.
5. Do NOT reproduce abstract text verbatim — paraphrase in your own words.

Then, for EACH source, provide (ALL in the RESPONSE LANGUAGE):
  - title_localized: the paper's title translated into the response language. If \
    the title is ALREADY in the response language, return an empty string "".
  - relevance: one short sentence in the response language on why this paper is \
    relevant to the question (your own paraphrase, not copied text).

Return ONLY a JSON object of this exact shape and nothing else:
{
  "answer": "<the synthesized answer in the response language>",
  "sources": [
    {"index": 1, "title_localized": "...", "relevance": "..."},
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

    return {"answer": data.get("answer", "").strip()}
