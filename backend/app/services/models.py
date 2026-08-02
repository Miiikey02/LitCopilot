"""Shared data structures for retrieved papers.

IMPORTANT guardrail: `abstract` holds full source text and is used ONLY in
memory to feed the LLM's synthesis. It must never be persisted to the database
or returned to the frontend. The `to_card()` method produces the display-safe
projection (metadata only, no verbatim abstract).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Paper:
    source: str  # "pubmed" | "semantic_scholar" | "openalex" | "biorxiv"
    source_id: str  # PMID, S2 paper id, OpenAlex work id, or bioRxiv DOI
    title: str
    authors: list[str] = field(default_factory=list)
    year: Optional[int] = None
    venue: str = ""  # journal / conference
    url: str = ""
    doi: str = ""
    abstract: str = ""  # in-memory only; never stored or displayed verbatim
    first_author_family: str = ""  # surname, normalized per-source by the parser

    # Populated later by the synthesis/translation step:
    title_zh: str = ""  # Chinese translation of the title
    relevance_zh: str = ""  # one-line "why relevant" in Chinese (our paraphrase)

    def citation_key(self) -> str:
        """[Author, Year] style short key used for inline citations."""
        if self.first_author_family:
            first_author = self.first_author_family
        elif self.authors:
            first_author = self.authors[0].split()[0]
        else:
            first_author = "Anon"
        yr = self.year if self.year else "n.d."
        return f"{first_author}, {yr}"

    def dedup_key(self) -> str:
        if self.doi:
            return f"doi:{self.doi.lower()}"
        return f"title:{''.join(self.title.lower().split())[:80]}"

    def to_card(self) -> dict:
        """Display-safe projection. Deliberately omits the raw abstract."""
        return {
            "source": self.source,
            "source_id": self.source_id,
            "title": self.title,
            "title_zh": self.title_zh,
            "authors": self.authors,
            "year": self.year,
            "venue": self.venue,
            "url": self.url,
            "doi": self.doi,
            "citation_key": self.citation_key(),
            "relevance_zh": self.relevance_zh,
        }
