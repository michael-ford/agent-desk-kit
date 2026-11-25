"""Talk it through: speech-to-speech triage with a realtime voice model.

The browser holds the audio connection. This module does everything that
needs trust or the vault:

  * mints a short-lived client secret for the provider (the real API key is
    fetched with `sec` per request and never leaves this process),
  * writes the model's instructions: who the owner is, what the intake is, every
    open item, its job and the rules it must keep,
  * runs the model's tool calls against the vault through the same
    do_action / do_undo path the buttons use, so every change is a
    path-scoped commit with undo.

The provider seam is `PROVIDERS`: a provider turns (instructions, tools) into
connection details for the browser. The browser has a matching adapter in
static/talk-<provider>.js.

Server functions are passed in as `backend` (the server module itself), so
there is one WRITE_LOCK and one undo stack.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid

import voice

PROVIDER = os.environ.get("INTAKE_TALK_PROVIDER", "openai")
MODEL = os.environ.get("INTAKE_TALK_MODEL", "gpt-realtime-2.1")
REASONING = os.environ.get("INTAKE_TALK_REASONING", "low")  # minimal | low | medium | high | xhigh
VOICE = os.environ.get("INTAKE_TALK_VOICE", "cedar")
TRANSCRIBE = os.environ.get("INTAKE_TALK_TRANSCRIBE", "gpt-4o-mini-transcribe")
NOISE = os.environ.get("INTAKE_TALK_NOISE", "far_field")  # near_field for a headset
# First spec that resolves wins ("env:NAME" or a `sec` "file:KEY"; see voice.sec_get).
SECRETS = os.environ.get("INTAKE_TALK_SECRET", "env:OPENAI_API_KEY")
# Who the voice aide is talking to, for its instructions.
OWNER_NAME = os.environ.get("INTAKE_OWNER_NAME", "the owner")
TZ_NAME = os.environ.get("INTAKE_TZ", "America/Los_Angeles")
TOKEN_TTL = 120  # seconds the browser has to open the connection; the session itself lasts up to 60 min

ACTION_TOOLS = {"mark_done": "done", "choose_option": "choose", "drop": "drop", "reschedule": "snooze", "add_comment": "comment",
                "reclassify": "reclassify", "ask_assistant": "ask", "hand_to_assistant": "assistant"}
BATCH_ACTIONS = ("mark_done", "drop", "reschedule", "reclassify", "add_comment", "hand_to_assistant")
DONE_WORDS = {"done": "Marked done", "choose": "Chose", "drop": "Dropped", "snooze": "Rescheduled", "comment": "Comment added",
              "reclassify": "Reclassified", "ask": "Asked the assistant", "assistant": "Handed to the assistant"}

YES_RE = re.compile(
    r"^\W*(?:(?:yes|yeah|yep|yup|yea|sure|ok|okay|correct|right|absolutely|definitely|please|confirmed?|"
    r"affirmative|go ahead|go for it|do it|do that|do them|do all|sounds good|that's right|that is right|"
    r"all of them|all three|all two|all four|all five|clear them|mark them|drop them|yes please)\b)", re.I)
NO_RE = re.compile(r"\b(?:no|nope|not|don't|do not|wait|hold on|hang on|stop|cancel|never ?mind|except|but|"
                   r"what|which|why|how|who|maybe|later|actually)\b", re.I)


def is_yes(text: str) -> bool:
    """A clear yes: short, starts affirmatively, and has no hedge, negation or question in it."""
    t = (text or "").strip()
    return (bool(t) and len(t.split()) <= 10 and "?" not in t
            and bool(YES_RE.match(t)) and not NO_RE.search(t))


# ---------------------------------------------------------------- tool schemas (provider-neutral JSON Schema)

ID = {"type": "string", "description": "Item id from the page list, e.g. \"i12\". Never say ids aloud."}
TOOLS = [
    {"name": "next_item", "description": "Highlight the next open item after the current one (actions in page order, then awareness) and return it. Use it when the owner says next, or when you move on.",
     "parameters": {"type": "object", "properties": {"phase": {"type": "string", "enum": ["action", "awareness"], "description": "Jump to the first open item of this phase instead."}}, "additionalProperties": False}},
    {"name": "get_item", "description": "Return one item's full current state, including notes and the assistant's answers, and highlight it on the owner's screen. Call it whenever you bring an item up.",
     "parameters": {"type": "object", "properties": {"id": ID}, "required": ["id"], "additionalProperties": False}},
    {"name": "mark_done", "description": "Mark one item done (handled, nothing more needed). Applies at once; the owner can undo.",
     "parameters": {"type": "object", "properties": {"id": ID, "note": {"type": "string", "description": "Optional short note, in the owner's words."}}, "required": ["id"], "additionalProperties": False}},
    {"name": "choose_option", "description": "Record the owner's decision on an item that offers options (its options are listed on the page and in get_item). Closes the item as done with their choice. Applies at once; the owner can undo.",
     "parameters": {"type": "object", "properties": {"id": ID, "option": {"type": "string", "description": "One of the item's options, exactly as listed."}, "note": {"type": "string", "description": "Optional short reason, in the owner's words."}}, "required": ["id", "option"], "additionalProperties": False}},
    {"name": "drop", "description": "Drop one item (not doing it). Applies at once; the owner can undo.",
     "parameters": {"type": "object", "properties": {"id": ID, "reason": {"type": "string"}}, "required": ["id"], "additionalProperties": False}},
    {"name": "reschedule", "description": "Hide one item until a date. The date must be today or later, ISO YYYY-MM-DD; resolve words like Monday yourself from today's date.",
     "parameters": {"type": "object", "properties": {"id": ID, "date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}, "note": {"type": "string"}}, "required": ["id", "date"], "additionalProperties": False}},
    {"name": "add_comment", "description": "Add the owner's comment under one item, for the record (The assistant reads these).",
     "parameters": {"type": "object", "properties": {"id": ID, "text": {"type": "string"}}, "required": ["id", "text"], "additionalProperties": False}},
    {"name": "reclassify", "description": "Move one item between the action list and the awareness digest.",
     "parameters": {"type": "object", "properties": {"id": ID, "kind": {"type": "string", "enum": ["action", "awareness"]}}, "required": ["id", "kind"], "additionalProperties": False}},
    {"name": "undo_last", "description": "Undo the most recent change made in this conversation (a whole batch counts as one).",
     "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "ask_assistant", "description": "Ask the assistant a question about one item. Returns at once; its answer arrives later as an app update. Don't wait for it.",
     "parameters": {"type": "object", "properties": {"id": ID, "question": {"type": "string"}}, "required": ["id", "question"], "additionalProperties": False}},
    {"name": "hand_to_assistant", "description": "Hand one item to the assistant with an instruction (it picks it up from its triage inbox later).",
     "parameters": {"type": "object", "properties": {"id": ID, "text": {"type": "string", "description": "What the assistant should do."}}, "required": ["id", "text"], "additionalProperties": False}},
    {"name": "batch", "description": (
        "Apply one action to several items. Two steps, always: first call WITHOUT confirm_id to propose it; "
        "you get back a confirm_id and the list. Tell the owner in one line what it covers and ask. Only after they "
        "clearly say yes, call again with just confirm_id. The app checks that they did; a proposal they didn't "
        "agree to is refused."),
     "parameters": {"type": "object", "properties": {
         "action": {"type": "string", "enum": list(BATCH_ACTIONS)},
         "ids": {"type": "array", "items": ID, "minItems": 2, "maxItems": 40},
         "note": {"type": "string", "description": "Note, reason, comment or instruction, depending on the action."},
         "date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$", "description": "For reschedule."},
         "kind": {"type": "string", "enum": ["action", "awareness"], "description": "For reclassify."},
         "confirm_id": {"type": "string", "description": "From the proposal, once the owner has said yes."}},
         "additionalProperties": False}},
]
TOOL_NAMES = {t["name"] for t in TOOLS}


# ---------------------------------------------------------------- instructions

def clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def plain(s: str) -> str:
    """Markdown emphasis and code ticks off, for labels the owner reads."""
    return re.sub(r"\*\*|`", "", s or "")


def item_status(it: dict, today: dt.date) -> str:
    if it["checked"]:
        d = (it.get("disposition") or "").lower()
        return "dropped" if d.startswith("dropped") else "done"
    if it.get("snoozedUntil") and it["snoozedUntil"] > today.isoformat():
        return f"snoozed until {it['snoozedUntil']}"
    return "open"


def item_line(it: dict, today: dt.date) -> str:
    bits = [f"i{it['id']}", it["kind"] + ("" if it.get("kindSource") == "tag" else " (guessed)"),
            f"{it['age']}d old", it.get("board") or "no board", it.get("project") or "no project",
            it.get("source") or "no source"]
    st = item_status(it, today)
    if st != "open":
        bits.append(st.upper())
    out = " | ".join(bits) + "\n   " + clip(it["text"], 420)
    if it.get("options") and st == "open":
        out += "\n   options: " + " / ".join(it["options"])
    for n in it.get("notes", []):
        who = n["who"] or "note"
        if n["kind"] == "question":
            out += f"\n   - the owner asked the assistant ({n['stamp']}): {clip(n['text'], 200)}"
        else:
            out += f"\n   - {who}{' (' + n['stamp'] + ')' if n.get('stamp') else ''}: {clip(n['text'], 320)}"
    if it.get("pendingAsk"):
        out += "\n   - (waiting for the assistant's answer)"
    return out


def instructions(data: dict, now: dt.datetime, resume: dict | None = None) -> str:
    today = now.date()
    items = [it for it in data["items"] if not it["checked"]]
    acts = [it for it in items if it["kind"] == "action"]
    aw = [it for it in items if it["kind"] == "awareness"]
    resolved = len(data["items"]) - len(items)
    when = now.strftime("%A %-d %B %Y, %H:%M")
    page = "\n".join(item_line(it, today) for it in acts + aw)
    text = f"""You are {OWNER_NAME}'s chief of staff for one job right now: going through today's intake with them, out loud.

