import type { Bot } from "grammy";
import { db } from "../../../db/client.js";
import { subscriptions, seenEntries } from "../../../db/schema.js";
import {
  getPendingSubscription,
  deletePendingSubscription,
} from "../../../subscription/pending.js";
import { logger } from "../../../logger.js";

/**
 * Registers callback query handlers for subscription confirm/cancel buttons.
 */
export function handleSubscriptionCallback(bot: Bot): void {
  // Confirm subscription: sub:c:{pendingKey}
  bot.callbackQuery(/^sub:c:(.+)$/, async (ctx) => {
    const pendingKey = ctx.match[1];
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.answerCallbackQuery("Error: Could not identify chat.");
      return;
    }

    // Get pending subscription data
    const pending = await getPendingSubscription(userId, pendingKey);

    if (!pending) {
      await ctx.answerCallbackQuery("Subscription expired. Try /subscribe again.");
      await ctx.editMessageText("Expired.");
      return;
    }

    try {
      const subscriptionId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      // Insert subscription
      db.insert(subscriptions)
        .values({
          id: subscriptionId,
          userId,
          chatId,
          blogUrl: pending.blogUrl,
          blogTitle: pending.blogTitle,
          feedUrl: pending.feedUrl,
          sitemapUrl: pending.sitemapUrl,
          monitorType: pending.monitorType,
          active: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      // Backfill prevention: Mark existing entries as seen
      for (const post of pending.recentPosts) {
        const entryId = post.id || post.link;
        db.insert(seenEntries)
          .values({
            id: crypto.randomUUID(),
            subscriptionId,
            entryId,
            url: post.link,
            firstSeen: now,
            notified: 1, // Mark as already notified to prevent backfill
          })
          .run();
      }

      // Clean up pending state
      await deletePendingSubscription(userId, pendingKey);

      logger.info({ userId, subscriptionId, blogUrl: pending.blogUrl }, "Subscription created");

      await ctx.answerCallbackQuery("Subscribed!");
      await ctx.editMessageText(`Subscribed to ${pending.blogTitle}`);
    } catch (error) {
      logger.error({ error, userId, pendingKey }, "Failed to create subscription");
      await ctx.answerCallbackQuery("Failed to subscribe. Try again.");
    }
  });

  // Cancel subscription: sub:x:{pendingKey}
  bot.callbackQuery(/^sub:x:(.+)$/, async (ctx) => {
    const pendingKey = ctx.match[1];
    const userId = ctx.from.id.toString();

    // Delete pending data (ignore if not found - might already be expired)
    await deletePendingSubscription(userId, pendingKey);

    logger.info({ userId, pendingKey }, "Subscription cancelled");

    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("Subscription cancelled.");
  });
}
