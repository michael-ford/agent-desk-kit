import { QueueEvents } from "bullmq";
import { eq, desc } from "drizzle-orm";
import type { Bot } from "grammy";
import { redis } from "./index.js";
import { db } from "../db/client.js";
import { articles } from "../db/schema.js";
import { logger } from "../logger.js";

export function setupQueueEvents(bot: Bot): QueueEvents {
  const queueEvents = new QueueEvents("article-processing", {
    connection: redis,
  });

  queueEvents.on("completed", async ({ jobId, returnvalue }) => {
    try {
      const result = typeof returnvalue === "string"
        ? JSON.parse(returnvalue) as { success: boolean }
        : returnvalue as { success: boolean };
      if (!result.success) return;

      // Find the most recently completed article
      const rows = db
        .select()
        .from(articles)
        .where(eq(articles.status, "done"))
        .orderBy(desc(articles.updatedAt))
        .limit(1)
        .all();

      const article = rows[0];
      if (article) {
        await bot.api.sendMessage(
          article.chatId,
          `Article saved: ${article.title ?? article.url}`
        );
      }
    } catch (err) {
      logger.error({ err, jobId }, "Failed to send completion notification");
    }
  });

  queueEvents.on("failed", async ({ jobId, failedReason }) => {
    try {
      const rows = db
        .select()
        .from(articles)
        .where(eq(articles.status, "processing"))
        .orderBy(desc(articles.updatedAt))
        .limit(1)
        .all();

      const article = rows[0];
      if (article) {
        const now = Math.floor(Date.now() / 1000);
        db.update(articles)
          .set({ status: "failed", error: failedReason, updatedAt: now })
          .where(eq(articles.id, article.id))
          .run();

        await bot.api.sendMessage(
          article.chatId,
          `Failed to process: ${failedReason}`
        );
      }
    } catch (err) {
      logger.error({ err, jobId }, "Failed to send failure notification");
    }
  });

  return queueEvents;
}
