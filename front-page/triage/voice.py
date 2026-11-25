"""Voice command parsing for the intake triage app.

parse(transcript, today, phase, options) -> intent dict:
    {"action": done|choose|drop|reschedule|comment|ask|assistant|next|prev|skip|undo|stop|unknown,
     "date": "YYYY-MM-DD" (reschedule only), "option": str (choose only),
     "text": str (optional), "tier": 1|2,
     "via": "grammar"|"jev"|"jev+local"|"llm", "confidence": float (tier 2)}

Tier 1 is a deterministic grammar and covers everything the owner is told to say.
When the current card offers decision options (server.parse_options), tier 1
also picks one from "yes", "keep", "option two", "the first one" or
"keep, because ..."; a plain command word (done, drop, next ...) still wins.
Tier 2 runs only when tier 1 finds nothing:
  1. Jev (TypeSafe's decision model) picks the action from the closed set.
  2. The date and the free text come from local extraction (the same date
     grammar as tier 1; the text is the utterance minus its command words).
  3. If Jev's confidence is under JEV_MIN_CONFIDENCE, or a reschedule has no
     date we can read, a small LLM with a JSON-schema response does the whole
     parse instead.
Dates are relative to `today` (America/Los_Angeles, supplied by the caller) and
never in the past.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import urllib.error
import urllib.request

ACTIONS = ["done", "drop", "reschedule", "comment", "ask", "assistant",
           "next", "prev", "skip", "undo", "stop", "unknown"]
NEEDS_TEXT = {"comment", "ask", "assistant"}

JEV_SECRET = os.environ.get("INTAKE_JEV_SECRET", "env:JEV_API_KEY")
JEV_MODEL = os.environ.get("INTAKE_JEV_MODEL", "jev-latest")
JEV_MIN_CONFIDENCE = float(os.environ.get("INTAKE_JEV_MIN_CONFIDENCE", "0.8"))
LLM_SECRET = os.environ.get("INTAKE_LLM_SECRET", "env:OPENROUTER_API_KEY")
LLM_MODEL = os.environ.get("INTAKE_LLM_MODEL", "openai/gpt-4.1-mini")
LLM_URL = os.environ.get("INTAKE_LLM_URL", "https://openrouter.ai/api/v1/chat/completions")

# ---------------------------------------------------------------- normalising

NUM_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "a": 1, "an": 1, "couple": 2, "a couple": 2,
}
ORD_WORDS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6,
    "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12,
    "thirteenth": 13, "fourteenth": 14, "fifteenth": 15, "sixteenth": 16,
    "seventeenth": 17, "eighteenth": 18, "nineteenth": 19, "twentieth": 20, "thirtieth": 30,
}
MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"])}
MONTHS.update({"jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
               "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12})
WEEKDAYS = {d: i for i, d in enumerate(
    ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])}
WEEKDAYS.update({"mon": 0, "tue": 1, "tues": 1, "wed": 2, "thu": 3, "thur": 3, "thurs": 3,
                 "fri": 4, "sat": 5, "sun": 6})


def norm(s: str) -> str:
    """Lowercase, straight quotes, no edge punctuation, single spaces."""
    s = (s or "").replace("’", "'").replace("‘", "'").lower()
    s = re.sub(r"[\s]+", " ", s).strip()
    return s.strip(" .,!?;:")


def _spoken_numbers(s: str) -> str:
    """'twenty first' -> '21st', 'third' -> '3rd', 'two weeks' -> '2 weeks'."""
    tens = r"(twenty|thirty)"
    units_o = "|".join(k for k in ORD_WORDS if ORD_WORDS[k] < 10)
    units_c = "|".join(k for k, v in NUM_WORDS.items() if v < 10 and k not in ("a", "an", "couple", "a couple"))
    s = re.sub(rf"\b{tens}[ -]({units_o})\b", lambda m: f"{NUM_WORDS[m.group(1)] + ORD_WORDS[m.group(2)]}th", s)
    s = re.sub(rf"\b{tens}[ -]({units_c})\b", lambda m: str(NUM_WORDS[m.group(1)] + NUM_WORDS[m.group(2)]), s)
    s = re.sub(r"\b(" + "|".join(ORD_WORDS) + r")\b", lambda m: f"{ORD_WORDS[m.group(1)]}th", s)
    s = re.sub(r"\ba couple( of)?\b", "2", s)
    s = re.sub(r"\b(" + "|".join(k for k in NUM_WORDS if " " not in k and k not in ("a", "an", "couple")) + r")\b",
               lambda m: str(NUM_WORDS[m.group(1)]), s)
    return s


# ---------------------------------------------------------------- dates


def _future_month_day(today: dt.date, month: int, day: int) -> dt.date | None:
    for year in (today.year, today.year + 1):
        try:
            d = dt.date(year, month, day)
        except ValueError:
            return None
        if d >= today:
            return d
    return None


def _future_day_of_month(today: dt.date, day: int) -> dt.date | None:
    first = today.replace(day=1)
    for k in range(3):
        base = _add_months(first, k)
        try:
            d = base.replace(day=day)
        except ValueError:
            continue
        if d >= today:
            return d
    return None


def _next_weekday(today: dt.date, wd: int) -> dt.date:
    n = (wd - today.weekday()) % 7
    return today + dt.timedelta(days=n or 7)


def _add_months(d: dt.date, n: int) -> dt.date:
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    for day in (d.day, 30, 29, 28):
        try:
            return dt.date(y, m, day)
        except ValueError:
            continue
    return d


MONTH_ALT = "|".join(sorted(MONTHS, key=len, reverse=True))
WEEKDAY_ALT = "|".join(sorted(WEEKDAYS, key=len, reverse=True))


def parse_date(phrase: str, today: dt.date) -> tuple[dt.date | None, tuple[int, int] | None]:
    """Find a date in a phrase. Returns (date, (start, end) span in the
    normalised-numbers phrase) or (None, None). 'next week' means a week from
    today and 'Monday' or 'next Monday' the coming Monday, matching the app's
    snooze buttons."""
    s = _spoken_numbers(norm(phrase))
    pats: list[tuple[str, callable]] = [
        (r"\b(\d{4})-(\d{2})-(\d{2})\b",
         lambda m: dt.date(int(m[1]), int(m[2]), int(m[3]))),
        (r"\bday after tomorrow\b", lambda m: today + dt.timedelta(days=2)),
        (r"\b(tomorrow|tmrw|tomorow)\b", lambda m: today + dt.timedelta(days=1)),
        (r"\b(today|tonight|this evening|later today)\b", lambda m: today),
        (r"\bin (\d+) (day|days|week|weeks|month|months)\b",
         lambda m: _add_months(today, int(m[1])) if m[2].startswith("month")
         else today + dt.timedelta(days=int(m[1]) * (7 if m[2].startswith("week") else 1))),
        (r"\b(\d+) (day|days|week|weeks)( from (now|today))?\b",
         lambda m: today + dt.timedelta(days=int(m[1]) * (7 if m[2].startswith("week") else 1))),
        (r"\b(a|1) (week|fortnight)\b",
         lambda m: today + dt.timedelta(days=14 if m[2] == "fortnight" else 7)),
        (r"\bnext month\b", lambda m: _add_months(today, 1)),
        (r"\bend of (the |this )?week\b",
         lambda m: today + dt.timedelta(days=4 - today.weekday()) if today.weekday() < 4 else _next_weekday(today, 4)),
        (r"\b(this weekend|the weekend|weekend)\b", lambda m: _next_weekday(today, 5)),
        (r"\bnext week\b", lambda m: today + dt.timedelta(days=7)),
        (rf"\b(?:(?:next|this|on|coming|this coming) )?({WEEKDAY_ALT})\b",
         lambda m: _next_weekday(today, WEEKDAYS[m[1]])),
        (rf"\b({MONTH_ALT})\.? (\d{{1,2}})(?:st|nd|rd|th)?\b",
         lambda m: _future_month_day(today, MONTHS[m[1]], int(m[2]))),
        (rf"\b(\d{{1,2}})(?:st|nd|rd|th)? (?:of )?({MONTH_ALT})\b",
         lambda m: _future_month_day(today, MONTHS[m[2]], int(m[1]))),
        (r"\bthe (\d{1,2})(?:st|nd|rd|th)\b",
         lambda m: _future_day_of_month(today, int(m[1]))),
    ]
    for pat, fn in pats:
        m = re.search(pat, s)
        if not m:
            continue
        try:
            d = fn(m)
        except ValueError:
            d = None
        if d and d >= today:
            return d, m.span()
    return None, None


# ---------------------------------------------------------------- tier 1

FILLER = r"(?:(?:ok(?:ay)?|um+|uh+|so|and|alright|right|yeah|yes|please|assistant)[ ,]+)*"
TAIL = r"(?:[ ,]+(?:please|thanks|thank you))?"


def _text_after(original: str, prefix_re: str) -> str | None:
    """Text after a command prefix, keeping the owner's original casing."""
    m = re.match(rf"^\s*{FILLER}{prefix_re}[\s,:.\-]*(.+?)\s*$", original.replace("’", "'"), re.I | re.S)
    if not m:
        return None
    t = m.group(m.lastindex).strip().rstrip(".")
    return t[:1].upper() + t[1:] if t else None


