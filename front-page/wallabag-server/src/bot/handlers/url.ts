import type { Context } from "grammy";
import { eq } from "drizzle-orm";
import normalizeUrl from "normalize-url";
import { extractUrls } from "../helpers/url.js";
import { db } from "../../db/client.js";
import { articles } from "../../db/schema.js";
import { articleQueue } from "../../queue/index.js";
import { logger } from "../../logger.js";

export function canonicalize(url: string): string {
  return normalizeUrl(url, {
    stripHash: true,
    stripWWW: true,
    removeQueryParameters: [/^utm_/, /^ref$/, /^source$/],
    removeTrailingSlash: true,
    sortQueryParameters: true,
  });
}

export async function handleUrl(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  const entities = ctx.message?.entities;
  const chatId = ctx.chat?.id;

  if (!chatId) return;

  const urls = extractUrls(text, entities);

  if (urls.length === 0) {
    await ctx.reply("No valid URL found. Send an http:// or https:// link.");
    return;
  }

  for (const url of urls) {
    try {
      const canonical = canonicalize(url);

      // Check for duplicate by canonical URL
      const existing = db
        .select()
        .from(articles)
        .where(eq(articles.canonicalUrl, canonical))
        .get();

      if (existing) {
        await ctx.reply(`Already queued: ${url}`);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);

      const result = db
        .insert(articles)
        .values({
          url,
          canonicalUrl: canonical,
          chatId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      await articleQueue.add("process-url", {
        articleId: result.id,
        url,
        chatId,
      });

      logger.info({ url, articleId: result.id }, "URL queued");
      await ctx.reply(`\u2705 Queued: ${url}`);
    } catch (err) {
      logger.error({ err, url }, "Failed to queue URL");
      await ctx.reply(`Failed to queue: ${url}`);
    }
  }
}