# Who you're talking to
{OWNER_NAME} is busy and runs several projects at once, and doesn't want noise. The assistant is their project manager: an agent who runs their issue boards (ME is the board for work that needs {OWNER_NAME}'s own hands; AGENT is the assistant's), their notes and this intake. It is {when} local time ({TZ_NAME}) now.

# What the intake is
The assistant's ingestion sweep stages everything project-shaped that arrived (messages, email, chat, GitHub, issue boards, meeting transcripts and so on) as one line per item on a daily page. Lines under an item are notes: the assistant's evidence ("looks resolved: the owner replied at 14:54"), the owner's comments, their questions to the assistant and its answers. Each item is either action (needs a decision or the owner's hands) or awareness (so they know). What the owner decides here is what the assistant turns into real work afterwards, so the dispositions matter:
- done: handled, nothing more needed
- drop: not doing it
- reschedule: hide it until a date
- comment: a note for the record
- hand to the assistant: it takes it from here (an issue, a chase, a reply draft)
- ask the assistant: a question it answers on the page, usually within minutes
Many action items pose one decision, and the page lists its choices under the item ("options: Retire / Keep"). The owner's answer to that question is the disposition: record it with choose_option, which closes the item with their choice and any reason they give. If they answer with something that isn't one of the options, it's a comment or a hand-off, not a choice.

