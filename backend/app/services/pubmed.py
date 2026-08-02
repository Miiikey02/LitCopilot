"""PubMed retrieval via NCBI E-utilities (esearch + efetch).

No scraping — only the official public API. Calls are throttled to respect
NCBI's rate policy (3/sec anonymous, 10/sec with an API key).
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import httpx

from ..config import MAX_RESULTS, NCBI_API_KEY, NCBI_EMAIL, NCBI_TOOL
from .models import Paper
from .ratelimit import RateLimiter

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

# 10/sec with a key, 3/sec without. Stay a hair under to be safe.
_limiter = RateLimiter(max_per_second=9.0 if NCBI_API_KEY else 2.7)


def _common_params() -> dict:
    p = {"tool": NCBI_TOOL, "db": "pubmed"}
    if NCBI_API_KEY:
        p["api_key"] = NCBI_API_KEY
    if NCBI_EMAIL:
        p["email"] = NCBI_EMAIL
    return p


async def _esearch(client: httpx.AsyncClient, query: str, retmax: int) -> list[str]:
    await _limiter.acquire()
    params = _common_params() | {
        "term": query,
        "retmax": str(retmax),
        "retmode": "json",
        "sort": "relevance",
    }
    r = await client.get(f"{EUTILS}/esearch.fcgi", params=params, timeout=20)
    r.raise_for_status()
    return r.json().get("esearchresult", {}).get("idlist", [])


def _text(node) -> str:
    return "".join(node.itertext()).strip() if node is not None else ""


def _parse_article(art: ET.Element) -> Paper | None:
    medline = art.find("MedlineCitation")
    if medline is None:
        return None
    pmid = _text(medline.find("PMID"))
    article = medline.find("Article")
    if article is None:
        return None

    title = _text(article.find("ArticleTitle"))

    # Abstract may be split into multiple labeled sections.
    abstract_parts = [
        _text(t) for t in article.findall("Abstract/AbstractText")
    ]
    abstract = " ".join(p for p in abstract_parts if p)

    authors = []
    first_family = ""
    for a in article.findall("AuthorList/Author"):
        last = _text(a.find("LastName"))
        initials = _text(a.find("Initials"))
        if last:
            authors.append(f"{last} {initials}".strip())
            if not first_family:
                first_family = last

    year = None
    for path in ("Journal/JournalIssue/PubDate/Year", "Journal/JournalIssue/PubDate/MedlineDate"):
        node = article.find(path)
        if node is not None and _text(node):
            digits = "".join(c for c in _text(node) if c.isdigit())[:4]
            if digits:
                year = int(digits)
                break

    venue = _text(article.find("Journal/Title"))

    doi = ""
    for eid in art.findall(".//ArticleId"):
        if eid.get("IdType") == "doi":
            doi = _text(eid)
            break

    return Paper(
        source="pubmed",
        source_id=pmid,
        title=title,
        authors=authors,
        year=year,
        venue=venue,
        url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
        doi=doi,
        abstract=abstract,
        first_author_family=first_family,
    )


async def _efetch(client: httpx.AsyncClient, pmids: list[str]) -> list[Paper]:
    if not pmids:
        return []
    await _limiter.acquire()
    params = _common_params() | {"id": ",".join(pmids), "retmode": "xml"}
    r = await client.get(f"{EUTILS}/efetch.fcgi", params=params, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    papers = []
    for art in root.findall(".//PubmedArticle"):
        p = _parse_article(art)
        if p and p.title:
            papers.append(p)
    return papers


async def search_pubmed(query: str, retmax: int = MAX_RESULTS) -> list[Paper]:
    """Search PubMed for `query` and return parsed Paper records with abstracts."""
    async with httpx.AsyncClient() as client:
        pmids = await _esearch(client, query, retmax)
        return await _efetch(client, pmids)
