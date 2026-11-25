import type { XPost } from "@homepage/agent-core";

/**
 * X reads via twitterapi.io:
 * the accounts the reader follows (cached a day), then batched `from:` searches.
 * Read-only; never posts, likes or follows.
 */
const BASE = "https://api.twitterapi.io";
const KEY = "xConfig";
const FOLLOWINGS_CACHE = "xFollowingsCache";
const BATCH = 12; // handles per search query
const MAX_CALLS = 25;

export interface XConfig {
  apiKey: string;
  handle: string;
}

export async function loadXConfig(): Promise<XConfig> {
  const s = await browser.storage.local.get(KEY);
  return { apiKey: "", handle: "", ...(s[KEY] as Partial<XConfig> | undefined) };
}

export async function saveXConfig(config: XConfig): Promise<void> {
  await browser.storage.local.set({ [KEY]: config });
  await browser.storage.local.remove(FOLLOWINGS_CACHE);
}

interface Ctx {
  apiKey: string;
  calls: number;
}

async function get(ctx: Ctx, path: string, params: Record<string, string>): Promise<any> {
  if (ctx.calls >= MAX_CALLS) throw new Error(`call ceiling (${MAX_CALLS}) reached`);
  ctx.calls++;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
      headers: { "X-API-Key": ctx.apiKey },
    });
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    return res.json();
  }
}

async function followings(ctx: Ctx, handle: string): Promise<string[]> {
  const cached = (await browser.storage.local.get(FOLLOWINGS_CACHE))[FOLLOWINGS_CACHE] as
    | { handle: string; at: number; users: string[] }
    | undefined;
  if (cached && cached.handle === handle && Date.now() - cached.at < 24 * 3600 * 1000) return cached.users;

  const users: string[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const params: Record<string, string> = { userName: handle, pageSize: "200" };
    if (cursor) params.cursor = cursor;
    const data = await get(ctx, "/twitter/user/followings", params);
    for (const u of data.followings ?? []) if (u.userName) users.push(u.userName);
    cursor = data.next_cursor ?? "";
    if (!data.has_next_page || !cursor) break;
  }
  await browser.storage.local.set({ [FOLLOWINGS_CACHE]: { handle, at: Date.now(), users } });
  return users;
}

function toPost(t: any): XPost | null {
  if (!t?.url || !t?.author?.userName) return null;
  const links = ((t.entities?.urls ?? []) as Array<{ expanded_url?: string }>)
    .map((u) => u.expanded_url)
    .filter((u): u is string => Boolean(u));
  return {
    author: t.author.userName,
    authorName: t.author.name ?? t.author.userName,
    text: String(t.text ?? "").slice(0, 280),
    url: t.url,
    createdAt: t.createdAt,
    likes: t.likeCount ?? 0,
    retweets: t.retweetCount ?? 0,
    replies: t.replyCount ?? 0,
    quoted: t.quoted_tweet?.text ? String(t.quoted_tweet.text).slice(0, 160) : undefined,
    links,
  };
}

export async function getXPosts(args: { days: number; minLikes: number }) {
  const cfg = await loadXConfig();
  const errors: string[] = [];
  if (!cfg.apiKey) {
    return { posts: [], accountsSearched: 0, calls: 0, errors: ["twitterapi.io key not set in Settings"] };
  }
  const ctx: Ctx = { apiKey: cfg.apiKey, calls: 0 };
  const users = await followings(ctx, cfg.handle);
  const since = new Date(Date.now() - args.days * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const byUrl = new Map<string, XPost>();
  for (let i = 0; i < users.length; i += BATCH) {
    const from = users.slice(i, i + BATCH).map((u) => `from:${u}`).join(" OR ");
    const query = `(${from}) since:${since} min_faves:${args.minLikes} -filter:replies`;
    try {
      const data = await get(ctx, "/twitter/tweet/advanced_search", { query, queryType: "Top" });
      for (const t of data.tweets ?? []) {
        const p = toPost(t);
        if (p) byUrl.set(p.url, p);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      if (String(err).includes("ceiling")) break;
    }
  }
  const posts = [...byUrl.values()].sort((a, b) => b.likes - a.likes).slice(0, 60);
  return { posts, accountsSearched: users.length, calls: ctx.calls, errors };
}
