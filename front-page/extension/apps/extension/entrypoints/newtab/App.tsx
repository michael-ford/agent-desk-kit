import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_MODEL, type HomepageModel } from "@homepage/agent-core";
import { DEFAULT_REBUILD_INTERVAL_HOURS } from "@/lib/auto-rebuild";
import { BUILD_STEPS } from "@/lib/protocol";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveSetting, type Homepage } from "@/lib/storage";
import { toRenderable } from "@/lib/transpile";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildStamp, StaleBuildBanner, useBuildStatus } from "./components/BuildStamp";
import { BuildProgress } from "./components/BuildProgress";
import { HomepagePreview } from "./components/HomepagePreview";
import { HomepageView } from "./components/HomepageView";
import { SettingsModal } from "./components/SettingsModal";
import { TriageView } from "./components/TriageView";
import { btn, errorBox } from "./components/ui";
import { useHomepageBuild } from "./useHomepageBuild";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState<HomepageModel>(DEFAULT_MODEL);
  const [autoRebuild, setAutoRebuild] = useState(true);
  const [intervalHours, setIntervalHours] = useState(DEFAULT_REBUILD_INTERVAL_HOURS);
  const [homepage, setHomepage] = useState<Homepage | undefined>(undefined);
  /** Legacy pages (agent-written TSX, before the data format): transpiled for Sandpack. */
  const legacyCode = useMemo(
    () => (!homepage?.data && homepage?.code ? toRenderable(homepage.code) : null),
    [homepage],
  );
  const hasPage = Boolean(homepage?.data || legacyCode);
  const buildStatus = useBuildStatus();
  /** A session left mid-flight, offered as "Resume interrupted build". */
  const [resumable, setResumable] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  // Re-read storage rather than trusting the message: a worker still on an
  // older build (before a reload) sends a different "done" payload.
  const { state, build, cancel, setBusy } = useHomepageBuild(() => void loadHomepage().then(setHomepage));

  /** News is the default on every new tab (2026-10-27). */
  const [view, setView] = useState<"news" | "triage">("news");
  /** The Triage frame mounts on first open and then stays, so switching back keeps its place (and any Talk session). */
  const [triageMounted, setTriageMounted] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const showTriage = useCallback(() => {
    setView("triage");
    setTriageMounted(true);
  }, []);
  // A self-reload would close this tab's Triage frame or a half-written comment.
  useEffect(() => setBusy(triageMounted || commentOpen), [triageMounted, commentOpen, setBusy]);

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      try {
        const [settings, homepage, activeSession] = await Promise.all([
          loadSettings(),
          loadHomepage(),
          extensionStore.get<string>(KEYS.activeSessionId),
        ]);
        setApiKey(settings.apiKey);
        setSystemPrompt(settings.systemPrompt);
        setModel(settings.model);
        setAutoRebuild(settings.autoRebuild);
        setIntervalHours(settings.rebuildIntervalHours ?? DEFAULT_REBUILD_INTERVAL_HOURS);
        setResumable(activeSession ?? null);
        setHomepage(homepage);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveKey = useCallback(async (key: string) => {
    await saveSetting("apiKey", key);
    setApiKey(key);
  }, []);

  const savePrompt = useCallback(
    async (prompt: string) => {
      await saveSetting("systemPrompt", prompt);
      setSystemPrompt(prompt);
      setShowSettings(false);
      // Keep showing the current homepage while the rebuild runs; a failed build
      // should not leave an empty page.
      build();
    },
    [build],
  );

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeModel = useCallback(async (next: HomepageModel) => {
    setModel(next);
    await saveSetting("model", next);
  }, []);
  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);
  const changeInterval = useCallback(async (next: number) => {
    setIntervalHours(next);
    await saveSetting("rebuildIntervalHours", next);
  }, []);

  if (loading) return <div style={{ padding: 20, textAlign: "center" }}>Loading…</div>;
  if (!apiKey) return <ApiKeySetup onSave={saveKey} />;

  // With no homepage to fall back to, a running build takes over the tab.
  if (state.running && (!hasPage || viewProgress)) {
    return (
      <BuildProgress
        state={state}
        onCancel={cancel}
        onBack={hasPage ? () => setViewProgress(false) : undefined}
      />
    );
  }

  if (!hasPage) {
    return (
      <div style={{ maxWidth: 560, margin: "14vh auto", padding: 24, fontFamily: "system-ui" }}>
        <h1 style={{ fontSize: 26 }}>Build your homepage</h1>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          The agent reads your browsing history, opens the pages you actually follow, and writes a
          homepage from what it finds today.
        </p>
        {state.error && (
          <div style={{ ...errorBox, margin: "16px 0", padding: 12, borderRadius: 4 }}>{state.error}</div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button style={btn} onClick={() => build()}>
            Build today&apos;s homepage
          </button>
          {resumable && (
            <button style={{ ...btn, backgroundColor: "#555" }} onClick={() => build({ resume: true })}>
              Resume interrupted build
            </button>
          )}
        </div>
      </div>
    );
  }

  const showError = state.error && dismissedError !== state.error;

  return (
    <div style={{ minHeight: "100vh", width: "100vw" }}>
      <div style={{ position: "fixed", top: 20, right: 20, zIndex: 999, display: "flex", gap: 8 }}>
        <div className="view-switch">
          <button className={view === "news" ? "on" : ""} onClick={() => setView("news")}>
            News
          </button>
          <button className={view === "triage" ? "on" : ""} onClick={showTriage}>
            Triage
          </button>
        </div>
        {view === "triage" ? null : state.running ? (
          // A build is running in the background (from here, another tab, or the
          // scheduled rebuild). Let the user watch it without losing this page.
          <button
            style={{ ...btn, backgroundColor: "#0a7", display: "flex", alignItems: "center", gap: 8 }}
            onClick={() => setViewProgress(true)}
            title="View build progress"
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "white",
                animation: "hb-pulse 1.2s ease-in-out infinite",
              }}
            />
            Building… {Math.min(state.stepIndex + 1, BUILD_STEPS.length)}/{BUILD_STEPS.length}
          </button>
        ) : (
          <button style={btn} onClick={() => build()} title="Rebuild now">
            ↻ Rebuild
          </button>
        )}
        {view === "news" && (
          <button style={btn} onClick={() => setShowSettings(true)} title="Customize homepage">
            ⚙️ Settings
          </button>
        )}
      </div>

      {showError && (
        <div
          style={{
            ...errorBox,
            position: "fixed",
            top: 20,
            left: 20,
            right: 260,
            zIndex: 999,
            padding: "10px 14px",
            borderRadius: 6,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>
            <b>Build failed.</b> {state.error}
          </span>
          <button style={{ ...btn, padding: "4px 10px", backgroundColor: "#a02620" }} onClick={() => build()}>
            Retry
          </button>
          <button
            onClick={() => setDismissedError(state.error)}
            style={{
              background: "transparent",
              border: "none",
              color: "#a02620",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {triageMounted && (
        <div style={{ display: view === "triage" ? "block" : "none" }}>
          <TriageView />
        </div>
      )}

      {homepage?.data ? (
        <HomepageView
          data={homepage.data}
          pageBuilt={homepage.timestamp}
          footer={<BuildStamp status={buildStatus} homepage={homepage} />}
          onCommentOpen={setCommentOpen}
        />
      ) : (
        <>
          <HomepagePreview code={legacyCode!} />
          <div className="hp-stamp-fixed">
            <BuildStamp status={buildStatus} homepage={homepage} />
          </div>
        </>
      )}
      <StaleBuildBanner status={buildStatus} />

      {showSettings && (
        <SettingsModal
          initialPrompt={systemPrompt}
          model={model}
          onChangeModel={changeModel}
          autoRebuild={autoRebuild}
          onToggleAutoRebuild={toggleAutoRebuild}
          intervalHours={intervalHours}
          onChangeInterval={changeInterval}
          onClose={() => setShowSettings(false)}
          onSave={savePrompt}
        />
      )}
    </div>
  );
}
