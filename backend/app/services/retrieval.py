"""Orchestrates multi-source retrieval and deduplication."""
from __future__ import annotations

import asyncio

from .biorxiv import search_biorxiv
from .models import Paper
from .openalex import search_openalex
from .pubmed import search_pubmed
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
    return existing


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
    """
    tasks = [
        search_pubmed(english_query, retmax=limit, sort=sort),
        search_semantic_scholar(english_query, limit=limit, sort=sort),
        search_openalex(english_query, limit=limit, sort=sort),
    ]
    if include_preprints:
        tasks.append(search_biorxiv(english_query, limit=limit, sort=sort))

    results = await asyncio.gather(*tasks, return_exceptions=True)
    # Keep source order pubmed → s2 → openalex → biorxiv (PubMed wins merges),
    # but interleave so the downstream [:limit] cap includes a mix from each
    # source rather than filling up entirely from PubMed.
    lists = [r for r in results if isinstance(r, list)]
    papers = dedupe(_interleave(lists))
    if sort == "date":
        # Undated records sort last rather than first.
        papers.sort(key=lambda p: (p.sort_date() != "", p.sort_date()), reverse=True)
    return papers
