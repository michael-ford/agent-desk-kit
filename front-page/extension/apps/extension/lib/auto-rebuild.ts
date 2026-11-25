/**
 * Auto-rebuild policy, evaluated by the worker's alarm heartbeat. Builds run at
 * fixed local times (anchored at 06:00, then every interval: 12h → 06:00 and
 * 18:00), not "N hours since the last build", so the page is fresh at the same
 * times each day. A slot missed while Chrome was closed or the Mac asleep runs
 * on the next heartbeat after wake. A failed build is retried a few times
 * within its slot instead of waiting for the next one.
 */

/** Interval choices offered in Settings, in hours. Each divides 24. */
export const REBUILD_INTERVAL_CHOICES = [6, 12, 24] as const;

export const DEFAULT_REBUILD_INTERVAL_HOURS = 12;

/** Local hour the daily schedule is anchored to. */
export const REBUILD_ANCHOR_HOUR = 6;

/** Attempts per slot (first try + retries), and the wait between them. */
export const MAX_ATTEMPTS_PER_SLOT = 3;
export const RETRY_DELAY_MS = 45 * 60 * 1000;

/** A stored/user value in hours, falling back to the default when unset or invalid. */
export function rebuildIntervalHours(hours?: number | null): number {
  return typeof hours === "number" && hours > 0 && 24 % hours === 0
    ? hours
    : DEFAULT_REBUILD_INTERVAL_HOURS;
}

/** The most recent scheduled build time at or before `now`, in local time. */
export function latestSlot(now: Date, intervalHours: number): Date {
  const slot = new Date(now);
  slot.setMinutes(0, 0, 0);
  const sinceAnchor = (((now.getHours() - REBUILD_ANCHOR_HOUR) % 24) + 24) % 24;
  slot.setHours(now.getHours() - (sinceAnchor % intervalHours));
  return slot;
}

/** Auto-build attempts made for one slot. */
export interface SlotAttempts {
  /** ISO time of the slot these attempts belong to. */
  slot: string;
  count: number;
  /** ISO time of the most recent attempt. */
  last: string;
}

export interface AutoRebuildInput {
  enabled: boolean;
  hasApiKey: boolean;
  isRunning: boolean;
  /** ISO timestamp of the last successful build, if any. */
  lastBuildTimestamp?: string | null;
  attempts?: SlotAttempts | null;
  intervalHours: number;
  now: Date;
}

/**
 * - Never fires before the first manual build, so nothing spends on the API
 *   before the user has engaged.
 * - Fires when the last good build predates the latest slot.
 * - Retries a failed slot at most MAX_ATTEMPTS_PER_SLOT times, RETRY_DELAY_MS
 *   apart, so it can't loop. The user can always rebuild by hand.
 */
export function shouldAutoRebuild(input: AutoRebuildInput): boolean {
  const { enabled, hasApiKey, isRunning, lastBuildTimestamp, attempts, intervalHours, now } = input;

  if (!enabled || !hasApiKey || isRunning || !lastBuildTimestamp) return false;

  const slot = latestSlot(now, intervalHours);
  if (new Date(lastBuildTimestamp).getTime() >= slot.getTime()) return false;

  if (attempts && attempts.slot === slot.toISOString()) {
    if (attempts.count >= MAX_ATTEMPTS_PER_SLOT) return false;
    if (now.getTime() - new Date(attempts.last).getTime() < RETRY_DELAY_MS) return false;
  }
  return true;
}

/** The attempt record after starting one more auto-build at `now`. */
export function nextAttempts(prev: SlotAttempts | null | undefined, now: Date, intervalHours: number): SlotAttempts {
  const slot = latestSlot(now, intervalHours).toISOString();
  const count = prev && prev.slot === slot ? prev.count + 1 : 1;
  return { slot, count, last: now.toISOString() };
}
