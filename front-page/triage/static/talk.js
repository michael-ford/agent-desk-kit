// Talk it through: the conversation controller.
//
// No DOM and no audio here. A provider adapter (talk-openai.js, talk-fake.js)
// owns the connection and turns provider events into the neutral events
// handled below. Tool calls go to the local server, which is the only thing
// that touches the vault. Tests drive this with a fake transport.
//
// Neutral events in:  ready, user.speaking, user.pending{itemId}, user.final{itemId,text},
//   response.started, assistant.delta{text}, assistant.done{text}, assistant.audioStopped,
//   response.done{status, toolCalls:[{callId,name,args}]}, error{message,code,fatal}
// Transport out: respond(), toolResults([{callId,output}], {respond}), note(text, {respond}),
//   mute(bool), close()

export const END_RE = /^\W*(?:(?:ok(?:ay)?|right|cool|great|thanks|thank you)[,.!]?\s+)*(?:that'?s (?:all|it|everything)(?: for (?:now|today))?|that is all|stop|stop (?:talking|listening|there|the session)|we'?re done(?: here| for (?:now|today))?|i'?m done for (?:now|today)|end (?:the )?(?:session|call|conversation)|good ?bye|bye(?: for now)?)\W*$/i;

const NOTE = "[App update, not the owner speaking]";

export class TalkController {
  constructor({
    api, connect, file,
    onCaption = () => {}, onState = () => {}, onUi = () => {}, onError = () => {},
    now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms),
    idleMs = 180000, renewMs = 55 * 60000, maxReconnects = 3, settleMs = 1200, tickMs = 5000,
  } = {}) {
    Object.assign(this, { api, connect, file, onCaption, onState, onUi, onError, now, schedule, idleMs, renewMs, maxReconnects, settleMs, tickMs });
    this.state = "off";
    this.gen = 0;
    this.t = null;
    this.reset();
  }

  reset() {
    this.sid = null;
    this.captions = [];
    this.heard = [];
    this.notes = [];
    this.pendingUser = new Set();
    this.responding = false;
    this.toolBusy = false;
    this.userSpeaking = false;
    this.lastUserAt = 0;
    this.lastActivity = this.now();
    this.ending = false;
    this.focus = null;
    this.reconnects = [];
    this.muted = false;
    this.stats = { toolCalls: 0, notes: 0, reconnects: 0, dropped: 0 };
  }

  get active() { return this.state !== "off"; }

  setState(s, why) { this.state = s; this.onState(s, why); }

  async start() {
    if (this.active) return;
    this.reset();
    this.setState("connecting");
    try { await this.open(null, "start"); }
    catch (e) { this.stop("error"); this.onError(e.message || String(e)); return; }
    this.tick();
  }

  // Open (or reopen) a provider connection. resume carries what the new
  // session needs to pick up the thread; the server adds the action log.
  async open(resume, reason) {
    const info = await this.api("/api/talk/session", { sid: this.sid, file: this.file, resume });
    if (this.state === "off") return;
    this.sid = info.sid;
    this.info = info;
    const gen = ++this.gen;
    this.reason = reason;
    let early = false;  // "ready" can fire before connect() has returned the transport
    const t = await this.connect(info, {
      onEvent: (e) => {
        if (gen !== this.gen) return;
        if (!this.t && e.type === "ready") { early = true; return; }
        this.event(e);
      },
      onClose: (why) => { if (gen === this.gen) this.closed(why); },
    });
    if (gen !== this.gen || this.state === "off") { try { t.close(); } catch {} return; }
    this.t = t;
    if (this.muted) t.mute?.(true);
    this.startedAt = this.now();
    if (early) this.event({ type: "ready" });
  }

  stop(why = "stopped") {
    if (this.state === "off") return;
    this.gen++;
    try { this.t?.close(); } catch {}
    this.t = null;
    this.responding = this.toolBusy = false;
    this.setState("off", why);
  }

  mute(on) { this.muted = !!on; this.t?.mute?.(this.muted); }

  // ---------------------------------------------------------------- events

  event(e) {
    switch (e.type) {
      case "ready":
        this.setState("live");
        this.lastActivity = this.now();
        if (this.reason === "start") this.respond();
        else if (this.reason === "dropped") {
          this.responding = true;
          this.t?.note(`${NOTE} The voice line dropped for a moment and is back. Say one short line and carry on.`, { respond: true });
        }
        return;
      case "user.speaking":
        this.userSpeaking = true;
        this.lastActivity = this.now();
        return;
      case "user.pending":
        if (e.itemId) this.pendingUser.add(e.itemId);
        return;
      case "user.final": {
        if (e.itemId) this.pendingUser.delete(e.itemId);
        this.userSpeaking = false;
        this.lastUserAt = this.lastActivity = this.now();
        const text = (e.text || "").trim();
        if (text) {
          this.heard.push({ text, at: this.now() });
          this.heard = this.heard.slice(-12);
          this.caption("you", text, true);
          if (END_RE.test(text)) this.beginEnding();
        }
        this.flushSoon();
        return;
      }
      case "response.started":
        this.responding = true;
        return;
      case "assistant.delta":
        this.lastActivity = this.now();
        this.caption("aide", e.text || "", false);
        return;
      case "assistant.done":
        this.caption("aide", e.text, true, true);
        return;
      case "assistant.audioStopped":
        if (this.ending && !this.responding) this.stop("done");
        return;
      case "response.done":
        this.responding = false;
        this.lastActivity = this.now();
        this.closeCaption();
        if (e.toolCalls?.length) {
          if (e.status && e.status !== "completed") {
            this.stats.dropped += e.toolCalls.length;
            this.queueNote(`${NOTE} Your last tool call was interrupted and did NOT run. Nothing changed.`);
          } else {
            this.runTools(e.toolCalls);
            return;
          }
        }
        if (this.ending) { this.schedule(() => { if (this.ending && !this.responding) this.stop("done"); }, 2500); return; }
        this.flushSoon();
        return;
      case "error":
        if (e.code === "conversation_already_has_active_response") return;
        if (e.fatal) { this.closed(e.message); return; }
        this.onError(e.message || "The voice service reported an error.");
        return;
      default:
    }
  }

  respond() { this.responding = true; this.t?.respond(); }

  caption(who, text, final, replace = false) {
    const last = this.captions[this.captions.length - 1];
    if (who === "aide" && last && last.who === "aide" && !last.final) {
      last.text = replace ? (text || last.text) : last.text + text;
      last.final = final;
    } else if (who === "aide" && replace && last && last.who === "aide") {
      last.text = text || last.text;
    } else {
      this.captions.push({ who, text, final });
    }
    this.captions = this.captions.slice(-40);
    this.onCaption(this.captions);
  }
  closeCaption() {
    const last = this.captions[this.captions.length - 1];
    if (last && !last.final) { last.final = true; this.onCaption(this.captions); }
  }

  // ---------------------------------------------------------------- tools

  async waitForTranscripts(ms = 3000) {
    const until = this.now() + ms;
    while (this.pendingUser.size && this.now() < until) await new Promise((r) => this.schedule(r, 100));
  }

  async runTools(calls) {
    const gen = this.gen;
    this.toolBusy = true;
    const outputs = [];
    for (const c of calls) {
      this.stats.toolCalls++;
      let args = c.args;
      try { if (typeof args === "string") args = JSON.parse(args || "{}"); } catch { /* the server reports bad JSON */ }
      // A batch confirmation is checked against what the owner actually said; let their words land first.
      if (c.name === "batch" && args && args.confirm_id) await this.waitForTranscripts();
      let res;
      try {
        res = await this.api("/api/talk/tool", { sid: this.sid, name: c.name, args, callId: c.callId, heard: this.heard.slice(-6) });
      } catch (err) {
        res = { output: { ok: false, error: `The app couldn't run that: ${err.message}` }, ui: {} };
      }
      outputs.push({ callId: c.callId, output: res.output });
      if (res.ui?.focus) this.focus = res.ui.focus;
      try { this.onUi(res.ui || {}, { name: c.name, args, output: res.output }); } catch {}
    }
    this.toolBusy = false;
    this.lastActivity = this.now();
    // Results from a connection that has since been replaced are not replayed:
    // the change is already on disk and in the log the new session was given.
    if (gen !== this.gen || !this.t) return;
    this.responding = true;
    this.t.toolResults(outputs, { respond: true });
  }

  // The owner tapped Yes/No on a batch proposal, or Undo on a log entry.
  async approve(confirmId, decision) {
    const res = await this.api("/api/talk/approve", { sid: this.sid, confirm_id: confirmId, decision });
    this.onUi(res.ui || {}, { name: "approve", output: res.output });
    this.queueNote(decision === "yes"
      ? `${NOTE} the owner tapped Yes on the batch proposal on screen. It ran: ${JSON.stringify(res.output)}`
      : `${NOTE} the owner tapped No on the batch proposal. Nothing changed.`);
    return res;
  }
  async undoEntry(seq) {
    const res = await this.api("/api/talk/undo", { sid: this.sid, seq });
    this.onUi(res.ui || {}, { name: "undo", output: res.output });
    this.queueNote(`${NOTE} the owner undid this on screen: ${res.output?.undone}. It is reversed.`);
    return res;
  }

  // ---------------------------------------------------------------- notes (the assistant's answers and screen taps)

  queueNote(text) { this.notes.push(text); this.flushSoon(); }

  idle() {
    return this.state === "live" && this.t && !this.responding && !this.toolBusy && !this.userSpeaking &&
      !this.pendingUser.size && this.now() - this.lastUserAt >= this.settleMs;
  }

  flushSoon() {
    if (this.flushTimer || !this.notes.length) return;
    this.flushTimer = true;
    this.schedule(() => { this.flushTimer = false; this.flush(); }, 300);
  }

  flush() {
    if (!this.notes.length || this.state === "off") return;
    if (!this.idle()) { this.flushSoon(); return; }
    const text = this.notes.splice(0, 4).join("\n");
    this.stats.notes++;
    this.responding = true;
    this.t.note(text, { respond: true });
    if (this.notes.length) this.flushSoon();
  }

  // ---------------------------------------------------------------- ending, idle, reconnect

  beginEnding() {
    this.ending = true;
    this.setState("ending");
    this.schedule(() => { if (this.ending) this.stop("done"); }, 8000);
  }

  tick() {
    if (this.state === "off") return;
    const t = this.now();
    if (this.state === "live" && !this.responding && !this.toolBusy && !this.userSpeaking && t - this.lastActivity > this.idleMs) {
      this.stop("idle");
      return;
    }
    if (this.state === "live" && this.startedAt && t - this.startedAt > this.renewMs && this.idle() && !this.notes.length) {
      this.reopen("renew");
    }
    this.schedule(() => this.tick(), this.tickMs);
  }

  closed(why) {
    if (this.state === "off") return;
    if (this.ending) { this.stop("done"); return; }
    this.reopen("dropped", why);
  }

  async reopen(reason, why) {
    const t = this.now();
    this.reconnects = this.reconnects.filter((x) => t - x < 600000);
    if (this.reconnects.length >= this.maxReconnects) {
      this.stop("error");
      this.onError("The voice line keeps dropping, so Talk it through stopped. Everything done so far is saved.");
      return;
    }
    this.reconnects.push(t);
    this.stats.reconnects++;
    this.gen++;                       // ignore anything the old connection still says
    try { this.t?.close(); } catch {}
    this.t = null;
    this.responding = this.toolBusy = this.userSpeaking = false;
    this.pendingUser.clear();
    this.setState("reconnecting", why || reason);
    const resume = { captions: this.captions.filter((c) => c.text).slice(-8).map(({ who, text }) => ({ who, text })), focus: this.focus };
    for (const wait of [0, 1000, 3000]) {
      if (wait) await new Promise((r) => this.schedule(r, wait));
      if (this.state === "off") return;
      try { await this.open(resume, reason); return; }
      catch (e) { if (e.status && e.status < 500 && e.status !== 429) break; }
    }
    this.stop("error");
    this.onError("Couldn't reconnect the voice line. Everything done so far is saved; tap Talk to start again.");
  }
}
