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


def _oa_pdf(item: dict) -> str:
    """Best legally-free full text OpenAlex knows about, if any."""
    best = item.get("best_oa_location") or {}
    return best.get("pdf_url") or best.get("landing_page_url") or (
        item.get("open_access") or {}
    ).get("oa_url") or ""


async def search_openalex(
    query: str, limit: int = MAX_RESULTS, sort: str = "relevance"
) -> list[Paper]:
    params = {
        "search": query,
        "per-page": str(min(limit, 200)),
    }
    if sort == "date":
        params["sort"] = "publication_date:desc"
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
                pub_date=item.get("publication_date") or "",
                oa_url=_oa_pdf(item),
                retraction_status="retracted" if item.get("is_retracted") else "",
            )
        )
    return papers


# --- Single-work lookup and the connected-papers graph ---------------------

_OA_FIELDS = (
    "id,doi,display_name,publication_year,publication_date,authorships,"
    "primary_location,open_access,best_oa_location,cited_by_count,"
    "referenced_works,related_works,is_retracted,abstract_inverted_index"
)


def _params(extra: dict) -> dict:
    p = dict(extra)
    if NCBI_EMAIL:
        p["mailto"] = NCBI_EMAIL
    return p


async def _get(client: httpx.AsyncClient, url: str, params: dict) -> dict:
    r = await client.get(url, params=_params(params), timeout=25)
    r.raise_for_status()
    return r.json()


def _to_paper(item: dict) -> Paper:
    authors = [
        a["author"]["display_name"]
        for a in (item.get("authorships") or [])
        if a.get("author") and a["author"].get("display_name")
    ]
    primary = item.get("primary_location") or {}
    source_obj = primary.get("source") or {}
    doi = _bare_doi(item.get("doi"))
    return Paper(
        source="openalex",
        source_id=(item.get("id") or "").rsplit("/", 1)[-1],
        title=item.get("display_name") or "",
        authors=authors,
        year=item.get("publication_year"),
        venue=source_obj.get("display_name") or "",
        url=item.get("doi") or primary.get("landing_page_url") or item.get("id") or "",
        doi=doi,
        abstract=_reconstruct_abstract(item.get("abstract_inverted_index")),
        first_author_family=authors[0].split()[-1] if authors else "",
        pub_date=item.get("publication_date") or "",
        oa_url=_oa_pdf(item),
        retraction_status="retracted" if item.get("is_retracted") else "",
    )


async def resolve_work(identifier: str) -> dict | None:
    """Find one OpenAlex work by DOI, OpenAlex id, PMID, or exact title."""
    ident = (identifier or "").strip()
    if not ident:
        return None
    try:
        async with httpx.AsyncClient() as client:
            if ident.lower().startswith("10."):
                return await _get(
                    client, f"{OPENALEX_WORKS}/doi:{ident}", {"select": _OA_FIELDS}
                )
            if ident.upper().startswith("W") and ident[1:].isdigit():
                return await _get(
                    client, f"{OPENALEX_WORKS}/{ident}", {"select": _OA_FIELDS}
                )
            if ident.isdigit():
                return await _get(
                    client, f"{OPENALEX_WORKS}/pmid:{ident}", {"select": _OA_FIELDS}
                )
            data = await _get(
                client,
                OPENALEX_WORKS,
                {"search": ident, "per-page": "1", "select": _OA_FIELDS},
            )
            results = data.get("results") or []
            return results[0] if results else None
    except (httpx.HTTPError, ValueError):
        return None


async def _batch_works(client: httpx.AsyncClient, ids: list[str]) -> list[dict]:
    """Fetch many works by OpenAlex id, in chunks the filter API accepts."""
    out: list[dict] = []
    for i in range(0, len(ids), 40):
        chunk = [w.rsplit("/", 1)[-1] for w in ids[i : i + 40]]
        try:
            data = await _get(
                client,
                OPENALEX_WORKS,
                {
                    "filter": f"openalex_id:{'|'.join(chunk)}",
                    "per-page": str(len(chunk)),
                    "select": _OA_FIELDS,
                },
            )
            out.extend(data.get("results") or [])
        except (httpx.HTTPError, ValueError):
            continue
    return out


async def connected_papers(seed: dict, limit: int = 28) -> dict:
    """Build a Connected-Papers-style graph around one work.

    Candidates are the seed's references, the papers citing it, and OpenAlex's
    own related works. Similarity between any two is bibliographic coupling —
    the overlap of their reference lists (Jaccard) — which is what makes two
    papers "about the same thing" even when neither cites the other.
    """
    seed_id = (seed.get("id") or "").rsplit("/", 1)[-1]
    refs = [w for w in (seed.get("referenced_works") or [])][:40]
    related = [w for w in (seed.get("related_works") or [])][:20]

    async with httpx.AsyncClient() as client:
        citing: list[dict] = []
        try:
            data = await _get(
                client,
                OPENALEX_WORKS,
                {
                    "filter": f"cites:{seed_id}",
                    "per-page": "20",
                    "sort": "cited_by_count:desc",
                    "select": _OA_FIELDS,
                },
            )
            citing = data.get("results") or []
        except (httpx.HTTPError, ValueError):
            citing = []

        fetched = await _batch_works(client, refs + related)

    by_id: dict[str, dict] = {}
    for w in fetched + citing:
        wid = (w.get("id") or "").rsplit("/", 1)[-1]
        if wid and wid != seed_id:
            by_id[wid] = w

    # Keep the most-cited candidates so the graph stays readable.
    ranked = sorted(
        by_id.values(), key=lambda w: w.get("cited_by_count") or 0, reverse=True
    )[:limit]

    nodes = []
    ref_sets: dict[str, set] = {}
    seed_refs = set(seed.get("referenced_works") or [])
    ref_sets[seed_id] = seed_refs
    for w in ranked:
        wid = (w.get("id") or "").rsplit("/", 1)[-1]
        ref_sets[wid] = set(w.get("referenced_works") or [])

    def similarity(a: str, b: str) -> float:
        sa, sb = ref_sets.get(a, set()), ref_sets.get(b, set())
        if not sa or not sb:
            return 0.0
        inter = len(sa & sb)
        if not inter:
            return 0.0
        return inter / len(sa | sb)

    all_ids = [seed_id] + [(w.get("id") or "").rsplit("/", 1)[-1] for w in ranked]
    for w in [seed] + ranked:
        wid = (w.get("id") or "").rsplit("/", 1)[-1]
        p = _to_paper(w)
        nodes.append(
            {
                "id": wid,
                "title": p.title,
                "authors": p.authors[:3],
                "year": p.year,
                "venue": p.venue,
                "doi": p.doi,
                "url": p.url,
                "citations": w.get("cited_by_count") or 0,
                "is_seed": wid == seed_id,
                "retraction_status": p.retraction_status,
                "similarity": round(similarity(seed_id, wid), 3) if wid != seed_id else 1.0,
            }
        )

    edges = []
    for i, a in enumerate(all_ids):
        for b in all_ids[i + 1 :]:
            s = similarity(a, b)
            if s >= 0.06:  # below this the link is noise, not a relationship
                edges.append({"source": a, "target": b, "weight": round(s, 3)})

    return {"nodes": nodes, "edges": edges}
