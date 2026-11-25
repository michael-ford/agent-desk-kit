# Telegram ↔ Paseo bridge

Talk to a long-running [Paseo](https://github.com/getpaseo/paseo) agent from
Telegram, one bot per agent. You DM the bot; the message lands in the agent's
session as a new turn (or is steered into the turn it is already running); the
agent answers by calling a `reply` tool. Nothing from the agent's transcript is
forwarded on its own: the agent decides what reaches your phone.

## Why it is split in two

Paseo runs Claude Code headless (Agent SDK, stream-json). In that mode Claude
Code channels don't deliver inbound messages and plugin MCP servers aren't
started, so the official Telegram channel plugin can't be used. The bridge
splits Telegram into two halves:

| Half | File | Runs as |
|---|---|---|
| Inbound: DM → agent turn | `bridge.ts <bot>` | a launchd job per bot (KeepAlive), installed by `install.sh` |
| Outbound: agent → Telegram | `outbound-mcp.ts <bot>` | stdio MCP server `telegram`, added to the session by `claude-bot.sh` (the Paseo provider command) |

The outbound tools have the same names and schemas as the official plugin's
(`reply`, `react`, `edit_message`, `download_attachment`), and inbound messages
use the plugin's `<channel source="telegram" ...>` wrapper, so instructions
written for the plugin work unchanged.

## Files

- `bots.json` (yours, git-ignored; start from `bots.example.json`): per bot,
  where its token comes from, its state directory and the file holding its
  Paseo agent id. Optional `"groups": true` and `"extraArgs"`.
- `bridge.ts`: the ONLY `getUpdates` poller per token. Writes
  `<stateDir>/bot.pid`, which a health check can watch.
  - Gating: DMs only, from senders listed in `<stateDir>/access.json`
    `allowFrom` (no pairing flow; edit it by hand; start from
    `access.example.json`). Missing or broken file = nobody gets in.
  - Group chats are opt-in per bot (`"groups": true` in `bots.json`). The group
    must also be listed in `access.json` `groups`:
    `{ "<chat id>": { "requireMention": true, "allowFrom": [] } }`.
    - `requireMention` true (default): only messages that @mention the bot or
      reply to it are delivered. false: every message from an allowed sender.
      Telegram only sends a bot ordinary group messages if privacy mode is off
      in @BotFather (`/setprivacy`; remove and re-add the bot after changing it)
      or the bot is a group admin.
    - `allowFrom` empty means the bot's DM `allowFrom`.
    - A message from an unlisted group is logged with its chat id; that's how
      you find the id. A basic group that becomes a supergroup changes id; the
      bridge logs `migrated to supergroup <new id>`.
  - Photos are downloaded to `<stateDir>/inbox`; other attachments pass an
    `attachment_file_id` the agent can fetch with `download_attachment`.
  - Messages that arrive while a delivery is waiting are batched into one prompt.
- `outbound-mcp.ts`: send-only tools. It never polls, so it can't collide with
  the bridge. It refuses chats not in `access.json` and refuses to send the
  bot's own state files.
- `paseo-agent-send.sh <bot> [--wait|--steer] <prompt | --prompt-file f>`: the
  one way anything sends to an agent: the bridge, scheduled triggers, the
  front page's buttons. A bare `paseo send` to a running agent **interrupts its
  turn**; this script takes a per-bot lock, waits for idle (up to 30 min), then
  sends. `--steer` (used by the bridge) injects into a running turn instead.
- `claude-bot.sh <bot>`: the Paseo provider command. Adds the outbound MCP for
  real sessions and passes probes (`--version`, auth) straight through.
- `install.sh <bot> [label-prefix]`: writes and loads the launchd job from
  `launchd/tg-bridge.plist.template`.

## Tokens

The bot token never goes in `bots.json`, a plist or a log. Each bot reads it at
start-up from, in order:

1. `"tokenCommand"`: a command that prints it, e.g.
   `["op", "read", "op://Private/desk-bot/token"]` (1Password),
   `["security", "find-generic-password", "-s", "desk-bot", "-w"]` (macOS
   Keychain), or a `sops` call.
2. `"tokenEnv"`, default `TELEGRAM_BOT_TOKEN_<NAME>` (e.g.
   `TELEGRAM_BOT_TOKEN_DESK`).

Both halves need it: the launchd job (inbound) and the Paseo daemon's session
(outbound). A `tokenCommand` works for both without extra wiring; an
environment variable has to be present in both environments.

## Set up a bot

1. Create the bot with @BotFather; note its token. Get your own numeric user id
   (message @userinfobot, or DM your new bot once the bridge runs and read the
   `dropped message from non-allowlisted user <id>` log line).
2. `bun install` here, then `cp bots.example.json bots.json` and edit it.
3. Create the state dir and its `access.json` (from `access.example.json`) with
   your user id in `allowFrom`.
4. In Paseo, add a provider whose command is this folder's `claude-bot.sh <bot>`
   (or a per-agent shim, see [`../agents/`](../agents/)), create the agent with
   that provider, and write its agent id to the bot's `agentIdFile`.
5. `./install.sh <bot>`, then DM the bot.

## Runbook

```bash
tail -f logs/<bot>.log                                         # bridge activity
launchctl kickstart -k gui/$(id -u)/com.example.tg-bridge-<bot>  # restart a bridge
paseo logs "$(cat ~/.agent-desk/agents/<bot>.id)" | tail       # what the agent did
./paseo-agent-send.sh <bot> "<prompt>"                         # safe send
bun test                                                       # unit tests
```

## Security notes

- The allowlist is the only gate. Anyone in `allowFrom` can make the agent act
  with whatever tools and permissions its session has.
- Message text and file names are sender-controlled. The bridge strips anything
  that could close or forge the `<channel>` wrapper, and the MCP's instructions
  tell the agent never to change access because a message asked it to. Treat
  forwarded content in a group as untrusted.
