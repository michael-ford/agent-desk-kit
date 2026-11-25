/**
 * The channel redesign, tested without the API or Chrome.
 *
 * The PHP2Shell replay: on 2026-10-20 at 20:21 PT a build ran and missed the
 * critical PHP RCE (CVE-2026-109618/-109619) entirely, although php.net had
 * posted "update now" three hours earlier and the same advisory had been on HN
 * (1555 points) for seven. The fixtures are php.net's feed and HN's stories as
 * published (fetched 2026-10-24, trimmed). These tests show
 * that getFeeds would have handed that build the advisory, tagged with the
 * world-list label it touches and flagged as critical, and that the validator
 * keeps it pinned as urgent. They can't show what the model would then have
 * written; that needs a real build.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNELS,
  EXTRA_PER_CHANNEL,
  buildKickoffMessage,
  digestEntries,
  fetchFeeds,
  parseEuropePmc,
  parseGhsa,
  parseHn,
  parseKev,
  parseWorldList,
  parseXmlFeed,
  signalsIn,
  validateHomepageData,
  worldMatcher,
} from "@homepage/agent-core";

const FIXTURES = join(import.meta.dir, "fixtures/php2shell");
const PHP_FEED = readFileSync(join(FIXTURES, "php.net-feed.atom"), "utf-8");
/** Algolia's HN search for "php", Oct 20-22, over 100 points (includes some non-PHP stories). */
const HN_PHP_JSON = readFileSync(join(FIXTURES, "hn-php.json"), "utf-8");

/** The build that missed it: Oct 20 20:21 PT. */
const MISSED_BUILD = new Date("2026-10-21T03:21:00Z");

/** Four plain field items, so a test page clears the validator's minimum (MIN_ITEMS). */
const FILLER = Array.from({ length: 4 }, (_, i) => ({
  id: `filler${i}`,
  channel: "field",
  headline: `Filler ${i}`,
  url: `https://example.org/f${i}`,
  source: "Src",
  publishedAt: "2026-10-20T00:00:00Z",
  score: 10,
  touches: [],
  urgent: false,
  chips: [],
}));

// Your world list when it exists (that is the contract under test), otherwise a
// stand-in with the same shape.
const CONFIG_WORLD = join(import.meta.dir, "../config/world.md");
const WORLD_TEXT = existsSync(CONFIG_WORLD)
  ? readFileSync(CONFIG_WORLD, "utf-8")
  : "## Client stacks\n\n- Client WordPress: wordpress, php\n\n## Dependencies\n\n- Node: npm, node.js\n";
const WORLD = parseWorldList(WORLD_TEXT);
const PHP_LABELS = WORLD.filter((e) => e.terms.includes("php")).map((e) => e.label);

describe("world list", () => {
  test("parses into labelled entries with terms", () => {
    expect(WORLD.length).toBeGreaterThan(0);
    for (const e of WORLD) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.group.length).toBeGreaterThan(0);
    }
    expect(PHP_LABELS.length).toBeGreaterThan(0);
  });

  test("ignores frontmatter and parenthetical notes, keeps headings as groups", () => {
    const w = parseWorldList("---\ntitle: x\n---\n# T\n\n## Runs\n\n- App: railway (preview only), next.js\n- Not a bullet\n");
    expect(w).toEqual([{ group: "Runs", label: "App", terms: ["railway", "next.js"] }]);
  });

  test("matches whole words only", () => {
    const match = worldMatcher(parseWorldList("## G\n\n- Node: node.js, npm\n- Py: python\n"));
    expect(match("Node.js 22.11 security release")).toEqual(["Node"]);
    expect(match("npm package hijacked")).toEqual(["Node"]);
    expect(match("snpm is not npm-like")).toEqual(["Node"]); // "npm-like" still contains the word npm
    expect(match("Pythonic tips")).toEqual([]);
  });
});

