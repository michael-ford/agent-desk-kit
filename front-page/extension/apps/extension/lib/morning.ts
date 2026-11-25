/**
 * The morning edition: every morning the top articles and one "front page"
 * EPUB (all headlines, open triage cards, numbered) go to the reader's koreader-sync,
 * so they're on the e-reader with the morning coffee, by 07:00.
 *
 * Runs in the worker off the 1-minute heartbeat (build-manager.ts), once per
 * local day, between 06:00 and noon. It waits for two things that land after
 * 06:00: the 06:00 homepage build, and the assistant's morning sweep, which writes the
 * day's intake file around 06:12. At MORNING_FALLBACK it goes with whatever it
 * has (yesterday's page, yesterday's cards), so a failed build or a late sweep
 * doesn't cost the morning. All times are the computer's local time zone.
 *
 * Nothing leaves except to your own koreader-sync (Settings → Send to Kobo),
 * plus a markdown copy of the edition to the local Intake Triage server, which
 * writes it to your notes folder (edition/current.md) for the assistant.
 */
import { arrangePage, normalizeUrl } from "@homepage/agent-core";
import {
  MORNING_ARTICLES,
  frontPageEpub,
  frontPageHtml,
  frontPageMarkdown,
  numberHeadlines,
  openCards,
  pickKoboArticles,
  type FrontPageInput,
  type TriageFile,
} from "./front-page";
import { archiveKoboEntry, loadKoboConfig, saveToKobo, uploadFrontPage, type EntryId } from "./kobo";
import { INTAKE_BASE, Refused, Unreachable, postIntake } from "./assistant";
import { loadSeen } from "./seen";
import { loadHomepage } from "./storage";

/** Local hours bounding the scheduled push. */
export const MORNING_START_HOUR = 6;
export const MORNING_END_HOUR = 12;
/** Minutes past 06:00 after which it stops waiting for a fresh build or today's cards. */
export const MORNING_FALLBACK_MIN = 40;
/** Minutes past 06:00 after which a running build no longer holds it back. */
export const MORNING_LAST_CALL_MIN = 50;
/** Today's intake file must be this quiet (minutes) before the sweep counts as finished. */
export const SWEEP_SETTLE_MIN = 3;
export const RETRY_MIN = 5;
export const MAX_ATTEMPTS = 4;
/** A "running" record older than this was cut off (worker killed) and may be retried. */
const STALE_RUNNING_MIN = 10;
/** Articles sent on earlier mornings are not sent again for this many days. */
const SENT_MEMORY_DAYS = 14;
/**
 * Articles the morning edition created are archived in koreader-sync once they
 * are this many days old, so the Kobo's unread list doesn't fill up (The reader,
 * 2026-11-16: yes). Only entries this code created (a 201): an article that was
 * already saved, by the 📖 button or by hand, is never touched.
 */
export const ARCHIVE_AFTER_DAYS = 7;
/** An entry whose archive keeps failing is forgotten after this long. */
const ARCHIVE_GIVE_UP_DAYS = 30;

const KEY_RECORD = "morningPush";
const KEY_SENT = "morningPushSent";
const KEY_ENABLED = "morningPushEnabled";
/** The latest edition's markdown, until the Intake Triage server has written it. Only the newest is kept. */
const KEY_EDITION_OUTBOX = "morningEditionOutbox";

export interface MorningArticle {
  url: string;
  headline: string;
  result: "queued" | "duplicate" | "failed";
  /** Entry id (Wallabag number or Readwise string), when the service answered with one. */
  id?: EntryId;
  error?: string;
}

export interface MorningRecord {
  /** Local YYYY-MM-DD this edition is for. */
  date: string;
  status: "running" | "done" | "failed";
  trigger: "schedule" | "manual";
  /** ISO time of the latest attempt. */
  at: string;
  attempts: number;
  homepageBuilt?: string;
  triageFile?: string | null;
  triageCards?: number;
  headlines?: number;
  articles?: MorningArticle[];
  /** koreader-sync ids of front pages not yet archived, newest last (the current one, plus any whose archive failed). */
  frontPageIds?: EntryId[];
  /** Front-page ids archived after this edition went up. */
  archived?: EntryId[];
  /** Morning-edition articles archived this run for being older than ARCHIVE_AFTER_DAYS. */
  articlesArchived?: number;
  /** The local copy for the assistant: written, or waiting in the outbox for the Intake Triage server. */
  localCopy?: "written" | "waiting" | "failed";
  error?: string;
}

