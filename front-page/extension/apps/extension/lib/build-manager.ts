import Anthropic from "@anthropic-ai/sdk";
import { parseWorldList, runHomepageBuild, seenForPrompt, type RunPhase } from "@homepage/agent-core";
import { leadOf, rememberLead } from "./lead";
import { nextAttempts, rebuildIntervalHours, shouldAutoRebuild, type SlotAttempts } from "./auto-rebuild";
import { browserBridge } from "./browser-bridge";
import { flushCommentOutbox } from "./assistant";
import { loadSeen } from "./seen";
import { flushAdvisoryOutbox, reportAdvisories } from "./advisories";
import {
  MAX_ATTEMPTS as MORNING_MAX_ATTEMPTS,
  MORNING_END_HOUR,
  MORNING_START_HOUR,
  fetchTriage,
  loadMorningRecord,
  localDate,
  flushEditionOutbox,
  morningPushDue,
  morningPushEnabled,
  runMorningPush,
  type MorningRecord,
} from "./morning";
import { BUILD_INFO, WORLD_LIST, readDiskBuildInfo, type SelfReload, type WorkerBuild } from "./build-info";
import {
  INITIAL_BUILD_STATE,
  LOG_RETENTION,
  stepForPhase,
  type BuildMsg,
  type BuildState,
  type PageMsg,
} from "./protocol";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveHomepage } from "./storage";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

/**
 * While a turn is active, ping a cheap chrome API on this interval to reset the
 * ~30s MV3 idle-unload timer. The ~1 min alarm heartbeat is the slower safety
 * net that reattaches after an unexpected kill.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** Storage snapshots are throttled so narration deltas don't flood chrome.storage. */
const SNAPSHOT_THROTTLE_MS = 2_000;
/** A late-joining tab doesn't need the whole narration, just enough to look alive. */
const NARRATION_STORAGE_CAP = 2_000;

/**
 * Owns the single build. Runs `runHomepageBuild` in the worker, holds live state,
 * enforces a single-flight lock, broadcasts progress to every connected tab,
 * mirrors a throttled snapshot to storage, and reattaches to an interrupted run
 * on wake.
 *
 * There is one instance per service worker — i.e. one per browser profile — so
 * single-flight is per-profile, which is the right grain.
 */
