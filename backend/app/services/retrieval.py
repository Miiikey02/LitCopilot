"""Orchestrates multi-source retrieval and deduplication."""
from __future__ import annotations

import asyncio
import re

from .biorxiv import search_biorxiv
from .models import Paper
from .openalex import search_openalex
from .pubmed import fetch_by_doi, search_pubmed
from .semantic_scholar import search_semantic_scholar


def _merge(existing: Paper, other: Paper) -> Paper:
    """Prefer the record with more complete metadata; keep any abstract we have."""
    if not existing.abstract and other.abstract:
        existing.abstract = other.abstract
    # Prefer a real journal DOI over a data-repository mirror (figshare etc.),
    # so citations export the citable article rather than its dataset record.
    if other.doi and (
        not existing.doi
        or (existing.is_dataset_doi() and not other.is_dataset_doi())
    ):
        existing.doi = other.doi
        if other.url:
            existing.url = other.url
    if not existing.venue and other.venue:
        existing.venue = other.venue
    if existing.year is None and other.year is not None:
        existing.year = other.year
    # Prefer the more precise date (e.g. "2024-03-11" over "2024").
    if len(other.pub_date) > len(existing.pub_date):
        existing.pub_date = other.pub_date
    if not existing.oa_url and other.oa_url:
        existing.oa_url = other.oa_url
    # If any source knows the work is retracted, that finding wins — a missing
    # flag elsewhere only means that source lacks the metadata.
    if other.retraction_status and existing.retraction_status != "retracted":
        existing.retraction_status = other.retraction_status
    return existing


_DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:a-z0-9]+", re.I)
_QUESTION_STARTS = (
    "what", "how", "which", "why", "when", "who", "is ", "are ", "does ", "do ",
    "can ", "should ", "recent", "latest", "current",
)


def looks_like_known_item(query: str) -> bool:
    """True when the query looks like a specific paper the user already knows.

    Researchers routinely paste a full title (or a DOI) to pull up one paper.
    Expanding that into topical keywords searches for the *subject* instead of
    the *paper*, so those queries also need a verbatim search.
    """
    q = query.strip()
    if _DOI_RE.search(q):
        return True
    if q.isdigit() and 6 <= len(q) <= 9:  # looks like a PMID
        return True
    lowered = q.lower()
    if q.endswith("?") or lowered.startswith(_QUESTION_STARTS):
        return False
    # A long, statement-shaped English phrase reads like a title.
    return len(q.split()) >= 6 and q.isascii()


def _norm_title(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum())


def _pin_exact_matches(papers: list[Paper], query: str) -> list[Paper]:
    """Move papers whose title matches the query to the front."""
    target = _norm_title(query)
    if not target:
        return papers
    exact, rest = [], []
    for p in papers:
        t = _norm_title(p.title)
        # Either direction of containment catches subtitle/punctuation drift.
        hit = t and (t == target or t in target or target in t)
        (exact if hit else rest).append(p)
    return exact + rest


def _interleave(lists: list[list[Paper]]) -> list[Paper]:
    """Round-robin merge so every source contributes within any prefix/cap.

    Order is pubmed[0], s2[0], openalex[0], pubmed[1], ... — each source's top
    hits surface early, and because PubMed is emitted first within each round it
    still wins on the subsequent dedup/merge (keeping its curated abstracts).
    """
    out: list[Paper] = []
    if not lists:
        return out
    for i in range(max(len(lst) for lst in lists)):
        for lst in lists:
            if i < len(lst):
                out.append(lst[i])
    return out


