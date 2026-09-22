"""Crossref, the registry DOIs are issued through.

The last resort for "what is this DOI": every DOI resolves here, with no key
and no meter, even when the richer indexes are rate-limited or do not cover
the field. It often has no abstract, so a paper found only here is shown with
its metadata and read from the publisher's page.
"""
from __future__ import annotations

import re

import httpx

from ..config import NCBI_EMAIL
from .models import Paper


def _strip_jats(text: str) -> str:
    text = re.sub(r"<jats:title>.*?</jats:title>", " ", text or "", flags=re.S)
    return " ".join(re.sub(r"<[^>]+>", " ", text).split())


async def fetch_by_doi(doi: str) -> Paper | None:
    doi = (doi or "").strip()
    if not doi:
        return None
    # Crossref's "polite pool" is faster for callers that say who they are.
    headers = {"User-Agent": f"Gaze (mailto:{NCBI_EMAIL})"} if NCBI_EMAIL else {}
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"https://api.crossref.org/works/{doi}", headers=headers, timeout=15
            )
            if r.status_code != 200:
                return None
            m = r.json().get("message") or {}
    except (httpx.HTTPError, ValueError):
        return None
    title = " ".join((m.get("title") or [""])[0].split())
    if not title:
        return None
    authors = [
        " ".join(x for x in (a.get("given"), a.get("family")) if x)
        for a in m.get("author") or []
        if a.get("family")
    ]
    parts = ((m.get("published") or m.get("issued") or {}).get("date-parts") or [[None]])[0]
    year = parts[0] if parts else None
    return Paper(
        source="crossref",
        source_id=m.get("DOI") or doi,
        title=title,
        authors=authors,
        year=year,
        venue=(m.get("container-title") or [""])[0],
        url=f"https://doi.org/{m.get('DOI') or doi}",
        doi=(m.get("DOI") or doi).lower(),
        abstract=_strip_jats(m.get("abstract") or ""),
        first_author_family=(m.get("author") or [{}])[0].get("family", "") if authors else "",
        pub_date="-".join(f"{int(x):02d}" if i else str(x) for i, x in enumerate(parts) if x),
    )


def _similar(a: str, b: str) -> float:
    from difflib import SequenceMatcher

    norm = lambda t: re.sub(r"[^a-z0-9]+", "", (t or "").lower())
    return SequenceMatcher(None, norm(a), norm(b)).ratio()


async def match_title(title: str) -> str:
    """The DOI of the paper with this title, or "" if none is close enough.

    A pasted title usually arrives damaged — spaces lost at line breaks
    ("sequentialdrug"), a hyphen gone — which defeats exact-phrase search in
    every index. Crossref's bibliographic matching tolerates that, and the
    similarity bar keeps a merely similar paper from standing in for it.
    """
    headers = {"User-Agent": f"Gaze (mailto:{NCBI_EMAIL})"} if NCBI_EMAIL else {}
    items = None
    # Crossref's search takes 2–8 s and more under load; one retry.
    for _ in range(2):
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(
                    "https://api.crossref.org/works",
                    params={"query.bibliographic": title, "rows": 3, "select": "DOI,title"},
                    headers=headers,
                    timeout=25,
                )
            if r.status_code == 200:
                items = r.json().get("message", {}).get("items") or []
                break
        except (httpx.HTTPError, ValueError):
            continue
    if not items:
        return ""
    for item in items:
        if _similar((item.get("title") or [""])[0], title) >= 0.93:
            return (item.get("DOI") or "").lower()
    return ""


_META = re.compile(
    r'<meta[^>]+(?:name|property)="(citation_abstract|dc\.description|description)"'
    r'[^>]+content="([^"]*)"',
    re.I,
)


async def publisher_abstract(doi: str) -> str:
    """The abstract from the publisher's own page, for a paper no index has one for.

    Closed-access journals often give their abstracts to nobody — not to
    Crossref, not to Semantic Scholar — but put them in the page's meta tags
    for search engines. Only for the few papers someone asked for by name: it
    is a page fetch per paper, and a short "description" is the site's
    boilerplate, not an abstract.
    """
    # Publisher pages are heavy (Nature's is 400 KB and takes 6–11 s), so a
    # generous timeout and one retry — a miss here means the reader gets
    # "no abstract" for the very paper they asked for.
    page = ""
    for _ in range(2):
        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                r = await client.get(
                    f"https://doi.org/{doi}",
                    headers={"User-Agent": "Mozilla/5.0 (compatible; Gaze literature assistant)"},
                    timeout=25,
                )
            if r.status_code == 200:
                page = r.text[:600_000]
                break
            if r.status_code in (403, 404):
                return ""
        except httpx.HTTPError:
            continue
    if not page:
        return ""
    import html

    found = {m.group(1).lower(): html.unescape(m.group(2)) for m in _META.finditer(page)}
    for key in ("citation_abstract", "dc.description", "description"):
        text = " ".join(_strip_jats(found.get(key, "")).split())
        if len(text) >= 300:
            return text
    return ""
