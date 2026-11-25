import { useEffect, useState } from "react";
import { loadXConfig, saveXConfig, type XConfig } from "@/lib/x";
import { DEFAULT_KOBO_CONFIG, loadKoboConfig, saveKoboConfig, type KoboConfig } from "@/lib/kobo";
import { loadMorningRecord, morningPushEnabled, setMorningPushEnabled, type MorningRecord } from "@/lib/morning";
import { MODEL_CHOICES, type HomepageModel } from "@homepage/agent-core";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { btn } from "./ui";

export function SettingsModal({
  initialPrompt,
  model,
  onChangeModel,
  autoRebuild,
  onToggleAutoRebuild,
  intervalHours,
  onChangeInterval,
  onClose,
  onSave,
}: {
  initialPrompt: string;
  model: HomepageModel;
  onChangeModel: (next: HomepageModel) => void;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  intervalHours: number;
  onChangeInterval: (next: number) => void;
  onClose: () => void;
  onSave: (prompt: string) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [kobo, setKobo] = useState<KoboConfig>(DEFAULT_KOBO_CONFIG);
  const [koboSaved, setKoboSaved] = useState(false);
  const [x, setX] = useState<XConfig>({ apiKey: "", handle: "" });
  const [xSaved, setXSaved] = useState(false);
  const [morningOn, setMorningOn] = useState(true);
  const [morning, setMorning] = useState<MorningRecord | null>(null);
  const [morningBusy, setMorningBusy] = useState(false);
  useEffect(() => {
    void morningPushEnabled().then(setMorningOn);
    void loadMorningRecord().then(setMorning);
  }, []);
  const sendMorningNow = async () => {
    setMorningBusy(true);
    try {
      setMorning((await browser.runtime.sendMessage({ kind: "morningPushNow" })) as MorningRecord);
    } finally {
      setMorningBusy(false);
    }
  };
  useEffect(() => {
    void loadKoboConfig().then(setKobo);
    void loadXConfig().then(setX);
  }, []);
  const koboField = (key: keyof KoboConfig, label: string, type = "text") => (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#333", marginTop: 6 }}>
      <span style={{ width: 110 }}>{label}</span>
      <input
        type={type}
        value={kobo[key]}
        onChange={(e) => {
          setKobo({ ...kobo, [key]: e.target.value });
          setKoboSaved(false);
        }}
        style={{ flex: 1, padding: 6, border: "1px solid #ddd", borderRadius: 4, fontSize: 13 }}
      />
    </label>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
          style={{
            width: "100%",
            minHeight: 200,
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
        >
          Model
          <select
            value={model}
            onChange={(e) => onChangeModel(e.target.value as HomepageModel)}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {MODEL_CHOICES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            marginLeft: 24,
            color: autoRebuild ? "#333" : "#aaa",
            fontSize: 14,
          }}
        >
          Every
          <select
            value={intervalHours}
            disabled={!autoRebuild}
            onChange={(e) => onChangeInterval(Number(e.target.value))}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {REBUILD_INTERVAL_CHOICES.map((h) => (
              <option key={h} value={h}>
                {h === 24 ? "day (6am)" : h === 12 ? "12 hours (6am, 6pm)" : "6 hours (6am, noon, 6pm, midnight)"}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension rebuilds in the background at these times (or on wake if Chrome
          was closed), retrying a failed build up to twice, 45 minutes apart (uses your API key).
        </p>
        <h3 style={{ margin: "20px 0 4px", color: "#333", fontSize: 15 }}>X via twitterapi.io</h3>
        {(["handle", "apiKey"] as const).map((key) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#333", marginTop: 6 }}>
            <span style={{ width: 110 }}>{key === "handle" ? "Your handle" : "API key"}</span>
            <input
              type={key === "apiKey" ? "password" : "text"}
              value={x[key]}
              onChange={(e) => {
                setX({ ...x, [key]: e.target.value });
                setXSaved(false);
              }}
              style={{ flex: 1, padding: 6, border: "1px solid #ddd", borderRadius: 4, fontSize: 13 }}
            />
          </label>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button
            onClick={() => void saveXConfig(x).then(() => setXSaved(true))}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd", padding: "6px 12px" }}
          >
            Save X settings
          </button>
          {xSaved && <span style={{ color: "#17865a", fontSize: 13 }}>Saved</span>}
        </div>
        <h3 style={{ margin: "20px 0 4px", color: "#333", fontSize: 15 }}>Send to reader</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#333", margin: "6px 0" }}>
          Deliver to
          <select
            value={kobo.service}
            onChange={(e) => {
              setKobo({ ...kobo, service: e.target.value as KoboConfig["service"] });
              setKoboSaved(false);
            }}
          >
            <option value="wallabag">Kobo / KOReader (Wallabag-compatible server)</option>
            <option value="readwise">iPad / phone (Readwise Reader)</option>
          </select>
        </label>
        {kobo.service === "readwise" ? (
          koboField("readwiseToken", "Reader token", "password")
        ) : (
          <>
            {koboField("baseUrl", "Server URL")}
            {koboField("password", "Password", "password")}
            {koboField("username", "Username")}
            {koboField("clientId", "Client ID")}
            {koboField("clientSecret", "Client secret", "password")}
          </>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button
            onClick={() => void saveKoboConfig(kobo).then(() => setKoboSaved(true))}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd", padding: "6px 12px" }}
          >
            Save reader settings
          </button>
          {koboSaved && <span style={{ color: "#17865a", fontSize: 13 }}>Saved</span>}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#333", marginTop: 12 }}>
          <input
            type="checkbox"
            checked={morningOn}
            onChange={(e) => {
              setMorningOn(e.target.checked);
              void setMorningPushEnabled(e.target.checked);
            }}
          />
          Morning edition: top 8 articles and a numbered front page (headlines and triage cards) to your reader each
          morning after the 06:00 build, by 07:00
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button
            disabled={morningBusy}
            onClick={() => void sendMorningNow()}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd", padding: "6px 12px" }}
          >
            {morningBusy ? "Sending…" : "Send morning edition now"}
          </button>
          <span data-testid="morning-status" style={{ fontSize: 13, color: morning?.status === "failed" ? "#b42318" : "#555" }}>
            {morningStatus(morning)}
          </span>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button onClick={() => onSave(draft)} style={btn}>
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}

function morningStatus(r: MorningRecord | null): string {
  if (!r) return "Not sent yet.";
  const at = new Date(r.at).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  if (r.status === "running") return `Sending (started ${at})…`;
  if (r.status === "failed") return `Failed ${at} (attempt ${r.attempts}): ${r.error ?? "unknown error"}`;
  const ok = (r.articles ?? []).filter((a) => a.result !== "failed").length;
  const bad = (r.articles ?? []).length - ok;
  return (
    `Sent ${at} (${r.trigger}): ${ok} articles${bad ? `, ${bad} failed` : ""}, front page #${r.frontPageIds?.at(-1)} ` +
    `with ${r.headlines} headlines and ${r.triageCards} triage cards${r.triageFile ? ` from ${r.triageFile}` : ""}` +
    `${r.articlesArchived ? `; archived ${r.articlesArchived} articles over 7 days old` : ""}.`
  );
}
