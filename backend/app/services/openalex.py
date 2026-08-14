"""OpenAlex retrieval via the free public API (no key required).

OpenAlex (~250M+ scholarly works across all fields, incl. preprints and
non-medical venues) broadens coverage well beyond PubMed — a legitimate,
ToS-clean stand-in for Google Scholar's breadth. We send one search per user
query and fail soft so an OpenAlex outage never breaks the pipeline.

Politeness: OpenAlex serves a faster, more reliable "polite pool" to callers who
identify themselves with a `mailto`. We pass one when an email is configured.
"""
from __future__ import annotations

import asyncio
import re

import httpx

from ..config import MAX_RESULTS, OPENALEX_MAILTO
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


def _oa_pdf_direct(item: dict) -> str:
    """A link to the PDF file itself, not to a page that offers one.

    `_oa_pdf` happily falls back to a landing page, which is right for "where
    can I read this" but useless for showing the file. Every open location is
    checked because the best one often records only a landing page while a
    mirror carries the actual PDF.
    """
    seen: list[dict] = []
    for key in ("best_oa_location", "primary_location"):
        loc = item.get(key)
        if loc:
            seen.append(loc)
    seen.extend(item.get("locations") or [])
    for loc in seen:
        url = (loc or {}).get("pdf_url") or ""
        if url and (loc.get("is_oa") or loc is seen[0]):
            return url
    return ""


async def search_openalex(
    query: str, limit: int = MAX_RESULTS, sort: str = "relevance"
) -> list[Paper]:
    params = {
        "search": query,
        "per-page": str(min(limit, 200)),
    }
    if sort == "date":
        params["sort"] = "publication_date:desc"
    if OPENALEX_MAILTO:
        params["mailto"] = OPENALEX_MAILTO
    try:
        async with httpx.AsyncClient() as client:
            results = (await _get(client, OPENALEX_WORKS, params)).get("results", [])
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
                pdf_url=_oa_pdf_direct(item),
                retraction_status="retracted" if item.get("is_retracted") else "",
            )
        )
    return papers


# --- Single-work lookup and the connected-papers graph ---------------------

_OA_FIELDS = (
    "id,doi,display_name,publication_year,publication_date,authorships,"
    "primary_location,open_access,best_oa_location,locations,cited_by_count,"
    "referenced_works,related_works,is_retracted,abstract_inverted_index"
)


def _params(extra: dict) -> dict:
    p = dict(extra)
    if OPENALEX_MAILTO:
        p["mailto"] = OPENALEX_MAILTO
    return p


async def _get(client: httpx.AsyncClient, url: str, params: dict, tries: int = 3) -> dict:
    """One OpenAlex request, retried when the index asks us to slow down.

    A 429 here is not a failed lookup — it is the same lookup, later. Treating
    it as "no such paper" is how a title search came to report that a paper
    plainly in the index did not exist.
    """
    delay = 0.6
    last = ""
    for attempt in range(tries):
        try:
            r = await client.get(url, params=_params(params), timeout=25)
        except httpx.HTTPError as exc:
            last = type(exc).__name__
            if attempt < tries - 1:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            raise
        if r.status_code in (429, 500, 502, 503, 504) and attempt < tries - 1:
            last = f"HTTP {r.status_code}"
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if r.status_code >= 400:
            # Carry the code and the first of the body: "did not answer" is
            # true of a 429, a 403 and a network drop alike, and they call for
            # completely different responses.
            raise httpx.HTTPError(f"HTTP {r.status_code}: {r.text[:120]}")
        return r.json()
    raise httpx.HTTPError(last or "OpenAlex did not answer")


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
        pdf_url=_oa_pdf_direct(item),
        retraction_status="retracted" if item.get("is_retracted") else "",
    )


# Why the most recent title lookup came back empty. Reset per call by
# `resolve_title_notes`, which the resolve endpoint drains into its response.
_NOTES: list[str] = []


def take_notes() -> list[str]:
    notes = list(_NOTES)
    _NOTES.clear()
    return notes


