import { Hono } from "hono";
import { redis } from "../../queue/index.js";

export const healthRoute = new Hono();

healthRoute.get("/health", async (c) => {
  let redisStatus = "disconnected";
  try {
    const pong = await redis.ping();
    if (pong === "PONG") redisStatus = "connected";
  } catch {
    redisStatus = "disconnected";
  }

  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    redis: redisStatus,
    uptime: process.uptime(),
  });
});
