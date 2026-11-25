#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Intake triage: a tiny local server for triaging the assistant's intake files.

Stdlib only. Serves ./static and a JSON API that reads and rewrites
<vault>/agent/intake/YYYY-MM-DD-intake.md in place, then commits only the
touched path(s) in the vault's git repo.

Env:
  INTAKE_VAULT        vault root (default ~/vault)
  INTAKE_SUBDIR       intake dir inside the vault (default agent/intake)
  INTAKE_PORT         port (default 8766); always bound to 127.0.0.1
  INTAKE_GIT          "0" disables git commits (default on if the vault is a repo)
  INTAKE_GROQ_SECRET  "<sec file>:<KEY>" for the Whisper fallback
                      (default transcriber:GROQ_API_KEY)
  INTAKE_TRIGGER      script run as `<script> triage "<message>"` when the owner asks
                      the assistant a question (default ~/assistant/scripts/assistant-trigger.sh;
                      "0" disables)
  INTAKE_ADVISORY_LIVE "1" lets newtab advisories start real agent session
                      (default off: The assistant is told what it would launch)
  INTAKE_ADVISORY_CAP advisory sessions a day before the rest are AGENT-board issues
                      only (default 3)
  INTAKE_EDITION      where the newtab's latest Kobo morning edition is written
                      (default <vault>/agent/edition/current.md)
  Voice tier 2 (see voice.py): INTAKE_JEV_SECRET (default env:JEV_API_KEY),
  INTAKE_LLM_SECRET (default env:OPENROUTER_API_KEY), INTAKE_LLM_MODEL.
  INTAKE_TZ           IANA time zone for stamps and dates (default America/Los_Angeles)
  INTAKE_PROJECTS     project folders inside the vault, for advisories (default projects)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

import talk
import voice

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
STATE_DIR = HERE / ".state"

VAULT = Path(os.environ.get("INTAKE_VAULT", "~/vault")).expanduser().resolve()
SUBDIR = os.environ.get("INTAKE_SUBDIR", "agent/intake").strip("/")
INTAKE_DIR = VAULT / SUBDIR
PORT = int(os.environ.get("INTAKE_PORT", "8766"))
GIT_ENABLED = os.environ.get("INTAKE_GIT", "1") != "0"
GROQ_SECRET = os.environ.get("INTAKE_GROQ_SECRET", "env:GROQ_API_KEY")
TRIGGER = os.environ.get("INTAKE_TRIGGER", "~/assistant/scripts/assistant-trigger.sh")
# the owner's AI newtab extension: the one other origin allowed to embed the app and
# to send "comment for the assistant". An unpacked extension's id comes from its folder
# path, so set this if ~/tools/ai-newtab ever moves.
NEWTAB_ORIGIN = os.environ.get("INTAKE_NEWTAB_ORIGIN", "chrome-extension://komhiagljgdhghicimkkjjmnldebhmne")
INBOX_NAME = "triage-inbox.md"
# The latest Kobo morning edition, as markdown, so the assistant can resolve "headline 25"
# or "triage T3" from a voice note. Overwritten by each edition; no history kept.
EDITION_PATH = Path(os.environ.get("INTAKE_EDITION", str(VAULT / "agent" / "edition" / "current.md"))).expanduser()
# One undo stack per vault, so a test vault never shares history with the real one.
UNDO_FILE = STATE_DIR / f"undo-{__import__('hashlib').sha1(str(VAULT).encode()).hexdigest()[:10]}.json"

TZ = ZoneInfo(os.environ.get("INTAKE_TZ", "America/Los_Angeles"))
PROJECTS_DIR = os.environ.get("INTAKE_PROJECTS", "projects").strip("/")
SEP = " — "  # em dash with spaces: the field separator in intake lines
FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-intake\.md$")
ITEM_RE = re.compile(r"^(?P<indent>[ \t]*)- \[(?P<mark>[ xX])\] (?P<body>.*)$")
ORIGIN_RE = re.compile(r"^\[(\d{2})-(\d{2})\]\s*")
SNOOZE_RE = re.compile(r" — snoozed until (\d{4}-\d{2}-\d{2})")
BOARD_RE = re.compile(r"^(AGENT|ME|n/a)(?:\s*\((.*)\))?$", re.I)
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
DISPOSITION_RE = re.compile(r" — ((?:done|dropped) \(Me[^)]*\).*)$")
# Classification tag: the last token of the item's own text. Anything the app
# appends later (snooze marker, done/dropped note) goes after it.
# The phase tag: a standalone #action / #awareness token. It belongs at the end
# of the item's text, but anyone editing the line can push text after it, so a
# token anywhere counts (the last one wins) and set_tag removes every copy.
TAG_RE = re.compile(r"\s+#(action|awareness)(?![\w/-])", re.I)
TAG_ANY_RE = TAG_RE
NOTE_Q_RE = re.compile(r"^Me \(([^)]*)\)\s*\?\s*(.*)$")
NOTE_ASSISTANT_RE = re.compile(r"^Assistant \(([^)]*)\)\s*:?\s*(.*)$")
NOTE_ME_RE = re.compile(r"^Me \(([^)]*)\)\s*:\s*(.*)$")
RESOLVED_RE = re.compile(r"\blooks (?:resolved|done|handled)\b", re.I)

WRITE_LOCK = threading.Lock()


class Conflict(Exception):
    """The file no longer contains the line the client acted on."""


# ---------------------------------------------------------------- time


def now_pt() -> dt.datetime:
    return dt.datetime.now(TZ)


def stamp() -> str:
    return now_pt().strftime("%Y-%m-%d %H:%M PT")


def today_pt() -> dt.date:
    return now_pt().date()


# ---------------------------------------------------------------- files


def list_files() -> list[dict]:
    out = []
    if INTAKE_DIR.is_dir():
        for p in INTAKE_DIR.iterdir():
            m = FILE_RE.match(p.name)
            if m and p.is_file():
                out.append({"name": p.name, "date": m.group(1)})
    out.sort(key=lambda f: f["date"], reverse=True)
    return out


