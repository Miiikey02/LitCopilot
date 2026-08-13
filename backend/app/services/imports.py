"""Reading a reference library exported from somewhere else.

Every reference manager exports the same handful of formats, so parsing files
covers EndNote, Zotero, Mendeley, PubMed, Web of Science and Scopus without a
single API integration or OAuth flow. Five parsers is the whole surface:

  RIS (.ris)        the lingua franca — Zotero, Mendeley, Scopus, WoS
  EndNote (.enw)    EndNote's own tagged flavour of the same idea
  MEDLINE (.nbib)   what PubMed's "Send to → Citation manager" produces
  EndNote XML       what EndNote produces when asked for XML
  CSL-JSON (.json)  Zotero's other export, and the cleanest of them

They are parsed leniently on purpose. A real exported library is not clean: it
has records with no year, authors written five different ways, DOIs with a
`https://doi.org/` glued on, and abstracts containing the delimiter. A parser
that rejects a file because record 200 of 300 is malformed has failed the user
in the way that matters — losing 299 good references to punish one bad one. So
anything unreadable is skipped and counted, never fatal.

What comes out is deliberately thin: enough to identify the paper, not to
describe it. A DOI or PMID is worth more than every other field combined,
because it lets the paper be looked up properly rather than believed.
"""
from __future__ import annotations

import asyncio
import json
import re
from xml.etree import ElementTree

# A DOI wherever it is hiding: bare, prefixed with doi:, or as a URL.
_DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"'<>,;\]]+", re.I)
_DOI_TRAILING = ".,;:)]}>"


def _clean_doi(value: str) -> str:
    found = _DOI.search(value or "")
    return found.group(0).rstrip(_DOI_TRAILING).lower() if found else ""


def _year(value: str) -> int | None:
    """The first plausible publication year in a date written any which way."""
    for token in re.findall(r"\b(1[5-9]\d{2}|20\d{2})\b", str(value or "")):
        return int(token)
    return None


