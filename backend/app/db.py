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
import secrets
from typing import Optional

from psycopg import connect
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import DATABASE_URL

_SCHEMA = """
CREATE TABLE IF NOT EXISTS teams (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_id    UUID NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
    team_id   BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL,
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, user_id)
);

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
    retraction_status TEXT NOT NULL DEFAULT '',
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

-- Saved chats with the research agent, so a conversation can be picked up
-- later. Only the exchanged messages are stored; abstracts never are, so a
-- resumed search conversation rebuilds its corpus by re-running seed_query.
CREATE TABLE IF NOT EXISTS conversations (
    id         BIGSERIAL PRIMARY KEY,
    user_id    UUID NOT NULL,
    team_id    BIGINT REFERENCES teams(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,          -- 'search' | 'library'
    title      TEXT NOT NULL DEFAULT '',
    seed_query TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,     -- 'user' | 'assistant'
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_idx
    ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversation_messages_idx
    ON conversation_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS search_history (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL,
    query         TEXT,
    detected_lang TEXT,
    english_query TEXT,
    result_count  INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uploaded PDFs. The bytes live here rather than on disk because the instance's
-- filesystem is wiped on every restart, which on a free tier is routine: an
-- upload would vanish minutes later and the reader would 404 on a paper the
-- user had just handed us.
CREATE TABLE IF NOT EXISTS uploads (
    id         TEXT PRIMARY KEY,
    user_id    UUID,
    title      TEXT,
    pages      INTEGER,
    blocks     JSONB,
    body       TEXT,
    data       BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uploads_created_idx ON uploads (created_at);
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
        conn.execute(
            "ALTER TABLE saved_papers ADD COLUMN IF NOT EXISTS retraction_status "
            "TEXT NOT NULL DEFAULT ''"
        )
        # A row belongs to a team workspace when team_id is set, otherwise to
        # the personal library of user_id. user_id always records who added it.
        for table in ("saved_papers", "folders"):
            conn.execute(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS team_id BIGINT "
                "REFERENCES teams(id) ON DELETE CASCADE"
            )
        # Uniqueness is per workspace, so the original per-user constraints are
        # replaced by partial indexes: one for personal rows, one for team rows.
        conn.execute(
            "ALTER TABLE saved_papers DROP CONSTRAINT IF EXISTS saved_papers_user_id_dedup_key_key"
        )
        conn.execute("ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_user_id_name_key")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS saved_papers_personal_uniq ON saved_papers "
            "(user_id, dedup_key) WHERE team_id IS NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS saved_papers_team_uniq ON saved_papers "
            "(team_id, dedup_key) WHERE team_id IS NOT NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS folders_personal_uniq ON folders "
            "(user_id, name) WHERE team_id IS NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS folders_team_uniq ON folders "
            "(team_id, name) WHERE team_id IS NOT NULL"
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
        "retraction_status": row["retraction_status"] or "",
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


# --- Teams ----------------------------------------------------------------


class NotAMember(Exception):
    """Raised when a user touches a team workspace they don't belong to."""


def _new_invite_code() -> str:
    # Short, unambiguous, easy to paste into a group chat.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _assert_member(conn, user_id: str, team_id: int | None) -> None:
    """Every team query goes through here — membership is the access rule."""
    if team_id is None:
        return
    row = conn.execute(
        "SELECT 1 FROM team_members WHERE team_id = %s AND user_id = %s",
        (team_id, user_id),
    ).fetchone()
    if not row:
        raise NotAMember(f"user is not a member of team {team_id}")


def create_team(user_id: str, name: str) -> dict | None:
    name = name.strip()
    if not name:
        return None
    with _get_pool().connection() as conn:
        for _ in range(5):  # retry on the astronomically unlikely code clash
            code = _new_invite_code()
            row = conn.execute(
                """INSERT INTO teams (name, owner_id, invite_code) VALUES (%s,%s,%s)
                   ON CONFLICT (invite_code) DO NOTHING
                   RETURNING id, name, invite_code""",
                (name, user_id, code),
            ).fetchone()
            if row:
                conn.execute(
                    "INSERT INTO team_members (team_id, user_id, role) VALUES (%s,%s,'owner')",
                    (row["id"], user_id),
                )
                return {
                    "id": row["id"],
                    "name": row["name"],
                    "invite_code": row["invite_code"],
                    "role": "owner",
                    "member_count": 1,
                }
    return None