def resolve_file(name: str) -> Path:
    if not name or not FILE_RE.match(name):
        raise ValueError(f"not an intake file name: {name!r}")
    p = INTAKE_DIR / name
    if not p.is_file():
        raise FileNotFoundError(name)
    return p


def read_text(p: Path) -> str:
    # newline="" keeps \r\n (if any) so untouched lines round-trip byte-exact.
    with open(p, encoding="utf-8", newline="") as f:
        return f.read()


def write_text_atomic(p: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=f".{p.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        try:
            os.chmod(tmp, os.stat(p).st_mode & 0o777)
        except FileNotFoundError:
            pass
        os.replace(tmp, p)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def split_lines(text: str) -> tuple[list[str], str]:
    """Split keeping the exact newline style. Returns (lines, newline)."""
    nl = "\r\n" if "\r\n" in text else "\n"
    return text.split(nl), nl


# ---------------------------------------------------------------- parsing


def origin_date(mm: int, dd: int, file_date: dt.date) -> dt.date:
    try:
        d = dt.date(file_date.year, mm, dd)
    except ValueError:
        return file_date
    if d > file_date:  # e.g. a [12-30] line carried into a January file
        d = dt.date(file_date.year - 1, mm, dd)
    return d


def parse_body(body: str, file_date: dt.date) -> dict:
    rest = body
    origin = file_date
    origin_tag = None
    m = ORIGIN_RE.match(rest)
    if m:
        origin_tag = f"{m.group(1)}-{m.group(2)}"
        origin = origin_date(int(m.group(1)), int(m.group(2)), file_date)
        rest = rest[m.end():]

    disposition = None
    dm = DISPOSITION_RE.search(rest)
    if dm:
        disposition = dm.group(1)
        rest = rest[: dm.start()]

    snoozes = SNOOZE_RE.findall(rest)
    snoozed_until = snoozes[-1] if snoozes else None
    rest = SNOOZE_RE.sub("", rest)

    tags = TAG_RE.findall(rest)
    tag = tags[-1].lower() if tags else None
    rest = TAG_RE.sub("", rest).rstrip()
    heuristic_src = rest

    segs = rest.split(SEP)
    board = board_note = project = None
    trailing = ""
    bi = None
    for i in range(len(segs) - 1, 0, -1):  # never segment 0
        bm = BOARD_RE.match(segs[i].strip())
        if bm and len(segs[i].strip()) <= 40:
            bi = i
            board = bm.group(1).upper() if bm.group(1).lower() != "n/a" else "n/a"
            board_note = (bm.group(2) or "").strip() or None
            break
    if bi is not None:
        after = SEP.join(segs[bi + 1:]).strip()
        pre = segs[:bi]
        if after:
            # Project is a short slug; anything sentence-like after it is a trailing note.
            pm = re.match(r"^(.{1,40}?)(?:\s+(?=[A-Z][a-z]+:)|$)", after)
            if pm and len(after) > 40:
                project = pm.group(1).strip()
                trailing = after[pm.end():].strip()
            elif len(after) <= 40:
                project = after
            else:
                trailing = after
    else:
        pre = segs
        # No board field (e.g. "... — awareness — Side project"): a short final
        # segment after at least two others is still the project.
        if len(segs) >= 3 and len(segs[-1].strip()) <= 30:
            project = segs[-1].strip()
            pre = segs[:-1]

    source = None
    if len(pre) >= 2 and len(pre[0]) <= 70:
        source = pre[0].strip()
        text = SEP.join(pre[1:]).strip()
    else:
        text = SEP.join(pre).strip()
    if trailing:
        text = f"{text} {trailing}".strip()

    source_kind = None
    if source:
        sk = re.match(r"[A-Za-z0-9][A-Za-z0-9_-]*", source)
        source_kind = sk.group(0).lower() if sk else None
    project_key = None
    if project:
        project_key = re.sub(r"[\s_-]+", "", project.split("/")[0].strip().lower())

    if tag:
        kind, kind_source = tag, "tag"
    elif re.search(r"awareness", heuristic_src, re.I) or board == "n/a":
        kind, kind_source = "awareness", "guess"
    else:
        kind, kind_source = "action", "guess"

    return {
        "originTag": origin_tag,
        "origin": origin.isoformat(),
        "source": source,
        "sourceKind": source_kind,
        "text": text,
        "options": parse_options(text),
        "board": board,
        "boardNote": board_note,
        "project": project,
        "projectKey": project_key,
        "snoozedUntil": snoozed_until,
        "disposition": disposition,
        "kind": kind,
        "kindSource": kind_source,
    }


# ---------------------------------------------------------------- decision options
#
# Cards that pose one decision get one-tap choices. Three forms, tried in order;
# anything ambiguous gets no options at all (no chips beats wrong chips):
#   1. a parenthetical slash list closing a question: "... (yes / no)?", "(retire / keep)?"
#   2. "Yes = close; no = revoke it."
#   3. one inline "X, or Y?" (or "X, Y, or Z?") question whose choices each start
#      like an instruction, e.g. "Retire the old project, or keep it?"
# Items that number several questions ("(1) ... (2) ...") never get options.

# "(yes / no)?" or "…? (retire / keep)" at the end: the choices to a question, not an aside.
OPT_PAREN_RE = re.compile(r"\(([^()]*/[^()]*)\)\s*\?|(?<=\?)\s*\(([^()]*/[^()]*)\)[\s.*_]*$")
OPT_WORD_RE = re.compile(r"^[A-Za-z][A-Za-z0-9'’ -]{0,29}$")
OPT_YESNO_RE = re.compile(r"\byes\s*=\s*[^;.?]+;\s*no\s*=", re.I)
OPT_ENUM_RE = re.compile(r"(?:^|\s)\((?:[1-9]|[a-e])\)\s", re.I)
OPT_AUX = {"does", "do", "did", "is", "are", "was", "were", "should", "would", "could", "can", "will",
           "has", "have", "had", "shall", "may", "might", "must", "not"}
OPT_STOP = OPT_AUX | {"as", "in", "on", "at", "to", "for", "with", "by", "from", "of", "the", "a", "an", "and",
                      "but", "so", "if", "when", "then", "or", "it", "this", "that", "these", "those", "who",
                      "what", "which", "why", "how", "where", "owner", "assistant", "he", "she", "they", "we", "i",
                      "you", "his", "her", "their", "just", "also", "maybe", "probably", "either"}


def _opt_clean(s: str) -> str:
    s = re.sub(r"\([^()]*\)", "", s)              # asides: "(Thu Oct 29)"
    s = s.replace("**", "").replace("`", "").replace("*", "")
    return re.sub(r"\s+", " ", s).strip(" ,;:.?!—-")


def _opt_label(s: str) -> str:
    return s[:1].upper() + s[1:]


def parse_options(text: str) -> list[str]:
    """The choices a card's question offers, as short labels; [] if none or unsure."""
    t = (text or "").strip()
    if not t or OPT_ENUM_RE.search(t) or t.count("?") > 2:
        return []

    parens = [m for m in OPT_PAREN_RE.finditer(t)]
    slashy = re.findall(r"\(([^()]*/[^()]*)\)", t)
    if parens:
        if len(slashy) != 1 or len(parens) != 1:
            return []
        parts = [p.strip() for p in (parens[0].group(1) or parens[0].group(2)).split("/")]
        if 2 <= len(parts) <= 6 and all(OPT_WORD_RE.match(p) for p in parts) and \
                len({p.lower() for p in parts}) == len(parts):
            return [_opt_label(p) for p in parts]
        return []

    if OPT_YESNO_RE.search(t):
        return ["Yes", "No"]

    # Inline: the one question sentence that holds ", or ".
    qs = [q for q in re.findall(r"[^?]*\?", t) if ", or " in q]
    if len(qs) != 1 or qs[0].count(", or ") != 1:
        return []
    q = qs[0]
    # The clause starts after the last sentence break or colon before the ", or".
    head, tail = q.rsplit(", or ", 1)
    starts = [m.end() for m in re.finditer(r"(?:[.!;:…]|—)[*\"”’')\]]*\s+", head)]
    head = head[starts[-1]:] if starts else head
    # "Does the owner send them, or leave it to Pat?": the choice is the verb after the name.
    head = re.sub(r"^(?:does|should|will|would) (?:owner|he|assistant|she) ", "", head.strip(), flags=re.I)
    tail = _opt_clean(tail)
    head_parts = [_opt_clean(p) for p in head.split(", ")]
    words = lambda s: s.split()
    first = lambda s: (words(s)[0].lower().strip("'’") if words(s) else "")
    if not tail or not all(head_parts) or first(tail) in OPT_AUX or tail.lower() in ("not", "no"):
        return []
    # "receive them, create the POs, or ignore them": a list, if every part leads with a word
    # that can start an instruction. Otherwise the commas belong to one choice.
    if len(head_parts) > 1 and all(first(p) not in OPT_STOP for p in head_parts):
        choices = head_parts + [tail]
    else:
        choices = [_opt_clean(head), tail]
    if len(choices) > 5 or first(choices[0]) in OPT_AUX:
        return []
    if all(len(words(c)) <= 4 for c in choices):
        labels = choices
    else:
        # Long choices: name each by its leading verb ("Retire" / "Keep"), when that's
        # unambiguous.
        labels = [words(c)[0] for c in choices]
        if any(first(c) in OPT_STOP for c in choices):
            return []
    labels = [_opt_label(l) for l in labels]
    if len({l.lower() for l in labels}) != len(labels) or any(len(l) > 40 for l in labels):
        return []
    return labels


def match_option(options: list[str], choice: str) -> str | None:
    """The option a client named (case- and punctuation-insensitive), or None."""
    key = lambda s: re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
    want = key(choice)
    return next((o for o in options if key(o) == want), None) if want else None


def item_blocks(lines: list[str]) -> list[dict]:
    """Locate checkbox items and the indented child lines that follow each."""
    items = []
    heading = None
    subheading = None
    seen: dict[str, int] = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        hm = HEADING_RE.match(line)
        if hm:
            if len(hm.group(1)) <= 2:
                heading, subheading = hm.group(2).strip(), None
            else:
                subheading = hm.group(2).strip()
        m = ITEM_RE.match(line)
        if not m:
            i += 1
            continue
        indent = len(m.group("indent").expandtabs(4))
        j = i + 1
        while j < len(lines):
            nxt = lines[j]
            if not nxt.strip():
                break
            nindent = len(nxt) - len(nxt.lstrip(" \t"))
            if nindent <= indent:
                break
            j += 1
        occ = seen.get(line, 0)
        seen[line] = occ + 1
        items.append({
            "start": i,
            "end": j,  # exclusive
            "raw": line,
            "occurrence": occ,
            "checked": m.group("mark") != " ",
            "body": m.group("body"),
            "indent": m.group("indent"),
            "children": lines[i + 1:j],
            "section": heading,
            "subsection": subheading,
        })
        i += 1  # children may hold nested checkboxes; keep scanning them too
    return items


def stamp_age(s: str) -> int | None:
    """Seconds since a 'YYYY-MM-DD HH:MM PT' stamp, or None."""
    try:
        t = dt.datetime.strptime(s.replace(" PT", "").strip(), "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    except ValueError:
        return None
    return int((now_pt() - t).total_seconds())


def parse_notes(comments: list[str]) -> tuple[list[dict], dict | None, bool]:
    """Classify an item's sub-bullets. Returns (notes, pending question, looks-resolved)."""
    notes = []
    for c in comments:
        if m := NOTE_Q_RE.match(c):
            notes.append({"who": "Me", "kind": "question", "stamp": m.group(1), "text": m.group(2)})
        elif m := NOTE_ASSISTANT_RE.match(c):
            notes.append({"who": "Assistant", "kind": "answer", "stamp": m.group(1), "text": m.group(2),
                          "resolved": bool(RESOLVED_RE.search(m.group(2)))})
        elif m := NOTE_ME_RE.match(c):
            notes.append({"who": "Me", "kind": "comment", "stamp": m.group(1), "text": m.group(2)})
        else:
            notes.append({"who": None, "kind": "other", "stamp": None, "text": c})
    pending = None
    for i, n in enumerate(notes):
        if n["kind"] == "question":
            answered = any(x["who"] == "Assistant" for x in notes[i + 1:])
            pending = None if answered else {"stamp": n["stamp"], "text": n["text"], "ageSec": stamp_age(n["stamp"]), "index": i}
    # the assistant's answer to a question pairs with it; mark which question each answers.
    q = None
    for n in notes:
        if n["kind"] == "question":
            q = n
        elif n["who"] == "Assistant" and q is not None:
            n["answers"] = q["text"]
            q = None
    resolved = any(n.get("resolved") for n in notes)
    return notes, pending, resolved


def parse_file(p: Path) -> dict:
    m = FILE_RE.match(p.name)
    file_date = dt.date.fromisoformat(m.group(1))
    text = read_text(p)
    lines, _ = split_lines(text)
    today = today_pt()
    out = []
    for n, b in enumerate(item_blocks(lines)):
        f = parse_body(b["body"], file_date)
        origin = dt.date.fromisoformat(f["origin"])
        comments = []
        for c in b["children"]:
            s = c.strip()
            if s.startswith("- "):
                s = s[2:]
            comments.append(s)
        notes, pending, resolved_hint = parse_notes(comments)
        out.append({
            "id": n,
            "raw": b["raw"],
            "occurrence": b["occurrence"],
            "checked": b["checked"],
            "nested": bool(b["indent"]),
            "section": b["section"],
            "subsection": b["subsection"],
            "age": (today - origin).days,
            "comments": comments,
            "notes": notes,
            "pendingAsk": pending,
            "resolvedHint": resolved_hint and not b["checked"],
            **f,
        })
    title = next((l[2:].strip() for l in lines if l.startswith("# ")), p.name)
    return {
        "file": p.name,
        "date": file_date.isoformat(),
        "title": title,
        "today": today.isoformat(),
        "mtime": os.stat(p).st_mtime,
        "items": out,
    }


# ---------------------------------------------------------------- edits


def find_block(lines: list[str], raw: str, occurrence: int) -> dict:
    matches = [b for b in item_blocks(lines) if b["raw"] == raw]
    if not matches:
        raise Conflict(
            "That item's line is no longer in the file exactly as shown "
            "(someone, probably the assistant's sweep, edited it). Reload and try again."
        )
    if occurrence >= len(matches):
        raise Conflict(
            "The file has fewer copies of that exact line than when it was loaded. "
            "Reload and try again."
        )
    return matches[occurrence]


def one_line(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def tick(raw: str) -> str:
    return re.sub(r"^([ \t]*)- \[ \] ", r"\1- [x] ", raw, count=1)


def apply_action(lines: list[str], block: dict, action: str, payload: dict) -> tuple[list[str], dict]:
    """Return (new block lines, extra info). Never touches other lines."""
    raw = block["raw"]
    children = list(block["children"])
    indent = block["indent"]
    child_indent = indent + "  "
    text = one_line(payload.get("text", ""))
    extra: dict = {}

    if action in ("done", "choose", "drop", "snooze", "ask", "reclassify") and block["checked"]:
        raise ValueError("This item is already resolved.")

    if action == "done":
        head = tick(raw) + f" — done (Me, {stamp()})" + (f": {text}" if text else "")
        return [head] + children, extra
    if action == "choose":
        options = parse_body(block["body"], today_pt())["options"]
        opt = match_option(options, payload.get("option", ""))
        if not opt:
            raise ValueError(f"Not one of this item's options ({' / '.join(options) or 'it has none'}): "
                             f"{payload.get('option', '')!r}")
        extra["option"] = opt
        head = tick(raw) + f' — done (Me, {stamp()}): chose "{opt}"' + (f"; {text}" if text else "")
        return [head] + children, extra
    if action == "drop":
        head = tick(raw) + " — dropped (Me)" + (f": {text}" if text else "")
        return [head] + children, extra
    if action == "snooze":
        date = payload.get("date", "")
        try:
            d = dt.date.fromisoformat(date)
        except ValueError:
            raise ValueError(f"bad date: {date!r}")
        # Re-snoozing replaces the previous marker instead of stacking them.
        head = SNOOZE_RE.sub("", raw) + f" — snoozed until {d.isoformat()}"
        if text:
            children.append(f"{child_indent}- Me ({stamp()}): {text}")
        return [head] + children, extra
    if action in ("comment", "assistant"):
        if not text:
            raise ValueError("Comment is empty.")
        body = f"→ Assistant: {text}" if action == "assistant" else text
        children.append(f"{child_indent}- Me ({stamp()}): {body}")
        extra["comment"] = body
        return [raw] + children, extra
    if action == "ask":
        if not text:
            raise ValueError("Question is empty.")
        children.append(f"{child_indent}- Me ({stamp()}) ? {text}")
        extra["question"] = text
        return [raw] + children, extra
    if action == "reclassify":
        kind = payload.get("kind")
        if kind not in ("action", "awareness"):
            raise ValueError(f"bad kind: {kind!r}")
        return [set_tag(raw, kind)] + children, extra
    raise ValueError(f"unknown action: {action}")


def set_tag(raw: str, kind: str) -> str:
    """Rewrite (or add) the #action/#awareness tag in place, keeping any
    snooze or done/dropped suffix after it."""
    m = re.match(r"^([ \t]*- \[[ xX]\] )(.*)$", raw)
    prefix, body = m.group(1), m.group(2)
    cut = len(body)
    for rx in (DISPOSITION_RE, SNOOZE_RE):
        mm = rx.search(body)
        if mm:
            cut = min(cut, mm.start())
    core, suffix = body[:cut], body[cut:]
    core = TAG_RE.sub("", core).rstrip()
    suffix = TAG_ANY_RE.sub("", suffix) if not DISPOSITION_RE.search(suffix) else suffix
    return f"{prefix}{core} #{kind}{suffix}"


def ascii_clean(s: str) -> str:
    """Printable ASCII on one line, for assistant-trigger.sh (its callers sanitize)."""
    s = (s or "").replace("\u2014", "-").replace("\u2013", "-").replace("\u2192", "->")
    s = s.replace("\u2018", "'").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    s = s.replace("\u2026", "...").replace("**", "")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[\x00-\x1f\x7f]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


TRIGGER_STATUS: dict = {}


def fire_triage_trigger(file_name: str, item_text: str, question: str, kind: str = "triage") -> dict:
    """Queue `assistant-trigger.sh triage "<file>|<item first 80>|<question>"`.
    The script itself returns quickly (delivery is detached); run it off the
    request thread anyway so a slow assistant-up never stalls the UI."""
    if TRIGGER in ("", "0"):
        return {"queued": False, "note": "trigger disabled"}
    script = Path(TRIGGER).expanduser()
    if not script.is_file():
        return {"queued": False, "note": f"trigger script not found: {script}"}
    parts = [ascii_clean(file_name), ascii_clean(item_text)[:80].rstrip(), ascii_clean(question)[:600]]
    msg = "|".join(x.replace("|", "/") for x in parts)

    def run():
        try:
            r = subprocess.run([str(script), kind, msg], capture_output=True, text=True, timeout=120,
                               stdin=subprocess.DEVNULL)
            TRIGGER_STATUS.update(at=stamp(), code=r.returncode, err=r.stderr.strip()[-300:])
            if r.returncode:
                sys.stderr.write(f"triage trigger exit {r.returncode}: {r.stderr.strip()[-300:]}\n")
        except Exception as e:  # noqa: BLE001
            TRIGGER_STATUS.update(at=stamp(), code=-1, err=str(e))
            sys.stderr.write(f"triage trigger failed: {e}\n")

    threading.Thread(target=run, daemon=True).start()
    return {"queued": True, "message": msg}


NEWTAB_LIMITS = {"url": 1000, "headline": 160, "prompt": 1500}
# A full edition (100-odd headlines with summaries, plus the cards) runs past the
# 64 KB the other newtab routes allow.
EDITION_MAX_BYTES = 1024 * 1024
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def write_newtab_edition(req: dict) -> dict:
    """Overwrite EDITION_PATH with the edition the newtab just sent to the Kobo.
    Written atomically (temp file, then rename) so the assistant never reads half a file.
    Not committed: the file is replaced every morning and history isn't wanted."""
    date, made_at, markdown = req.get("date"), req.get("madeAt"), req.get("markdown")
    if not isinstance(date, str) or not DATE_RE.match(date):
        raise ValueError("date must be YYYY-MM-DD")
    if not isinstance(made_at, str):
        raise ValueError("madeAt is required")
    try:
        dt.datetime.fromisoformat(made_at.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("madeAt must be an ISO time") from None
    if not isinstance(markdown, str) or not markdown.strip():
        raise ValueError("markdown is required")
    if not markdown.startswith("---\n"):
        raise ValueError("markdown must start with its front matter")
    EDITION_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=EDITION_PATH.parent, prefix=".edition-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(markdown)
        os.replace(tmp, EDITION_PATH)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return {"written": True, "path": str(EDITION_PATH), "date": date, "madeAt": made_at}


def fire_newtab_trigger(req: dict) -> dict:
    """Queue `assistant-trigger.sh newtab "<url>|<headline>|<prompt>"` for a comment
    the owner wrote on a newtab story. Runs the script synchronously (it returns as
    soon as the message is queued) so the extension can show a real failure.
    The headline is untrusted page data; only the prompt is the owner's. the assistant's
    newtab protocol knows that."""
    if not isinstance(req, dict):
        raise ValueError("expected a JSON object")
    url = str(req.get("url") or "").strip()
    if not re.match(r"^https?://\S+$", url):
        raise ValueError("url must be an http(s) URL")
    prompt = ascii_clean(str(req.get("prompt") or ""))
    if not prompt:
        raise ValueError("prompt is empty")
    if TRIGGER in ("", "0"):
        raise LookupError("the assistant trigger is turned off (INTAKE_TRIGGER=0)")
    script = Path(TRIGGER).expanduser()
    if not script.is_file():
        raise LookupError(f"trigger script not found: {script}")
    parts = [ascii_clean(url)[: NEWTAB_LIMITS["url"]],
             ascii_clean(str(req.get("headline") or ""))[: NEWTAB_LIMITS["headline"]].rstrip(),
             prompt[: NEWTAB_LIMITS["prompt"]]]
    msg = "|".join(x.replace("|", "/") for x in parts)
    try:
        r = subprocess.run([str(script), "newtab", msg], capture_output=True, text=True, timeout=30,
                           stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        TRIGGER_STATUS.update(at=stamp(), kind="newtab", code=-1, err="timeout")
        raise talk.ProviderError("the assistant trigger timed out after 30s")
    TRIGGER_STATUS.update(at=stamp(), kind="newtab", code=r.returncode, err=r.stderr.strip()[-300:])
    if r.returncode:
        raise talk.ProviderError(f"the assistant trigger failed (exit {r.returncode}): {r.stderr.strip()[-200:]}")
    return {"ok": True, "queued": True}


# A critical or high advisory on the newtab that touches a vault project. The
# extension reports it; this decides, so the extension never holds the power to
# start sessions. One advisory starts at most one session per project, ever
# (matched by id or url), and at most ADVISORY_CAP a day start one at all; the
# rest become an AGENT-board issue only. Real launches are off until the owner sets
# INTAKE_ADVISORY_LIVE=1: until then the assistant is told what it would have done.
ADVISORY_LIVE = os.environ.get("INTAKE_ADVISORY_LIVE", "0") == "1"
ADVISORY_CAP = int(os.environ.get("INTAKE_ADVISORY_CAP", "3"))
ADVISORY_SEVERITIES = ("critical", "high")
ADVISORY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")  # same as the extension's validator
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# Per vault, like the undo stack, so the tests never share a ledger with the real one.
ADVISORY_LEDGER = STATE_DIR / f"advisories-{__import__('hashlib').sha1(str(VAULT).encode()).hexdigest()[:10]}.json"
ADVISORY_LOCK = threading.Lock()


def load_ledger() -> list[dict]:
    try:
        return json.loads(ADVISORY_LEDGER.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def fire_advisory_trigger(req: dict) -> dict:
    """Dedup, cap, then queue `assistant-trigger.sh advisory
    "<mode>|<id>|<severity>|<projects>|<url>|<headline>|<action>"`. mode is
    LAUNCH or ISSUE-ONLY, prefixed DRYRUN- unless real launches are on.
    projects is comma-separated slugs. The headline and action are model-written
    from untrusted pages; the id, severity and slugs are checked here."""
    if not isinstance(req, dict):
        raise ValueError("expected a JSON object")
    adv_id = str(req.get("id") or "").strip().lower()
    if not ADVISORY_ID_RE.match(adv_id):
        raise ValueError("id must be a short lowercase advisory id")
    severity = str(req.get("severity") or "").strip().lower()
    if severity not in ADVISORY_SEVERITIES:
        raise ValueError("severity must be critical or high")
    url = str(req.get("url") or "").strip()
    if not re.match(r"^https?://\S+$", url):
        raise ValueError("url must be an http(s) URL")
    raw = req.get("projects")
    if not isinstance(raw, list) or not raw:
        raise ValueError("projects must be a non-empty list")
    projects = list(dict.fromkeys(str(p) for p in raw[:3]))
    unknown = [p for p in projects if not (SLUG_RE.match(p) and (VAULT / PROJECTS_DIR / p / "current-state.md").is_file())]
    projects = [p for p in projects if p not in unknown]
    if not projects:
        raise ValueError(f"unknown project: {', '.join(unknown)}")
    if TRIGGER in ("", "0"):
        raise LookupError("the assistant trigger is turned off (INTAKE_TRIGGER=0)")
    script = Path(TRIGGER).expanduser()
    if not script.is_file():
        raise LookupError(f"trigger script not found: {script}")

    with ADVISORY_LOCK:
        # Dry-run entries never block real ones: turning launches on starts clean.
        ledger = [e for e in load_ledger() if e.get("live") == ADVISORY_LIVE]
        seen = {p for e in ledger if e["id"] == adv_id or e["url"] == url for p in e["projects"]}
        fresh = [p for p in projects if p not in seen]
        if not fresh:
            return {"ok": True, "status": "duplicate", "dry": not ADVISORY_LIVE, "unknown": unknown}
        today = today_pt().isoformat()
        launched_today = sum(1 for e in ledger if e["date"] == today and e["status"] == "launch")
        status = "launch" if launched_today < ADVISORY_CAP else "issue-only"
        mode = ("" if ADVISORY_LIVE else "DRYRUN-") + status.upper()
        parts = [mode, adv_id, severity, ",".join(fresh), ascii_clean(url)[: NEWTAB_LIMITS["url"]],
                 ascii_clean(str(req.get("headline") or ""))[: NEWTAB_LIMITS["headline"]].rstrip(),
                 ascii_clean(str(req.get("action") or ""))[:200].rstrip()]
        msg = "|".join(x.replace("|", "/") for x in parts)
        try:
            r = subprocess.run([str(script), "advisory", msg], capture_output=True, text=True, timeout=30,
                               stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            TRIGGER_STATUS.update(at=stamp(), kind="advisory", code=-1, err="timeout")
            raise talk.ProviderError("the assistant trigger timed out after 30s")
        TRIGGER_STATUS.update(at=stamp(), kind="advisory", code=r.returncode, err=r.stderr.strip()[-300:])
        if r.returncode:
            # Not recorded, so the extension's retry gets a fresh decision.
            raise talk.ProviderError(f"the assistant trigger failed (exit {r.returncode}): {r.stderr.strip()[-200:]}")
        STATE_DIR.mkdir(exist_ok=True)
        entry = {"at": stamp(), "date": today, "id": adv_id, "url": url, "severity": severity,
                 "projects": fresh, "status": status, "live": ADVISORY_LIVE}
        write_text_atomic(ADVISORY_LEDGER, json.dumps(load_ledger() + [entry], indent=1))
    return {"ok": True, "status": status, "dry": not ADVISORY_LIVE, "projects": fresh, "unknown": unknown}


INBOX_HEADER = (
    "# Triage inbox: The owner to the assistant\n"
    "\n"
    "Written by the intake-triage app (`~/tools/intake-triage`) whenever the owner hands an\n"
    "intake item to the assistant. The assistant: process each line at the next sweep, then tick it.\n"
    "Each line names the intake file it came from; the same comment is also an indented\n"
    "sub-bullet under the item in that file.\n"
    "\n"
)


def inbox_line(file_name: str, item_text: str, comment: str) -> str:
    excerpt = one_line(item_text)
    if len(excerpt) > 140:
        excerpt = excerpt[:137].rstrip() + "..."
    note = file_name[:-3]
    return f"- [ ] {stamp()} — [[{note}]] — {excerpt} — Me {comment}"


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(VAULT), *args], capture_output=True, text=True, timeout=30
    )


def git_available() -> bool:
    if not GIT_ENABLED:
        return False
    r = git("rev-parse", "--show-toplevel")
    return r.returncode == 0 and Path(r.stdout.strip()).resolve() == VAULT


def commit(paths: list[Path], message: str) -> dict:
    if not git_available():
        return {"committed": False, "note": "git disabled or vault is not a repo"}
    rels = [str(p.relative_to(VAULT)) for p in paths]
    last_err = ""
    for attempt in range(6):
        add = git("add", "--", *rels)
        if add.returncode == 0:
            c = git("commit", "-m", message, "--", *rels)
            if c.returncode == 0:
                sha = git("rev-parse", "--short", "HEAD").stdout.strip()
                return {"committed": True, "sha": sha}
            out = (c.stdout + c.stderr)
            if "nothing to commit" in out or "no changes added" in out:
                return {"committed": False, "note": "nothing to commit"}
            last_err = out.strip()
        else:
            last_err = add.stderr.strip()
        if "index.lock" in last_err or "Unable to create" in last_err:
            time.sleep(0.4 * (attempt + 1))
            continue
        break
    raise RuntimeError(f"The file was saved, but the git commit failed: {last_err}")


# ---------------------------------------------------------------- undo stack


def load_undo() -> list[dict]:
    try:
        return json.loads(UNDO_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_undo(stack: list[dict]) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    UNDO_FILE.write_text(json.dumps(stack[-25:], ensure_ascii=False, indent=1))


def find_sequence(lines: list[str], seq: list[str]) -> list[int]:
    hits = []
    n = len(seq)
    for i in range(len(lines) - n + 1):
        if lines[i:i + n] == seq:
            hits.append(i)
    return hits


ACTION_LABEL = {"done": "done", "choose": "choose", "drop": "drop", "snooze": "reschedule",
                "comment": "comment", "assistant": "hand to the assistant", "ask": "ask the assistant",
                "reclassify": "reclassify"}


def do_action(req: dict) -> dict:
    action = req.get("action")
    if action not in ACTION_LABEL:
        raise ValueError(f"unknown action: {action}")
    p = resolve_file(req.get("file", ""))
    with WRITE_LOCK:
        text = read_text(p)  # always re-read right before writing
        lines, nl = split_lines(text)
        block = find_block(lines, req.get("raw", ""), int(req.get("occurrence", 0)))
        before = lines[block["start"]:block["end"]]
        after, extra = apply_action(lines, block, action, req)
        new_lines = lines[:block["start"]] + after + lines[block["end"]:]
        write_text_atomic(p, nl.join(new_lines))
        touched = [p]
        inbox_entry = None
        if action == "assistant":
            ip = INTAKE_DIR / INBOX_NAME
            entry = inbox_line(p.name, parse_body(block["body"], dt.date.fromisoformat(
                FILE_RE.match(p.name).group(1)))["text"], extra["comment"])
            existing = read_text(ip) if ip.exists() else INBOX_HEADER
            if existing and not existing.endswith("\n"):
                existing += "\n"
            write_text_atomic(ip, existing + entry + "\n")
            touched.append(ip)
            inbox_entry = entry
        item_text = one_line(parse_body(block["body"], dt.date.today())["text"])
        excerpt = item_text[:60]
        label = ACTION_LABEL[action] + (f" as {req.get('kind')}" if action == "reclassify" else "") + \
            (f' "{extra["option"]}"' if action == "choose" else "")
        msg = f"intake triage: {label} — {excerpt}"
        undo_id = uuid.uuid4().hex[:10]
        stack = load_undo()
        stack.append({"id": undo_id, "file": p.name, "action": action, "before": before,
                      "after": after, "inbox": inbox_entry, "at": stamp(), "excerpt": excerpt})
        save_undo(stack)
        warning = None
        try:
            git_info = commit(touched, msg)
        except RuntimeError as e:
            git_info, warning = None, str(e)
    out = {"ok": True, "git": git_info, "undoId": undo_id, "newRaw": after[0], "message": msg}
    if action == "choose":
        out["option"] = extra["option"]
    if warning:
        out["warning"] = warning
    if action == "ask":
        out["trigger"] = fire_triage_trigger(p.name, item_text, extra["question"])
        if not out["trigger"]["queued"]:
            out["warning"] = (out.get("warning", "") + " " if out.get("warning") else "") + \
                f"Question saved, but the assistant wasn't pinged: {out['trigger']['note']}"
    if action in ("comment", "assistant"):
        # The owner wants comments handled when they post them, not at the next sweep (2026-10-27).
        out["trigger"] = fire_triage_trigger(p.name, item_text, extra["comment"], kind="triage-comment")
        if not out["trigger"]["queued"]:
            out["warning"] = (out.get("warning", "") + " " if out.get("warning") else "") + \
                f"Comment saved, but the assistant wasn't pinged: {out['trigger']['note']}"
    return out


def do_undo(undo_id: str | None = None) -> dict:
    """Undo the newest action, or a specific one by id (talk mode's action log).
    A specific undo still refuses if the item was edited after that action."""
    with WRITE_LOCK:
        stack = load_undo()
        if not stack:
            raise ValueError("Nothing to undo.")
        k = len(stack) - 1
        if undo_id is not None:
            k = next((i for i, e in enumerate(stack) if e["id"] == undo_id), -1)
            if k < 0:
                raise ValueError("That change was already undone (or is too old to undo here).")
        u = stack[k]
        p = resolve_file(u["file"])
        lines, nl = split_lines(read_text(p))
        hits = find_sequence(lines, u["after"])
        if not hits:
            raise Conflict("Can't undo: the item was edited after that action. Fix it by hand in your editor.")
        i = hits[-1]
        new_lines = lines[:i] + u["before"] + lines[i + len(u["after"]):]
        write_text_atomic(p, nl.join(new_lines))
        touched = [p]
        if u.get("inbox"):
            ip = INTAKE_DIR / INBOX_NAME
            if ip.exists():
                ilines, inl = split_lines(read_text(ip))
                if u["inbox"] in ilines:
                    j = len(ilines) - 1 - ilines[::-1].index(u["inbox"])
                    del ilines[j]
                    write_text_atomic(ip, inl.join(ilines))
                    touched.append(ip)
        stack.pop(k)
        save_undo(stack)
        msg = f"intake triage: undo {ACTION_LABEL[u['action']]} — {u.get('excerpt', '')}"
        try:
            git_info = commit(touched, msg)
        except RuntimeError as e:
            return {"ok": True, "warning": str(e), "undone": u["action"], "file": u["file"], "raw": u["before"][0]}
    return {"ok": True, "git": git_info, "undone": u["action"], "file": u["file"], "raw": u["before"][0]}


# ---------------------------------------------------------------- whisper fallback


def groq_key() -> str | None:
    return voice.sec_get(GROQ_SECRET)


def transcribe(audio: bytes, content_type: str, lang: str) -> str:
    key = groq_key()
    if not key:
        raise LookupError(
            f"No Groq key at '{GROQ_SECRET}'. Set GROQ_API_KEY in the server's environment "
            "(or point INTAKE_GROQ_SECRET at another spec)."
        )
    ext = "webm" if "webm" in content_type else "ogg" if "ogg" in content_type else "m4a" if "mp4" in content_type else "wav"
    boundary = uuid.uuid4().hex
    parts = []

    def field(name: str, value: str):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())

    field("model", "whisper-large-v3")  # same model as ~/tools/transcriber
    field("response_format", "json")
    if lang:
        field("language", lang.split("-")[0])
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.{ext}"\r\n'
        f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n".encode()
    )
    parts.append(audio)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        data=b"".join(parts),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "intake-triage/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read()).get("text", "").strip()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Groq returned HTTP {e.code}") from None


# ---------------------------------------------------------------- http


class Handler(SimpleHTTPRequestHandler):
    server_version = "intake-triage/2.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "microphone=(self)")
        # Only the app itself and the newtab extension may frame it.
        self.send_header("Content-Security-Policy", f"frame-ancestors 'self' {NEWTAB_ORIGIN}")
        super().end_headers()

    # Guard against DNS rebinding and cross-site requests: a local tool that
    # writes to the vault must only answer pages it served itself.
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}:
            return False
        return self.headers.get("X-Intake-Triage") == "1"

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, e: Exception) -> None:
        if isinstance(e, Conflict):
            self._json(409, {"ok": False, "error": str(e), "conflict": True})
        elif isinstance(e, (ValueError, FileNotFoundError)):
            self._json(400, {"ok": False, "error": str(e)})
        elif isinstance(e, talk.ProviderError):
            self._json(502, {"ok": False, "error": str(e)})
        elif isinstance(e, LookupError):
            self._json(503, {"ok": False, "error": str(e)})
        else:
            self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        if not self._host_ok():
            return self._json(403, {"error": "bad host"})
        path, _, qs = self.path.partition("?")
        params = {k: v[-1] for k, v in urllib.parse.parse_qs(qs).items()}
        try:
            if path == "/api/files":
                return self._json(200, {"files": list_files(), "today": today_pt().isoformat()})
            if path == "/api/items":
                name = params.get("file", "")
                if not name:
                    files = list_files()
                    if not files:
                        raise FileNotFoundError(f"no intake files in {INTAKE_DIR}")
                    name = files[0]["name"]
                return self._json(200, parse_file(resolve_file(name)))
            if path == "/api/status":
                return self._json(200, {
                    "vault": str(VAULT), "intakeDir": str(INTAKE_DIR),
                    "git": git_available(), "undo": len(load_undo()),
                    "lastUndo": (load_undo() or [{}])[-1].get("excerpt"),
                    "lastTrigger": TRIGGER_STATUS or None,
                    "talk": {"provider": TALK.provider_name, "model": talk.MODEL if TALK.provider_name == "openai" else TALK.provider_name},
                })
        except Exception as e:  # noqa: BLE001
            return self._err(e)
        if path.startswith("/api/"):
            return self._json(404, {"error": "not found"})
        return super().do_GET()

    def _newtab_ok(self) -> bool:
        """The newtab comment route answers only the extension's own pages.
        Browsers set Origin; no web page (or other extension) can claim it."""
        return (self._host_ok() and self.headers.get("Origin") == NEWTAB_ORIGIN
                and self.headers.get("X-Intake-Triage") == "1")

    def do_POST(self):
        newtab_routes = {"/api/newtab/comment": fire_newtab_trigger, "/api/newtab/advisory": fire_advisory_trigger,
                         "/api/newtab/edition": write_newtab_edition}
        if self.path in newtab_routes:
            if not self._newtab_ok():
                return self._json(403, {"ok": False, "error": "forbidden"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > (EDITION_MAX_BYTES if self.path == "/api/newtab/edition" else 64 * 1024):
                return self._json(413, {"ok": False, "error": "too large"})
            try:
                return self._json(200, newtab_routes[self.path](json.loads(self.rfile.read(length) or b"{}")))
            except Exception as e:  # noqa: BLE001
                return self._err(e)
        if not (self._host_ok() and self._origin_ok()):
            return self._json(403, {"ok": False, "error": "forbidden"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > 25 * 1024 * 1024:
            return self._json(413, {"ok": False, "error": "too large"})
        body = self.rfile.read(length) if length else b""
        try:
            if self.path == "/api/action":
                return self._json(200, do_action(json.loads(body or b"{}")))
            if self.path == "/api/undo":
                return self._json(200, do_undo())
            if self.path.startswith("/api/talk/"):
                req = json.loads(body or b"{}")
                route = {"/api/talk/session": TALK.open, "/api/talk/tool": TALK.tool,
                         "/api/talk/approve": TALK.approve, "/api/talk/undo": TALK.undo}.get(self.path)
                if route:
                    return self._json(200, route(req))
            if self.path == "/api/voice":
                req = json.loads(body or b"{}")
                phase = "awareness" if req.get("phase") == "awareness" else "action"
                options = [str(o)[:60] for o in (req.get("options") or [])[:9] if isinstance(o, str)]
                return self._json(200, {"ok": True, **voice.parse(str(req.get("text", ""))[:500], today_pt(), phase,
                                                                   options=options)})
            if self.path.startswith("/api/transcribe"):
                lang = self.headers.get("X-Lang", "en")
                text = transcribe(body, self.headers.get("Content-Type", ""), lang)
                return self._json(200, {"ok": True, "text": text})
        except Exception as e:  # noqa: BLE001
            return self._err(e)
        return self._json(404, {"ok": False, "error": "not found"})


TALK = talk.TalkDesk(sys.modules[__name__])


def main():
    if not INTAKE_DIR.is_dir():
        sys.exit(f"intake dir not found: {INTAKE_DIR}")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"intake-triage: http://127.0.0.1:{PORT}  (vault {VAULT}, git {'on' if git_available() else 'off'})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
