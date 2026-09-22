"""Folder watches: bring a folder the papers published in its field since last time.

A check is one PubMed search limited to what PubMed received since the last
check, minus anything the workspace already holds or was already offered,
screened by the model against what the folder actually contains. The screen
is the part that makes this usable: a keyword search for a field returns a
few dozen papers a week, and a list where half do not belong is a list people
stop opening.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from .. import db
from ..config import has_llm_key, redact
from . import llm_service
from .pubmed import search_pubmed

# How far back the first check looks. Long enough that a new watch shows
# something, short enough that what it shows is actually new.
FIRST_LOOK_DAYS = 30
# How much earlier than its interval a watch may run (see claim_due_watches).
SLACK_HOURS = 4
# The screen reads candidates in batches this size.
SCREEN_BATCH = 25
# A check covers everything since the last one, however long ago that was —
# someone back from two months away should find those two months, not the
# newest week of them. So how much is fetched scales with the gap, up to a
# ceiling that keeps one check bounded.
PER_WEEK = 40
MAX_FETCH = 300


def _window(prev: datetime | None) -> tuple[str, int]:
    """(start date for PubMed, how many days that covers)."""
    now = datetime.now(timezone.utc)
    # A day of overlap: PubMed's entry dates are days, not instants, and a
    # paper entered late on the day of the last check must not fall between.
    start = (prev - timedelta(days=1)) if prev else now - timedelta(days=FIRST_LOOK_DAYS)
    return start.strftime("%Y/%m/%d"), max(1, (now - start).days)


async def check(watch: dict) -> int:
    """Run one watch; returns how many new papers it filed as findings."""
    try:
        since, days = _window(watch.get("prev"))
        retmax = min(MAX_FETCH, PER_WEEK * -(-days // 7))
        term = f'({watch["query"]}) AND ("{since}"[EDAT] : "3000"[EDAT])'
        found = await search_pubmed(term, retmax=retmax, sort="date")
        known = await asyncio.to_thread(db.watch_known_keys, watch)
        fresh = [p for p in found if db.dedup_key(p.to_card()) not in known]
        if not fresh:
            await asyncio.to_thread(db.add_watch_hits, watch["id"], [])
            return 0

        ctx = await asyncio.to_thread(_folder_titles, watch["folder_id"])
        lang = watch.get("lang") or "zh"
        hits: list[tuple[dict, dict]] = []
        rejected: list[dict] = []
        for i in range(0, len(fresh), SCREEN_BATCH):
            batch = fresh[i : i + SCREEN_BATCH]
            if not has_llm_key():
                hits += [(p.to_card(), {}) for p in batch]
                continue
            try:
                kept = await llm_service.screen_new_papers(
                    ctx["name"], ctx["titles"], batch, lang
                )
            except Exception as exc:  # noqa: BLE001 - unscreened beats nothing
                print(redact(f"[watch {watch['id']}] screen failed: {exc}"))
                # Offered unscreened rather than dropped: in a catch-up these
                # papers will not come round again.
                hits += [(p.to_card(), {}) for p in batch]
                continue
            hits += [(batch[j].to_card(), meta) for j, meta in sorted(kept.items())]
            # Remembered, so the next check does not re-roll the verdict.
            rejected += [p.to_card() for j, p in enumerate(batch) if j not in kept]
        return await asyncio.to_thread(db.add_watch_hits, watch["id"], hits, rejected)
    except Exception as exc:  # noqa: BLE001 - one folder must not stop the rest
        msg = f"{type(exc).__name__}: {exc}"
        print(redact(f"[watch {watch['id']}] check failed: {msg}"))
        await asyncio.to_thread(db.set_watch_error, watch["id"], msg)
        raise


def _folder_titles(folder_id: int) -> dict:
    with db._get_pool().connection() as conn:
        name = conn.execute(
            "SELECT name FROM folders WHERE id = %s", (folder_id,)
        ).fetchone()
        rows = conn.execute(
            "SELECT title FROM saved_papers WHERE folder_id = %s "
            "ORDER BY created_at DESC LIMIT 15",
            (folder_id,),
        ).fetchall()
    return {"name": name["name"] if name else "", "titles": [r["title"] for r in rows]}


async def run_due() -> int:
    """Check every watch that is due. Returns how many were checked."""
    due = await asyncio.to_thread(db.claim_due_watches, SLACK_HOURS)
    for watch in due:
        try:
            await check(watch)
        except Exception:  # noqa: BLE001 - already recorded on the watch
            pass
        await asyncio.sleep(1)
    return len(due)


async def loop(every_seconds: int = 1800) -> None:
    """The background timer. Also nudged by people opening the library, since
    a sleeping instance has no timer running."""
    await asyncio.sleep(60)
    while True:
        try:
            await run_due()
        except Exception as exc:  # noqa: BLE001
            print(redact(f"[watch] loop error: {type(exc).__name__}: {exc}"))
        await asyncio.sleep(every_seconds)