SIMPLE = [
    ("done", r"(?:it'?s |that'?s |this is |mark (?:it |this |that )?(?:as )?)?(?:done|finished|complete|completed|sorted|handled|dealt with)(?: (?:with )?(?:it|this|that))?|tick (?:it|this)(?: off)?|check (?:it|this) off|yes,? done"),
    ("drop", r"drop(?: (?:it|this|that)(?: one)?)?|(?:bin|scrap|kill|trash|delete|ditch|discard|toss) (?:it|this|that)(?: one)?|not (?:worth it|needed|relevant)|forget (?:it|this|that)|dropped"),
    ("next", r"next(?: one| item| card| please)?|go (?:on|forward)|move on|continue|forward"),
    ("prev", r"back|go back|previous(?: one| item| card)?|prev|last one|back one|go back one"),
    ("skip", r"skip(?: (?:it|this|that)(?: one)?(?: for now)?)?|pass|leave (?:it|this)(?: for now)?"),
    ("undo", r"undo(?: (?:that|it|the last one))?|oops|whoops|take that back|revert(?: that)?"),
    ("stop", r"stop(?: listening)?|pause(?: listening)?|that'?s (?:it|all)(?: for now)?|i'?m done for now|end session|quit|stop voice"),
]


YES_WORDS = {"yes", "yeah", "yep", "yup", "yea", "sure", "correct", "affirmative", "yes please"}
NO_WORDS = {"no", "nope", "nah", "negative", "no thanks", "no thank you"}
PICK_NUM = {**{k: v for k, v in NUM_WORDS.items() if v <= 9 and k not in ("a", "an", "couple", "a couple")},
            **{k: v for k, v in ORD_WORDS.items() if v <= 9}, **{str(n): n for n in range(1, 10)}}