/**
 * Normalized URL → when it was sent and, when this code created the entry, its
 * koreader-sync id (until archived). A bare string is the date (first format).
 */
export interface SentEntry {
  date: string;
  /** Set only when the morning edition created the entry (201). */
  id?: EntryId;
  archived?: boolean;
}
type SentMemory = Record<string, SentEntry | string>;

const sentDate = (e: SentEntry | string) => (typeof e === "string" ? e : e.date);

/**
 * Archive morning-edition articles older than ARCHIVE_AFTER_DAYS. Returns the
 * updated memory and how many were archived. A failure stays pending for the
 * next morning.
 */
export async function archiveOldArticles(
  sent: SentMemory,
  now: Date,
  archive: (id: EntryId) => Promise<void> = archiveKoboEntry,
): Promise<{ sent: SentMemory; archived: number }> {
  const due = localDate(new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 86_400_000));
  const next: SentMemory = { ...sent };
  let archived = 0;
  for (const [url, e] of Object.entries(sent)) {
    if (typeof e === "string" || e.id === undefined || e.archived || e.date > due) continue;
    try {
      await archive(e.id);
      next[url] = { ...e, archived: true };
      archived++;
    } catch (err) {
      console.warn("[morning] article archive failed", e.id, err);
    }
  }
  return { sent: next, archived };
}

