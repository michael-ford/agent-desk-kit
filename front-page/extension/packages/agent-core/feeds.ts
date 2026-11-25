/**
 * getFeeds: fetch every channel's feed sources in code and hand the model short,
 * date-windowed entries instead of whole pages. Some of these feeds are huge
 * (Cloudflare's changelog is ~8 MB, Vercel's ~4 MB, php.net's ~1.5 MB); fetched
 * with web_fetch they would fill the context window, which is how the
 * 2026-10-09 build died. Each entry is pre-tagged with the world-list labels its
 * text matches and with urgency signals, as hints the model confirms.
 *
 * Pure parsing plus `fetch`: no DOM (MV3 service workers have no DOMParser),
 * no chrome.*, no node:*, so the harness can test it with fixtures.
 */
import { CHANNELS, SHARED_FEEDS, type ChannelKey, type FeedFormat, type Source } from "./channels";
import { signalsIn, worldMatcher, type WorldEntry } from "./world";

export interface FeedEntry {
  title: string;
  url: string;
  /** ISO 8601. */
  date: string;
  /** Plain text, at most SNIPPET_CHARS. */
  snippet: string;
  /** World-list labels whose terms appear in the title or snippet (hints only). */
  touches?: string[];
  /** Urgency words found: exploited, critical, security, deprecation, pricing, credit, outage. */
  signals?: string[];
  /** Hacker News discussion, for an HN chip. */
  discussion?: string;
}

export interface FeedResult {
  source: string;
  /** "any" for shared feeds such as Hacker News: the model places each entry. */
  channel: ChannelKey | "any";
  ok: boolean;
  error?: string;
  /** Entries in the window before the per-source cap was applied. */
  inWindow: number;
  entries: FeedEntry[];
}

export interface GetFeedsResult {
  windowNote: string;
  feeds: FeedResult[];
}

