# Reading it on an iPad

**Recommendation: deliver to Readwise Reader.** It's built in: Settings → Send
to reader → "iPad / phone (Readwise Reader)", paste your Reader access token,
done.

## Why Reader

Judged on what this setup has to live with: an iPad, a Railway account, no
Tailscale, and no appetite for another thing to administer.

- **Nothing to run.** No server, no Redis, no volume, no bot, no fetch or LLM
  keys. The extension talks to Reader's API directly with one token, stored in
  the extension like the Anthropic key.
- **A good iPad reader.** Offline reading, decent typography, highlights,
  text-to-speech. Reader fetches and cleans each article itself, which is the
  job the Kobo route needs Firecrawl and an LLM for.
- **The front page gets better on a tablet.** It arrives as an HTML document
  with every headline linked to its story, which the Kobo EPUB can't usefully
  do. Numbers, triage cards and options are unchanged, so voice answers work
  the same way.
- **It stays tidy.** The extension archives yesterday's front page, and its own
  articles after 7 days, through Reader's API. Things you saved yourself are
  never touched.
- **The cost is money, not time.** Reader is $7.99 a month billed yearly
  (Reader only; $9.99 with Readwise highlights), with a 30-day free trial
  (Readwise pricing page, 2026-11-20).

## Set it up

1. Start a Reader trial and install the Reader app on the iPad.
2. Copy your access token from https://readwise.io/access_token
3. In the new tab: Settings → Send to reader → Deliver to "iPad / phone
   (Readwise Reader)" → paste the token as "Reader token" → Save reader
   settings.
4. Turn on the morning edition and press "Send morning edition now" to test.
   In Reader, the front page shows up as "Front page · <day> <time>". Everything
   the extension saves is tagged `front-page-kit`; the front page is also
   tagged `front-page`.

The 📖 button on each story saves to Reader too.

## What the code does

All in `extension/apps/extension/lib/kobo.ts` (the names still say Kobo):

| Step | Wallabag (Kobo) | Readwise Reader (iPad) |
|---|---|---|
| Save an article | `POST /api/entries {url}` | `POST https://readwise.io/api/v3/save/ {url, tags}`: 201 new, 200 already saved |
| Front page | EPUB to `POST /api/entries/upload` | `frontPageHtml()` (linked headlines) to the same save endpoint, with `html`, `title`, `should_clean_html: false` and a made-up unique `url` (`https://front-page.invalid/<time>`), which Reader requires |
| Archive | `PATCH /api/entries/{id} {archive: 1}` | `PATCH /api/v3/update/{id}/ {location: "archive"}`; a 404 counts as archived |
| Auth | OAuth password grant | header `Authorization: Token <token>` |

Reader's document ids are strings and Wallabag's are numbers. An id's type
decides which service archives it, so switching services doesn't strand old
entries. Covered by tests in `extension/harness/morning.test.ts` against a fake
Reader API. **It has not yet been run against the real Reader service.** The
first "Send morning edition now" is the live test. Reader's limits (50 saves a
minute) are far above the 9 a morning this sends.

One cosmetic leftover: the markdown copy for the assistant still labels sent
articles `[Kobo]`. Only the numbers matter to the edition review.

## The alternatives, and why not

- **Host the Kobo server on Railway** ([`wallabag-server/`](../wallabag-server/)).
  Railway can run it, but there is no good way to read it on an iPad:
  KOReader doesn't run on iPadOS, and the server only implements the part of
  the Wallabag API that KOReader uses, so the official wallabag iOS app is
  unlikely to work against it (untested). It also adds the admin you want to
  avoid: a service, Redis, a volume, a Telegram bot, and Firecrawl and
  OpenRouter keys. Choose it if you also read on a Kobo, or want no
  subscription.
- **A full Wallabag (self-hosted on Railway, or wallabag.it) with the wallabag
  iOS app.** The articles work. The front page doesn't, because stock Wallabag
  has no EPUB upload; you'd change `uploadFrontPage` to send the HTML as a new
  entry's `content`. It's more to run than Reader, and a weaker reading app.
- **Apple Books.** It reads the EPUB as it is, but nothing puts it there each
  morning without a manual step or a Shortcuts automation. Articles would
  still need another route.
- **A private web page over Tailscale.** It means another network to
  administer, and a page instead of an offline reader. The triage app binds to
  127.0.0.1 on purpose; don't expose it on Railway's public URL.

## Answering on the iPad

Unchanged. Read the front page, record a voice memo answering by number, and
hand the transcript to the assistant (`agent/skills/edition-review`). Because
the headlines link out, you can open a story from the front page before you
answer.
