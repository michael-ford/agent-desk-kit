import type { Context } from "grammy";
import crypto from "node:crypto";
import { db } from "../../db/client.js";
import { articles } from "../../db/schema.js";
import { articleQueue } from "../../queue/index.js";
import { logger } from "../../logger.js";

export async function handleText(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  const chatId = ctx.chat?.id;

  if (!text || !chatId) return;

  // Ignore commands
  if (text.startsWith("/")) return;

  // Ignore short messages
  if (text.length < 200) return;

  // Ignore messages with URL entities -- those belong to the URL handler
  if (
    ctx.message?.entities?.some(
      (e) => e.type === "url" || e.type === "text_link"
    )
  ) {
    return;
  }

  try {
    const pasteUri = `paste://${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);

    const result = db
      .insert(articles)
      .values({
        url: pasteUri,
        canonicalUrl: pasteUri,
        chatId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    await articleQueue.add("process-text", {
      articleId: result.id,
      text,
      chatId,
    });

    logger.info({ articleId: result.id }, "Pasted text queued");
    await ctx.reply("Queued pasted article for processing");
  } catch (err) {
    logger.error({ err }, "Failed to queue pasted text");
    await ctx.reply("Failed to queue pasted text");
  }
}
