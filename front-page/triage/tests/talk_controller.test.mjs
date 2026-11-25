// node --test tests/talk_controller.test.mjs
// Drives TalkController with a fake transport, a fake server and a fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import { TalkController, END_RE } from "../static/talk.js";
import { translate } from "../static/talk-openai.js";

const tickle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function harness(opts = {}, toolFn) {
  let clock = 1_000_000;
  const timers = [];
  const schedule = (fn, ms) => { timers.push({ at: clock + ms, fn }); };
  async function advance(ms) {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      clock = t.at;
      t.fn();
      await tickle();
    }
    clock = end;
    await tickle();
  }
  const calls = [];
  const conns = [];
  const states = [];
  const uis = [];
  const errors = [];
  let n = 0;
  const api = async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    if (path === "/api/talk/session") return { ok: true, sid: body.sid || "s1", provider: "fake", connect: { kind: "fake" } };
    if (path === "/api/talk/tool") return toolFn ? toolFn(body) : { ok: true, output: { ok: true, did: body.name }, ui: { focus: "i3" } };
    if (path === "/api/talk/approve") return { ok: true, output: { ok: true }, ui: { pending: null } };
    if (path === "/api/talk/undo") return { ok: true, output: { undone: "Dropped: x" }, ui: { changed: true } };
    throw new Error("unexpected " + path);
  };
  const connect = async (info, { onEvent, onClose }) => {
    const c = {
      id: ++n, info, onEvent, onClose, sent: [], closed: false,
      respond() { this.sent.push(["respond"]); },
      toolResults(o) { this.sent.push(["toolResults", o]); },
      note(t) { this.sent.push(["note", t]); },
      mute(on) { this.sent.push(["mute", on]); },
      close() { this.closed = true; this.sent.push(["close"]); },
    };
    conns.push(c);
    return c;
  };
  const ctl = new TalkController({
    api, connect, file: "2026-10-24-intake.md", now: () => clock, schedule,
    onState: (s, why) => states.push([s, why]), onUi: (ui) => uis.push(ui), onError: (m) => errors.push(m), ...opts,
  });
  const last = () => conns[conns.length - 1];
  const emit = async (e) => { last().onEvent(e); await tickle(); };
  const toolCalls = () => calls.filter((c) => c.path === "/api/talk/tool");
  return { ctl, calls, conns, states, uis, errors, advance, emit, last, toolCalls, get clock() { return clock; } };
}

async function live(h) {
  await h.ctl.start();
  await h.emit({ type: "ready" });
}

test("opens a session and greets once ready", async () => {
  const h = harness();
  await live(h);
  assert.deepEqual(h.calls[0], { path: "/api/talk/session", body: { sid: null, file: "2026-10-24-intake.md", resume: null } });
  assert.equal(h.ctl.state, "live");
  assert.deepEqual(h.last().sent, [["respond"]]);
});

test("a completed tool call goes to the server and its result back to the model", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "user.final", itemId: "u1", text: "drop the newsletter" });
  await h.emit({ type: "response.started" });
  await h.emit({ type: "response.done", status: "completed", toolCalls: [{ callId: "c1", name: "drop", args: '{"id":"i3"}' }] });
  const tc = h.toolCalls();
  assert.equal(tc.length, 1);
  assert.equal(tc[0].body.name, "drop");
  assert.deepEqual(tc[0].body.args, { id: "i3" });
  assert.equal(tc[0].body.heard[0].text, "drop the newsletter");
  assert.deepEqual(h.last().sent.at(-1), ["toolResults", [{ callId: "c1", output: { ok: true, did: "drop" } }]]);
  assert.equal(h.ctl.focus, "i3");
  assert.equal(h.uis.at(-1).focus, "i3");
});

test("an interrupted response's tool call does not run, and the model is told", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "response.started" });
  await h.emit({ type: "response.done", status: "cancelled", toolCalls: [{ callId: "c1", name: "mark_done", args: '{"id":"i1"}' }] });
  assert.equal(h.toolCalls().length, 0);
  await h.advance(2000);
  const note = h.last().sent.find((s) => s[0] === "note");
  assert.ok(note && /did NOT run/.test(note[1]));
});

test("a batch confirmation waits for the owner's words to be transcribed", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "user.speaking" });
  await h.emit({ type: "user.pending", itemId: "u9" });
  await h.emit({ type: "response.done", status: "completed", toolCalls: [{ callId: "c2", name: "batch", args: '{"confirm_id":"abc"}' }] });
  await h.advance(300);
  assert.equal(h.toolCalls().length, 0, "held until the transcript lands");
  h.last().onEvent({ type: "user.final", itemId: "u9", text: "yes do it" });
  await h.advance(200);
  const tc = h.toolCalls();
  assert.equal(tc.length, 1);
  assert.equal(tc[0].body.heard.at(-1).text, "yes do it");
});

