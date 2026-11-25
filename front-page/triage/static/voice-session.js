// A hands-free voice session: one tap keeps the mic live across cards.
//
// Chrome's SpeechRecognition ends on its own (after silence, and after about a
// minute even with continuous = true). While the session is active, every end
// starts a fresh recognizer straight away, so there is no gap between cards.
// Final results that arrive while a command is still being applied are dropped,
// as is anything that matches text the app itself just showed.
//
// No DOM access here, so tests can drive it with a fake recognizer.

const normalise = (s) => (s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

export class VoiceSession {
  constructor({
    Recognizer,
    lang = "en-US",
    onFinal = async () => {},
    onInterim = () => {},
    onState = () => {},
    onError = () => {},
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cooldownMs = 350,
    maxRestarts = 8,
    restartWindowMs = 10000,
  } = {}) {
    Object.assign(this, { Recognizer, lang, onFinal, onInterim, onState, onError, now, schedule, cooldownMs, maxRestarts, restartWindowMs });
    this.active = false;
    this.busy = false;
    this.rec = null;
    this.restarts = [];
    this.echoes = [];
    this.cooldownUntil = 0;
    this.stats = { finals: 0, ignoredBusy: 0, ignoredEcho: 0, restarts: 0 };
  }

  get supported() { return typeof this.Recognizer === "function"; }

  start() {
    if (this.active) return true;
    if (!this.supported) { this.onError("unsupported", "This browser has no speech recognition. Chrome or Edge on desktop works."); return false; }
    this.active = true;
    this.restarts = [];
    this._spawn();
    this.onState("listening");
    return true;
  }

  stop(reason = "stopped") {
    if (!this.active) return;
    this.active = false;
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch {}
    this.onInterim("");
    this.onState("off", reason);
  }

  toggle() { return this.active ? (this.stop(), false) : this.start(); }

  // Remember text the app just showed, so a mic picking it up is ignored.
  ignore(text, ms = 6000) {
    const n = normalise(text);
    if (n.length >= 4) this.echoes.push({ n, until: this.now() + ms });
  }

  _isEcho(text) {
    const t = this.now();
    this.echoes = this.echoes.filter((e) => e.until > t);
    const n = normalise(text);
    return !!n && this.echoes.some((e) => e.n === n || (n.length >= 8 && e.n.includes(n)));
  }

  _spawn() {
    const rec = new this.Recognizer();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const handled = new Set();
    const live = () => this.active && this.rec === rec;

    rec.onresult = (e) => {
      if (!live()) return;
      let interim = "";
      for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
        const r = e.results[i];
        const text = (r[0]?.transcript || "").trim();
        if (!r.isFinal) { interim += (interim ? " " : "") + text; continue; }
        if (handled.has(i)) continue;
        handled.add(i);
        if (!text) continue;
        if (this.busy || this.now() < this.cooldownUntil) { this.stats.ignoredBusy++; continue; }
        if (this._isEcho(text)) { this.stats.ignoredEcho++; continue; }
        this._dispatch(text);
      }
      this.onInterim(this.busy ? "" : interim);
    };

    rec.onerror = (e) => {
      if (!live()) return;
      const err = e?.error || "unknown";
      if (err === "no-speech" || err === "aborted") return; // onend restarts
      if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture") {
        this.stop("error");
        this.onError(err, "Microphone blocked. Allow it for this site in the browser's address-bar settings.");
        return;
      }
      if (err === "network") return; // counted as a restart in onend; repeated failures stop the session
      this.onError(err, `Speech recognition error: ${err}`);
    };

    rec.onend = () => {
      if (!live()) return;
      const t = this.now();
      this.restarts = this.restarts.filter((x) => t - x < this.restartWindowMs);
      this.restarts.push(t);
      if (this.restarts.length > this.maxRestarts) {
        this.stop("error");
        this.onError("restart-loop", "Speech recognition keeps stopping, so listening is off. Tap the mic to try again.");
        return;
      }
      this.stats.restarts++;
      this.schedule(() => { if (this.active && this.rec === rec) this._spawn(); }, 0);
    };

    try { rec.start(); }
    catch (err) {
      // start() throws if the previous instance hasn't released the mic yet.
      this.schedule(() => { if (this.active && this.rec === rec) this._spawn(); }, 150);
    }
  }

  async _dispatch(text) {
    this.stats.finals++;
    this.busy = true;
    this.onState("busy", text);
    try { await this.onFinal(text); }
    catch (err) { this.onError("command", err?.message || String(err)); }
    finally {
      this.busy = false;
      this.cooldownUntil = this.now() + this.cooldownMs;
      if (this.active) this.onState("listening");
    }
  }
}
