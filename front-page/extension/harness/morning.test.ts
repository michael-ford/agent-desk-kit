/**
 * The morning edition (apps/extension/lib/morning.ts, front-page.ts, epub.ts):
 * when it fires, what it picks, that the front page is a valid EPUB, and the
 * full push against a fake koreader-sync and Intake Triage server.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arrangePage, type ChannelKey, type HomepageData, type NewsItem } from "@homepage/agent-core";

// ---- fake chrome.storage, installed before the extension modules load --------
const store: Record<string, unknown> = {};
(globalThis as any).browser = {
  storage: {
    local: {
      async get(key: string) {
        return key in store ? { [key]: structuredClone(store[key]) } : {};
      },
      async set(obj: Record<string, unknown>) {
        Object.assign(store, structuredClone(obj));
      },
      async remove(key: string) {
        delete store[key];
      },
    },
  },
};

const { buildEpub, crc32 } = await import("../apps/extension/lib/epub");
const { frontPageBody, frontPageEpub, frontPageHtml, frontPageMarkdown, numberCards, numberHeadlines, openCards, pickKoboArticles, plainText, readableOnKobo } =
  await import("../apps/extension/lib/front-page");
const { morningPushDue, runMorningPush, localDate, archiveOldArticles, pruneSent, flushEditionOutbox } = await import(
  "../apps/extension/lib/morning"
);

let n = 0;
function item(channel: ChannelKey, over: Partial<NewsItem> = {}): NewsItem {
  n++;
  return {
    id: `${channel}-${n}`,
    channel,
    headline: `${channel} story ${n}`,
    url: `https://example.org/${channel}/${n}`,
    source: "Src",
    publishedAt: "2026-11-16T10:00:00.000Z",
    score: 50,
    touches: [],
    urgent: false,
    chips: [],
    ...over,
  };
}
function page(items: NewsItem[], lead = items[0]!.id): HomepageData {
  return {
    version: 1,
    lead,
    items,
    calendar: [{ label: "Today · Mon Nov 16", events: [{ time: "09:30", title: "Team standup" }] }],
    github: { onYou: [], following: [] },
    alsoSeen: "",
    sources: [],
  };
}

/** Local time on Mon 2026-11-16 (the test's local time zone). */
const at = (h: number, m = 0) => new Date(2026, 10, 16, h, m);
const TODAY = "2026-11-16";

function triageFile(over: Partial<{ date: string; mtime: number }> = {}) {
  return {
    file: `${over.date ?? TODAY}-intake.md`,
    date: over.date ?? TODAY,
    today: TODAY,
    mtime: over.mtime ?? at(6, 12).getTime() / 1000,
    items: [
      { checked: false, kind: "awareness", text: "Groceries gained **kosher salt**.", project: "personal", source: "keep" },
      { checked: false, kind: "action", text: "Pick a repo: [lint](https://x.y)", project: "dev", source: "reel", options: ["Lint", "Remove"] },
      { checked: true, kind: "action", text: "Done already", project: "dev" },
      { checked: false, kind: "action", text: "Snoozed to Friday", snoozedUntil: "2026-11-20" },
      { checked: false, kind: "awareness", text: "Snooze ended today", snoozedUntil: TODAY },
    ],
  };
}

