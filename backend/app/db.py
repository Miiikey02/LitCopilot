"""Postgres persistence for saved papers, folders, tags, and search history.

Backed by Supabase Postgres so data survives redeploys (the previous SQLite file
lived on ephemeral disk). Every row is owned by a user id taken from the
verified Supabase JWT, and every query is scoped by it — that scoping is what
keeps one researcher's library private from another's.

We store ONLY paper metadata and our own short paraphrase (relevance_zh) —
never abstract text — so the same guardrail that applies to the API applies to
storage.
"""
from __future__ import annotations

import json
from typing import Optional

from psycopg import connect
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import DATABASE_URL

_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id         BIGSERIAL PRIMARY KEY,
    user_id    UUID NOT NULL,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS saved_papers (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID NOT NULL,
    source       TEXT,
    source_id    TEXT,
    title        TEXT,
    title_zh     TEXT,
    authors      JSONB NOT NULL DEFAULT '[]'::jsonb,
    year         INTEGER,
    venue        TEXT,
    url          TEXT,
    doi          TEXT,
    citation_key TEXT,
    relevance_zh TEXT,
    pub_date     TEXT,
    oa_url       TEXT,
    notes        TEXT NOT NULL DEFAULT '',
    folder_id    BIGINT REFERENCES folders(id) ON DELETE SET NULL,
    dedup_key    TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Uniqueness is per user: two researchers may each save the same paper.
    UNIQUE (user_id, dedup_key)
);

CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id BIGINT NOT NULL REFERENCES saved_papers(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    UNIQUE (paper_id, tag)
);

