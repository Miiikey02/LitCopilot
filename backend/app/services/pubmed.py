"""PubMed retrieval via NCBI E-utilities (esearch + efetch).

No scraping — only the official public API. Calls are throttled to respect
NCBI's rate policy (3/sec anonymous, 10/sec with an API key).
"""
from __future__ import annotations

import asyncio
import re
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


async def _esearch(
    client: httpx.AsyncClient, query: str, retmax: int, sort: str = "relevance"
) -> list[str]:
    await _limiter.acquire()
    params = _common_params() | {
        "term": query,
        "retmax": str(retmax),
        "retmode": "json",
        # E-utilities' own newest-first ordering, so "sort by date" surfaces
        # recent papers rather than re-ordering the top relevance hits.
        "sort": "pub_date" if sort == "date" else "relevance",
    }
    r = await client.get(f"{EUTILS}/esearch.fcgi", params=params, timeout=20)
    r.raise_for_status()
    return r.json().get("esearchresult", {}).get("idlist", [])


def _text(node) -> str:
    return "".join(node.itertext()).strip() if node is not None else ""


_MONTHS = {
    m: i
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun",
         "jul", "aug", "sep", "oct", "nov", "dec"),
        start=1,
    )
}


def _month_num(raw: str) -> int | None:
    """PubMed months come as "03", "3" or "Mar" depending on the record."""
    raw = raw.strip()
    if raw.isdigit():
        n = int(raw)
        return n if 1 <= n <= 12 else None
    return _MONTHS.get(raw[:3].lower())


def _date_from(node) -> str:
    """Build "YYYY", "YYYY-MM" or "YYYY-MM-DD" from a PubMed date element."""
    if node is None:
        return ""
    year = "".join(c for c in _text(node.find("Year")) if c.isdigit())[:4]
    if not year:
        # MedlineDate is free text like "2019 Nov-Dec" — take the year only.
        digits = "".join(c for c in _text(node.find("MedlineDate")) if c.isdigit())[:4]
        return digits if len(digits) == 4 else ""
    month = _month_num(_text(node.find("Month")))
    if not month:
        return year
    day = "".join(c for c in _text(node.find("Day")) if c.isdigit())[:2]
    if not day:
        return f"{year}-{month:02d}"
    return f"{year}-{month:02d}-{int(day):02d}"


def _pub_date(article: ET.Element) -> str:
    """Prefer the electronic ArticleDate; fall back to the journal PubDate."""
    return _date_from(article.find("ArticleDate")) or _date_from(
        article.find("Journal/JournalIssue/PubDate")
    )


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

    pub_date = _pub_date(article)
    year = int(pub_date[:4]) if pub_date[:4].isdigit() else None

    venue = _text(article.find("Journal/Title"))

    # PubMed marks the retracted article itself as "Retracted Publication";
    # "Retraction of Publication" is the notice announcing someone else's
    # retraction, which is a normal citable item and must not be flagged.
    pub_types = {
        (_text(t) or "").lower() for t in article.findall("PublicationTypeList/PublicationType")
    }
    retraction_status = ""
    if "retracted publication" in pub_types:
        retraction_status = "retracted"
    elif "expression of concern" in pub_types:
        retraction_status = "concern"

    doi = ""
    pmcid = ""
    for eid in art.findall(".//ArticleId"):
        id_type = eid.get("IdType")
        if id_type == "doi" and not doi:
            doi = _text(eid)
        elif id_type == "pmc" and not pmcid:
            pmcid = _text(eid)

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
        pub_date=pub_date,
        # A PMC id means the full text is free to read there.
        oa_url=f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/" if pmcid else "",
        retraction_status=retraction_status,
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
    # Restore the esearch ranking (relevance or date); efetch does not promise
    # to echo the id order back.
    rank = {pmid: i for i, pmid in enumerate(pmids)}
    papers.sort(key=lambda p: rank.get(p.source_id, len(rank)))
    return papers


