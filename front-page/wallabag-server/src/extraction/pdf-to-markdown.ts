import { PDFParse } from "pdf-parse";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { config } from "../config/index.js";
import { logger } from "../logger.js";

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.OPENROUTER_API_KEY,
});

const SYSTEM_PROMPT = `You are a document formatting specialist. Given raw text extracted from a PDF, produce well-structured markdown.

Your job is to RECONSTRUCT the document's structure from the raw text:
- Identify and format section headings (Abstract, Introduction, Methods, Results, Discussion, References, etc.) as markdown headings (## for major sections, ### for subsections)
- Preserve all body text faithfully — do not summarize or omit content
- Format lists, tables, and numbered items properly
- Preserve superscript reference numbers as markdown (e.g., ^1, ^2,3)
- Keep author names, affiliations, and metadata at the top
- Format the references/bibliography section cleanly
- Preserve italic text for gene names, species names, etc. where apparent from context

Do NOT remove or alter any content. Your role is purely structural formatting.`;

const PdfMarkdown = z.object({
  title: z.string().describe("Document title"),
  author: z
    .string()
    .nullable()
    .describe("First/corresponding author, or comma-separated author list if short"),
  cleanedMarkdown: z
    .string()
    .describe("Full document content as well-structured markdown"),
  tags: z
    .array(z.string())
    .describe("3-5 topic tags summarizing the document"),
});

export type PdfMarkdown = z.infer<typeof PdfMarkdown>;

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  return result.text;
}

export async function pdfToMarkdown(
  rawText: string,
  filename: string
): Promise<PdfMarkdown> {
  const completion = await openrouter.chat.completions.parse({
    model: config.OPENROUTER_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `## Source filename\n${filename}\n\n## Raw PDF text\n${rawText}`,
      },
    ],
    response_format: zodResponseFormat(PdfMarkdown, "pdf_markdown"),
    provider: config.OPENROUTER_PROVIDER
      ? { order: [config.OPENROUTER_PROVIDER] }
      : undefined,
  });

  const parsed = completion.choices[0]?.message?.parsed;

  if (!parsed) {
    throw new Error("LLM PDF-to-markdown returned no parsed result");
  }

  logger.info(
    { title: parsed.title, tags: parsed.tags },
    "PDF converted to structured markdown"
  );

  return parsed;
}
