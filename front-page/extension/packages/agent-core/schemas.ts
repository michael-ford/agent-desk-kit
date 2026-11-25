import { CHANNEL_KEYS } from "./channels";
/**
 * Input schemas for the two custom tools. The caps live in the schema, not just
 * the handler, so the model can see the ceiling it is working against.
 */

/**
 * Structurally compatible with the SDK's `BetaManagedAgentsCustomToolInputSchema`,
 * which wants a mutable `required` and an open index signature.
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  [k: string]: unknown;
}

export const GET_HISTORY_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    daysToAnalyze: {
      type: "integer",
      minimum: 1,
      maximum: 90,
      description: "How many days of history to analyze. Default 14.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Top N domains by relevance score. Default 30.",
    },
  },
  required: [],
};

export const GET_PAGE_HTML_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
      description:
        "URLs to load in real browser tabs. Authenticated, JS-rendered pages work — " +
        "this is the user's own logged-in browser, not a fetch from a datacenter.",
    },
    loadDelayMs: {
      type: "integer",
      minimum: 0,
      maximum: 30000,
      description: "Extra wait after load, for lazy-rendered content. Default 8000.",
    },
  },
  required: ["urls"],
};

export const DEFAULTS = {
  daysToAnalyze: 14,
  maxResults: 30,
  loadDelayMs: 8000,
  /** Cap on titles carried per domain in the digest. */
  sampleTitles: 5,
} as const;

export const GET_X_POSTS_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 7,
      description: "How many days back to search. Default 3.",
    },
    minLikes: {
      type: "integer",
      minimum: 0,
      maximum: 1000,
      description: "Only posts with at least this many likes. Default 20.",
    },
  },
  required: [],
};

export const GET_FEEDS_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    channels: {
      type: "array",
      items: { type: "string", enum: [...CHANNEL_KEYS] },
      description: "Only these channels' feeds. Default: every channel plus the shared feeds (Hacker News).",
    },
    days: {
      type: "integer",
      minimum: 1,
      maximum: 14,
      description: "Override each channel's window (AI 3 days, the others 7).",
    },
  },
  required: [],
};