describe("when the morning edition fires", () => {
  const fresh = at(6, 8).toISOString();
  const stale = new Date(2026, 10, 15, 18, 6).toISOString();
  const sweep = { date: TODAY, today: TODAY, mtime: at(6, 12).getTime() / 1000 };
  const base = { enabled: true, record: null, buildRunning: false, triage: sweep };

  test("not before 06:00 or after noon, and not when off", () => {
    expect(morningPushDue({ ...base, now: at(5, 59), homepageBuilt: fresh }).due).toBe(false);
    expect(morningPushDue({ ...base, now: at(12, 0), homepageBuilt: fresh }).due).toBe(false);
    expect(morningPushDue({ ...base, now: at(6, 30), homepageBuilt: fresh, enabled: false }).due).toBe(false);
  });

  test("waits for the 06:00 build and the morning sweep, then goes", () => {
    expect(morningPushDue({ ...base, now: at(6, 5), homepageBuilt: stale, buildRunning: true }).reason).toBe("waiting for the build");
    // Fresh page, but the sweep only just wrote the file.
    expect(morningPushDue({ ...base, now: at(6, 13), homepageBuilt: fresh }).due).toBe(false);
    // Fresh page, yesterday's file only.
    expect(morningPushDue({ ...base, now: at(6, 20), homepageBuilt: fresh, triage: { ...sweep, date: "2026-11-15" } }).due).toBe(false);
    expect(morningPushDue({ ...base, now: at(6, 16), homepageBuilt: fresh }).due).toBe(true);
  });

  test("at 06:40 goes with what it has; a running build holds it until 06:50", () => {
    expect(morningPushDue({ ...base, now: at(6, 40), homepageBuilt: stale, triage: null }).due).toBe(true);
    expect(morningPushDue({ ...base, now: at(6, 40), homepageBuilt: fresh, triage: { ...sweep, date: "2026-11-15" } }).due).toBe(true);
    expect(morningPushDue({ ...base, now: at(6, 45), homepageBuilt: stale, buildRunning: true }).due).toBe(false);
    expect(morningPushDue({ ...base, now: at(6, 50), homepageBuilt: stale, buildRunning: true }).due).toBe(true);
  });

  test("a Mac that slept past 07:00 still gets the edition once it wakes, after the build", () => {
    expect(morningPushDue({ ...base, now: at(8, 30), homepageBuilt: stale, buildRunning: true }).due).toBe(true);
    expect(morningPushDue({ ...base, now: at(8, 30), homepageBuilt: stale }).due).toBe(true);
  });

  test("once a day; a failure retries every 5 minutes, at most 4 attempts", () => {
    const rec = (status: "done" | "failed" | "running", mins: number, attempts = 1) => ({
      date: TODAY,
      status,
      trigger: "schedule" as const,
      at: at(6, mins).toISOString(),
      attempts,
    });
    const now = at(6, 30);
    expect(morningPushDue({ ...base, now, homepageBuilt: fresh, record: rec("done", 20) }).due).toBe(false);
    expect(morningPushDue({ ...base, now, homepageBuilt: fresh, record: rec("failed", 27) }).due).toBe(false);
    expect(morningPushDue({ ...base, now, homepageBuilt: fresh, record: rec("failed", 25) }).due).toBe(true);
    expect(morningPushDue({ ...base, now, homepageBuilt: fresh, record: rec("failed", 10, 4) }).due).toBe(false);
    expect(morningPushDue({ ...base, now, homepageBuilt: fresh, record: rec("running", 25) }).due).toBe(false);
    expect(morningPushDue({ ...base, now, homepageBuilt: fresh, record: rec("running", 15) }).due).toBe(true);
    // Yesterday's record doesn't block today.
    expect(morningPushDue({ ...base, now, homepageBuilt: fresh, record: { ...rec("done", 20), date: "2026-11-15" } }).due).toBe(true);
  });
});

