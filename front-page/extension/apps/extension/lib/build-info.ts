/**
 * Which build of the extension is running, and whether a newer one is on disk.
 *
 * Chrome keeps running a service worker's code until the extension is reloaded,
 * while new-tab pages load their files fresh from the unpacked directory. So a
 * `pnpm build` without a reload leaves a stale worker behind (it happened on
 * Oct 9 and Oct 13). The worker records its stamp under `workerBuild` on every
 * start and reloads itself when `build-info.json` on disk differs and no build
 * is running; the page shows the stamp and a banner while they disagree.
 */
import type { BuildInfo } from "../build-stamp";

export type { BuildInfo };

declare const __BUILD_INFO__: BuildInfo;
declare const __WORLD_LIST__: string;

/** The stamp of the code in this bundle. */
export const BUILD_INFO: BuildInfo = __BUILD_INFO__;

/** The world list as it was when this bundle was built ("" if missing). */
export const WORLD_LIST: string = __WORLD_LIST__;

/** What the worker writes to storage on start. */
export interface WorkerBuild extends BuildInfo {
  /** ISO time this worker instance started. */
  startedAt: string;
}

/** The last self-reload, so a reload that didn't take is not retried forever. */
export interface SelfReload {
  from: string;
  to: string;
  at: string;
}

/** The stamp of the build currently on disk, or null if it can't be read (e.g. mid-build). */
export async function readDiskBuildInfo(): Promise<BuildInfo | null> {
  try {
    // Written by the build:done hook after bundling, so WXT's typed public paths don't list it.
    const url = (browser.runtime.getURL as (path: string) => string)("/build-info.json");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const info = (await res.json()) as BuildInfo;
    return typeof info?.id === "string" ? info : null;
  } catch {
    return null;
  }
}

/** "Oct 24, 10:15" in local time. */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
