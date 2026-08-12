"""Reading a PDF the user already has.

Most biomedical PDFs cannot be fetched by a server: publishers and PMC alike
answer automated requests with a bot check. A reader with institutional access
has the file anyway, so they can hand it over and 精读模式 works on anything —
including the PDF pane, which finally displays, because the bytes are ours.

A PDF carries no structure, only positioned glyphs. Turning it back into
readable blocks is guesswork, and the guesses here are deliberately
conservative: running heads are dropped only when they actually repeat across
pages, and a line is called a heading only when it looks like nothing else.
Getting it wrong costs the reader a paragraph break, never a paragraph.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import tempfile
from collections import Counter, OrderedDict
from pathlib import Path
from time import monotonic, time

import pypdfium2 as pdfium

from .. import db
from ..config import DATABASE_URL, SUPABASE_JWT_SECRET, has_db

_DIR = Path(tempfile.gettempdir()) / "gaze-uploads"
_INDEX: "OrderedDict[str, dict]" = OrderedDict()
_TTL = 12 * 3600.0
_MAX_FILES = 40
MAX_BYTES = 25 * 1024 * 1024


def _sweep() -> None:
    """Drop expired uploads, and the least recent once there are too many."""
    now = monotonic()
    for uid in [u for u, r in _INDEX.items() if now - r["stamp"] > _TTL]:
        _forget(uid)
    while len(_INDEX) > _MAX_FILES:
        _forget(next(iter(_INDEX)))


def _forget(uid: str) -> None:
    record = _INDEX.pop(uid, None)
    if record:
        Path(record["path"]).unlink(missing_ok=True)


# A line that is really a running head, a page number, or a DOI stamp — the
# furniture a journal prints on every page and no one reads.
_PAGE_NOISE = re.compile(
    r"^(page\s*)?\d{1,4}$|^\d+\s*of\s*\d+$|^doi:|^https?://\S+$|^downloaded from",
    re.I,
)
# Words split across a line break: "neuro-\nprotection".
_HYPHEN_BREAK = re.compile(r"(\w)-\n(\w)")


def _looks_like_heading(line: str) -> bool:
    words = line.split()
    if not (1 <= len(words) <= 12) or len(line) > 90:
        return False
    # A heading never trails a comma or semicolon. The exception for lines
    # starting with a digit is only for the full stop in "3.1 Methods" — it let
    # "14 days, followed by continued HFD feeding..." through as a heading.
    if line.endswith((",", ";", ":")):
        return False
    if line.endswith(".") and not re.match(r"^\d+(\.\d+)*\.?$", line.split()[0]):
        return False
    if re.match(r"^\d+(\.\d+)*\.?\s+\S", line):  # "3.1 Delivery vectors"
        return True
    if line.isupper() and len(line) > 3:
        return True
    letters = [c for c in line if c.isalpha()]
    if not letters:
        return False
    # Figure panel labels ("D E", "B C") are capitals separated by spaces and
    # look exactly like a Title Case heading. Real headings have real words.
    if sum(1 for w in words if len(w) <= 2) > len(words) / 2:
        return False
    # Title Case, and not a sentence fragment that merely starts a paragraph.
    capitals = sum(1 for w in words if w[:1].isupper())
    return capitals >= max(2, len(words) - 1) and not line.endswith(".")


# A running head usually carries the page number, so the literal strings never
# repeat — "4 Cell Metabolism 37, 1-17" and "6 Cell Metabolism 37, 1-17" are the
# same furniture. Compare with the digits masked out.
def _repeat_key(line: str) -> str:
    return re.sub(r"\d+", "#", line)


def _running_heads(pages: list[str]) -> set[str]:
    """Lines repeated on most pages: the journal's furniture, not the paper."""
    if len(pages) < 3:
        return set()
    seen: Counter[str] = Counter()
    for text in pages:
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        for line in lines[:3] + lines[-3:]:
            if 3 < len(line) < 120:
                seen[_repeat_key(line)] += 1
    threshold = max(3, int(len(pages) * 0.25))
    return {key for key, n in seen.items() if n >= threshold}


