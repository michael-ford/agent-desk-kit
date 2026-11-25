import type { Context } from "grammy";
import { discoverFeed } from "../../subscription/discovery.js";
import { fetchFeed, parseSitemap } from "../../subscription/feed-parser.js";
import {
  savePendingSubscription,
  type PendingSubscription,
} from "../../subscription/pending.js";
import { buildConfirmKeyboard } from "../keyboards/subscription.js";
import { logger } from "../../logger.js";

/**
 * Handles /subscribe <url> command.
 * Discovers feed, shows preview with blog name and recent posts,
 * and presents confirm/cancel keyboard.
 */
export async function handleSubscribe(ctx: Context): Promise<void> {
  const url = ctx.match as string | undefined;
  const userId = ctx.from?.id?.toString();
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) {
    await ctx.reply("Could not identify user.");
    return;
  }

  // Validate URL argument
  if (!url || url.trim() === "") {
    await ctx.reply("Usage: /subscribe <url>\n\nExample: /subscribe https://example.com/blog");
    return;
  }

  const trimmedUrl = url.trim();

  // Validate URL format
  if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
    await ctx.reply("Invalid URL. Must start with http:// or https://");
    return;
  }

  // Send discovery message
  const message = await ctx.reply(`Discovering feed for ${trimmedUrl}...`);

  try {
    const result = await discoverFeed(trimmedUrl);

    if (result.type === "none") {
      await ctx.api.editMessageText(
        chatId,
        message.message_id,
        `Could not find RSS feed or sitemap for ${trimmedUrl}. Make sure the blog has a feed.`
      );
      return;
    }

    let blogTitle: string;
    let recentPosts: Array<{ id?: string; title: string; link: string }>;
    let pendingData: PendingSubscription;

    if (result.type === "rss") {
      const feed = await fetchFeed(result.feedUrl);
      if (!feed) {
        await ctx.api.editMessageText(
          chatId,
          message.message_id,
          `Found feed but could not parse it. Try a different URL.`
        );
        return;
      }

      blogTitle = feed.title;
      recentPosts = feed.entries.slice(0, 3).map((e) => ({
        id: e.id,
        title: e.title,
        link: e.link,
      }));

      pendingData = {
        blogUrl: trimmedUrl,
        feedUrl: result.feedUrl,
        blogTitle,
        monitorType: "rss",
        recentPosts,
      };
    } else {
      // Sitemap
      const urls = await parseSitemap(result.sitemapUrl);
      if (urls.length === 0) {
        await ctx.api.editMessageText(
          chatId,
          message.message_id,
          `Found sitemap but it appears to be empty.`
        );
        return;
      }

      // Extract domain as blog title
      const parsedUrl = new URL(trimmedUrl);
      blogTitle = parsedUrl.hostname.replace(/^www\./, "");

      recentPosts = urls.slice(0, 3).map((u) => ({
        id: u,
        title: u,
        link: u,
      }));

      pendingData = {
        blogUrl: trimmedUrl,
        sitemapUrl: result.sitemapUrl,
        blogTitle,
        monitorType: "sitemap",
        recentPosts,
      };
    }

    // Save pending subscription
    const pendingKey = await savePendingSubscription(userId, pendingData);

    // Build confirmation message
    const postList = recentPosts
      .map((p) => `- ${p.title}`)
      .join("\n");

    const confirmMessage = `*${escapeMarkdown(blogTitle)}*

Recent posts:
${postList}

Subscribe to this blog?`;

    // Edit with confirmation keyboard
    await ctx.api.editMessageText(
      chatId,
      message.message_id,
      confirmMessage,
      {
        parse_mode: "Markdown",
        reply_markup: buildConfirmKeyboard(pendingKey),
      }
    );

    logger.info({ userId, blogUrl: trimmedUrl, pendingKey }, "Subscription preview shown");
  } catch (error) {
    logger.error({ error, url: trimmedUrl }, "Subscribe command failed");
    await ctx.api.editMessageText(
      chatId,
      message.message_id,
      `Failed to discover feed for ${trimmedUrl}. Please try again later.`
    );
  }
}

/**
 * Escapes special characters for Telegram Markdown v1
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}
