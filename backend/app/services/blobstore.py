"""Uploaded files, kept in Supabase Storage rather than a database column.

Files were living in a BYTEA column, which worked while uploads were something
a reader did occasionally. It stops working the moment anyone imports a
reference library: a few hundred papers with attachments is gigabytes, against
a free tier that measures the whole database in hundreds of megabytes. Storage
is sized and priced for files; Postgres is not.

Every function here is best-effort by design. Storage being unreachable, or
simply unconfigured, must never lose an upload or fail a request — the caller
falls back to the database column, which still works and is merely expensive.
That fallback is also what makes this deployable before the service key is set.
"""
from __future__ import annotations

import httpx

from ..config import (
    SUPABASE_BUCKET,
    SUPABASE_SERVICE_KEY,
    SUPABASE_URL,
    has_blob_storage,
)

# Generous: a 25MB PDF over a slow uplink is normal, and a timeout here costs
# the upload a fallback into Postgres rather than an error.
_TIMEOUT = httpx.Timeout(90.0, connect=10.0)

_bucket_checked = False


def enabled() -> bool:
    return has_blob_storage()


def _headers() -> dict:
    return {"Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"}


def _url(*parts: str) -> str:
    return "/".join([SUPABASE_URL, "storage/v1", *parts])


def key_for(uid: str) -> str:
    """Where an upload's bytes live. The id is already unguessable."""
    return f"{uid}.pdf"


def ensure_bucket() -> bool:
    """Create the private bucket once per process. True if it should exist."""
    global _bucket_checked
    if not enabled():
        return False
    if _bucket_checked:
        return True
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(
                _url("bucket"),
                headers=_headers(),
                json={
                    "id": SUPABASE_BUCKET,
                    "name": SUPABASE_BUCKET,
                    # Private. Files are served through the app, which checks
                    # who is asking; a public bucket would make every upload
                    # readable by anyone who learned its URL.
                    "public": False,
                },
            )
        # 409 is "already there", which is the normal case after the first run.
        if resp.status_code in (200, 201, 409):
            _bucket_checked = True
            return True
    except Exception:  # noqa: BLE001 - caller falls back to the database
        return False
    return False


def put(uid: str, data: bytes) -> str | None:
    """Store bytes. Returns the storage key, or None if it did not land."""
    if not ensure_bucket():
        return None
    key = key_for(uid)
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            url = _url("object", SUPABASE_BUCKET, key)
            headers = {**_headers(), "Content-Type": "application/pdf"}
            resp = client.post(url, headers=headers, content=data)
            if resp.status_code == 409:
                # Already there under this key — same id, same bytes. Replace
                # rather than fail, so a retried upload converges.
                resp = client.put(url, headers=headers, content=data)
        return key if resp.status_code in (200, 201) else None
    except Exception:  # noqa: BLE001
        return None


def get(key: str) -> bytes | None:
    """The stored bytes, or None when they are gone or unreachable."""
    if not enabled() or not key:
        return None
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.get(
                _url("object", SUPABASE_BUCKET, key), headers=_headers()
            )
        return resp.content if resp.status_code == 200 else None
    except Exception:  # noqa: BLE001
        return None


def delete(keys: list[str]) -> int:
    """Remove stored files. Returns how many the server reported deleting."""
    keys = [k for k in keys if k]
    if not enabled() or not keys:
        return 0
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.request(
                "DELETE",
                _url("object", SUPABASE_BUCKET),
                headers={**_headers(), "Content-Type": "application/json"},
                json={"prefixes": keys},
            )
        if resp.status_code != 200:
            return 0
        body = resp.json()
        return len(body) if isinstance(body, list) else len(keys)
    except Exception:  # noqa: BLE001
        return 0
