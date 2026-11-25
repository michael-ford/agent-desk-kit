import { Hono } from "hono";
import { tokenRoute } from "./auth.js";
import { entriesRoute } from "./entries.js";

const wallabagRoute = new Hono();

// OAuth2 token endpoint (no auth required)
wallabagRoute.route("/", tokenRoute);

// Entry CRUD endpoints (auth required, applied within entriesRoute)
wallabagRoute.route("/", entriesRoute);

export { wallabagRoute };
