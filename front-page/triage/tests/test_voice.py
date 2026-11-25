#!/usr/bin/env python3
"""Voice command parsing: tier 1 (local grammar) and tier 2 (Jev, then an LLM).

    python3 tests/test_voice.py          # offline: tier 2 is mocked
    python3 tests/test_voice.py --live   # also one real call each to Jev and the LLM

Today is pinned to Saturday 2026-10-24 (America/Los_Angeles).
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import voice  # noqa: E402

TODAY = dt.date(2026, 10, 24)  # a Saturday
fails = 0


def check(cond, msg):
    global fails
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails += 1


def no_tier2(*a, **k):
    raise AssertionError("tier 2 must not be called for a grammar phrase")


# (phrase, expected action, expected date or None, expected text or None)
TIER1 = [
    ("done", "done", None, None),
    ("Done.", "done", None, None),
    ("that's done", "done", None, None),
    ("mark it done", "done", None, None),
    ("drop", "drop", None, None),
    ("drop it", "drop", None, None),
    ("drop because it is stale", "drop", None, "It is stale"),
    ("drop it because Sam already handled it", "drop", None, "Sam already handled it"),
    ("reschedule for Monday", "reschedule", "2026-10-26", None),
    ("Monday", "reschedule", "2026-10-26", None),
    ("later", "reschedule", "2026-10-25", None),
    ("not now", "reschedule", "2026-10-25", None),
    ("tomorrow", "reschedule", "2026-10-25", None),
    ("snooze till next week", "reschedule", "2026-10-31", None),
    ("snooze to the weekend", "reschedule", "2026-10-31", None),
    ("end of the week", "reschedule", "2026-10-30", None),
    ("Nov 3", "reschedule", "2026-11-03", None),
    ("November third", "reschedule", "2026-11-03", None),
    ("reschedule to the 3rd", "reschedule", "2026-11-03", None),
    ("the 30th", "reschedule", "2026-10-30", None),
    ("next Friday", "reschedule", "2026-10-30", None),
    ("comment call him back", "comment", None, "Call him back"),
    ("comment: ask Sam for the numbers", "comment", None, "Ask Sam for the numbers"),
    ("ask is this paid", "ask", None, "Is this paid?"),
    ("ask the assistant whether Pat replied", "ask", None, None),
    ("tell the assistant to chase it", "assistant", None, "Chase it"),
    ("note to self, needs the receipts", "comment", None, "Needs the receipts"),
    ("bin it", "drop", None, None),
    ("push this out to Wednesday", "reschedule", "2026-10-28", None),
    ("next", "next", None, None),
    ("next one", "next", None, None),
    ("back", "prev", None, None),
    ("previous", "prev", None, None),
    ("skip", "skip", None, None),
    ("undo", "undo", None, None),
    ("undo that", "undo", None, None),
    ("stop", "stop", None, None),
    ("pause", "stop", None, None),
]

print("Tier 1: local grammar")
for phrase, action, date, text in TIER1:
    r = voice.parse(phrase, TODAY, jev=no_tier2, llm=no_tier2)
    ok = r["action"] == action and r.get("tier") == 1
    if date is not None:
        ok = ok and r.get("date") == date
    if text is not None:
        ok = ok and r.get("text") == text
    if action in voice.NEEDS_TEXT:
        ok = ok and bool(r.get("text"))
    check(ok, f"{phrase!r:44} -> {action}{' ' + date if date else ''}{' / ' + text if text else ''}   got {({k: v for k, v in r.items() if k in ('action', 'date', 'text', 'tier')})}")

print("\nTier 1 hands non-commands to tier 2")
for phrase in ["what is the weather", "honestly I have no idea about this one", "hmm"]:
    check(voice.tier1(phrase, TODAY) is None, f"{phrase!r} is not a grammar match")


# ---------------------------------------------------------------- tier 2, mocked

def jev_says(choice, conf):
    calls = []
    def f(t, phase):
        calls.append((t, phase))
        return {"choice": choice, "confidence": conf, "probabilities": {}}
    f.calls = calls
    return f


def llm_says(obj):
    calls = []
    def f(t, today, phase):
        calls.append(t)
        return obj
    f.calls = calls
    return f


def llm_fails(*a):
    raise TimeoutError("mock timeout")


# (phrase, jev mock, llm mock, expected subset)
TIER2 = [
    ("yeah that one's sorted", jev_says("done", 0.97), llm_says({"action": "unknown", "date": None, "text": None}),
     {"action": "done", "via": "jev"}),
    ("chuck it, nobody needs it", jev_says("drop", 0.93), llm_fails, {"action": "drop", "via": "jev"}),
    ("can this wait until Wednesday", jev_says("reschedule", 0.91), llm_fails,
     {"action": "reschedule", "date": "2026-10-28", "via": "jev+local"}),
    ("deal with it in a few days please", jev_says("reschedule", 0.9),
     llm_says({"action": "reschedule", "date": "2026-10-27", "text": None}),
     {"action": "reschedule", "date": "2026-10-27", "via": "llm"}),  # Jev sure, no local date -> LLM
    ("find out if the invoice went through", jev_says("ask", 0.88), llm_fails,
     {"action": "ask", "via": "jev+local"}),
    ("let the assistant handle the follow up with Acme", jev_says("assistant", 0.86), llm_fails,
     {"action": "assistant", "via": "jev+local"}),
    ("um can we maybe, I don't know", jev_says("skip", 0.41),
     llm_says({"action": "unknown", "date": None, "text": None}), {"action": "unknown", "via": "llm"}),
    ("park that for a fortnight", jev_says("reschedule", 0.55),
     llm_says({"action": "reschedule", "date": "2026-11-07", "text": None}),
     {"action": "reschedule", "date": "2026-11-07", "via": "llm"}),
    ("move it to last Tuesday", jev_says("reschedule", 0.5),
     llm_says({"action": "reschedule", "date": "2026-10-20", "text": None}),
     {"action": "unknown"}),  # past date rejected by validation
    ("so this one needs the receipts first", jev_says("comment", 0.6),
     llm_says({"action": "comment", "date": None, "text": "needs the receipts"}),
     {"action": "comment", "text": "needs the receipts", "via": "llm"}),
    ("put a note on it", jev_says("comment", 0.6), llm_says({"action": "comment", "date": None, "text": ""}),
     {"action": "unknown"}),  # comment with no text rejected
    ("whatever this is", jev_says("done", 0.3), llm_says({"action": "launch", "date": None, "text": None}),
     {"action": "unknown"}),  # action outside the schema
    ("anything at all", lambda *a: (_ for _ in ()).throw(ConnectionError("down")), llm_fails,
     {"action": "unknown", "via": "none"}),  # both tiers down
    ("we can scrap that", lambda *a: (_ for _ in ()).throw(LookupError("no key")),
     llm_says({"action": "drop", "date": None, "text": None}), {"action": "drop", "via": "llm"}),  # Jev down -> LLM
]

print("\nTier 2: Jev, then the LLM (mocked)")
for phrase, jev, llm, want in TIER2:
    r = voice.parse(phrase, TODAY, "action", jev=jev, llm=llm)
    got = {k: r.get(k) for k in want}
    check(got == want and r.get("tier") == 2, f"{phrase!r:44} -> {want}   got {({k: r.get(k) for k in ('action', 'date', 'text', 'via')})}")

r = voice.parse("find out if the invoice went through", TODAY, jev=jev_says("ask", 0.9), llm=llm_fails)
check(r["text"].endswith("?") and "invoice" in r["text"], f"ask text is the question, ends with '?': {r['text']!r}")
j = jev_says("next", 0.95)
voice.parse("go on to the following one", TODAY, "awareness", jev=j, llm=llm_fails)
check(j.calls and j.calls[0][1] == "awareness", "phase is passed through to tier 2")
llm = llm_says({"action": "done", "date": None, "text": None})
voice.parse("sure", TODAY, jev=jev_says("done", 0.79), llm=llm)
check(len(llm.calls) == 1, "confidence just under 0.8 goes to the LLM")

print("\nSchema validation")
v = voice.validate
check(v({"action": "reschedule", "date": "2026-10-24"}, TODAY) == {"action": "reschedule", "date": "2026-10-24"}, "reschedule to today is allowed")
check(v({"action": "reschedule", "date": "Monday"}, TODAY)["action"] == "unknown", "non-ISO date rejected")
check(v({"action": "reschedule"}, TODAY)["action"] == "unknown", "missing date rejected")
check(v({"action": "ask", "text": "   "}, TODAY)["action"] == "unknown", "blank question rejected")
check(v({"action": "drop", "text": "stale"}, TODAY) == {"action": "drop", "text": "stale"}, "drop keeps a reason")
check(v({"action": "next", "text": "junk", "date": "2026-10-30"}, TODAY) == {"action": "next"}, "extra fields stripped")
check(v({}, TODAY)["action"] == "unknown", "empty intent -> unknown")

# ---------------------------------------------------------------- live smoke

if "--live" in sys.argv:
    print("\nLive smoke (real Jev and LLM calls; keys read by voice.sec_get)")
    try:
        j = voice.jev_choose("chuck that one, it's old news", "action")
        check(j["choice"] in voice.ACTIONS, f"Jev answered: {j['choice']} at {j['confidence']:.2f}")
    except Exception as e:  # noqa: BLE001
        check(False, f"Jev call failed: {type(e).__name__}: {e}")
    try:
        out = voice.validate(voice.llm_parse("push this to next Thursday please", TODAY, "action"), TODAY)
        check(out.get("action") == "reschedule" and out.get("date") == "2026-10-29", f"LLM answered: {out}")
    except Exception as e:  # noqa: BLE001
        check(False, f"LLM call failed: {type(e).__name__}: {e}")
    r = voice.parse("yeah I've sorted that one out already", TODAY)
    check(r["tier"] == 2 and r["action"] == "done", f"full cascade: {({k: r.get(k) for k in ('action', 'via', 'confidence')})}")

n1, n2 = len(TIER1), len(TIER2)
print(f"\n{n1} grammar phrasings, {n2} model phrasings")
print("ALL PASSED" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