describe("what goes to the Kobo", () => {
  test("only links koreader-sync can read", () => {
    expect(readableOnKobo("https://www.anthropic.com/news/x")).toBe(true);
    expect(readableOnKobo("https://x.com/a/status/1")).toBe(false);
    expect(readableOnKobo("https://mobile.twitter.com/a")).toBe(false);
    expect(readableOnKobo("https://www.youtube.com/watch?v=1")).toBe(false);
    expect(readableOnKobo("https://news.ycombinator.com/item?id=1")).toBe(false);
    expect(readableOnKobo("not a url")).toBe(false);
  });

  test("top 8 new items by score, skipping unreadable links, seen items and earlier mornings' sends", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => item("ai", { score: 90 - i })),
      item("work", { score: 99, url: "https://x.com/someone/status/1" }),
      item("field", { score: 95, url: "https://example.org/sent-yesterday" }),
      item("career", { score: 40 }),
    ];
    const view = arrangePage(page(items), {}, at(6, 8).toISOString(), at(6, 30));
    const picks = pickKoboArticles(view, new Set(["https://example.org/sent-yesterday"]));
    expect(picks).toHaveLength(8);
    expect(picks.map((p) => p.score)).toEqual([90, 89, 88, 87, 86, 85, 84, 83]);
  });

  test("open triage cards match the Triage app: unresolved, not snoozed past today, actions first", () => {
    const cards = openCards(triageFile());
    expect(cards.map((c) => c.text)).toEqual([
      "Pick a repo: [lint](https://x.y)",
      "Groceries gained **kosher salt**.",
      "Snooze ended today",
    ]);
    expect(plainText(cards[0]!.text)).toBe("Pick a repo: lint");
  });

  test("the front page numbers every headline and every card, and marks the Kobo ones", () => {
    const items = [item("ai", { score: 80, headline: "Lead & <stuff>" }), item("work", { score: 70, urgent: true }), item("field", { score: 60 })];
    const view = arrangePage(page(items), {}, at(6, 8).toISOString(), at(6, 30));
    const headlines = numberHeadlines(view, [items[0]!]);
    const file = triageFile();
    const body = frontPageBody({
      date: TODAY,
      dayLabel: "Mon Nov 16",
      homepageBuilt: at(6, 8).toISOString(),
      madeAt: at(6, 20).toISOString(),
      headlines,
      calendar: page(items).calendar,
      triage: { file, cards: openCards(file) },
    });
    expect(headlines.map((h) => h.n)).toEqual([1, 2, 3]);
    expect(headlines[0]!.section).toBe("Urgent");
    expect(body).toContain("<b>[Kobo]</b> Lead &amp; &lt;stuff&gt;");
    expect(body).toContain('<span class="n">T1.</span> Pick a repo: lint');
    expect(body).toContain("(1) Lint (2) Remove");
    expect(body).toContain("<span class=\"n\">T3.</span> Snooze ended today");
    expect(body).toContain("09:30 · Team standup");
    expect(body).toContain("Triage (3 open)");
  });

  test("the local copy for the assistant carries exactly the Kobo's numbers, from the same lists", () => {
    const items = [
      item("ai", { score: 80, headline: "Lead\nwith a break" }),
      item("work", { score: 70, urgent: true }),
      item("field", { score: 60, summary: "A summary." }),
      item("ai", { score: 40 }),
    ];
    const view = arrangePage(page(items), { [items[3]!.url]: { firstSeen: at(5).toISOString() } } as any, at(6, 8).toISOString(), at(6, 30));
    const headlines = numberHeadlines(view, [items[2]!]);
    const file = triageFile();
    const input = {
      date: TODAY,
      dayLabel: "Mon Nov 16",
      homepageBuilt: at(6, 8).toISOString(),
      madeAt: at(6, 20).toISOString(),
      headlines,
      calendar: page(items).calendar,
      triage: { file, cards: openCards(file) },
    };
    const body = frontPageBody(input);
    const md = frontPageMarkdown(input, {
      trigger: "schedule",
      frontPageId: 777,
      articles: [{ url: items[2]!.url, headline: items[2]!.headline, result: "queued", id: 501 }],
    });
    // Every number on the EPUB is the same item in the markdown.
    for (const h of headlines) {
      const title = h.item.headline.replace(/\s+/g, " ");
      expect(body).toContain(`<span class="n">${h.n}.</span> ${h.onKobo ? "<b>[Kobo]</b> " : ""}${h.item.headline}`);
      expect(md).toContain(`- **${h.n}.** ${h.onKobo ? "[Kobo] " : ""}${title} (`);
      expect(md).toContain(h.item.url);
    }
    const cards = numberCards(openCards(file));
    expect(cards.map((c) => [c.t, c.group])).toEqual([[1, "To act on"], [2, "For awareness"], [3, "For awareness"]]);
    for (const c of cards) {
      expect(body).toContain(`<span class="n">T${c.t}.</span> ${plainText(c.card.text)}`);
      expect(md).toContain(`- **T${c.t}.** ${plainText(c.card.text)}`);
    }
    expect(md).toContain("  - Options: (1) Lint (2) Remove");
    expect(md).toContain("  - Intake text: Pick a repo: [lint](https://x.y)");
    expect(md.startsWith("---\ndate: 2026-11-16\n")).toBe(true);
    expect(md).toContain("trigger: schedule");
    expect(md).toContain("triage_file: 2026-11-16-intake.md");
    expect(md).toContain("front_page_wallabag_id: 777");
    expect(md).toContain(`(queued, wallabag id 501, headline ${headlines.find((h) => h.onKobo)!.n})`);
    expect(md).toContain("- 09:30 · Team standup");
    expect(md).not.toMatch(/Lead\nwith/);
    // The section headings appear in the same order as on the Kobo.
    const order = (s: string, names: string[]) => names.map((x) => s.indexOf(x));
    const sections = [...new Set(headlines.map((h) => h.section))];
    expect(order(md, sections.map((x) => `### ${x}`))).toEqual([...order(md, sections.map((x) => `### ${x}`))].sort((a, b) => a - b));
  });

  test("with the Triage server down the local copy says so", () => {
    const view = arrangePage(page([item("ai")]), {}, at(6, 8).toISOString(), at(6, 30));
    const md = frontPageMarkdown(
      { date: TODAY, dayLabel: "Mon Nov 16", homepageBuilt: at(6, 8).toISOString(), madeAt: at(6, 20).toISOString(), headlines: numberHeadlines(view, []), calendar: [], triage: null },
      { trigger: "manual", frontPageId: 1, articles: [] },
    );
    expect(md).toContain("trigger: send-now");
    expect(md).toContain("triage_file: none (Triage server unreachable)");
    expect(md).toContain("The Triage server was unreachable");
  });
});

