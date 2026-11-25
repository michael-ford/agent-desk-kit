# Wallabag-compatible reading server (for a Kobo / KOReader)

A reference copy of the small server the original setup runs to get articles
onto a Kobo. It speaks the part of the Wallabag API that KOReader's built-in
Wallabag plugin uses, plus an EPUB upload endpoint the morning edition needs.
Articles arrive from the new-tab extension, from a Telegram bot, or from
forwarded email. Each one is fetched, cleaned by an LLM and turned into an
EPUB, which KOReader downloads on sync.

**For an iPad you don't need this server.** See [`../docs/ipad.md`](../docs/ipad.md):
the recommended route there delivers straight to Readwise Reader. Use this
server if you read on a Kobo or another KOReader device.

It is a snapshot of the deployed code with deploy details, hosts and secrets
removed. It has no test suite. It was built and smoke-tested from this folder
with Docker: health, OAuth login, auth on the entries API, and refusal to start
without its required settings.

## What it does

```
Telegram bot ─┐                       ┌─ Firecrawl (fetch) ─ LLM via OpenRouter (clean) ─ EPUB
extension ────┼─► HTTP API ─► BullMQ ─┤
email hook ───┘     (Hono)    (Redis) └─ SQLite (entries) + EPUB files on disk
                       ▲
KOReader ──────────────┘  Wallabag API: login, list, download EPUB, archive
```

| Route | Used by | Does |
|---|---|---|
| `POST /oauth/v2/token` | KOReader, extension | password-grant login |
| `GET /api/entries` | KOReader | list unread (or `archive=1`) entries |
| `GET /api/entries/{id}/export.epub` | KOReader | download one EPUB |
| `POST /api/entries` `{url}` | extension (📖 and the morning edition) | save a URL: 201 new, 200 already saved |
| `POST /api/entries/upload` | extension (morning edition) | upload a ready-made EPUB (multipart `file`, `title`, `author`, `tags`). Not part of stock Wallabag |
| `PATCH /api/entries/{id}` `{archive: 1}` | KOReader, extension | archive |
| `DELETE /api/entries/{id}` | KOReader | delete |
| `POST /api/email/inbound` | an inbound-email service | `{from, subject, htmlBody, textBody?, date?, secret}`; turns a newsletter into an article |
| `GET /health` | Railway health check | status and Redis connection |

The Telegram bot (`src/bot/`) accepts URLs, pasted article text, and EPUB, PDF
and Markdown files, and reports each finished article back in the chat.
`/subscribe` records blogs to follow, but this version doesn't poll them yet.

## Settings

All environment variables. See `.env.example`.

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | from @BotFather. The bot is part of the server: without it, it won't start |
| `ALLOWED_USER_IDS` | yes | your Telegram user id (comma-separated for several). Only these users can use the bot, and the first one gets the "article ready" messages |
| `FIRECRAWL_API_KEY` | yes | fetches pages |
| `OPENROUTER_API_KEY` | yes | the cleaning LLM |
| `OPENROUTER_MODEL` | no | default `google/gemini-2.0-flash-001` |
| `OPENROUTER_PROVIDER` | no | pin one OpenRouter provider; otherwise the fastest compatible one |
| `WALLABAG_USERNAME`, `WALLABAG_PASSWORD`, `WALLABAG_CLIENT_ID`, `WALLABAG_CLIENT_SECRET` | yes | the login KOReader and the extension use. Choose your own; set the same four in KOReader's Wallabag plugin and in the extension's Settings → Send to reader |
| `EMAIL_WEBHOOK_SECRET` | yes | shared secret for `/api/email/inbound`. Set a random value even if you never use email |
| `REDIS_URL` | yes in production | default `redis://localhost:6379` |
| `DATABASE_PATH` | no | default `./data/koreader-sync.db` (that is `/app/data/…` in the container) |
| `EPUB_STORAGE_PATH` | no | default `./data/epubs` |
| `BOT_MODE` | no | `polling` (default) or `webhook` |
| `WEBHOOK_URL` | with `webhook` | see below |
| `PORT`, `LOG_LEVEL` | no | Railway sets `PORT` |

## Deploy on Railway

One project with two services and one volume. About fifteen minutes.

1. **Create the project.** New Project → Deploy from GitHub repo, pick your
   copy of this kit, then in the service's Settings set **Root Directory** to
   `wallabag-server`. Railway finds the `Dockerfile` and builds from it. (Or
   install the Railway CLI and run `railway up` from this folder. That uploads
   the folder as it is, and nothing redeploys until you run it again.)
2. **Add Redis.** In the project: New → Database → Redis.
3. **Add a volume** to the app service, mounted at `/app/data`. It holds the
   SQLite database and the EPUBs. Without it, every deploy wipes them.
4. **Variables** on the app service: everything marked required above, plus
   `REDIS_URL=${{Redis.REDIS_URL}}` (a Railway reference to the Redis
   service). Leave `PORT` to Railway.
5. **Networking:** Settings → Networking → Generate Domain. That public HTTPS
   URL is the server URL for KOReader and the extension.
6. **Health check:** Settings → Deploy → Healthcheck Path `/health`.
7. **Keep it to one replica.** SQLite on a volume doesn't share across
   replicas, and two pollers on one bot token conflict.

Check it: `https://<your-domain>/health` should show `"redis":"connected"`.
Then send the bot a URL. When it replies that the article is ready, sync
KOReader.

**Bot mode.** Polling (the default) works on Railway with one replica, and is
the simplest. For webhook mode, set `BOT_MODE=webhook` and
`WEBHOOK_URL=https://<your-domain>/webhook/<bot token>`. The server listens at
`/webhook/<bot token>`, but doesn't register the webhook itself, so register it
once with Telegram's `setWebhook` method. Never run polling and webhook on the
same token at the same time.

**Costs to expect:** Railway usage (one small container, Redis and a volume),
Firecrawl and OpenRouter usage per article. All three are small at a dozen
articles a day; check current prices.

## KOReader

On the Kobo, open KOReader's Wallabag plugin (in the tools menu) and configure
the server. Use the
server URL from step 5 and the four `WALLABAG_*` values. Set a download folder,
then sync. The morning edition's Front page appears as "Front page · <day>".

## Run locally

```bash
cp .env.example .env    # fill it in
docker compose up --build
```

`docker-compose.yml` runs the app and Redis, with data in `./data`. For
development without Docker: `npm install`, then `npm run dev`, using Node 20
(the native SQLite module may not build on newer Node versions).
