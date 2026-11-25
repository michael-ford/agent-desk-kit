# Agent desk kit

A working personal agent setup, packaged so you can build your own:

- **Always-on agents.** A personal assistant and a "desk" per project run as
  long-lived sessions in [Paseo](https://github.com/getpaseo/paseo) on a
  machine that stays on. They keep context, and anything can message them
  without interrupting a turn.
- **Telegram as the front door.** Text any of them from your phone or watch.
  Each agent decides what to send back.
- **A front page.** Your Chrome new tab is a ranked feed of your own sources.
  Every story has a 💬 button that hands it to your assistant. A Triage tab holds
  the day's open items, and a morning edition goes to your e-reader for you to
  answer by voice.
- **Voice to handoff.** Talk a plan through with a voice model, have it commit
  a handoff to a repo, and let the desk pick it up.

Start with [docs/overview.md](docs/overview.md): it has the diagram, a typical
day, and which part to adopt first.

## The parts

| Part | Folder | What it does |
|---|---|---|
| Overview | [`docs/overview.md`](docs/overview.md) | How the pieces fit, a day with it, what to adopt first. |
| Always-on agents | [`agents/`](agents/) | The pattern (assistant + per-project desks + short-lived workers), a provider shim that loads each agent's own instructions, a persona template, a trigger script for schedules and buttons, and a health check. |
| Telegram bridge | [`bridge/`](bridge/) | Telegram ↔ Paseo: an inbound poller per bot, send-only reply tools for the agent, an idle-safe send that every caller uses, a launchd installer. Bun + TypeScript, with tests. |
| Front page | [`front-page/`](front-page/) | Chrome new-tab extension, triage app, morning edition (Kobo or iPad), and the assistant playbooks that feed them. Has its own README and docs. |
| Voice handoff | [`docs/voice-handoff.md`](docs/voice-handoff.md) | The talk → handoff file → agent loop, with a handoff template. |

## Quick start: text an agent about a project

1. Install [Paseo](https://github.com/getpaseo/paseo), [Bun](https://bun.sh)
   and your agent CLI on a machine that stays on.
2. Make a bot with @BotFather and follow [`bridge/README.md`](bridge/README.md)
   (bots.json, access.json, token).
3. Follow "Set up a project desk" in [`agents/README.md`](agents/README.md).
4. DM the bot.

Then add the front page ([`front-page/README.md`](front-page/README.md)) with
`ASSISTANT_BOT` set, so its buttons and sweeps reach your assistant.

## Personal data

Nothing here is anyone's real configuration. Bot names, ids, paths, profiles
and examples are placeholders. Your `bots.json`, `access.json`, persona files
and logs are git-ignored; keep it that way if you fork this.

## Tests

```bash
cd bridge && bun install && bun test
```

The front page's tests are listed in [`front-page/README.md`](front-page/README.md#tests).

## Licence

MIT, see [`LICENSE`](LICENSE). The new-tab extension is a fork of
[ai-newtab](https://github.com/ThariqS/ai-newtab) by Thariq Shihipar (MIT); its
original licence is in [`front-page/extension/LICENSE`](front-page/extension/LICENSE).