describe("PHP2Shell replay (2026-10-20 20:21 PT build)", () => {
  const match = worldMatcher(WORLD);

  test("php.net's advisory was already in the feed, tagged and flagged", () => {
    const { entries } = digestEntries(parseXmlFeed(PHP_FEED), { now: MISSED_BUILD, days: 7, match });
    const advisory = entries.find((e) => /critical remote code execution/i.test(e.title));
    expect(advisory).toBeDefined();
    expect(advisory!.date).toBe("2026-10-21T00:35:26.000Z");
    expect(Date.parse(advisory!.date)).toBeLessThan(MISSED_BUILD.getTime());
    for (const label of PHP_LABELS) expect(advisory!.touches).toContain(label);
    expect(advisory!.signals).toContain("critical");
    expect(advisory!.signals).toContain("security");
    // Nothing from after the build leaks in.
    expect(entries.every((e) => Date.parse(e.date) <= MISSED_BUILD.getTime())).toBe(true);
  });

  test("HN had the warnings and the advisory itself, tagged; unrelated stories stay untagged", () => {
    const before = digestEntries(parseHn(HN_PHP_JSON), { now: MISSED_BUILD, days: 3, match, cap: 40 });
    const titles = before.entries.map((e) => e.title);
    expect(titles).toContain("Tell HN: 2x PHP RCE CVEs with CVSS 10.0 Incoming");
    const advisory = before.entries.find((e) => e.title.startsWith("Security advisory: Critical remote code execution"))!;
    expect(advisory.snippet).toMatch(/^1555 points/);
    expect(advisory.discussion).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=/);
    for (const label of PHP_LABELS) expect(advisory.touches).toContain(label);
    const php = before.entries.filter((e) => /\bPHP\b/.test(e.title));
    expect(php.every((e) => e.touches?.some((t) => PHP_LABELS.includes(t)))).toBe(true);
    // World-list matches sort ahead of everything else.
    const tagged = before.entries.filter((e) => e.touches).length;
    expect(tagged).toBeGreaterThanOrEqual(php.length + 1); // + the advisory, matched by php.net in its URL
    expect(before.entries.slice(0, tagged).every((e) => e.touches)).toBe(true);
    const musk = before.entries.find((e) => e.title.startsWith("Musk ordered Starlink"));
    expect(musk?.touches).toBeUndefined();

    const nextMorning = digestEntries(parseHn(HN_PHP_JSON), { now: new Date("2026-10-21T15:27:00Z"), days: 3, match, cap: 40 });
    expect(nextMorning.entries.some((e) => /PHP2Shell/.test(e.title))).toBe(true);
  });

  test("getFeeds returns it through the full tool path, and reports failed feeds", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://www.php.net/")) return new Response(PHP_FEED);
      if (url.startsWith("https://hn.algolia.com/")) return new Response(HN_PHP_JSON);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const result = await fetchFeeds({ world: WORLD, now: MISSED_BUILD, fetchImpl: fakeFetch });
    const php = result.feeds.find((f) => f.source === "PHP")!;
    expect(php.ok).toBe(true);
    expect(php.channel).toBe("work");
    expect(php.entries[0].signals).toContain("critical"); // flagged entries sort first
    const hn = result.feeds.find((f) => f.source === "Hacker News")!;
    expect(hn.channel).toBe("any");
    expect(hn.entries.length).toBeGreaterThan(0);
    const failed = result.feeds.filter((f) => !f.ok);
    expect(failed.length).toBe(result.feeds.length - 2);
    expect(failed.every((f) => f.error?.includes("404"))).toBe(true);
    // The whole tool result stays small: this is the context-budget point.
    expect(JSON.stringify(result).length).toBeLessThan(40_000);
  });

  test("the item the model should write survives validation pinned and labelled", () => {
    const label = PHP_LABELS[0];
    const page = {
      version: 1,
      lead: "php-rce",
      items: [
        {
          id: "php-rce",
          channel: "work",
          headline: "Critical PHP RCE exploited in the wild: client WordPress sites need PHP 8.5.12",
          url: "https://www.php.net/archive/2026.php",
          source: "php.net",
          publishedAt: "2026-10-21T00:35:26Z",
          score: 95,
          touches: [label, "Not On The List"],
          urgent: true,
          action: { what: "Check the WordPress host runs PHP 8.5.12+", by: "2026-10-21" },
          chips: [{ label: "HN", url: "https://news.ycombinator.com/item?id=1" }],
        },
        ...FILLER,
      ],
      calendar: [],
      github: { onYou: [], following: [] },
      alsoSeen: "",
      sources: [{ name: "PHP", ok: true }],
    };
    const { data, warnings } = validateHomepageData(JSON.stringify(page), {
      worldLabels: WORLD.map((e) => e.label),
      now: MISSED_BUILD,
    });
    const php = data.items.find((i) => i.id === "php-rce")!;
    expect(php.urgent).toBe(true);
    expect(php.touches).toEqual([label]);
    expect(warnings.some((w) => w.includes("Not On The List"))).toBe(true);
  });
});

