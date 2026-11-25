import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { config } from "../config/index.js";
import { CleanedArticle } from "./schemas.js";

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.OPENROUTER_API_KEY,
  // BullMQ owns retries. Avoid allowing SDK retries to multiply the time a
  // single job can spend waiting on an unresponsive provider.
  timeout: 90_000,
  maxRetries: 0,
});

const SYSTEM_PROMPT = `You are an article content cleaner. Given raw text content (from a web page, email, or pasted article), produce a cleaned version.

REMOVE: navigation menus, ads, CTAs, subscription prompts, cookie notices, author bios, related article links, social sharing buttons, formatting artifacts, header/footer boilerplate.

PRESERVE: article body text, headings, lists, code blocks, blockquotes, image references.

Also extract the article title, author, publication date, and assign 3-5 topic tags.`;

export async function llmClean(
  markdown: string,
  metadata: Record<string, unknown>
): Promise<CleanedArticle> {
  const userMessage = `## Metadata
${JSON.stringify(metadata, null, 2)}

## Raw Markdown
${markdown}`;

  const completion = await openrouter.chat.completions.parse({
    model: config.OPENROUTER_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    response_format: zodResponseFormat(CleanedArticle, "cleaned_article"),
    // Article cleaning is extraction/rewriting, so keep model thinking small.
    reasoning_effort: "minimal",
    // OpenRouter-specific provider routing. When no provider is explicitly
    // pinned, prefer a compatible high-throughput endpoint and retain its
    // normal fallback behaviour.
    provider: config.OPENROUTER_PROVIDER
      ? {
          order: [config.OPENROUTER_PROVIDER],
          require_parameters: true,
        }
      : {
          sort: "throughput",
          require_parameters: true,
        },
  });

  const parsed = completion.choices[0]?.message?.parsed;

  if (!parsed) {
    throw new Error("LLM cleaning returned no parsed result");
  }

  return parsed;
}
