import { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { articles } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { extractUrl } from "../../extraction/firecrawl.js";
import { llmClean } from "../../extraction/llm-clean.js";
import { generateEpub } from "../../epub/generator.js";

export interface ProcessUrlJobData {
  articleId: number;
  url: string;
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

export async function processUrl(
  job: Job<ProcessUrlJobData>
): Promise<{ success: boolean }> {
  const { articleId, url } = job.data;

  logger.info({ url, articleId }, "Processing URL - starting pipeline");

  try {
    // Step 1: Extract
    updateArticle(articleId, { status: "extracting" });
    const extracted = await extractUrl(url);
    logger.info(
      { url, titleFound: !!extracted.metadata.title },
      "Extraction complete"
    );

    // Step 2: LLM Clean
    updateArticle(articleId, { status: "cleaning" });
    const cleaned = await llmClean(extracted.markdown, extracted.metadata);
    logger.info(
      { url, title: cleaned.title, tags: cleaned.tags },
      "LLM cleaning complete"
    );

    // Step 3: Generate EPUB
    updateArticle(articleId, { status: "generating" });
    const epubPath = await generateEpub({
      title: cleaned.title,
      author: cleaned.author ?? "Unknown",
      tags: cleaned.tags,
      sourceUrl: url,
      cleanedMarkdown: cleaned.cleanedMarkdown,
    });
    logger.info({ url, epubPath }, "EPUB generation complete");

    // Step 4: Save all results
    updateArticle(articleId, {
      status: "done",
      title: cleaned.title,
      author: cleaned.author,
      publishedDate: cleaned.publishedDate,
      content: cleaned.cleanedMarkdown,
      tags: JSON.stringify(cleaned.tags),
      epubPath,
    });

    logger.info({ url, articleId }, "Pipeline complete");
    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown pipeline error";
    logger.error({ url, articleId, error: message }, "Pipeline failed");

    updateArticle(articleId, { status: "failed", error: message });

    throw error;
  }
}
