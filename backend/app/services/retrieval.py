"""Orchestrates multi-source retrieval and deduplication."""
from __future__ import annotations

import asyncio

from .models import Paper
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
    """Fetch from PubMed + Semantic Scholar concurrently, then dedupe.

    PubMed is the primary source (curated, has structured surnames); its records
    are placed first so they win on merge.
    """
    pubmed_res, s2_res = await asyncio.gather(
        search_pubmed(english_query, retmax=limit),
        search_semantic_scholar(english_query, limit=limit),
        return_exceptions=True,
    )
    papers: list[Paper] = []
    if isinstance(pubmed_res, list):
        papers.extend(pubmed_res)
    if isinstance(s2_res, list):
        papers.extend(s2_res)
    return dedupe(papers)