async def search_pubmed(
    query: str, retmax: int = MAX_RESULTS, sort: str = "relevance"
) -> list[Paper]:
    """Search PubMed for `query` and return parsed Paper records with abstracts.

    `sort` is "relevance" (default) or "date" (newest first).
    """
    async with httpx.AsyncClient() as client:
        pmids = await _esearch(client, query, retmax, sort)
        return await _efetch(client, pmids)


async def fetch_by_doi(doi: str) -> Paper | None:
    """Look one paper up by DOI, for filling in a missing abstract.

    Other sources sometimes return a paper's metadata without its abstract
    (common for very recent or closed-access articles); PubMed usually has it.
    Fails soft — returns None if the DOI isn't indexed or anything goes wrong.
    """
    doi = (doi or "").strip()
    if not doi:
        return None
    try:
        async with httpx.AsyncClient() as client:
            # [AID] is the article-id field; fall back to a bare DOI search,
            # which PubMed also resolves, in case the field query misses.
            ids = await _esearch(client, f"{doi}[AID]", 1)
            if not ids:
                ids = await _esearch(client, doi, 1)
            if not ids:
                return None
            papers = await _efetch(client, ids[:1])
            return papers[0] if papers else None
    except (httpx.HTTPError, ValueError, KeyError):
        return None


# --- Open-access full text (PMC) ------------------------------------------

# Sections that carry the findings. Skip references/acknowledgements, which are
# long and add nothing the model can reason from.
_SKIP_SECTIONS = ("reference", "acknowledg", "author contribution",
                  "competing interest", "supplementary", "funding")


def _pmcid_from(paper: Paper) -> str:
    """PMC id, recovered from the oa_url we stored at parse time."""
    if "pmc.ncbi.nlm.nih.gov/articles/" not in (paper.oa_url or ""):
        return ""
    tail = paper.oa_url.rstrip("/").rsplit("/", 1)[-1]
    return tail if tail.upper().startswith("PMC") else ""


def _extract_body(root: ET.Element) -> str:
    """Plain text of an article body, section by section."""
    parts: list[str] = []
    for sec in root.iter():
        if sec.tag != "sec":
            continue
        title = _text(sec.find("title")).strip()
        if title and any(s in title.lower() for s in _SKIP_SECTIONS):
            continue
        paras = [_text(p) for p in sec.findall("p")]
        body = " ".join(t for t in paras if t)
        if body:
            parts.append(f"{title}: {body}" if title else body)
    if not parts:  # some records have loose <p> with no <sec>
        parts = [_text(p) for p in root.iter("p")]
    return _tidy_citations(" ".join(p for p in parts if p).strip())


# JATS wraps each reference marker in its own <xref>, so flattening the element
# yields "[[1], [2], [3]]" where the paper prints "[1-3]". Left alone it reads
# as broken markup in the reading pane and wastes tokens in the prompt.
_XREF_GROUP = re.compile(r"\[\s*(?:\[\d+\][\s,;]*)+\]")
_XREF_RUN = re.compile(r"\[\d+\](?:\s*[,;]\s*\[\d+\])+")


def _tidy_citations(text: str) -> str:
    def join(m: re.Match) -> str:
        return "[" + ",".join(re.findall(r"\d+", m.group(0))) + "]"

    return _XREF_RUN.sub(join, _XREF_GROUP.sub(join, text))


def _blocks_from_body(body: ET.Element) -> list[dict]:
    """Full text as ordered blocks, for a reading pane rather than a prompt.

    `_extract_body` flattens an article into one string, which is all a model
    needs. A person reading the paper needs the structure back: which heading
    they are under, where a paragraph ends, and what Figure 1's caption says —
    captions especially, since "what does Figure 1 show" is the question people
    ask most and the caption is the only part of a figure we have as text.
    """
    out: list[dict] = []

    def caption_of(el: ET.Element) -> tuple[str, str]:
        return _text(el.find("label")).strip(), _text(el.find("caption")).strip()

    def walk(el: ET.Element, depth: int) -> None:
        for child in el:
            tag = child.tag
            if tag == "sec":
                title = _text(child.find("title")).strip()
                if title and any(k in title.lower() for k in _SKIP_SECTIONS):
                    continue
                if title:
                    out.append({"type": "heading", "text": title, "level": min(depth, 3)})
                walk(child, depth + 1)
            elif tag == "p":
                t = _tidy_citations(_text(child).strip())
                if t:
                    out.append({"type": "p", "text": t})
            elif tag in ("fig", "table-wrap"):
                label, cap = caption_of(child)
                if label or cap:
                    out.append({
                        "type": "figure" if tag == "fig" else "table",
                        "label": label or ("Figure" if tag == "fig" else "Table"),
                        "text": cap,
                    })
            elif tag == "title":
                continue
            else:
                walk(child, depth)

    walk(body, 1)
    for i, b in enumerate(out):
        b["id"] = f"b{i}"
    return out


