/**
 * The "comment for the assistant" client (apps/extension/lib/assistant.ts) with a fake
 * chrome.storage and fetch: queued when the Intake Triage server answers, kept
 * in an outbox while it's down, flushed in order when it's back, and a comment
 * the server refuses is dropped instead of retried forever.
 */
import { beforeEach, describe, expect, test } from "bun:test";

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
const posted: Array<{ url: string; headline: string; prompt: string }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  expect(String(input)).toBe("http://127.0.0.1:8766/api/newtab/comment");
  expect((init?.headers as Record<string, string>)["X-Intake-Triage"]).toBe("1");
  if (mode === "down") throw new TypeError("Failed to fetch");
  if (mode === "refuse") return Response.json({ ok: false, error: "url must be an http(s) URL" }, { status: 400 });
  if (mode === "trigger-fails") return Response.json({ ok: false, error: "the assistant trigger failed (exit 1)" }, { status: 502 });
  posted.push(JSON.parse(String(init?.body)));
  return Response.json({ ok: true, queued: true });
}) as typeof fetch;

const { flushCommentOutbox, loadCommentStates, sendComment } = await import("../apps/extension/lib/assistant");

const c = (n: number) => ({ url: `https://example.org/${n}`, headline: `Story ${n}`, prompt: `  prompt ${n}  ` });

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  posted.length = 0;
  mode = "ok";
});

describe("comment for the assistant", () => {
  test("queued when the server answers; the prompt is trimmed", async () => {
    expect(await sendComment(c(1))).toBe("queued");
    expect(posted).toEqual([{ url: "https://example.org/1", headline: "Story 1", prompt: "prompt 1" }]);
    expect((await loadCommentStates())["https://example.org/1"].status).toBe("queued");
  });

  test("a failing trigger or bad request throws instead of pretending", async () => {
    mode = "trigger-fails";
    await expect(sendComment(c(1))).rejects.toThrow(/trigger failed/);
    expect(store.commentOutbox).toBeUndefined();
  });

  test("server down: kept in order in the outbox, flushed when it's back", async () => {
    mode = "down";
    expect(await sendComment(c(1))).toBe("waiting");
    expect(await sendComment(c(2))).toBe("waiting");
    expect((await loadCommentStates())["https://example.org/2"].status).toBe("waiting");

    await flushCommentOutbox(); // still down: nothing lost
    expect((store.commentOutbox as unknown[]).length).toBe(2);

    mode = "ok";
    await flushCommentOutbox();
    expect(posted.map((p) => p.headline)).toEqual(["Story 1", "Story 2"]);
    expect(store.commentOutbox).toEqual([]);
    expect((await loadCommentStates())["https://example.org/1"].status).toBe("queued");
  });

  test("a refused comment is dropped; a failing trigger keeps the rest for the next heartbeat", async () => {
    mode = "down";
    await sendComment(c(1));
    await sendComment(c(2));
    mode = "refuse";
    await flushCommentOutbox();
    expect(store.commentOutbox).toEqual([]);

    mode = "down";
    await sendComment(c(3));
    mode = "trigger-fails";
    await flushCommentOutbox();
    expect((store.commentOutbox as unknown[]).length).toBe(1);
  });
});