# Your job
Be the sharp, dry-witted chief of staff who read the whole page before they sat down. Help them get through it quickly and well.
- Bring up what matters first: deadlines, people waiting on them, money. Group related items and notice patterns ("three of these are calendar invites, all accepted. Clear them?").
- Propose a disposition when you have one, with the reason in a clause.
- Answer their questions from the page and the assistant's notes. When the page doesn't say, say so and offer to ask the assistant.
- Follow their lead. Item by item, jumping around, only the invites: whatever they want. There is no script.

# Rules you keep (these are your acceptance criteria)
1. Changes happen only through your tools. Never say anything is done, dropped, moved, noted, asked or handed over unless the tool returned ok true. If a tool fails, say so plainly and briefly.
2. A clear instruction about one item: just do it and confirm in a word or two. They can say undo. Anything covering more than one item goes through batch: propose, say in one line what it covers, and wait for a clear yes before confirming. Silence, "hmm" or a question is not a yes.
3. Be brief. One or two short sentences a turn. Don't read items out in full, don't recap, don't narrate what you're about to do. They can see the screen. Refer to items by their gist ("the invoice one"), never by id.
4. Facts come only from this page, the assistant's notes and the assistant's answers. If you're not sure, say so. Never guess dates, amounts or who said what.
5. ask_assistant doesn't block. Ask, say you've asked, and carry on. Its answer arrives later as an app update; bring it up at a natural pause.
6. You can't send messages, emails or anything beyond this page, so never offer to. Hand it to the assistant or note it for the owner.
7. Messages that start with "[App update" come from the app, not from the owner. Use them, but don't answer them as if they spoke.
8. Call get_item when you bring an item up, so it lights up on their screen.

# Starting
Open with one short line, then the one thing most worth their attention, or the shape of the page in a sentence. Then let them drive.

# The page: {data['file']}
{len(acts)} open actions, {len(aw)} awareness items, {resolved} already resolved. Lines read: id | phase | age | board | project | source, then the text and its notes.

