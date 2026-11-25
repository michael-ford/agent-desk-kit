/**
 * The homepage as data. The agent writes this as JSON; a fixed renderer in the
 * extension draws it. Before 2026-10-24 the agent wrote the whole page as TSX
 * and invented its own item types every build, so nothing could rely on what an
 * item was. These types are the contract.
 */
import { CHANNELS, CHANNEL_KEYS, type ChannelKey } from "./channels";

export interface LinkChip {
  /** Short source label: "HN", "X", "Blog", "Docs", "php.net". */
  label: string;
  url: string;
}

export interface Action {
  /** What the reader (or a client) should do, imperative: "Check the WordPress host runs PHP 8.5.12+". */
  what: string;
  /** YYYY-MM-DD deadline, when there is one. */
  by?: string;
}

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A security flaw the story is about. Critical and high ones can start an assessment session (advisories.ts). */
export interface Advisory {
  /** Lowercase dedup key: "cve-2026-12345", "ghsa-xxxx-xxxx-xxxx", or a short slug when there is no id. */
  id: string;
  severity: Severity;
}

export interface NewsItem {
  /** Unique within the page. */
  id: string;
  channel: ChannelKey;
  /** What the story means for the reader, not how the announcer framed it. */
  headline: string;
  /** Best primary-source link. */
  url: string;
  /** "php.net", "Anthropic", "X · @handle". */
  source: string;
  /** ISO 8601 publication time. */
  publishedAt: string;
  /** 0-100 against the channel's rubric. */
  score: number;
  /** World-list labels the story touches. Rendered as "→ label" chips. */
  touches: string[];
  /** Needs action by a date: pinned to the urgent strip above the lead. */
  urgent: boolean;
  action?: Action;
  /** Set when the story is a security flaw (vulnerability, exploit, security release). */
  advisory?: Advisory;
  /** One plain sentence, shown on hover only. */
  summary?: string;
  /** Set only when a story the reader has already seen comes back: what changed. Shown as an "Update" tag. */
  update?: string;
  /** Coverage of the same event: HN thread, X posts, docs. */
  chips: LinkChip[];
}

export interface CalendarEvent {
  /** "09:30" local, or "All day". */
  time: string;
  title: string;
}

export interface CalendarDay {
  /** "Today · Sat Oct 24". */
  label: string;
  events: CalendarEvent[];
}

export interface GithubRow {
  repo: string;
  title: string;
  url: string;
  number?: number;
  /** "Assigned", "Mentioned", "Review requested", "Your PR". Only for onYou rows. */
  reason?: string;
}

export interface SourceStatus {
  name: string;
  ok: boolean;
  /** Why it failed, when it did. */
  note?: string;
}

export interface HomepageData {
  version: 1;
  /** Id of the lead item. */
  lead: string;
  items: NewsItem[];
  calendar: CalendarDay[];
  github: { onYou: GithubRow[]; following: GithubRow[] };
  /** One line: what was dropped and why. */
  alsoSeen: string;
  sources: SourceStatus[];
}

/** The same contract, as the agent sees it in its system prompt. Keep in step with the types above. */
export const HOMEPAGE_DATA_CONTRACT = `interface HomepageData {
  version: 1;
  lead: string;                // id of the lead item
  items: NewsItem[];
  calendar: { label: string; events: { time: string; title: string }[] }[];  // "Today · Sat Oct 24", "Tomorrow · Sun Oct 25"
  github: { onYou: GithubRow[]; following: GithubRow[] };
  alsoSeen: string;            // one line: what was dropped and why
  sources: { name: string; ok: boolean; note?: string }[];  // every source in the kickoff, with its outcome
}
interface NewsItem {
  id: string;                  // unique, short: "php-rce"
  channel: ${CHANNEL_KEYS.map((k) => `"${k}"`).join(" | ")};
  headline: string;            // what it means for the reader, not the announcer's framing
  url: string;                 // absolute http(s) URL of the best primary source
  source: string;              // "php.net", "Anthropic", "X · @handle"
  publishedAt: string;         // ISO 8601
  score: number;               // integer 0-100
  touches: string[];           // exact labels from the world list; [] if none
  urgent: boolean;             // needs action by a date (see the urgent rule)
  action?: { what: string; by?: string };  // required when urgent; by = YYYY-MM-DD
  advisory?: { id: string; severity: "critical" | "high" | "medium" | "low" };  // security flaws only (see the advisory rule)
  summary?: string;            // one plain sentence, hover only
  update?: string;             // ONLY for a story on the seen list that has really changed: what changed, one line
  chips: { label: string; url: string }[];  // other coverage of the same event: HN, X, Blog, Docs
}
interface GithubRow { repo: string; title: string; url: string; number?: number; reason?: string }`;

