import type { Context } from "grammy";

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "KOReader Sync Bot. Send me a URL to save an article for your Kobo."
  );
}