export const SNIPPET_CHARS = 200;
export const ENTRIES_PER_FEED = 12;
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Tag-stripped, entity-decoded, whitespace-collapsed text. */
export function plainText(s: string): string {
  const unwrapped = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Feeds often entity-encode their HTML, so decode, strip tags, then decode again.
  return decodeEntities(decodeEntities(unwrapped).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
  return pick?.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
}

function toIso(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(plainText(s));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** RSS 2.0 `<item>` and Atom `<entry>`, without a DOM. */
export function parseXmlFeed(xml: string): FeedEntry[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const out: FeedEntry[] = [];
  for (const [, kind, block] of blocks) {
    const title = plainText(tag(block, "title") ?? "");
    const url =
      kind.toLowerCase() === "entry"
        ? atomLink(block)
        : plainText(tag(block, "link") ?? "") || plainText(tag(block, "guid") ?? "");
    const date = toIso(
      tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date"),
    );
    const body = tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? "";
    if (!title || !url || !/^https?:/i.test(decodeEntities(url))) continue;
    out.push({ title, url: decodeEntities(url), date, snippet: plainText(body).slice(0, SNIPPET_CHARS) });
  }
  return out;
}

interface KevVuln {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  dueDate: string;
  shortDescription: string;
  knownRansomwareCampaignUse?: string;
}

/** CISA's Known Exploited Vulnerabilities catalog. Every entry is exploited in the wild by definition. */
export function parseKev(json: string): FeedEntry[] {
  const data = JSON.parse(json) as { vulnerabilities?: KevVuln[] };
  return (data.vulnerabilities ?? []).map((v) => ({
    title: `${v.cveID}: ${v.vendorProject} ${v.product}, ${v.vulnerabilityName} (CISA due ${v.dueDate})`,
    url: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
    date: toIso(v.dateAdded),
    snippet: `Exploited in the wild. ${v.shortDescription}`.slice(0, SNIPPET_CHARS),
  }));
}

interface Ghsa {
  ghsa_id: string;
  summary: string;
  html_url: string;
  severity: string;
  published_at: string;
  cve_id?: string | null;
  vulnerabilities?: Array<{ package?: { ecosystem?: string; name?: string } | null; vulnerable_version_range?: string | null }>;
}

/** GitHub's reviewed advisories. Only critical and high are kept; the rest is noise at this scale. */
export function parseGhsa(json: string): FeedEntry[] {
  const data = JSON.parse(json) as Ghsa[];
  return data
    .filter((a) => a.severity === "critical" || a.severity === "high")
    .map((a) => {
      const pkgs = (a.vulnerabilities ?? [])
        .map((v) => (v.package?.name ? `${v.package.name} ${v.vulnerable_version_range ?? ""}`.trim() : ""))
        .filter(Boolean)
        .join("; ");
      return {
        title: `${a.severity.toUpperCase()} ${a.cve_id ?? a.ghsa_id}: ${a.summary}`,
        url: a.html_url,
        date: toIso(a.published_at),
        snippet: `Packages: ${pkgs}`.slice(0, SNIPPET_CHARS),
      };
    });
}

interface EpmcResult {
  id: string;
  source: string;
  title: string;
  authorString?: string;
  firstPublicationDate?: string;
  bookOrReportDetails?: { publisher?: string };
  doi?: string;
}

/** Europe PMC search results (used for bioRxiv/medRxiv preprints: bioRxiv's own RSS is gone). */
export function parseEuropePmc(json: string): FeedEntry[] {
  const data = JSON.parse(json) as { resultList?: { result?: EpmcResult[] } };
  return (data.resultList?.result ?? []).map((r) => ({
    title: plainText(r.title),
    url: r.doi ? `https://doi.org/${r.doi}` : `https://europepmc.org/article/${r.source}/${r.id}`,
    date: toIso(r.firstPublicationDate),
    snippet: `${r.bookOrReportDetails?.publisher ?? "Preprint"} · ${r.authorString ?? ""}`.slice(0, SNIPPET_CHARS),
  }));
}

interface HnHit {
  objectID: string;
  title: string;
  url?: string | null;
  created_at: string;
  points: number;
  num_comments?: number;
}

/** Hacker News stories from Algolia's search API. Ask HN/Tell HN posts link to their own thread. */
export function parseHn(json: string): FeedEntry[] {
  const data = JSON.parse(json) as { hits?: HnHit[] };
  return (data.hits ?? []).map((h) => {
    const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
    return {
      title: h.title,
      url: h.url || discussion,
      date: toIso(h.created_at),
      snippet: `${h.points} points, ${h.num_comments ?? 0} comments`,
      discussion,
    };
  });
}

const PARSERS: Record<FeedFormat, (body: string) => FeedEntry[]> = {
  xml: parseXmlFeed,
  kev: parseKev,
  ghsa: parseGhsa,
  europepmc: parseEuropePmc,
  hn: parseHn,
};

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

/**
 * Window, tag, and cap one feed's entries. Undated entries are kept only when
 * nothing in the feed is dated (some feeds omit dates), so they can't crowd out
 * fresh ones.
 */
export function digestEntries(
  entries: FeedEntry[],
  opts: { now: Date; days: number; match: (text: string) => string[]; cap?: number },
): { inWindow: number; entries: FeedEntry[] } {
  const since = opts.now.getTime() - opts.days * 24 * 3600_000;
  // An hour of slack for clocks; beyond that a "future" entry is a bad date.
  const until = opts.now.getTime() + 3600_000;
  const anyDated = entries.some((e) => e.date);
  const fresh = entries
    .filter((e) => (e.date ? Date.parse(e.date) >= since && Date.parse(e.date) <= until : !anyDated))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const seen = new Set<string>();
  const unique = fresh.filter((e) => !seen.has(e.url) && seen.add(e.url));
  const tagged = unique.map((e) => {
    const text = `${e.title} ${e.snippet}`;
    // The link's host counts for the world list: HN's copy of php.net's
    // advisory never says "PHP" in its title, only in its URL.
    const touches = opts.match(`${text} ${hostWords(e.url)}`);
    const signals = signalsIn(text);
    return { ...e, ...(touches.length ? { touches } : {}), ...(signals.length ? { signals } : {}) };
  });
  // Entries that touch the world list go first, then ones with an urgency
  // signal, so the cap cuts plain entries before flagged ones.
  const flagged = (e: FeedEntry) => (e.touches ? 2 : 0) + (e.signals ? 1 : 0);
  const ordered = [...tagged].sort((a, b) => flagged(b) - flagged(a));
  return { inWindow: tagged.length, entries: ordered.slice(0, opts.cap ?? ENTRIES_PER_FEED) };
}

/** Hosts whose name says nothing about the story (any repo or post can live there). */
const GENERIC_HOSTS = /(^|\.)(github\.com|githubusercontent\.com|github\.io|medium\.com|substack\.com|youtube\.com|x\.com|twitter\.com|news\.ycombinator\.com)$/;

/** "www.php.net" → "php net", so a host can match world-list terms as words. */
export function hostWords(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return GENERIC_HOSTS.test(host) ? "" : host.split(".").join(" ");
  } catch {
    return "";
  }
}

/** Fill a source URL's window placeholders: {from} and {to} (YYYY-MM-DD), {since} (epoch seconds). */
export function fillDates(url: string, now: Date, days: number): string {
  const start = new Date(now.getTime() - days * 24 * 3600_000);
  const values: Record<string, string> = {
    from: start.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
    since: String(Math.floor(start.getTime() / 1000)),
  };
  let out = url;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(encodeURIComponent(`{${k}}`), v).replaceAll(`{${k}}`, v);
  }
  return out;
}

export interface FetchFeedsOptions {
  world: WorldEntry[];
  now?: Date;
  /** Only these channels (default: all, plus the shared feeds). */
  channels?: ChannelKey[];
  /** Override every channel's window. */
  days?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchFeeds(opts: FetchFeedsOptions): Promise<GetFeedsResult> {
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;
  const match = worldMatcher(opts.world);
  const wanted = CHANNELS.filter((c) => !opts.channels?.length || opts.channels.includes(c.key));

  const jobs: Array<{ source: Source; channel: ChannelKey | "any"; days: number }> = [
    ...wanted.flatMap((c) =>
      c.sources.filter((s) => s.mode === "feed").map((s) => ({ source: s, channel: c.key, days: opts.days ?? c.windowDays })),
    ),
    ...(opts.channels?.length ? [] : SHARED_FEEDS.map((s) => ({ source: s, channel: "any" as const, days: opts.days ?? 3 }))),
  ];

  const feeds = await Promise.all(
    jobs.map(async ({ source, channel, days }): Promise<FeedResult> => {
      try {
        const res = await doFetch(fillDates(source.url, now, days), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { Accept: "application/rss+xml, application/atom+xml, application/json, text/xml, */*" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = PARSERS[source.format ?? "xml"](await res.text());
        const digest = digestEntries(parsed, { now, days, match, cap: source.cap });
        return { source: source.name, channel, ok: true, ...digest };
      } catch (err) {
        return { source: source.name, channel, ok: false, error: String(err).slice(0, 200), inWindow: 0, entries: [] };
      }
    }),
  );

  return {
    windowNote:
      "Entries are pre-filtered to each channel's window and capped per feed. touches and signals are keyword " +
      "hints from code: confirm them before using a touches label as a chip or marking an item urgent.",
    feeds,
  };
}
