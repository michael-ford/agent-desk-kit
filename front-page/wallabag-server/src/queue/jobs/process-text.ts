import { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { articles } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { llmClean } from "../../extraction/llm-clean.js";
import { generateEpub } from "../../epub/generator.js";

export interface ProcessTextJobData {
  articleId: number;
  text: string;
  chatId: number;
}

function updateArticle(
  articleId: number,
  fields: Record<string, unknown>
): void {
  const now = Math.floor(Date.now() / 1000);
  db.update(articles)
    .set({ ...fields, updatedAt: now })
    .where(eq(articles.id, articleId))
    .run();
}

export async function processText(
  job: Job<ProcessTextJobData>
): Promise<{ success: boolean }> {
  const { articleId, text } = job.data;

  logger.info({ articleId }, "Processing pasted text - starting pipeline");

  try {
    // Step 1: LLM Clean (no extraction step needed)
    updateArticle(articleId, { status: "cleaning" });
    const cleaned = await llmClean(text, { source: "paste" });
    logger.info(
      { articleId, title: cleaned.title, tags: cleaned.tags },
      "LLM cleaning complete"
    );

    // Step 2: Generate EPUB
    updateArticle(articleId, { status: "generating" });
    const article = db
      .select()
      .from(articles)
      .where(eq(articles.id, articleId))
      .get();
    const sourceUrl = article?.url ?? `paste://${articleId}`;

    const epubPath = await generateEpub({
      title: cleaned.title,
      author: cleaned.author ?? "Unknown",
      tags: cleaned.tags,
      sourceUrl,
      cleanedMarkdown: cleaned.cleanedMarkdown,
    });
    logger.info({ articleId, epubPath }, "EPUB generation complete");

    // Step 3: Save all results
    updateArticle(articleId, {
      status: "done",
      title: cleaned.title,
      author: cleaned.author ?? "Unknown",
      publishedDate: cleaned.publishedDate,
      content: cleaned.cleanedMarkdown,
      tags: JSON.stringify(cleaned.tags),
      epubPath,
    });

    logger.info({ articleId }, "Pasted text pipeline complete");
    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown pipeline error";
    logger.error({ articleId, error: message }, "Pasted text pipeline failed");

    updateArticle(articleId, { status: "failed", error: message });

    throw error;
  }
}