PICK_FILLER = re.compile(
    r"^(?:(?:ok(?:ay)?|um+|uh+|so|and|alright|right|well|hmm+|assistant)[ ,]+)*"
    r"(?:(?:let'?s|i'?ll|i will|we'?ll) (?:go with |pick |choose |take |say )?|go with |pick |choose |take |"
    r"i (?:pick|choose|say) |i'?d say |the answer is |answer |make it )?")


def pick_option(transcript: str, options: list[str]) -> dict | None:
    """Which of the card's options the owner named, if they named exactly one."""
    if not options:
        return None
    s = norm(transcript)
    s = re.sub(rf"{TAIL}$", "", s).strip(" .,!?")
    s = PICK_FILLER.sub("", s, count=1).strip(" .,!?")
    reason = None
    m = re.match(r"^(.+?)[ ,:;-]+(?:because|cause|'cause|since|as) (.+)$", s)
    if m:
        s, reason = m.group(1).strip(" ,"), m.group(2).strip()
    key = lambda x: re.sub(r"[^a-z0-9' ]+", " ", x.lower().replace("’", "'")).split()
    said = key(s)
    if not said:
        return None
    hit = None
    # "option two", "number 2", "the second one", "first", "2"
    nm = re.fullmatch(r"(?:(?:option|number|choice|answer) )?(?:the )?(\w+)(?: (?:one|option|choice))?", " ".join(said))
    if nm and nm.group(1) in PICK_NUM:
        n = PICK_NUM[nm.group(1)]
        if 1 <= n <= len(options):
            hit = options[n - 1]
    if hit is None:
        phrase = " ".join(said)
        bare = re.sub(r" (?:it|this|that|them|one|please)$", "", phrase)
        for o in options:
            k = " ".join(key(o))
            if k in (phrase, bare) or re.sub(r" (?:it|this|that|them)$", "", k) in (phrase, bare):
                hit = o
                break
            if k == "yes" and (phrase in YES_WORDS or bare in YES_WORDS):
                hit = o
                break
            if k == "no" and (phrase in NO_WORDS or bare in NO_WORDS):
                hit = o
                break
    if hit is None:
        # A long label by its first word ("send" for "Send it now"), if only one starts so.
        firsts = [key(o)[0] if key(o) else "" for o in options]
        if len(said) == 1 and firsts.count(said[0]) == 1:
            hit = options[firsts.index(said[0])]
    if hit is None:
        return None
    out = {"action": "choose", "option": hit}
    if reason:
        out["text"] = reason[:1].upper() + reason[1:]
    return out


