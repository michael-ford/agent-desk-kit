import "dotenv/config";
import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { db, sqlite } from "./db/client.js";
import { createBot } from "./bot/index.js";
import { createServer } from "./server/index.js";
import { articleQueue, createWorker, redis } from "./queue/index.js";
import { setupQueueEvents } from "./queue/events.js";
import { logger } from "./logger.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// Run migrations
try {
  migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Database migrations applied");
} catch (err) {
  logger.warn({ err }, "Migration warning (may be first run with no migrations)");
}

const bot = createBot();
const worker = createWorker();
const queueEvents = setupQueueEvents(bot);
const app = createServer(bot);

// Start server
const server = serve({ fetch: app.fetch, port: config.PORT }, () => {
  logger.info({ port: config.PORT }, "HTTP server started");
});

// Start bot
if (config.BOT_MODE === "polling") {
  bot.start({
    onStart: () => logger.info("Bot started in polling mode"),
  });
} else {
  logger.info({ webhook: config.WEBHOOK_URL }, "Bot running in webhook mode");
}

// Graceful shutdown
async function shutdown() {
  logger.info("Shutting down...");
  try {
    if (config.BOT_MODE === "polling") {
      bot.stop();
    }
    await worker.close();
    await queueEvents.close();
    await articleQueue.close();
    await redis.quit();
    sqlite.close();
    server.close();
    logger.info("Shutdown complete");
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