{page}
"""
    if resume:
        text += "\n# Resumed conversation\n" + resume_text(resume)
    return text


def resume_text(resume: dict) -> str:
    out = ("The voice connection was reopened mid-conversation (a dropped line or the session time limit). "
           "Don't greet them again; carry on from where you were.\n")
    log = resume.get("log") or []
    if log:
        out += "Changes made so far in this conversation (all committed):\n" + "\n".join(
            f"- {e['label']}{' (since undone)' if e.get('undone') else ''}" for e in log[-30:]) + "\n"
    if resume.get("pending"):
        out += f"A batch proposal was waiting for their yes: {resume['pending']}. Ask again if it still matters.\n"
    caps = resume.get("captions") or []
    if caps:
        out += "The last few lines of the conversation:\n" + "\n".join(
            f"{'Owner' if c.get('who') == 'you' else 'You'}: {clip(c.get('text', ''), 240)}" for c in caps[-8:]) + "\n"
    if resume.get("focus"):
        out += f"The item on screen: {resume['focus']}.\n"
    return out


# ---------------------------------------------------------------- providers

class ProviderError(Exception):
    pass


def fetch_key() -> str:
    for spec in [s.strip() for s in SECRETS.split(",") if s.strip()]:
        v = voice.sec_get(spec)
        if v:
            return v
    raise LookupError("No OpenAI key for Talk it through. Set OPENAI_API_KEY in the server's "
                      "environment (or point INTAKE_TALK_SECRET at another spec).")


class OpenAIRealtime:
    """OpenAI Realtime over WebRTC. The server mints an ephemeral client secret
    with the full session config baked in; the browser uses it once to post its
    SDP offer. The secret expires in TOKEN_TTL seconds and can't be used to
    change the session's instructions or tools from outside this server's say."""
    name = "openai"
    url = "https://api.openai.com/v1/realtime/client_secrets"
    calls_url = "https://api.openai.com/v1/realtime/calls"

    def __init__(self, key_fn=fetch_key, post=None):
        self.key_fn = key_fn
        self.post = post or self._post

    def session_config(self, instr: str) -> dict:
        cfg = {
            "type": "realtime",
            "model": MODEL,
            "instructions": instr,
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "transcription": {"model": TRANSCRIBE, "language": "en"},
                    "noise_reduction": {"type": NOISE},
                    "turn_detection": {"type": "semantic_vad", "eagerness": "auto",
                                       "create_response": True, "interrupt_response": True},
                },
                "output": {"voice": VOICE},
            },
            "tools": [{"type": "function", **t} for t in TOOLS],
            "tool_choice": "auto",
        }
        if MODEL.startswith("gpt-realtime-2"):
            cfg["reasoning"] = {"effort": REASONING}
        return cfg

    def mint(self, instr: str) -> dict:
        body = {"expires_after": {"anchor": "created_at", "seconds": TOKEN_TTL}, "session": self.session_config(instr)}
        res = self.post(self.url, body, self.key_fn())
        if not res.get("value"):
            raise ProviderError("The provider returned no client secret.")
        return {"provider": self.name, "model": MODEL, "voice": VOICE, "token": res["value"],
                "expiresAt": res.get("expires_at"), "connect": {"kind": "webrtc", "url": self.calls_url}}

    @staticmethod
    def _post(url: str, body: dict, key: str) -> dict:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "intake-triage/3.0"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            # Report the provider's own message, never the request (it carries the key).
            try:
                msg = json.loads(e.read()).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                msg = ""
            raise ProviderError(f"OpenAI refused the session ({e.code}): {msg[:300]}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise ProviderError(f"Couldn't reach OpenAI: {type(e).__name__}") from None


class FakeProvider:
    """For demos and browser tests: the browser's fake adapter plays the model."""
    name = "fake"

    def mint(self, instr: str) -> dict:
        return {"provider": "fake", "model": "fake", "voice": None, "token": None, "connect": {"kind": "fake"},
                "instructionsChars": len(instr)}


PROVIDERS = {"openai": OpenAIRealtime, "fake": FakeProvider}


# ---------------------------------------------------------------- sessions and tools

class ToolError(Exception):
    pass


