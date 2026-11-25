/**
 * Seen and read (packages/agent-core/seen.ts): what counts as seen, what
 * leaves the page, and how channel shares are filled (2026-10-29).
 */
import { describe, expect, test } from "bun:test";
import {
  CHANNELS,
  arrangePage,
  buildKickoffMessage,
  itemState,
  pruneSeen,
  recordClicked,
  recordShown,
  seenForPrompt,
  seenKey,
  validateHomepageData,
  type ChannelKey,
  type HomepageData,
  type NewsItem,
} from "@homepage/agent-core";

const NOW = new Date("2026-10-29T16:00:00Z");
const BUILD_1 = "2026-10-28T13:00:00.000Z";
const BUILD_2 = "2026-10-29T13:00:00.000Z";

let n = 0;
function item(channel: ChannelKey, over: Partial<NewsItem> = {}): NewsItem {
  n++;
  return {
    id: `${channel}-${n}`,
    channel,
    headline: `${channel} story ${n}`,
    url: `https://example.org/${channel}/${n}`,
    source: "Src",
    publishedAt: "2026-10-29T10:00:00.000Z",
    score: 50,
    touches: [],
    urgent: false,
    chips: [],
    ...over,
  };
}
function page(items: NewsItem[], lead = items[0].id): HomepageData {
  return { version: 1, lead, items, calendar: [], github: { onYou: [], following: [] }, alsoSeen: "", sources: [] };
}
const share = (k: ChannelKey) => CHANNELS.find((c) => c.key === k)!.slots;
const shownIn = (view: ReturnType<typeof arrangePage>, k: ChannelKey) =>
  view.channels.find((c) => c.key === k)!.fresh.length + [view.lead, ...view.urgent].filter((i) => i?.channel === k).length;

describe("seen and read", () => {
  test("an item is new on the page it first appears on, seen from the next build", () => {
    const story = item("field", { url: "https://www.genomeweb.com/story?utm_source=x#top" });
    const store = recordShown({}, [story], BUILD_1);
    expect(itemState(story, store, BUILD_1)).toBe("new");
    expect(itemState(story, store, BUILD_2)).toBe("seen");
    // Same story, cleaned-up link, new item id: still seen.
    expect(itemState({ url: "https://www.genomeweb.com/story" }, store, BUILD_2)).toBe("seen");
  });

  test("clicked is done; an update brings a story back once", () => {
    const it = item("ai");
    let store = recordClicked(recordShown({}, [it], BUILD_1), it, "2026-10-28T14:00:00Z");
    expect(itemState(it, store, BUILD_2)).toBe("done");
    const updated = { ...it, update: "v2 released with the fix" };
    expect(itemState(updated, store, BUILD_2)).toBe("new");
    store = recordShown(store, [updated], BUILD_2);
    expect(itemState(updated, store, "2026-10-30T01:00:00.000Z")).toBe("seen");
    expect(seenKey(it.url, " V2 released with the fix")).toBe(seenKey(it.url, "v2 released with the fix"));
  });

  test("memory lasts a week; the kickoff carries it", () => {
    const old = item("ai");
    const recent = item("ai", { headline: "Recent one" });
    let store = recordShown({}, [old], "2026-10-20T13:00:00.000Z");
    store = recordClicked(recordShown(store, [recent], BUILD_1), recent, BUILD_1);
    expect(Object.keys(pruneSeen(store, NOW))).toEqual([seenKey(recent.url)]);
    const lines = seenForPrompt(store, NOW);
    expect(lines).toEqual([`- read: Recent one — ${seenKey(recent.url)}`]);
    const msg = buildKickoffMessage({ now: NOW, seen: lines });
    expect(msg).toContain("Seen by the reader");
    expect(msg).toContain("Recent one");
  });

  test("validator keeps update and allows ranked extras beyond a share", () => {
    const many = Array.from({ length: share("ai") + 12 }, (_, i) => item("ai", { score: 90 - i, update: i === 0 ? "now GA" : undefined }));
    const { data } = validateHomepageData(JSON.stringify(page(many)), { now: NOW });
    expect(data.items.length).toBe(share("ai") + 8);
    expect(data.items.find((i) => i.update)?.update).toBe("now GA");
  });
});

describe("channel shares (guaranteed, then redistributed)", () => {
  const fill = (k: ChannelKey, count: number, score = 50) => Array.from({ length: count }, (_, i) => item(k, { score: score - i }));

  test("field with 2 new items gives its other 4 slots to channels with more", () => {
    const items = [...fill("ai", 25, 90), ...fill("work", share("work")), ...fill("field", 2), ...fill("career", share("career"))];
    const view = arrangePage(page(items), {}, BUILD_2, NOW);
    expect(shownIn(view, "field")).toBe(2);
    expect(shownIn(view, "ai")).toBe(share("ai") + (share("field") - 2));
    const total = view.channels.reduce((s, c) => s + c.fresh.length, 0) + 1 + view.urgent.length;
    expect(total).toBe(CHANNELS.reduce((s, c) => s + c.slots, 0));
  });

  test("field with 6 new items keeps all 6 even when AI has 25 new", () => {
    const items = [...fill("ai", 25, 99), ...fill("work", share("work")), ...fill("field", 6, 20), ...fill("career", share("career"))];
    const view = arrangePage(page(items), {}, BUILD_2, NOW);
    expect(shownIn(view, "field")).toBe(6);
    expect(shownIn(view, "ai")).toBe(share("ai"));
  });

  test("seen items don't hold a slot; they collapse, and done items leave", () => {
    const sci = fill("field", 6);
    const store = recordClicked(recordShown({}, sci.slice(0, 4), BUILD_1), sci[0], BUILD_1);
    const items = [...fill("ai", 20, 90), ...sci];
    const view = arrangePage(page(items), store, BUILD_2, NOW);
    const field = view.channels.find((c) => c.key === "field")!;
    expect(field.fresh.map((i) => i.id)).toEqual(sci.slice(4).map((i) => i.id));
    expect(field.seen.map((i) => i.id)).toEqual(sci.slice(1, 4).map((i) => i.id));
    // Work and career have nothing, field only 2 new: AI's 20 all fit in the freed slots.
    expect(shownIn(view, "ai")).toBe(20);
  });

  test("a seen lead is replaced by the best new item; urgent stays until clicked", () => {
    const oldLead = item("field", { score: 99 });
    const flaw = item("work", { urgent: true, action: { what: "patch" }, score: 95 });
    const fresh = item("ai", { score: 70 });
    let store = recordShown({}, [oldLead, flaw], BUILD_1);
    let view = arrangePage(page([oldLead, flaw, fresh], oldLead.id), store, BUILD_2, NOW);
    expect(view.lead?.id).toBe(fresh.id);
    expect(view.urgent.map((i) => i.id)).toEqual([flaw.id]);
    store = recordClicked(store, flaw, BUILD_2);
    view = arrangePage(page([oldLead, flaw, fresh], oldLead.id), store, BUILD_2, NOW);
    expect(view.urgent).toEqual([]);
  });
});
