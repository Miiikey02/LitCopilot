"""SQLite persistence for saved papers, tags, and search history.

Single-user MVP: one connection per operation is plenty. We store ONLY paper
metadata and our own Chinese paraphrase (relevance_zh) — never abstract text —
so the same guardrail that applies to the API applies to storage.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime

from .config import DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS saved_papers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT,
    source_id    TEXT,
    title        TEXT,
    title_zh     TEXT,
    authors      TEXT,          -- JSON array
    year         INTEGER,
    venue        TEXT,
    url          TEXT,
    doi          TEXT,
    citation_key TEXT,
    relevance_zh TEXT,
    dedup_key    TEXT UNIQUE,    -- prevents saving the same paper twice
    created_at   TEXT
);

CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id INTEGER NOT NULL,
    tag      TEXT NOT NULL,
    UNIQUE (paper_id, tag),
    FOREIGN KEY (paper_id) REFERENCES saved_papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS search_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    query         TEXT,
    detected_lang TEXT,
    english_query TEXT,
    result_count  INTEGER,
    created_at    TEXT
);
"""


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(_SCHEMA)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _row_to_paper(row: sqlite3.Row, tags: list[str]) -> dict:
    return {
        "id": row["id"],
        "source": row["source"],
        "source_id": row["source_id"],
        "title": row["title"],
        "title_zh": row["title_zh"],
        "authors": json.loads(row["authors"] or "[]"),
        "year": row["year"],
        "venue": row["venue"],
        "url": row["url"],
        "doi": row["doi"],
        "citation_key": row["citation_key"],
        "relevance_zh": row["relevance_zh"],
        "tags": tags,
        "created_at": row["created_at"],
    }


def _dedup_key(card: dict) -> str:
    doi = (card.get("doi") or "").strip().lower()
    if doi:
        return f"doi:{doi}"
    src = card.get("source", "")
    sid = card.get("source_id", "")
    if sid:
        return f"{src}:{sid}"
    title = "".join((card.get("title") or "").lower().split())[:80]
    return f"title:{title}"


# --- Saved papers ---------------------------------------------------------


def save_paper(card: dict, tags: list[str] | None = None) -> dict:
    """Idempotently save a paper (metadata only). Returns the stored record.

    Re-saving an already-saved paper is a no-op that merges any new tags in.
    """
    tags = [t.strip() for t in (tags or []) if t.strip()]
    key = _dedup_key(card)
    with _conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO saved_papers
               (source, source_id, title, title_zh, authors, year, venue, url,
                doi, citation_key, relevance_zh, dedup_key, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                card.get("source", ""),
                card.get("source_id", ""),
                card.get("title", ""),
                card.get("title_zh", ""),
                json.dumps(card.get("authors", []), ensure_ascii=False),
                card.get("year"),
                card.get("venue", ""),
                card.get("url", ""),
                card.get("doi", ""),
                card.get("citation_key", ""),
                card.get("relevance_zh", ""),
                key,
                _now(),
            ),
        )
        row = conn.execute(
            "SELECT * FROM saved_papers WHERE dedup_key = ?", (key,)
        ).fetchone()
        paper_id = row["id"]
        for tag in tags:
            conn.execute(
                "INSERT OR IGNORE INTO paper_tags (paper_id, tag) VALUES (?,?)",
                (paper_id, tag),
            )
        tag_rows = conn.execute(
            "SELECT tag FROM paper_tags WHERE paper_id = ? ORDER BY tag", (paper_id,)
        ).fetchall()
    return _row_to_paper(row, [r["tag"] for r in tag_rows])


def list_saved(tag: str | None = None) -> list[dict]:
    with _conn() as conn:
        if tag:
            rows = conn.execute(
                """SELECT p.* FROM saved_papers p
                   JOIN paper_tags t ON t.paper_id = p.id
                   WHERE t.tag = ?
                   ORDER BY p.created_at DESC""",
                (tag,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM saved_papers ORDER BY created_at DESC"
            ).fetchall()
        result = []
        for row in rows:
            tag_rows = conn.execute(
                "SELECT tag FROM paper_tags WHERE paper_id = ? ORDER BY tag",
                (row["id"],),
            ).fetchall()
            result.append(_row_to_paper(row, [r["tag"] for r in tag_rows]))
    return result


def delete_saved(paper_id: int) -> bool:
    with _conn() as conn:
        cur = conn.execute("DELETE FROM saved_papers WHERE id = ?", (paper_id,))
        return cur.rowcount > 0


def add_tag(paper_id: int, tag: str) -> bool:
    tag = tag.strip()
    if not tag:
        return False
    with _conn() as conn:
        exists = conn.execute(
            "SELECT 1 FROM saved_papers WHERE id = ?", (paper_id,)
        ).fetchone()
        if not exists:
            return False
        conn.execute(
            "INSERT OR IGNORE INTO paper_tags (paper_id, tag) VALUES (?,?)",
            (paper_id, tag),
        )
    return True


def remove_tag(paper_id: int, tag: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(
            "DELETE FROM paper_tags WHERE paper_id = ? AND tag = ?", (paper_id, tag)
        )
        return cur.rowcount > 0


def list_tags() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            """SELECT tag, COUNT(*) AS n FROM paper_tags
               GROUP BY tag ORDER BY tag"""
        ).fetchall()
    return [{"tag": r["tag"], "count": r["n"]} for r in rows]


# --- Search history -------------------------------------------------------


def add_history(query: str, detected_lang: str, english_query: str, result_count: int) -> None:
    with _conn() as conn:
        conn.execute(
            """INSERT INTO search_history
               (query, detected_lang, english_query, result_count, created_at)
               VALUES (?,?,?,?,?)""",
            (query, detected_lang, english_query, result_count, _now()),
        )


def list_history(limit: int = 30) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM search_history ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "query": r["query"],
            "detected_lang": r["detected_lang"],
            "english_query": r["english_query"],
            "result_count": r["result_count"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def clear_history() -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM search_history")
