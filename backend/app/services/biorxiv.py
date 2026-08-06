"""bioRxiv preprint retrieval.

bioRxiv's own API only supports date/DOI lookup — NOT keyword search — so topic
search goes through Crossref, where every bioRxiv preprint is registered.
bioRxiv/medRxiv are run by "openRxiv" (Crossref member 54368); we filter to
posted-content from that member and keep only records whose institution name is
"bioRxiv" (which distinguishes them from medRxiv). Fail-soft: any error just
yields no bioRxiv results.

Note for callers/UI: these are PREPRINTS — not peer-reviewed. The "bioRxiv"
source badge signals that to the reader.
"""
from __future__ import annotations

import re

import httpx

from ..config import MAX_RESULTS, NCBI_EMAIL
from .models import Paper

CROSSREF_WORKS = "https://api.crossref.org/works"
_TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: str) -> str:
    """Strip JATS/HTML tags and common entities from a Crossref text fragment."""
    if not text:
        return ""
    text = _TAG_RE.sub(" ", text)
    text = (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#x2019;", "’")
    )
    return " ".join(text.split())


def _strip_jats(text: str) -> str:
    """Clean an abstract fragment, dropping any leading 'Abstract' label."""
    return re.sub(r"^abstract\s*", "", _clean(text), flags=re.IGNORECASE)


def _posted_date(item: dict) -> str:
    """First resolvable Crossref date as "YYYY[-MM[-DD]]"; "" when unknown."""
    for key in ("posted", "published", "published-online", "created", "issued"):
        parts = (item.get(key) or {}).get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            nums = [int(n) for n in parts[0][:3] if isinstance(n, int)]
            return "-".join(
                [f"{nums[0]:04d}"] + [f"{n:02d}" for n in nums[1:]]
            )
    return ""


def _pdf_url(resource_url: str) -> str:
    """bioRxiv serves every preprint's PDF at <landing page>.full.pdf."""
    if "biorxiv.org/content/" in resource_url:
        return f"{resource_url.rstrip('/')}.full.pdf"
    return ""


async def search_biorxiv(
    query: str, limit: int = MAX_RESULTS, sort: str = "relevance"
) -> list[Paper]:
    params = {
        "query": query,
        "filter": "type:posted-content,member:54368",  # openRxiv (bioRxiv/medRxiv)
        "rows": str(min(limit * 2, 50)),  # over-fetch, then keep only bioRxiv
    }
    if sort == "date":
        params["sort"] = "published"
        params["order"] = "desc"
    if NCBI_EMAIL:
        params["mailto"] = NCBI_EMAIL  # Crossref "polite pool"
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(CROSSREF_WORKS, params=params, timeout=20)
            r.raise_for_status()
            items = r.json().get("message", {}).get("items", [])
    except (httpx.HTTPError, ValueError):
        return []

    papers: list[Paper] = []
    for item in items:
        institutions = [
            (i.get("name") or "").lower() for i in item.get("institution") or []
        ]
        if not any("biorxiv" in name for name in institutions):
            continue  # exclude medRxiv / other posted-content on the same member
        titles = item.get("title") or []
        title = _clean(titles[0]) if titles else ""
        if not title:
            continue

        authors = []
        for a in item.get("author") or []:
            name = " ".join(p for p in (a.get("given"), a.get("family")) if p)
            if name:
                authors.append(name)
        first_family = ""
        if item.get("author"):
            first_family = (item["author"][0].get("family") or "").strip()

        doi = (item.get("DOI") or "").strip()
        resource_url = (item.get("resource") or {}).get("primary", {}).get("URL", "")
        pub_date = _posted_date(item)
        papers.append(
            Paper(
                source="biorxiv",
                source_id=doi,
                title=title,
                authors=authors,
                year=int(pub_date[:4]) if pub_date[:4].isdigit() else None,
                venue="bioRxiv (preprint)",
                url=resource_url or item.get("URL") or (f"https://doi.org/{doi}" if doi else ""),
                doi=doi,
                abstract=_strip_jats(item.get("abstract", "")),
                first_author_family=first_family,
                pub_date=pub_date,
                # Preprints are open by definition.
                oa_url=_pdf_url(resource_url),
            )
        )
        if len(papers) >= limit:
            break
    return papers