def _blocks_from_pages(pages: list[str]) -> list[dict]:
    noise = _running_heads(pages)
    blocks: list[dict] = []
    buffer: list[str] = []

    def flush() -> None:
        if not buffer:
            return
        text = re.sub(r"\s+", " ", " ".join(buffer)).strip()
        if len(text) > 1:
            blocks.append({"type": "p", "text": text})
        buffer.clear()

    for text in pages:
        text = _HYPHEN_BREAK.sub(r"\1\2", text)
        for raw in text.splitlines():
            line = raw.strip()
            if not line or _repeat_key(line) in noise or _PAGE_NOISE.match(line):
                flush()
                continue
            if _looks_like_heading(line):
                flush()
                blocks.append({"type": "heading", "text": line, "level": 1})
                continue
            buffer.append(line)
            # A line that ends a sentence and falls well short of the column
            # width is the end of a paragraph, not a wrap.
            if line.endswith(".") and len(line) < 60:
                flush()
        flush()
    flush()

    for i, b in enumerate(blocks):
        b["id"] = f"b{i}"
    return blocks


# A DOI as printed on a paper's first page. Deliberately only searched near the
# front: the reference list is full of other people's DOIs, and picking one of
# those would label the upload as an entirely different paper.
_DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"'<>,;]+", re.I)
_DOI_TRAILING = ".,;:)]}>\u3002\uff0c"


def _find_doi(pages: list[str], meta: dict | None = None) -> str:
    candidates = []
    for key in ("doi", "Subject", "Keywords"):
        value = (meta or {}).get(key)
        if value:
            candidates.append(str(value))
    candidates.extend(pages[:2])
    for text in candidates:
        found = _DOI.search(text or "")
        if found:
            return found.group(0).rstrip(_DOI_TRAILING)
    return ""


def _title_from(meta_title: str, blocks: list[dict]) -> str:
    title = (meta_title or "").strip()
    if 8 < len(title) < 300 and not title.lower().endswith(".pdf"):
        return title
    # Otherwise the first substantial line is nearly always the title.
    for b in blocks[:6]:
        if 15 < len(b["text"]) < 300:
            return b["text"]
    return "Uploaded PDF"


def _new_path() -> tuple[str, Path]:
    _DIR.mkdir(parents=True, exist_ok=True)
    uid = secrets.token_hex(16)  # unguessable: the id is the only credential
    return uid, _DIR / f"{uid}.pdf"


def _check_chunk(first: bool, chunk: bytes, written: int) -> None:
    if first and chunk[:5] != b"%PDF-":
        raise ValueError("not a PDF")
    if written > MAX_BYTES:
        raise ValueError("file too large")


def _finish(uid: str, path: Path) -> dict:
    """Extract text from a written file and build the record for the reader."""
    # PDFium rather than a pure-Python parser: a 24-page paper took 6.3s to
    # extract with pypdf locally and 143s on the deployed instance, whose CPU is
    # far slower. PDFium does the same work in 0.3s for the same text, and its
    # licence (Apache-2.0/BSD-3) is safe for a product you may sell, which
    # PyMuPDF's AGPL would not be.
    doc = None
    try:
        doc = pdfium.PdfDocument(str(path))
        pages = []
        for i in range(len(doc)):
            page = doc[i]
            textpage = page.get_textpage()
            pages.append(textpage.get_text_range() or "")
            textpage.close()
            page.close()
        meta = doc.get_metadata_dict() or {}
        meta_title = str(meta.get("Title", "") or "")
    except pdfium.PdfiumError as exc:
        path.unlink(missing_ok=True)
        raise ValueError("password-protected or damaged PDF") from exc
    except Exception as exc:  # noqa: BLE001
        path.unlink(missing_ok=True)
        raise ValueError("could not read this PDF") from exc
    finally:
        if doc is not None:
            doc.close()

    blocks = _blocks_from_pages(pages)
    text = "\n\n".join(b["text"] for b in blocks)
    if len(text) < 400:
        # A scanned PDF is images of text; without OCR there is nothing to read.
        path.unlink(missing_ok=True)
        raise ValueError("no selectable text — this looks like a scanned PDF")

    record = {
        "id": uid,
        "path": str(path),
        "stamp": monotonic(),
        "pages": len(pages),
        "blocks": blocks,
        "text": text,
        "title": _title_from(meta_title, blocks),
        # The identifier that lets us look the paper up properly, rather than
        # guessing its authors and journal out of the PDF's front matter.
        "doi": _find_doi(pages, meta),
        "card": None,  # filled once the DOI or title resolves
    }
    _INDEX[uid] = record
    _INDEX.move_to_end(uid)
    _sweep()
    return record


def save(source, user_id: str | None = None) -> dict:
    """Store an uploaded PDF from bytes or a readable file object."""
    uid, path = _new_path()
    try:
        if isinstance(source, (bytes, bytearray)):
            _check_chunk(True, bytes(source), len(source))
            path.write_bytes(source)
        else:
            written = 0
            with path.open("wb") as out:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    _check_chunk(written == len(chunk), chunk, written)
                    out.write(chunk)
            if written == 0:
                raise ValueError("empty file")
    except ValueError:
        path.unlink(missing_ok=True)
        raise
    return _finish(uid, path)