/** Drop memory past SENT_MEMORY_DAYS, but keep entries still waiting to be archived (up to ARCHIVE_GIVE_UP_DAYS). */
export function pruneSent(sent: SentMemory, now: Date): SentMemory {
  const keep = localDate(new Date(now.getTime() - SENT_MEMORY_DAYS * 86_400_000));
  const giveUp = localDate(new Date(now.getTime() - ARCHIVE_GIVE_UP_DAYS * 86_400_000));
  return Object.fromEntries(
    Object.entries(sent).filter(([, e]) => {
      const d = sentDate(e);
      if (d >= keep) return true;
      return typeof e !== "string" && e.id !== undefined && !e.archived && d >= giveUp;
    }),
  );
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local time `minutes` past MORNING_START_HOUR on `now`'s day. */
function morningAt(now: Date, minutes: number): Date {
  const t = new Date(now);
  t.setHours(MORNING_START_HOUR, minutes, 0, 0);
  return t;
}

export interface DueInput {
  now: Date;
  enabled: boolean;
  record?: MorningRecord | null;
  /** ISO time of the current homepage build. */
  homepageBuilt?: string | null;
  buildRunning: boolean;
  /** The latest intake file, or null when the Triage server is unreachable. */
  triage: Pick<TriageFile, "date" | "today" | "mtime"> | null;
}

export type Due = { due: true; reason: string } | { due: false; reason: string };

/** Whether the scheduled push should run now. Pure; called every heartbeat. */
export function morningPushDue(input: DueInput): Due {
  const { now, enabled, record, homepageBuilt, buildRunning, triage } = input;
  if (!enabled) return { due: false, reason: "off" };
  const hour = now.getHours();
  if (hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) return { due: false, reason: "outside the morning window" };

  const today = localDate(now);
  if (record && record.date === today) {
    if (record.status === "done") return { due: false, reason: "already sent today" };
    const since = (now.getTime() - Date.parse(record.at)) / 60_000;
    if (record.status === "running" && since < STALE_RUNNING_MIN) return { due: false, reason: "running" };
    if (record.attempts >= MAX_ATTEMPTS) return { due: false, reason: "gave up after retries" };
    if (since < RETRY_MIN) return { due: false, reason: "waiting to retry" };
  }

  const fallback = now >= morningAt(now, MORNING_FALLBACK_MIN);
  const lastCall = now >= morningAt(now, MORNING_LAST_CALL_MIN);
  const freshPage = Boolean(homepageBuilt && Date.parse(homepageBuilt) >= morningAt(now, 0).getTime());
  const sweepDone = Boolean(
    triage && triage.date === today && now.getTime() / 1000 - triage.mtime >= SWEEP_SETTLE_MIN * 60,
  );

  // A build in progress will beat yesterday's page; wait for it unless the deadline is close.
  if (buildRunning && !freshPage && !lastCall) return { due: false, reason: "waiting for the build" };
  if (freshPage && sweepDone) return { due: true, reason: "fresh page and today's cards" };
  if (fallback && !buildRunning) return { due: true, reason: freshPage ? "sweep not in yet" : "no fresh page yet" };
  if (lastCall) return { due: true, reason: "last call before 07:00" };
  return { due: false, reason: freshPage ? "waiting for the morning sweep" : "waiting for the 06:00 build" };
}

// ---- storage -----------------------------------------------------------------

export async function loadMorningRecord(): Promise<MorningRecord | null> {
  return ((await browser.storage.local.get(KEY_RECORD))[KEY_RECORD] as MorningRecord | undefined) ?? null;
}

async function saveRecord(r: MorningRecord) {
  await browser.storage.local.set({ [KEY_RECORD]: r });
}

/** On unless switched off in Settings. */
export async function morningPushEnabled(): Promise<boolean> {
  return ((await browser.storage.local.get(KEY_ENABLED))[KEY_ENABLED] as boolean | undefined) ?? true;
}

export async function setMorningPushEnabled(on: boolean): Promise<void> {
  await browser.storage.local.set({ [KEY_ENABLED]: on });
}

/** The latest intake file from the Intake Triage server, or null if it's down. */
export async function fetchTriage(): Promise<TriageFile | null> {
  try {
    const res = await fetch(`${INTAKE_BASE}/api/items`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as TriageFile;
  } catch {
    return null;
  }
}

// ---- the push ----------------------------------------------------------------

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
}

/**
 * Make and send today's edition. Each article is sent on its own, so one bad
 * link doesn't sink the rest; the edition counts as sent once the front page is
 * up. Earlier front pages (yesterday's, or an earlier one today) are archived
 * after the new one is in, so the Kobo shows one.
 */
export async function runMorningPush(trigger: MorningRecord["trigger"], now = new Date()): Promise<MorningRecord> {
  const today = localDate(now);
  const prev = await loadMorningRecord();
  const sameDay = prev?.date === today;
  const record: MorningRecord = {
    date: today,
    status: "running",
    trigger,
    at: now.toISOString(),
    attempts: (sameDay ? prev!.attempts : 0) + 1,
    // Carried across days until archived, so a failed morning doesn't lose yesterday's id.
    frontPageIds: prev?.frontPageIds ?? [],
  };
  await saveRecord(record);

  try {
    const homepage = await loadHomepage();
    if (!homepage?.data) throw new Error("no homepage built yet");
    const view = arrangePage(homepage.data, await loadSeen(), homepage.timestamp, now);

    const sent = ((await browser.storage.local.get(KEY_SENT))[KEY_SENT] as SentMemory | undefined) ?? {};
    // Today's own sends don't count, so a retry or "Send now" picks the same articles.
    const earlier = new Set(Object.entries(sent).filter(([, e]) => sentDate(e) !== today).map(([u]) => u));
    const picks = pickKoboArticles(view, earlier, MORNING_ARTICLES);

    const articles: MorningArticle[] = [];
    for (const item of picks) {
      try {
        const saved = await saveToKobo(item.url);
        articles.push({ url: item.url, headline: item.headline, result: saved.result, ...(saved.id !== undefined ? { id: saved.id } : {}) });
        const key = normalizeUrl(item.url);
        const prior = sent[key];
        // Keep the id from an earlier try today (a retry sees its own entry as a duplicate).
        const ownId = saved.result === "queued" ? saved.id : typeof prior === "object" && prior.date === today ? prior.id : undefined;
        sent[key] = { date: today, ...(ownId !== undefined ? { id: ownId } : {}) };
      } catch (err) {
        articles.push({ url: item.url, headline: item.headline, result: "failed", error: String(err instanceof Error ? err.message : err) });
      }
    }
    await browser.storage.local.set({ [KEY_SENT]: pruneSent(sent, now) });

    const triageFile = await fetchTriage();
    const headlines = numberHeadlines(view, picks.filter((p) => articles.find((a) => a.url === p.url)?.result !== "failed"));
    const page: FrontPageInput = {
      date: today,
      dayLabel: dayLabel(now),
      homepageBuilt: homepage.timestamp,
      madeAt: now.toISOString(),
      headlines,
      calendar: homepage.data.calendar,
      triage: triageFile ? { file: triageFile, cards: openCards(triageFile) } : null,
    };
    const readwise = (await loadKoboConfig()).service === "readwise";
    const id = await uploadFrontPage({
      epub: frontPageEpub(page),
      html: frontPageHtml(page, readwise ? { savedLabel: "Reader", savedWhere: "your Reader library" } : {}),
      // Reader needs a unique URL per document; this one is made up and never fetched.
      url: `https://front-page.invalid/${encodeURIComponent(page.madeAt)}`,
      filename: `front-page-${today}.epub`,
      title: `Front page · ${dayLabel(now)} ${hhmm(now)}`,
      tags: ["front-page"],
    });

    // The local copy for the assistant, from the same numbered lists as the EPUB. Its
    // own failure never costs the edition; the heartbeat retries a waiting one.
    let localCopy: MorningRecord["localCopy"] = "failed";
    try {
      await browser.storage.local.set({
        [KEY_EDITION_OUTBOX]: { madeAt: page.madeAt, date: today, markdown: frontPageMarkdown(page, { trigger, frontPageId: id, articles }) },
      });
      localCopy = await flushEditionOutbox();
    } catch (err) {
      console.warn("[morning] local copy", err);
    }

    // Archive the older front pages (yesterday's, or an earlier one today) now the new one is in.
    const archived: EntryId[] = [];
    for (const old of record.frontPageIds ?? []) {
      try {
        await archiveKoboEntry(old);
        archived.push(old);
      } catch (err) {
        console.warn("[morning] archive failed", old, err);
      }
    }

    // Last, so a failure here can't cost the morning's edition.
    let articlesArchived = 0;
    try {
      const stored = ((await browser.storage.local.get(KEY_SENT))[KEY_SENT] as SentMemory | undefined) ?? {};
      const swept = await archiveOldArticles(stored, now);
      articlesArchived = swept.archived;
      await browser.storage.local.set({ [KEY_SENT]: pruneSent(swept.sent, now) });
    } catch (err) {
      console.warn("[morning] old-article archive", err);
    }

    const done: MorningRecord = {
      ...record,
      status: "done",
      homepageBuilt: homepage.timestamp,
      triageFile: triageFile?.file ?? null,
      triageCards: triageFile ? openCards(triageFile).length : 0,
      headlines: headlines.length,
      articles,
      frontPageIds: [...(record.frontPageIds ?? []).filter((x) => !archived.includes(x)), id],
      archived,
      articlesArchived,
      localCopy,
    };
    await saveRecord(done);
    console.log("[morning] edition sent", { id, articles: articles.length, headlines: headlines.length });
    return done;
  } catch (err) {
    const failed: MorningRecord = { ...record, status: "failed", error: err instanceof Error ? err.message : String(err) };
    await saveRecord(failed);
    console.error("[morning] edition failed", err);
    return failed;
  }
}

// ---- the local copy ------------------------------------------------------------

interface EditionCopy {
  date: string;
  madeAt: string;
  markdown: string;
}

/**
 * Send the waiting edition copy to the Intake Triage server, which overwrites
 * edition/current.md in your notes folder. Called after each edition and on the
 * worker's heartbeat. While the server is down (or its write fails) the copy
 * waits; one it refuses outright (4xx) is dropped with a console error rather
 * than retried forever. "written" also covers an empty outbox.
 */
export async function flushEditionOutbox(): Promise<"written" | "waiting" | "failed"> {
  const copy = (await browser.storage.local.get(KEY_EDITION_OUTBOX))[KEY_EDITION_OUTBOX] as EditionCopy | undefined;
  if (!copy) return "written";
  let result: "written" | "waiting" | "failed";
  try {
    await postIntake("/api/newtab/edition", copy);
    result = "written";
  } catch (err) {
    if (err instanceof Refused && err.status >= 400 && err.status < 500) {
      console.error("[morning] the server refused the edition copy", err);
      result = "failed";
    } else {
      if (!(err instanceof Unreachable)) console.warn("[morning] edition copy failed; will retry", err);
      return "waiting";
    }
  }
  // Clear only if a newer edition hasn't replaced it meanwhile.
  const latest = (await browser.storage.local.get(KEY_EDITION_OUTBOX))[KEY_EDITION_OUTBOX] as EditionCopy | undefined;
  if (latest?.madeAt === copy.madeAt) await browser.storage.local.remove(KEY_EDITION_OUTBOX);
  return result;
}