def _tidy(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").replace(" ", " ")).strip()


# A name that belongs to a body rather than a person. Reordering "WHO Study
# Group" into "Group, WHO Study" makes it unrecognisable, and consortium
# authorship is common enough in biomedicine to be worth detecting.
_ORGANISATION = re.compile(
    r"(?i)\b(group|consortium|committee|society|network|collaborati\w+|"
    r"team|initiative|investigators|working|association|institute|"
    r"organi[sz]ation|trial|project)\b"
)
# "Almasieh M" and "Karigo TT" — PubMed's surname-then-initials form.
_INITIALS = re.compile(r"^(.+?)\s+([A-Z]{1,3})$")


def _person(name: str) -> str:
    """Normalise one author to "Family, Given" without inventing anything."""
    name = _tidy(name).rstrip(".,;")
    if not name:
        return ""
    if "," in name:
        return name
    if _ORGANISATION.search(name):
        return name
    initials = _INITIALS.match(name)
    if initials:
        return f"{initials.group(1)}, {initials.group(2)}"
    # "John Smith" -> "Smith, John". A single token is left alone: it is a
    # surname on its own, or a body's acronym, and either way has no halves.
    parts = name.split()
    return f"{parts[-1]}, {' '.join(parts[:-1])}" if len(parts) > 1 else name


def _entry(**kw) -> dict:
    """One parsed reference, with every field present and normalised."""
    return {
        "title": _tidy(kw.get("title", "")),
        "authors": [a for a in (_person(x) for x in kw.get("authors") or []) if a],
        "year": kw.get("year"),
        "venue": _tidy(kw.get("venue", "")),
        "doi": _clean_doi(kw.get("doi", "")),
        "pmid": _tidy(kw.get("pmid", "")),
        "url": _tidy(kw.get("url", "")),
    }


def _usable(entry: dict) -> bool:
    """Enough to look the paper up, or at least to show the user what it is."""
    return bool(entry["doi"] or entry["pmid"] or len(entry["title"]) > 8)


# --- RIS, and EndNote's .enw, which is the same shape with different tags ---

_RIS_LINE = re.compile(r"^([A-Z][A-Z0-9])  - ?(.*)$")
_ENW_LINE = re.compile(r"^%([A-Z0-9?])\s*(.*)$", re.I)

_RIS_FIELDS = {
    "TI": "title", "T1": "title", "CT": "title",
    "AU": "author", "A1": "author", "A2": "author",
    "PY": "year", "Y1": "year", "DA": "year",
    "JO": "venue", "JF": "venue", "JA": "venue", "T2": "venue", "SO": "venue",
    "DO": "doi", "DI": "doi",
    "UR": "url", "L3": "url",
    "AN": "accession",
}
_ENW_FIELDS = {
    "T": "title", "A": "author", "D": "year", "J": "venue",
    "R": "doi", "U": "url", "M": "accession",
}


def _from_tagged(text: str, pattern: re.Pattern, fields: dict, end: str) -> list[dict]:
    """RIS and .enw share a structure: tagged lines, records ended by a marker."""
    out: list[dict] = []
    current: dict = {}
    authors: list[str] = []
    last_key = ""

    def flush() -> None:
        nonlocal current, authors, last_key
        if current or authors:
            entry = _entry(
                title=current.get("title", ""),
                authors=authors,
                year=_year(current.get("year", "")),
                venue=current.get("venue", ""),
                doi=current.get("doi", "") or current.get("url", ""),
                pmid=_pmid_from(current),
                url=current.get("url", ""),
            )
            if _usable(entry):
                out.append(entry)
        current, authors, last_key = {}, [], ""

    for raw in text.splitlines():
        line = raw.rstrip()
        match = pattern.match(line)
        if not match:
            # A wrapped continuation of the previous field, which is how long
            # titles and abstracts are exported.
            if last_key and line.strip() and last_key in current:
                current[last_key] += " " + line.strip()
            continue
        tag, value = match.group(1), match.group(2).strip()
        if tag == end:
            flush()
            last_key = ""
            continue
        key = fields.get(tag)
        if key == "author":
            authors.append(value)
            last_key = ""
        elif key:
            # First value wins: exports repeat JO/JF for the same journal, and
            # the first is the one the exporter considered primary.
            current.setdefault(key, value)
            last_key = key
    flush()
    return out


def _pmid_from(current: dict) -> str:
    """PubMed's id, which RIS carries in whichever field the exporter chose."""
    for key in ("accession", "url", "doi"):
        value = current.get(key, "")
        if not value:
            continue
        if re.fullmatch(r"\d{7,8}", value.strip()):
            return value.strip()
        found = re.search(r"pubmed(?:\.ncbi\.nlm\.nih\.gov)?/(\d{7,8})", value, re.I)
        if found:
            return found.group(1)
    return ""


def parse_ris(text: str) -> list[dict]:
    return _from_tagged(text, _RIS_LINE, _RIS_FIELDS, end="ER")


def parse_enw(text: str) -> list[dict]:
    # .enw separates records with a blank line rather than an end tag; turning
    # those into a sentinel lets one implementation serve both.
    marked = re.sub(r"\n\s*\n", "\n%Z end\n", text.strip() + "\n\n")
    return _from_tagged(marked, _ENW_LINE, {**_ENW_FIELDS, "Z": None}, end="Z")


# --- MEDLINE / .nbib, as PubMed exports it ---

_NBIB_LINE = re.compile(r"^([A-Z]{2,4})\s*- (.*)$")
_NBIB_FIELDS = {
    "TI": "title", "BTI": "title",
    "FAU": "author", "AU": "author",
    "DP": "year", "DEP": "year",
    "JT": "venue", "TA": "venue",
    "PMID": "pmid",
    "AID": "doi", "LID": "doi",
}


def parse_nbib(text: str) -> list[dict]:
    out: list[dict] = []
    current: dict = {}
    authors: list[str] = []
    full_authors: list[str] = []
    last_key = ""

    def flush() -> None:
        nonlocal current, authors, full_authors, last_key
        if current or authors or full_authors:
            entry = _entry(
                title=current.get("title", ""),
                # FAU is "Smith, John A" where AU is "Smith JA" — prefer the
                # one a person would recognise.
                authors=full_authors or authors,
                year=_year(current.get("year", "")),
                venue=current.get("venue", ""),
                doi=current.get("doi", ""),
                pmid=current.get("pmid", ""),
            )
            if _usable(entry):
                out.append(entry)
        current, authors, full_authors, last_key = {}, [], [], ""

    for raw in text.splitlines():
        if not raw.strip():
            flush()
            continue
        match = _NBIB_LINE.match(raw)
        if not match:
            if last_key and raw.startswith(" ") and last_key in current:
                current[last_key] += " " + raw.strip()
            continue
        tag, value = match.group(1), match.group(2).strip()
        key = _NBIB_FIELDS.get(tag)
        if tag == "FAU":
            full_authors.append(value)
        elif tag == "AU":
            authors.append(value)
        elif key == "doi":
            # AID carries several ids, each labelled: "10.1/x [doi]", "S1 [pii]"
            if "[doi]" in value.lower() or _clean_doi(value):
                current.setdefault("doi", value)
            last_key = ""
        elif key:
            current.setdefault(key, value)
            last_key = key
    flush()
    return out


# --- BibTeX ---

_BIB_ENTRY = re.compile(r"@(\w+)\s*\{(.*?)\n\s*\}\s*(?=@|\Z)", re.S)
_BIB_NAME = re.compile(r"(\w+)\s*=\s*")
_BIB_FIELDS = {
    "title": "title", "author": "author", "year": "year", "date": "year",
    "journal": "venue", "journaltitle": "venue", "booktitle": "venue",
    "doi": "doi", "url": "url", "pmid": "pmid", "eprint": "pmid",
}


def _debrace(value: str) -> str:
    value = value.strip().rstrip(",").strip()
    if value.startswith("{") and value.endswith("}"):
        value = value[1:-1]
    elif value.startswith('"') and value.endswith('"'):
        value = value[1:-1]
    # {\'e} and {Nature} alike: braces carry meaning to LaTeX, not to a reader.
    return _tidy(value.replace("{", "").replace("}", "").replace("\\&", "&"))


def _bib_fields(body: str) -> dict:
    """Split one entry into name/value pairs, counting braces as we go.

    A regex cannot do this: BibTeX nests braces to protect capitalisation and
    spell accents, so `{{CRISPR}/Cas9 ...}` ends at the *matching* brace, not
    the first one. A non-greedy match stopped after "CRISPR" and silently threw
    away the rest of every title that used the convention — which is most of
    them, since that is exactly what the convention is for.
    """
    fields: dict = {}
    i = 0
    while i < len(body):
        match = _BIB_NAME.search(body, i)
        if not match:
            break
        name = match.group(1).strip().lower()
        j = match.end()
        if j < len(body) and body[j] == "{":
            depth, start = 0, j
            while j < len(body):
                if body[j] == "{":
                    depth += 1
                elif body[j] == "}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            value = body[start:j]
        elif j < len(body) and body[j] == '"':
            end = body.find('"', j + 1)
            end = len(body) if end == -1 else end + 1
            value, j = body[j:end], end
        else:
            end = body.find(",", j)
            end = len(body) if end == -1 else end
            value, j = body[j:end], end
        fields.setdefault(name, _debrace(value))
        i = max(j, match.end())
    return fields


def parse_bibtex(text: str) -> list[dict]:
    out: list[dict] = []
    for _kind, body in _BIB_ENTRY.findall(text):
        fields: dict = {}
        for name, value in _bib_fields(body).items():
            key = _BIB_FIELDS.get(name)
            if key and key not in fields:
                fields[key] = value
        authors = [a for a in re.split(r"\s+and\s+", fields.get("author", "")) if a.strip()]
        entry = _entry(
            title=fields.get("title", ""),
            authors=authors,
            year=_year(fields.get("year", "")),
            venue=fields.get("venue", ""),
            doi=fields.get("doi", "") or fields.get("url", ""),
            pmid=fields.get("pmid", "") if fields.get("pmid", "").isdigit() else "",
            url=fields.get("url", ""),
        )
        if _usable(entry):
            out.append(entry)
    return out


# --- EndNote XML ---


def _xml_text(node, *paths: str) -> str:
    """EndNote wraps most text in <style> children, so read the whole subtree."""
    for path in paths:
        found = node.find(path)
        if found is not None:
            text = "".join(found.itertext())
            if text.strip():
                return text
    return ""


def parse_endnote_xml(text: str) -> list[dict]:
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return []
    out: list[dict] = []
    for record in root.iter("record"):
        authors = [
            "".join(a.itertext()).strip()
            for a in record.findall("./contributors/authors/author")
        ]
        doi = _xml_text(record, "./electronic-resource-num")
        urls = _xml_text(record, "./urls/related-urls/url", "./urls/web-urls/url")
        entry = _entry(
            title=_xml_text(record, "./titles/title"),
            authors=authors,
            year=_year(_xml_text(record, "./dates/year", "./dates/pub-dates/date")),
            venue=_xml_text(
                record, "./periodical/full-title", "./titles/secondary-title"
            ),
            doi=doi or urls,
            pmid=_tidy(_xml_text(record, "./accession-num")),
            url=urls,
        )
        if entry["pmid"] and not entry["pmid"].isdigit():
            entry["pmid"] = ""
        if _usable(entry):
            out.append(entry)
    return out


# --- CSL-JSON ---


def parse_csl_json(text: str) -> list[dict]:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if isinstance(data, dict):
        data = data.get("items") or [data]
    out: list[dict] = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        authors = []
        for person in item.get("author") or []:
            if isinstance(person, dict):
                family, given = person.get("family", ""), person.get("given", "")
                authors.append(f"{family}, {given}".strip(", ") if family else person.get("literal", ""))
            elif isinstance(person, str):
                authors.append(person)
        issued = (item.get("issued") or {}).get("date-parts") or [[]]
        year = issued[0][0] if issued and issued[0] else item.get("issued", {}).get("literal", "")
        entry = _entry(
            title=item.get("title", "") if isinstance(item.get("title"), str) else "",
            authors=authors,
            year=_year(year),
            venue=item.get("container-title", "") if isinstance(item.get("container-title"), str) else "",
            doi=item.get("DOI") or item.get("doi") or "",
            pmid=str(item.get("PMID") or item.get("pmid") or ""),
            url=item.get("URL") or "",
        )
        if _usable(entry):
            out.append(entry)
    return out


# --- Plain identifiers, pasted ---

_PMID_ONLY = re.compile(r"^\d{7,8}$")


def parse_identifiers(text: str) -> list[dict]:
    """A pasted list of DOIs and PMIDs, one per line or separated by commas."""
    out: list[dict] = []
    seen: set[str] = set()
    for token in re.split(r"[\s,;]+", text or ""):
        token = token.strip().strip("<>\"'")
        if not token:
            continue
        doi = _clean_doi(token)
        pmid = ""
        if not doi:
            bare = re.sub(r"(?i)^pmid:?\s*", "", token)
            if _PMID_ONLY.fullmatch(bare):
                pmid = bare
            else:
                found = re.search(r"pubmed(?:\.ncbi\.nlm\.nih\.gov)?/(\d{7,8})", token, re.I)
                pmid = found.group(1) if found else ""
        if not (doi or pmid):
            continue
        key = doi or pmid
        if key in seen:
            continue
        seen.add(key)
        out.append(_entry(doi=doi, pmid=pmid))
    return out


# --- Choosing a parser -----------------------------------------------------

PARSERS = {
    "ris": parse_ris,
    "enw": parse_enw,
    "nbib": parse_nbib,
    "bibtex": parse_bibtex,
    "endnote-xml": parse_endnote_xml,
    "csl-json": parse_csl_json,
    "identifiers": parse_identifiers,
}

_EXTENSIONS = {
    ".ris": "ris", ".txt": None, ".enw": "enw", ".nbib": "nbib", ".medline": "nbib",
    ".bib": "bibtex", ".bibtex": "bibtex", ".xml": "endnote-xml", ".json": "csl-json",
}


def sniff(text: str, filename: str = "") -> str:
    """Which format this is, by content first and file name second.

    Content wins because exports are routinely renamed, saved as .txt, or
    emailed with the extension stripped — and because these formats are easy to
    tell apart from their first few lines.
    """
    head = text.lstrip()[:4000]
    if not head:
        return ""
    if head.startswith("<") and "<record" in head.lower():
        return "endnote-xml"
    if head[:1] in "[{":
        return "csl-json"
    if re.search(r"^@\w+\s*\{", head, re.M):
        return "bibtex"
    if re.search(r"^TY  - ", head, re.M):
        return "ris"
    if re.search(r"^PMID\s*- ", head, re.M):
        return "nbib"
    if re.search(r"^%0 ", head, re.M):
        return "enw"
    # Tagged but unlabelled: RIS without its TY line still parses as RIS.
    if re.search(r"^[A-Z][A-Z0-9]  - ", head, re.M):
        return "ris"
    by_name = _EXTENSIONS.get("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else None
    if by_name:
        return by_name
    # Nothing structural left; if it looks like bare identifiers, treat it so.
    return "identifiers" if _DOI.search(head) or _PMID_ONLY.match(head.strip()) else ""


def parse(text: str, filename: str = "", fmt: str = "") -> tuple[list[dict], str]:
    """Parse a reference export. Returns (entries, format actually used)."""
    fmt = fmt or sniff(text, filename)
    parser = PARSERS.get(fmt)
    if not parser:
        return [], ""
    try:
        return parser(text), fmt
    except Exception:  # noqa: BLE001 - a broken file yields nothing, never a 500
        return [], fmt


def identifier_for(entry: dict) -> str:
    """What to look this reference up by, best identifier first.

    A DOI or PMID resolves to the real record; a title is a search that may
    return the wrong paper, so it is the last resort, not the first.
    """
    if entry.get("doi"):
        return entry["doi"]
    if entry.get("pmid"):
        return entry["pmid"]
    return entry.get("title", "")


async def run_job(
    entries: list[dict],
    resolve,
    store,
    progress,
    throttle: float = 0.34,
) -> dict:
    """Resolve and file every reference, reporting as it goes.

    `resolve(entry) -> card | None` looks one reference up; `store(card) ->
    "added" | "duplicate"` files it; `progress(counts)` is called after each.

    Paced deliberately. Every resolution is a call to PubMed or OpenAlex, and
    firing three hundred of them as fast as the loop allows earns a 429 and a
    half-imported library — the same rate limit that made the paper map
    intermittent. One at a time with a gap between is slower than it could be
    and finishes, which is the trade that matters for a job nobody watches.
    """
    counts = {"done": 0, "added": 0, "duplicates": 0, "failed": 0}
    for entry in entries:
        try:
            card = await resolve(entry)
            if card is None:
                counts["failed"] += 1
            elif store(card) == "duplicate":
                counts["duplicates"] += 1
            else:
                counts["added"] += 1
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - one bad reference is not the file
            counts["failed"] += 1
        counts["done"] += 1
        try:
            # A copy: the caller may keep what it is handed, and one shared
            # dict mutated in place would turn a progress log into five
            # identical final rows.
            progress(dict(counts))
        except Exception:  # noqa: BLE001 - reporting must not stop the work
            pass
        await asyncio.sleep(throttle)
    return counts


def fallback_card(entry: dict) -> dict:
    """A saveable record built from the file alone, when lookup finds nothing.

    Importing 300 references and silently dropping the 40 that no database
    recognises loses exactly the ones a lab is most likely to care about —
    theses, in-press papers, regional journals. Better to keep what the export
    said and mark where it came from.
    """
    return {
        "source": "import",
        "source_id": entry.get("doi") or entry.get("pmid") or entry.get("title", "")[:120],
        "title": entry.get("title", ""),
        "authors": entry.get("authors", []),
        "year": entry.get("year"),
        "venue": entry.get("venue", ""),
        "doi": entry.get("doi", ""),
        "url": entry.get("url", ""),
    }


def dedupe(entries: list[dict]) -> list[dict]:
    """Collapse repeats within one file, preferring the richer record.

    Exported libraries repeat: the same paper filed in two groups exports
    twice. Matching is by DOI, then PMID, then a normalised title — the same
    ladder used for search results, for the same reason.
    """
    best: dict[str, dict] = {}
    order: list[str] = []
    for entry in entries:
        key = (
            f"doi:{entry['doi']}" if entry["doi"]
            else f"pmid:{entry['pmid']}" if entry["pmid"]
            else "title:" + re.sub(r"[^a-z0-9]+", "", entry["title"].lower())[:80]
        )
        if key in best:
            kept = best[key]
            # Keep whichever record carries more of what we need.
            score = lambda e: (bool(e["doi"]), bool(e["pmid"]), len(e["authors"]), bool(e["year"]))
            if score(entry) > score(kept):
                best[key] = entry
        else:
            best[key] = entry
            order.append(key)
    return [best[k] for k in order]
