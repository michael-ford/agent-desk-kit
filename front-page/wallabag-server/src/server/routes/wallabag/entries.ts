import { Hono } from "hono";
import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { articles } from "../../../db/schema.js";
import { wallabagAuth } from "./auth.js";
import { toWallabagEntry } from "./types.js";
import { config } from "../../../config/index.js";
import { articleQueue } from "../../../queue/index.js";
import { canonicalize } from "../../../bot/handlers/url.js";
import { logger } from "../../../logger.js";

export const entriesRoute = new Hono();

// Strip .json suffix from paths so /api/entries/1.json → /api/entries/1
// KOReader sends .json suffix on all Wallabag API calls
entriesRoute.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.endsWith(".json")) {
    url.pathname = url.pathname.slice(0, -5);
    const newReq = new Request(url.toString(), c.req.raw);
    return entriesRoute.fetch(newReq, c.env);
  }
  await next();
});

// All entry routes require auth
entriesRoute.use("/api/entries/*", wallabagAuth);
entriesRoute.use("/api/entries", wallabagAuth);

// GET /api/entries — List articles
entriesRoute.get("/api/entries", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const perPage = Math.max(1, Math.min(100, parseInt(c.req.query("perPage") ?? "30", 10) || 30));
  const archive = c.req.query("archive") === "1" ? 1 : 0;

  const conditions = and(
    eq(articles.status, "done"),
    eq(articles.isArchived, archive),
  );

  const items = db
    .select()
    .from(articles)
    .where(conditions)
    .limit(perPage)
    .offset((page - 1) * perPage)
    .all();

  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(articles)
    .where(conditions)
    .get();

  const total = countResult?.count ?? 0;

  return c.json({
    _embedded: { items: items.map(toWallabagEntry) },
    page,
    pages: Math.ceil(total / perPage) || 1,
    limit: perPage,
    total,
  });
});

// POST /api/entries/upload — Upload an EPUB file directly
entriesRoute.post("/api/entries/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  const title = formData.get("title")?.toString() ?? "Untitled";
  const author = formData.get("author")?.toString() ?? null;
  const tags = formData.get("tags")?.toString() ?? null;

  if (!file || !(file instanceof File)) {
    return c.json({ error: "file is required (multipart field 'file')" }, 400);
  }

  if (!file.name.endsWith(".epub")) {
    return c.json({ error: "file must be an .epub" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const timestamp = Date.now();
  const safeName = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const filename = `${safeName}-${timestamp}.epub`;
  const booksDir = `${config.EPUB_STORAGE_PATH}/books`;
  const epubPath = `${booksDir}/${filename}`;

  await mkdir(booksDir, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(epubPath, buffer);

  const result = db.insert(articles).values({
    url: `epub://upload/${filename}`,
    title,
    author,
    status: "done",
    isArchived: 0,
    content: null,
    tags: tags ? JSON.stringify(tags.split(",").map((t: string) => t.trim())) : null,
    epubPath,
    chatId: 0,
    createdAt: now,
    updatedAt: now,
  }).returning().get();

  return c.json(toWallabagEntry(result), 201);
});

// POST /api/entries — Save a URL (standard Wallabag API; used by the AI newtab
// "send to Kobo" button and any Wallabag client). Queues the same process-url
// job as the Telegram bot; completion is reported to the first allowed user.
entriesRoute.post("/api/entries", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  const body: Record<string, unknown> = contentType.includes("application/json")
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody();
  const url = typeof body.url === "string" ? body.url.trim() : "";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return c.json({ error: "invalid_url" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return c.json({ error: "invalid_url" }, 400);
  }

  const canonical = canonicalize(url);
  const existing = db.select().from(articles).where(eq(articles.canonicalUrl, canonical)).get();
  if (existing) return c.json(toWallabagEntry(existing), 200);

  const chatId = config.ALLOWED_USER_IDS[0];
  const now = Math.floor(Date.now() / 1000);
  const result = db.insert(articles).values({
    url,
    canonicalUrl: canonical,
    chatId,
    createdAt: now,
    updatedAt: now,
  }).returning().get();

  await articleQueue.add("process-url", { articleId: result.id, url, chatId });
  logger.info({ url, articleId: result.id }, "URL queued via API");
  return c.json(toWallabagEntry(result), 201);
});

// GET /api/entries/:id/export.epub — Download EPUB
entriesRoute.get("/api/entries/:id/export.epub", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "not_found" }, 404);

  const article = db.select().from(articles).where(eq(articles.id, id)).get();
  if (!article || !article.epubPath) {
    return c.json({ error: "not_found" }, 404);
  }

  let data: Buffer;
  try {
    data = await readFile(article.epubPath);
  } catch {
    return c.json({ error: "not_found" }, 404);
  }

  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${id}.epub"`,
    },
  });
});

// PATCH /api/entries/:id — Update article (archive/unarchive)
entriesRoute.patch("/api/entries/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "not_found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  if (body.archive === 1 || body.archive === 0) {
    db.update(articles)
      .set({ isArchived: body.archive, updatedAt: now })
      .where(eq(articles.id, id))
      .run();
  }

  const updated = db.select().from(articles).where(eq(articles.id, id)).get();
  if (!updated) return c.json({ error: "not_found" }, 404);

  return c.json(toWallabagEntry(updated));
});

// DELETE /api/entries/:id — Delete article
entriesRoute.delete("/api/entries/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "not_found" }, 404);

  const article = db.select().from(articles).where(eq(articles.id, id)).get();

  // Best-effort delete EPUB file
  if (article?.epubPath) {
    try {
      await unlink(article.epubPath);
    } catch {
      // ignore
    }
  }

  db.delete(articles).where(eq(articles.id, id)).run();

  return c.json({ id });
});
