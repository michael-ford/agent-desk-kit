import { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { articles } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { emailHtmlToMarkdown } from "../../extraction/email-clean.js";
import { llmClean } from "../../extraction/llm-clean.js";
import { generateEpub } from "../../epub/generator.js";

export interface ProcessEmailJobData {
  articleId: number;
  subject: string;
  from: string;
  htmlBody: string;
  date?: string;
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

export async function processEmail(
  job: Job<ProcessEmailJobData>
): Promise<{ success: boolean }> {
  const { articleId, subject, from, htmlBody, date } = job.data;

  logger.info({ articleId, subject, from }, "Processing email - starting pipeline");

  try {
    // Step 1: Sanitize HTML and convert to markdown
    updateArticle(articleId, { status: "extracting" });
    const markdown = emailHtmlToMarkdown(htmlBody);
    logger.info(
      { articleId, markdownLength: markdown.length },
      "Email HTML sanitized and converted to markdown"
    );

    // Step 2: LLM Clean
    updateArticle(articleId, { status: "cleaning" });
    const cleaned = await llmClean(markdown, {
      title: subject,
      author: from,
      date,
      sourceURL: `email://${from}`,
    });
    logger.info(
      { articleId, title: cleaned.title, tags: cleaned.tags },
      "LLM cleaning complete"
    );

    // Step 3: Generate EPUB
    updateArticle(articleId, { status: "generating" });
    const epubPath = await generateEpub({
      title: cleaned.title,
      author: cleaned.author ?? from,
      tags: cleaned.tags,
      sourceUrl: `email://${from}`,
      cleanedMarkdown: cleaned.cleanedMarkdown,
    });
    logger.info({ articleId, epubPath }, "EPUB generation complete");

    // Step 4: Save all results
    updateArticle(articleId, {
      status: "done",
      title: cleaned.title,
      author: cleaned.author ?? from,
      publishedDate: cleaned.publishedDate,
      content: cleaned.cleanedMarkdown,
      tags: JSON.stringify(cleaned.tags),
      epubPath,
    });

    logger.info({ articleId, subject }, "Email pipeline complete");
    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown pipeline error";
    logger.error({ articleId, subject, error: message }, "Email pipeline failed");

    updateArticle(articleId, { status: "failed", error: message });

    throw error;
  }
}