def list_teams(user_id: str) -> list[dict]:
    with _get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT t.id, t.name, t.invite_code, m.role,
                      (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id) AS member_count
               FROM teams t
               JOIN team_members m ON m.team_id = t.id
               WHERE m.user_id = %s
               ORDER BY t.name""",
            (user_id,),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "invite_code": r["invite_code"],
            "role": r["role"],
            "member_count": r["member_count"],
        }
        for r in rows
    ]


def join_team(user_id: str, invite_code: str) -> dict | None:
    code = (invite_code or "").strip().upper()
    if not code:
        return None
    with _get_pool().connection() as conn:
        team = conn.execute(
            "SELECT id, name, invite_code FROM teams WHERE invite_code = %s", (code,)
        ).fetchone()
        if not team:
            return None
        conn.execute(
            """INSERT INTO team_members (team_id, user_id) VALUES (%s,%s)
               ON CONFLICT DO NOTHING""",
            (team["id"], user_id),
        )
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM team_members WHERE team_id = %s", (team["id"],)
        ).fetchone()["n"]
    return {
        "id": team["id"],
        "name": team["name"],
        "invite_code": team["invite_code"],
        "role": "member",
        "member_count": n,
    }


def list_members(user_id: str, team_id: int) -> list[dict]:
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        rows = conn.execute(
            """SELECT m.user_id, m.role, u.email
               FROM team_members m
               LEFT JOIN auth.users u ON u.id = m.user_id
               WHERE m.team_id = %s
               ORDER BY m.role DESC, m.joined_at""",
            (team_id,),
        ).fetchall()
    return [
        {"user_id": str(r["user_id"]), "email": r["email"] or "", "role": r["role"]}
        for r in rows
    ]


def rename_team(user_id: str, team_id: int, name: str) -> bool:
    name = name.strip()
    if not name:
        return False
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "UPDATE teams SET name = %s WHERE id = %s AND owner_id = %s",
            (name, team_id, user_id),
        )
        return cur.rowcount > 0


def delete_team(user_id: str, team_id: int) -> bool:
    """Only the owner can disband a team; its shared papers go with it."""
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM teams WHERE id = %s AND owner_id = %s", (team_id, user_id)
        )
        return cur.rowcount > 0


def leave_team(user_id: str, team_id: int, target_user_id: str | None = None) -> bool:
    """Leave a team, or (as owner) remove another member.

    The owner cannot leave their own team — they disband it instead, so a team
    is never left without an owner.
    """
    target = target_user_id or user_id
    with _get_pool().connection() as conn:
        team = conn.execute("SELECT owner_id FROM teams WHERE id = %s", (team_id,)).fetchone()
        if not team:
            return False
        is_owner = str(team["owner_id"]) == str(user_id)
        if target != user_id and not is_owner:
            return False  # only the owner removes other people
        if str(team["owner_id"]) == str(target):
            return False  # owner must delete the team instead
        cur = conn.execute(
            "DELETE FROM team_members WHERE team_id = %s AND user_id = %s",
            (team_id, target),
        )
        return cur.rowcount > 0


# --- Saved papers ---------------------------------------------------------
#
# Every row lives in exactly one workspace: a personal library (team_id NULL,
# owned by user_id) or a team's shared library (team_id set). `user_id` always
# records who added the row, which is what team attribution displays.


def _paper_scope(user_id: str, team_id: int | None) -> tuple[str, list]:
    """SQL predicate + params restricting `p` to one workspace."""
    if team_id is None:
        return "p.user_id = %s AND p.team_id IS NULL", [user_id]
    return "p.team_id = %s", [team_id]


def save_paper(
    user_id: str,
    card: dict,
    tags: list[str] | None = None,
    folder_id: int | None = None,
    team_id: int | None = None,
) -> dict:
    """Idempotently save a paper into a workspace. Returns the stored record.

    Re-saving a paper already in that workspace is a no-op that merges new tags.
    """
    tags = [t.strip() for t in (tags or []) if t.strip()]
    key = _dedup_key(card)
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if folder_id is not None:
            where, params = (
                ("user_id = %s AND team_id IS NULL", [user_id])
                if team_id is None
                else ("team_id = %s", [team_id])
            )
            owns = conn.execute(
                f"SELECT 1 FROM folders WHERE id = %s AND {where}",
                [folder_id, *params],
            ).fetchone()
            if not owns:
                folder_id = None  # ignore a folder from another workspace

        scope_sql, scope_params = _paper_scope(user_id, team_id)
        existing = conn.execute(
            f"SELECT * FROM saved_papers p WHERE {scope_sql} AND p.dedup_key = %s",
            [*scope_params, key],
        ).fetchone()
        if existing is None:
            conn.execute(
                """INSERT INTO saved_papers
                   (user_id, team_id, source, source_id, title, title_zh, authors,
                    year, venue, url, doi, citation_key, relevance_zh, pub_date,
                    oa_url, retraction_status, folder_id, dedup_key)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    user_id,
                    team_id,
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
                    card.get("retraction_status", ""),
                    folder_id,
                    key,
                ),
            )
            existing = conn.execute(
                f"SELECT * FROM saved_papers p WHERE {scope_sql} AND p.dedup_key = %s",
                [*scope_params, key],
            ).fetchone()
        for tag in tags:
            conn.execute(
                """INSERT INTO paper_tags (paper_id, tag) VALUES (%s,%s)
                   ON CONFLICT DO NOTHING""",
                (existing["id"], tag),
            )
        return _row_to_paper(existing, _tags_for(conn, existing["id"]))


