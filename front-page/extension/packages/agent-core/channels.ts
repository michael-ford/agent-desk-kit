/**
 * The four channels. EDIT ME: these are worked examples (AI, your work, a field
 * you follow, your industry and jobs). Each one ranks items against
 * its own goal, has its own sources and its own number of slots. The prompt's
 * channel section, the getFeeds tool, the validator's caps and the renderer all
 * read from here, so a channel is defined once.
 *
 * Channels set colour and placement only. They never add to a score.
 */

/**
 * Channel keys. To rename or add a channel, change this list and the CHANNELS
 * entries below; the schema, prompt and renderer all read from here.
 */
export const CHANNEL_KEYS = ["ai", "work", "field", "career"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

/**
 * How a source is read:
 * - feed: fetched and parsed in code by the getFeeds tool (RSS/Atom/JSON), so
 *   only short, date-windowed entries reach the model's context.
 * - web: the model web_fetches the page.
 * - chrome: the page is too big for context or blocks plain fetches, so it goes
 *   through getPageHtml (the reader's Chrome) and is grepped, not read whole.
 */
export type SourceMode = "feed" | "web" | "chrome";

/** The parser getFeeds uses for a feed source. */
export type FeedFormat = "xml" | "kev" | "ghsa" | "europepmc" | "hn";

export interface Source {
  name: string;
  url: string;
  mode: SourceMode;
  /** Required when mode is "feed". */
  format?: FeedFormat;
  /** Entries kept from this feed (default ENTRIES_PER_FEED in feeds.ts). */
  cap?: number;
}

export interface Channel {
  key: ChannelKey;
  label: string;
  colour: string;
  /** Item slots on the page (the lead and urgent items count toward their channel). */
  slots: number;
  /** Feed entries older than this are dropped before the model sees them. */
  windowDays: number;
  /** What counts, in your own words. */
  counts: string;
  /** What the 40 "fit" points measure in this channel. */
  rankedBy: string;
  sources: Source[];
}

/** Europe PMC preprint search, newest first. `{from}` and `{to}` are filled with dates at fetch time. */
function europePmc(query: string): string {
  const q = `(${query}) AND SRC:PPR AND FIRST_PDATE:[{from} TO {to}]`;
  return `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=25&resultType=lite&sort=${encodeURIComponent("P_PDATE_D desc")}`;
}

export const CHANNELS: readonly Channel[] = [
  {
    key: "ai",
    label: "AI",
    colour: "#1f5fbf",
    slots: 10,
    windowDays: 3,
    counts:
      "Models of every kind: frontier, open-weight (DeepSeek, Qwen, GLM, Llama, Mistral), world models, " +
      "decision models, small and specialist models. Inference and providers: new hosts, price and speed " +
      "changes, outages. Agent engineering: coding agents, agent SDKs, MCP. " +
      "Lab safety, security and usage-policy news.",
    rankedBy: "how big the story is, and whether the reader would use it this month",
    sources: [
      { name: "OpenAI", url: "https://openai.com/news/", mode: "web" },
      { name: "Anthropic", url: "https://www.anthropic.com/news", mode: "web" },
      { name: "Google DeepMind", url: "https://deepmind.google/discover/blog/", mode: "web" },
      { name: "Meta AI", url: "https://ai.meta.com/blog/", mode: "web" },
      { name: "xAI", url: "https://x.ai/news", mode: "web" },
      { name: "Mistral", url: "https://mistral.ai/news", mode: "web" },
      { name: "Poolside", url: "https://poolside.ai/blog", mode: "web" },
      { name: "OpenRouter", url: "https://openrouter.ai/announcements", mode: "web" },
      { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", mode: "feed", format: "xml" },
      { name: "Together AI", url: "https://www.together.ai/blog/rss.xml", mode: "feed", format: "xml" },
      { name: "Anthropic status", url: "https://status.anthropic.com/history.rss", mode: "feed", format: "xml" },
      { name: "OpenAI status", url: "https://status.openai.com/history.rss", mode: "feed", format: "xml" },
      { name: "Artificial Analysis", url: "https://artificialanalysis.ai/articles", mode: "chrome" },
      { name: "Groq", url: "https://groq.com/blog", mode: "chrome" },
      { name: "Cerebras", url: "https://www.cerebras.ai/blog", mode: "chrome" },
      { name: "Fireworks", url: "https://fireworks.ai/blog", mode: "chrome" },
    ],
  },
  {
    key: "work",
    label: "Your work",
    colour: "#c8501c",
    slots: 8,
    windowDays: 7,
    counts:
      "Anything that touches what the reader or the reader's clients run, or what they depend on (the world " +
      "list below): vulnerabilities, deprecations, outages, price and plan changes, platform changes. Also news " +
      "from the clients' industries and how AI consultancies are selling.",
    rankedBy: "whether it touches something on the world list, and whether it needs action by a date",
    sources: [
      { name: "CISA KEV", url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", mode: "feed", format: "kev" },
      { name: "GitHub advisories (npm)", url: "https://api.github.com/advisories?type=reviewed&ecosystem=npm&per_page=50", mode: "feed", format: "ghsa" },
      { name: "GitHub advisories (PyPI)", url: "https://api.github.com/advisories?type=reviewed&ecosystem=pip&per_page=50", mode: "feed", format: "ghsa" },
      { name: "PHP", url: "https://www.php.net/feed.atom", mode: "feed", format: "xml" },
      { name: "WordPress security", url: "https://wordpress.org/news/category/security/feed/", mode: "feed", format: "xml" },
      { name: "Node.js vulnerabilities", url: "https://nodejs.org/en/feed/vulnerability.xml", mode: "feed", format: "xml" },
      { name: "Next.js", url: "https://nextjs.org/feed.xml", mode: "feed", format: "xml" },
      { name: "Railway changelog", url: "https://railway.com/changelog/rss.xml", mode: "feed", format: "xml" },
      { name: "Vercel changelog", url: "https://vercel.com/atom", mode: "feed", format: "xml" },
      { name: "Cloudflare changelog", url: "https://developers.cloudflare.com/changelog/rss/index.xml", mode: "feed", format: "xml" },
      { name: "GitHub changelog", url: "https://github.blog/changelog/feed/", mode: "feed", format: "xml" },
      { name: "Docker", url: "https://www.docker.com/blog/feed/", mode: "feed", format: "xml" },
      { name: "Shopify developer changelog", url: "https://shopify.dev/changelog/feed.xml", mode: "feed", format: "xml" },
    ],
  },
  {
    key: "field",
    label: "AI for science",
    colour: "#17865a",
    slots: 6,
    windowDays: 7,
    counts:
      "AI scientists and autonomous labs, evidence synthesis and meta-analysis, peer review and preprints, " +
      "provenance and citation accuracy, clinical guidelines, evals for extraction. " +
      "Company news from these labs counts (awards, hires, programs).",
    rankedBy: "relevance to the reader's side project, a tool that extracts evidence from papers with clickable provenance",
    sources: [
      { name: "Lila Sciences", url: "https://lila.ai/news", mode: "web" },
      { name: "Edison Scientific", url: "https://edisonscientific.com/blog", mode: "web" },
      { name: "Google Research", url: "https://research.google/blog/rss/", mode: "feed", format: "xml" },
      { name: "Cochrane", url: "https://www.cochrane.org/news/rss.xml", mode: "feed", format: "xml" },
      { name: "CPIC", url: "https://cpicpgx.org/feed/", mode: "feed", format: "xml" },
      {
        name: "Preprints: evidence synthesis",
        url: europePmc(
          '(("systematic review" OR "meta-analysis" OR "evidence synthesis" OR "peer review" OR "data extraction") AND ' +
            '("large language model" OR LLM OR "artificial intelligence")) OR "AI scientist"',
        ),
        mode: "feed",
        format: "europepmc",
      },
    ],
  },
  {
    key: "career",
    label: "Industry & jobs",
    colour: "#7a3fc2",
    slots: 6,
    windowDays: 7,
    counts:
      "Funding, acquisitions and launches among AI tooling and agent companies, how AI consultancies and " +
      "agencies are selling, and hiring for applied-AI work (a possible next step for the reader).",
    rankedBy: "whether it changes who the reader could sell to or work for, and whether it is a career signal",
    sources: [
      { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", mode: "feed", format: "xml" },
      { name: "Crunchbase News", url: "https://news.crunchbase.com/feed/", mode: "feed", format: "xml" },
      { name: "Latent Space", url: "https://www.latent.space/feed", mode: "feed", format: "xml" },
      {
        name: "Preprints: example query (edit or remove)",
        url: europePmc('"large language model" AND (agent OR agents) AND (industry OR enterprise)'),
        mode: "feed",
        format: "europepmc",
      },
    ],
  },
];

export function channel(key: ChannelKey): Channel {
  return CHANNELS.find((c) => c.key === key)!;
}

/** Sources every channel draws from. Their entries are tagged "any" and the model places them. */
export const SHARED_FEEDS: readonly Source[] = [
  // Every story above 100 points in the window, not just the current front
  // page, so a big story from overnight is still there in the morning. Algolia's
  // API rather than hnrss.org, which returned 502s on 2026-10-24.
  {
    name: "Hacker News",
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E100,created_at_i%3E{since}&hitsPerPage=200",
    mode: "feed",
    format: "hn",
    cap: 40,
  },
];