/**
 * Fewer surviving items than this and the page is rejected (the previous one is
 * kept): a 30-item page shouldn't be replaced by a broken 2-item one.
 */
export const MIN_ITEMS = 5;

/** New items a channel may list beyond its share, for slots other channels can't fill. */
export const EXTRA_PER_CHANNEL = 8;

/** At most this many items in the urgent strip. */
export const MAX_URGENT = 5;
const MAX_TOUCHES = 3;
/** Also the shape the Intake Triage server checks. */
export const ADVISORY_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_CHIPS = 6;

export interface ValidationResult {
  data: HomepageData;
  /** Everything dropped or repaired, for the build log. */
  warnings: string[];
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Parse and repair the agent's JSON. Bad items are dropped with a warning rather
 * than failing the page; the page is rejected only when nothing usable is left.
 * Also enforces what the prompt asks for but code can guarantee: channel slot
 * caps, the urgent cap, known world-list labels, http(s) links only, and a lead.
 *
 * Text is rendered by React (escaped) and links are restricted to http(s), so a
 * prompt injection in a scraped page can at worst produce a misleading headline.
 */
export function validateHomepageData(
  raw: string,
  opts: { worldLabels?: string[]; now?: Date } = {},
): ValidationResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`homepage.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const root = obj(parsed);
  // Given but empty (no world list in this build) means no label is valid.
  // Omitted (e.g. the harness verifier) means labels aren't checked.
  const known = opts.worldLabels ? new Map(opts.worldLabels.map((l) => [l.toLowerCase(), l])) : null;
  const now = opts.now ?? new Date();

  const ids = new Set<string>();
  let items: NewsItem[] = [];
  for (const [i, rawItem] of arr(root.items).entries()) {
    const it = obj(rawItem);
    const label = str(it.headline, 80) || `item ${i}`;
    const ch = it.channel as ChannelKey;
    if (!CHANNEL_KEYS.includes(ch)) {
      warnings.push(`dropped "${label}": unknown channel ${JSON.stringify(it.channel)}`);
      continue;
    }
    if (!str(it.headline) || !isHttpUrl(it.url)) {
      warnings.push(`dropped "${label}": missing headline or http(s) url`);
      continue;
    }
    let id = str(it.id, 60) || `item-${i}`;
    while (ids.has(id)) id += "-";
    ids.add(id);

    const touches: string[] = [];
    for (const t of arr(it.touches)) {
      const s = str(t, 60);
      if (!s) continue;
      const canonical = known ? known.get(s.toLowerCase()) : s;
      if (!canonical) warnings.push(`"${label}": touches "${s}" is not a world-list label; dropped`);
      else if (!touches.includes(canonical)) touches.push(canonical);
    }

    const a = obj(it.action);
    const action: Action | undefined = str(a.what)
      ? { what: str(a.what, 200), ...(/^\d{4}-\d{2}-\d{2}$/.test(str(a.by)) ? { by: str(a.by) } : {}) }
      : undefined;
    const adv = obj(it.advisory);
    const advId = str(adv.id, 64).toLowerCase();
    const severity = str(adv.severity).toLowerCase() as Severity;
    let advisory: Advisory | undefined;
    if (Object.keys(adv).length) {
      if (ADVISORY_ID_RE.test(advId) && SEVERITIES.includes(severity)) advisory = { id: advId, severity };
      else warnings.push(`"${label}": advisory ${JSON.stringify(it.advisory)} needs an id and a severity; dropped`);
    }
    let urgent = it.urgent === true;
    if (urgent && !action) {
      warnings.push(`"${label}": urgent without an action; unpinned`);
      urgent = false;
    }

    const published = new Date(str(it.publishedAt));
    const score = Math.round(Number(it.score));
    items.push({
      id,
      channel: ch,
      headline: str(it.headline, 200),
      url: it.url as string,
      source: str(it.source, 60) || new URL(it.url as string).hostname,
      publishedAt: Number.isNaN(published.getTime()) ? "" : published.toISOString(),
      score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
      touches: touches.slice(0, MAX_TOUCHES),
      urgent,
      ...(action ? { action } : {}),
      ...(advisory ? { advisory } : {}),
      ...(str(it.summary) ? { summary: str(it.summary, 300) } : {}),
      ...(str(it.update) ? { update: str(it.update, 160) } : {}),
      chips: arr(it.chips)
        .map(obj)
        .filter((c) => str(c.label) && isHttpUrl(c.url))
        .map((c) => ({ label: str(c.label, 24), url: c.url as string }))
        .slice(0, MAX_CHIPS),
    });
  }

  // Channel caps, by score: its share plus a few ranked extras, which the
  // renderer (seen.ts arrangePage) shows only where another channel has room.
  const kept: NewsItem[] = [];
  for (const c of CHANNELS) {
    const cap = c.slots + EXTRA_PER_CHANNEL;
    const inChannel = items.filter((i) => i.channel === c.key).sort((x, y) => y.score - x.score);
    kept.push(...inChannel.slice(0, cap));
    if (inChannel.length > cap) warnings.push(`${c.key}: ${inChannel.length - cap} items over its ${cap} cap; dropped the lowest`);
  }
  items = kept;
  if (items.length < MIN_ITEMS) {
    throw new Error(`homepage.json has only ${items.length} usable items (minimum ${MIN_ITEMS})`);
  }

  // Urgent cap, after the slot caps: keep the soonest deadlines.
  const urgent = items.filter((i) => i.urgent).sort(byDeadline);
  for (const extra of urgent.slice(MAX_URGENT)) {
    extra.urgent = false;
    warnings.push(`"${extra.headline.slice(0, 80)}": more than ${MAX_URGENT} urgent items; unpinned`);
  }

  // The lead: the agent's pick if it survived, else the best of the last 48h, else the best.
  let lead = str(root.lead);
  if (!items.some((i) => i.id === lead)) {
    const recent = items.filter((i) => i.publishedAt && now.getTime() - Date.parse(i.publishedAt) < 48 * 3600_000);
    const pick = [...(recent.length ? recent : items)].sort((x, y) => y.score - x.score)[0];
    if (lead) warnings.push(`lead "${lead}" not among the items; using "${pick.id}"`);
    lead = pick.id;
  }

  const gh = obj(root.github);
  const ghRows = (v: unknown, withReason: boolean): GithubRow[] =>
    arr(v)
      .map(obj)
      .filter((r) => str(r.title) && isHttpUrl(r.url))
      .slice(0, 15)
      .map((r) => ({
        repo: str(r.repo, 80),
        title: str(r.title, 200),
        url: r.url as string,
        ...(Number.isInteger(r.number) ? { number: r.number as number } : {}),
        ...(withReason && str(r.reason) ? { reason: str(r.reason, 30) } : {}),
      }));

  return {
    data: {
      version: 1,
      lead,
      items,
      calendar: arr(root.calendar)
        .map(obj)
        .filter((d) => str(d.label))
        .slice(0, 3)
        .map((d) => ({
          label: str(d.label, 60),
          events: arr(d.events)
            .map(obj)
            .filter((e) => str(e.title))
            .slice(0, 20)
            .map((e) => ({ time: str(e.time, 20), title: str(e.title, 160) })),
        })),
      github: { onYou: ghRows(gh.onYou, true), following: ghRows(gh.following, false) },
      alsoSeen: str(root.alsoSeen, 600),
      sources: arr(root.sources)
        .map(obj)
        .filter((s) => str(s.name))
        .map((s) => ({ name: str(s.name, 60), ok: s.ok === true, ...(str(s.note) ? { note: str(s.note, 160) } : {}) })),
    },
    warnings,
  };
}

/** Soonest deadline first; items without a date after dated ones, then by score. */
export function byDeadline(a: NewsItem, b: NewsItem): number {
  const da = a.action?.by ?? "9999";
  const db = b.action?.by ?? "9999";
  return da === db ? b.score - a.score : da < db ? -1 : 1;
}
