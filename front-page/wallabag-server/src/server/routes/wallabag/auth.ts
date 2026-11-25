import { Hono } from "hono";
import crypto from "node:crypto";
import { redis } from "../../../queue/index.js";
import { config } from "../../../config/index.js";
import type { MiddlewareHandler } from "hono";

const TOKEN_PREFIX = "wallabag:token:";
const TOKEN_TTL = 3600;

export const tokenRoute = new Hono();

tokenRoute.post("/oauth/v2/token", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  if (body.grant_type !== "password") {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }

  const valid =
    body.client_id === config.WALLABAG_CLIENT_ID &&
    body.client_secret === config.WALLABAG_CLIENT_SECRET &&
    body.username === config.WALLABAG_USERNAME &&
    body.password === config.WALLABAG_PASSWORD;

  if (!valid) {
    return c.json({ error: "invalid_grant" }, 400);
  }

  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();

  await redis.set(`${TOKEN_PREFIX}${accessToken}`, "valid", "EX", TOKEN_TTL);

  return c.json({
    access_token: accessToken,
    expires_in: TOKEN_TTL,
    refresh_token: refreshToken,
    token_type: "bearer",
    scope: null,
  });
});

export const wallabagAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "token_expired" }, 401);
  }

  const token = authHeader.slice(7);
  const result = await redis.get(`${TOKEN_PREFIX}${token}`);

  if (!result) {
    return c.json({ error: "token_expired" }, 401);
  }

  await next();
};
