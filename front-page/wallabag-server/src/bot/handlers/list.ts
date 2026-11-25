import type { Context } from "grammy";
import { desc } from "drizzle-orm";
import { db } from "../../db/client.js";
import { articles } from "../../db/schema.js";

const STATUS_EMOJI: Record<string, string> = {
  queued: "\u23F3",
  processing: "\u2699\uFE0F",
  done: "\u2705",
  failed: "\u274C",
};

export async function handleList(ctx: Context): Promise<void> {
  const rows = db
    .select()
    .from(articles)
    .orderBy(desc(articles.createdAt))
    .limit(10)
    .all();

  if (rows.length === 0) {
    await ctx.reply("No articles yet. Send me a URL to get started.");
    return;
  }

  const lines = rows.map((row, i) => {
    const emoji = STATUS_EMOJI[row.status] ?? "\u2753";
    const label = row.title ?? row.url;
    return `${i + 1}. ${emoji} ${label} \u2014 ${row.status}`;
  });

  await ctx.reply(lines.join("\n"));
}