def _license_of(root: ET.Element) -> str:
    """The article's stated licence, so the reader can show what it may show."""
    lic = root.find(".//permissions/license")
    if lic is None:
        return ""
    href = lic.get("{http://www.w3.org/1999/xlink}href", "")
    return (_text(lic) or href).strip()[:300]


async def fetch_article(pmcid: str) -> dict:
    """One open-access article as reading blocks. Empty dict when unavailable."""
    if not pmcid:
        return {}
    try:
        await _limiter.acquire()
        async with httpx.AsyncClient() as client:
            params = _common_params() | {"db": "pmc", "id": pmcid, "retmode": "xml"}
            r = await client.get(f"{EUTILS}/efetch.fcgi", params=params, timeout=30)
            r.raise_for_status()
            root = ET.fromstring(r.text)
    except (httpx.HTTPError, ET.ParseError, ValueError):
        return {}
    body = root.find(".//body")
    if body is None:
        return {}
    blocks = _blocks_from_body(body)
    if sum(len(b.get("text", "")) for b in blocks) < 500:
        return {}

    # Many publishers deposit figures in <floats-group>, outside <body>, so
    # walking the body alone finds none of them even though the text says
    # "(Fig. 1)" throughout. Collect what the body missed and append it — a
    # caption at the end is far better than a caption the reader cannot reach.
    seen = {b.get("label", "") for b in blocks if b["type"] in ("figure", "table")}
    extra: list[dict] = []
    for tag, kind in (("fig", "figure"), ("table-wrap", "table")):
        for el in root.iter(tag):
            label = _text(el.find("label")).strip()
            cap = _text(el.find("caption")).strip()
            if not (label or cap) or label in seen:
                continue
            seen.add(label)
            extra.append({"type": kind, "label": label or kind.title(), "text": cap})
    if extra:
        blocks.append({"type": "heading", "text": "Figures and tables", "level": 1})
        blocks.extend(extra)
    for i, b in enumerate(blocks):
        b["id"] = f"b{i}"
    return {"blocks": blocks, "license": _license_of(root)}


async def fetch_full_text(papers: list[Paper], limit: int = 8) -> int:
    """Fill `full_text` for open-access papers. Returns how many were read.

    Only PMC-hosted open-access articles are fetched — that is the text NCBI
    serves freely through E-utilities. Paywalled papers keep their abstract.
    Bounded because each paper is a separate rate-limited request, and fails
    soft so a slow or missing article never breaks a run.
    """
    targets = [p for p in papers if not p.full_text and _pmcid_from(p)][:limit]
    if not targets:
        return 0

    async def one(paper: Paper) -> bool:
        pmcid = _pmcid_from(paper)
        try:
            await _limiter.acquire()
            async with httpx.AsyncClient() as client:
                params = _common_params() | {"db": "pmc", "id": pmcid, "retmode": "xml"}
                r = await client.get(f"{EUTILS}/efetch.fcgi", params=params, timeout=30)
                r.raise_for_status()
                body = _extract_body(ET.fromstring(r.text))
        except (httpx.HTTPError, ET.ParseError, ValueError):
            return False
        # Very short bodies mean the OA text wasn't actually served; the
        # abstract we already have is better than a stub.
        if len(body) < 500:
            return False
        paper.full_text = body[:20000]
        return True

    results = await asyncio.gather(*[one(p) for p in targets], return_exceptions=True)
    return sum(1 for r in results if r is True)
