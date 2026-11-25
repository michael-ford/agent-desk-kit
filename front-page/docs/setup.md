# Setup

Set the parts up in this order. Each one is useful on its own, so you can stop
after any step.

1. The new tab (an hour, most of it editing your profile and sources)
2. The triage app and a notes folder
3. The assistant and its sweeps
4. The morning edition and the review loop

---

## 1. The new tab

### Make it yours

Three files hold everything personal. Edit them before the first build.

| File | What to put there |
|---|---|
| `extension/packages/agent-core/reader-profile.ts` | `READER` (your name and place, for the page header) and `READER_PROFILE`: who you are, what you work on, what you run, and the sources read every build (X, calendar, GitHub). The scoring rubric and rules live here too. |
| `extension/packages/agent-core/channels.ts` | Your channels: key, label, colour, slots, window, what counts, what "fit" means, and each channel's sources. |
| `extension/config/world.md` | Your world list: deployments, client stacks, dependencies, projects. Override the path with `HOMEPAGE_WORLD_LIST`. |

The profile goes into every build's kickoff message, so editing it and
rebuilding is enough. No agent recreation is needed.

### Plug in your own sources

This is where you will spend most of your time. For each source, pick the
cheapest mode that works:

| You have | Add it as | Notes |
|---|---|---|
| An RSS or Atom feed | `{ name, url, mode: "feed", format: "xml" }` in a channel's `sources` | Best option. Look for `/feed`, `/rss.xml`, `/atom`, or a `<link rel="alternate">` in the page head. |
| A changelog or status page with a feed | same, usually in "Your work" | Status pages (`/history.rss`) and changelogs are the early warning for outages and deprecations. |
| A security feed for something you run | same, or `format: "kev"` / `"ghsa"` for CISA KEV and GitHub advisories | Read the vendor's own feed: advisories often reach it hours or days before the aggregators. |
| A literature search | `format: "europepmc"` with the `europePmc(query)` helper | `{from}` and `{to}` are filled with dates at fetch time. |
| A news page with no feed | `mode: "web"` | The model fetches it. Costs more context than a feed. |
| A page behind a login, or one that blocks bots | `mode: "chrome"` | Read through your signed-in Chrome and grepped. |
| A source every channel shares | `SHARED_FEEDS` in `channels.ts` | Hacker News is the example. |
| A new feed format | a parser in `packages/agent-core/feeds.ts` and a new `FeedFormat` | Keep entries short and date-windowed: the point is to keep raw pages out of the model's context. |
| A personal account page (calendar, notifications) | a line in "Sources outside the channels" in `reader-profile.ts` | Read with `getPageHtml` through Chrome. |
| X | Settings → "X via twitterapi.io": key and your handle | Optional. Read-only, about $0.05 a build. |

Then list the things you run in `config/world.md`, so `getFeeds` can tag
matching entries. Run the tests after editing (`pnpm test`): the
`channels.test.ts` replay checks that a critical PHP advisory gets tagged
against every world-list label whose terms include `php`, so keep at least one
such label or adjust that test.

To rename or add channels, edit `CHANNEL_KEYS` and `CHANNELS` together. The
schema, prompt, validator and renderer all read from them. The tests use the
example keys, so update them too.

### Build and install

```bash
cd extension
pnpm install
pnpm build                     # writes apps/extension/.output/chrome-mv3
pnpm typecheck && pnpm test    # optional
```

In Chrome: `chrome://extensions` → Developer mode → Load unpacked →
`extension/apps/extension/.output/chrome-mv3`. Open a new tab, paste your
Anthropic API key, choose a model in Settings, and build.

After every code change: `pnpm build`, then click reload on the extension
once. The page footer shows the running build; if it says a newer build is on
disk, the worker will reload itself shortly.

**Cost.** One build is one agent session on your API key. Feeds are parsed in
code to keep it small (about 20k tokens of feed entries). Haiku is cheapest;
Sonnet is a good default.

---

## 2. The triage app and a notes folder

Make a notes folder (an Obsidian vault works well) and put it under git:

```bash
mkdir -p ~/notes/agent/intake ~/notes/agent/edition/reviews ~/notes/projects
cd ~/notes && git init && git commit --allow-empty -m init
cp -r <kit>/examples/notes/agent/intake/2026-01-15-intake.md ~/notes/agent/intake/   # to try it
```

Run the app:

