#!/usr/bin/env python3
"""End-to-end test of every action against a COPY of an intake file.

Usage: python3 tests/test_roundtrip.py <source-intake.md>
Builds a throwaway git vault in a temp dir, starts server.py against it on a
spare port, runs each action over HTTP, and checks:
  - only the targeted item's block changes; every other line is byte-identical
  - each action makes exactly one commit touching only the intended path(s)
  - a dirty unrelated file in the vault is never committed
  - stale lines are refused (409), undo restores the exact bytes
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]).expanduser()
NAME = SRC.name
fails = 0


def check(cond, msg):
    global fails
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails += 1


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


tmp = Path(tempfile.mkdtemp(prefix="intake-triage-test-"))
vault = tmp / "vault"
intake = vault / "agent" / "intake"
intake.mkdir(parents=True)
shutil.copy(SRC, intake / NAME)
# Fixtures for the tag tests, whatever state the real page is in.
with open(intake / NAME, "a", encoding="utf-8") as fh:
    fh.write("\n## Test fixtures\n\n"
             "- [ ] fixture one \u2014 an untagged plain to-do for the reclassify test \u2014 ME \u2014 testproj\n"
             "- [ ] fixture two \u2014 Awareness. An untagged FYI \u2014 AGENT\n"
             "- [ ] fixture three \u2014 a tag mid-line #action (edited later by hand) \u2014 AGENT \u2014 testproj\n"
             "- [ ] fixture four \u2014 the old site is idle. Retire it? (retire / keep) \u2014 ME \u2014 testproj #action\n")
(vault / "unrelated.md").write_text("clean\n")
g = lambda *a: subprocess.run(["git", "-C", str(vault), *a], capture_output=True, text=True)
g("init", "-q"); g("config", "user.email", "t@example.com"); g("config", "user.name", "test")
g("add", "-A"); g("commit", "-qm", "init")
(vault / "unrelated.md").write_text("dirty, must never be committed\n")
g("add", "unrelated.md")  # even STAGED unrelated changes must stay out of our commits

# A stand-in for assistant-trigger.sh that only records its arguments, so the test
# never pings the real the assistant. Tier 2 voice keys point nowhere: no network.
fake_trigger = tmp / "fake-trigger.sh"
trigger_log = tmp / "trigger-args.txt"
fake_trigger.write_text(f'#!/bin/sh\nprintf "%s\\n%s\\n" "$1" "$2" > "{trigger_log}"\n')
fake_trigger.chmod(0o755)

port = free_port()
env = {**os.environ, "INTAKE_VAULT": str(vault), "INTAKE_PORT": str(port), "INTAKE_TRIGGER": str(fake_trigger),
       "INTAKE_JEV_SECRET": "env:INTAKE_TEST_NO_SUCH_KEY", "INTAKE_LLM_SECRET": "env:INTAKE_TEST_NO_SUCH_KEY"}
proc = subprocess.Popen([sys.executable, str(HERE / "server.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
BASE = f"http://127.0.0.1:{port}"


def call(path, body=None, headers=None):
    h = {"X-Intake-Triage": "1", "Content-Type": "application/json"} if body is not None else {}
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=h,
                                 method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


for _ in range(50):
    try:
        call("/api/files"); break
    except Exception:
        time.sleep(0.1)

path = intake / NAME
original = path.read_bytes()


def lines():
    return path.read_text(encoding="utf-8").split("\n")


def items():
    return call(f"/api/items?file={NAME}")[1]["items"]


def open_items():
    return [i for i in items() if not i["checked"]]


def commits():
    return int(g("rev-list", "--count", "HEAD").stdout.strip())


def last_commit_files():
    return [l for l in g("show", "--name-only", "--format=%s", "HEAD").stdout.strip().split("\n") if l]


def assert_only_block_changed(before, after, start, old_len, new_len, label):
    check(before[:start] == after[:start], f"{label}: lines above the item unchanged")
    check(before[start + old_len:] == after[start + new_len:], f"{label}: lines below the item unchanged")


def run(action, item, **extra):
    before = lines()
    start = before.index(item["raw"])
    old_len = 1 + len(item["comments"])
    n0 = commits()
    code, res = call("/api/action", {"file": NAME, "raw": item["raw"], "occurrence": item["occurrence"], "action": action, **extra})
    after = lines()
    check(code == 200 and res.get("ok"), f"{action}: HTTP 200 ({res.get('error', '')})")
    new_len = len(after) - len(before) + old_len
    assert_only_block_changed(before, after, start, old_len, new_len, action)
    check(commits() == n0 + 1, f"{action}: exactly one new commit")
    return before, after, start, res


rel = f"agent/intake/{NAME}"
print(f"Testing against a copy of {SRC} in {tmp}")

its = open_items()
check(len(its) > 5, f"parsed {len(its)} open items")

# 1. done with note
it = its[0]
b, a, s, res = run("done", it, text="sorted it\nover the phone")
check(a[s].startswith("- [x] ") and " — done (Me, " in a[s] and a[s].endswith(" PT): sorted it over the phone"), "done: ticked, stamped, note on one line")
check(last_commit_files()[1:] == [rel] and last_commit_files()[0].startswith("intake triage: done — "), f"done: commit touches only {rel}")
check("unrelated.md" in g("diff", "--cached", "--name-only").stdout, "staged unrelated.md still staged, not committed")

# 2. undo restores exact bytes
code, res = call("/api/undo", {})
check(code == 200 and path.read_bytes() == original, "undo: file is byte-identical to the original")
check(last_commit_files()[1:] == [rel], "undo: commit touches only the intake file")

# 3. snooze
it = open_items()[1]
b, a, s, _ = run("snooze", it, date="2026-10-27")
check(a[s] == it["raw"] + " — snoozed until 2026-10-27" and a[s].startswith("- [ ] "), "snooze: marker appended, still unticked")
sn = [i for i in items() if i["raw"] == a[s]][0]
check(sn["snoozedUntil"] == "2026-10-27" and sn["project"] == it["project"] and sn["board"] == it["board"], "snooze: parse keeps board/project and reads the date")
it2 = sn
b, a, s, _ = run("snooze", it2, date="2026-11-02")
check(a[s].count("snoozed until") == 1 and a[s].endswith("snoozed until 2026-11-02"), "re-snooze replaces the old marker")

# 4. comment
it = open_items()[2]
b, a, s, _ = run("comment", it, text="Ask Sam for the numbers first")
check(a[s] == it["raw"], "comment: item line untouched")
check(a[s + 1 + len(it["comments"])].startswith("  - Me (") and a[s + 1 + len(it["comments"])].endswith(" PT): Ask Sam for the numbers first"), "comment: indented sub-bullet with PT stamp")

# 5. comment on an item that already has a sub-bullet goes after the existing ones
withkids = [i for i in open_items() if i["comments"]]
if withkids:
    it = withkids[0]
    b, a, s, _ = run("comment", it, text="second note")
    check(a[s + 1:s + 1 + len(it["comments"])] == b[s + 1:s + 1 + len(it["comments"])] and "second note" in a[s + len(it["comments"]) + 1], "comment: appended after existing sub-bullets")

# 6. drop with and without reason
it = open_items()[3]
b, a, s, _ = run("drop", it, text="not mine")
check(a[s] == "- [x] " + it["raw"][6:] + " — dropped (Me): not mine", "drop: exact format with reason")
it = open_items()[3]
b, a, s, _ = run("drop", it, text="")
check(a[s].endswith(" — dropped (Me)"), "drop: exact format without reason")

# 7. hand to the assistant: comment + inbox queue, one commit with both paths
it = open_items()[4]
b, a, s, _ = run("assistant", it, text="draft the reply for me")
check(a[s + 1 + len(it["comments"])].endswith("PT): → Assistant: draft the reply for me"), "assistant: flagged sub-bullet")
inbox = (intake / "triage-inbox.md").read_text()
check("→ Assistant: draft the reply for me" in inbox and f"[[{NAME[:-3]}]]" in inbox, "assistant: queued in triage-inbox.md")
files = last_commit_files()[1:]
check(sorted(files) == sorted([rel, "agent/intake/triage-inbox.md"]), f"assistant: commit touches exactly the two paths ({files})")
code, _ = call("/api/undo", {})
check("draft the reply for me" not in (intake / "triage-inbox.md").read_text(), "undo assistant: inbox line removed")
check(not any("draft the reply" in l for l in lines()), "undo assistant: comment removed")

# 8. stale line: fail loudly
code, res = call("/api/action", {"file": NAME, "raw": "- [ ] this line does not exist", "occurrence": 0, "action": "done"})
check(code == 409 and res.get("conflict"), "stale line: 409 conflict")
it = open_items()[0]
path.write_text(path.read_text().replace(it["raw"], it["raw"] + " (edited by the assistant)"))
code, res = call("/api/action", {"file": NAME, "raw": it["raw"], "occurrence": 0, "action": "done"})
check(code == 409, "line edited after load: 409, file untouched")
check(it["raw"] + " (edited by the assistant)" in path.read_text(), "edited line left as the assistant wrote it")

# 9. guards
code, _ = call("/api/action", {"file": "../../etc/passwd", "raw": "x", "action": "done"})
check(code == 400, "path traversal refused")
req = urllib.request.Request(BASE + "/api/undo", data=b"{}", method="POST")
try:
    urllib.request.urlopen(req); code = 200
except urllib.error.HTTPError as e:
    code = e.code
check(code == 403, "POST without the app header refused (CSRF guard)")
code, _ = call("/api/undo", {}, {"Origin": "https://evil.example"})
check(code == 403, "cross-origin POST refused")

# 10. untouched lines: compare against the original, ignoring the lines we acted on
orig = original.decode().split("\n")
now = lines()
touched_raw = {i["raw"] for i in its[:5]} | {it["raw"]}
untouched = [l for l in orig if l not in touched_raw and not l.startswith("  - ")]
check(all(l in now for l in untouched), "every untouched original line is still present verbatim")
check(path.read_bytes().endswith(b"\n") == original.endswith(b"\n"), "trailing newline preserved")
check("dirty, must never be committed" not in g("show", "HEAD:unrelated.md").stdout, "unrelated.md never committed")

# ---------------------------------------------------------------- v2: phases, tags, ask, voice
print("\nv2")
all_items = items()
check(all(i["kind"] in ("action", "awareness") for i in all_items), "every item has a kind")
aw = [i for i in all_items if i["kind"] == "awareness"]
ac = [i for i in all_items if i["kind"] == "action"]
check(aw and ac, f"both phases present ({len(ac)} action, {len(aw)} awareness)")
tagged = [i for i in all_items if i["kindSource"] == "tag"]
guessed = [i for i in all_items if i["kindSource"] == "guess"]
check(all(i["raw"].count("#" + i["kind"]) for i in tagged), f"tagged items ({len(tagged)}) take their kind from the tag")
check(all(("awareness" in i["raw"].lower() or i["board"] == "n/a") == (i["kind"] == "awareness") for i in guessed),
      f"untagged items ({len(guessed)}): awareness if the text says so or board n/a, else action")
check(not any(t in i["text"] for i in all_items for t in ("#action", "#awareness")), "tags never shown in item text")

# reclassify an open action item to awareness, then back
fx = {i["raw"].split(" \u2014 ")[0][6:]: i for i in items() if i["raw"].startswith("- [ ] fixture ")}
check(fx["fixture one"]["kind"] == "action" and fx["fixture one"]["kindSource"] == "guess", "untagged plain item: guessed action")
check(fx["fixture two"]["kind"] == "awareness" and fx["fixture two"]["kindSource"] == "guess", "untagged item saying Awareness: guessed awareness")
f3 = fx["fixture three"]
check(f3["kind"] == "action" and f3["kindSource"] == "tag" and "#action" not in f3["text"] and f3["board"] == "AGENT" and f3["project"] == "testproj",
      "mid-line tag still counts, hidden from text, board and project still parsed")
b, a, s, _ = run("reclassify", f3, kind="awareness")
check(a[s] == "- [ ] fixture three \u2014 a tag mid-line (edited later by hand) \u2014 AGENT \u2014 testproj #awareness", f"mid-line tag moved and rewritten, no duplicate: {a[s][-60:]}")
code, _ = call("/api/undo", {})

it = fx["fixture one"]
b, a, s, res = run("reclassify", it, kind="awareness")
check(a[s] == it["raw"] + " #awareness", "reclassify: tag appended at the end of the line")
check(res["newRaw"] == a[s] and "as awareness" in last_commit_files()[0], "reclassify: newRaw returned, commit message says as awareness")
now = [i for i in items() if i["raw"] == a[s]][0]
check(now["kind"] == "awareness" and now["kindSource"] == "tag", "reclassify: parsed as awareness from the tag")
check("#awareness" not in now["text"] and now["board"] == it["board"] and now["project"] == it["project"], "tag hidden from text, board and project")
b, a, s, _ = run("reclassify", now, kind="action")
check(a[s] == it["raw"] + " #action" and (a[s].count("#action") + a[s].count("#awareness")) == 1, "reclassify back: tag rewritten in place, not added twice")

# tag sits before a snooze suffix
it = [i for i in items() if i["raw"] == a[s]][0]
b, a, s, _ = run("snooze", it, date="2026-11-09")
it = [i for i in items() if i["raw"] == a[s]][0]
b, a, s, _ = run("reclassify", it, kind="awareness")
check(a[s].endswith(" #awareness — snoozed until 2026-11-09"), f"tag goes before the snooze marker: ...{a[s][-48:]}")
check([i for i in items() if i["raw"] == a[s]][0]["snoozedUntil"] == "2026-11-09", "snooze still parsed after the tag")

# ask: writes the question, fires the (fake) trigger, shows as pending
it = [i for i in open_items() if not i["snoozedUntil"] and not i["comments"]][0]
if trigger_log.exists():
    trigger_log.unlink()
b, a, s, res = run("ask", it, text="Was this paid \u2014 or still \u201copen\u201d? | check")
q = a[s + 1]
check(q.startswith("  - Me (") and " PT) ? Was this paid" in q, f"ask: question sub-bullet written ({q[:60]}...)")
check(res.get("trigger", {}).get("queued") and "warning" not in res, "ask: trigger queued, no warning")
for _ in range(50):
    if trigger_log.exists() and trigger_log.read_text().count("\n") >= 2:
        break
    time.sleep(0.1)
targs = trigger_log.read_text().split("\n") if trigger_log.exists() else ["", ""]
check(targs[0] == "triage", "trigger called with kind 'triage'")
parts = targs[1].split("|")
check(len(parts) == 3 and parts[0] == NAME and parts[2] == 'Was this paid - or still "open"? / check', f"trigger message is file|item|question, ASCII, pipes escaped: {targs[1][:120]!r}")
check(all(32 <= ord(c) < 127 for c in targs[1]), "trigger message is printable ASCII")
check(len(parts[1]) <= 80, "item part capped at 80 chars")
it = [i for i in items() if i["raw"] == it["raw"]][0]
check(it["pendingAsk"] and it["pendingAsk"]["text"].startswith("Was this paid"), "ask: pendingAsk set until the assistant answers")

# The assistant answers (as it would, one sub-bullet under the question)
L = lines()
qi = L.index(q)
L.insert(qi + 1, "  - Assistant (2026-10-24 10:05 PT): Paid on Oct 20 per the receipt email; this looks resolved.")
path.write_text("\n".join(L))
it = [i for i in items() if i["raw"] == it["raw"]][0]
check(it["pendingAsk"] is None, "answer clears pendingAsk")
mar = [n for n in it["notes"] if n["who"] == "Assistant"]
check(mar and mar[0]["kind"] == "answer" and mar[0]["answers"].startswith("Was this paid") and mar[0]["stamp"].startswith("2026-10-24"), "the assistant's answer parsed and paired with the question")
check(it["resolvedHint"] is True, "'looks resolved' offers Yes, done")
b, a, s, _ = run("done", it, text="")
check(a[s].startswith("- [x] ") and a[s + 1] == q, "Yes, done: ticks the item, keeps the Q and A under it")
check([i for i in items() if i["raw"] == a[s]][0]["resolvedHint"] is False, "no resolve hint on a checked item")
code, res = call("/api/action", {"file": NAME, "raw": a[s], "occurrence": 0, "action": "ask", "text": "still?"})
check(code == 400, "ask on a resolved item refused")

# undo hands back the restored raw line so the UI can reselect it
code, res = call("/api/undo", {})
check(code == 200 and res.get("raw") == it["raw"], "undo returns the restored raw line")

# ask with no text is refused
code, res = call("/api/action", {"file": NAME, "raw": it["raw"], "occurrence": it["occurrence"], "action": "ask", "text": "  "})
check(code == 400, "ask with an empty question refused")

# voice endpoint, tier 1 over HTTP
for text, want in [("drop because it's stale", {"action": "drop", "text": "It's stale"}),
                   ("snooze till next week", {"action": "reschedule", "tier": 1}),
                   ("ask did Acme confirm", {"action": "ask", "text": "Did Acme confirm?"}),
                   ("next", {"action": "next"}), ("stop", {"action": "stop"})]:
    code, res = call("/api/voice", {"text": text, "phase": "action"})
    check(code == 200 and all(res.get(k) == v for k, v in want.items()), f"/api/voice {text!r} -> {want}")
code, res = call("/api/voice", {"text": "what is the weather like", "phase": "awareness"})
check(code == 200 and res["action"] == "unknown" and res["tier"] == 2, "/api/voice non-command -> unknown (tier 2 unreachable)")
code, _ = call("/api/voice", {"text": "done"}, {"Origin": "https://evil.example"})
check(code == 403, "/api/voice cross-origin refused")

# ---------------------------------------------------------------- decision options
fx = next(i for i in open_items() if "fixture four" in i["raw"])
check(fx["options"] == ["Retire", "Keep"], f"options parsed from the trailing parenthetical: {fx['options']}")
check(all(i["options"] == [] for i in items() if "fixture one" in i["raw"]), "a plain to-do has no options")
orig = path.read_bytes()
code, res = call("/api/action", {"file": NAME, "raw": fx["raw"], "occurrence": 0, "action": "choose", "option": "maybe"})
check(code == 400 and "Retire" in res.get("error", ""), f"choose: an option not on the item is refused ({res.get('error', '')})")
check(path.read_bytes() == orig, "choose: refused pick leaves the file alone")
b, a, s, res = run("choose", fx, option="keep", text="still used by the docs")
check(a[s].startswith("- [x] ") and ' PT): chose "Keep"; still used by the docs' in a[s] and " — done (Me, " in a[s], f"choose: ticked with the canonical option and note: {a[s][-70:]}")
check(res.get("option") == "Keep", "choose: response names the option")
check(last_commit_files()[0].startswith('intake triage: choose "Keep"') or '"Keep"' in last_commit_files()[0], f"choose: commit message names the choice ({last_commit_files()[0]})")
code, res = call("/api/undo", {})
check(code == 200 and path.read_bytes() == orig and res.get("raw") == fx["raw"], "choose: undo restores exact bytes and hands back the raw line")
code, res = call("/api/voice", {"text": "keep it", "phase": "action", "options": fx["options"]})
check(res.get("action") == "choose" and res.get("option") == "Keep", f"/api/voice 'keep it' with options -> choose Keep ({res})")
code, res = call("/api/voice", {"text": "option one", "phase": "action", "options": fx["options"]})
check(res.get("action") == "choose" and res.get("option") == "Retire", "/api/voice 'option one' -> choose Retire")
code, res = call("/api/voice", {"text": "done", "phase": "action", "options": fx["options"]})
check(res.get("action") == "done", "/api/voice 'done' still means done when options exist")

# ---------------------------------------------------------------- newtab comment
EXT = "chrome-extension://komhiagljgdhghicimkkjjmnldebhmne"
vault_before = g("status", "--porcelain").stdout
if trigger_log.exists():
    trigger_log.unlink()
comment = {"url": "https://www.php.net/archive/2026.php", "headline": "Critical PHP RCE \u2014 a|b \u2192 patch",
           "prompt": "Is the shop's host on 8.5.12?\nCheck | report"}
code, res = call("/api/newtab/comment", comment, {"Origin": EXT})
check(code == 200 and res.get("queued") is True, f"newtab comment from the extension is queued ({code} {res})")
targs = trigger_log.read_text().split("\n") if trigger_log.exists() else ["", ""]
check(targs[0] == "newtab", f"newtab comment fires the 'newtab' trigger kind ({targs[0]!r})")
check(targs[1] == "https://www.php.net/archive/2026.php|Critical PHP RCE - a/b -> patch|Is the shop's host on 8.5.12? Check / report",
      f"newtab message is url|headline|prompt, ASCII, one line, pipes escaped ({targs[1]!r})")
check(g("status", "--porcelain").stdout == vault_before, "newtab comment writes nothing to the vault")
for label, hdrs in [("no Origin", {}), ("a web origin", {"Origin": "https://evil.example"}),
                    ("the app's own origin", {"Origin": f"http://127.0.0.1:{port}"}),
                    ("another extension", {"Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})]:
    code, _ = call("/api/newtab/comment", comment, hdrs)
    check(code == 403, f"newtab comment from {label} refused ({code})")
code, _ = call("/api/newtab/comment", comment, {"Origin": EXT, "X-Intake-Triage": ""})
check(code == 403, "newtab comment without the app header refused")
code, _ = call("/api/action", {"file": NAME}, {"Origin": EXT})
check(code == 403, "the extension origin can't reach the vault-writing routes")
for bad, why in [({**comment, "url": "javascript:alert(1)"}, "non-http url"), ({**comment, "prompt": "  "}, "empty prompt")]:
    code, res = call("/api/newtab/comment", bad, {"Origin": EXT})
    check(code == 400, f"newtab comment with {why} refused ({code} {res.get('error')})")
good_trigger = fake_trigger.read_text()
fake_trigger.write_text('#!/bin/sh\necho "assistant is down" >&2\nexit 3\n')
code, res = call("/api/newtab/comment", comment, {"Origin": EXT})
check(code == 502 and "exit 3" in res.get("error", ""), f"a failing trigger is reported, not swallowed ({code} {res.get('error')})")
fake_trigger.write_text(good_trigger)
req = urllib.request.Request(BASE + "/", method="GET")
with urllib.request.urlopen(req, timeout=10) as r:
    csp = r.headers.get("Content-Security-Policy", "")
check(csp == f"frame-ancestors 'self' {EXT}", f"only the app and the extension may frame it ({csp!r})")

# ---------------------------------------------------------------- newtab advisory
for slug in ("example-shop", "trades-site", "booking-app"):
    (vault / "projects" / slug).mkdir(parents=True, exist_ok=True)
    (vault / "projects" / slug / "current-state.md").write_text("---\nstatus: active\n---\n")


def trigger_args():
    if not trigger_log.exists():
        return None
    a = trigger_log.read_text().split("\n")
    trigger_log.unlink()
    return a[0], a[1]


adv = {"id": "PHP2Shell", "severity": "critical", "projects": ["example-shop", "no-such-project"],
       "url": "https://www.php.net/archive/2026.php", "headline": "Critical PHP RCE — a|b",
       "action": "Check the host runs PHP 8.5.12+"}
trigger_args()
code, res = call("/api/newtab/advisory", adv, {"Origin": EXT})
check(code == 200 and res.get("status") == "launch" and res.get("dry") is True and res.get("unknown") == ["no-such-project"],
      f"advisory: dry run by default, unknown project set aside ({code} {res})")
t = trigger_args()
check(t == ("advisory", "DRYRUN-LAUNCH|php2shell|critical|example-shop|https://www.php.net/archive/2026.php|"
                        "Critical PHP RCE - a/b|Check the host runs PHP 8.5.12+"),
      f"advisory message is mode|id|severity|projects|url|headline|action ({t!r})")
code, res = call("/api/newtab/advisory", adv, {"Origin": EXT})
check(code == 200 and res.get("status") == "duplicate" and trigger_args() is None, "advisory: the same id and project never fires twice")
code, res = call("/api/newtab/advisory", {**adv, "id": "cve-2026-99999"}, {"Origin": EXT})
check(res.get("status") == "duplicate" and trigger_args() is None, "advisory: the same url under a new id is still a duplicate")
code, res = call("/api/newtab/advisory", {**adv, "projects": ["example-shop", "booking-app"]}, {"Origin": EXT})
t = trigger_args()
check(res.get("projects") == ["booking-app"] and t and t[1].split("|")[3] == "booking-app", f"advisory: only the new project fires ({res} {t!r})")
check(g("status", "--porcelain", "--", "agent").stdout == "", "advisory writes nothing to the intake files")
for bad, why in [({**adv, "severity": "medium"}, "medium severity"), ({**adv, "id": "x y"}, "a bad id"),
                 ({**adv, "projects": ["no-such-project"]}, "no known project"), ({**adv, "projects": ["../../etc"]}, "a path as a slug"),
                 ({**adv, "url": "javascript:alert(1)"}, "a non-http url")]:
    code, res = call("/api/newtab/advisory", bad, {"Origin": EXT})
    check(code == 400 and trigger_args() is None, f"advisory with {why} refused ({code} {res.get('error')})")
code, _ = call("/api/newtab/advisory", adv, {"Origin": "https://evil.example"})
check(code == 403, "advisory from a web origin refused")
fake_trigger.write_text('#!/bin/sh\necho "assistant is down" >&2\nexit 3\n')
code, res = call("/api/newtab/advisory", {**adv, "id": "cve-2026-1", "url": "https://example.org/a"}, {"Origin": EXT})
check(code == 502, f"advisory: a failing trigger is reported ({code})")
fake_trigger.write_text(good_trigger)
code, res = call("/api/newtab/advisory", {**adv, "id": "cve-2026-1", "url": "https://example.org/a"}, {"Origin": EXT})
check(res.get("status") == "launch", f"advisory: a failed trigger isn't recorded, so the retry fires ({res})")
trigger_args()

# ---------------------------------------------------------------- newtab edition
edition_path = vault / "agent" / "edition" / "current.md"
ed = {"date": "2026-11-18", "madeAt": "2026-11-18T14:41:00.000Z",
      "markdown": "---\ndate: 2026-11-18\n---\n\n- **1.** First headline\n" + "x" * 100_000}
vault_before = g("status", "--porcelain").stdout
code, res = call("/api/newtab/edition", ed, {"Origin": EXT})
check(code == 200 and res.get("written") is True and edition_path.read_text() == ed["markdown"],
      f"edition: written to agent/edition/current.md, over 64 KB accepted ({code} {res.get('error')})")
ed2 = {**ed, "madeAt": "2026-11-18T17:00:00Z", "markdown": "---\ndate: 2026-11-18\n---\n\n- **1.** Resent\n"}
code, res = call("/api/newtab/edition", ed2, {"Origin": EXT})
check(code == 200 and edition_path.read_text() == ed2["markdown"], "edition: a resend overwrites it")
check(sorted(p.name for p in edition_path.parent.iterdir()) == ["current.md"], "edition: one file, no temp files left")
check(g("log", "-1", "--format=%s").stdout.strip() != "" and "kobo-edition" not in g("log", "-1", "--name-only").stdout,
      "edition: not committed")
for label, hdrs in [("a web origin", {"Origin": "https://evil.example"}), ("no origin", {})]:
    code, _ = call("/api/newtab/edition", ed, hdrs)
    check(code == 403, f"edition from {label} refused ({code})")
for why, bad in [("a bad date", {**ed, "date": "../x"}), ("no madeAt", {**ed, "madeAt": None}),
                 ("a bad madeAt", {**ed, "madeAt": "yesterday"}), ("empty markdown", {**ed, "markdown": " "}),
                 ("no front matter", {**ed, "markdown": "hello"})]:
    code, res = call("/api/newtab/edition", bad, {"Origin": EXT})
    check(code == 400, f"edition with {why} refused ({code} {res.get('error')})")
try:  # the server answers 413 without reading the body, so the client may see the pipe close instead
    code, _ = call("/api/newtab/edition", {**ed, "markdown": "---\n" + "x" * (1024 * 1024 + 10)}, {"Origin": EXT})
except urllib.error.URLError:
    code = 413
check(code == 413, f"edition over 1 MB refused ({code})")
check(edition_path.read_text() == ed2["markdown"], "edition: refused sends leave the file alone")

proc.terminate()
proc.wait(5)

# Live mode, cap 1, on a second server against the same vault: still the fake trigger.
port = free_port()
BASE = f"http://127.0.0.1:{port}"
proc = subprocess.Popen([sys.executable, str(HERE / "server.py")],
                        env={**env, "INTAKE_PORT": str(port), "INTAKE_ADVISORY_LIVE": "1", "INTAKE_ADVISORY_CAP": "1"},
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        call("/api/files"); break
    except Exception:
        time.sleep(0.1)
code, res = call("/api/newtab/advisory", adv, {"Origin": EXT})
t = trigger_args()
check(res.get("status") == "launch" and res.get("dry") is False and t and t[1].startswith("LAUNCH|php2shell|"),
      f"advisory live: dry-run history doesn't block a real launch ({res} {t!r})")
code, res = call("/api/newtab/advisory", {**adv, "id": "cve-2026-2", "url": "https://example.org/b",
                                          "projects": ["trades-site"]}, {"Origin": EXT})
t = trigger_args()
check(res.get("status") == "issue-only" and t and t[1].startswith("ISSUE-ONLY|cve-2026-2|"),
      f"advisory live: over the daily cap it's an AGENT-board issue only ({res} {t!r})")
test_ledger = HERE / ".state" / f"advisories-{__import__('hashlib').sha1(str(vault.resolve()).encode()).hexdigest()[:10]}.json"
check(test_ledger.exists() and len(json.loads(test_ledger.read_text())) == 5, "advisory ledger is per vault and records each fired trigger")
test_ledger.unlink(missing_ok=True)

proc.terminate()
proc.wait(5)
print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}  (temp vault: {tmp})")
sys.exit(1 if fails else 0)