def dedupe(papers: list[Paper]) -> list[Paper]:
    """Collapse duplicates across sources by DOI *or* normalized title.

    Matching on title as well as DOI catches the same work registered under
    several DOIs (a journal DOI plus figshare/zenodo mirrors). To avoid merging
    genuinely different papers that share a generic title (two reviews both
    called "Glaucoma"), a title match only counts when the known years agree.
    """
    kept: list[Paper] = []
    by_doi: dict[str, Paper] = {}
    by_title: dict[str, Paper] = {}

    for p in papers:
        doi = p.doi.lower()
        tkey = p.title_key()

        match = by_doi.get(doi) if doi else None
        if match is None and tkey:
            candidate = by_title.get(tkey)
            # Same title counts as the same paper unless the years disagree.
            if candidate is not None and (
                candidate.year is None or p.year is None or candidate.year == p.year
            ):
                match = candidate

        if match is not None:
            _merge(match, p)
            # Index this DOI too, so later mirrors collapse onto the same record.
            if doi:
                by_doi.setdefault(doi, match)
            continue

        kept.append(p)
        if doi:
            by_doi[doi] = p
        if tkey:
            by_title.setdefault(tkey, p)
    return kept


async def retrieve(
    english_query: str,
    limit: int,
    include_preprints: bool = True,
    sort: str = "relevance",
    exact_query: str | None = None,
) -> list[Paper]:
    """Fetch from PubMed + Semantic Scholar + OpenAlex (+ bioRxiv), then dedupe.

    PubMed is the primary source (curated, has structured surnames); its records
    are placed first so they win on merge. Semantic Scholar and OpenAlex broaden
    coverage; bioRxiv adds cutting-edge preprints (included only when
    `include_preprints`). All sources fail soft, so any one outage never breaks
    the pipeline.

    `sort` is "relevance" (default) or "date". Date sorting is pushed down into
    each source's own query so we retrieve genuinely recent literature, and the
    merged list is then re-sorted newest-first — otherwise the caller's [:limit]
    cap would slice a round-robin of four differently-dated lists.

    `exact_query` is the user's untouched text, passed when it looks like a
    specific paper (a pasted title or DOI). We then additionally search that
    verbatim and pin title matches to the front — expansion alone would look for
    the topic and miss the very paper being asked for.
    """

    def _source_tasks(q: str) -> list:
        tasks = [
            search_pubmed(q, retmax=limit, sort=sort),
            search_semantic_scholar(q, limit=limit, sort=sort),
            search_openalex(q, limit=limit, sort=sort),
        ]
        if include_preprints:
            tasks.append(search_biorxiv(q, limit=limit, sort=sort))
        return tasks

    queries = [english_query]
    if exact_query and exact_query.strip() != english_query.strip():
        queries.append(exact_query.strip())

    per_query = [_source_tasks(q) for q in queries]
    results = await asyncio.gather(
        *[t for tasks in per_query for t in tasks], return_exceptions=True
    )

    # Keep source order pubmed → s2 → openalex → biorxiv (PubMed wins merges),
    # but interleave so the downstream [:limit] cap includes a mix from each
    # source rather than filling up entirely from PubMed. The verbatim pass is
    # interleaved first so a known-item hit survives the cap.
    n = len(per_query[0])
    lists = [r for r in results if isinstance(r, list)]
    if len(queries) > 1:
        expanded, verbatim = lists[:n], lists[n:]
        lists = verbatim + expanded

    papers = dedupe(_interleave(lists))
    if sort == "date":
        # Undated records sort last rather than first.
        papers.sort(key=lambda p: (p.sort_date() != "", p.sort_date()), reverse=True)
    if exact_query:
        papers = _pin_exact_matches(papers, exact_query)
        await _backfill_abstracts(papers[:3])
    return papers


async def _backfill_abstracts(papers: list[Paper]) -> None:
    """Fill in missing abstracts by DOI for the top known-item hits.

    A paper found only via a metadata-only source arrives without an abstract,
    and the synthesis step then has nothing to summarise — precisely the case
    where the user asked for that paper by name. PubMed usually carries it.
    """
    targets = [p for p in papers if not p.abstract and p.doi]
    if not targets:
        return
    fetched = await asyncio.gather(
        *[fetch_by_doi(p.doi) for p in targets], return_exceptions=True
    )
    for paper, found in zip(targets, fetched):
        if isinstance(found, Paper) and found.abstract:
            paper.abstract = found.abstract
            if not paper.venue:
                paper.venue = found.venue
