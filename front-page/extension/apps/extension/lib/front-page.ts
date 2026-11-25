/**
 * The morning edition for the Kobo (morning.ts sends it): which articles go to
 * the device, and the "front page" document, which lists every headline and
 * every open triage card, numbered so the reader can answer into a voice recorder
 * ("headline 7, follow up", "triage T3, drop") without a screen.
 *
 * Pure functions over the arranged page (agent-core arrangePage) and the
 * Intake Triage app's /api/items payload, so the harness tests them directly.
 */
import { CHANNELS, normalizeUrl, type CalendarDay, type NewsItem, type PageView } from "@homepage/agent-core";
import { buildEpub, xmlEscape } from "./epub";

/** How many articles go to the Kobo each morning (2026-11-16: top 8 by score). */
export const MORNING_ARTICLES = 8;

/**
 * Hosts koreader-sync can't turn into a readable article: social posts, video,
 * and discussion pages. Their headlines are still on the front page.
 */
const UNREADABLE_HOSTS = [
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "news.ycombinator.com",
  "linkedin.com",
  "reddit.com",
  "bsky.app",
];

export function readableOnKobo(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^www\./, "");
  return !UNREADABLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** One numbered headline on the front page. */
export interface NumberedHeadline {
  n: number;
  item: NewsItem;
  section: string;
  /** Collapsed under "Seen before" on the page. */
  seen: boolean;
  onKobo: boolean;
}

/**
 * The page in reading order: urgent, lead, then each channel's new items, then
 * each channel's seen items. Done (clicked) items are already gone from the view.
 */
export function pageInOrder(view: PageView): Array<{ item: NewsItem; section: string; seen: boolean }> {
  const out: Array<{ item: NewsItem; section: string; seen: boolean }> = [];
  for (const item of view.urgent) out.push({ item, section: "Urgent", seen: false });
  if (view.lead) out.push({ item: view.lead, section: "Lead", seen: false });
  for (const c of view.channels) {
    const label = CHANNELS.find((ch) => ch.key === c.key)?.label ?? c.key;
    for (const item of c.fresh) out.push({ item, section: label, seen: false });
  }
  for (const c of view.channels) {
    const label = CHANNELS.find((ch) => ch.key === c.key)?.label ?? c.key;
    for (const item of c.seen) out.push({ item, section: `${label}: seen before`, seen: true });
  }
  return out;
}

/**
 * The articles to send: the best new items by score whose link koreader-sync
 * can read, skipping any already sent on an earlier morning (`alreadySent` holds
 * normalized URLs). Seen items are not sent: The reader has had them on screen.
 */
export function pickKoboArticles(view: PageView, alreadySent: ReadonlySet<string>, n = MORNING_ARTICLES): NewsItem[] {
  const picked: NewsItem[] = [];
  const urls = new Set<string>();
  const candidates = pageInOrder(view)
    .filter((e) => !e.seen)
    .map((e) => e.item)
    .sort((a, b) => b.score - a.score);
  for (const item of candidates) {
    if (picked.length >= n) break;
    const key = normalizeUrl(item.url);
    if (!readableOnKobo(item.url) || alreadySent.has(key) || urls.has(key)) continue;
    urls.add(key);
    picked.push(item);
  }
  return picked;
}

export function numberHeadlines(view: PageView, onKobo: readonly NewsItem[]): NumberedHeadline[] {
  const kobo = new Set(onKobo);
  return pageInOrder(view).map((e, i) => ({ ...e, n: i + 1, onKobo: kobo.has(e.item) }));
}

// ---- triage ------------------------------------------------------------------

/** The fields of an Intake Triage `/api/items` item that the front page uses. */
export interface TriageItem {
  checked: boolean;
  snoozedUntil?: string | null;
  kind?: string | null;
  text: string;
  source?: string | null;
  project?: string | null;
  options?: string[] | null;
}

