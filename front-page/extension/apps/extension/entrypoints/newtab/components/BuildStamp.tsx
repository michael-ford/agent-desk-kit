import { useEffect, useState } from "react";
import {
  BUILD_INFO,
  formatStamp,
  readDiskBuildInfo,
  type BuildInfo,
  type SelfReload,
  type WorkerBuild,
} from "@/lib/build-info";
import { KEYS, extensionStore, type Homepage } from "@/lib/storage";

export interface BuildStatus {
  /** What the service worker (the part that runs builds) is running; undefined before it has ever written a stamp. */
  worker: WorkerBuild | undefined;
  /** What is on disk; falls back to this page's own bundle, which Chrome loads fresh from disk. */
  disk: BuildInfo;
  selfReload: SelfReload | undefined;
  loaded: boolean;
}

/** Live view of which build is running versus on disk. */
export function useBuildStatus(): BuildStatus {
  const [status, setStatus] = useState<BuildStatus>({ worker: undefined, disk: BUILD_INFO, selfReload: undefined, loaded: false });

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const [worker, selfReload, disk] = await Promise.all([
        extensionStore.get<WorkerBuild>(KEYS.workerBuild),
        extensionStore.get<SelfReload>(KEYS.selfReload),
        readDiskBuildInfo(),
      ]);
      if (!disposed) setStatus({ worker, selfReload, disk: disk ?? BUILD_INFO, loaded: true });
    };
    void refresh();
    const onChanged = (changes: Record<string, unknown>) => {
      if (KEYS.workerBuild in changes || KEYS.selfReload in changes) void refresh();
    };
    browser.storage.local.onChanged.addListener(onChanged);
    // Catch a `pnpm build` that lands while this tab is open.
    const timer = setInterval(refresh, 60_000);
    return () => {
      disposed = true;
      browser.storage.local.onChanged.removeListener(onChanged);
      clearInterval(timer);
    };
  }, []);

  return status;
}

/** "code built Oct 24, 10:15 (3a065a6+1f2e3d) · page built Oct 24, 06:02 by … · world list as of …" */
export function BuildStamp({ status, homepage }: { status: BuildStatus; homepage: Homepage | undefined }) {
  const w = status.worker;
  const world = w?.world ?? BUILD_INFO.world;
  return (
    <>
      {w ? (
        <span title={`Background build id ${w.id}, started ${formatStamp(w.startedAt)}`}>
          code built {formatStamp(w.builtAt)} ({w.version})
        </span>
      ) : (
        <span>code: background build unknown (no stamp, so older than the stamp itself)</span>
      )}
      {homepage && (
        <span>
          {" · "}page built {formatStamp(homepage.timestamp)}
          {homepage.builtBy ? ` by ${homepage.builtBy}` : " by an unstamped build"}
        </span>
      )}
      <span>
        {" · "}world list {world.found ? `as of ${world.asOf} (${world.entries ?? "?"} entries)` : "missing"}
      </span>
    </>
  );
}

/** Shown while the service worker runs different code from what is on disk. */
export function StaleBuildBanner({ status }: { status: BuildStatus }) {
  if (!status.loaded) return null;
  const { worker, disk, selfReload } = status;
  if (worker && worker.id === disk.id) return null;

  const tried = worker && selfReload && selfReload.from === worker.id && selfReload.to === disk.id;
  return (
    <div className="hp-stale" role="alert">
      <b>Not the latest build.</b> The background is running{" "}
      {worker ? (
        <>
          code built {formatStamp(worker.builtAt)} (<code>{worker.version}</code>)
        </>
      ) : (
        "an unstamped build"
      )}
      , but the build on disk is from {formatStamp(disk.builtAt)} (<code>{disk.version}</code>).{" "}
      {tried
        ? `It tried to reload itself at ${formatStamp(selfReload.at)} and that didn't take. Reload it in chrome://extensions.`
        : worker
          ? "It reloads itself within a minute when no build is running, and waits while a Triage view or comment box is open in any tab. If this stays, reload it in chrome://extensions."
          : "Reload the extension in chrome://extensions."}
    </div>
  );
}
