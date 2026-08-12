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

import re
import secrets
import tempfile
from collections import Counter, OrderedDict
from pathlib import Path
from time import monotonic

import pypdfium2 as pdfium

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


def _title_from(meta_title: str, blocks: list[dict]) -> str:
    title = (meta_title or "").strip()
    if 8 < len(title) < 300 and not title.lower().endswith(".pdf"):
        return title
    # Otherwise the first substantial line is nearly always the title.
    for b in blocks[:6]:
        if 15 < len(b["text"]) < 300:
            return b["text"]
    return "Uploaded PDF"


def save(data: bytes) -> dict:
    """Store an uploaded PDF and return what the reader needs to show it.

    Raises ValueError when the bytes are not a usable PDF.
    """
    if not data.startswith(b"%PDF-"):
        raise ValueError("not a PDF")
    if len(data) > MAX_BYTES:
        raise ValueError("file too large")

    _DIR.mkdir(parents=True, exist_ok=True)
    uid = secrets.token_hex(16)  # unguessable: the id is the only credential
    path = _DIR / f"{uid}.pdf"
    path.write_bytes(data)

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
        meta_title = str((doc.get_metadata_dict() or {}).get("Title", "") or "")
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
    }
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
    return None


def file_bytes(uid: str) -> bytes | None:
    record = get(uid)
    return Path(record["path"]).read_bytes() if record else None
