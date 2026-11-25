import { EPub, type Options, type Content } from "epub-gen-memory";
import { marked } from "marked";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { config } from "../config/index.js";
import { defaultCss } from "./templates.js";

export interface EpubInput {
  title: string;
  author: string;
  tags: string[];
  sourceUrl: string;
  cleanedMarkdown: string;
}

function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function generateEpub(input: EpubInput): Promise<string> {
  const html = await marked(input.cleanedMarkdown);

  const options: Options = {
    title: input.title,
    author: input.author,
    publisher: "KOReader Sync",
    description: `Source: ${input.sourceUrl}\nTags: ${input.tags.join(", ")}`,
    lang: "en",
    version: 3,
    css: defaultCss,
  };

  const content: Content = [
    {
      title: input.title,
      content: html,
    },
  ];

  const epubInstance = new EPub(options, content);
  const epubBuffer = await epubInstance.genEpub();

  const articlesDir = path.join(config.EPUB_STORAGE_PATH, "articles");
  await mkdir(articlesDir, { recursive: true });

  const timestamp = Date.now();
  const filename = `${sanitizeFilename(input.title)}-${timestamp}.epub`;
  const filePath = path.join(articlesDir, filename);

  await writeFile(filePath, Buffer.from(epubBuffer));

  return filePath;
}