async def save_stream(chunks) -> dict:
    """Store an uploaded PDF straight from the request body.

    The file arrives as the raw body rather than multipart/form-data because
    python-multipart parses the whole payload in Python, which costs seconds of
    the reader's time for an 8MB paper on a slow instance. Nothing is gained by
    it here: there is exactly one field.
    """
    uid, path = _new_path()
    written = 0
    try:
        with path.open("wb") as out:
            async for chunk in chunks:
                if not chunk:
                    continue
                written += len(chunk)
                _check_chunk(written == len(chunk), chunk, written)
                out.write(chunk)
        if written == 0:
            raise ValueError("empty file")
    except ValueError:
        path.unlink(missing_ok=True)
        raise
    return _finish(uid, path)


def owner_of(uid: str) -> str | None:
    """Who uploaded this file, or None if nobody was signed in."""
    if not has_db():
        return None
    try:
        return db.upload_owner(uid)
    except Exception:  # noqa: BLE001
        return None


def may_read(uid: str, user_id: str | None) -> bool:
    """Whether this requester may read this upload.

    An upload made while signed out has no owner and stays reachable by its
    unguessable id — that is the only way an anonymous reader could ever get
    back to their own file. An upload with an owner is theirs alone.
    """
    owner = owner_of(uid)
    return owner is None or owner == user_id


# The PDF pane is an <iframe>, and a frame cannot send an Authorization header,
# so the JWT that protects every other route is unavailable there. Instead the
# article response — which IS authenticated — hands out a short-lived grant tied
# to that one file, signed with a server secret. The reader's frame carries it;
# a stranger with the id alone cannot mint one.
_GRANT_TTL = 6 * 3600


def _grant_secret() -> bytes:
    seed = SUPABASE_JWT_SECRET or DATABASE_URL or "gaze-local-only"
    return hashlib.sha256(f"gaze-upload-grant:{seed}".encode()).digest()


def make_grant(uid: str, ttl: int = _GRANT_TTL) -> str:
    expiry = int(time()) + ttl
    payload = f"{uid}:{expiry}".encode()
    sig = hmac.new(_grant_secret(), payload, hashlib.sha256).hexdigest()[:32]
    return f"{expiry}.{sig}"


def check_grant(uid: str, grant: str) -> bool:
    try:
        expiry_s, sig = (grant or "").split(".", 1)
        expiry = int(expiry_s)
    except (ValueError, AttributeError):
        return False
    if expiry < time():
        return False
    expected = hmac.new(
        _grant_secret(), f"{uid}:{expiry}".encode(), hashlib.sha256
    ).hexdigest()[:32]
    return hmac.compare_digest(expected, sig)


def persist(record: dict, user_id: str | None) -> None:
    """Write an upload to the database, off the request's critical path.

    The local copy is only a cache: the instance's filesystem is wiped on every
    restart — routine on a free tier — and an upload that disappears minutes
    after the reader opened it is worse than one that never worked. Writing 8MB
    to Postgres costs seconds, though, and the reader is served from the cache
    either way, so it happens after the response. The exposure is a crash in
    those few seconds, which costs a re-upload rather than a wrong answer.
    """
    if not has_db():
        return
    try:
        db.put_upload(record, Path(record["path"]).read_bytes(), user_id)
    except Exception:  # noqa: BLE001 - the reader still works this session
        pass


def _rehydrate(uid: str) -> dict | None:
    """Pull an upload back from the database after a restart."""
    if not has_db():
        return None
    try:
        stored = db.get_upload(uid, with_data=True)
    except Exception:  # noqa: BLE001
        return None
    if stored is None:
        return None
    _DIR.mkdir(parents=True, exist_ok=True)
    path = _DIR / f"{uid}.pdf"
    path.write_bytes(stored.pop("data"))
    record = {**stored, "path": str(path), "stamp": monotonic()}
    _INDEX[uid] = record
    _INDEX.move_to_end(uid)
    _sweep()
    return record


def get(uid: str) -> dict | None:
    """The stored upload, or None once it has expired or was never there."""
    _sweep()
    record = _INDEX.get(uid)
    if record and Path(record["path"]).exists():
        _INDEX.move_to_end(uid)
        return record
    _INDEX.pop(uid, None)
    return _rehydrate(uid)


def file_bytes(uid: str) -> bytes | None:
    record = get(uid)
    return Path(record["path"]).read_bytes() if record else None
