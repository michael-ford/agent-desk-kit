import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, "ALLOWED_USER_IDS is required")
    .transform((val) =>
      val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
    )
    .refine((ids) => ids.every((id) => !isNaN(id) && id > 0), {
      message: "ALLOWED_USER_IDS must be comma-separated positive numbers",
    }),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DATABASE_PATH: z.string().default("./data/koreader-sync.db"),
  BOT_MODE: z.enum(["webhook", "polling"]).default("polling"),
  WEBHOOK_URL: z.string().optional(),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),
  FIRECRAWL_API_KEY: z.string().min(1, "FIRECRAWL_API_KEY is required"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().default("google/gemini-2.0-flash-001"),
  OPENROUTER_PROVIDER: z.string().optional(),
  EPUB_STORAGE_PATH: z.string().default("./data/epubs"),
  // The OAuth client id/secret and username KOReader (and the extension) log in
  // with. No defaults: pick your own values and set the same ones on the client.
  WALLABAG_CLIENT_ID: z.string().min(1, "WALLABAG_CLIENT_ID is required"),
  WALLABAG_CLIENT_SECRET: z.string().min(1, "WALLABAG_CLIENT_SECRET is required"),
  WALLABAG_USERNAME: z.string().min(1, "WALLABAG_USERNAME is required"),
  WALLABAG_PASSWORD: z.string().min(1, "WALLABAG_PASSWORD is required"),
  EMAIL_WEBHOOK_SECRET: z.string().min(1, "EMAIL_WEBHOOK_SECRET is required"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

if (config.BOT_MODE === "webhook" && !config.WEBHOOK_URL) {
  console.error("WEBHOOK_URL is required when BOT_MODE=webhook");
  process.exit(1);
}

export type Config = typeof config;