def list_saved(
    user_id: str,
    tag: str | None = None,
    folder: str | None = None,
    q: str | None = None,
    team_id: int | None = None,
) -> list[dict]:
    """List a workspace's saved papers, optionally filtered by tag/folder/text.

    `folder` is a folder id as a string, or "unfiled" for papers in no folder.
    `q` matches case-insensitively across title, Chinese title, authors, venue
    and notes.
    """
    scope_sql, params = _paper_scope(user_id, team_id)
    clauses = [scope_sql]
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
        _assert_member(conn, user_id, team_id)
        rows = conn.execute(
            f"""SELECT p.*, u.email AS added_by_email FROM saved_papers p {join}
                LEFT JOIN auth.users u ON u.id = p.user_id
                WHERE {' AND '.join(clauses)}
                ORDER BY p.created_at DESC""",
            params,
        ).fetchall()
        out = []
        for r in rows:
            paper = _row_to_paper(r, _tags_for(conn, r["id"]))
            # Shown in a shared library so a lab can see who contributed what.
            paper["added_by"] = r.get("added_by_email") or ""
            out.append(paper)
        return out


def _accessible_paper(conn, user_id: str, paper_id: int, team_id: int | None) -> bool:
    """True when the paper is in the workspace the caller is acting in."""
    scope_sql, params = _paper_scope(user_id, team_id)
    return bool(
        conn.execute(
            f"SELECT 1 FROM saved_papers p WHERE p.id = %s AND {scope_sql}",
            [paper_id, *params],
        ).fetchone()
    )


def delete_saved(user_id: str, paper_id: int, team_id: int | None = None) -> bool:
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_paper(conn, user_id, paper_id, team_id):
            return False
        cur = conn.execute("DELETE FROM saved_papers WHERE id = %s", (paper_id,))
        return cur.rowcount > 0


def add_tag(user_id: str, paper_id: int, tag: str, team_id: int | None = None) -> bool:
    tag = tag.strip()
    if not tag:
        return False
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_paper(conn, user_id, paper_id, team_id):
            return False
        conn.execute(
            """INSERT INTO paper_tags (paper_id, tag) VALUES (%s,%s)
               ON CONFLICT DO NOTHING""",
            (paper_id, tag),
        )
        return True


def remove_tag(user_id: str, paper_id: int, tag: str, team_id: int | None = None) -> bool:
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_paper(conn, user_id, paper_id, team_id):
            return False
        cur = conn.execute(
            "DELETE FROM paper_tags WHERE paper_id = %s AND tag = %s", (paper_id, tag)
        )
        return cur.rowcount > 0


def set_notes(
    user_id: str, paper_id: int, notes: str, team_id: int | None = None
) -> bool:
    """Replace a paper's note. In a team library, notes are shared."""
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_paper(conn, user_id, paper_id, team_id):
            return False
        cur = conn.execute(
            "UPDATE saved_papers SET notes = %s WHERE id = %s", (notes or "", paper_id)
        )
        return cur.rowcount > 0


def list_tags(user_id: str, team_id: int | None = None) -> list[dict]:
    scope_sql, params = _paper_scope(user_id, team_id)
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        rows = conn.execute(
            f"""SELECT t.tag AS tag, COUNT(*) AS n
                FROM paper_tags t
                JOIN saved_papers p ON p.id = t.paper_id
                WHERE {scope_sql}
                GROUP BY t.tag ORDER BY t.tag""",
            params,
        ).fetchall()
    return [{"tag": r["tag"], "count": r["n"]} for r in rows]


# --- Folders --------------------------------------------------------------


def _folder_scope(user_id: str, team_id: int | None) -> tuple[str, list]:
    if team_id is None:
        return "f.user_id = %s AND f.team_id IS NULL", [user_id]
    return "f.team_id = %s", [team_id]


