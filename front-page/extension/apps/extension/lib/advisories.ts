/**
 * Advisories: a critical or high security flaw on the page that touches a
 * world-list label with a project slug (`- Label [slug]: terms`) goes to the
 * Intake Triage server's /api/newtab/advisory, which dedups it per (advisory,
 * project), applies the daily cap, and queues `assistant-trigger.sh advisory` so
 * The assistant can start an assessment session in that project. Whether a session
 * really starts (or the assistant only says what it would launch) is the server's
 * call, not the extension's: real launches are off until the reader turns them on.
 *
 * Like comments, a report waits in an outbox while the server is down. This
 * side remembers what it has reported only so it doesn't re-post every build;
 * the server's ledger is the one that counts.
 */
import type { HomepageData, Severity, WorldEntry } from "@homepage/agent-core";
import { Refused, Unreachable, postIntake } from "./assistant";

const OUTBOX = "advisoryOutbox";
const SENT = "advisoriesSent";
const SENT_KEEP = 500;

/** Severities that can start a session (2026-10-27). */
const SESSION_SEVERITIES: readonly Severity[] = ["critical", "high"];

export interface AdvisoryReport {
  id: string;
  severity: Severity;
  /** Project slugs, one per touched label that has one, deduped. */
  projects: string[];
  url: string;
  headline: string;
  action?: string;
}

/** Per `${id}|${project}`: when the server accepted it. */
type Sent = Record<string, string>;

const key = (id: string, project: string) => `${id}|${project}`;

async function read<T>(k: string, fallback: T): Promise<T> {
  return ((await browser.storage.local.get(k))[k] as T | undefined) ?? fallback;
}

/** The page's items that qualify, with their projects. Pure; exported for tests. */
export function advisoriesIn(data: HomepageData, world: WorldEntry[]): AdvisoryReport[] {
  const projectOf = new Map(world.filter((e) => e.project).map((e) => [e.label, e.project!]));
  const reports: AdvisoryReport[] = [];
  for (const item of data.items) {
    if (!item.advisory || !SESSION_SEVERITIES.includes(item.advisory.severity)) continue;
    const projects = [...new Set(item.touches.map((t) => projectOf.get(t)).filter((p): p is string => !!p))];
    if (!projects.length) continue;
    reports.push({
      id: item.advisory.id,
      severity: item.advisory.severity,
      projects,
      url: item.url,
      headline: item.headline,
      ...(item.action ? { action: item.action.what } : {}),
    });
  }
  return reports;
}

/**
 * Called after each build. Queues the page's qualifying advisories that
 * haven't been reported for those projects yet, then tries to send them.
 */
export async function reportAdvisories(data: HomepageData, world: WorldEntry[]): Promise<void> {
  const sent = await read<Sent>(SENT, {});
  const outbox = await read<AdvisoryReport[]>(OUTBOX, []);
  const waiting = new Set(outbox.flatMap((r) => r.projects.map((p) => key(r.id, p))));
  const fresh = advisoriesIn(data, world)
    .map((r) => ({ ...r, projects: r.projects.filter((p) => !sent[key(r.id, p)] && !waiting.has(key(r.id, p))) }))
    .filter((r) => r.projects.length);
  if (fresh.length) await browser.storage.local.set({ [OUTBOX]: [...outbox, ...fresh] });
  await flushAdvisoryOutbox();
}

/**
 * Also called by the worker's heartbeat. Oldest first, stopping at the first
 * that can't be delivered. Any 200 (launched, dry run, duplicate, over the cap)
 * means the server has decided and it is done; a report the server refuses
 * outright is dropped with a console error rather than retried forever.
 */
export async function flushAdvisoryOutbox(): Promise<void> {
  const outbox = await read<AdvisoryReport[]>(OUTBOX, []);
  if (!outbox.length) return;
  let i = 0;
  for (; i < outbox.length; i++) {
    try {
      const reply = await postIntake("/api/newtab/advisory", outbox[i]);
      console.log("[advisories]", outbox[i].id, outbox[i].projects, reply.status);
      const sent = await read<Sent>(SENT, {});
      for (const p of outbox[i].projects) sent[key(outbox[i].id, p)] = new Date().toISOString();
      const trimmed = Object.fromEntries(Object.entries(sent).sort((a, b) => b[1].localeCompare(a[1])).slice(0, SENT_KEEP));
      await browser.storage.local.set({ [SENT]: trimmed });
    } catch (err) {
      if (err instanceof Unreachable) break;
      if (err instanceof Refused && err.status >= 400 && err.status < 500) {
        console.error("[advisories] dropping a report the server refused", outbox[i], err);
        continue;
      }
      break; // the trigger failed; try again next heartbeat
    }
  }
  // Re-read so a report added while we were sending isn't lost.
  const now = await read<AdvisoryReport[]>(OUTBOX, []);
  await browser.storage.local.set({ [OUTBOX]: [...outbox.slice(i), ...now.slice(outbox.length)] });
}