CREATE TABLE IF NOT EXISTS search_history (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL,
    query         TEXT,
    detected_lang TEXT,
    english_query TEXT,
    result_count  INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_papers_user_idx ON saved_papers (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS search_history_user_idx ON search_history (user_id, created_at DESC);
"""

_pool: Optional[ConnectionPool] = None


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not configured")
        _pool = ConnectionPool(
            DATABASE_URL, min_size=1, max_size=5, kwargs={"row_factory": dict_row}
        )
    return _pool


def init_db() -> None:
    with _get_pool().connection() as conn:
        conn.execute(_SCHEMA)
        # Columns added after a table already existed in a deployed database.
        conn.execute(
            "ALTER TABLE saved_papers ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''"
        )


def _row_to_paper(row: dict, tags: list[str]) -> dict:
    authors = row["authors"]
    if isinstance(authors, str):  # tolerate text-typed legacy rows
        authors = json.loads(authors or "[]")
    return {
        "id": row["id"],
        "source": row["source"] or "",
        "source_id": row["source_id"] or "",
        "title": row["title"] or "",
        "title_zh": row["title_zh"] or "",
        "authors": authors or [],
        "year": row["year"],
        "venue": row["venue"] or "",
        "url": row["url"] or "",
        "doi": row["doi"] or "",
        "citation_key": row["citation_key"] or "",
        "relevance_zh": row["relevance_zh"] or "",
        "pub_date": row["pub_date"] or "",
        "oa_url": row["oa_url"] or "",
        "notes": row["notes"] or "",
        "folder_id": row["folder_id"],
        "tags": tags,
        "created_at": row["created_at"].isoformat(),
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


def _tags_for(conn, paper_id: int) -> list[str]:
    rows = conn.execute(
        "SELECT tag FROM paper_tags WHERE paper_id = %s ORDER BY tag", (paper_id,)
    ).fetchall()
    return [r["tag"] for r in rows]


# --- Saved papers ---------------------------------------------------------


def save_paper(
    user_id: str,
    card: dict,
    tags: list[str] | None = None,
    folder_id: int | None = None,
) -> dict:
    """Idempotently save a paper for one user. Returns the stored record.

    Re-saving an already-saved paper is a no-op that merges any new tags in.
    """
    tags = [t.strip() for t in (tags or []) if t.strip()]
    key = _dedup_key(card)
    with _get_pool().connection() as conn:
        if folder_id is not None:
            owns = conn.execute(
                "SELECT 1 FROM folders WHERE id = %s AND user_id = %s",
                (folder_id, user_id),
            ).fetchone()
            if not owns:
                folder_id = None  # ignore a folder that isn't this user's
        conn.execute(
            """INSERT INTO saved_papers
               (user_id, source, source_id, title, title_zh, authors, year, venue,
                url, doi, citation_key, relevance_zh, pub_date, oa_url, folder_id,
                dedup_key)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (user_id, dedup_key) DO NOTHING""",
            (
                user_id,
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
            ),
        )
        row = conn.execute(
            "SELECT * FROM saved_papers WHERE user_id = %s AND dedup_key = %s",
            (user_id, key),
        ).fetchone()
        for tag in tags:
            conn.execute(
                """INSERT INTO paper_tags (paper_id, tag) VALUES (%s,%s)
                   ON CONFLICT DO NOTHING""",
                (row["id"], tag),
            )
        return _row_to_paper(row, _tags_for(conn, row["id"]))


def list_saved(
    user_id: str,
    tag: str | None = None,
    folder: str | None = None,
    q: str | None = None,
) -> list[dict]:
    """List a user's saved papers, optionally filtered by tag, folder and text.

    `folder` is a folder id as a string, or "unfiled" for papers in no folder.
    `q` matches case-insensitively across title, Chinese title, authors, venue
    and the user's own notes.
    """
    clauses = ["p.user_id = %s"]
    params: list = [user_id]
    join = ""
    if tag:
        join = "JOIN paper_tags t ON t.paper_id = p.id"
        clauses.append("t.tag = %s")
        params.append(tag)
    if folder == "unfiled":
        clauses.append("p.folder_id IS NULL")
    elif folder:
        clauses.append("p.folder_id = %s")
        params.append(int(folder))
    if q and q.strip():
        clauses.append(
            "(p.title ILIKE %s OR p.title_zh ILIKE %s OR p.venue ILIKE %s"
            " OR p.notes ILIKE %s OR p.authors::text ILIKE %s)"
        )
        params.extend([f"%{q.strip()}%"] * 5)

    with _get_pool().connection() as conn:
        rows = conn.execute(
            f"""SELECT p.* FROM saved_papers p {join}
                WHERE {' AND '.join(clauses)}
                ORDER BY p.created_at DESC""",
            params,
        ).fetchall()
        return [_row_to_paper(r, _tags_for(conn, r["id"])) for r in rows]


def delete_saved(user_id: str, paper_id: int) -> bool:
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM saved_papers WHERE id = %s AND user_id = %s",
            (paper_id, user_id),
        )
        return cur.rowcount > 0


def _owns_paper(conn, user_id: str, paper_id: int) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM saved_papers WHERE id = %s AND user_id = %s",
            (paper_id, user_id),
        ).fetchone()
    )


def add_tag(user_id: str, paper_id: int, tag: str) -> bool:
    tag = tag.strip()
    if not tag:
        return False
    with _get_pool().connection() as conn:
        if not _owns_paper(conn, user_id, paper_id):
            return False
        conn.execute(
            """INSERT INTO paper_tags (paper_id, tag) VALUES (%s,%s)
               ON CONFLICT DO NOTHING""",
            (paper_id, tag),
        )
        return True


def remove_tag(user_id: str, paper_id: int, tag: str) -> bool:
    with _get_pool().connection() as conn:
        if not _owns_paper(conn, user_id, paper_id):
            return False
        cur = conn.execute(
            "DELETE FROM paper_tags WHERE paper_id = %s AND tag = %s",
            (paper_id, tag),
        )
        return cur.rowcount > 0


def set_notes(user_id: str, paper_id: int, notes: str) -> bool:
    """Replace a paper's note. Owner-scoped like every other mutation."""
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "UPDATE saved_papers SET notes = %s WHERE id = %s AND user_id = %s",
            (notes or "", paper_id, user_id),
        )
        return cur.rowcount > 0


def list_tags(user_id: str) -> list[dict]:
    with _get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT t.tag AS tag, COUNT(*) AS n
               FROM paper_tags t
               JOIN saved_papers p ON p.id = t.paper_id
               WHERE p.user_id = %s
               GROUP BY t.tag ORDER BY t.tag""",
            (user_id,),
        ).fetchall()
    return [{"tag": r["tag"], "count": r["n"]} for r in rows]


# --- Folders --------------------------------------------------------------


def create_folder(user_id: str, name: str) -> dict | None:
    """Create a folder. Returns None if the name is empty or already used."""
    name = name.strip()
    if not name:
        return None
    with _get_pool().connection() as conn:
        row = conn.execute(
            """INSERT INTO folders (user_id, name) VALUES (%s,%s)
               ON CONFLICT (user_id, name) DO NOTHING
               RETURNING id, name""",
            (user_id, name),
        ).fetchone()
    if row is None:
        return None  # duplicate name for this user
    return {"id": row["id"], "name": row["name"], "count": 0}


def list_folders(user_id: str) -> list[dict]:
    """A user's folders with how many papers each holds, plus the unfiled count."""
    with _get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT f.id, f.name, COUNT(p.id) AS n
               FROM folders f
               LEFT JOIN saved_papers p ON p.folder_id = f.id
               WHERE f.user_id = %s
               GROUP BY f.id, f.name
               ORDER BY f.name""",
            (user_id,),
        ).fetchall()
        unfiled = conn.execute(
            """SELECT COUNT(*) AS n FROM saved_papers
               WHERE user_id = %s AND folder_id IS NULL""",
            (user_id,),
        ).fetchone()["n"]
    folders = [{"id": r["id"], "name": r["name"], "count": r["n"]} for r in rows]
    return folders + [{"id": None, "name": "", "count": unfiled}]


def rename_folder(user_id: str, folder_id: int, name: str) -> bool:
    name = name.strip()
    if not name:
        return False
    with _get_pool().connection() as conn:
        taken = conn.execute(
            "SELECT 1 FROM folders WHERE user_id = %s AND name = %s AND id <> %s",
            (user_id, name, folder_id),
        ).fetchone()
        if taken:
            return False
        cur = conn.execute(
            "UPDATE folders SET name = %s WHERE id = %s AND user_id = %s",
            (name, folder_id, user_id),
        )
        return cur.rowcount > 0


def delete_folder(user_id: str, folder_id: int) -> bool:
    """Delete a folder. Its papers are kept and become unfiled (FK ON DELETE SET NULL)."""
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM folders WHERE id = %s AND user_id = %s", (folder_id, user_id)
        )
        return cur.rowcount > 0


def set_paper_folder(user_id: str, paper_id: int, folder_id: int | None) -> bool:
    """Move a paper into a folder, or out of all folders when folder_id is None."""
    with _get_pool().connection() as conn:
        if folder_id is not None:
            owns_folder = conn.execute(
                "SELECT 1 FROM folders WHERE id = %s AND user_id = %s",
                (folder_id, user_id),
            ).fetchone()
            if not owns_folder:
                return False
        cur = conn.execute(
            "UPDATE saved_papers SET folder_id = %s WHERE id = %s AND user_id = %s",
            (folder_id, paper_id, user_id),
        )
        return cur.rowcount > 0


# --- Search history -------------------------------------------------------


def add_history(
    user_id: str, query: str, detected_lang: str, english_query: str, result_count: int
) -> None:
    with _get_pool().connection() as conn:
        conn.execute(
            """INSERT INTO search_history
               (user_id, query, detected_lang, english_query, result_count)
               VALUES (%s,%s,%s,%s,%s)""",
            (user_id, query, detected_lang, english_query, result_count),
        )


def list_history(user_id: str, limit: int = 30) -> list[dict]:
    with _get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT * FROM search_history WHERE user_id = %s
               ORDER BY created_at DESC LIMIT %s""",
            (user_id, limit),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "query": r["query"] or "",
            "detected_lang": r["detected_lang"] or "",
            "english_query": r["english_query"] or "",
            "result_count": r["result_count"] or 0,
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


def clear_history(user_id: str) -> None:
    with _get_pool().connection() as conn:
        conn.execute("DELETE FROM search_history WHERE user_id = %s", (user_id,))
