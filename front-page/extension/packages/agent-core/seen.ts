/**
 * What the reader has already seen, and how a page is arranged around it (The reader,
 * 2026-10-29: "I don't want to stare at the same thing and take up a spot").
 *
 * - Seen: shown in a tab they actually looked at, on a page that a newer build
 *   has since replaced. So an item is new all day on the page it first
 *   appeared on, and seen from the next build on.
 * - Done: they clicked it (headline, chip, Send to Kobo, comment). Done items
 *   leave the page.
 * - An item comes back as new only with an `update` (what changed), which is
 *   part of its key, so a seen or done story can return once per real update.
 *
 * Stories are keyed by URL: the model writes a new item id every build.
 *
 * Channel slots are guaranteed shares of NEW items. A channel that can't fill
 * its share gives the unused slots to channels that have more new items (in
 * practice mostly AI). A busy channel never takes slots from one that can fill
 * its own. Seen items collapse into one "Seen before (n)" line per channel.
 */
import { CHANNELS, type ChannelKey } from "./channels";
import type { HomepageData, NewsItem } from "./homepage-data";

export interface SeenRecord {
  headline: string;
  /** Timestamp of the earliest page build this story (and update) was shown on in a viewed tab. */
  firstBuild?: string;
  /** ISO time they clicked it. */
  clickedAt?: string;
}

/** Keyed by seenKey(url, update). */
export type SeenStore = Record<string, SeenRecord>;

/** How long a story is remembered: the feeds' longest window. */
export const SEEN_DAYS = 7;

/** Normalized URL: no fragment, no tracking parameters, no trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_|fbclid$|gclid$|mc_)/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function seenKey(url: string, update?: string): string {
  const u = normalizeUrl(url);
  return update?.trim() ? `${u}#update:${update.trim().toLowerCase()}` : u;
}

export type ItemState = "new" | "seen" | "done";

/** An item's state on a page built at `pageBuilt`. */
export function itemState(item: Pick<NewsItem, "url" | "update">, store: SeenStore, pageBuilt: string): ItemState {
  const rec = store[seenKey(item.url, item.update)];
  if (!rec) return "new";
  if (rec.clickedAt) return "done";
  return rec.firstBuild && rec.firstBuild < pageBuilt ? "seen" : "new";
}

/** Record that a page was looked at: every item on it is shown, as of this build. */
export function recordShown(store: SeenStore, items: NewsItem[], pageBuilt: string): SeenStore {
  const next = { ...store };
  for (const item of items) {
    const key = seenKey(item.url, item.update);
    const rec = next[key];
    if (!rec) next[key] = { headline: item.headline, firstBuild: pageBuilt };
    else if (!rec.firstBuild || pageBuilt < rec.firstBuild) next[key] = { ...rec, firstBuild: pageBuilt };
  }
  return next;
}

export function recordClicked(store: SeenStore, item: Pick<NewsItem, "url" | "update" | "headline">, at: string): SeenStore {
  const key = seenKey(item.url, item.update);
  const rec = store[key];
  return { ...store, [key]: { ...rec, headline: rec?.headline ?? item.headline, clickedAt: rec?.clickedAt ?? at } };
}

/** Drop what is older than SEEN_DAYS. */
export function pruneSeen(store: SeenStore, now: Date): SeenStore {
  const cutoff = new Date(now.getTime() - SEEN_DAYS * 24 * 3600_000).toISOString();
  return Object.fromEntries(
    Object.entries(store).filter(([, r]) => (r.clickedAt ?? r.firstBuild ?? "") >= cutoff),
  );
}

/** The seen list for the kickoff, newest first, capped so it can't crowd the context. */
export function seenForPrompt(store: SeenStore, now: Date, cap = 80): string[] {
  const live = pruneSeen(store, now);
  return Object.entries(live)
    .sort((a, b) => (b[1].clickedAt ?? b[1].firstBuild ?? "").localeCompare(a[1].clickedAt ?? a[1].firstBuild ?? ""))
    .slice(0, cap)
    .map(([key, r]) => `- ${r.clickedAt ? "read" : "seen"}: ${r.headline} — ${key}`);
}

export interface ChannelView {
  key: ChannelKey;
  /** New items shown in full, best first. */
  fresh: NewsItem[];
  /** Seen items, collapsed into "Seen before (n)". */
  seen: NewsItem[];
}

export interface PageView {
  lead: NewsItem | undefined;
  /** Pinned above the lead until clicked, seen or not. */
  urgent: NewsItem[];
  channels: ChannelView[];
}

/**
 * Arrange a page: drop done items, pick a new lead, keep unclicked urgent items
 * pinned, then give each channel its guaranteed share of new items and hand
 * unused shares to the best overflow new items elsewhere. Pure, so the renderer
 * and the tests use the same rule.
 */
export function arrangePage(data: HomepageData, store: SeenStore, pageBuilt: string, now = new Date()): PageView {
  const state = new Map(data.items.map((i) => [i.id, itemState(i, store, pageBuilt)]));
  const live = data.items.filter((i) => state.get(i.id) !== "done");
  const isNew = (i: NewsItem) => state.get(i.id) === "new";

  // Lead: the model's pick if it's still new, else the best new item of the last 48h, else the best new item.
  let lead = live.find((i) => i.id === data.lead && isNew(i));
  if (!lead) {
    const fresh = live.filter(isNew).sort((a, b) => b.score - a.score);
    lead = fresh.find((i) => i.publishedAt && now.getTime() - Date.parse(i.publishedAt) < 48 * 3600_000) ?? fresh[0];
  }
  const urgent = live.filter((i) => i.urgent && i !== lead);
  const pinned = new Set<NewsItem | undefined>([lead, ...urgent]);

  const byScore = (a: NewsItem, b: NewsItem) => b.score - a.score;
  const rest = live.filter((i) => !pinned.has(i));
  const pools = CHANNELS.map((c) => {
    const inChannel = rest.filter((i) => i.channel === c.key);
    // Pinned items count toward their channel's share.
    const pinnedHere = [...pinned].filter((i) => i?.channel === c.key).length;
    return {
      key: c.key,
      share: Math.max(0, c.slots - pinnedHere),
      fresh: inChannel.filter(isNew).sort(byScore),
      seen: inChannel.filter((i) => !isNew(i)).sort(byScore),
    };
  });

  // 1. Each channel fills its own share with new items.
  const shown = new Map(pools.map((p) => [p.key, p.fresh.slice(0, p.share)]));
  let spare = pools.reduce((n, p) => n + Math.max(0, p.share - p.fresh.length), 0);
  // 2. Unused shares go to the best remaining new items in channels that have more.
  const overflow = pools.flatMap((p) => p.fresh.slice(p.share)).sort(byScore);
  for (const item of overflow) {
    if (spare <= 0) break;
    shown.get(item.channel)!.push(item);
    spare--;
  }

  return {
    lead,
    urgent,
    channels: pools.map((p) => ({ key: p.key, fresh: shown.get(p.key)!, seen: p.seen })),
  };
}