def tier1(transcript: str, today: dt.date, options: list[str] | None = None) -> dict | None:
    s = norm(transcript)
    if not s:
        return None
    core = re.sub(rf"^{FILLER}", "", s)
    core = re.sub(rf"{TAIL}$", "", core).strip(" .,!?")

    for action, pat in SIMPLE:
        if re.fullmatch(pat, core):
            return {"action": action}

    picked = pick_option(transcript, options or [])
    if picked:
        return picked

    # done / drop with a reason: "done, paid it", "drop because it's stale"
    m = re.match(r"^(done|finished|drop(?: it| this)?)(?:[ ,:.-]+(?:because|cause|since|as|note|with note|reason)?[ ,:]*)(.+)$", core)
    if m and m.group(2).strip():
        act = "done" if m.group(1) in ("done", "finished") else "drop"
        text = _text_after(transcript, r"(?:done|finished|drop(?: it| this)?)[ ,:.-]*(?:because|cause|since|as|note|with note|reason)?")
        return {"action": act, "text": text}

    # comment / ask / tell the assistant
    for action, prefix in (
        ("assistant", r"(?:tell (?:the )?assistant|tell her|tell it|hand (?:it |this )?(?:off )?to (?:the )?assistant|hand off|for (?:the )?assistant|(?:the )?assistant should|(?:the )?assistant can you|(?:the )?assistant please|have (?:the )?assistant|get (?:the )?assistant to|let (?:the )?assistant know)(?: to| that)?"),
        ("ask", r"(?:ask(?: (?:the )?assistant)?|question(?: for (?:the )?assistant)?|query)(?: whether| if| about)?"),
        ("comment", r"(?:comment|add (?:a )?comment|add (?:a )?note|note to self|note(?: that)?|leave (?:a )?note|make (?:a )?note)(?: that)?"),
    ):
        if re.match(rf"^{prefix}\b", core):
            text = _text_after(transcript, prefix)
            if text:
                if action == "ask" and not text.endswith("?"):
                    text += "?"
                return {"action": action, "text": text}
            return None  # "comment" with nothing after it: let tier 2 / the UI decide

    # reschedule. A date in the past ("last Tuesday", "yesterday") is not a reschedule
    # the grammar can be sure of; hand it to tier 2, whose answer is validated.
    if re.search(rf"\b(?:last|past|ago|yesterday)\b", core) and not re.search(r"\blast one\b", core):
        return None
    later_words = r"(?:reschedule|re-schedule|snooze|postpone|push|move|defer|bump|remind me|later|come back to (?:it|this)|revisit|put (?:it|this) off)"
    if re.match(rf"^{later_words}\b", core):
        d, _ = parse_date(core, today)
        if d:
            return {"action": "reschedule", "date": d.isoformat()}
        if re.fullmatch(r"(?:later|later please|come back to (?:it|this)(?: later)?|snooze(?: it| this)?|remind me later|push (?:it|this)(?: back)?)", core):
            return {"action": "reschedule", "date": (today + dt.timedelta(days=1)).isoformat()}
        return None
    if re.fullmatch(r"(?:not now|do it later|deal with (?:it|this) later)", core):
        return {"action": "reschedule", "date": (today + dt.timedelta(days=1)).isoformat()}
    if _is_bare_date(core):
        d, _ = parse_date(core, today)
        if d:
            return {"action": "reschedule", "date": d.isoformat()}
    return None


