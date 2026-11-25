import { redis } from "../queue/index.js";
import { logger } from "../logger.js";

export interface PendingSubscription {
  blogUrl: string;
  feedUrl?: string;
  sitemapUrl?: string;
  blogTitle: string;
  monitorType: "rss" | "sitemap";
  recentPosts: Array<{ id?: string; title: string; link: string }>;
}

const PENDING_TTL = 300; // 5 minutes
const KEY_PREFIX = "pending:sub";

/**
 * Generates a short numeric key based on timestamp
 */
function generateKey(): string {
  return Date.now().toString(36);
}

/**
 * Saves a pending subscription to Redis with 5 minute TTL.
 * Returns a short key that can be used in Telegram callback_data.
 */
export async function savePendingSubscription(
  userId: string,
  data: PendingSubscription
): Promise<string> {
  const key = generateKey();
  const redisKey = `${KEY_PREFIX}:${userId}:${key}`;

  await redis.setex(redisKey, PENDING_TTL, JSON.stringify(data));

  logger.debug({ userId, key, blogUrl: data.blogUrl }, "Saved pending subscription");

  return key;
}

/**
 * Retrieves a pending subscription from Redis.
 * Returns null if not found or expired.
 */
export async function getPendingSubscription(
  userId: string,
  key: string
): Promise<PendingSubscription | null> {
  const redisKey = `${KEY_PREFIX}:${userId}:${key}`;

  const data = await redis.get(redisKey);
  if (!data) {
    logger.debug({ userId, key }, "Pending subscription not found or expired");
    return null;
  }

  try {
    return JSON.parse(data) as PendingSubscription;
  } catch (error) {
    logger.error({ error, userId, key }, "Failed to parse pending subscription");
    return null;
  }
}

/**
 * Deletes a pending subscription from Redis.
 */
export async function deletePendingSubscription(
  userId: string,
  key: string
): Promise<void> {
  const redisKey = `${KEY_PREFIX}:${userId}:${key}`;

  await redis.del(redisKey);

  logger.debug({ userId, key }, "Deleted pending subscription");
}
