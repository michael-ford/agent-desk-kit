import { Hono } from "hono";
import { z } from "zod";
import { config } from "../../../config/index.js";
import { db } from "../../../db/client.js";
import { articles } from "../../../db/schema.js";
import { articleQueue } from "../../../queue/index.js";
import { logger } from "../../../logger.js";

const InboundEmailSchema = z.object({
  from: z.string(),
  subject: z.string(),
  htmlBody: z.string().min(1),
  textBody: z.string().optional(),
  date: z.string().optional(),
  secret: z.string(),
});

export const emailRoute = new Hono();

emailRoute.post("/api/email/inbound", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = InboundEmailSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", details: parsed.error.issues }, 400);
  }

  if (parsed.data.secret !== config.EMAIL_WEBHOOK_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { from, subject, htmlBody, date } = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const syntheticUrl = `email://${from}/${now}`;

  const result = db
    .insert(articles)
    .values({
      url: syntheticUrl,
      title: subject,
      status: "queued",
      chatId: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const articleId = Number(result.lastInsertRowid);

  await articleQueue.add("process-email", {
    articleId,
    subject,
    from,
    htmlBody,
    date,
  });

  logger.info({ articleId, from, subject }, "Email ingested via webhook");

  return c.json({ ok: true, articleId });
});
