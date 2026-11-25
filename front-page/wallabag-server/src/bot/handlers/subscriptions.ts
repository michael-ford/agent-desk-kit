import type { Context, Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { and, eq, like } from "drizzle-orm";
import { db } from "../../db/client.js";
import { subscriptions } from "../../db/schema.js";
import { logger } from "../../logger.js";

/**
 * Handles /subscriptions command.
 * Lists all active subscriptions with unsubscribe buttons.
 */
export async function handleSubscriptions(ctx: Context): Promise<void> {
  const userId = ctx.from?.id?.toString();

  if (!userId) {
    await ctx.reply("Could not identify user.");
    return;
  }

  const subs = db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.active, 1)))
    .all();

  if (subs.length === 0) {
    await ctx.reply("No active subscriptions. Use /subscribe <url> to add one.");
    return;
  }

  // Build numbered list message
  const lines = subs.map((sub, i) => `${i + 1}. ${sub.blogTitle || sub.blogUrl}`);
  const message = `Your subscriptions (${subs.length}):\n\n${lines.join("\n")}`;

  // Build inline keyboard with unsubscribe buttons
  const keyboard = new InlineKeyboard();
  for (const sub of subs) {
    // Use first 8 characters of UUID as shortId (fits in 64-byte callback data limit)
    const shortId = sub.id.substring(0, 8);
    keyboard.text(`Unsubscribe: ${sub.blogTitle || "blog"}`, `unsub:${shortId}`).row();
  }

  await ctx.reply(message, { reply_markup: keyboard });
}

/**
 * Registers callback query handler for unsubscribe buttons.
 */
export function handleUnsubscribeCallback(bot: Bot): void {
  // Match unsub:{8-char-short-id}
  bot.callbackQuery(/^unsub:([a-f0-9]{8})$/, async (ctx) => {
    const shortId = ctx.match[1];
    const userId = ctx.from.id.toString();

    // Find subscription by ID prefix
    const sub = db
      .select()
      .from(subscriptions)
      .where(
        and(
          like(subscriptions.id, `${shortId}%`),
          eq(subscriptions.userId, userId),
          eq(subscriptions.active, 1)
        )
      )
      .get();

    if (!sub) {
      await ctx.answerCallbackQuery("Subscription not found.");
      return;
    }

    // Soft delete: set active = 0
    const now = Math.floor(Date.now() / 1000);
    db.update(subscriptions)
      .set({ active: 0, updatedAt: now })
      .where(eq(subscriptions.id, sub.id))
      .run();

    logger.info({ userId, subscriptionId: sub.id, blogUrl: sub.blogUrl }, "Subscription deactivated");

    await ctx.answerCallbackQuery(`Unsubscribed from ${sub.blogTitle || "blog"}`);

    // Update the message to reflect remaining subscriptions
    const remainingSubs = db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.active, 1)))
      .all();

    if (remainingSubs.length === 0) {
      await ctx.editMessageText("No active subscriptions. Use /subscribe <url> to add one.");
      return;
    }

    // Rebuild message and keyboard for remaining subscriptions
    const lines = remainingSubs.map((s, i) => `${i + 1}. ${s.blogTitle || s.blogUrl}`);
    const message = `Your subscriptions (${remainingSubs.length}):\n\n${lines.join("\n")}`;

    const keyboard = new InlineKeyboard();
    for (const s of remainingSubs) {
      const shortId = s.id.substring(0, 8);
      keyboard.text(`Unsubscribe: ${s.blogTitle || "blog"}`, `unsub:${shortId}`).row();
    }

    await ctx.editMessageText(message, { reply_markup: keyboard });
  });
}
