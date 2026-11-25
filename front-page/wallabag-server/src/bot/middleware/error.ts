import { BotError } from "grammy";
import { logger } from "../../logger.js";

export async function errorBoundary(err: BotError): Promise<void> {
  const ctx = err.ctx;
  const e = err.error;

  logger.error({ err: e, update: ctx.update }, "Bot error");

  try {
    await ctx.reply("Something went wrong. Please try again.");
  } catch (replyErr) {
    logger.error({ err: replyErr }, "Failed to send error reply");
  }
}