def _is_bare_date(core: str) -> bool:
    """'tomorrow', 'Nov 3', 'till next week', 'monday': the whole utterance is a date."""
    rest = _spoken_numbers(core)
    rest = re.sub(r"^(?:to|till|til|until|for|on|by|next|this|coming)\s+", "", rest)
    return bool(re.fullmatch(
        rf"(?:(?:the )?(?:day after )?tomorrow|today|next week|next month|(?:this |the )?weekend|end of (?:the |this )?week|"
        rf"in \d+ (?:days?|weeks?|months?)|\d+ (?:days?|weeks?)|a week|a fortnight|"
        rf"(?:next |this |coming )?(?:{WEEKDAY_ALT})|(?:{MONTH_ALT})\.? \d{{1,2}}(?:st|nd|rd|th)?|\d{{1,2}}(?:st|nd|rd|th)? (?:of )?(?:{MONTH_ALT})|"
        rf"the \d{{1,2}}(?:st|nd|rd|th)|\d{{4}}-\d{{2}}-\d{{2}})", rest))


# ---------------------------------------------------------------- tier 2

JEV_CRITERIA = {
    "done": "Mark the current item done, finished, handled or already taken care of",
    "drop": "Drop, discard or delete the current item; it is not worth doing",
    "reschedule": "Postpone or snooze the current item to a later day",
    "comment": "Leave a note or comment on the current item",
    "ask": "Ask the assistant a question about the current item",
    "assistant": "Hand the item to the assistant or tell it to do something with it",
    "next": "Move on to the next item without acting",
    "prev": "Go back to the previous item",
    "skip": "Skip this item for now and leave it untouched",
    "undo": "Undo the last action",
    "stop": "Stop listening, pause or end the voice session",
    "unknown": "Not a command for the triage app: chatter, talking to someone else, or unclear",
}

STRIP_PREFIX = re.compile(
    r"^\s*(?:(?:ok(?:ay)?|so|um+|uh+|hey|assistant)[ ,]+)*"
    r"(?:(?:can|could) you |please |would you )?"
    r"(?:(?:ask|tell|let) (?:(?:the )?assistant|her|it) (?:know )?(?:to |that |whether |if |about )?|"
    r"(?:add|leave|make|write) (?:a )?(?:note|comment)(?: that| saying)?|note that|i want to note that|"
    r"have (?:the )?assistant |get (?:the )?assistant to |(?:the )?assistant(?: should| can| could| please)? )",
    re.I)


def local_text(transcript: str) -> str:
    t = (transcript or "").strip()
    m = STRIP_PREFIX.match(t)
    if m and m.end() < len(t):
        t = t[m.end():]
    t = t.strip().rstrip(".")
    return t[:1].upper() + t[1:]


def sec_get(spec: str) -> str | None:
    """Resolve a secret spec. "env:NAME" reads an environment variable; "file:KEY"
    asks a `sec get file KEY` command (a SOPS/age wrapper), if you have one."""
    if spec.startswith("env:"):
        return os.environ.get(spec[4:]) or None
    try:
        f, k = spec.split(":", 1)
        r = subprocess.run(["sec", "get", f, k], capture_output=True, text=True, timeout=20)
    except (ValueError, FileNotFoundError, subprocess.TimeoutExpired):
        return None
    v = r.stdout.strip()
    return v if r.returncode == 0 and v else None


def _post_json(url: str, body: dict, key: str, timeout: float = 8) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "User-Agent": "intake-triage/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def jev_choose(transcript: str, phase: str) -> dict:
    """Returns {"choice", "confidence", "probabilities"}. Raises on failure."""
    key = sec_get(JEV_SECRET)
    if not key:
        raise LookupError(f"no Jev key at '{JEV_SECRET}'")
    where = "an action item (a to-do)" if phase == "action" else "an awareness item (an FYI)"
    out = _post_json("https://api.typesafe.ai/v1/systemone", {
        "model": JEV_MODEL,
        "state": f'The owner is triaging {where} in their intake list by voice and said: "{transcript}"',
        "questions": {"action": {"type": "choice",
                                 "instructions": "Which command did the owner give for the current item?",
                                 "criteria": JEV_CRITERIA}},
    }, key)
    a = out["answers"]["action"]
    return {"choice": a["choice"], "confidence": float(a.get("confidence", 0)),
            "probabilities": a.get("probabilities", {})}


