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
from .services import blobstore

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
    -- Folders nest. A reading list is rarely one flat level: a project has
    -- topics, a topic has threads. Deleting a parent lifts its children up
    -- rather than taking them with it, because a folder is a label and losing
    -- one should never lose papers.
    parent_id  BIGINT REFERENCES folders(id) ON DELETE SET NULL,
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
    kind       TEXT NOT NULL,          -- 'search' | 'library' | 'paper'
    -- The papers the answer was written from, as metadata only (no abstracts,
    -- same rule as everywhere else). Without them a saved thread could only be
    -- reopened by running its search again, which is not reopening at all.
    sources    JSONB,
    -- How the result was arrived at and displayed: the mode, the filters, and
    -- a deep brief's sub-questions, contradictions and gaps. Without it a
    -- reopened deep search collapses into a plain answer and the controls snap
    -- back to defaults, which is not the state the reader left.
    state      JSONB,
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
    card       JSONB,  -- resolved bibliographic record, so an upload looks like any other paper
    data       BYTEA NOT NULL,
    sha256     TEXT,          -- same bytes uploaded twice reuse one row
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE uploads ADD COLUMN IF NOT EXISTS card JSONB;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS sha256 TEXT;
-- The bytes moved to Supabase Storage. `data` stays for rows written before the
-- move and for deployments with no Storage configured, so it can no longer be
-- NOT NULL: exactly one of the two columns holds the file.
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE uploads ALTER COLUMN data DROP NOT NULL;
CREATE INDEX IF NOT EXISTS uploads_sha_idx ON uploads (user_id, sha256);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sources JSONB;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS state JSONB;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_user_id_name_key;
CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent_id);
CREATE TABLE IF NOT EXISTS feedback (
    id         BIGSERIAL PRIMARY KEY,
    user_id    UUID,          -- null when sent by someone not signed in
    email      TEXT,          -- optional, only if they want a reply
    message    TEXT NOT NULL,
    context    TEXT,          -- which screen they were on, for reproducing it
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An import of someone else's reference library. Progress lives in the
-- database rather than in memory because these runs are minutes long: the
-- instance can restart mid-import, and a job that vanishes without saying how
-- far it got is worse than one that admits it stopped.
CREATE TABLE IF NOT EXISTS import_jobs (
    id         BIGSERIAL PRIMARY KEY,
    user_id    UUID NOT NULL,
    team_id    BIGINT REFERENCES teams(id) ON DELETE CASCADE,
    folder_id  BIGINT REFERENCES folders(id) ON DELETE SET NULL,
    filename   TEXT,
    format     TEXT,
    status     TEXT NOT NULL DEFAULT 'running',  -- running | done | stopped
    total      INTEGER NOT NULL DEFAULT 0,
    done       INTEGER NOT NULL DEFAULT 0,
    added      INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    failed     INTEGER NOT NULL DEFAULT 0,
    entries    JSONB,   -- what was parsed, so a stopped job can say what is left
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where a paper is in the reading of it. A library that only records whether
-- something was saved cannot answer "what should I read next", which is the
-- question a researcher actually has most mornings.
-- '' (unset) | toread | reading | read | cited
ALTER TABLE saved_papers ADD COLUMN IF NOT EXISTS read_state TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS saved_papers_state_idx ON saved_papers (user_id, read_state);

-- What it would take to put the library back as it was. Written before a batch
-- of changes, not after: the agent can restructure a shelf in one click, and
-- an undo is what makes that safe to use boldly rather than nervously.
CREATE TABLE IF NOT EXISTS library_undo (
    id         BIGSERIAL PRIMARY KEY,
    user_id    UUID NOT NULL,
    team_id    BIGINT REFERENCES teams(id) ON DELETE CASCADE,
    label      TEXT NOT NULL DEFAULT '',
    inverse    JSONB NOT NULL,   -- low-level ops, applied in reverse
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    undone_at  TIMESTAMPTZ
);

-- A skill is the lab's own convention, written down once.
--
-- No vendor can guess that a group names folders by grant number, or that
-- every note must record species and sample size. These are instructions, not
-- code: a skill composes the tools the agent already has, so it adds no
-- capability and no attack surface, and everything it does still arrives as a
-- proposal. `description` says when to use it, and is what lets the agent pick
-- one on its own rather than waiting to be told.
CREATE TABLE IF NOT EXISTS skills (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL,
    team_id     BIGINT REFERENCES teams(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    -- Shared skills apply to everyone in the workspace, so a PI can set the
    -- group's conventions once. Personal ones stay personal.
    shared      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An experiment, as it was actually run. The lab notebook that literature
-- management keeps pointing at but never had anywhere to put: what was tried,
-- what happened, and which papers it came from. Linked to saved papers by id
-- so "this protocol is from Tanaka 2019" survives.
CREATE TABLE IF NOT EXISTS records (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL,
    team_id     BIGINT REFERENCES teams(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'experiment',  -- experiment | protocol | observation
    happened_on DATE,
    aim         TEXT NOT NULL DEFAULT '',
    method      TEXT NOT NULL DEFAULT '',
    result      TEXT NOT NULL DEFAULT '',
    paper_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS records_user_idx ON records (user_id, happened_on DESC NULLS LAST);

-- An assistant someone built for themselves: which capabilities it may use,
-- and how it should work. The built-in three are code; these are the same
-- thing with the instructions written by a user instead.
CREATE TABLE IF NOT EXISTS assistants (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID NOT NULL,
    team_id      BIGINT REFERENCES teams(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    -- Which toolsets it is allowed: any of library | records | writing.
    toolsets     JSONB NOT NULL DEFAULT '["library"]'::jsonb,
    shared       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistants_user_idx ON assistants (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS skills_user_idx ON skills (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS skills_team_idx ON skills (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS library_undo_user_idx ON library_undo (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS import_jobs_user_idx ON import_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC);
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
        # Uniqueness is per parent, not per workspace: "Methods" under two
        # different projects is an ordinary thing to want, and the old indexes
        # forbade it. COALESCE gives top-level folders a stand-in parent so a
        # NULL parent still collides with another NULL parent.
        conn.execute("DROP INDEX IF EXISTS folders_personal_uniq")
        conn.execute("DROP INDEX IF EXISTS folders_team_uniq")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS folders_personal_parent_uniq ON folders "
            "(user_id, COALESCE(parent_id, 0), name) WHERE team_id IS NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS folders_team_parent_uniq ON folders "
            "(team_id, COALESCE(parent_id, 0), name) WHERE team_id IS NOT NULL"
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
        "read_state": row.get("read_state") or "",
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


class NotPermitted(Exception):
    """The caller is a member, but this action is the workspace owner's."""


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
            """SELECT m.user_id, m.role, u.email,
                      (SELECT COUNT(*) FROM saved_papers p
                        WHERE p.team_id = m.team_id AND p.user_id = m.user_id)
                        AS papers_added
               FROM team_members m
               LEFT JOIN auth.users u ON u.id = m.user_id
               WHERE m.team_id = %s
               ORDER BY m.role DESC, m.joined_at""",
            (team_id,),
        ).fetchall()
    return [
        {
            "user_id": str(r["user_id"]),
            "email": r["email"] or "",
            "role": r["role"],
            "papers_added": r["papers_added"] or 0,
        }
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


READ_STATES = ("", "toread", "reading", "read", "cited")


def set_read_state(
    user_id: str, paper_id: int, state: str, team_id: int | None = None
) -> bool:
    """Where this paper is in the reading of it. '' clears the mark."""
    if state not in READ_STATES:
        return False
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_paper(conn, user_id, paper_id, team_id):
            return False
        cur = conn.execute(
            "UPDATE saved_papers SET read_state = %s WHERE id = %s", (state, paper_id)
        )
        return cur.rowcount > 0


def read_state_counts(user_id: str, team_id: int | None = None) -> dict:
    scope_sql, params = _paper_scope(user_id, team_id)
    with _get_pool().connection() as conn:
        rows = conn.execute(
            f"""SELECT p.read_state AS s, count(*) AS n FROM saved_papers p
                 WHERE {scope_sql} GROUP BY p.read_state""",
            params,
        ).fetchall()
    return {(r["s"] or "unset"): r["n"] for r in rows}


# --- Undo -----------------------------------------------------------------


def record_undo(
    user_id: str, team_id: int | None, label: str, inverse: list[dict]
) -> int | None:
    """Store what it would take to put things back. Returns the undo id."""
    if not inverse:
        return None
    with _get_pool().connection() as conn:
        row = conn.execute(
            """INSERT INTO library_undo (user_id, team_id, label, inverse)
               VALUES (%s,%s,%s,%s) RETURNING id""",
            (user_id, team_id, label[:200], json.dumps(inverse, ensure_ascii=False)),
        ).fetchone()
        return int(row["id"])


def get_undo(user_id: str, undo_id: int) -> dict | None:
    with _get_pool().connection() as conn:
        row = conn.execute(
            """SELECT id, label, inverse, team_id, created_at, undone_at
                 FROM library_undo WHERE id = %s AND user_id = %s""",
            (undo_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def mark_undone(user_id: str, undo_id: int) -> bool:
    with _get_pool().connection() as conn:
        cur = conn.execute(
            """UPDATE library_undo SET undone_at = now()
                WHERE id = %s AND user_id = %s AND undone_at IS NULL""",
            (undo_id, user_id),
        )
        return cur.rowcount > 0


def paper_snapshot(user_id: str, paper_ids: list[int], team_id: int | None = None) -> dict:
    """Folder, note, state and tags for these papers, as they are right now.

    Read before a change so the inverse can be computed from what was actually
    there, rather than from what the change assumed was there.
    """
    if not paper_ids:
        return {}
    scope_sql, params = _paper_scope(user_id, team_id)
    with _get_pool().connection() as conn:
        rows = conn.execute(
            f"""SELECT p.id, p.folder_id, p.notes, p.read_state,
                       COALESCE(array_agg(t.tag) FILTER (WHERE t.tag IS NOT NULL), '{{}}') AS tags
                  FROM saved_papers p
             LEFT JOIN paper_tags t ON t.paper_id = p.id
                 WHERE {scope_sql} AND p.id = ANY(%s)
              GROUP BY p.id, p.folder_id, p.notes, p.read_state""",
            [*params, [int(i) for i in paper_ids]],
        ).fetchall()
    return {
        r["id"]: {
            "folder_id": r["folder_id"],
            "notes": r["notes"] or "",
            "read_state": r["read_state"] or "",
            "tags": list(r["tags"] or []),
        }
        for r in rows
    }


def paper_exists(user_id: str, card: dict, team_id: int | None = None) -> bool:
    """Whether this workspace already holds this paper.

    save_paper is idempotent, but silently so — it cannot tell an import
    whether it added a reference or recognised one. An import that reports
    "300 added" when 280 were already there has told the user nothing.
    """
    scope_sql, params = _paper_scope(user_id, team_id)
    with _get_pool().connection() as conn:
        row = conn.execute(
            f"SELECT 1 FROM saved_papers p WHERE {scope_sql} AND p.dedup_key = %s",
            [*params, _dedup_key(card)],
        ).fetchone()
    return row is not None


# --- Import jobs ---------------------------------------------------------


def create_import_job(
    user_id: str,
    entries: list[dict],
    filename: str,
    fmt: str,
    folder_id: int | None,
    team_id: int | None,
) -> int:
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        row = conn.execute(
            """INSERT INTO import_jobs
                 (user_id, team_id, folder_id, filename, format, total, entries)
               VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (
                user_id,
                team_id,
                folder_id,
                filename[:200],
                fmt,
                len(entries),
                json.dumps(entries, ensure_ascii=False),
            ),
        ).fetchone()
        return int(row["id"])


def update_import_job(job_id: int, **fields) -> None:
    """Write progress. Unknown columns are ignored rather than raising."""
    allowed = {"status", "done", "added", "duplicates", "failed", "note"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return
    assignments = ", ".join(f"{k} = %s" for k in sets)
    with _get_pool().connection() as conn:
        conn.execute(
            f"UPDATE import_jobs SET {assignments}, updated_at = now() WHERE id = %s",
            [*sets.values(), job_id],
        )


def get_import_job(user_id: str, job_id: int) -> dict | None:
    with _get_pool().connection() as conn:
        row = conn.execute(
            """SELECT id, filename, format, status, total, done, added, duplicates,
                      failed, note, folder_id, created_at, updated_at
                 FROM import_jobs WHERE id = %s AND user_id = %s""",
            (job_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def recent_import_jobs(user_id: str, limit: int = 10) -> list[dict]:
    with _get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT id, filename, format, status, total, done, added, duplicates,
                      failed, note, created_at
                 FROM import_jobs WHERE user_id = %s
                ORDER BY created_at DESC LIMIT %s""",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def stop_stale_import_jobs() -> int:
    """Mark jobs that were running when the process died.

    Background work does not survive a restart, and on a free instance restarts
    are routine. Left alone these sit at "running" forever, which reads as a
    hang; saying they stopped, and how far they got, at least tells the truth.
    """
    with _get_pool().connection() as conn:
        cur = conn.execute(
            """UPDATE import_jobs
                  SET status = 'stopped',
                      note = 'interrupted by a server restart',
                      updated_at = now()
                WHERE status = 'running'"""
        )
        return cur.rowcount or 0


def list_saved(
    user_id: str,
    tag: str | None = None,
    folder: str | None = None,
    q: str | None = None,
    team_id: int | None = None,
    state: str | None = None,
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
    if state:
        # "unset" is a filter in its own right: the pile nobody has triaged yet
        # is exactly what someone wants to see when they open the library.
        clauses.append("p.read_state = %s")
        params.append("" if state == "unset" else state)
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


def _is_owner(conn, user_id: str, team_id: int) -> bool:
    row = conn.execute(
        "SELECT role FROM team_members WHERE team_id = %s AND user_id = %s",
        (team_id, user_id),
    ).fetchone()
    return bool(row and row["role"] == "owner")


def delete_saved(user_id: str, paper_id: int, team_id: int | None = None) -> bool:
    """Remove a saved paper.

    In a shared library anyone could previously delete anything, so a student
    could clear the group's collection — including papers they had never seen.
    Removing is now limited to whoever saved the paper, plus the workspace
    owner, who needs to be able to tidy up after people who have left.
    """
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_paper(conn, user_id, paper_id, team_id):
            return False
        if team_id is not None:
            row = conn.execute(
                "SELECT user_id FROM saved_papers WHERE id = %s", (paper_id,)
            ).fetchone()
            saved_by = str(row["user_id"]) if row else ""
            if saved_by != user_id and not _is_owner(conn, user_id, team_id):
                raise NotPermitted("only the person who saved it, or the owner")
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


def create_folder(
    user_id: str,
    name: str,
    team_id: int | None = None,
    parent_id: int | None = None,
) -> dict | None:
    """Create a folder in a workspace. None if the name is empty or taken."""
    name = name.strip()
    if not name:
        return None
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        scope_sql, params = _folder_scope(user_id, team_id)
        # Clash only within the same parent — the check used to span the whole
        # workspace, which stopped "Methods" existing under two projects.
        parent_sql = "f.parent_id IS NULL" if parent_id is None else "f.parent_id = %s"
        parent_params = [] if parent_id is None else [parent_id]
        clash = conn.execute(
            f"SELECT 1 FROM folders f WHERE {scope_sql} AND {parent_sql} AND f.name = %s",
            [*params, *parent_params, name],
        ).fetchone()
        if clash:
            return None
        row = conn.execute(
            """INSERT INTO folders (user_id, team_id, name, parent_id)
               VALUES (%s,%s,%s,%s) RETURNING id, name, parent_id""",
            (user_id, team_id, name, parent_id),
        ).fetchone()
    return {
        "id": row["id"],
        "name": row["name"],
        "parent_id": row["parent_id"],
        "count": 0,
    }


def list_folders(user_id: str, team_id: int | None = None) -> list[dict]:
    """A workspace's folders with paper counts, plus the unfiled count."""
    scope_sql, params = _folder_scope(user_id, team_id)
    p_scope, p_params = _paper_scope(user_id, team_id)
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        rows = conn.execute(
            f"""SELECT f.id, f.name, f.parent_id, COUNT(p.id) AS n
                FROM folders f
                LEFT JOIN saved_papers p ON p.folder_id = f.id
                WHERE {scope_sql}
                GROUP BY f.id, f.name, f.parent_id
                ORDER BY f.name""",
            params,
        ).fetchall()
        unfiled = conn.execute(
            f"SELECT COUNT(*) AS n FROM saved_papers p WHERE {p_scope} AND p.folder_id IS NULL",
            p_params,
        ).fetchone()["n"]
    folders = [
        {"id": r["id"], "name": r["name"], "parent_id": r["parent_id"], "count": r["n"]}
        for r in rows
    ]
    return folders + [{"id": None, "name": "", "parent_id": None, "count": unfiled}]


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
    """Delete a folder; its papers are kept and become unfiled.

    In a shared workspace, deleting is limited to whoever made the folder and
    the workspace admin — the same rule as saved papers. Creating, renaming and
    re-nesting stay open to every member, because organising a shared shelf is
    collaborative and all of it is reversible; deleting a branch someone else
    built is the one action that is not.
    """
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_folder(conn, user_id, folder_id, team_id):
            return False
        if team_id is not None:
            row = conn.execute(
                "SELECT user_id FROM folders WHERE id = %s", (folder_id,)
            ).fetchone()
            made_by = str(row["user_id"]) if row else ""
            if made_by != user_id and not _is_owner(conn, user_id, team_id):
                raise NotPermitted("only the person who made it, or an admin")
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
    sources: list[dict] | None = None,
    state: dict | None = None,
) -> int:
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        row = conn.execute(
            """INSERT INTO conversations
                   (user_id, team_id, kind, title, seed_query, sources, state)
               VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (
                user_id,
                team_id,
                kind,
                _title_from(first_message),
                seed_query,
                json.dumps(sources) if sources else None,
                json.dumps(state) if state else None,
            ),
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
    user_id: str,
    kind: str | None = None,
    limit: int = 50,
    team_id: int | None = None,
    scope_team: bool = False,
    q: str | None = None,
) -> list[dict]:
    """Threads for this user, optionally narrowed to one workspace.

    `scope_team` is what makes a workspace's threads its own: without it a
    library conversation started in a lab workspace shows up in the personal
    library and in every other lab, because they are all the same user's rows.

    `q` searches the whole thread, not just its title. What people remember
    about a past search is rarely the question they typed — it is a paper they
    saw or a phrase in the answer — so the question, every message, and the
    titles of the papers it cited are all matched, and the first matching
    message comes back as a snippet so the reader can see why it matched.

    ILIKE rather than full-text search, deliberately: Postgres tokenises by
    whitespace, so a to_tsvector index would not match anything inside a
    Chinese sentence without a segmenter. Substring matching is what actually
    works in both languages, and at one user's thread count it is cheap.
    """
    search = (q or "").strip()
    like = _like_pattern(search)
    clauses = ["c.user_id = %s"]
    params: list = [user_id]
    # The snippet subquery sits in the SELECT list, so its parameter binds
    # before any in the WHERE clause.
    snippet_sql = "NULL AS snippet"
    if search:
        snippet_sql = """(SELECT m.content FROM conversation_messages m
                           WHERE m.conversation_id = c.id AND m.content ILIKE %s
                           ORDER BY m.id LIMIT 1) AS snippet"""
        params.insert(0, like)
    if kind:
        clauses.append("c.kind = %s")
        params.append(kind)
    if scope_team:
        if team_id is None:
            clauses.append("c.team_id IS NULL")
        else:
            clauses.append("c.team_id = %s")
            params.append(team_id)
    if search:
        clauses.append(
            """(c.title ILIKE %s OR c.seed_query ILIKE %s
                OR c.sources::text ILIKE %s
                OR EXISTS (SELECT 1 FROM conversation_messages m
                            WHERE m.conversation_id = c.id AND m.content ILIKE %s))"""
        )
        params += [like, like, like, like]
    params.append(limit)
    with _get_pool().connection() as conn:
        rows = conn.execute(
            f"""SELECT c.id, c.kind, c.title, c.seed_query, c.team_id, c.updated_at,
                       (SELECT COUNT(*) FROM conversation_messages m
                         WHERE m.conversation_id = c.id) AS message_count,
                       {snippet_sql}
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
            "snippet": _excerpt(r["snippet"], search),
        }
        for r in rows
    ]


def _like_pattern(term: str) -> str:
    """Wrap a search term for ILIKE, treating its characters as characters.

    `%` and `_` are wildcards to LIKE, so an unescaped `_` quietly matches any
    character — searching "IL_6" would return "IL-6" and "IL6" as well, and
    a lone "%" would match every row. Backslash goes first, or escaping the
    others would then be escaped in turn.
    """
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _excerpt(text: str | None, term: str, width: int = 110) -> str:
    """A short window of `text` around `term`, so a hit shows its context.

    Returning the whole message would fill the rail with an answer; returning
    its first line would usually miss the match, which is the one part the
    reader is looking for.
    """
    if not text or not term:
        return ""
    body = " ".join(text.split())
    at = body.lower().find(term.lower())
    if at < 0:
        return body[:width] + ("…" if len(body) > width else "")
    start = max(0, at - width // 3)
    end = min(len(body), start + width)
    return ("…" if start else "") + body[start:end] + ("…" if end < len(body) else "")


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
        "sources": c.get("sources") or [],
        "state": c.get("state") or {},
        "messages": [{"role": r["role"], "content": r["content"] } for r in rows],
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
    """Persist an uploaded PDF and its extracted text.

    The bytes go to Storage when it is configured, and only fall back into the
    `data` column when that fails — a slow, expensive write beats losing the
    file the reader just handed over.
    """
    key = blobstore.put(record["id"], data) if blobstore.enabled() else None
    with _get_pool().connection() as conn:
        conn.execute(
            """
            INSERT INTO uploads
                (id, user_id, title, pages, blocks, body, data, card, sha256, storage_key)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (
                record["id"],
                user_id,
                record["title"],
                record["pages"],
                json.dumps(record["blocks"]),
                record["text"],
                None if key else data,
                json.dumps(record.get("card")) if record.get("card") else None,
                record.get("sha256"),
                key,
            ),
        )


def get_upload(uid: str, with_data: bool = False) -> dict | None:
    """An uploaded PDF. `with_data` also returns the bytes, which are large."""
    cols = "id, title, pages, blocks, body, card, storage_key" + (
        ", data" if with_data else ""
    )
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
        "card": row["card"],
    }
    if with_data:
        data = blobstore.get(row["storage_key"]) if row["storage_key"] else None
        if data is None and row["data"] is not None:
            data = bytes(row["data"])  # written before the move, or no Storage
        # May be None: the extracted text is stored separately and still opens
        # in the reader, so a missing file costs the PDF pane, not the paper.
        record["data"] = data
    return record


def purge_uploads(older_than_hours: int = 72) -> int:
    """Drop scratch uploads. Returns how many went.

    An upload that someone saved to a library is theirs and is kept forever; one
    that was read once and never saved is a temporary file, and each is
    megabytes in a database measured in hundreds of them.
    """
    with _get_pool().connection() as conn:
        rows = conn.execute(
            """DELETE FROM uploads u
                WHERE u.created_at < now() - make_interval(hours => %s)
                  AND NOT EXISTS (
                    SELECT 1 FROM saved_papers p
                     WHERE p.source_id = 'upload:' || u.id
                  )
             RETURNING u.storage_key""",
            (older_than_hours,),
        ).fetchall()
    # Deleting the row is not deleting the file once the file lives elsewhere;
    # without this, purging would free nothing and Storage would grow forever.
    keys = [r["storage_key"] for r in rows if r["storage_key"]]
    if keys:
        blobstore.delete(keys)
    return len(rows)


def migrate_uploads_to_storage(limit: int = 25) -> tuple[int, int]:
    """Move file bytes out of the `data` column into Storage.

    Returns (moved, remaining). Batched and called at startup rather than run as
    one migration: the rows are megabytes each, the free instance is small, and
    a boot that has to shift a gigabyte before serving a request is a boot that
    times out. Anything not yet moved still reads from `data`, so a half-done
    migration is a working system.
    """
    if not blobstore.enabled():
        return 0, 0
    with _get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT id, data FROM uploads
                WHERE storage_key IS NULL AND data IS NOT NULL
                ORDER BY created_at LIMIT %s""",
            (limit,),
        ).fetchall()
        moved = 0
        for row in rows:
            key = blobstore.put(row["id"], bytes(row["data"]))
            if not key:
                break  # Storage is unwell; leave the rest where they are
            conn.execute(
                "UPDATE uploads SET storage_key = %s, data = NULL WHERE id = %s",
                (key, row["id"]),
            )
            moved += 1
        remaining = conn.execute(
            "SELECT count(*) AS n FROM uploads WHERE storage_key IS NULL AND data IS NOT NULL"
        ).fetchone()["n"]
    return moved, remaining


def find_upload_by_hash(user_id: str | None, sha: str) -> dict | None:
    """An upload of these exact bytes already stored for this person."""
    if not sha:
        return None
    with _get_pool().connection() as conn:
        row = conn.execute(
            """SELECT id FROM uploads
                WHERE sha256 = %s AND user_id IS NOT DISTINCT FROM %s
                ORDER BY created_at LIMIT 1""",
            (sha, user_id),
        ).fetchone()
    return get_upload(row["id"]) if row else None


def upload_owner(uid: str) -> str | None:
    """The user id that uploaded this file, or None when it has no owner."""
    with _get_pool().connection() as conn:
        row = conn.execute("SELECT user_id FROM uploads WHERE id = %s", (uid,)).fetchone()
    return str(row["user_id"]) if row and row["user_id"] else None


def set_conversation_sources(user_id: str, conversation_id: int, sources: list[dict]) -> bool:
    """Replace the stored corpus — the agent can add papers mid-thread."""
    with _get_pool().connection() as conn:
        if not _owns_conversation(conn, user_id, conversation_id):
            return False
        conn.execute(
            "UPDATE conversations SET sources = %s, updated_at = now() WHERE id = %s",
            (json.dumps(sources), conversation_id),
        )
        return True


def replace_conversation_result(
    user_id: str,
    conversation_id: int,
    first_message: str,
    answer: str,
    sources: list[dict],
    state: dict,
) -> bool:
    """Overwrite a thread with a fresh run of the same question.

    Re-running at a different depth, or against different databases, is the
    same piece of work — filing it as a second thread leaves the reader with
    two entries for one question and no way to tell them apart. The earlier
    exchange is replaced rather than appended because the answer it produced no
    longer describes what is on screen.
    """
    with _get_pool().connection() as conn:
        if not _owns_conversation(conn, user_id, conversation_id):
            return False
        conn.execute(
            "DELETE FROM conversation_messages WHERE conversation_id = %s",
            (conversation_id,),
        )
        conn.execute(
            """UPDATE conversations
                  SET title = %s, sources = %s, state = %s, updated_at = now()
                WHERE id = %s""",
            (_title_from(first_message), json.dumps(sources), json.dumps(state), conversation_id),
        )
        for role, content in (("user", first_message), ("assistant", answer)):
            conn.execute(
                """INSERT INTO conversation_messages (conversation_id, role, content)
                   VALUES (%s,%s,%s)""",
                (conversation_id, role, content),
            )
        return True


def set_member_role(user_id: str, team_id: int, member_id: str, role: str) -> bool:
    """Promote or demote a member. Only an owner may, and never the last one.

    A lab outlives any one person's account, so ownership has to be shareable
    and transferable — otherwise a graduating PI takes the group's library with
    them. Demoting the last owner is refused, because a workspace nobody can
    administer cannot be repaired.
    """
    if role not in ("owner", "member"):
        return False
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _is_owner(conn, user_id, team_id):
            raise NotPermitted("only an owner can change roles")
        if role == "member":
            owners = conn.execute(
                "SELECT COUNT(*) AS n FROM team_members WHERE team_id = %s AND role = 'owner'",
                (team_id,),
            ).fetchone()["n"]
            current = conn.execute(
                "SELECT role FROM team_members WHERE team_id = %s AND user_id = %s",
                (team_id, member_id),
            ).fetchone()
            if owners <= 1 and current and current["role"] == "owner":
                raise NotPermitted("a workspace needs at least one owner")
        cur = conn.execute(
            "UPDATE team_members SET role = %s WHERE team_id = %s AND user_id = %s",
            (role, team_id, member_id),
        )
        return cur.rowcount > 0


def move_folder(
    user_id: str, folder_id: int, parent_id: int | None, team_id: int | None = None
) -> bool:
    """Re-file a folder under another one, or back to the top level.

    A folder cannot be moved inside itself or its own descendants: that would
    detach the whole branch from the tree, leaving papers that exist but can
    never be reached.
    """
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        if not _accessible_folder(conn, user_id, folder_id, team_id):
            return False
        if parent_id is not None:
            if parent_id == folder_id:
                raise NotPermitted("a folder cannot contain itself")
            if not _accessible_folder(conn, user_id, parent_id, team_id):
                return False
            walker = parent_id
            seen = 0
            while walker is not None and seen < 64:
                if walker == folder_id:
                    raise NotPermitted("a folder cannot be moved inside itself")
                row = conn.execute(
                    "SELECT parent_id FROM folders WHERE id = %s", (walker,)
                ).fetchone()
                walker = row["parent_id"] if row else None
                seen += 1
        cur = conn.execute(
            "UPDATE folders SET parent_id = %s WHERE id = %s", (parent_id, folder_id)
        )
        return cur.rowcount > 0


def add_feedback(
    user_id: str | None, message: str, email: str = "", context: str = ""
) -> bool:
    """Record a piece of feedback. Anonymous is allowed — search is."""
    message = (message or "").strip()
    if not message:
        return False
    with _get_pool().connection() as conn:
        conn.execute(
            """INSERT INTO feedback (user_id, email, message, context)
               VALUES (%s,%s,%s,%s)""",
            (user_id, (email or "").strip()[:200] or None, message[:4000], (context or "")[:400]),
        )
        return True

# --- Skills ---------------------------------------------------------------

MAX_SKILLS = 40


def create_skill(
    user_id: str,
    name: str,
    description: str,
    instructions: str,
    team_id: int | None = None,
    shared: bool = False,
) -> dict | None:
    name = (name or "").strip()[:80]
    instructions = (instructions or "").strip()
    if not name or not instructions:
        return None
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        # A cap, because every skill offered to the agent costs prompt space
        # and makes choosing between them harder.
        n = conn.execute(
            "SELECT count(*) AS n FROM skills WHERE user_id = %s", (user_id,)
        ).fetchone()["n"]
        if n >= MAX_SKILLS:
            return None
        row = conn.execute(
            """INSERT INTO skills (user_id, team_id, name, description, instructions, shared)
               VALUES (%s,%s,%s,%s,%s,%s)
               RETURNING id, name, description, instructions, shared, team_id, updated_at""",
            (user_id, team_id, name, (description or "").strip()[:300],
             instructions[:4000], bool(shared and team_id)),
        ).fetchone()
    return _skill_row(row)


def _skill_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "instructions": row["instructions"],
        "shared": bool(row["shared"]),
        "team_id": row["team_id"],
        "updated_at": row["updated_at"].isoformat(),
    }


def list_skills(user_id: str, team_id: int | None = None) -> list[dict]:
    """This person's skills, plus any shared into the workspace they are in."""
    with _get_pool().connection() as conn:
        if team_id is None:
            rows = conn.execute(
                """SELECT id, name, description, instructions, shared, team_id, updated_at
                     FROM skills WHERE user_id = %s AND team_id IS NULL
                    ORDER BY updated_at DESC""",
                (user_id,),
            ).fetchall()
        else:
            _assert_member(conn, user_id, team_id)
            rows = conn.execute(
                """SELECT id, name, description, instructions, shared, team_id, updated_at
                     FROM skills
                    WHERE (user_id = %s AND team_id IS NULL)
                       OR (team_id = %s AND (shared OR user_id = %s))
                    ORDER BY shared DESC, updated_at DESC""",
                (user_id, team_id, user_id),
            ).fetchall()
    return [_skill_row(r) for r in rows]


def get_skill(user_id: str, skill_id: int, team_id: int | None = None) -> dict | None:
    """One skill, if this person may use it — their own, or shared to them."""
    with _get_pool().connection() as conn:
        row = conn.execute(
            """SELECT s.id, s.name, s.description, s.instructions, s.shared,
                      s.team_id, s.updated_at
                 FROM skills s
                WHERE s.id = %s
                  AND (s.user_id = %s
                       OR (s.shared AND s.team_id IS NOT NULL AND EXISTS (
                             SELECT 1 FROM team_members m
                              WHERE m.team_id = s.team_id AND m.user_id = %s)))""",
            (skill_id, user_id, user_id),
        ).fetchone()
    return _skill_row(row) if row else None


def update_skill(user_id: str, skill_id: int, **fields) -> bool:
    """Edit a skill. Only its author may; sharing does not grant editing."""
    allowed = {"name", "description", "instructions", "shared"}
    sets = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not sets:
        return False
    assignments = ", ".join(f"{k} = %s" for k in sets)
    with _get_pool().connection() as conn:
        cur = conn.execute(
            f"UPDATE skills SET {assignments}, updated_at = now()"
            " WHERE id = %s AND user_id = %s",
            [*sets.values(), skill_id, user_id],
        )
        return cur.rowcount > 0


def delete_skill(user_id: str, skill_id: int) -> bool:
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM skills WHERE id = %s AND user_id = %s", (skill_id, user_id)
        )
        return cur.rowcount > 0

# --- Experiment records ---------------------------------------------------


def _record_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "kind": row["kind"] or "experiment",
        "happened_on": row["happened_on"].isoformat() if row["happened_on"] else "",
        "aim": row["aim"] or "",
        "method": row["method"] or "",
        "result": row["result"] or "",
        "paper_ids": list(row["paper_ids"] or []),
        "updated_at": row["updated_at"].isoformat(),
    }


_RECORD_COLS = ("id, title, kind, happened_on, aim, method, result, paper_ids, updated_at")


def create_record(user_id: str, team_id: int | None = None, **f) -> dict | None:
    title = (f.get("title") or "").strip()[:200]
    if not title:
        return None
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        row = conn.execute(
            f"""INSERT INTO records
                  (user_id, team_id, title, kind, happened_on, aim, method, result, paper_ids)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING {_RECORD_COLS}""",
            (user_id, team_id, title, (f.get("kind") or "experiment")[:30],
             f.get("happened_on") or None, (f.get("aim") or "")[:4000],
             (f.get("method") or "")[:8000], (f.get("result") or "")[:8000],
             json.dumps([int(i) for i in (f.get("paper_ids") or [])])),
        ).fetchone()
    return _record_row(row)


def list_records(
    user_id: str, team_id: int | None = None, q: str | None = None, limit: int = 100
) -> list[dict]:
    clauses = ["(r.user_id = %s AND r.team_id IS NULL)" if team_id is None else "r.team_id = %s"]
    params: list = [user_id if team_id is None else team_id]
    if team_id is not None:
        with _get_pool().connection() as conn:
            _assert_member(conn, user_id, team_id)
    if q and q.strip():
        clauses.append(
            "(r.title ILIKE %s OR r.aim ILIKE %s OR r.method ILIKE %s OR r.result ILIKE %s)"
        )
        params += [_like_pattern(q.strip())] * 4
    params.append(limit)
    with _get_pool().connection() as conn:
        rows = conn.execute(
            f"""SELECT {_RECORD_COLS} FROM records r
                 WHERE {' AND '.join(clauses)}
                 ORDER BY r.happened_on DESC NULLS LAST, r.id DESC LIMIT %s""",
            params,
        ).fetchall()
    return [_record_row(r) for r in rows]


def update_record(user_id: str, record_id: int, **f) -> bool:
    allowed = {"title", "kind", "happened_on", "aim", "method", "result"}
    sets = {k: v for k, v in f.items() if k in allowed and v is not None}
    if "paper_ids" in f and f["paper_ids"] is not None:
        sets["paper_ids"] = json.dumps([int(i) for i in f["paper_ids"]])
    if not sets:
        return False
    assignments = ", ".join(f"{k} = %s" for k in sets)
    with _get_pool().connection() as conn:
        cur = conn.execute(
            f"UPDATE records SET {assignments}, updated_at = now()"
            " WHERE id = %s AND user_id = %s",
            [*sets.values(), record_id, user_id],
        )
        return cur.rowcount > 0


def delete_record(user_id: str, record_id: int) -> bool:
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM records WHERE id = %s AND user_id = %s", (record_id, user_id)
        )
        return cur.rowcount > 0


# --- Custom assistants ----------------------------------------------------

VALID_TOOLSETS = ("library", "records", "writing")
MAX_ASSISTANTS = 20


def _assistant_row(row: dict) -> dict:
    return {
        "id": f"custom:{row['id']}",
        "name": row["name"],
        "description": row["description"] or "",
        "instructions": row["instructions"],
        "toolsets": list(row["toolsets"] or []),
        "shared": bool(row["shared"]),
        "team_id": row["team_id"],
        "builtin": False,
    }


def create_assistant(
    user_id: str, name: str, description: str, instructions: str,
    toolsets: list[str], team_id: int | None = None, shared: bool = False,
) -> dict | None:
    name = (name or "").strip()[:80]
    instructions = (instructions or "").strip()[:4000]
    picked = [t for t in (toolsets or []) if t in VALID_TOOLSETS] or ["library"]
    if not name or not instructions:
        return None
    with _get_pool().connection() as conn:
        _assert_member(conn, user_id, team_id)
        n = conn.execute(
            "SELECT count(*) AS n FROM assistants WHERE user_id = %s", (user_id,)
        ).fetchone()["n"]
        if n >= MAX_ASSISTANTS:
            return None
        row = conn.execute(
            """INSERT INTO assistants
                 (user_id, team_id, name, description, instructions, toolsets, shared)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               RETURNING id, name, description, instructions, toolsets, shared, team_id""",
            (user_id, team_id, name, (description or "").strip()[:300], instructions,
             json.dumps(picked), bool(shared and team_id)),
        ).fetchone()
    return _assistant_row(row)


def list_assistants(user_id: str, team_id: int | None = None) -> list[dict]:
    with _get_pool().connection() as conn:
        if team_id is None:
            rows = conn.execute(
                """SELECT id, name, description, instructions, toolsets, shared, team_id
                     FROM assistants WHERE user_id = %s AND team_id IS NULL
                    ORDER BY updated_at DESC""",
                (user_id,),
            ).fetchall()
        else:
            _assert_member(conn, user_id, team_id)
            rows = conn.execute(
                """SELECT id, name, description, instructions, toolsets, shared, team_id
                     FROM assistants
                    WHERE (user_id = %s AND team_id IS NULL)
                       OR (team_id = %s AND (shared OR user_id = %s))
                    ORDER BY shared DESC, updated_at DESC""",
                (user_id, team_id, user_id),
            ).fetchall()
    return [_assistant_row(r) for r in rows]


def get_assistant(user_id: str, assistant_id: int) -> dict | None:
    with _get_pool().connection() as conn:
        row = conn.execute(
            """SELECT a.id, a.name, a.description, a.instructions, a.toolsets,
                      a.shared, a.team_id
                 FROM assistants a
                WHERE a.id = %s
                  AND (a.user_id = %s
                       OR (a.shared AND a.team_id IS NOT NULL AND EXISTS (
                             SELECT 1 FROM team_members m
                              WHERE m.team_id = a.team_id AND m.user_id = %s)))""",
            (assistant_id, user_id, user_id),
        ).fetchone()
    return _assistant_row(row) if row else None


def update_assistant(user_id: str, assistant_id: int, **fields) -> bool:
    allowed = {"name", "description", "instructions", "shared"}
    sets = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if fields.get("toolsets"):
        picked = [t for t in fields["toolsets"] if t in VALID_TOOLSETS]
        if picked:
            sets["toolsets"] = json.dumps(picked)
    if not sets:
        return False
    assignments = ", ".join(f"{k} = %s" for k in sets)
    with _get_pool().connection() as conn:
        cur = conn.execute(
            f"UPDATE assistants SET {assignments}, updated_at = now()"
            " WHERE id = %s AND user_id = %s",
            [*sets.values(), assistant_id, user_id],
        )
        return cur.rowcount > 0


def delete_assistant(user_id: str, assistant_id: int) -> bool:
    with _get_pool().connection() as conn:
        cur = conn.execute(
            "DELETE FROM assistants WHERE id = %s AND user_id = %s",
            (assistant_id, user_id),
        )
        return cur.rowcount > 0
