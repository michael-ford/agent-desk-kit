/**
 * Who the homepage is for and the rules every channel shares. Sent with every
 * build in the kickoff message (not the system prompt), so editing this file and
 * rebuilding the extension takes effect without recreating the agent.
 *
 * The channels themselves (what counts, sources, slots) live in channels.ts, the
 * world list in config/world.md, and the look in the extension's fixed renderer
 * (entrypoints/newtab/components/HomepageView.tsx).
 *
 * EDIT ME. Everything below describes a made-up reader ("Alex", a freelance
 * developer). Replace it with your own: who you are, what you work on, what you
 * run, and which other sources the agent should read. The more concrete the
 * "what you are working on" list, the better the ranking.
 */
import { EXTRA_PER_CHANNEL } from "./homepage-data";

/** Shown in the page header ("Good morning, Alex." · place). Leave either empty to hide it. */
export const READER = { name: "Alex", place: "" };

export const READER_PROFILE = `## Reader profile

Alex (example reader, local time zone). A freelance developer who builds web apps
and AI automations for small local businesses, and has spent the last year
building agent systems with coding agents and MCP servers. Wants to grow the
consulting practice and keep up with AI in science.

What Alex is working on:
- The consulting practice: builds and runs AI agents and web apps for small
  businesses (a shop, a booking site, a trades company). Alex deploys and runs
  these, so a flaw, outage or price change in anything they run on is Alex's
  problem, and so are the clients' own sites.
- A side project: an evidence-extraction tool that pulls findings out of
  scientific papers with provenance you can click back to the source.
- Keeping up with the AI tooling market and who is hiring for applied AI work.

The page has four channels, below. Each channel ranks items against its own goal.
Every item belongs to exactly one channel. The world list says what Alex and the
clients run and depend on; it is how you judge "does this touch the reader".

## Sources outside the channels (every build)

- X: call getXPosts once (days 3, minLikes 20). Recent posts from the accounts
  the reader follows, without ads. Put the best 4-8 posts in the channel they
  belong to (source "X · @handle"), and use matching posts as X chips on other
  items. Skip jokes, ragebait and off-topic posts. Never scrape x.com. (Skip
  this source when getXPosts reports it is not configured.)
- Calendar: getPageHtml https://calendar.google.com/calendar/u/0/r/week . Today's
  and tomorrow's events with times (local time).
- GitHub: getPageHtml https://github.com/notifications . ALL notifications,
  split into "onYou" (assigned, mentioned, review requested, the reader's own
  PR/issue) with the reason, and "following" (threads the reader watches). Skip
  bot noise.

Never include: YouTube, Reddit, NSFW, shopping, or anything from browsing
history. Do not call getHistory.

## Scoring (every channel)

Score every item 0-100, an explicit integer:
- 40: fit to its channel's goal ("ranked by" in the channel)
- 20: actionable for the reader this week
- 20: novelty, which decays with age: published in the last 24h = up to 20;
  1-3 days = up to 10; older = 0. Old news is not news, however big it was.
- 10: source credibility (primary source > reporting > secondhand claim)
- 10: reaction (HN points/comments, X engagement from credible people)
The channel only decides where an item goes. It never adds points. Low-interest
items (advertising products, consumer and teen features, routine partnership
announcements, personality drama) lose 25.

## Rules

- Headlines say what the story means for the reader, in their terms, not how the
  announcer framed it. Bad: "Vendor X's coalition discloses PHP flaws". Good:
  "Critical PHP RCE exploited in the wild: client WordPress sites need the
  patched PHP release".
- touches: the world-list labels the story really affects, spelled exactly as
  in the list. A story about PHP touches every label whose stack runs PHP. Leave
  it empty when nothing on the list is affected; never stretch.
- urgent: true only when the reader or a client should act by a date: an
  exploited or critical flaw in something on the world list, a deprecation or
  shutdown, a price or plan change, an expiring credit. Give action.what
  (imperative) and action.by (YYYY-MM-DD; today if it's "now"). At most 5 urgent
  items. Urgent items are pinned above the lead, from whichever channel they are in.
- advisory: set it on every item about a security flaw (a vulnerability, an
  exploit, a security release). id is the CVE id when there is one, else the
  GHSA id, else the vendor's advisory id, else a short slug of the flaw's own
  name ("php2shell"). Use the same id every build. severity is the vendor's or
  CVSS rating (critical, high, medium, low); when none is given, critical for
  remote code execution or exploitation in the wild, else high. A critical or
  high advisory that touches a world-list project starts an assessment session
  in that project, so set touches with care.
- Cluster by event, not by source: a release, its coverage, its HN thread and
  its X reaction are ONE item. url = the best primary source; the rest become
  chips labelled by source (HN, X, Blog, Docs).
- New first. "Seen by the reader" in the kickoff lists stories already seen or
  read. Don't pick them again. The one exception is a story that has really
  changed since (a new version, a fix, an exploit, a price): include it with
  update set to what changed. A new link to the same story counts as the same
  story.
- Each channel's share is the number of NEW items it gets. Fill it with its best
  new items, then add up to ${EXTRA_PER_CHANNEL} more ranked new items if the channel has
  them; the page shows those only where another channel has nothing new to fill
  its share. A quiet channel stays short; never pad it with weak or seen items,
  and never move an item to a channel it doesn't belong to.
- The lead is the most important item for the reader that was published in the
  last 48 hours, from any channel. Never lead with a story listed under "Recent
  leads".
- alsoSeen: one line on what was dropped and why.
- sources: every source named in this message, with ok and a short note when it
  failed. Never pretend a failed source succeeded.
`;