export interface TriageFile {
  file: string;
  /** YYYY-MM-DD of the intake file. */
  date: string;
  /** YYYY-MM-DD, local, per the server. */
  today: string;
  /** Unix seconds the file was last written. */
  mtime: number;
  items: TriageItem[];
}

/** Open cards, as the Triage app counts them: not resolved and not snoozed past today. Action cards first. */
export function openCards(file: TriageFile): TriageItem[] {
  const open = file.items.filter((it) => !it.checked && !(it.snoozedUntil && it.snoozedUntil > file.today));
  return [...open.filter((it) => it.kind === "action"), ...open.filter((it) => it.kind !== "action")];
}

/** One numbered triage card: T-numbers run through "To act on" then "For awareness". */
export interface NumberedCard {
  /** The n of "Tn". */
  t: number;
  card: TriageItem;
  group: "To act on" | "For awareness";
}

/** The T-numbering the front page shows. `cards` is openCards() output; actions are numbered first. */
export function numberCards(cards: readonly TriageItem[]): NumberedCard[] {
  const actions = cards.filter((c) => c.kind === "action");
  const rest = cards.filter((c) => c.kind !== "action");
  return [
    ...actions.map((card) => ({ card, group: "To act on" as const })),
    ...rest.map((card) => ({ card, group: "For awareness" as const })),
  ].map((c, i) => ({ ...c, t: i + 1 }));
}