test("app updates are injected only when idle, at most four at a time", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "response.started" });
  for (let i = 1; i <= 6; i++) h.ctl.queueNote(`[App update, not the owner speaking] note ${i}`);
  await h.advance(3000);
  assert.equal(h.last().sent.filter((s) => s[0] === "note").length, 0, "not while the model is talking");
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.advance(400);
  let notes = h.last().sent.filter((s) => s[0] === "note");
  assert.equal(notes.length, 1);
  assert.equal(notes[0][1].split("\n").length, 4);
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.advance(400);
  notes = h.last().sent.filter((s) => s[0] === "note");
  assert.equal(notes.length, 2);
  assert.match(notes[1][1], /note 6/);
});

test("app updates wait while the owner is speaking", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.emit({ type: "user.speaking" });
  h.ctl.queueNote("[App update, not the owner speaking] the assistant answered");
  await h.advance(2000);
  assert.equal(h.last().sent.filter((s) => s[0] === "note").length, 0);
  await h.emit({ type: "user.final", itemId: "u1", text: "next" });
  await h.advance(600);
  assert.equal(h.last().sent.filter((s) => s[0] === "note").length, 0, "lets the model answer them first (settle time)");
  await h.advance(1500);
  assert.equal(h.last().sent.filter((s) => s[0] === "note").length, 1);
});

test("'that's all' ends after the goodbye has been spoken", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "user.final", itemId: "u1", text: "Okay, that's all for today." });
  assert.equal(h.ctl.state, "ending");
  await h.emit({ type: "response.started" });
  await h.emit({ type: "assistant.audioStopped" });
  assert.equal(h.ctl.state, "ending", "not mid-response");
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.emit({ type: "assistant.audioStopped" });
  assert.equal(h.ctl.state, "off");
  assert.deepEqual(h.states.at(-1), ["off", "done"]);
  assert.ok(h.conns[0].closed);
});

test("ending falls back to a grace period if the audio-stopped event never comes", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "user.final", itemId: "u1", text: "stop" });
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.advance(2400);
  assert.equal(h.ctl.state, "ending");
  await h.advance(200);
  assert.equal(h.ctl.state, "off");
  const h2 = harness();
  await live(h2);
  await h2.emit({ type: "user.final", itemId: "u1", text: "goodbye" });
  await h2.advance(8100);
  assert.equal(h2.ctl.state, "off", "8 s hard stop with no response at all");
});

test("stops after three quiet minutes", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.advance(170000);
  assert.equal(h.ctl.state, "live");
  await h.advance(20000);
  assert.deepEqual(h.states.at(-1), ["off", "idle"]);
});

test("a dropped line reconnects with resume context and does not replay old tool results", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({}, async (body) => { await gate; return { ok: true, output: { ok: true, did: body.name }, ui: {} }; });
  await live(h);
  await h.emit({ type: "user.final", itemId: "u1", text: "mark the plumber one done" });
  await h.emit({ type: "assistant.done", text: "Done." });
  await h.emit({ type: "response.done", status: "completed", toolCalls: [{ callId: "c1", name: "mark_done", args: '{"id":"i2"}' }] });
  const first = h.last();
  first.onClose("data channel closed");
  await h.advance(10);
  assert.equal(h.conns.length, 2);
  const reopen = h.calls.filter((c) => c.path === "/api/talk/session")[1];
  assert.equal(reopen.body.sid, "s1");
  assert.deepEqual(reopen.body.resume.captions.map((c) => c.text), ["mark the plumber one done", "Done."]);
  release();
  await h.advance(10);
  assert.equal(first.sent.filter((s) => s[0] === "toolResults").length, 0, "old connection gets nothing");
  assert.equal(h.last().sent.filter((s) => s[0] === "toolResults").length, 0, "new connection gets no stale call_id");
  await h.emit({ type: "ready" });
  assert.equal(h.ctl.state, "live");
  const sent = h.last().sent;
  assert.equal(sent.filter((s) => s[0] === "respond").length, 0, "no fresh greeting");
  assert.match(sent.find((s) => s[0] === "note")[1], /dropped/);
});