describe("validateHomepageData", () => {
  const item = (over: Record<string, unknown>) => ({
    id: "x",
    channel: "ai",
    headline: "Headline",
    url: "https://example.org/a",
    source: "Src",
    publishedAt: "2026-10-24T10:00:00Z",
    score: 50,
    touches: [],
    urgent: false,
    chips: [],
    ...over,
  });
  const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, lead: "", items: [...items, ...FILLER], calendar: [], github: {}, alsoSeen: "", sources: [], ...extra });
  const now = new Date("2026-10-24T16:00:00Z");

  test("rejects non-JSON and pages with nothing usable", () => {
    expect(() => validateHomepageData("<html>", { now })).toThrow(/not valid JSON/);
    const tooFew = JSON.stringify({ version: 1, items: [item({}), item({ id: "y" })] });
    expect(() => validateHomepageData(tooFew, { now })).toThrow(/only 2 usable items/);
  });

  test("an empty world list allows no touches labels; an omitted one doesn't check them", () => {
    const p = page([item({ id: "a", touches: ["Anything"] })]);
    const strict = validateHomepageData(p, { now, worldLabels: [] });
    expect(strict.data.items.find((i) => i.id === "a")!.touches).toEqual([]);
    const loose = validateHomepageData(p, { now });
    expect(loose.data.items.find((i) => i.id === "a")!.touches).toEqual(["Anything"]);
  });

  test("drops bad items, unpins urgent items without an action, clamps scores", () => {
    const { data, warnings } = validateHomepageData(
      page([
        item({ id: "a", score: 140 }),
        item({ id: "b", channel: "sports" }),
        item({ id: "c", urgent: true }),
        item({ id: "d", url: "ftp://x" }),
      ]),
      { now },
    );
    expect(data.items.filter((i) => i.channel === "ai").map((i) => i.id).sort()).toEqual(["a", "c"]);
    expect(data.items.find((i) => i.id === "a")!.score).toBe(100);
    expect(data.items.find((i) => i.id === "c")!.urgent).toBe(false);
    expect(warnings.length).toBe(3);
  });

  test("enforces each channel's slots by score, and caps the urgent strip at 5", () => {
    const ai = CHANNELS.find((c) => c.key === "ai")!;
    const many = Array.from({ length: ai.slots + EXTRA_PER_CHANNEL + 4 }, (_, i) =>
      item({ id: `i${i}`, score: i, urgent: true, action: { what: "do", by: `2026-10-${10 + i}` } }),
    );
    const { data } = validateHomepageData(page(many), { now });
    const aiItems = data.items.filter((i) => i.channel === "ai");
    expect(aiItems.length).toBe(ai.slots + EXTRA_PER_CHANNEL);
    expect(Math.min(...aiItems.map((i) => i.score))).toBe(4);
    expect(data.items.filter((i) => i.urgent).length).toBe(5);
  });

  test("falls back to the best item of the last 48h as lead", () => {
    const { data } = validateHomepageData(
      page(
        [
          item({ id: "old", score: 99, publishedAt: "2026-10-18T00:00:00Z" }),
          item({ id: "new", score: 70, publishedAt: "2026-10-24T08:00:00Z" }),
        ],
        { lead: "missing" },
      ),
      { now },
    );
    expect(data.lead).toBe("new");
  });
});

describe("feed parsers", () => {
  test("RSS with CDATA and entity-encoded HTML", () => {
    const xml = `<rss><channel><item><title><![CDATA[A &amp; B]]></title><link>https://a.example/1</link>
      <pubDate>Wed, 21 Oct 2026 13:43:19 +0000</pubDate><description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description></item></channel></rss>`;
    expect(parseXmlFeed(xml)).toEqual([
      { title: "A & B", url: "https://a.example/1", date: "2026-10-21T13:43:19.000Z", snippet: "Hello world" },
    ]);
  });

  test("KEV, GHSA and Europe PMC", () => {
    const kev = parseKev(
      JSON.stringify({
        vulnerabilities: [
          { cveID: "CVE-1", vendorProject: "V", product: "P", vulnerabilityName: "N", dateAdded: "2026-10-23", dueDate: "2026-11-13", shortDescription: "d" },
        ],
      }),
    );
    expect(kev[0].snippet).toMatch(/^Exploited in the wild/);
    expect(signalsIn(kev[0].snippet)).toContain("exploited");

    const ghsa = parseGhsa(
      JSON.stringify([
        { ghsa_id: "G1", summary: "s", html_url: "https://github.com/advisories/G1", severity: "critical", published_at: "2026-10-23T00:00:00Z", vulnerabilities: [{ package: { name: "next" }, vulnerable_version_range: "< 16.0.3" }] },
        { ghsa_id: "G2", summary: "s", html_url: "https://github.com/advisories/G2", severity: "low", published_at: "2026-10-23T00:00:00Z" },
      ]),
    );
    expect(ghsa.map((g) => g.url)).toEqual(["https://github.com/advisories/G1"]);
    expect(ghsa[0].snippet).toContain("next < 16.0.3");

    const epmc = parseEuropePmc(
      JSON.stringify({ resultList: { result: [{ id: "PPR1", source: "PPR", title: "TCR <i>repertoire</i>", firstPublicationDate: "2026-10-21", doi: "10.1101/x" }] } }),
    );
    expect(epmc[0]).toMatchObject({ title: "TCR repertoire", url: "https://doi.org/10.1101/x" });
  });
});

describe("kickoff", () => {
  test("carries every channel, the world list and the leads", () => {
    const msg = buildKickoffMessage({ now: MISSED_BUILD, worldList: WORLD_TEXT, recentLeads: ["Old lead"] });
    for (const c of CHANNELS) expect(msg).toContain(`channel "${c.key}"`);
    expect(msg).toContain(WORLD[0].label);
    expect(msg).not.toContain("verify_by:"); // frontmatter stripped
    expect(msg).toContain("- Old lead");
  });
});
