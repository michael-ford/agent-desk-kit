#!/usr/bin/env python3
"""Talk it through: the server side.

    uv run --no-project --python '>=3.11' tests/test_talk.py          # offline
    uv run --no-project --python '>=3.11' --with websockets tests/test_talk.py --live
                                                                       # plus one real hello

Offline: every tool handler against a throwaway git vault (never the real
one), the batch consent gate, undo, the tool schemas, the provider config and
the key-safety paths. --live also mints a real client secret with a page from
the throwaway vault and asks the model for a three-word hello over WebSocket,
tools disabled. Nothing touches the real vault.
"""
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
LIVE = "--live" in sys.argv
TMP = Path(tempfile.mkdtemp(prefix="talk-test-"))
VAULT = TMP / "vault"
INTAKE = VAULT / "agent" / "intake"
INTAKE.mkdir(parents=True)
TRIGGER_LOG = TMP / "trigger.log"
trigger = TMP / "trigger.sh"
trigger.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{TRIGGER_LOG}"\n')
trigger.chmod(0o755)

os.environ.update(INTAKE_VAULT=str(VAULT), INTAKE_TRIGGER=str(trigger), INTAKE_GIT="1", INTAKE_TALK_PROVIDER="fake")
sys.path.insert(0, str(HERE))
import server  # noqa: E402
import talk  # noqa: E402

TODAY = server.today_pt()
PAGE = f"{TODAY.isoformat()}-intake.md"
(INTAKE / PAGE).write_text(f"""---
tags:
  - agent
  - intake
---

# Intake — {TODAY.isoformat()}

## Sweep: close slot

- [ ] **Year-end balance sheet** — chase the balance sheet for the tax forms. — ME — admin #action
  - Assistant ({TODAY.isoformat()} 09:00 PT): They said it comes Monday.
- [ ] **Plumber call times** — reply with two slots for next week. — ME — personal #action
- [ ] **Acme invite: Tuesday sync** — calendar invite for Tuesday, accepted. — ME — admin #action
- [ ] **Acme invite: Thursday review** — calendar invite for Thursday, accepted. — ME — admin #action
- [ ] **AI weekly newsletter** — reference only. — AGENT — reference #awareness
- [ ] **Side-project standup notes** — FYI, nothing asked of the owner. — AGENT — side-project #awareness
- [x] **Old invoice** — already paid. — ME — admin #action
""")


def git(*a):
    return subprocess.run(["git", "-C", str(VAULT), *a], capture_output=True, text=True, check=True).stdout


git("init", "-q")
git("config", "user.email", "test@example.invalid")
git("config", "user.name", "talk test")
git("add", ".")
git("commit", "-qm", "seed")

fails = 0


def check(cond, msg):
    global fails
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails += 1


def page_text():
    return (INTAKE / PAGE).read_text()


def commits():
    return int(git("rev-list", "--count", "HEAD").strip())


def ms():
    return time.time() * 1000