def _norm_title(text: str) -> str:
    """A title reduced to comparable words: case, punctuation and spacing gone."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).split())


async def _resolve_title(client: httpx.AsyncClient, ident: str) -> dict | None:
    """Find the work whose title this is — not merely the best topical match.

    Asking for the single top relevance hit gave the wrong paper: searching a
    2026 paper's exact title returned a 2020 review of the same subject,
    because relevance ranking rewards a heavily cited review over the paper you
    actually named. So several candidates are fetched and their titles compared,
    and only if none matches does the best relevance hit stand.
    """
    want = _norm_title(ident)
    # Commas and colons separate clauses in OpenAlex's filter syntax, so a title
    # containing them cannot be passed through raw.
    safe = re.sub(r"[,:|]+", " ", ident).strip()
    # No `select` here, unlike the by-id lookups. Trimming fields is only a
    # bandwidth saving, and the plain list query is the shape already proven to
    # work against this API from the deployed host — a title lookup returning
    # nothing at all is a far worse trade than a slightly larger response.
    attempts = (
        {"filter": f"title.search:{safe}", "per-page": "10"},
        {"search": ident, "per-page": "10"},
    )
    fallback = None
    for params in attempts:
        try:
            data = await _get(client, OPENALEX_WORKS, params)
        except (httpx.HTTPError, ValueError) as exc:
            # Kept, not swallowed: a lookup that finds nothing because the index
            # refused the request is a different problem from one that finds
            # nothing because the paper is not there, and the reader can only
            # act on the second.
            _NOTES.append(f"{type(exc).__name__}: {str(exc)[:120]}")
            continue
        results = data.get("results") or []
        if fallback is None and results:
            fallback = results[0]
        for item in results:
            if _norm_title(item.get("display_name")) == want:
                return item
        # A near match covers a subtitle the user left off, or a trailing period.
        for item in results:
            got = _norm_title(item.get("display_name"))
            if got and len(want) > 30 and (got.startswith(want) or want.startswith(got)):
                return item
        _NOTES.append(f"{len(results)} candidates, no title match")
    return fallback


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
            return await _resolve_title(client, ident)
    except (httpx.HTTPError, ValueError):
        return None


async def _batch_works(
    client: httpx.AsyncClient, ids: list[str]
) -> tuple[list[dict], int]:
    """Fetch many works by id. Returns (works, how many chunks failed).

    The failure count matters: a chunk lost to rate limiting used to vanish
    into a `continue`, and a graph built from nothing looked exactly like a
    paper with no neighbours.
    """
    out: list[dict] = []
    failed = 0
    _batch_works.last_error = ""
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
        except (httpx.HTTPError, ValueError) as exc:
            failed += 1
            _batch_works.last_error = str(exc)[:120]
            continue
    return out, failed


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
        citing_failed = False
        why = ""
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
        except (httpx.HTTPError, ValueError) as exc:
            citing = []
            citing_failed = True
            why = str(exc)[:120]

        fetched, batches_failed = await _batch_works(client, refs + related)

    # Wanted neighbours and got none of them: that is the index refusing us,
    # not a paper standing alone in the literature. Saying so lets the reader
    # retry instead of believing a graph that was never built.
    starved = (
        bool(refs or related) and not fetched and not citing
        and (batches_failed or citing_failed)
    )

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

    # Bibliographic-coupling Jaccard is small in absolute terms — two papers
    # citing 40 works each rarely overlap by much — so a fixed threshold leaves
    # the map almost edgeless. Keep each paper's few strongest links instead,
    # which is what makes the clusters legible.
    scored: list[tuple[float, str, str]] = []
    for i, a in enumerate(all_ids):
        for b in all_ids[i + 1 :]:
            sim = similarity(a, b)
            if sim > 0:
                scored.append((sim, a, b))

    keep: dict[tuple[str, str], float] = {}
    per_node: dict[str, int] = {}
    TOP_PER_NODE = 3
    for sim, a, b in sorted(scored, key=lambda x: -x[0]):
        if per_node.get(a, 0) >= TOP_PER_NODE and per_node.get(b, 0) >= TOP_PER_NODE:
            continue
        keep[(a, b)] = sim
        per_node[a] = per_node.get(a, 0) + 1
        per_node[b] = per_node.get(b, 0) + 1

    # Normalise weights to 0-1 across this graph so edge thickness is readable
    # even when every absolute similarity is small.
    top = max(keep.values(), default=1.0) or 1.0
    edges = [
        {"source": a, "target": b, "weight": round(min(sim / top, 1.0), 3)}
        for (a, b), sim in keep.items()
    ]

    out = {"nodes": nodes, "edges": edges}
    if starved:
        out["warning"] = "neighbours unavailable"
        # Not shown to the reader; it is how the cause gets out of a deployed
        # instance whose logs are not to hand. A 429 asks for patience, a 403
        # asks for a different call entirely.
        out["detail"] = (
            getattr(_batch_works, "last_error", "") or why or "unknown"
        )[:160]
    return out
