/**
 * The world list: what the reader runs, depends on and works on. It lives at
 * config/world.md (or $HOMEPAGE_WORLD_LIST), is bundled at extension build time,
 * and is best kept current by your assistant (for example at a weekly review).
 *
 * Format (the contract with whoever maintains it): `## Group` headings, and under them one
 * bullet per thing, `- Chip label: term, term, term`. The label becomes the
 * "→ label" chip; the terms are matched case-insensitively as whole words.
 * Parenthetical notes in a term ("railway (preview only)") are ignored.
 *
 * A label may name its project: `- Shop WordPress [example-shop]: php`.
 * The slug is a project folder your assistant knows (see triage/README.md). Only labels with a slug can
 * start an advisory session (advisories.ts); "Python" or "Services" never do.
 */

export interface WorldEntry {
  group: string;
  label: string;
  terms: string[];
  /** Project slug, from `[slug]` after the label. */
  project?: string;
}

/** `Label [slug]`: the bracket is optional and a slug is lowercase letters, digits and dashes. */
const LABEL_RE = /^(.+?)(?:\s*\[([a-z0-9][a-z0-9-]*)\])?$/;

export function parseWorldList(markdown: string): WorldEntry[] {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const entries: WorldEntry[] = [];
  let group = "";
  for (const line of body.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      group = heading[1];
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+([^:]+?):\s*(.+)$/);
    if (!bullet || !group) continue;
    const terms = bullet[2]
      .split(",")
      .map((t) => t.replace(/\([^)]*\)/g, "").trim().toLowerCase())
      .filter((t) => t.length >= 2);
    const [, label, project] = bullet[1].trim().match(LABEL_RE)!;
    entries.push({ group, label: label.trim(), terms, ...(project ? { project } : {}) });
  }
  return entries;
}

/**
 * The list as the model sees it in the kickoff: frontmatter, the title and the
 * project slugs stripped (the model writes labels, and a slug would get copied
 * into them).
 */
export function worldListForPrompt(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^#\s.*\n/m, "")
    .replace(/^(\s*[-*]\s+[^:\n]+?)\s*\[[a-z0-9][a-z0-9-]*\]:/gm, "$1:")
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One compiled matcher per entry, so a feed of hundreds of entries doesn't recompile regexes. */
export function worldMatcher(entries: WorldEntry[]): (text: string) => string[] {
  const compiled = entries
    .filter((e) => e.terms.length)
    .map((e) => ({
      label: e.label,
      // Whole-word match; "node.js" and "next.js" keep their dots literal.
      re: new RegExp(`(?<![\\w.])(?:${e.terms.map(escape).join("|")})(?![\\w])`, "i"),
    }));
  return (text) => compiled.filter((c) => c.re.test(text)).map((c) => c.label);
}

/**
 * Words that usually mean "act by a date". getFeeds tags matching entries so
 * the model can't miss them; the model still decides whether an item is urgent.
 */
const SIGNALS: Array<[string, RegExp]> = [
  ["exploited", /exploited|in the wild|actively attacked|zero-day|0-day/i],
  ["critical", /\bcritical\b|\bRCE\b|remote code execution|CVSS\s*(?:score\s*)?(?:9|10)/i],
  ["security", /\bCVE-\d{4}-\d+|vulnerabilit|security (?:advisory|release|update)|patch now|update now/i],
  ["deprecation", /deprecat|end of life|\bEOL\b|sunset|shutting down|retire[sd]?\b|breaking change/i],
  ["pricing", /pric(?:e|ing) (?:change|increase|update)|new pricing|now costs|free tier|rate limit/i],
  ["credit", /credits? (?:expire|expiring)|expires? on/i],
  ["outage", /outage|degraded|incident|downtime/i],
];

export function signalsIn(text: string): string[] {
  return SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
