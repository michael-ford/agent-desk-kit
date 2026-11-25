import type { Context, NextFunction } from "grammy";
import { config } from "../../config/index.js";
import { logger } from "../../logger.js";

export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId || !config.ALLOWED_USER_IDS.includes(userId)) {
    logger.debug({ userId }, "Rejected unauthorized user");
    return; // Silent rejection — no reply, no error
  }

  await next();
}
