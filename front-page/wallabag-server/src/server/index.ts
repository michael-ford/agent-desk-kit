import { Hono } from "hono";
import { webhookCallback } from "grammy";
import type { Bot } from "grammy";
import { healthRoute } from "./routes/health.js";
import { wallabagRoute } from "./routes/wallabag/index.js";
import { emailRoute } from "./routes/email/inbound.js";
import { config } from "../config/index.js";

export function createServer(bot: Bot): Hono {
  const app = new Hono();

  // Health check
  app.route("/", healthRoute);

  // Wallabag API shim
  app.route("/", wallabagRoute);

  // Email inbound webhook
  app.route("/", emailRoute);

  // Telegram webhook endpoint (only used in webhook mode)
  if (config.BOT_MODE === "webhook") {
    app.post(`/webhook/${config.TELEGRAM_BOT_TOKEN}`, webhookCallback(bot, "hono"));
  }

  return app;
}