/** Markdown-ish intake text to plain text: links keep their label, emphasis and code marks go. */
export function plainText(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

// ---- the document ------------------------------------------------------------

export interface FrontPageInput {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** "Mon Nov 16". */
  dayLabel: string;
  /** ISO time the homepage was built. */
  homepageBuilt: string;
  /** ISO time this edition was made. */
  madeAt: string;
  headlines: NumberedHeadline[];
  calendar: CalendarDay[];
  /** null when the Triage server couldn't be reached. */
  triage: { file: TriageFile; cards: TriageItem[] } | null;
}

const CSS = `
body { font-family: serif; line-height: 1.35; margin: 0 0.4em; }
h1 { font-size: 1.5em; margin: 0.2em 0; }
h2 { font-size: 1.15em; margin: 1.1em 0 0.3em; border-bottom: 1px solid #000; }
h3 { font-size: 1em; margin: 0.9em 0 0.2em; font-variant: small-caps; }
p { margin: 0.35em 0; }
.meta { font-size: 0.85em; }
.h, .t { text-indent: -1.6em; margin-left: 1.6em; }
.n { font-weight: bold; }
.sub { font-size: 0.85em; margin-left: 1.6em; }
`;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** How the front page names where the articles went, and whether headlines link out. */
export interface BodyOptions {
  /** Link each headline to its story (a tablet can follow links; the Kobo EPUB stays plain). */
  links?: boolean;
  /** The marker on headlines that were sent as articles: "Kobo" gives "[Kobo]". */
  savedLabel?: string;
  /** Where those articles are: "your Wallabag list". */
  savedWhere?: string;
}

export function frontPageBody(input: FrontPageInput, opts: BodyOptions = {}): string {
  const { dayLabel, homepageBuilt, madeAt, headlines, calendar, triage } = input;
  const { links = false, savedLabel = "Kobo", savedWhere = "your Wallabag list" } = opts;
  const e = xmlEscape;
  const out: string[] = [];
  const koboCount = headlines.filter((h) => h.onKobo).length;

  out.push(`<h1>Front page · ${e(dayLabel)}</h1>`);
  out.push(
    `<p class="meta">Homepage built ${e(new Date(homepageBuilt).toDateString())} ${hhmm(homepageBuilt)}. ` +
      `This edition made ${hhmm(madeAt)}. ${koboCount} articles marked [${e(savedLabel)}] are in ${e(savedWhere)}. ` +
      (triage ? `Triage cards are from ${e(triage.file.file)}, as of ${hhmm(madeAt)}; they may change during the day.` : "Triage server was unreachable, so no cards today.") +
      `</p>`,
  );
  out.push(`<p class="meta">Answer by number into the recorder: “headline 7, follow up”, “triage T3, drop”.</p>`);

  const today = calendar.find((d) => /today/i.test(d.label)) ?? calendar[0];
  if (today && today.events.length) {
    out.push(`<h2>${e(today.label)}</h2>`);
    for (const ev of today.events) out.push(`<p>${e(ev.time)} · ${e(ev.title)}</p>`);
  }

  out.push(`<h2>Headlines (${headlines.length})</h2>`);
  let section = "";
  for (const h of headlines) {
    if (h.section !== section) {
      section = h.section;
      out.push(`<h3>${e(section)}</h3>`);
    }
    const it = h.item;
    const bits = [it.source, `score ${it.score}`, ...(it.touches.length ? [`→ ${it.touches.join(", ")}`] : [])];
    out.push(
      `<p class="h"><span class="n">${h.n}.</span> ${h.onKobo ? `<b>[${e(savedLabel)}]</b> ` : ""}` +
        (links && /^https?:\/\//i.test(it.url) ? `<a href="${e(it.url)}">${e(it.headline)}</a>` : e(it.headline)) +
        ` <span class="meta">(${e(bits.join(" · "))})</span></p>`,
    );
    if (it.update) out.push(`<p class="sub">Update: ${e(it.update)}</p>`);
    if (it.action) out.push(`<p class="sub">Do: ${e(it.action.what)}${it.action.by ? ` by ${e(it.action.by)}` : ""}</p>`);
    if (it.summary) out.push(`<p class="sub">${e(it.summary)}</p>`);
  }

  if (triage) {
    out.push(`<h2>Triage (${triage.cards.length} open)</h2>`);
    const numbered = numberCards(triage.cards);
    let group = "";
    for (const { t, card: c, group: g } of numbered) {
      if (g !== group) {
        group = g;
        out.push(`<h3>${g} (${numbered.filter((x) => x.group === g).length})</h3>`);
      }
      const where = [c.project, c.source].filter(Boolean).join(" · ");
      out.push(`<p class="t"><span class="n">T${t}.</span> ${e(plainText(c.text))}${where ? ` <span class="meta">(${e(where)})</span>` : ""}</p>`);
      if (c.options?.length) out.push(`<p class="sub">Options: ${c.options.map((o, i) => `(${i + 1}) ${e(plainText(o))}`).join(" ")}</p>`);
    }
  }
  return out.join("\n");
}

/**
 * The front page as a standalone HTML document with linked headlines, for
 * services that take HTML rather than an EPUB (Readwise Reader on an iPad).
 */
export function frontPageHtml(input: FrontPageInput, opts: BodyOptions = {}): string {
  const title = `Front page · ${input.dayLabel}`;
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${xmlEscape(title)}</title><style>${CSS}</style></head>` +
    `<body>${frontPageBody(input, { links: true, ...opts })}</body></html>`
  );
}

export function frontPageEpub(input: FrontPageInput): Uint8Array {
  return buildEpub({
    title: `Front page · ${input.dayLabel}`,
    author: "AI newtab",
    identifier: `urn:ai-newtab:front-page:${input.madeAt}`,
    date: input.date,
    css: CSS,
    chapters: [{ id: "front", title: `Front page · ${input.dayLabel}`, body: frontPageBody(input) }],
  });
}

// ---- the local copy for the assistant ---------------------------------------------------

/** What the edition sent, beyond the front page itself, for the local copy. */
export interface EditionExtras {
  trigger: "schedule" | "manual";
  /** koreader-sync (Wallabag) id of the front page EPUB. */
  frontPageId: number | string;
  articles: Array<{ url: string; headline: string; result: string; id?: number | string }>;
}

/** One line: no newlines, so a numbered entry never spills into the next. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The edition as markdown, written to your notes folder (edition/current.md) so
 * The assistant can resolve "headline 25" or "triage T3" from a voice note. Built from
 * the same numbered lists as frontPageBody, so the numbers match the Kobo.
 */
export function frontPageMarkdown(input: FrontPageInput, extras: EditionExtras): string {
  const { date, dayLabel, homepageBuilt, madeAt, headlines, calendar, triage } = input;
  const out: string[] = [];
  const cards = triage ? numberCards(triage.cards) : [];
  const byUrl = new Map(headlines.map((h) => [h.item.url, h.n]));

  out.push("---");
  out.push(`date: ${date}`);
  out.push(`made_at: ${madeAt}`);
  out.push(`made_at_local: "${hhmm(madeAt)}"`);
  out.push(`trigger: ${extras.trigger === "manual" ? "send-now" : "schedule"}`);
  out.push(`homepage_built: ${homepageBuilt}`);
  out.push(`triage_file: ${triage ? triage.file.file : "none (Triage server unreachable)"}`);
  out.push(`headlines: ${headlines.length}`);
  out.push(`triage_cards: ${cards.length}`);
  out.push(`front_page_wallabag_id: ${extras.frontPageId}`);
  out.push("---", "");
  out.push(`# Front page · ${dayLabel} (made ${hhmm(madeAt)})`, "");
  out.push(
    "The latest Kobo morning edition, overwritten each time one is made. Numbers are exactly as on the Kobo: " +
      "“headline N” is **N.** under Headlines, “triage TN” is **TN.** under Triage.",
    "",
  );

  const today = calendar.find((d) => /today/i.test(d.label)) ?? calendar[0];
  if (today && today.events.length) {
    out.push(`## ${oneLine(today.label)}`, "");
    for (const ev of today.events) out.push(`- ${oneLine(ev.time)} · ${oneLine(ev.title)}`);
    out.push("");
  }

  out.push(`## Articles sent to the Kobo (${extras.articles.length})`, "");
  for (const a of extras.articles) {
    const n = byUrl.get(a.url);
    const bits = [a.result, ...(a.id !== undefined ? [`wallabag id ${a.id}`] : []), ...(n ? [`headline ${n}`] : [])];
    out.push(`- ${oneLine(a.headline)} — ${a.url} (${bits.join(", ")})`);
  }
  out.push("");

  out.push(`## Headlines (${headlines.length})`);
  let section = "";
  for (const h of headlines) {
    if (h.section !== section) {
      section = h.section;
      out.push("", `### ${section}`, "");
    }
    const it = h.item;
    const bits = [it.source, `score ${it.score}`, ...(it.touches.length ? [`→ ${it.touches.join(", ")}`] : [])];
    out.push(`- **${h.n}.** ${h.onKobo ? "[Kobo] " : ""}${oneLine(it.headline)} (${oneLine(bits.join(" · "))}) ${it.url}`);
    if (it.update) out.push(`  - Update: ${oneLine(it.update)}`);
    if (it.action) out.push(`  - Do: ${oneLine(it.action.what)}${it.action.by ? ` by ${oneLine(it.action.by)}` : ""}`);
    if (it.summary) out.push(`  - ${oneLine(it.summary)}`);
  }
  out.push("");

  if (!triage) {
    out.push("## Triage", "", "The Triage server was unreachable, so the edition had no cards.");
  } else {
    out.push(`## Triage (${cards.length} open, from ${triage.file.file})`);
    let group = "";
    for (const { t, card: c, group: g } of cards) {
      if (g !== group) {
        group = g;
        out.push("", `### ${g} (${cards.filter((x) => x.group === g).length})`, "");
      }
      const where = [c.project, c.source].filter(Boolean).join(" · ");
      out.push(`- **T${t}.** ${oneLine(plainText(c.text))}${where ? ` (${oneLine(where)})` : ""}`);
      if (c.options?.length) out.push(`  - Options: ${c.options.map((o, i) => `(${i + 1}) ${oneLine(plainText(o))}`).join(" ")}`);
      out.push(`  - Intake text: ${oneLine(c.text)}`);
    }
  }
  return out.join("\n").trimEnd() + "\n";
}
