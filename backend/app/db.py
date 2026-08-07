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
CREATE TABLE IF NOT EXISTS folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT
);

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
    pub_date     TEXT,           -- "YYYY[-MM[-DD]]" when the source resolves it
    oa_url       TEXT,           -- free full-text link, when one exists
    folder_id    INTEGER,        -- NULL = unfiled; a paper lives in one folder
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


# Columns added after the first release; existing databases get them via a
# tiny in-place migration (SQLite has no "ADD COLUMN IF NOT EXISTS").
_ADDED_COLUMNS = (
    ("pub_date", "TEXT", "''"),
    ("oa_url", "TEXT", "''"),
    ("folder_id", "INTEGER", "NULL"),  # NULL = unfiled
)


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(_SCHEMA)
        existing = {
            r["name"] for r in conn.execute("PRAGMA table_info(saved_papers)")
        }
        for name, col_type, default in _ADDED_COLUMNS:
            if name not in existing:
                conn.execute(
                    f"ALTER TABLE saved_papers ADD COLUMN {name} {col_type} "
                    f"DEFAULT {default}"
                )


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
        "pub_date": row["pub_date"] or "",
        "oa_url": row["oa_url"] or "",
        "folder_id": row["folder_id"],
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


def save_paper(
    card: dict, tags: list[str] | None = None, folder_id: int | None = None
) -> dict:
    """Idempotently save a paper (metadata only). Returns the stored record.

    Re-saving an already-saved paper is a no-op that merges any new tags in.
    """
    tags = [t.strip() for t in (tags or []) if t.strip()]
    key = _dedup_key(card)
    with _conn() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO saved_papers
               (source, source_id, title, title_zh, authors, year, venue, url,
                doi, citation_key, relevance_zh, pub_date, oa_url, folder_id,
                dedup_key, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                card.get("pub_date", ""),
                card.get("oa_url", ""),
                folder_id,
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


def list_saved(tag: str | None = None, folder: str | None = None) -> list[dict]:
    """List saved papers, optionally filtered by tag and/or folder.

    `folder` is a folder id as a string, or "unfiled" for papers in no folder.
    """
    clauses: list[str] = []
    params: list = []
    join = ""
    if tag:
        join = "JOIN paper_tags t ON t.paper_id = p.id"
        clauses.append("t.tag = ?")
        params.append(tag)
    if folder == "unfiled":
        clauses.append("p.folder_id IS NULL")
    elif folder:
        clauses.append("p.folder_id = ?")
        params.append(int(folder))

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with _conn() as conn:
        rows = conn.execute(
            f"""SELECT p.* FROM saved_papers p {join}
                {where}
                ORDER BY p.created_at DESC""",
            params,
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


# --- Folders --------------------------------------------------------------


def create_folder(name: str) -> dict | None:
    """Create a folder. Returns None if the name is empty or already taken."""
    name = name.strip()
    if not name:
        return None
    with _conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO folders (name, created_at) VALUES (?,?)", (name, _now())
            )
        except sqlite3.IntegrityError:
            return None  # duplicate name
        row = conn.execute(
            "SELECT * FROM folders WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return {"id": row["id"], "name": row["name"], "count": 0}


def list_folders() -> list[dict]:
    """All folders with how many papers each holds."""
    with _conn() as conn:
        rows = conn.execute(
            """SELECT f.id, f.name, COUNT(p.id) AS n
               FROM folders f
               LEFT JOIN saved_papers p ON p.folder_id = f.id
               GROUP BY f.id, f.name
               ORDER BY f.name"""
        ).fetchall()
        unfiled = conn.execute(
            "SELECT COUNT(*) AS n FROM saved_papers WHERE folder_id IS NULL"
        ).fetchone()["n"]
    folders = [{"id": r["id"], "name": r["name"], "count": r["n"]} for r in rows]
    return folders + [{"id": None, "name": "", "count": unfiled}]


def rename_folder(folder_id: int, name: str) -> bool:
    name = name.strip()
    if not name:
        return False
    with _conn() as conn:
        try:
            cur = conn.execute(
                "UPDATE folders SET name = ? WHERE id = ?", (name, folder_id)
            )
        except sqlite3.IntegrityError:
            return False  # another folder already uses that name
        return cur.rowcount > 0


def delete_folder(folder_id: int) -> bool:
    """Delete a folder. Its papers are kept and become unfiled."""
    with _conn() as conn:
        conn.execute(
            "UPDATE saved_papers SET folder_id = NULL WHERE folder_id = ?",
            (folder_id,),
        )
        cur = conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        return cur.rowcount > 0


def set_paper_folder(paper_id: int, folder_id: int | None) -> bool:
    """Move a paper into a folder, or out of all folders when folder_id is None."""
    with _conn() as conn:
        if folder_id is not None:
            exists = conn.execute(
                "SELECT 1 FROM folders WHERE id = ?", (folder_id,)
            ).fetchone()
            if not exists:
                return False
        cur = conn.execute(
            "UPDATE saved_papers SET folder_id = ? WHERE id = ?",
            (folder_id, paper_id),
        )
        return cur.rowcount > 0


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
