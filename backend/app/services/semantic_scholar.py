"""Semantic Scholar retrieval via the Graph API.

Used to broaden coverage beyond PubMed and to pull venue/year metadata.

A key matters here more than it looks. Without one, every unauthenticated
caller in the world shares a single pool, and that pool is saturated
essentially all the time: measured from two different networks, three
consecutive searches returned 429 on every attempt. The source was not slow or
partial — it was contributing nothing, and failing soft meant nothing said so.
Keys are free from S2 for research use.
"""
from __future__ import annotations

import asyncio

import httpx

from ..config import MAX_RESULTS, S2_API_KEY
from .models import Paper

S2_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"
FIELDS = (
    "title,abstract,year,venue,authors,externalIds,url,"
    "publicationDate,openAccessPdf"
)


async def search_semantic_scholar(
    query: str, limit: int = MAX_RESULTS, sort: str = "relevance"
) -> list[Paper]:
    """Search Semantic Scholar. The public search endpoint has no sort option,
    so for `sort="date"` we over-fetch and re-rank newest-first locally.
    """
    fetch = min(limit * 3, 100) if sort == "date" else limit
    params = {"query": query, "limit": str(fetch), "fields": FIELDS}
    headers = {"x-api-key": S2_API_KEY} if S2_API_KEY else {}
    # Two attempts with a pause, because an unkeyed 429 often clears within a
    # second or two. Kept short: the caller is waiting, and the other sources
    # have already answered.
    delay = 1.2
    try:
        async with httpx.AsyncClient() as client:
            for attempt in range(2):
                r = await client.get(S2_SEARCH, params=params, headers=headers, timeout=20)
                if r.status_code == 429 and attempt == 0:
                    await asyncio.sleep(delay)
                    continue
                r.raise_for_status()
                data = r.json().get("data", [])
                break
            else:
                return []
    except (httpx.HTTPError, ValueError):
        # Fail soft — PubMed alone still yields a usable answer. The search
        # response now names a source that returned nothing, so this is quiet
        # rather than invisible.
        return []

    papers = [_to_paper(item) for item in data]
    if sort == "date":
        papers.sort(key=lambda p: p.sort_date(), reverse=True)
        papers = papers[:limit]
    return papers


def _to_paper(item: dict) -> Paper:
    ext = item.get("externalIds") or {}
    oa = item.get("openAccessPdf") or {}
    authors = [a.get("name", "") for a in (item.get("authors") or []) if a.get("name")]
    return Paper(
        source="semantic_scholar",
        source_id=str(item.get("paperId", "")),
        title=item.get("title") or "",
        authors=authors,
        year=item.get("year"),
        venue=item.get("venue") or "",
        url=item.get("url") or "",
        doi=ext.get("DOI", "") or "",
        abstract=item.get("abstract") or "",
        # S2 stores "First Last", so the surname is the last token.
        first_author_family=authors[0].split()[-1] if authors else "",
        pub_date=item.get("publicationDate") or "",
        oa_url=oa.get("url") or "",
    )


async def fetch_by_doi(doi: str) -> Paper | None:
    """One paper by DOI — a fallback when OpenAlex and PubMed cannot answer.

    PubMed does not index much outside biomedicine proper (a Nature Machine
    Intelligence paper, say), and OpenAlex is metered; S2 covers both gaps.
    """
    doi = (doi or "").strip()
    if not doi:
        return None
    headers = {"x-api-key": S2_API_KEY} if S2_API_KEY else {}
    try:
        async with httpx.AsyncClient() as client:
            for attempt in range(2):
                r = await client.get(
                    f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}",
                    params={"fields": FIELDS},
                    headers=headers,
                    timeout=15,
                )
                if r.status_code == 429 and attempt == 0:
                    await asyncio.sleep(1.2)
                    continue
                if r.status_code != 200:
                    return None
                return _to_paper(r.json())
    except (httpx.HTTPError, ValueError):
        return None
    return None