```bash
INTAKE_VAULT=~/notes INTAKE_NEWTAB_ORIGIN=chrome-extension://<your extension id> triage/run.sh --open
```

Your extension id is shown in `chrome://extensions`. Without it, the
extension's Triage view can't frame the app and its comment and edition routes
are refused. All settings are environment variables; see
[`triage/README.md`](../triage/README.md). To keep it running, install the
LaunchAgent template in `triage/launchd/`.

Optional voice features:

- Chrome's built-in speech recognition works with no key.
- `GROQ_API_KEY`: Whisper fallback for dictation.
- `OPENROUTER_API_KEY`: LLM fallback for voice commands the grammar doesn't know.
- `OPENAI_API_KEY`: "Talk it through", a spoken pass over the whole page
  (roughly $1 to $2 for 15 minutes).

---

## 3. The assistant

The playbooks in [`agent/`](../agent/) are written as agent skills. Install
them where your agent harness loads skills, then edit the parts marked "EDIT":
your sources, the repos to watch, your boards, and your quiet hours.

What the assistant needs:

- Read access to your sources (email, messages, calendar, repos, task lists).
  Start with two or three; a sweep with fewer sources is still useful.
- Write access to the notes folder, and git.
- A way to reach you (a chat bot, email) for the close-of-day offer and urgent
  items.
- A trigger entry point for the triage app: see
  [`agent/assistant-trigger.sh`](../agent/assistant-trigger.sh). It turns the
  app's `<kind> "<message>"` calls into a prompt for your assistant. With an
  always-on Paseo agent ([`../../agents/`](../../agents/)), set
  `ASSISTANT_BOT=<bot>` in the triage app's environment and the prompt goes
  straight into that agent's session, waiting until it is idle.

Schedule the sweeps (06:12, 12:33, 17:03 local), for example with cron:

```cron
12 6 * * *  /path/to/assistant-trigger.sh sweep
33 12 * * * /path/to/assistant-trigger.sh sweep
3 17 * * *  /path/to/assistant-trigger.sh sweep
```

The morning sweep should finish before about 06:40, when the edition stops
waiting for it.

---

## 4. The morning edition and the review loop

### Where it goes

**On an iPad:** use Readwise Reader. Setup is four steps in [ipad.md](ipad.md),
and needs no server. Skip the rest of this section.

**On a Kobo or other KOReader device:** you need a Wallabag-compatible server
that the device syncs from. [`wallabag-server/`](../wallabag-server/) is the
one the original setup runs, with Railway deploy notes.

### A Wallabag-compatible server (Kobo)

The edition is delivered through a Wallabag-style API that the e-reader syncs
from. KOReader (on Kobo and other devices) has a built-in Wallabag client. The
extension uses:

| Call | Used for |
|---|---|
| `POST /oauth/v2/token` (password grant) | logging in |
| `POST /api/entries` `{url}` | saving an article (201 new, 200 already saved) |
| `POST /api/entries/upload` (multipart EPUB, `title`, `tags`) | uploading the Front page EPUB |
| `PATCH /api/entries/{id}` `{archive: 1}` | archiving old front pages and articles |

The upload endpoint is in [`wallabag-server/`](../wallabag-server/); we don't
believe stock Wallabag has it, so check before relying on another server. If your
server lacks it, either add an equivalent endpoint, or adapt
`uploadEpubToKobo` in `extension/apps/extension/lib/kobo.ts` (for example, post
the front page as an entry with `content` set to the HTML from
`frontPageBody()`). The articles alone work with any Wallabag server.

In the extension: Settings → "Send to reader" → Kobo / KOReader: server URL, username, password,
OAuth client id and secret. Then turn on the morning edition and try "Send
morning edition now". The status line under it shows what was sent.

On the device: point KOReader's Wallabag plugin at the same server, and sync
in the morning.

The edition needs the computer awake between 06:00 and 06:40. If it sleeps, the
edition goes out after that morning's build, any time before noon.

### The voice answer

Read the front page and record your answers by number: "headline 7, save it
for the weekend", "T2, include it", "T4, ask Jordan for a week". Get the
recording transcribed (any recorder app with a cloud folder plus a
transcription step works) and hand the transcript to the assistant, which
follows [`agent/skills/edition-review/SKILL.md`](../agent/skills/edition-review/SKILL.md).

For an iPad instead of an e-reader, see [ipad.md](ipad.md).