export class BuildManager {
  private state: BuildState = { ...INITIAL_BUILD_STATE };
  private readonly ports = new Set<Port>();
  /** Tabs that asked the worker not to reload itself right now. */
  private readonly busyPorts = new Set<Port>();
  private controller: AbortController | null = null;
  private running = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- port lifecycle ------------------------------------------------------

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => this.onPageMessage(port, raw as PageMsg));
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      this.busyPorts.delete(port);
    });
  }

  private onPageMessage(port: Port, msg: PageMsg) {
    switch (msg.kind) {
      case "subscribe":
        this.send(port, { kind: "snapshot", state: this.state });
        break;
      case "startBuild":
        void this.startBuild({ resume: msg.resume });
        break;
      case "cancel":
        this.cancel();
        break;
      case "busy":
        if (msg.busy) this.busyPorts.add(port);
        else this.busyPorts.delete(port);
        break;
    }
  }

  private send(port: Port, msg: BuildMsg) {
    try {
      port.postMessage(msg);
    } catch {
      // Port went away between the has-check and the post; drop it.
      this.ports.delete(port);
    }
  }

  private broadcast(msg: BuildMsg) {
    for (const port of [...this.ports]) this.send(port, msg);
  }

  // ---- heartbeat -----------------------------------------------------------

  /**
   * Called on worker wake and on every alarm tick. If a session was left
   * mid-flight, reattach and continue (lossless — the orchestrator replays the
   * event log and re-answers orphaned tool calls). Otherwise, consider the daily
   * rebuild. The single-flight lock is the arbiter that keeps these from racing.
   */
  /** The tick in progress. Worker start fires tick() from several places at once; they share one. */
  private ticking: Promise<void> | null = null;

  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick() {
    // Comments written while the Intake Triage server was down. Independent of
    // builds, and cheap when the outbox is empty.
    await flushCommentOutbox().catch((err) => console.error("[BuildManager] comment outbox", err));
    await flushAdvisoryOutbox().catch((err) => console.error("[BuildManager] advisory outbox", err));
    await flushEditionOutbox().catch((err) => console.error("[BuildManager] edition outbox", err));

    if (this.running) {
      // A run is live but the worker may have just woken; make sure the
      // self-keepalive is ticking so the active turn stays warm.
      this.startKeepalive();
      this.kickMorningPush();
      return;
    }

    const sessionId = await extensionStore.get<string>(KEYS.activeSessionId);
    if (sessionId) {
      void this.startBuild({ resume: true });
      return;
    }

    // Before any scheduled build: if newer code is on disk, run that instead.
    if (await this.reloadIfNewerBuild()) return;

    await this.maybeAutoRebuild();
    // After the rebuild check, so a build it just started holds the push back.
    this.kickMorningPush();
  }

  // ---- morning edition (morning.ts) ------------------------------------------

  private morning: Promise<MorningRecord | null> | null = null;

  /** Fire-and-forget: a push takes a minute and must not hold up the heartbeat. */
  private kickMorningPush() {
    if (this.morning) return;
    this.morning = this.maybeMorningPush()
      .catch((err) => {
        console.error("[BuildManager] morning edition", err);
        return null;
      })
      .finally(() => {
        this.morning = null;
      });
  }

  private async maybeMorningPush(): Promise<MorningRecord | null> {
    const now = new Date();
    const hour = now.getHours();
    if (hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) return null; // cheap exit outside the window, no fetches
    const [enabled, record, homepage] = await Promise.all([morningPushEnabled(), loadMorningRecord(), loadHomepage()]);
    if (!enabled || (record?.status === "done" && record.date === localDate(now))) return null;
    const triage = await fetchTriage();
    const due = morningPushDue({ now, enabled, record, homepageBuilt: homepage?.timestamp, buildRunning: this.running, triage });
    if (!due.due) return null;
    console.log("[BuildManager] morning edition due:", due.reason);
    this.keepWarm(true);
    try {
      const result = await runMorningPush("schedule", now);
      if (result.status === "failed" && result.attempts >= MORNING_MAX_ATTEMPTS) this.notify("Morning edition failed", result.error ?? "");
      return result;
    } finally {
      this.keepWarm(false);
    }
  }

  /** "Send now" from Settings: runs whatever the time, and resends if today's already went. */
  async morningPushNow(): Promise<MorningRecord> {
    while (this.morning) await this.morning;
    const run = (async () => {
      this.keepWarm(true);
      try {
        return await runMorningPush("manual");
      } finally {
        this.keepWarm(false);
      }
    })();
    this.morning = run;
    try {
      return await run;
    } finally {
      this.morning = null;
    }
  }

  /** Record which build this worker is running, so it can be checked from the page or storage. */
  async recordWorkerBuild() {
    const record: WorkerBuild = { ...BUILD_INFO, startedAt: new Date().toISOString() };
    await extensionStore.set(KEYS.workerBuild, record);
  }

  /**
   * Reload the extension when `build-info.json` on disk is from a different
   * build than this worker's code. Only called while idle (no build, no session
   * to reattach), so it never interrupts a build. A reload that leaves the same
   * mismatch behind is not retried; the page banner stays up instead.
   */
  private async reloadIfNewerBuild(): Promise<boolean> {
    const disk = await readDiskBuildInfo();
    if (!disk || disk.id === BUILD_INFO.id) return false;

    const last = await extensionStore.get<SelfReload>(KEYS.selfReload);
    if (last && last.from === BUILD_INFO.id && last.to === disk.id) return false;
    // A build may have started (from a tab) while we were awaiting. And a
    // reload closes every extension page: don't throw away an open Triage view
    // (possibly mid-conversation) or a half-written comment. The next idle tick
    // reloads; the page banner says why it's waiting.
    if (this.running || this.busyPorts.size > 0) return false;
    // The worker is unloaded when idle, which drops every port; open extension
    // tabs reconnect and re-declare "busy" within about a second. Wait until
    // every open tab has reconnected. (A fixed grace period after start never
    // ended: with no tab open, every alarm wakes a fresh worker.)
    const tabs = await browser.runtime.getContexts({ contextTypes: [browser.runtime.ContextType.TAB] });
    if (tabs.length > this.ports.size || this.running || this.busyPorts.size > 0) return false;

    console.log("[BuildManager] newer build on disk, reloading", { running: BUILD_INFO.id, disk: disk.id });
    const record: SelfReload = { from: BUILD_INFO.id, to: disk.id, at: new Date().toISOString() };
    await extensionStore.set(KEYS.selfReload, record);
    browser.runtime.reload();
    return true;
  }

  /** Whether opening the day's first tab should already show a fresh homepage. */
  private async maybeAutoRebuild() {
    const [settings, homepage, attempts] = await Promise.all([
      loadSettings(),
      loadHomepage(),
      extensionStore.get<SlotAttempts>(KEYS.autoBuildAttempts),
    ]);
    const now = new Date();
    const intervalHours = rebuildIntervalHours(settings.rebuildIntervalHours);

    if (
      !shouldAutoRebuild({
        enabled: settings.autoRebuild,
        hasApiKey: Boolean(settings.apiKey),
        isRunning: this.running,
        lastBuildTimestamp: homepage?.timestamp,
        attempts,
        intervalHours,
        now,
      })
    ) {
      return;
    }

    // Record the attempt before starting so a second wake doesn't double-start
    // it, and a failure waits out the retry delay.
    await extensionStore.set(KEYS.autoBuildAttempts, nextAttempts(attempts, now, intervalHours));
    void this.startBuild({ resume: false });
  }

  // ---- the build -----------------------------------------------------------

  async startBuild(opts: { resume?: boolean } = {}) {
    if (this.running) {
      console.log("[BuildManager] startBuild ignored — a build is already running");
      return; // single-flight: a second start just attaches.
    }

    // Claim the lock before the first await, so a second caller arriving while
    // settings load sees it and can't start a second paid build.
    this.running = true;
    const { apiKey, systemPrompt, model } = await loadSettings();
    if (!apiKey) {
      // Manual builds are gated behind the key-setup screen and auto-builds
      // require a key, so this only happens if the key was removed.
      console.warn("[BuildManager] startBuild aborted — no API key in storage");
      const message = "No Anthropic API key found. Add your key and try again.";
      this.running = false;
      this.state = { ...INITIAL_BUILD_STATE, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      return;
    }

    this.controller = new AbortController();
    this.state = { ...INITIAL_BUILD_STATE, running: true, phase: "setup" };
    this.broadcast({ kind: "snapshot", state: this.state });
    this.startKeepalive();
    console.log("[BuildManager] build started", { resume: Boolean(opts.resume) });

    try {
      // The key is the user's own, read from local storage — there is no server
      // to hide it behind. See ARCHITECTURE.md → Privacy.
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

      const resumeSessionId = opts.resume
        ? await extensionStore.get<string>(KEYS.activeSessionId)
        : undefined;

      let recentLeads = (await extensionStore.get<string[]>(KEYS.recentLeads)) ?? [];
      if (!recentLeads.length) {
        // First build with lead tracking: seed from the page currently shown.
        const lead = leadOf(await loadHomepage());
        if (lead) recentLeads = [lead];
      }

      const result = await runHomepageBuild({
        client,
        recentLeads,
        worldList: WORLD_LIST,
        seen: seenForPrompt(await loadSeen(), new Date()),
        bridge: browserBridge,
        store: extensionStore,
        userSystemPrompt: systemPrompt,
        model,
        resumeSessionId,
        signal: this.controller.signal,
        callbacks: {
          onPhase: (phase, detail) => this.onPhase(phase, detail),
          onText: (chunk) => this.onText(chunk),
          onLog: (line) => this.onLog(line),
        },
      });

      // runHomepageBuild has validated the data; a page that fails validation
      // throws there, and the previous homepage is kept.
      const homepage = await saveHomepage(result.data, BUILD_INFO.version);
      const lead = leadOf(homepage);
      if (lead) await extensionStore.set(KEYS.recentLeads, rememberLead(recentLeads, lead));
      // Critical and high flaws in a world-list project go to the assistant. Never fails the build.
      await reportAdvisories(result.data, parseWorldList(WORLD_LIST)).catch((err) =>
        console.error("[BuildManager] advisories", err),
      );

      this.state = { ...this.state, running: false, phase: "done" };
      this.broadcast({ kind: "done", homepage });
      await this.mirror(true);
      console.log("[BuildManager] build done", { items: result.data.items.length, source: result.source });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = /homepage\.json/.test(raw) ? `${raw}. The previous homepage was kept; click Rebuild to try again.` : raw;
      this.state = { ...this.state, running: false, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      await this.mirror(true);
      this.notifyFailure(message);
      console.error("[BuildManager] build failed", error);
    } finally {
      this.running = false;
      this.controller = null;
      this.stopKeepalive();
    }
  }

  cancel() {
    this.controller?.abort();
  }

  // ---- callback fan-out ----------------------------------------------------

  private onPhase(phase: RunPhase, detail?: string) {
    const mapped = stepForPhase(phase);
    const stepIndex =
      mapped === undefined ? this.state.stepIndex : Math.max(this.state.stepIndex, mapped);
    this.state = { ...this.state, phase, stepIndex, detail: detail ?? "" };
    this.broadcast({ kind: "phase", phase, stepIndex, detail: detail ?? "" });
    void this.mirror(false);
  }

  private onText(chunk: string) {
    this.state = { ...this.state, narration: this.state.narration + chunk };
    this.broadcast({ kind: "text", chunk });
    void this.mirror(false);
  }

  private onLog(line: string) {
    this.state = { ...this.state, logs: [...this.state.logs.slice(-LOG_RETENTION), line] };
    this.broadcast({ kind: "log", line });
    void this.mirror(false);
  }

  // ---- storage mirror ------------------------------------------------------

  /**
   * Mirror a lightweight snapshot to storage so a tab that opens while the worker
   * is asleep paints last-known state instantly; the heartbeat then revives the
   * live run. Deltas go over the port; storage only gets a throttled snapshot.
   */
  private async mirror(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) {
      this.snapshotTimer ??= setTimeout(() => {
        this.snapshotTimer = null;
        void this.mirror(true);
      }, SNAPSHOT_THROTTLE_MS);
      return;
    }

    this.lastSnapshotAt = now;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    const trimmed: BuildState = {
      ...this.state,
      narration: this.state.narration.slice(-NARRATION_STORAGE_CAP),
      logs: this.state.logs.slice(-LOG_RETENTION),
    };
    await extensionStore.set(KEYS.buildSnapshot, trimmed);
  }

  // ---- worker keepalive ----------------------------------------------------

  private startKeepalive() {
    this.keepalive ??= setInterval(() => {
      // A cheap chrome API call resets the ~30s idle-unload timer while a turn is
      // in flight (the in-flight session fetch does most of the work; this covers
      // the gaps between requests).
      void browser.runtime.getPlatformInfo();
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  /** Keep the worker alive through a morning push without stopping a build's keepalive. */
  private morningWarm: ReturnType<typeof setInterval> | null = null;
  private keepWarm(on: boolean) {
    if (on) this.morningWarm ??= setInterval(() => void browser.runtime.getPlatformInfo(), KEEPALIVE_INTERVAL_MS);
    else if (this.morningWarm) {
      clearInterval(this.morningWarm);
      this.morningWarm = null;
    }
  }

  // ---- failure surfacing ---------------------------------------------------

  private notifyFailure(message: string) {
    // Only ping when nobody is watching — an open tab already shows the error
    // inline. A headless daily build that fails otherwise vanishes silently.
    if (this.ports.size > 0) return;
    this.notify("Homepage build failed", message);
  }

  private notify(title: string, message: string) {
    try {
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title,
        message: message.slice(0, 200),
      });
    } catch {
      // notifications permission missing or API unavailable — nothing else to do.
    }
  }
}
