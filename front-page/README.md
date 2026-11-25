# Front page kit

A personal "front page" system: a Chrome new tab that an agent rewrites from
your own sources, a daily intake of everything that arrived for you overnight,
and a morning edition of both that lands on an e-reader by 07:00. You read it
with your coffee, answer it by number into a voice recorder, and an assistant
turns every answer into an action.

This repo packages one person's working setup so you can build your own. The
code runs, but the profile, sources, world list and examples are placeholders
for you to replace. Every name, company and piece of content in the examples is
made up.

In this kit the "assistant" is one of the always-on Paseo agents in
[`../agents/`](../agents/): set `ASSISTANT_BOT` and the extension's 💬 button,
the triage app and the sweeps all deliver straight into its session.

## The parts

| Part | Folder | What it does |
|---|---|---|
| New-tab extension | [`extension/`](extension/) | Chrome MV3 extension. A Claude Managed Agents session reads your feeds and pages, scores every story against your profile and world list, and writes the page as typed JSON that a fixed renderer draws. Rebuilds itself at 06:00 and 18:00. |
| Morning edition | [`extension/apps/extension/lib/morning.ts`](extension/apps/extension/lib/morning.ts), [`front-page.ts`](extension/apps/extension/lib/front-page.ts) | Each morning: the top 8 new articles plus one "Front page" (calendar, every headline numbered 1..N, every open triage card numbered T1..Tn). It goes either as an EPUB to a Wallabag-compatible server that a Kobo syncs from, or as linked HTML to Readwise Reader on an iPad. Also writes a markdown copy with the same numbers. |
| Kobo reading server | [`wallabag-server/`](wallabag-server/) | Reference copy of the Wallabag-compatible server the Kobo route uses (Telegram bot, URL→clean EPUB pipeline, KOReader API, EPUB upload), with Railway deploy notes. Not needed for an iPad. |
| Triage app | [`triage/`](triage/) | Local web app (Python stdlib, no build) for working through the day's intake: done, drop, snooze, comment, ask the assistant, hand to the assistant, by keys, buttons or voice. Every action edits one line of a markdown file and commits that path only. The extension embeds it as its Triage view. |
| Assistant playbooks | [`agent/`](agent/) | The instructions the assistant follows: the 3×-daily ingestion sweep that writes the intake cards, the review of your voice answer to the edition, and how it handles comments, questions and security advisories from the other two parts. Written as agent skills (`SKILL.md`). |
| Docs | [`docs/`](docs/) | [Methodology](docs/methodology.md) (where sources come from, how they are gathered, ranked and assembled, and why), [formats](docs/formats.md) (every file and message template), [setup](docs/setup.md) (including where to plug in your own sources) and [iPad delivery](docs/ipad.md) (recommends Readwise Reader). |
| Examples | [`examples/`](examples/) | A synthetic notes folder: an intake page, a morning edition and a review ledger, in the exact formats the code reads and writes. |

## The day

```
06:00  extension builds the page (feeds, pages, X, calendar, GitHub → scored stories)
06:12  assistant's morning sweep writes today's intake page (cards), silently
06:40  morning edition: top 8 articles + numbered Front page → Readwise Reader (iPad) or Wallabag server (Kobo)
       markdown copy of the edition → triage app → notes/agent/edition/current.md
07:00  e-reader syncs; you read it and record answers: "headline 7, follow up", "T3, drop"
       voice note → transcript → assistant runs the edition review: one ledger row
       and one real action per thing you said
day    new tab: News view (💬 comment to the assistant, 📖 send to e-reader)
            Triage view (the intake, worked by keys or voice)
12:33  midday sweep (speaks only for same-day urgent items)
17:03  close sweep (re-checks the review ledger; offers an intake conversation)
18:00  extension rebuilds the page
```

## Quick start

1. Read [docs/methodology.md](docs/methodology.md), then [docs/setup.md](docs/setup.md).
2. Edit `extension/packages/agent-core/reader-profile.ts`,
   `extension/packages/agent-core/channels.ts` and `extension/config/world.md`.
3. `cd extension && pnpm install && pnpm build`, then load
   `extension/apps/extension/.output/chrome-mv3` unpacked in `chrome://extensions`.
4. Start the triage app: `triage/run.sh --open` with `INTAKE_VAULT` pointing at
   your notes folder.
5. Give your assistant the playbooks in `agent/` and schedule its sweeps.
6. In the extension's Settings, choose where to send it (Send to reader), then
   turn on the morning edition.

## What you need

- Chrome (or another Chromium browser), Node 20+, pnpm, and Bun for the tests.
- Python 3.11+ and [uv](https://docs.astral.sh/uv/) for the triage app.
- An Anthropic API key (the extension's builds run as Claude Managed Agents
  sessions billed to it).
- An assistant agent that can run on a schedule, read your sources and edit
  markdown files: any coding-agent harness that loads skills will do. The
  playbooks assume it can read your email, messages, calendar and GitHub; drop
  the sources you don't have.
- Somewhere to read the morning edition: on an iPad, a Readwise Reader
  account (recommended, see [docs/ipad.md](docs/ipad.md)); on a Kobo, a
  Wallabag-compatible server such as [`wallabag-server/`](wallabag-server/).
- Optional: a twitterapi.io key for X, an OpenAI key for the triage app's
  spoken "Talk it through" mode, a Groq or OpenRouter key for voice fallbacks.

## Tests

```bash
cd extension && pnpm typecheck && pnpm test          # 70 tests (Bun)
cd triage && uv run --no-project --python '>=3.11' tests/test_roundtrip.py ../examples/notes/agent/intake/2026-01-15-intake.md
cd triage && uv run --no-project --python '>=3.11' tests/test_voice.py
cd triage && uv run --no-project --python '>=3.11' tests/test_talk.py
cd triage && node --test tests/
```

## Credits and licence

The new-tab extension is a fork of
[ai-newtab](https://github.com/ThariqS/ai-newtab) by Thariq Shihipar, released
under the MIT licence; its original licence is kept in
[`extension/LICENSE`](extension/LICENSE). The fork's changes, the triage app,
the playbooks and the docs are released under the same MIT terms (see
[`LICENSE`](LICENSE)).
