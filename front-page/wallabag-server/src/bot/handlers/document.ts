import type { Context } from "grammy";
import { writeFile, mkdir } from "node:fs/promises";
import { db } from "../../db/client.js";
import { articles } from "../../db/schema.js";
import { config } from "../../config/index.js";
import { logger } from "../../logger.js";
import { parseEpubFilename } from "../helpers/epub-filename.js";
import { generateEpub } from "../../epub/generator.js";
import {
  extractPdfText,
  pdfToMarkdown,
} from "../../extraction/pdf-to-markdown.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB Telegram Bot API limit

function parseDocFilename(filename: string): string {
  const base = filename.replace(/\.(md|pdf)$/i, "").trim();
  let title = base;
  if (!title.includes(" ")) {
    title = title.replace(/[_-]+/g, " ").trim();
  }
  return title || filename;
}

async function downloadTelegramFile(
  ctx: Context,
  fileId: string
): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function handleDocument(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  const chatId = ctx.chat?.id;

  if (!doc || !chatId) return;

  const fileName = doc.file_name?.toLowerCase() ?? "";
  const isEpub =
    doc.mime_type === "application/epub+zip" || fileName.endsWith(".epub");
  const isMarkdown =
    doc.mime_type === "text/markdown" || fileName.endsWith(".md");
  const isPdf =
    doc.mime_type === "application/pdf" || fileName.endsWith(".pdf");

  if (!isEpub && !isMarkdown && !isPdf) return;

  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("File too large. Maximum size is 20MB.");
    return;
  }

  if (isPdf) {
    await handlePdfUpload(ctx, doc, chatId);
  } else if (isMarkdown) {
    await handleMarkdownUpload(ctx, doc, chatId);
  } else {
    await handleEpubUpload(ctx, doc, chatId);
  }
}

async function handleMarkdownUpload(
  ctx: Context,
  doc: NonNullable<Context["message"]>["document"] & {},
  chatId: number
): Promise<void> {
  try {
    const originalName = doc.file_name ?? "untitled.md";
    const title = parseDocFilename(originalName);

    const buffer = await downloadTelegramFile(ctx, doc.file_id);
    const markdown = buffer.toString("utf-8");

    // Convert markdown to EPUB using existing generator
    const epubPath = await generateEpub({
      title,
      author: "Unknown",
      tags: [],
      sourceUrl: `markdown://upload/${originalName}`,
      cleanedMarkdown: markdown,
    });

    const now = Math.floor(Date.now() / 1000);
    db.insert(articles)
      .values({
        url: `markdown://upload/${originalName}-${Date.now()}`,
        title,
        author: "Unknown",
        status: "done",
        isArchived: 0,
        content: markdown,
        epubPath,
        chatId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    logger.info({ title, epubPath }, "Markdown uploaded and converted to EPUB via Telegram");
    await ctx.reply(`Converted and saved: ${title}`);
  } catch (err) {
    logger.error({ err }, "Failed to process Markdown upload");
    await ctx.reply("Failed to convert Markdown. Please try again.");
  }
}

async function handlePdfUpload(
  ctx: Context,
  doc: NonNullable<Context["message"]>["document"] & {},
  chatId: number
): Promise<void> {
  try {
    const originalName = doc.file_name ?? "untitled.pdf";
    await ctx.reply("Processing PDF... this may take a moment.");

    const buffer = await downloadTelegramFile(ctx, doc.file_id);

    // Extract raw text from PDF
    const rawText = await extractPdfText(buffer);
    if (!rawText.trim()) {
      await ctx.reply(
        "Could not extract text from this PDF. It may be image-only."
      );
      return;
    }

    // LLM structures the raw text as clean markdown
    const result = await pdfToMarkdown(rawText, originalName);

    // Convert structured markdown to EPUB
    const epubPath = await generateEpub({
      title: result.title,
      author: result.author ?? "Unknown",
      tags: result.tags,
      sourceUrl: `pdf://upload/${originalName}`,
      cleanedMarkdown: result.cleanedMarkdown,
    });

    const now = Math.floor(Date.now() / 1000);
    db.insert(articles)
      .values({
        url: `pdf://upload/${originalName}-${Date.now()}`,
        title: result.title,
        author: result.author,
        status: "done",
        isArchived: 0,
        content: result.cleanedMarkdown,
        epubPath,
        chatId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const label = result.author
      ? `${result.title} by ${result.author}`
      : result.title;
    logger.info(
      { title: result.title, epubPath },
      "PDF uploaded and converted to EPUB via Telegram"
    );
    await ctx.reply(`Converted and saved: ${label}`);
  } catch (err) {
    logger.error({ err }, "Failed to process PDF upload");
    await ctx.reply("Failed to convert PDF. Please try again.");
  }
}

async function handleEpubUpload(
  ctx: Context,
  doc: NonNullable<Context["message"]>["document"] & {},
  chatId: number
): Promise<void> {
  try {
    const originalName = doc.file_name ?? "untitled.epub";
    const { title, author } = parseEpubFilename(originalName);

    const buffer = await downloadTelegramFile(ctx, doc.file_id);

    // Save to disk (same pattern as entries.ts upload endpoint)
    const now = Math.floor(Date.now() / 1000);
    const timestamp = Date.now();
    const safeName = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    const filename = `${safeName}-${timestamp}.epub`;
    const booksDir = `${config.EPUB_STORAGE_PATH}/books`;
    const epubPath = `${booksDir}/${filename}`;

    await mkdir(booksDir, { recursive: true });
    await writeFile(epubPath, buffer);

    // Insert article record
    db.insert(articles)
      .values({
        url: `epub://upload/${filename}`,
        title,
        author,
        status: "done",
        isArchived: 0,
        content: null,
        epubPath,
        chatId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const label = author ? `${title} by ${author}` : title;
    logger.info({ title, author, epubPath }, "EPUB uploaded via Telegram");
    await ctx.reply(`Saved: ${label}`);
  } catch (err) {
    logger.error({ err }, "Failed to process EPUB upload");
    await ctx.reply("Failed to save EPUB. Please try again.");
  }
}
