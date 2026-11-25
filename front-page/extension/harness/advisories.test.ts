/**
 * Advisory sessions: the world list's `[slug]` syntax, the validator's advisory
 * field, which items qualify, and the client (apps/extension/lib/advisories.ts)
 * with a fake chrome.storage and fetch. Nothing here reaches the real server.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildKickoffMessage,
  parseWorldList,
  validateHomepageData,
  type HomepageData,
  type NewsItem,
} from "@homepage/agent-core";

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
    },
  },
};

type Mode = "down" | "ok" | "refuse" | "trigger-fails";
let mode: Mode = "ok";
const posted: Array<Record<string, unknown>> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  expect(String(input)).toBe("http://127.0.0.1:8766/api/newtab/advisory");
  if (mode === "down") throw new TypeError("Failed to fetch");
  if (mode === "refuse") return Response.json({ ok: false, error: "unknown project" }, { status: 400 });
  if (mode === "trigger-fails") return Response.json({ ok: false, error: "the assistant trigger failed (exit 1)" }, { status: 502 });
  posted.push(JSON.parse(String(init?.body)));
  return Response.json({ ok: true, status: "dry-run" });
}) as typeof fetch;

const { advisoriesIn, flushAdvisoryOutbox, reportAdvisories } = await import("../apps/extension/lib/advisories");

const WORLD_MD = `---
title: t
---

# World

## Deployments

- Shop WordPress [example-shop]: wordpress, php
- Trades site [trades-site]: vercel, next.js
- Booking app [booking-app]: railway

## Dependencies

- Python: pypi, uv
`;
const WORLD = parseWorldList(WORLD_MD);

describe("world list [slug]", () => {
  test("a bracketed slug names the project and stays out of the label", () => {
    expect(WORLD.find((e) => e.label === "Shop WordPress")).toEqual({
      group: "Deployments",
      label: "Shop WordPress",
      terms: ["wordpress", "php"],
      project: "example-shop",
    });
    expect(WORLD.find((e) => e.label === "Python")!.project).toBeUndefined();
  });

  test("the model's copy of the list has no slugs", () => {
    const kickoff = buildKickoffMessage({ now: new Date("2026-10-27T16:00:00Z"), worldList: WORLD_MD });
    expect(kickoff).toContain("- Shop WordPress: wordpress, php");
    expect(kickoff).not.toContain("example-shop");
  });
});

const item = (over: Partial<NewsItem> & { id: string }): NewsItem => ({
  channel: "work",
  headline: `Headline ${over.id}`,
  url: `https://example.org/${over.id}`,
  source: "Src",
  publishedAt: "2026-10-27T10:00:00Z",
  score: 80,
  touches: [],
  urgent: false,
  chips: [],
  ...over,
});
const FILLER = Array.from({ length: 5 }, (_, i) => item({ id: `f${i}`, channel: "ai" }));

describe("validator: advisory", () => {
  const validate = (advisory: unknown) =>
    validateHomepageData(JSON.stringify({ version: 1, lead: "", items: [{ ...item({ id: "a" }), advisory }, ...FILLER] }), {
      now: new Date("2026-10-27T16:00:00Z"),
    });

  test("kept and lowercased when the id and severity are good", () => {
    const { data } = validate({ id: "CVE-2026-12345", severity: "Critical" });
    expect(data.items.find((i) => i.id === "a")!.advisory).toEqual({ id: "cve-2026-12345", severity: "critical" });
  });

  test("dropped with a warning when malformed; the item survives", () => {
    for (const bad of [{ id: "", severity: "high" }, { id: "x y", severity: "high" }, { id: "cve-1", severity: "severe" }]) {
      const { data, warnings } = validate(bad);
      expect(data.items.find((i) => i.id === "a")!.advisory).toBeUndefined();
      expect(warnings.some((w) => w.includes("advisory"))).toBe(true);
    }
  });
});

const page = (items: NewsItem[]): HomepageData => ({
  version: 1,
  lead: "f0",
  items: [...items, ...FILLER],
  calendar: [],
  github: { onYou: [], following: [] },
  alsoSeen: "",
  sources: [],
});
const PHP = item({
  id: "php",
  touches: ["Shop WordPress", "Python"],
  urgent: true,
  action: { what: "Check the host runs PHP 8.5.12+", by: "2026-10-27" },
  advisory: { id: "php2shell", severity: "critical" },
});

describe("advisoriesIn", () => {
  test("critical and high with a project qualify; projects deduped, labels without a slug ignored", () => {
    const next = item({
      id: "next",
      touches: ["Trades site", "Booking app", "Trades site"],
      advisory: { id: "cve-2026-1", severity: "high" },
    });
    expect(advisoriesIn(page([PHP, next]), WORLD)).toEqual([
      {
        id: "php2shell",
        severity: "critical",
        projects: ["example-shop"],
        url: "https://example.org/php",
        headline: "Headline php",
        action: "Check the host runs PHP 8.5.12+",
      },
      { id: "cve-2026-1", severity: "high", projects: ["trades-site", "booking-app"], url: "https://example.org/next", headline: "Headline next" },
    ]);
  });

  test("medium, no advisory, or no project: nothing", () => {
    const items = [
      item({ id: "m", touches: ["Shop WordPress"], advisory: { id: "cve-2026-2", severity: "medium" } }),
      item({ id: "n", touches: ["Shop WordPress"], urgent: true, action: { what: "x" } }),
      item({ id: "p", touches: ["Python"], advisory: { id: "cve-2026-3", severity: "critical" } }),
    ];
    expect(advisoriesIn(page(items), WORLD)).toEqual([]);
  });
});

describe("reportAdvisories", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    posted.length = 0;
    mode = "ok";
  });

  test("sent once per (advisory, project) across rebuilds", async () => {
    await reportAdvisories(page([PHP]), WORLD);
    await reportAdvisories(page([PHP]), WORLD);
    expect(posted.map((p) => [p.id, p.projects])).toEqual([["php2shell", ["example-shop"]]]);
    // A later build that adds a project sends only the new one.
    await reportAdvisories(page([{ ...PHP, touches: ["Shop WordPress", "Booking app"] }]), WORLD);
    expect(posted.map((p) => p.projects)).toEqual([["example-shop"], ["booking-app"]]);
  });

  test("waits in the outbox while the server is down, and isn't queued twice", async () => {
    mode = "down";
    await reportAdvisories(page([PHP]), WORLD);
    await reportAdvisories(page([PHP]), WORLD);
    expect(store.advisoryOutbox).toHaveLength(1);
    mode = "ok";
    await flushAdvisoryOutbox();
    expect(posted).toHaveLength(1);
    expect(store.advisoryOutbox).toEqual([]);
  });

  test("a trigger failure is retried; a refusal is dropped", async () => {
    mode = "trigger-fails";
    await reportAdvisories(page([PHP]), WORLD);
    expect(store.advisoryOutbox).toHaveLength(1);
    mode = "refuse";
    await flushAdvisoryOutbox();
    expect(store.advisoryOutbox).toEqual([]);
    expect(posted).toHaveLength(0);
  });
});
