"""Orchestrates multi-source retrieval and deduplication."""
from __future__ import annotations

import asyncio

from .models import Paper
from .openalex import search_openalex
from .pubmed import search_pubmed
from .semantic_scholar import search_semantic_scholar


def _merge(existing: Paper, other: Paper) -> Paper:
    """Prefer the record with more complete metadata; keep any abstract we have."""
    if not existing.abstract and other.abstract:
        existing.abstract = other.abstract
    if not existing.doi and other.doi:
        existing.doi = other.doi
    if not existing.venue and other.venue:
        existing.venue = other.venue
    if existing.year is None and other.year is not None:
        existing.year = other.year
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
    """Collapse duplicates across sources by DOI, then normalized title."""
    seen: dict[str, Paper] = {}
    order: list[str] = []
    for p in papers:
        key = p.dedup_key()
        if key in seen:
            _merge(seen[key], p)
        else:
            seen[key] = p
            order.append(key)
    return [seen[k] for k in order]


async def retrieve(english_query: str, limit: int) -> list[Paper]:
    """Fetch from PubMed + Semantic Scholar + OpenAlex concurrently, then dedupe.

    PubMed is the primary source (curated, has structured surnames); its records
    are placed first so they win on merge. Semantic Scholar and OpenAlex broaden
    coverage; all three fail soft, so any one outage never breaks the pipeline.
    """
    pubmed_res, s2_res, openalex_res = await asyncio.gather(
        search_pubmed(english_query, retmax=limit),
        search_semantic_scholar(english_query, limit=limit),
        search_openalex(english_query, limit=limit),
        return_exceptions=True,
    )
    # Keep source order pubmed → s2 → openalex (PubMed wins merges), but
    # interleave so the downstream [:limit] cap includes a mix from each source
    # rather than filling up entirely from PubMed.
    lists = [r for r in (pubmed_res, s2_res, openalex_res) if isinstance(r, list)]
    return dedupe(_interleave(lists))
