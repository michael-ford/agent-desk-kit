import {
  DEFAULT_MODEL,
  MODEL_CHOICES,
  STORAGE_KEYS as AGENT_KEYS,
  type HomepageData,
  type HomepageModel,
  type KVStore,
} from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  model: "model",
  autoRebuild: "autoRebuild",
  /** Auto-build attempts for the current schedule slot (see auto-rebuild.ts). */
  autoBuildAttempts: "autoBuildAttempts",
  rebuildIntervalHours: "autoRebuildIntervalHours",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
  /** Lead headlines of recent builds, newest first (see lead.ts). */
  recentLeads: "recentLeads",
  /** The build stamp of the running service worker, written on every start (see build-info.ts). */
  workerBuild: "workerBuild",
  /** The worker's last self-reload onto a newer build on disk. */
  selfReload: "selfReload",
} as const;

export interface Homepage {
  /** The page as data, drawn by the fixed renderer (builds from 2026-10-24 on). */
  data?: HomepageData;
  /** Legacy: the agent's raw TSX, from builds before the data format. Rendered in Sandpack. */
  code?: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
  /** Build stamp (version) of the extension code that ran the build. */
  builtBy?: string;
}

export interface Settings {
  apiKey: string | null;
  systemPrompt: string;
  model: HomepageModel;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  rebuildIntervalHours: number | null;
}

/** The `KVStore` agent-core persists its agent/environment/session IDs through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.apiKey,
    KEYS.systemPrompt,
    KEYS.model,
    KEYS.autoRebuild,
    KEYS.rebuildIntervalHours,
  ]);
  const model = s[KEYS.model] as string | undefined;
  return {
    apiKey: (s[KEYS.apiKey] as string | undefined) ?? null,
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    // Fall back if a stored model is no longer offered.
    model: MODEL_CHOICES.find((m) => m.id === model)?.id ?? DEFAULT_MODEL,
    autoRebuild: s[KEYS.autoRebuild] !== false,
    rebuildIntervalHours: (s[KEYS.rebuildIntervalHours] as number | undefined) ?? null,
  };
}

export async function saveSetting<K extends "apiKey" | "systemPrompt" | "model" | "autoRebuild" | "rebuildIntervalHours">(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(data: HomepageData, builtBy: string): Promise<Homepage> {
  const homepage: Homepage = { data, timestamp: new Date().toISOString(), builtBy };
  await extensionStore.set(KEYS.homepage, homepage);
  return homepage;
}
