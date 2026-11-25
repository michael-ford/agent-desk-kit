import { extract } from "@extractus/feed-extractor";
import { XMLParser } from "fast-xml-parser";
import { logger } from "../logger.js";

export interface FeedEntry {
  id?: string;
  title: string;
  link: string;
  published?: Date;
}

export interface FeedResult {
  title: string;
  link?: string;
  description?: string;
  entries: FeedEntry[];
}

interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

interface SitemapIndex {
  sitemap: Array<{ loc: string }>;
}

const FETCH_TIMEOUT = 10000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "koreader-sync/1.0 (Feed Parser)",
      },
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetches and parses an RSS/Atom feed, returning normalized entries
 */
export async function fetchFeed(feedUrl: string): Promise<FeedResult | null> {
  try {
    const feed = await extract(feedUrl, {
      getExtraEntryFields: () => ({}),
    });

    if (!feed) {
      logger.warn({ feedUrl }, "Feed extraction returned null");
      return null;
    }

    const entries: FeedEntry[] = (feed.entries || []).map((entry) => ({
      id: entry.id || entry.link,
      title: entry.title || "Untitled",
      link: entry.link || "",
      published: entry.published ? new Date(entry.published) : undefined,
    }));

    return {
      title: feed.title || "Untitled Feed",
      link: feed.link,
      description: feed.description,
      entries,
    };
  } catch (error) {
    logger.error({ error, feedUrl }, "Failed to fetch/parse feed");
    throw new Error(`Failed to parse feed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Parses a sitemap and extracts all URLs, handling sitemap indexes recursively.
 * Returns URLs sorted by lastmod descending (most recent first) if available.
 */
export async function parseSitemap(sitemapUrl: string, maxDepth = 2): Promise<string[]> {
  if (maxDepth <= 0) {
    logger.warn({ sitemapUrl }, "Max sitemap depth reached");
    return [];
  }

  try {
    const response = await fetchWithTimeout(sitemapUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });

    const parsed = parser.parse(xml);

    // Check if this is a sitemap index
    if (parsed.sitemapindex) {
      const index: SitemapIndex = parsed.sitemapindex;
      const sitemaps = Array.isArray(index.sitemap) ? index.sitemap : [index.sitemap];

      const allUrls: SitemapUrl[] = [];
      for (const sitemap of sitemaps) {
        if (sitemap?.loc) {
          const childUrls = await parseSitemap(sitemap.loc, maxDepth - 1);
          allUrls.push(...childUrls.map((loc) => ({ loc })));
        }
      }

      return allUrls.map((u) => u.loc);
    }

    // Regular sitemap with urlset
    if (parsed.urlset?.url) {
      const urls: SitemapUrl[] = Array.isArray(parsed.urlset.url)
        ? parsed.urlset.url
        : [parsed.urlset.url];

      // Sort by lastmod descending if available
      const sortedUrls = urls
        .filter((u) => u?.loc)
        .sort((a, b) => {
          if (!a.lastmod && !b.lastmod) return 0;
          if (!a.lastmod) return 1;
          if (!b.lastmod) return -1;
          return new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime();
        });

      return sortedUrls.map((u) => u.loc);
    }

    logger.warn({ sitemapUrl }, "Sitemap has unexpected structure");
    return [];
  } catch (error) {
    logger.error({ error, sitemapUrl }, "Failed to parse sitemap");
    throw new Error(`Failed to parse sitemap: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
