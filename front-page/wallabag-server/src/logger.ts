import pino from "pino";

// Config may not be loaded yet when logger is first imported,
// so we read LOG_LEVEL directly from env with a fallback
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
});
