"""In-memory store for multi-turn research conversations.

A session holds the accumulated papers (WITH abstracts — server-side only, never
serialized to the client) plus the running message history, so follow-up turns
can cite the growing corpus without ever exposing verbatim abstracts.

This is intentionally in-memory and ephemeral: it resets on redeploy and is
scoped to a single process (fine for the free-tier single-instance MVP). Moving
to real multi-user/multi-instance later means backing this with a shared store.
"""
from __future__ import annotations

import uuid
from collections import OrderedDict
from time import time
from typing import Optional

from .models import Paper

# Bounds to keep memory sane for a long-running single instance.
_MAX_SESSIONS = 200
_MAX_CORPUS = 40  # cap accumulated papers per session (keeps synth prompt bounded)
_MAX_HISTORY = 12  # cap stored messages per session

_sessions: "OrderedDict[str, dict]" = OrderedDict()


def create_session(
    papers: list[Paper],
    messages: list[dict],
    lang: str,
    include_preprints: bool = True,
    sources: list[str] | None = None,
) -> str:
    """Start a session seeded with the initial search's papers + first exchange."""
    session_id = uuid.uuid4().hex
    _sessions[session_id] = {
        "papers": list(papers),
        "messages": list(messages),
        "lang": lang,
        "include_preprints": include_preprints,
        # Follow-up searches stay within the databases the reader chose.
        "sources": sources,
        "updated": time(),
    }
    _sessions.move_to_end(session_id)
    while len(_sessions) > _MAX_SESSIONS:
        _sessions.popitem(last=False)  # evict least-recently-used
    return session_id


def get_session(session_id: str) -> Optional[dict]:
    sess = _sessions.get(session_id)
    if sess is not None:
        _sessions.move_to_end(session_id)
    return sess


def _dedup_keys(papers: list[Paper]) -> set[str]:
    return {p.dedup_key() for p in papers}


def add_papers(session_id: str, new_papers: list[Paper]) -> list[Paper]:
    """Append papers not already present; return the ones actually added."""
    sess = _sessions.get(session_id)
    if sess is None:
        return []
    existing = _dedup_keys(sess["papers"])
    added: list[Paper] = []
    for p in new_papers:
        key = p.dedup_key()
        if key not in existing:
            existing.add(key)
            sess["papers"].append(p)
            added.append(p)
    # Keep the corpus bounded, preferring the most recently added papers.
    if len(sess["papers"]) > _MAX_CORPUS:
        sess["papers"] = sess["papers"][-_MAX_CORPUS:]
    sess["updated"] = time()
    return added


def add_message(session_id: str, role: str, content: str) -> None:
    sess = _sessions.get(session_id)
    if sess is None:
        return
    sess["messages"].append({"role": role, "content": content})
    if len(sess["messages"]) > _MAX_HISTORY:
        sess["messages"] = sess["messages"][-_MAX_HISTORY:]
    sess["updated"] = time()
