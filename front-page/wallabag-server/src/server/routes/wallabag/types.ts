import type { Article } from "../../../db/schema.js";

export interface WallabagTag {
  id: number;
  label: string;
  slug: string;
}

export interface WallabagEntry {
  id: number;
  title: string | null;
  url: string;
  content: string | null;
  is_archived: number;
  is_starred: number;
  created_at: string;
  updated_at: string;
  domain_name: string;
  reading_time: number;
  mimetype: string;
  language: string | null;
  tags: WallabagTag[];
  _links: {
    self: { href: string };
  };
}

export function toWallabagEntry(article: Article): WallabagEntry {
  let domain = "";
  try {
    domain = new URL(article.url).hostname;
  } catch {
    domain = article.url;
  }

  let tags: WallabagTag[] = [];
  if (article.tags) {
    try {
      const parsed = JSON.parse(article.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.map((label: string, i: number) => ({
          id: i + 1,
          label,
          slug: label.toLowerCase().replace(/\s+/g, "-"),
        }));
      }
    } catch {
      // ignore malformed tags
    }
  }

  return {
    id: article.id,
    title: article.title ?? null,
    url: article.url,
    content: article.content ?? null,
    is_archived: article.isArchived,
    is_starred: 0,
    created_at: new Date(article.createdAt * 1000).toISOString(),
    updated_at: new Date(article.updatedAt * 1000).toISOString(),
    domain_name: domain,
    reading_time: Math.ceil((article.content?.length ?? 0) / 1500),
    mimetype: "text/html",
    language: null,
    tags,
    _links: {
      self: { href: `/api/entries/${article.id}` },
    },
  };
}