class TalkSession:
    def __init__(self, desk: "TalkDesk", file: str):
        self.desk = desk
        self.b = desk.backend
        self.id = uuid.uuid4().hex[:12]
        self.file = file
        self.created = time.time()
        self.lock = threading.Lock()
        self.known: dict[str, str] = {}   # id -> text when the model last saw it
        self.log: list[dict] = []         # [{seq, label, undoIds, ids, at, undone}]
        self.pending: dict[str, dict] = {}
        self.focus: str | None = None
        self.connects = 0

    # -- page access
    def data(self) -> dict:
        return self.b.parse_file(self.b.resolve_file(self.file))

    def snapshot(self, data: dict) -> None:
        for it in data["items"]:
            self.known[f"i{it['id']}"] = it["text"]

    def resolve(self, iid, data: dict | None = None) -> dict:
        iid = str(iid or "").strip().lower()
        if not re.fullmatch(r"i\d+", iid):
            raise ToolError(f"{iid or 'That'} isn't an item id. Ids look like i12.")
        data = data or self.data()
        n = int(iid[1:])
        by_id = {it["id"]: it for it in data["items"]}
        want = self.known.get(iid)
        it = by_id.get(n)
        if it and (want is None or it["text"] == want):
            return it
        if want is not None:
            same = [x for x in data["items"] if x["text"] == want]
            if len(same) == 1:
                return same[0]
        raise ToolError(f"No item {iid} on the page any more (the page may have changed). Use get_item on what you can see.")

    def brief(self, it: dict) -> dict:
        today = self.b.today_pt()
        assistant = [n for n in it.get("notes", []) if n["who"] == "Assistant"]
        out = {"id": f"i{it['id']}", "status": item_status(it, today), "phase": it["kind"],
               "age_days": it["age"], "board": it.get("board"), "project": it.get("project"),
               "source": it.get("source"), "text": clip(it["text"], 600), "options": it.get("options") or None,
               "notes": [{"who": n["who"] or "note", "kind": n["kind"], "when": n.get("stamp"), "text": clip(n["text"], 500)}
                         for n in it.get("notes", [])]}
        if it.get("pendingAsk"):
            out["waiting_for_assistant"] = it["pendingAsk"]["text"]
        if assistant and assistant[-1].get("resolved"):
            out["assistant_thinks_resolved"] = True
        return out

    def counts(self, data: dict) -> dict:
        today = self.b.today_pt().isoformat()
        open_ = [it for it in data["items"] if not it["checked"] and not (it.get("snoozedUntil") and it["snoozedUntil"] > today)]
        return {"open_actions": sum(it["kind"] == "action" for it in open_),
                "open_awareness": sum(it["kind"] == "awareness" for it in open_)}

    # -- writes
    def apply(self, it: dict, action: str, text: str = "", **extra) -> dict:
        req = {"action": action, "file": self.file, "raw": it["raw"], "occurrence": it["occurrence"], "text": text or "", **extra}
        try:
            return self.b.do_action(req)
        except self.b.Conflict as e:
            raise ToolError(f"The item changed on disk just now, so nothing was written: {e}") from None
        except ValueError as e:
            raise ToolError(str(e)) from None

    def record(self, label: str, undo_ids: list[str], ids: list[str]) -> dict:
        e = {"seq": len(self.log) + 1, "label": label, "undoIds": undo_ids, "ids": ids,
             "at": self.b.now_pt().strftime("%H:%M"), "undone": False}
        self.log.append(e)
        return e

    def undo_entry(self, entry: dict) -> dict:
        if entry["undone"]:
            raise ToolError("That change was already undone.")
        errors = []
        for u in reversed(entry["undoIds"]):
            try:
                self.b.do_undo(undo_id=u)
            except Exception as ex:  # noqa: BLE001
                errors.append(str(ex))
        if errors and len(errors) == len(entry["undoIds"]):
            raise ToolError("Couldn't undo: " + errors[0])
        entry["undone"] = True
        return {"undone": entry["label"], "partial_errors": errors or None}

    def check_date(self, s: str) -> str:
        try:
            d = dt.date.fromisoformat(str(s or ""))
        except ValueError:
            raise ToolError(f"{s!r} isn't a date. Use YYYY-MM-DD.") from None
        today = self.b.today_pt()
        if d < today:
            raise ToolError(f"{d.isoformat()} is in the past; today is {today.isoformat()}.")
        if d > today + dt.timedelta(days=366):
            raise ToolError("That's more than a year out. Pick a nearer date, or drop it.")
        return d.isoformat()

    def single(self, name: str, args: dict) -> tuple[dict, dict]:
        action = ACTION_TOOLS[name]
        data = self.data()
        it = self.resolve(args.get("id"), data)
        iid = f"i{it['id']}"
        text, extra = "", {}
        if name == "mark_done":
            text = args.get("note", "")
        elif name == "choose_option":
            opts = it.get("options") or []
            if not opts:
                raise ToolError("That item has no options; use mark_done, add_comment or another tool.")
            if not self.b.match_option(opts, args.get("option", "")):
                raise ToolError(f"Not one of its options. They are: {' / '.join(opts)}.")
            extra["option"] = args.get("option", "")
            text = args.get("note", "")
        elif name == "drop":
            text = args.get("reason", "")
        elif name == "reschedule":
            extra["date"] = self.check_date(args.get("date"))
            text = args.get("note", "")
        elif name in ("add_comment", "hand_to_assistant"):
            text = args.get("text", "")
            if not text.strip():
                raise ToolError("The text is empty.")
        elif name == "ask_assistant":
            text = args.get("question", "")
            if not text.strip():
                raise ToolError("The question is empty.")
        elif name == "reclassify":
            kind = args.get("kind")
            if kind not in ("action", "awareness"):
                raise ToolError("kind must be action or awareness.")
            if it["kind"] == kind and it.get("kindSource") == "tag":
                return {"ok": True, "note": f"Already tagged {kind}; nothing changed."}, {"focus": iid}
            extra["kind"] = kind
        if it["checked"] and name not in ("add_comment", "hand_to_assistant"):
            raise ToolError(f"That item is already {item_status(it, self.b.today_pt())}.")
        res = self.apply(it, action, text, **extra)
        label = DONE_WORDS[action] + (f" to {extra['date']}" if action == "snooze" else "") + \
            (f' "{res.get("option") or extra["option"]}"' if action == "choose" else "") + \
            (f" as {extra['kind']}" if action == "reclassify" else "") + f": {clip(plain(it['text']), 70)}"
        entry = self.record(label, [res["undoId"]], [iid])
        fresh = self.data()
        self.snapshot(fresh)
        out = {"ok": True, "did": label, "undo": "undo_last reverses it", **self.counts(fresh)}
        if res.get("warning"):
            out["warning"] = res["warning"]
        if name == "ask_assistant":
            out["note"] = "Asked. Its answer comes later as an app update; carry on meanwhile."
        ui = {"focus": iid, "changed": True, "log": entry}
        if name == "ask_assistant":
            ui["asked"] = iid
        return out, ui

    def batch(self, args: dict, heard: list[dict]) -> tuple[dict, dict]:
        cid = args.get("confirm_id")
        if cid:
            p = self.pending.get(cid)
            if not p:
                raise ToolError("That proposal isn't open any more. Propose it again.")
            said = [h for h in heard if float(h.get("at", 0)) / 1000 > p["created"]]
            yes = p.get("approved") or any(is_yes(h.get("text", "")) for h in said[-2:])
            if not yes:
                return {"ok": False, "status": "not_confirmed",
                        "error": "The owner hasn't clearly said yes since you proposed this, so nothing changed. Ask them, and wait for a yes."}, \
                    {"pending": self.pending_ui(cid)}
            del self.pending[cid]
            return self.run_batch(p)
        action = args.get("action")
        if action not in BATCH_ACTIONS:
            raise ToolError(f"batch action must be one of {', '.join(BATCH_ACTIONS)}.")
        ids = list(dict.fromkeys(str(i).lower() for i in (args.get("ids") or [])))
        if len(ids) < 2:
            raise ToolError("A batch needs at least two ids; use the single tool for one.")
        if len(ids) > 40:
            raise ToolError("Too many at once; 40 is the limit.")
        data = self.data()
        items = [self.resolve(i, data) for i in ids]
        extra = {}
        if action == "reschedule":
            extra["date"] = self.check_date(args.get("date"))
        if action == "reclassify":
            if args.get("kind") not in ("action", "awareness"):
                raise ToolError("kind must be action or awareness.")
            extra["kind"] = args["kind"]
        if action in ("add_comment", "hand_to_assistant") and not (args.get("note") or "").strip():
            raise ToolError("This batch needs the note text.")
        closed = [f"i{it['id']}" for it in items if it["checked"] and action not in ("add_comment", "hand_to_assistant")]
        if closed:
            raise ToolError(f"Already resolved, leave them out: {', '.join(closed)}.")
        self.pending.clear()  # one open proposal at a time
        cid = uuid.uuid4().hex[:6]
        self.pending[cid] = {"id": cid, "action": action, "ids": [f"i{it['id']}" for it in items],
                             "texts": [clip(plain(it["text"]), 80) for it in items], "note": args.get("note", ""),
                             "created": time.time(), **extra}
        summary = self.pending_summary(self.pending[cid])
        return {"ok": True, "status": "needs_confirmation", "confirm_id": cid, "summary": summary,
                "items": [{"id": f"i{it['id']}", "text": clip(it["text"], 100)} for it in items],
                "next": "Tell the owner in one line and ask. Call batch with confirm_id only after they say yes."}, \
            {"pending": self.pending_ui(cid), "focus": f"i{items[0]['id']}"}

    def pending_summary(self, p: dict) -> str:
        verb = {"mark_done": "Mark done", "drop": "Drop", "reschedule": f"Reschedule to {p.get('date')}",
                "reclassify": f"Move to {p.get('kind')}", "add_comment": "Comment on",
                "hand_to_assistant": "Hand to the assistant"}[p["action"]]
        return f"{verb}: {len(p['ids'])} items"

    def pending_ui(self, cid: str) -> dict | None:
        p = self.pending.get(cid)
        if not p:
            return None
        return {"id": cid, "summary": self.pending_summary(p), "items": p["texts"], "ids": p["ids"]}

    def run_batch(self, p: dict) -> tuple[dict, dict]:
        action = ACTION_TOOLS[p["action"]]
        data = self.data()
        undo_ids, done, failed = [], [], []
        for iid in p["ids"]:
            try:
                it = self.resolve(iid, data)
                extra = {k: p[k] for k in ("date", "kind") if k in p}
                res = self.apply(it, action, p.get("note", ""), **extra)
                undo_ids.append(res["undoId"])
                done.append(iid)
                data = self.data()
            except ToolError as e:
                failed.append({"id": iid, "error": str(e)})
        if not done:
            raise ToolError("None of them changed: " + failed[0]["error"])
        label = f"{self.pending_summary(p).split(':')[0]}: {len(done)} items"
        entry = self.record(label, undo_ids, done)
        fresh = self.data()
        self.snapshot(fresh)
        out = {"ok": True, "did": label, "changed": done, "undo": "undo_last reverses the whole batch", **self.counts(fresh)}
        if failed:
            out["failed"] = failed
        return out, {"changed": True, "log": entry, "pending": None}

    def call(self, name: str, args: dict, heard: list[dict] | None = None) -> tuple[dict, dict]:
        """Run one tool call. Returns (output for the model, ui hints for the browser)."""
        if name not in TOOL_NAMES:
            return {"ok": False, "error": f"There is no tool called {name}."}, {}
        if not isinstance(args, dict):
            return {"ok": False, "error": "Arguments must be an object."}, {}
        with self.lock:
            try:
                if name == "next_item":
                    data = self.data()
                    out, ui = self.next_item(data, args.get("phase"))
                elif name == "get_item":
                    it = self.resolve(args.get("id"))
                    self.focus = f"i{it['id']}"
                    out, ui = {"ok": True, "item": self.brief(it)}, {"focus": self.focus}
                elif name == "undo_last":
                    live = [e for e in self.log if not e["undone"]]
                    if not live:
                        raise ToolError("Nothing to undo in this conversation.")
                    r = self.undo_entry(live[-1])
                    fresh = self.data()
                    self.snapshot(fresh)
                    out, ui = {"ok": True, **r, **self.counts(fresh)}, {"changed": True, "log": live[-1],
                                                                         "focus": live[-1]["ids"][0] if len(live[-1]["ids"]) == 1 else None}
                elif name == "batch":
                    out, ui = self.batch(args, heard or [])
                else:
                    out, ui = self.single(name, args)
            except ToolError as e:
                return {"ok": False, "error": str(e)}, {}
            except FileNotFoundError as e:
                return {"ok": False, "error": f"The page isn't there: {e}"}, {}
        if ui.get("focus"):
            self.focus = ui["focus"]
        return out, ui

    def next_item(self, data: dict, phase: str | None) -> tuple[dict, dict]:
        today = self.b.today_pt().isoformat()
        open_ = [it for it in data["items"] if not it["checked"] and not (it.get("snoozedUntil") and it["snoozedUntil"] > today)]
        order = [it for it in open_ if it["kind"] == "action"] + [it for it in open_ if it["kind"] == "awareness"]
        if not order:
            return {"ok": True, "item": None, "note": "Nothing open is left on the page."}, {}
        if phase in ("action", "awareness"):
            pick = next((it for it in order if it["kind"] == phase), None)
            if not pick:
                return {"ok": True, "item": None, "note": f"No open {phase} items left."}, {}
        else:
            ids = [f"i{it['id']}" for it in order]
            if self.focus in ids:
                k = ids.index(self.focus)
                pick = order[k + 1] if k + 1 < len(order) else None
            else:
                # The focused item was just resolved (or nothing is focused): next in page order after it.
                cur = int(self.focus[1:]) if self.focus else -1
                cur_kind = next((it["kind"] for it in data["items"] if f"i{it['id']}" == self.focus), "action")
                rest = [it for it in order if (it["kind"] == cur_kind and it["id"] > cur) or (cur_kind == "action" and it["kind"] == "awareness")]
                pick = rest[0] if rest else None
            if not pick:
                return {"ok": True, "item": None, "note": "That was the last open item."}, {}
        self.focus = f"i{pick['id']}"
        self.known[self.focus] = pick["text"]
        return {"ok": True, "item": self.brief(pick), **self.counts(data)}, {"focus": self.focus}