desk = server.TALK
try:
    # ------------------------------------------------------------ session
    print("Session")
    info = desk.open({"file": PAGE})
    sid = info["sid"]
    check(info["ok"] and info["provider"] == "fake" and info["connect"]["kind"] == "fake", "fake provider opens a session")
    s = desk.get(sid)
    data = s.data()
    def find(gist):
        return next(f"i{it['id']}" for it in data["items"] if gist in it["text"])
    sheet, plumber, invite1, invite2, news, standup, old = (find(k) for k in (
        "balance sheet for the tax", "two slots", "invite for Tuesday", "invite for Thursday",
        "reference only", "nothing asked of the owner", "already paid"))

    def call(name, args=None, heard=None):
        return desk.tool({"sid": sid, "name": name, "args": args if args is not None else {}, "heard": heard or []})

    # ------------------------------------------------------------ instructions
    print("Instructions")
    instr = talk.instructions(data, server.now_pt())
    check(TODAY.strftime("%A") in instr and str(TODAY.year) in instr and "local time" in instr, "today's date and place are in the instructions")
    check(all(f"{i} |" in instr for i in (sheet, plumber, news)), "every open item is listed with its id")
    check(f"{old} |" not in instr and "1 already resolved" in instr, "resolved items are counted, not listed")
    check("They said it comes Monday" in instr, "the assistant's evidence notes are included")
    check("acceptance criteria" in instr and "ok true" in instr and "batch" in instr and "[App update" in instr, "the rules are in the instructions")
    check("4 open actions, 2 awareness items" in instr, "open counts are right")
    r = talk.instructions(data, server.now_pt(), {"log": [{"label": "Dropped: x", "undone": False}], "captions": [{"who": "you", "text": "next"}], "focus": sheet, "pending": None})
    check("Resumed conversation" in r and "Dropped: x" in r and "Owner: next" in r and sheet in r, "resume context carries the log, captions and focus")

    # ------------------------------------------------------------ reading
    print("Reading")
    out = call("next_item")["output"]
    check(out["ok"] and out["item"]["id"] == sheet, "next_item starts at the first open action")
    out = call("next_item")["output"]
    check(out["item"]["id"] == plumber, "next_item moves on")
    out = call("next_item", {"phase": "awareness"})["output"]
    check(out["item"]["id"] == news, "next_item can jump to awareness")
    res = call("get_item", {"id": sheet})
    check(res["output"]["item"]["notes"][0]["who"] == "Assistant" and res["ui"]["focus"] == sheet, "get_item returns notes and focuses the item")
    check(not call("get_item", {"id": "12"})["output"]["ok"], "a malformed id is refused")
    check(not call("get_item", {"id": "i99"})["output"]["ok"], "an unknown id is refused")
    check(not call("rm_rf", {})["output"]["ok"], "an unknown tool is refused")
    check(not desk.tool({"sid": sid, "name": "get_item", "args": "{not json"})["output"]["ok"], "bad JSON arguments are refused")

    # ------------------------------------------------------------ single changes
    print("Single changes")
    n0 = commits()
    res = call("mark_done", {"id": invite1, "note": "accepted"})
    check(res["output"]["ok"] and res["ui"]["changed"] and res["ui"]["log"]["seq"] == 1, "mark_done applies and logs")
    check("- [x] **Acme invite: Tuesday sync**" in page_text() and commits() == n0 + 1, "mark_done is on disk and committed")
    check(git("show", "--stat", "--format=", "HEAD").count("|") == 1, "the commit touches only the intake page")
    check(not call("mark_done", {"id": invite1})["output"]["ok"], "an already-resolved item is refused")
    res = call("drop", {"id": news, "reason": "not reading it"})
    check(res["output"]["ok"] and "- [x] **AI weekly newsletter**" in page_text(), "drop applies")
    past = (TODAY - dt.timedelta(days=1)).isoformat()
    far = (TODAY + dt.timedelta(days=400)).isoformat()
    check("past" in call("reschedule", {"id": plumber, "date": past})["output"]["error"], "a past date is refused")
    check("year" in call("reschedule", {"id": plumber, "date": far})["output"]["error"], "a date over a year out is refused")
    check(not call("reschedule", {"id": plumber, "date": "Monday"})["output"]["ok"], "a non-ISO date is refused")
    soon = (TODAY + dt.timedelta(days=3)).isoformat()
    res = call("reschedule", {"id": plumber, "date": soon})
    fresh = s.data()
    plumb = next(it for it in fresh["items"] if f"i{it['id']}" == plumber)
    check(res["output"]["ok"] and plumb["snoozedUntil"] == soon, "reschedule hides it until the date")
    res = call("add_comment", {"id": sheet, "text": "check with the accountant"})
    check(res["output"]["ok"] and "check with the accountant" in page_text(), "add_comment writes a sub-bullet")
    check(not call("add_comment", {"id": sheet, "text": "  "})["output"]["ok"], "an empty comment is refused")
    res = call("reclassify", {"id": standup, "kind": "action"})
    check(res["output"]["ok"] and "Side-project standup notes** — FYI, nothing asked of the owner. — AGENT — side-project #action" in page_text(), "reclassify retags the item")
    res = call("ask_assistant", {"id": sheet, "question": "Did they send it yet?"})
    check(res["output"]["ok"] and res["ui"].get("asked") == sheet and "Did they send it yet?" in page_text(), "ask_assistant saves the question")
    # Triggers run on background threads, so the earlier comment's trigger line may
    # land before or after this one: look for the ask's own line.
    def ask_line():
        lines = TRIGGER_LOG.read_text().splitlines() if TRIGGER_LOG.exists() else []
        return any(l.startswith("triage ") and "Did they send it yet?" in l for l in lines)
    for _ in range(200):
        if ask_line():
            break
        time.sleep(0.05)
    check(ask_line(), "ask_assistant fires the triage trigger (fake)")
    res = call("hand_to_assistant", {"id": sheet, "text": "chase them Monday"})
    inbox = INTAKE / server.INBOX_NAME
    check(res["output"]["ok"] and inbox.exists() and "chase them Monday" in inbox.read_text(), "hand_to_assistant writes the triage inbox")

    # ------------------------------------------------------------ undo
    print("Undo")
    before_inbox = inbox.read_text()
    res = call("undo_last")
    check(res["output"]["ok"] and "chase them Monday" not in inbox.read_text() and "chase them Monday" not in page_text(), "undo_last reverses the hand-off, page and inbox")
    check(before_inbox != inbox.read_text(), "the inbox line is gone")
    seq_drop = next(e["seq"] for e in s.log if e["label"].startswith("Dropped"))
    res = desk.undo({"sid": sid, "seq": seq_drop})
    check(res["ok"] and "- [ ] **AI weekly newsletter**" in page_text(), "undo by log entry reverses an older change")
    try:
        desk.undo({"sid": sid, "seq": seq_drop})
        check(False, "undoing the same entry twice is refused")
    except ValueError:
        check(True, "undoing the same entry twice is refused")
    check("- [x] **Acme invite: Tuesday sync**" in page_text(), "other changes stay put")

    # ------------------------------------------------------------ batch consent
    print("Batch")
    call("undo_last")  # undo the ask, so the balance-sheet item is just commented
    res = call("batch", {"action": "mark_done", "ids": [invite2]})
    check(not res["output"]["ok"], "a one-item batch is refused")
    res = call("batch", {"action": "mark_done", "ids": [invite1, invite2]})
    check(not res["output"]["ok"] and "Already resolved" in res["output"]["error"], "a batch with a resolved item is refused")
    res = call("batch", {"action": "mark_done", "ids": [invite2, standup], "note": "cleared"})
    out = res["output"]
    cid = out["confirm_id"]
    check(out["status"] == "needs_confirmation" and res["ui"]["pending"]["id"] == cid and len(res["ui"]["pending"]["items"]) == 2, "a batch proposes first")
    check("- [ ] **Acme invite: Thursday review**" in page_text(), "a proposal changes nothing")
    t_prop = ms()
    time.sleep(0.01)
    out = call("batch", {"confirm_id": cid})["output"]
    check(out.get("status") == "not_confirmed", "confirming without a yes is refused")
    out = call("batch", {"confirm_id": cid}, [{"text": "yes", "at": t_prop - 5000}])["output"]
    check(out.get("status") == "not_confirmed", "a yes from before the proposal doesn't count")
    out = call("batch", {"confirm_id": cid}, [{"text": "hmm, which ones?", "at": ms()}])["output"]
    check(out.get("status") == "not_confirmed", "a question isn't a yes")
    out = call("batch", {"confirm_id": cid}, [{"text": "okay but not the standup one", "at": ms()}])["output"]
    check(out.get("status") == "not_confirmed", "a hedged yes isn't a yes")
    n0 = commits()
    res = call("batch", {"confirm_id": cid}, [{"text": "Yeah, do it.", "at": ms()}])
    out = res["output"]
    check(out["ok"] and set(out["changed"]) == {invite2, standup} and res["ui"]["pending"] is None, "a clear yes runs the batch")
    check("- [x] **Acme invite: Thursday review**" in page_text() and "- [x] **Side-project standup notes**" in page_text() and commits() == n0 + 2, "the batch is on disk, one commit per item")
    check(not call("batch", {"confirm_id": cid}, [{"text": "yes", "at": ms()}])["output"]["ok"], "a used proposal can't run twice")
    res = call("undo_last")
    check(res["output"]["ok"] and "- [ ] **Acme invite: Thursday review**" in page_text() and "- [ ] **Side-project standup notes**" in page_text(), "undo_last reverses the whole batch")
    # tap to approve
    res = call("batch", {"action": "reschedule", "ids": [invite2, standup], "date": soon})
    cid = res["output"]["confirm_id"]
    res = desk.approve({"sid": sid, "confirm_id": cid, "decision": "yes"})
    check(res["output"]["ok"] and res["ui"]["pending"] is None, "a Yes tap runs the batch")
    res = call("batch", {"action": "drop", "ids": [invite2, standup]})
    cid = res["output"]["confirm_id"]
    res = desk.approve({"sid": sid, "confirm_id": cid, "decision": "no"})
    check(res["output"].get("declined") and "- [x] **Acme invite: Thursday review**" not in page_text(), "a No tap changes nothing")
    check(not s.pending, "no proposal is left open")

    # ------------------------------------------------------------ reconnect
    print("Reconnect")
    info2 = desk.open({"sid": sid, "file": PAGE, "resume": {"captions": [{"who": "aide", "text": "Two Acme invites left."}], "focus": invite2}})
    check(info2["sid"] == sid and info2["connects"] == 2, "a reconnect keeps the same session and its log")
    try:
        desk.tool({"sid": "nope", "name": "next_item", "args": {}})
        check(False, "an unknown session is refused")
    except ValueError:
        check(True, "an unknown session is refused")

    # ------------------------------------------------------------ is_yes
    print("Consent words")
    for t in ["yes", "Yes.", "yeah go ahead", "sure", "ok do it", "okay, all of them", "yep", "please do", "correct", "do it"]:
        check(talk.is_yes(t), f"yes: {t!r}")
    for t in ["no", "not yet", "wait", "hold on", "yes but not the second one", "okay which ones?", "maybe", "what are they",
              "yes except the Acme one", "sure, actually no", "", "yes " + "word " * 12]:
        check(not talk.is_yes(t), f"not yes: {t!r}")

    # ------------------------------------------------------------ tool schemas
    print("Tool schemas")
    names = [t["name"] for t in talk.TOOLS]
    want = {"next_item", "get_item", "mark_done", "drop", "reschedule", "add_comment", "reclassify", "undo_last",
            "ask_assistant", "hand_to_assistant", "choose_option", "batch"}
    check(len(names) == len(set(names)) and set(names) == want, "exactly the allowed tools, no duplicates")
    for t in talk.TOOLS:
        p = t["parameters"]
        ok = (p["type"] == "object" and p.get("additionalProperties") is False and isinstance(p["properties"], dict)
              and all(r in p["properties"] for r in p.get("required", []))
              and all(isinstance(v, dict) and "type" in v for v in p["properties"].values())
              and isinstance(t["description"], str) and len(t["description"]) > 20)
        check(ok, f"{t['name']}: valid object schema")
    check(set(talk.ACTION_TOOLS) | {"next_item", "get_item", "undo_last", "batch"} == want, "every tool has a handler")
    check(set(talk.TOOLS[-1]["parameters"]["properties"]["action"]["enum"]) <= set(talk.ACTION_TOOLS), "batch actions are real tools")
    check(not any(w in json.dumps(talk.TOOLS).lower() for w in ("shell", "http", "browse", "send_email", "web_search")), "no web, shell or outward tools")

    # ------------------------------------------------------------ provider config and key safety
    print("Provider")
    seen = {}
    SECRET = "sk-test-" + "x" * 40

    def fake_post(url, body, key):
        seen.update(url=url, body=body, key=key)
        return {"value": "ek_test_123", "expires_at": 1, "session": body["session"]}

    prov = talk.OpenAIRealtime(key_fn=lambda: SECRET, post=fake_post)
    m = prov.mint("hello instructions")
    sess = seen["body"]["session"]
    check(seen["url"].endswith("/v1/realtime/client_secrets") and seen["key"] == SECRET, "mints a client secret with the server-side key")
    check(seen["body"]["expires_after"] == {"anchor": "created_at", "seconds": talk.TOKEN_TTL} and 10 <= talk.TOKEN_TTL <= 600, "the client secret is short-lived")
    check(sess["model"] == talk.MODEL and sess["type"] == "realtime" and sess["instructions"] == "hello instructions", "session carries model and instructions")
    check(sess.get("reasoning", {}).get("effort") == talk.REASONING if talk.MODEL.startswith("gpt-realtime-2") else True, "reasoning effort is set")
    check(sess["audio"]["input"]["turn_detection"]["type"] == "semantic_vad" and sess["audio"]["output"]["voice"] == talk.VOICE, "audio config is set")
    check([t["name"] for t in sess["tools"]] == names and all(t["type"] == "function" for t in sess["tools"]), "tools are passed as functions")
    check(m["token"] == "ek_test_123" and SECRET not in json.dumps(m) and m["connect"]["url"].endswith("/v1/realtime/calls"), "the browser gets the ephemeral token, never the key")
    try:
        talk.OpenAIRealtime(key_fn=lambda: SECRET, post=lambda *a: {}).mint("x")
        check(False, "a missing client secret is an error")
    except talk.ProviderError as e:
        check(SECRET not in str(e), "a missing client secret is an error, without the key")

    import io
    import urllib.error
    import urllib.request
    real_open = urllib.request.urlopen

    def raising(req, timeout=0):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(
            json.dumps({"error": {"message": "Incorrect API key provided: sk-tes***xxxx"}}).encode()))
    urllib.request.urlopen = raising
    try:
        talk.OpenAIRealtime._post("https://example.invalid", {}, SECRET)
        check(False, "a provider refusal raises ProviderError")
    except talk.ProviderError as e:
        check("401" in str(e) and SECRET not in str(e) and e.__cause__ is None and e.__suppress_context__, "a refusal reports the provider's message, not the key, with no traceback chain")
    finally:
        urllib.request.urlopen = real_open
    old = talk.SECRETS
    talk.SECRETS = "env:INTAKE_TEST_NO_SUCH_KEY"
    try:
        talk.fetch_key()
        check(False, "a missing key explains how to add one")
    except LookupError as e:
        check("OPENAI_API_KEY" in str(e), "a missing key explains how to add one")
    finally:
        talk.SECRETS = old

    # ------------------------------------------------------------ live: one hello, no tools
    if LIVE:
        print("Live (OpenAI)")
        import asyncio
        import websockets

        instr = talk.instructions(s.data(), server.now_pt())
        live = talk.OpenAIRealtime().mint(instr)  # real key from the secret spec, used only server-side
        check(live["token"].startswith("ek_") and live["model"] == talk.MODEL, f"minted a client secret for {live['model']} with the real page config")

        async def hello():
            url = f"wss://api.openai.com/v1/realtime?model={talk.MODEL}"
            async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {live['token']}"}) as ws:
                await ws.send(json.dumps({"type": "conversation.item.create", "item": {
                    "type": "message", "role": "user", "content": [{"type": "input_text", "text": "Say hello in three words. Don't use any tools."}]}}))
                await ws.send(json.dumps({"type": "response.create", "response": {"tool_choice": "none", "output_modalities": ["text"]}}))
                text, calls, status, t0 = "", 0, None, time.time()
                while time.time() - t0 < 40:
                    e = json.loads(await asyncio.wait_for(ws.recv(), 40))
                    if e["type"] == "response.output_text.delta":
                        text += e.get("delta", "")
                    elif e["type"] == "error":
                        return None, 0, "error: " + e.get("error", {}).get("message", "")[:200]
                    elif e["type"] == "response.done":
                        r = e["response"]
                        status = r.get("status")
                        calls = sum(o.get("type") == "function_call" for o in r.get("output", []))
                        if not text:
                            text = " ".join(c.get("text", "") or c.get("transcript", "") for o in r.get("output", []) for c in o.get("content", []) or [])
                        break
                return text.strip(), calls, status

        snap, n0 = page_text(), commits()
        t0 = time.time()
        text, calls, status = asyncio.run(hello())
        print(f"       model said: {text!r} ({status}, {time.time() - t0:.1f}s)")
        check(status == "completed" and text and calls == 0, "live hello: a short reply, no tool calls")
        check(page_text() == snap and commits() == n0, "live hello: nothing written")
finally:
    shutil.rmtree(TMP, ignore_errors=True)
    try:
        server.UNDO_FILE.unlink()
    except FileNotFoundError:
        pass

print(f"\n{'FAILED: ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
