import FirecrawlApp from "@mendable/firecrawl-js";
import { config } from "../config/index.js";

const firecrawl = new FirecrawlApp({ apiKey: config.FIRECRAWL_API_KEY });

const MAX_MARKDOWN_LENGTH = 100_000;

export interface ExtractedArticle {
  markdown: string;
  metadata: {
    title?: string;
    author?: string;
    date?: string;
    sourceURL: string;
    description?: string;
  };
}

export async function extractUrl(url: string): Promise<ExtractedArticle> {
  const result = await firecrawl.scrape(url, {
    formats: ["markdown"],
    onlyMainContent: true,
  });

  const markdown = (result.markdown ?? "").slice(0, MAX_MARKDOWN_LENGTH);

  return {
    markdown,
    metadata: {
      title: result.metadata?.title,
      author: (result.metadata as Record<string, string | undefined>)?.author,
      date: (result.metadata as Record<string, string | undefined>)
        ?.publishedDate,
      sourceURL: result.metadata?.sourceURL ?? url,
      description: result.metadata?.description,
    },
  };
}