describe("the EPUB", () => {
  test("crc32 matches the zip standard", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("is a valid zip with mimetype first and stored, and well-formed XHTML", async () => {
    const items = [item("ai", { headline: "Q&A: “quotes” and émojis ✓" })];
    const view = arrangePage(page(items), {}, at(6, 8).toISOString(), at(6, 30));
    const epub = frontPageEpub({
      date: TODAY,
      dayLabel: "Mon Nov 16",
      homepageBuilt: at(6, 8).toISOString(),
      madeAt: at(6, 20).toISOString(),
      headlines: numberHeadlines(view, []),
      calendar: [],
      triage: { file: triageFile(), cards: openCards(triageFile()) },
    });
    // "mimetype" is the first local header, stored (method 0), no extra field.
    expect(new TextDecoder().decode(epub.slice(30, 38))).toBe("mimetype");
    expect(new DataView(epub.buffer).getUint16(8, true)).toBe(0);
    expect(new TextDecoder().decode(epub.slice(38, 58))).toBe("application/epub+zip");

    const dir = mkdtempSync(join(tmpdir(), "morning-epub-"));
    const path = join(dir, "front.epub");
    writeFileSync(path, epub);
    const t = Bun.spawnSync(["unzip", "-t", path]);
    expect(t.exitCode).toBe(0);
    for (const f of ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/toc.ncx", "OEBPS/front.xhtml"]) {
      const x = Bun.spawnSync(["sh", "-c", `unzip -p "${path}" "${f}" | xmllint --noout -`]);
      expect({ f, code: x.exitCode, err: x.stderr.toString() }).toEqual({ f, code: 0, err: "" });
    }
  });

  test("buildEpub lists every chapter in the spine", () => {
    const epub = buildEpub({ title: "T", author: "A", identifier: "urn:x", date: TODAY, chapters: [{ id: "a", title: "A", body: "<p>a</p>" }, { id: "b", title: "B", body: "<p>b</p>" }] });
    const text = new TextDecoder().decode(epub);
    expect(text).toContain('<itemref idref="a"/>');
    expect(text).toContain('<itemref idref="b"/>');
  });
});

describe("the push, against fake koreader-sync and Intake Triage servers", () => {
  type Call = { method: string; path: string; body?: unknown };
  let calls: Call[] = [];
  let nextId = 500;
  let uploadFails = false;
  let triageDown = false;
  let editionCopies: Array<{ date: string; madeAt: string; markdown: string }> = [];

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    calls = [];
    uploadFails = false;
    triageDown = false;
    editionCopies = [];
    store.koboConfig = { baseUrl: "https://wallabag.example.com", username: "reader", password: "pw", clientId: "id", clientSecret: "secret" };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.host === "127.0.0.1:8766") {
        if (triageDown) throw new TypeError("Failed to fetch");
        if (url.pathname === "/api/newtab/edition") {
          expect(method).toBe("POST");
          expect((init?.headers as Record<string, string>)["X-Intake-Triage"]).toBe("1");
          editionCopies.push(JSON.parse(String(init!.body)));
          return Response.json({ ok: true, written: true });
        }
        expect(url.pathname).toBe("/api/items");
        return Response.json(triageFile());
      }
      expect(url.host).toBe("wallabag.example.com");
      if (url.pathname === "/oauth/v2/token") return Response.json({ access_token: "tok", expires_in: 3600 });
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      if (url.pathname === "/api/entries" && method === "POST") {
        const body = JSON.parse(String(init!.body));
        calls.push({ method, path: url.pathname, body });
        return Response.json({ id: nextId++ }, { status: body.url.endsWith("/dup") ? 200 : 201 });
      }
      if (url.pathname === "/api/entries/upload") {
        const form = init!.body as FormData;
        const file = form.get("file") as File;
        calls.push({ method, path: url.pathname, body: { name: file.name, title: form.get("title"), tags: form.get("tags"), size: file.size } });
        if (uploadFails) return Response.json({ error: "boom" }, { status: 500 });
        return Response.json({ id: nextId++ }, { status: 201 });
      }
      const m = url.pathname.match(/^\/api\/entries\/(\d+)$/);
      if (m && method === "PATCH") {
        calls.push({ method, path: url.pathname, body: JSON.parse(String(init!.body)) });
        return Response.json({ id: Number(m[1]) });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
  });

  function seedHomepage() {
    const items = [
      ...Array.from({ length: 9 }, (_, i) => item("ai", { score: 90 - i })),
      item("work", { score: 95, url: "https://example.org/dup" }),
    ];
    store.homepageData = { data: page(items), timestamp: at(6, 8).toISOString() };
    return items;
  }

  test("sends 8 articles and a front page, then archives yesterday's front page", async () => {
    seedHomepage();
    store.morningPush = { date: "2026-11-15", status: "done", trigger: "schedule", at: new Date(2026, 10, 15, 6, 20).toISOString(), attempts: 1, frontPageIds: [42] };

    const r = await runMorningPush("schedule", at(6, 20));
    expect(r.status).toBe("done");
    expect(r.articles).toHaveLength(8);
    expect(r.articles!.map((a) => a.result)).toEqual(["duplicate", ...Array(7).fill("queued")]);
    const upload = calls.find((c) => c.path === "/api/entries/upload")!;
    expect(upload.body).toMatchObject({ name: "front-page-2026-11-16.epub", title: "Front page · Mon Nov 16 06:20", tags: "front-page" });
    // The local copy for the assistant went to the Intake Triage server, with the wallabag ids.
    expect(r.localCopy).toBe("written");
    expect(editionCopies).toHaveLength(1);
    expect(editionCopies[0]).toMatchObject({ date: TODAY, madeAt: at(6, 20).toISOString() });
    expect(editionCopies[0]!.markdown).toContain(`front_page_wallabag_id: ${r.frontPageIds![0]}`);
    expect(editionCopies[0]!.markdown).toContain(`## Headlines (${r.headlines})`);
    for (const a of r.articles!) expect(editionCopies[0]!.markdown).toContain(a.url);
    expect(r.articles!.filter((a) => a.result === "queued").every((a) => typeof a.id === "number")).toBe(true);
    expect(store.morningEditionOutbox).toBeUndefined();
    expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/entries/42", body: { archive: 1 } });
    expect(r.archived).toEqual([42]);
    expect(r.frontPageIds).toHaveLength(1);
    expect(r.triageCards).toBe(3);
    expect(r.triageFile).toBe("2026-11-16-intake.md");
    // The articles are remembered so tomorrow doesn't resend them; only the ones it created carry an id.
    const mem = Object.values(store.morningPushSent as Record<string, { date: string; id?: number }>);
    expect(mem.map((e) => e.date)).toEqual(Array(8).fill(TODAY));
    expect(mem.filter((e) => e.id !== undefined)).toHaveLength(7); // the duplicate isn't ours
  });

  test("archives its own articles once they're 7 days old, never a duplicate or someone else's entry", async () => {
    seedHomepage();
    store.morningPushSent = {
      "https://example.org/old-ours": { date: "2026-11-09", id: 7 }, // exactly 7 days: archive
      "https://example.org/newer-ours": { date: "2026-11-10", id: 8 }, // 6 days: keep
      "https://example.org/old-dup": { date: "2026-11-01" }, // was already saved: never archive
      "https://example.org/legacy": "2026-11-01", // first-format record: no id, never archive
      "https://example.org/done": { date: "2026-11-05", id: 9, archived: true },
    };
    const r = await runMorningPush("schedule", at(6, 20));
    expect(r.status).toBe("done");
    expect(r.articlesArchived).toBe(1);
    const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.path);
    expect(patches).toEqual(["/api/entries/7"]);
    const mem = store.morningPushSent as Record<string, unknown>;
    expect(mem["https://example.org/old-ours"]).toEqual({ date: "2026-11-09", id: 7, archived: true });
    expect(mem["https://example.org/newer-ours"]).toEqual({ date: "2026-11-10", id: 8 });
  });

  test("a failed article archive stays pending and doesn't fail the edition", async () => {
    const now = at(6, 20);
    const sent = { a: { date: "2026-11-01", id: 1 }, b: { date: "2026-11-02", id: 2 } };
    const { sent: next, archived } = await archiveOldArticles(sent, now, async (id) => {
      if (id === 1) throw new Error("502");
    });
    expect(archived).toBe(1);
    expect(next.a).toEqual({ date: "2026-11-01", id: 1 });
    expect(next.b).toEqual({ date: "2026-11-02", id: 2, archived: true });
  });

  test("memory: kept 14 days, pending archives up to 30", () => {
    const now = at(6, 20);
    const pruned = pruneSent(
      {
        recent: { date: "2026-11-10" },
        oldDone: { date: "2026-10-20", id: 1, archived: true },
        oldPending: { date: "2026-10-20", id: 2 },
        ancientPending: { date: "2026-10-10", id: 3 },
        oldLegacy: "2026-10-20",
      },
      now,
    );
    expect(Object.keys(pruned).sort()).toEqual(["oldPending", "recent"]);
  });

  test("a failed upload keeps yesterday's id for the retry, which archives it", async () => {
    seedHomepage();
    store.morningPush = { date: "2026-11-15", status: "done", trigger: "schedule", at: new Date(2026, 10, 15, 6, 20).toISOString(), attempts: 1, frontPageIds: [42] };
    uploadFails = true;
    const failed = await runMorningPush("schedule", at(6, 20));
    expect(failed.status).toBe("failed");
    expect(failed.frontPageIds).toEqual([42]);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    uploadFails = false;
    calls = [];
    const retry = await runMorningPush("schedule", at(6, 25));
    expect(retry.status).toBe("done");
    expect(retry.attempts).toBe(2);
    expect(retry.archived).toEqual([42]);
    // Same articles as the first try: today's own sends don't count as "already sent".
    expect(retry.articles).toHaveLength(8);
  });

  test("Send now after the morning's edition replaces today's front page", async () => {
    seedHomepage();
    const first = await runMorningPush("schedule", at(6, 20));
    const firstId = first.frontPageIds![0]!;
    const again = await runMorningPush("manual", at(9, 0));
    expect(again.archived).toEqual([firstId]);
    expect(again.frontPageIds).toHaveLength(1);
    expect(localDate(at(9, 0))).toBe(TODAY);
  });

  test("Intake Triage down: the edition still goes, the copy waits, and the heartbeat writes the latest one", async () => {
    seedHomepage();
    triageDown = true;
    const first = await runMorningPush("schedule", at(6, 20));
    expect(first.status).toBe("done");
    expect(first.triageFile).toBeNull();
    expect(first.localCopy).toBe("waiting");
    const again = await runMorningPush("manual", at(9, 0));
    expect(again.localCopy).toBe("waiting");
    // Only the latest edition waits.
    expect((store.morningEditionOutbox as { madeAt: string }).madeAt).toBe(at(9, 0).toISOString());
    expect(await flushEditionOutbox()).toBe("waiting");
    triageDown = false;
    expect(await flushEditionOutbox()).toBe("written");
    expect(editionCopies.map((c) => c.madeAt)).toEqual([at(9, 0).toISOString()]);
    expect(editionCopies[0]!.markdown).toContain("trigger: send-now");
    expect(store.morningEditionOutbox).toBeUndefined();
    expect(await flushEditionOutbox()).toBe("written");
    expect(editionCopies).toHaveLength(1);
  });

  test("no homepage yet is a failure, not a crash", async () => {
    const r = await runMorningPush("schedule", at(6, 20));
    expect(r.status).toBe("failed");
    expect(r.error).toContain("no homepage");
  });
});

