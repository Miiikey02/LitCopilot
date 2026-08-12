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
    # Publication date as far as the source resolves it: "YYYY", "YYYY-MM" or
    # "YYYY-MM-DD". Empty when unknown. Used for date sorting (`year` alone ties
    # dozens of papers together within a year).
    pub_date: str = ""
    # Direct link to a legally free full text (PMC, OpenAlex/S2 open access,
    # bioRxiv PDF). Empty when the paper is paywalled.
    oa_url: str = ""
    # A link to the PDF file itself, where a source gives one. Distinct from
    # `oa_url`, which may point at a landing page — fine for "go read this",
    # useless for displaying the file.
    pdf_url: str = ""
    # Research-integrity status: "" (nothing known), "retracted", or "concern"
    # (an editorial expression of concern). Citing retracted work is a real
    # hazard in a thesis or grant, so this is surfaced prominently.
    retraction_status: str = ""
    # Open-access full text, fetched on demand for deep research. In memory
    # only, exactly like `abstract` — never stored or returned to the client.
    full_text: str = ""
    # Study design label assigned during deep research: "rct" | "cohort" |
    # "case" | "preclinical" | "invitro" | "review" | "guideline" | "other".
    evidence_type: str = ""

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

    def sort_date(self) -> str:
        """Zero-padded key for newest-first sorting; "" sorts last."""
        if self.pub_date:
            parts = self.pub_date.split("-")
            y = parts[0].zfill(4)
            m = (parts[1] if len(parts) > 1 else "00").zfill(2)
            d = (parts[2] if len(parts) > 2 else "00").zfill(2)
            return f"{y}-{m}-{d}"
        if self.year:
            return f"{self.year:04d}-00-00"
        return ""

    def dedup_key(self) -> str:
        if self.doi:
            return f"doi:{self.doi.lower()}"
        return self.title_key()

    def title_key(self) -> str:
        """Normalized-title key, used to catch the same paper under two DOIs.

        Sources sometimes register several DOIs for one work (e.g. a journal DOI
        plus figshare data-collection mirrors), which DOI-only dedup misses.
        Returns "" for titles too short to match safely on their own.
        """
        norm = "".join(ch for ch in self.title.lower() if ch.isalnum())[:80]
        return f"title:{norm}" if len(norm) >= 20 else ""

    def is_dataset_doi(self) -> bool:
        """True for data-repository DOIs (figshare/zenodo/dryad mirrors)."""
        d = self.doi.lower()
        return any(m in d for m in ("figshare", "zenodo", "dryad", "10.6084/"))

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
            "pub_date": self.pub_date,
            "oa_url": self.oa_url,
            "retraction_status": self.retraction_status,
            "evidence_type": self.evidence_type,
            "has_full_text": bool(self.full_text),
        }
