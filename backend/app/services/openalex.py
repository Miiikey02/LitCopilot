"""OpenAlex retrieval via the free public API (no key required).

OpenAlex (~250M+ scholarly works across all fields, incl. preprints and
non-medical venues) broadens coverage well beyond PubMed — a legitimate,
ToS-clean stand-in for Google Scholar's breadth. We send one search per user
query and fail soft so an OpenAlex outage never breaks the pipeline.

Politeness: OpenAlex serves a faster, more reliable "polite pool" to callers who
identify themselves with a `mailto`. We pass one when an email is configured.
"""
from __future__ import annotations

import httpx

from ..config import MAX_RESULTS, NCBI_EMAIL
from .models import Paper

OPENALEX_WORKS = "https://api.openalex.org/works"


def _reconstruct_abstract(inv: dict | None) -> str:
    """Rebuild plain-text abstract from OpenAlex's inverted-index representation."""
    if not inv:
        return ""
    positions: list[tuple[int, str]] = []
    for word, idxs in inv.items():
        for i in idxs:
            positions.append((i, word))
    positions.sort(key=lambda t: t[0])
    return " ".join(word for _, word in positions)


def _bare_doi(doi_url: str | None) -> str:
    """OpenAlex gives DOIs as full URLs; return the bare 10.x/... form."""
    if not doi_url:
        return ""
    return doi_url.replace("https://doi.org/", "").replace("http://doi.org/", "")


async def search_openalex(query: str, limit: int = MAX_RESULTS) -> list[Paper]:
    params = {
        "search": query,
        "per-page": str(min(limit, 200)),
    }
    if NCBI_EMAIL:
        params["mailto"] = NCBI_EMAIL
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(OPENALEX_WORKS, params=params, timeout=20)
            r.raise_for_status()
            results = r.json().get("results", [])
    except (httpx.HTTPError, ValueError):
        # Fail soft — the other sources still yield a usable answer.
        return []

    papers = []
    for item in results:
        authors = [
            a["author"]["display_name"]
            for a in (item.get("authorships") or [])
            if a.get("author") and a["author"].get("display_name")
        ]
        # OpenAlex names are "First Last", so the surname is the last token.
        first_family = authors[0].split()[-1] if authors else ""

        primary = item.get("primary_location") or {}
        source_obj = primary.get("source") or {}
        venue = source_obj.get("display_name") or ""

        doi = _bare_doi(item.get("doi"))
        url = (
            item.get("doi")
            or primary.get("landing_page_url")
            or item.get("id")
            or ""
        )
        # OpenAlex work id looks like "https://openalex.org/W2741809807".
        oa_id = (item.get("id") or "").rsplit("/", 1)[-1]

        papers.append(
            Paper(
                source="openalex",
                source_id=oa_id,
                title=item.get("display_name") or item.get("title") or "",
                authors=authors,
                year=item.get("publication_year"),
                venue=venue,
                url=url,
                doi=doi,
                abstract=_reconstruct_abstract(item.get("abstract_inverted_index")),
                first_author_family=first_family,
            )
        )
    return papers