def create_folder(user_id: str, name: str, team_id: int | None = None) -> dict | None:
    """Create a folder in a workspace. None if the name is empty or taken."""
    name = name.strip()
    if not name:
        return None
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        scope_sql, params = _folder_scope(user_id, team_id)
        clash = conn.execute(
            f"SELECT 1 FROM folders f WHERE {scope_sql} AND f.name = %s",
            [*params, name],
        ).fetchone()
        if clash:
            return None
        row = conn.execute(
            "INSERT INTO folders (user_id, team_id, name) VALUES (%s,%s,%s) RETURNING id, name",
            (user_id, team_id, name),
        ).fetchone()
    return {"id": row["id"], "name": row["name"], "count": 0}


def list_folders(user_id: str, team_id: int | None = None) -> list[dict]:
    """A workspace's folders with paper counts, plus the unfiled count."""
    scope_sql, params = _folder_scope(user_id, team_id)
    p_scope, p_params = _paper_scope(user_id, team_id)
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        rows = conn.execute(
            f"""SELECT f.id, f.name, COUNT(p.id) AS n
                FROM folders f
                LEFT JOIN saved_papers p ON p.folder_id = f.id
                WHERE {scope_sql}
                GROUP BY f.id, f.name
                ORDER BY f.name""",
            params,
        ).fetchall()
        unfiled = conn.execute(
            f"SELECT COUNT(*) AS n FROM saved_papers p WHERE {p_scope} AND p.folder_id IS NULL",
            p_params,
        ).fetchone()["n"]
    folders = [{"id": r["id"], "name": r["name"], "count": r["n"]} for r in rows]
    return folders + [{"id": None, "name": "", "count": unfiled}]


def _accessible_folder(conn, user_id: str, folder_id: int, team_id: int | None) -> bool:
    scope_sql, params = _folder_scope(user_id, team_id)
    return bool(
        conn.execute(
            f"SELECT 1 FROM folders f WHERE f.id = %s AND {scope_sql}",
            [folder_id, *params],
        ).fetchone()
    )


def rename_folder(
    user_id: str, folder_id: int, name: str, team_id: int | None = None
) -> bool:
    name = name.strip()
    if not name:
        return False
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_folder(conn, user_id, folder_id, team_id):
            return False
        scope_sql, params = _folder_scope(user_id, team_id)
        taken = conn.execute(
            f"SELECT 1 FROM folders f WHERE {scope_sql} AND f.name = %s AND f.id <> %s",
            [*params, name, folder_id],
        ).fetchone()
        if taken:
            return False
        cur = conn.execute(
            "UPDATE folders SET name = %s WHERE id = %s", (name, folder_id)
        )
        return cur.rowcount > 0


def delete_folder(user_id: str, folder_id: int, team_id: int | None = None) -> bool:
    """Delete a folder; its papers are kept and become unfiled."""
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_folder(conn, user_id, folder_id, team_id):
            return False
        cur = conn.execute("DELETE FROM folders WHERE id = %s", (folder_id,))
        return cur.rowcount > 0


def set_paper_folder(
    user_id: str, paper_id: int, folder_id: int | None, team_id: int | None = None
) -> bool:
    """Move a paper into a folder of the same workspace, or out of all folders."""
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_paper(conn, user_id, paper_id, team_id):
            return False
        if folder_id is not None and not _accessible_folder(
            conn, user_id, folder_id, team_id
        ):
            return False
        cur = conn.execute(
            "UPDATE saved_papers SET folder_id = %s WHERE id = %s",
            (folder_id, paper_id),
        )
        return cur.rowcount > 0
# --- Conversations --------------------------------------------------------


def _title_from(text: str) -> str:
    """A short label for the sidebar, taken from the opening question."""
    t = " ".join((text or "").split())
    return t[:60] if t else "…"


def create_conversation(
    user_id: str,
    kind: str,
    first_message: str,
    seed_query: str = "",
    team_id: int | None = None,
) -> int:
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        row = conn.execute(
            """INSERT INTO conversations (user_id, team_id, kind, title, seed_query)
               VALUES (%s,%s,%s,%s,%s) RETURNING id""",
            (user_id, team_id, kind, _title_from(first_message), seed_query),
        ).fetchone()
        return row["id"]


def _owns_conversation(conn, user_id: str, conversation_id: int) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM conversations WHERE id = %s AND user_id = %s",
            (conversation_id, user_id),
        ).fetchone()
    )


