import * as cheerio from "cheerio";
import { extract } from "@extractus/feed-extractor";
import { logger } from "../logger.js";

export type DiscoveryResult =
  | { type: "rss"; feedUrl: string }
  | { type: "sitemap"; sitemapUrl: string }
  | { type: "none" };

const FEED_MIME_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/xml",
  "text/xml",
];

const COMMON_FEED_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feed/",
];

const FETCH_TIMEOUT = 5000;

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "koreader-sync/1.0 (RSS Feed Discovery)",
        ...options.headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Attempts to find an RSS/Atom feed via <link rel="alternate"> autodiscovery
 */
async function discoverViaAutodiscovery(blogUrl: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(blogUrl);
    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for link elements with alternate rel and feed mime types
    const feedLink = $('link[rel="alternate"]').filter((_, el) => {
      const type = $(el).attr("type")?.toLowerCase() || "";
      return FEED_MIME_TYPES.some((mime) => type.includes(mime));
    }).first();

    const href = feedLink.attr("href");
    if (href) {
      // Resolve relative URLs to absolute
      return new URL(href, blogUrl).href;
    }

    return null;
  } catch (error) {
    logger.debug({ error, blogUrl }, "Autodiscovery failed");
    return null;
  }
}

/**
 * Probes common feed paths and validates they are actual feeds
 */
async function discoverViaCommonPaths(blogUrl: string): Promise<string | null> {
  const baseUrl = new URL(blogUrl);

  for (const path of COMMON_FEED_PATHS) {
    const feedUrl = new URL(path, baseUrl).href;

    try {
      // Use HEAD first to check existence
      const headResponse = await fetchWithTimeout(feedUrl, { method: "HEAD" });
      if (!headResponse.ok) continue;

      // Validate it's actually a feed by trying to parse it
      const feed = await extract(feedUrl, {
        getExtraEntryFields: () => ({}),
      });

      if (feed && feed.title) {
        logger.debug({ feedUrl }, "Found valid feed at common path");
        return feedUrl;
      }
    } catch {
      // Continue to next path
      continue;
    }
  }

  return null;
}

/**
 * Checks if sitemap.xml exists as a fallback
 */
async function discoverSitemap(blogUrl: string): Promise<string | null> {
  const baseUrl = new URL(blogUrl);
  const sitemapUrl = new URL("/sitemap.xml", baseUrl).href;

  try {
    const response = await fetchWithTimeout(sitemapUrl, { method: "HEAD" });
    if (response.ok) {
      return sitemapUrl;
    }
  } catch {
    // Sitemap not available
  }

  return null;
}

/**
 * Discovers RSS/Atom feed or sitemap for a blog URL using a waterfall strategy:
 * 1. Autodiscovery via <link rel="alternate">
 * 2. Probing common feed paths (/feed, /rss.xml, etc.)
 * 3. Fallback to sitemap.xml
 */
export async function discoverFeed(blogUrl: string): Promise<DiscoveryResult> {
  logger.info({ blogUrl }, "Starting feed discovery");

  // Ensure URL has protocol
  const normalizedUrl = blogUrl.startsWith("http") ? blogUrl : `https://${blogUrl}`;

  // Step 1: Try autodiscovery
  const autodiscoveredFeed = await discoverViaAutodiscovery(normalizedUrl);
  if (autodiscoveredFeed) {
    logger.info({ feedUrl: autodiscoveredFeed }, "Feed found via autodiscovery");
    return { type: "rss", feedUrl: autodiscoveredFeed };
  }

  // Step 2: Try common paths
  const commonPathFeed = await discoverViaCommonPaths(normalizedUrl);
  if (commonPathFeed) {
    logger.info({ feedUrl: commonPathFeed }, "Feed found via common paths");
    return { type: "rss", feedUrl: commonPathFeed };
  }

  // Step 3: Fallback to sitemap
  const sitemapUrl = await discoverSitemap(normalizedUrl);
  if (sitemapUrl) {
    logger.info({ sitemapUrl }, "Sitemap found as fallback");
    return { type: "sitemap", sitemapUrl };
  }

  logger.warn({ blogUrl }, "No feed or sitemap found");
  return { type: "none" };
}
