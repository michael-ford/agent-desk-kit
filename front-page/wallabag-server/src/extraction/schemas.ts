import { z } from "zod";

export const CleanedArticle = z.object({
  title: z.string().describe("Article title"),
  author: z.string().nullable().describe("Article author if identifiable"),
  publishedDate: z
    .string()
    .nullable()
    .describe("Publication date in ISO 8601 format if identifiable"),
  cleanedMarkdown: z
    .string()
    .describe("Article body as clean markdown, no navigation/ads/CTAs"),
  tags: z
    .array(z.string())
    .describe("3-5 topic tags summarizing the article content"),
});

export type CleanedArticle = z.infer<typeof CleanedArticle>;