describe("delivery to Readwise Reader (iPad), against a fake Reader API", () => {
  type Call = { method: string; path: string; auth?: string; body: Record<string, unknown> };
  let calls: Call[] = [];
  let nextId = 1;

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    calls = [];
    nextId = 1;
    store.koboConfig = { service: "readwise", readwiseToken: "rw-test-token" };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.host === "127.0.0.1:8766") {
        if (url.pathname === "/api/newtab/edition") return Response.json({ ok: true, written: true });
        return Response.json(triageFile());
      }
      expect(url.host).toBe("readwise.io");
      const auth = (init?.headers as Record<string, string>).Authorization;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, path: url.pathname, auth, body });
      if (url.pathname === "/api/v3/save/" && method === "POST") {
        const dup = String(body.url).endsWith("/dup");
        return Response.json({ id: `doc${nextId++}`, url: "https://read.readwise.io/new/read/x" }, { status: dup ? 200 : 201 });
      }
      const m = url.pathname.match(/^\/api\/v3\/update\/([^/]+)\/$/);
      if (m && method === "PATCH") return m[1] === "gone" ? new Response(null, { status: 404 }) : Response.json({ id: m[1] });
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
  });

  test("articles by URL, the front page as linked HTML, yesterday's front page archived", async () => {
    store.homepageData = {
      data: page([...Array.from({ length: 9 }, (_, i) => item("ai", { score: 90 - i })), item("work", { score: 95, url: "https://example.org/dup" })]),
      timestamp: at(6, 8).toISOString(),
    };
    store.morningPush = { date: "2026-11-15", status: "done", trigger: "schedule", at: new Date(2026, 10, 15, 6, 20).toISOString(), attempts: 1, frontPageIds: ["docOld"] };

    const r = await runMorningPush("schedule", at(6, 20));
    expect(r.status).toBe("done");
    expect(calls.every((c) => c.auth === "Token rw-test-token")).toBe(true);

    const saves = calls.filter((c) => c.path === "/api/v3/save/");
    const articleSaves = saves.filter((c) => c.body.html === undefined);
    expect(articleSaves).toHaveLength(8);
    expect(articleSaves.every((c) => (c.body.tags as string[]).includes("front-page-kit"))).toBe(true);
    expect(r.articles!.map((a) => a.result)).toEqual(["duplicate", ...Array(7).fill("queued")]);
    expect(r.articles!.filter((a) => a.result === "queued").every((a) => typeof a.id === "string")).toBe(true);

    const front = saves.find((c) => c.body.html !== undefined)!;
    expect(front.body).toMatchObject({ title: "Front page · Mon Nov 16 06:20", should_clean_html: false, category: "article" });
    expect(String(front.body.url)).toBe(`https://front-page.invalid/${encodeURIComponent(at(6, 20).toISOString())}`);
    const html = String(front.body.html);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("[Reader]");
    expect(html).toContain("are in your Reader library");
    expect(html).toContain('<a href="https://example.org/');
    expect(html).toContain("T1.");

    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/api/v3/update/docOld/", body: { location: "archive" } });
    expect(r.archived).toEqual(["docOld"]);
    expect(r.frontPageIds).toEqual([r.frontPageIds![0]]);
    expect(typeof r.frontPageIds![0]).toBe("string");
  });

  test("a document Reader no longer has counts as archived; string ids age out like numbers", async () => {
    const swept = await archiveOldArticles(
      { "https://example.org/a": { date: "2026-11-09", id: "gone" }, "https://example.org/b": { date: "2026-11-09", id: "doc9" } },
      at(6, 20),
    );
    expect(swept.archived).toBe(2);
    expect(calls.map((c) => c.path)).toEqual(["/api/v3/update/gone/", "/api/v3/update/doc9/"]);
  });

  test("the HTML front page links only http(s) URLs and escapes them", () => {
    const items = [item("ai", { url: "https://example.org/a?x=1&y=<2>" }), item("ai", { url: "javascript:alert(1)" })];
    const input = {
      date: TODAY,
      dayLabel: "Mon Nov 16",
      homepageBuilt: at(6, 8).toISOString(),
      madeAt: at(6, 20).toISOString(),
      headlines: numberHeadlines(arrangePage(page(items), {}, at(6, 8).toISOString(), at(6, 30)), []),
      calendar: [],
      triage: null,
    };
    const html = frontPageHtml(input);
    expect(html).toContain('<a href="https://example.org/a?x=1&amp;y=&lt;2&gt;">');
    expect(html).not.toContain("javascript:");
    // The Kobo EPUB body stays plain text.
    expect(frontPageBody(input)).not.toContain("<a href");
  });
});
