# Methodology

How the front page gets made: where the sources come from, how they are
gathered, ranked and assembled, and the reasons behind each choice. The reasons
matter more than the code. Most of them came from a specific morning when the
page got something wrong.

There are two pipelines that meet in the morning edition:

1. **The world**: news, releases, security advisories and changelogs, ranked by
   how much they matter to you. Built by the new-tab extension.
2. **Your intake**: everything that arrived for you personally (messages,
   email, meetings, repos, your issue boards), staged as cards that each ask
   one decision. Built by the assistant's ingestion sweep.

---

## 1. The world (the new tab)

### Sources

Every source belongs to a **channel**. A channel is a goal, not a topic: it says
what counts, what the 40 "fit" points measure, how many slots it gets and how
far back it looks. The kit ships four example channels in
`extension/packages/agent-core/channels.ts`:

| Channel | Goal | Window | Slots |
|---|---|---|---|
| AI | the biggest model, inference, agent-engineering and lab news | 3 days | 10 |
| Your work | anything touching what you or your clients run (from the world list): flaws, deprecations, outages, price changes, platform changes | 7 days | 8 |
| Your field | a field you follow (the example is AI for science) | 7 days | 6 |
| Industry & jobs | funding, launches, hiring | 7 days | 6 |

Each source has a **mode**, which decides how it is read:

- `feed`: RSS, Atom or a JSON API, fetched and parsed **in code** by the
  `getFeeds` tool (`feeds.ts`). Only short, date-windowed entries reach the
  model. This is the default whenever a feed exists, because it is cheap,
  complete and can't be misread. Parsers: `xml` (RSS/Atom), `kev` (CISA Known
  Exploited Vulnerabilities), `ghsa` (GitHub advisories), `europepmc`
  (preprint search), `hn` (Hacker News via Algolia).
- `web`: the model fetches the page itself (`web_fetch`). For news pages with
  no feed.
- `chrome`: the extension opens the page in your signed-in Chrome and hands
  over cleaned HTML that the model greps rather than reads whole. For pages
  that block plain fetches, need a login, or are too big for context.

Sources shared by every channel:

- **Hacker News**, every story over 100 points in the window (Algolia's search
  API, so last night's big story is still there in the morning). The model
  places each story in the channel it belongs to.
- **X**, through twitterapi.io: the accounts you follow, batched `from:`
  searches over the last 3 days with at least 20 likes, ranked by likes, capped
  at 60 posts of 280 characters. Never scraping x.com, which returned mostly
  ads.
- **Calendar** (today and tomorrow) and **GitHub notifications** (split into
  "on you" and "following"), both read through Chrome.

The **world list** (`extension/config/world.md`) is the other half of the
input: what you run, depend on and work on. `getFeeds` matches every entry
against it in code and tags it with the labels it touches, and with signal
words (`exploited`, `critical`, `security`, `deprecation`, `pricing`, `credit`,
`outage`), so the model can't overlook a match. Keep it short and specific: a
broad term ("prisma") will match the wrong thing (the PRISMA review
guideline). Have your assistant refresh it weekly.

### Gathering

One build is one agent session:

1. The kickoff message carries the reader profile, the channel definitions,
   the world list, the stories you've already seen, and the recent leads.
2. The model calls `getFeeds` once for all feed sources, `web_fetch` for web
   sources, `getPageHtml` for Chrome sources, and `getXPosts` once.
3. It clusters by event: a release, its coverage, its HN thread and its X
   reaction are one item, with the primary source as the link and the rest as
   chips.
4. It writes `homepage.json`, which is validated against `HomepageData`
   (`homepage-data.ts`) before it is saved. Invalid output is rejected and the
   previous page is kept.

Builds run at fixed local times (06:00 and 18:00 by default), with up to 3
retries 45 minutes apart, and catch up on the first heartbeat after the
computer wakes.

### Ranking

Every item gets an explicit 0 to 100 score:

| Points | For |
|---|---|
| 40 | fit to its channel's goal |
| 20 | actionable for you this week |
| 20 | novelty, decaying with age: up to 20 in the first 24 h, up to 10 at 1 to 3 days, 0 after |
| 10 | source credibility (primary source > reporting > secondhand) |
| 10 | reaction (HN points and comments, X engagement from credible people) |

Low-interest items (ads, consumer features, routine partnership news, drama)
lose 25. The channel only decides where an item goes; it never adds points.

On top of the score:

- **Headlines are written in your terms**, not the announcer's. "Critical PHP
  RCE exploited in the wild: client WordPress sites need the patched release",
  not "Vendor X's coalition discloses PHP flaws".
- **touches**: the world-list labels the story really affects.
- **urgent**: only when you or a client must act by a date (an exploited or
  critical flaw in something on the world list, a deprecation, a price change,
  an expiring credit). Urgent items carry `action.what` and `action.by` and are
  pinned above the lead. At most 5.
- **advisory**: every security item gets a stable id (CVE, GHSA, vendor id or a
  slug) and a severity. Critical and high advisories that touch a world-list
  label with a project slug are sent to the assistant, which can start an
  exposure-assessment session in that project (capped, deduplicated, dry run
  until you turn it on).
- **The lead** is the most important item from the last 48 hours, and never a
  story from the recent-leads list.
- **New first.** A story is "seen" once a tab showed it for 3 seconds and a
  newer build replaced that page; clicking it makes it "read". Seen stories
  collapse into a "Seen before (n)" line; read ones leave. A seen story can
  come back only with an `update` saying what changed.
- **Each channel's slots are a guaranteed share** of new items. A quiet channel
  says so instead of padding; only slots it can't fill pass to channels that
  have more.

### Assembly

The model writes data, not markup. A fixed renderer (`HomepageView.tsx`) draws
the page: the urgent strip, the lead, the channels in their colours, the
sidebar calendar, GitHub at the bottom. Each story has 💬 (comment to your
assistant, which arrives as a trigger and becomes a tracked issue) and 📖 (save
the article to the e-reader).

---

## 2. Your intake (the sweep)

The assistant runs a full sweep three times a day (06:12, 12:33, 17:03). Full
means every source, every time; the time slot only decides how loudly it
speaks. The playbook is [`agent/skills/ingestion-sweep/SKILL.md`](../agent/skills/ingestion-sweep/SKILL.md).

### Sources

Since the last sweep:

- **Meeting transcripts** from a meetings folder (real multi-person meetings
  only; solo voice memos are listed by name, not read).
- **Messages**: chat apps, Slack, anything addressed to you.
- **Email**, unread only (a read email is one you've seen).
- **Repos**: notifications plus a direct check of each watched repo, because
  your own pushes and some PRs never notify you.
- **Lists** you keep (shopping, packing): only items that need a decision.
- **Leftovers**: unresolved cards from earlier pages, each re-checked at its
  source before it is carried.
- **Work-state evidence** that something got done: your sent mail, your
  replies, merged PRs, closed issues, ticked tasks, meetings that happened.
- **Review ledgers** from the last two mornings: any row not closed with
  evidence is raised again.
- **Chases due**: things you're waiting on from other people, by their
  follow-up date.

### Cards

Each candidate becomes one line on `agent/intake/YYYY-MM-DD-intake.md`. The
rules that make a card worth reading on paper:

- **Answerable from the card alone.** Could you decide it in 10 seconds
  without opening anything? The line states the decision you owe, and a
  `context —` sub-bullet gives who asked, what exactly they want, the one or
  two facts needed, a recommendation, the link, and which channels were
  checked.
- **One decision per card.** Discrete choices go in a trailing parenthetical,
  `(approve / request changes)`, which the triage app turns into answer chips
  and voice commands. Never repeat the app's own Done and Drop.
- **Cross-channel check before writing.** A card about a person or topic is
  checked against messages, email (inbox and sent) and the project record for
  the last 14 days. If you already replied, or a decision is recorded, there
  is no card.
- **Carry receipts.** A card carried to the next day gets a "re-checked
  <sources>, still open because <reason>" note. No receipt, no carry.
- **Close on evidence.** When the source shows it's done, the assistant ticks
  it itself and says so in one line. Ambiguous evidence stays open as "looks
  resolved".
- **Don't card what doesn't change your actions**: usage-cap notices, list
  additions, terms-of-service updates, routine automation reports, other
  people's repo activity, and awareness items older than 2 days.
- **If the assistant can do it, the assistant does it**, and reports.

### Speaking

- Morning sweep: silent. It writes the page; the morning edition carries it.
- Midday: silent unless something is urgent today.
- Close: one message offering to go through the intake now or in the morning.

---

## 3. The morning edition

Runs inside the extension's background worker, once a day between 06:00 and
noon (`lib/morning.ts`):

1. It waits for the 06:00 build and for today's intake page to stop changing
   for 3 minutes (the sweep has finished). At 06:40 it goes with whatever it
   has.
2. **Articles**: the 8 best new items by score, skipping seen and read items,
   social and video links (X, YouTube, HN, Reddit, LinkedIn, Bluesky), and
   anything sent in the last 14 days. Each is saved to the Wallabag-compatible
   server, which turns it into a clean EPUB.
3. **Front page**: one EPUB with today's calendar, every headline on the page
   numbered 1..N (the ones sent as articles marked `[Kobo]`) and every open
   triage card numbered T1..Tn (action cards first, with their options). The
   previous front page is archived once the new one is in. Articles the
   edition created are archived after 7 days; anything you saved yourself is
   never touched.
4. **Markdown copy**: the same numbered lists, written to
   `agent/edition/current.md` in your notes through the triage app, so the
   assistant can resolve "headline 25" exactly as you saw it.

Failures retry every 5 minutes, up to 4 times, then raise a notification.

## 4. The review loop

You answer the edition by number into a voice recorder ("headline 7, follow
up", "T3, drop, it's done", "T5: ask them for the quote first"). The transcript
goes to the assistant, which follows
[`agent/skills/edition-review/SKILL.md`](../agent/skills/edition-review/SKILL.md):

1. Split the transcript into items: every headline, card, comment and question.
2. Write the ledger first (`agent/edition/reviews/YYYY-MM-DD.md`), one row per
   item.
3. Give every row a real action: done with evidence, a task for you, handed
   off, or a numbered question back to you. "Noted" is not an action.
4. The close sweep re-reads the ledger and raises anything not closed.

---

## Why it's built this way

Each of these came from a real failure:

- **Channels instead of topic filters.** A critical, exploited PHP flaw ranked
  #2, but was framed as an AI-lab story, so it read as news rather than "patch
  now". Ranking each channel against its own goal, plus the world list,
  urgent flags and headlines in your terms, fixed the class of problem rather
  than the one story.
- **Vendor feeds for security.** The advisory was on the language's own feed
  three hours before a build that missed it, and never reached the government
  or GitHub advisory feeds. Read the vendors you depend on directly.
- **Typed JSON plus a fixed renderer.** The model once wrote invalid JSX and the
  build failed. Data is validated; markup isn't. The cost: the look can no
  longer be changed by describing it.
- **Fixed build times with retries.** A build failed when the laptop slept, and
  the old "every 12 hours since the last try" schedule left yesterday's page up
  all morning.
- **A build stamp and self-reload.** Two rounds of fixes never went live because
  the extension wasn't reloaded after `pnpm build`. The page footer shows which
  build is running, and the worker reloads itself when a newer one is on disk.
- **Seen memory.** The same week-old story sat in the same slot for six days,
  because every build started from scratch and slow channels refilled with the
  same items.
- **Novelty decay and a recent-leads list.** A big story led the page for days.
- **Feeds parsed in code, trimmed social input.** A build died silently when
  full HN comment threads and 120 X posts filled the context window.
- **Cards that stand alone.** A card that said "three questions on the repo
  thread" could not be answered on paper. On one morning 77 of 91 cards were
  closed as noise; that produced the never-card list and the cross-channel
  check.
- **A ledger for the voice review.** Questions asked in a voice note were lost
  because nothing tracked them. Every item now gets a row and an action.
