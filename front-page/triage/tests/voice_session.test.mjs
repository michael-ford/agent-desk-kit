// node --test tests/voice_session.test.mjs
// Drives VoiceSession with a fake SpeechRecognition.
import test from "node:test";
import assert from "node:assert/strict";
import { VoiceSession } from "../static/voice-session.js";

function harness(opts = {}) {
  const made = [];
  class FakeRec {
    constructor() { this.started = false; this.aborted = false; this.results = []; made.push(this); }
    start() { if (opts.throwOnStart && made.length === 2 && !this._threw) { this._threw = true; throw new Error("InvalidStateError"); } this.started = true; }
    abort() { this.aborted = true; }
    stop() { this.onend?.(); }
    // test helpers
    say(text, isFinal = true) {
      const r = Object.assign([{ transcript: text }], { isFinal });
      this.results.push(r);
      this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
    }
    interim(text) {
      const r = Object.assign([{ transcript: text }], { isFinal: false });
      this.onresult?.({ resultIndex: this.results.length, results: [...this.results, r] });
    }
    end() { this.onend?.(); }
    error(error) { this.onerror?.({ error }); }
  }
  let clock = 0;
  const timers = [];
  const heard = [];
  const states = [];
  const errors = [];
  let release = null;
  const s = new VoiceSession({
    Recognizer: FakeRec,
    now: () => clock,
    schedule: (fn, ms) => timers.push({ fn, at: clock + ms }),
    onFinal: (t) => { heard.push(t); return opts.slow ? new Promise((r) => { release = r; }) : Promise.resolve(); },
    onState: (st) => states.push(st),
    onError: (code, msg) => errors.push(code),
    onInterim: () => {},
  });
  const flush = () => { while (timers.length) timers.shift().fn(); };
  const tick = (ms) => { clock += ms; };
  return { s, made, heard, states, errors, flush, tick, release: () => release?.(), cur: () => made[made.length - 1] };
}

const settle = () => new Promise((r) => setImmediate(r));

test("start creates a continuous recognizer and passes finals through", async () => {
  const h = harness();
  h.s.start();
  assert.equal(h.made.length, 1);
  assert.equal(h.cur().continuous, true);
  assert.equal(h.cur().interimResults, true);
  h.cur().say("done");
  await settle();
  assert.deepEqual(h.heard, ["done"]);
});

test("auto-restarts when Chrome ends the session, with no gap and no lost commands", async () => {
  const h = harness();
  h.s.start();
  h.cur().end();            // silence timeout
  h.flush();
  assert.equal(h.made.length, 2, "a fresh recognizer was started");
  assert.equal(h.cur().started, true);
  h.tick(1000);
  h.cur().say("next");
  await settle();
  h.tick(65000);
  h.cur().end();            // the ~60 s limit
  h.flush();
  assert.equal(h.made.length, 3);
  h.cur().say("drop");
  await settle();
  assert.deepEqual(h.heard, ["next", "drop"]);
  assert.equal(h.s.active, true);
});

test("no restart after stop()", () => {
  const h = harness();
  h.s.start();
  const first = h.cur();
  h.s.stop();
  assert.equal(first.aborted, true);
  first.end();
  h.flush();
  assert.equal(h.made.length, 1);
  assert.equal(h.s.active, false);
  assert.equal(h.states.at(-1), "off");
});

test("results that arrive while a command is applying are ignored", async () => {
  const h = harness({ slow: true });
  h.s.start();
  h.cur().say("done");
  await settle();
  assert.equal(h.s.busy, true);
  h.cur().say("next");      // spoken while "done" is still being applied
  await settle();
  assert.deepEqual(h.heard, ["done"]);
  h.release();
  await settle();
  assert.equal(h.s.busy, false);
  h.tick(10);
  h.cur().say("too soon");  // inside the short cooldown
  h.tick(1000);
  h.cur().say("skip");
  await settle();
  assert.deepEqual(h.heard, ["done", "skip"]);
  assert.equal(h.s.stats.ignoredBusy, 2);
});

test("a final result is handled once even when Chrome re-sends the results list", async () => {
  const h = harness();
  h.s.start();
  const rec = h.cur();
  rec.say("done");
  await settle();
  h.tick(1000);
  rec.interim("comm");      // re-fires onresult with the old final still in the list
  rec.onresult({ resultIndex: 0, results: rec.results });
  await settle();
  assert.deepEqual(h.heard, ["done"]);
});

test("the app's own toast text is ignored", async () => {
  const h = harness();
  h.s.start();
  h.s.ignore("Rescheduled to Mon 26 Oct");
  h.cur().say("rescheduled to Mon 26 Oct");
  await settle();
  assert.deepEqual(h.heard, []);
  h.tick(7000);             // echo window over
  h.cur().say("rescheduled to Mon 26 Oct");
  await settle();
  assert.deepEqual(h.heard, ["rescheduled to Mon 26 Oct"]);
});

test("no-speech and network errors keep listening; a restart loop gives up", () => {
  const h = harness();
  h.s.start();
  h.cur().error("no-speech");
  h.cur().end();
  h.flush();
  assert.equal(h.s.active, true);
  assert.equal(h.made.length, 2);
  for (let i = 0; i < 9; i++) { h.cur().error("network"); h.cur().end(); h.flush(); h.tick(100); }
  assert.equal(h.s.active, false);
  assert.deepEqual(h.errors, ["restart-loop"]);
});

test("mic permission denied stops the session", () => {
  const h = harness();
  h.s.start();
  h.cur().error("not-allowed");
  h.cur().end();
  h.flush();
  assert.equal(h.s.active, false);
  assert.deepEqual(h.errors, ["not-allowed"]);
  assert.equal(h.made.length, 1);
});

test("start() that throws (mic not released yet) retries", () => {
  const h = harness({ throwOnStart: true });
  h.s.start();
  h.cur().end();
  h.flush();               // second instance throws on start, schedules a retry
  assert.equal(h.s.active, true);
  assert.equal(h.made.length, 3);
  assert.equal(h.cur().started, true);
});

test("unsupported browser reports and stays off", () => {
  const s = new VoiceSession({ Recognizer: undefined, onError: (c) => { s.err = c; } });
  assert.equal(s.start(), false);
  assert.equal(s.err, "unsupported");
});