test("events from a replaced connection are ignored", async () => {
  const h = harness();
  await live(h);
  const old = h.last();
  old.onClose("x");
  await h.advance(10);
  old.onEvent({ type: "response.done", status: "completed", toolCalls: [{ callId: "c9", name: "drop", args: '{"id":"i1"}' }] });
  await h.advance(10);
  assert.equal(h.toolCalls().length, 0);
});

test("gives up after three reconnects in ten minutes", async () => {
  const h = harness();
  await live(h);
  for (let i = 0; i < 3; i++) {
    h.last().onClose("drop");
    await h.advance(10);
    await h.emit({ type: "ready" });
  }
  assert.equal(h.ctl.state, "live");
  h.last().onClose("drop");
  await h.advance(10);
  assert.equal(h.ctl.state, "off");
  assert.match(h.errors.at(-1), /keeps dropping/);
});

test("renews the connection before the provider's session limit, when idle", async () => {
  const h = harness({ idleMs: 10 * 3600000 });
  await live(h);
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.advance(54 * 60000);
  assert.equal(h.conns.length, 1);
  await h.advance(2 * 60000);
  assert.equal(h.conns.length, 2);
  const reopen = h.calls.filter((c) => c.path === "/api/talk/session")[1];
  assert.ok(reopen.body.resume, "carries resume context");
  await h.emit({ type: "ready" });
  assert.equal(h.last().sent.length, 0, "a renewal says nothing");
  assert.ok(h.conns[0].closed);
});

test("screen taps reach the server and the model hears about them", async () => {
  const h = harness();
  await live(h);
  await h.emit({ type: "response.done", status: "completed", toolCalls: [] });
  await h.ctl.approve("abc", "yes");
  await h.ctl.undoEntry(2);
  await h.advance(2000);
  assert.deepEqual(h.calls.filter((c) => c.path === "/api/talk/approve")[0].body, { sid: "s1", confirm_id: "abc", decision: "yes" });
  assert.deepEqual(h.calls.filter((c) => c.path === "/api/talk/undo")[0].body, { sid: "s1", seq: 2 });
  const note = h.last().sent.find((s) => s[0] === "note")[1];
  assert.match(note, /tapped Yes/);
  assert.match(note, /undid this on screen: Dropped: x/);
});

test("END_RE: endings, not instructions", () => {
  for (const t of ["that's all", "That's it.", "okay, that's all for today", "stop", "we're done", "end the session", "bye", "Goodbye!", "thanks, that's everything"]) {
    assert.ok(END_RE.test(t), t);
  }
  for (const t of ["stop the Acme one", "that's all of them done", "drop it", "is that all?", "bye bye invoice"]) {
    assert.ok(!END_RE.test(t), t);
  }
});

test("translate(): OpenAI realtime events to neutral ones", () => {
  assert.deepEqual(translate({ type: "input_audio_buffer.speech_started" }), { type: "user.speaking" });
  assert.deepEqual(translate({ type: "input_audio_buffer.committed", item_id: "it1" }), { type: "user.pending", itemId: "it1" });
  assert.deepEqual(translate({ type: "conversation.item.input_audio_transcription.completed", item_id: "it1", transcript: "yes" }), { type: "user.final", itemId: "it1", text: "yes" });
  assert.deepEqual(translate({ type: "conversation.item.input_audio_transcription.failed", item_id: "it1" }), { type: "user.final", itemId: "it1", text: "" });
  assert.deepEqual(translate({ type: "response.created" }), { type: "response.started" });
  assert.deepEqual(translate({ type: "response.output_audio_transcript.delta", delta: "Hi" }), { type: "assistant.delta", text: "Hi" });
  assert.deepEqual(translate({ type: "response.output_audio_transcript.done", transcript: "Hi there" }), { type: "assistant.done", text: "Hi there" });
  assert.deepEqual(translate({ type: "output_audio_buffer.stopped" }), { type: "assistant.audioStopped" });
  assert.deepEqual(translate({ type: "response.done", response: { status: "completed", output: [
    { type: "message" }, { type: "function_call", call_id: "c1", name: "drop", arguments: '{"id":"i1"}' }] } }),
  { type: "response.done", status: "completed", toolCalls: [{ callId: "c1", name: "drop", args: '{"id":"i1"}' }] });
  assert.deepEqual(translate({ type: "error", error: { message: "expired", code: "session_expired" } }), { type: "error", message: "expired", code: "session_expired", fatal: true });
  assert.equal(translate({ type: "error", error: { message: "x", code: "invalid_value" } }).fatal, false);
  assert.equal(translate({ type: "rate_limits.updated" }), null);
});