class TalkDesk:
    """All talk sessions for this server process."""

    def __init__(self, backend, provider: str | None = None):
        self.backend = backend
        self.sessions: dict[str, TalkSession] = {}
        self.lock = threading.Lock()
        self.provider_name = provider or PROVIDER
        if self.provider_name not in PROVIDERS:
            raise ValueError(f"unknown talk provider {self.provider_name!r}")
        self.provider = PROVIDERS[self.provider_name]()

    def get(self, sid: str) -> TalkSession:
        s = self.sessions.get(str(sid or ""))
        if not s:
            raise ValueError("That talk session has ended. Start a new one.")
        return s

    def open(self, req: dict) -> dict:
        """New session, or a reconnect of an existing one (req.sid + req.resume)."""
        if req.get("sid"):
            s = self.get(req["sid"])
        else:
            name = req.get("file") or ""
            self.backend.resolve_file(name)  # validates the name
            s = TalkSession(self, name)
            with self.lock:
                self.sessions[s.id] = s
                for old in sorted(self.sessions.values(), key=lambda x: x.created)[:-5]:
                    del self.sessions[old.id]
        data = s.data()
        s.snapshot(data)
        resume = None
        if req.get("resume") is not None:
            r = req["resume"] if isinstance(req["resume"], dict) else {}
            pend = next(iter(s.pending.values()), None)
            resume = {"log": s.log, "captions": r.get("captions") or [], "focus": s.focus or r.get("focus"),
                      "pending": s.pending_summary(pend) if pend else None}
        instr = instructions(data, self.backend.now_pt(), resume)
        info = self.provider.mint(instr)
        s.connects += 1
        return {"ok": True, "sid": s.id, **info, "connects": s.connects}

    def tool(self, req: dict) -> dict:
        s = self.get(req.get("sid"))
        args = req.get("args")
        if isinstance(args, str):
            try:
                args = json.loads(args or "{}")
            except json.JSONDecodeError:
                return {"ok": True, "output": {"ok": False, "error": "Arguments weren't valid JSON."}, "ui": {}}
        heard = [h for h in (req.get("heard") or []) if isinstance(h, dict)][-6:]
        out, ui = s.call(str(req.get("name", "")), args if args is not None else {}, heard)
        return {"ok": True, "output": out, "ui": ui}

    def approve(self, req: dict) -> dict:
        """The owner tapped Yes or No on a batch proposal."""
        s = self.get(req.get("sid"))
        with s.lock:
            p = s.pending.get(str(req.get("confirm_id", "")))
            if not p:
                raise ValueError("That proposal isn't open any more.")
            if req.get("decision") == "yes":
                del s.pending[p["id"]]
                try:
                    out, ui = s.run_batch(p)
                except ToolError as e:
                    raise ValueError(str(e)) from None
            else:
                del s.pending[p["id"]]
                out, ui = {"ok": True, "declined": s.pending_summary(p)}, {"pending": None}
        return {"ok": True, "output": out, "ui": ui}

    def undo(self, req: dict) -> dict:
        """The owner tapped Undo on an entry in the action log."""
        s = self.get(req.get("sid"))
        with s.lock:
            entry = next((e for e in s.log if e["seq"] == int(req.get("seq", -1))), None)
            if not entry:
                raise ValueError("No such change in this conversation.")
            try:
                r = s.undo_entry(entry)
            except ToolError as e:
                raise ValueError(str(e)) from None
            s.snapshot(s.data())
        return {"ok": True, "output": r, "ui": {"changed": True, "log": entry}}
