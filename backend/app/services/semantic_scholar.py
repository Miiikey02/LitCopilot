"""Semantic Scholar retrieval via the public Graph API (no key required).

Used to broaden coverage beyond PubMed and to pull venue/year metadata. The
public endpoint is rate-limited by S2; we keep request volume low (one search
per user query) and fail soft so a S2 outage never breaks the pipeline.
"""
from __future__ import annotations

import httpx

from ..config import MAX_RESULTS
from .models import Paper

S2_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"
FIELDS = "title,abstract,year,venue,authors,externalIds,url"


async def search_semantic_scholar(query: str, limit: int = MAX_RESULTS) -> list[Paper]:
    params = {"query": query, "limit": str(limit), "fields": FIELDS}
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(S2_SEARCH, params=params, timeout=20)
            r.raise_for_status()
            data = r.json().get("data", [])
    except (httpx.HTTPError, ValueError):
        # Fail soft — PubMed alone still yields a usable answer.
        return []

    papers = []
    for item in data:
        ext = item.get("externalIds") or {}
        doi = ext.get("DOI", "") or ""
        authors = [a.get("name", "") for a in (item.get("authors") or []) if a.get("name")]
        # S2 stores "First Last", so the surname is the last token.
        first_family = authors[0].split()[-1] if authors else ""
        papers.append(
            Paper(
                source="semantic_scholar",
                source_id=str(item.get("paperId", "")),
                title=item.get("title") or "",
                authors=authors,
                year=item.get("year"),
                venue=item.get("venue") or "",
                url=item.get("url") or "",
                doi=doi,
                abstract=item.get("abstract") or "",
                first_author_family=first_family,
            )
        )
    return papers