def append_messages(user_id: str, conversation_id: int, messages: list[dict]) -> bool:
    """Append turns and bump the conversation's updated_at."""
    with _get_pool().connection() as conn:
        if not _owns_conversation(conn, user_id, conversation_id):
            return False
        for m in messages:
            conn.execute(
                """INSERT INTO conversation_messages (conversation_id, role, content)
                   VALUES (%s,%s,%s)""",
                (conversation_id, m.get("role", "user"), m.get("content", "")),
            )
        conn.execute(
            "UPDATE conversations SET updated_at = now() WHERE id = %s",
            (conversation_id,),
        )
        return True


def list_conversations(
    user_id: str, kind: str | None = None, limit: int = 50
) -> list[dict]:
    clauses = ["c.user_id = %s"]
    params: list = [user_id]
    if kind:
        clauses.append("c.kind = %s")
        params.append(kind)
    params.append(limit)
    with _get_pool().connection() as conn:
        rows = conn.execute(
            f"""SELECT c.id, c.kind, c.title, c.seed_query, c.team_id, c.updated_at,
                       (SELECT COUNT(*) FROM conversation_messages m
                         WHERE m.conversation_id = c.id) AS message_count
                FROM conversations c
                WHERE {' AND '.join(clauses)}
                ORDER BY c.updated_at DESC
                LIMIT %s""",
            params,
        ).fetchall()
    return [
        {
            "id": r["id"],
            "kind": r["kind"],
            "title": r["title"],
            "seed_query": r["seed_query"] or "",
            "team_id": r["team_id"],
            "message_count": r["message_count"],
            "updated_at": r["updated_at"].isoformat(),
        }
        for r in rows
    ]


def get_conversation(user_id: str, conversation_id: int) -> dict | None:
    with _get_pool().connection() as conn:
        c = conn.execute(
            "SELECT * FROM conversations WHERE id = %s AND user_id = %s",
            (conversation_id, user_id),
        ).fetchone()
        if not c:
            return None
        rows = conn.execute(
            """SELECT role, content FROM conversation_messages
               WHERE conversation_id = %s ORDER BY id""",
            (conversation_id,),
        ).fetchall()
    return {
        "id": c["id"],
        "kind": c["kind"],
        "title": c["title"],
        "seed_query": c["seed_query"] or "",
        "team_id": c["team_id"],
        "updated_at": c["updated_at"].isoformat(),
        "messages": [{"role": r["role"], "content": r["content"]} for r in rows],
    }


def rename_conversation(user_id: str, conversation_id: int, title: str) -> bool:
    title = title.strip()
    if not title:
        return False
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "UPDATE conversations SET title = %s WHERE id = %s AND user_id = %s",
            (title[:60], conversation_id, user_id),
        )
        return cur.rowcount > 0


def delete_conversation(user_id: str, conversation_id: int) -> bool:
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM conversations WHERE id = %s AND user_id = %s",
            (conversation_id, user_id),
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


# --- Uploaded PDFs -------------------------------------------------------


def put_upload(record: dict, data: bytes, user_id: str | None) -> None:
    """Persist an uploaded PDF and its extracted text."""
    with _get_pool().connection() as conn:
        conn.execute(
            """
            INSERT INTO uploads (id, user_id, title, pages, blocks, body, data)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (
                record["id"],
                user_id,
                record["title"],
                record["pages"],
                json.dumps(record["blocks"]),
                record["text"],
                data,
            ),
        )


def get_upload(uid: str, with_data: bool = False) -> dict | None:
    """An uploaded PDF. `with_data` also returns the bytes, which are large."""
    cols = "id, title, pages, blocks, body" + (", data" if with_data else "")
    with _get_pool().connection() as conn:
        row = conn.execute(
            f"SELECT {cols} FROM uploads WHERE id = %s", (uid,)
        ).fetchone()
    if row is None:
        return None
    record = {
        "id": row["id"],
        "title": row["title"] or "",
        "pages": row["pages"] or 0,
        "blocks": row["blocks"] or [],
        "text": row["body"] or "",
    }
    if with_data:
        record["data"] = bytes(row["data"])
    return record


def purge_uploads(older_than_hours: int = 72) -> int:
    """Drop uploads past their keep-window. Returns how many went."""
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM uploads WHERE created_at < now() - make_interval(hours => %s)",
            (older_than_hours,),
        )
        return cur.rowcount or 0


def upload_owner(uid: str) -> str | None:
    """The user id that uploaded this file, or None when it has no owner."""
    with _get_pool().connection() as conn:
        row = conn.execute("SELECT user_id FROM uploads WHERE id = %s", (uid,)).fetchone()
    return str(row["user_id"]) if row and row["user_id"] else None