LLM_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["action", "date", "text"],
    "properties": {
        "action": {"type": "string", "enum": ACTIONS},
        "date": {"type": ["string", "null"], "description": "YYYY-MM-DD for reschedule, else null"},
        "text": {"type": ["string", "null"], "description": "comment, question, instruction for the assistant, or reason; else null"},
    },
}


def llm_parse(transcript: str, today: dt.date, phase: str) -> dict:
    key = sec_get(LLM_SECRET)
    if not key:
        raise LookupError(f"no LLM key at sec '{LLM_SECRET}'")
    sys_prompt = (
        "You turn one spoken command into JSON for a to-do triage app. "
        f"Today is {today.strftime('%A')} {today.isoformat()} (America/Los_Angeles). "
        "Actions: done (finished/handled), drop (discard; optional reason in text), "
        "reschedule (needs date, never in the past; 'next week' = today + 7 days, a weekday = its next occurrence), "
        "comment (note in text), ask (a question for the assistant, in text), "
        "assistant (an instruction for the assistant, in text), next, prev, skip, undo, stop (stop listening), "
        "unknown (not a command, or unclear). Keep text in the speaker's words, minus the command words. "
        "If unsure, answer unknown.")
    out = _post_json(LLM_URL, {
        "model": LLM_MODEL,
        "temperature": 0,
        "messages": [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": transcript}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "intent", "strict": True, "schema": LLM_SCHEMA}},
    }, key, timeout=12)
    return json.loads(out["choices"][0]["message"]["content"])


def validate(intent: dict, today: dt.date) -> dict:
    """Clamp a tier-2 answer to the schema; anything inconsistent becomes unknown."""
    a = intent.get("action")
    if a not in ACTIONS:
        return {"action": "unknown"}
    out = {"action": a}
    text = (intent.get("text") or "").strip()
    if a == "reschedule":
        try:
            d = dt.date.fromisoformat(intent.get("date") or "")
        except ValueError:
            return {"action": "unknown", "why": "no date"}
        if d < today:
            return {"action": "unknown", "why": "date in the past"}
        out["date"] = d.isoformat()
    elif a in NEEDS_TEXT:
        if not text:
            return {"action": "unknown", "why": "nothing to say"}
        out["text"] = text
    elif a in ("done", "drop") and text:
        out["text"] = text
    return out


def tier2(transcript: str, today: dt.date, phase: str = "action",
          jev=jev_choose, llm=llm_parse) -> dict:
    notes = []
    try:
        j = jev(transcript, phase)
    except Exception as e:  # noqa: BLE001
        j = None
        notes.append(f"jev: {type(e).__name__}: {e}"[:200])
    if j and j["confidence"] >= JEV_MIN_CONFIDENCE:
        a = j["choice"]
        res = {"action": a, "tier": 2, "via": "jev", "confidence": round(j["confidence"], 3)}
        if a == "reschedule":
            d, _ = parse_date(transcript, today)
            if d:
                res.update(date=d.isoformat(), via="jev+local")
                return res
        elif a in NEEDS_TEXT:
            res.update(text=local_text(transcript), via="jev+local")
            if a == "ask" and not res["text"].endswith("?"):
                res["text"] += "?"
            return res
        else:
            return res
    try:
        out = validate(llm(transcript, today, phase), today)
        out.update(tier=2, via="llm")
        if j:
            out["jev"] = {"choice": j["choice"], "confidence": round(j["confidence"], 3)}
        return out
    except Exception as e:  # noqa: BLE001
        notes.append(f"llm: {type(e).__name__}: {e}"[:200])
    return {"action": "unknown", "tier": 2, "via": "none", "why": "; ".join(notes) or "low confidence"}


def parse(transcript: str, today: dt.date, phase: str = "action", options: list[str] | None = None, **kw) -> dict:
    t = (transcript or "").strip()
    if not t:
        return {"action": "unknown", "tier": 1, "via": "grammar", "transcript": t}
    r = tier1(t, today, options)
    if r:
        r = {k: v for k, v in r.items() if v is not None}
        r.update(tier=1, via="grammar")
    else:
        r = tier2(t, today, phase, **kw)
    r["transcript"] = t
    return r
