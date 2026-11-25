import { Bot } from "grammy";
import { config } from "../config/index.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorBoundary } from "./middleware/error.js";
import { handleStart } from "./handlers/start.js";
import { handleUrl } from "./handlers/url.js";
import { handleList } from "./handlers/list.js";
import { handleText } from "./handlers/text.js";
import { handleDocument } from "./handlers/document.js";
import { handleSubscribe } from "./handlers/subscribe.js";
import { handleSubscriptions, handleUnsubscribeCallback } from "./handlers/subscriptions.js";
import { handleSubscriptionCallback } from "./handlers/callbacks/subscription.js";

export function createBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Auth middleware runs first on every update
  bot.use(authMiddleware);

  // Command handlers
  bot.command("start", handleStart);
  bot.command("list", handleList);
  bot.command("subscribe", handleSubscribe);
  bot.command("subscriptions", handleSubscriptions);

  // Callback query handlers
  handleSubscriptionCallback(bot);
  handleUnsubscribeCallback(bot);

  // Document handler — matches EPUB file attachments
  bot.on("message:document", handleDocument);

  // URL handler — matches any text message with URL entities
  bot.on("message:entities:url", handleUrl);
  bot.on("message:entities:text_link", handleUrl);

  // Text handler — matches plain text messages (pasted articles)
  bot.on("message:text", handleText);

  // Error boundary
  bot.catch(errorBoundary);

  return bot;
}
