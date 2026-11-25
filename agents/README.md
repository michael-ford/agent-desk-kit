# Always-on agents in Paseo

The pattern: a few **long-lived agent sessions** that are always reachable,
instead of a fresh chat for every job.

- **One personal assistant**: your inbox, calendar, tasks, notes, the morning
  sweep and the front page's buttons all route to it.
- **One "desk" per project**: lives in the project's directory, knows its repos
  and conventions, and is where you text about that project.
- **Short-lived workers** for real jobs: a desk starts a separate agent for a
  code change or a long piece of research and reports back, so the desk itself
  stays responsive.

[Paseo](https://github.com/getpaseo/paseo) is what keeps them alive. It is an
open-source daemon plus desktop/mobile/web client that runs agent sessions
(Claude Code, Codex, OpenCode, Pi and others) on one machine and lets anything
send them messages. Run it on a machine that stays on (an old laptop or a small
server is enough) and reach it from the app or from Telegram via
[`../bridge/`](../bridge/).

## Files

| File | What it is |
|---|---|
| `desk-claude.example.sh` | Per-agent provider shim: the agent's Telegram tools plus its own instructions (`persona/CLAUDE.md`), loaded so they survive compaction. |
| `persona/CLAUDE.example.md` | Template instructions for a project desk: how the session works, what may go over Telegram, Telegram style. |
| `agent-trigger.sh <bot> <kind> [msg]` | Turns a schedule or a button press into a one-line `[trigger]` prompt that names the skill to follow. Returns at once; delivery waits for the agent to be idle. |
| `agent-up.sh <bot>` | Health check: agent present in Paseo, inbound poller alive (restarts it). Run it every few minutes. |

## Set up a project desk

1. Make the bot and its `bots.json` entry ([`../bridge/README.md`](../bridge/README.md)).
2. Copy `desk-claude.example.sh` and `persona/` into the project (for example
   `<project>/desk/`), set `BOT` in the shim, and fill in
   `persona/CLAUDE.md` from the template.
3. Add a provider to `~/.paseo/config.json`:

   ```json
   {
     "agents": {
       "providers": {
         "claude-desk": {
           "extends": "claude",
           "label": "Project desk (Telegram)",
           "command": ["/abs/path/to/project/desk/desk-claude.sh"]
         }
       }
     }
   }
   ```

4. Create the agent once, in the project directory, and save its id:

   ```bash
   cd /path/to/project
   paseo run --no-wait -q --provider claude-desk --title "Project desk" \
     "You are this project's desk agent. Read persona/CLAUDE.md, then wait for messages." \
     > ~/.agent-desk/agents/desk.id
   ```

   Check the file holds just the id (`paseo ls` lists agents).
5. `../bridge/install.sh desk`, then DM the bot. Add
   `agent-up.sh desk` to cron or launchd.

The personal assistant is the same recipe with its own bot, provider and
persona, pointed at your notes folder instead of a project.

## Things that bite

- **Never `paseo send` straight to a busy agent**: it interrupts the running
  turn. Everything goes through `../bridge/paseo-agent-send.sh`, which waits.
- **Instructions under Paseo** load from `CLAUDE.md` files only.
  `--append-system-prompt-file` and a `--settings` SessionStart hook don't
  reach a Paseo session; use the shim's `--add-dir persona` route.
- **Long sessions compact.** Anything the agent must always know lives in
  `CLAUDE.md` files or skills, not in conversation. A nightly
  `paseo-agent-send.sh <bot> --wait "/compact"` keeps context fresh on your
  schedule instead of mid-task.
- **In-session timers are not durable.** A reminder the agent schedules inside
  its own process is lost when the process restarts. Put recurring jobs in
  cron/launchd calling `agent-trigger.sh`.
- **The agent's permissions are the allowlisted Telegram user's permissions.**
  An agent in bypass mode with your browser and accounts will do what anyone
  on its allowlist asks. Keep allowlists to yourself, and give a desk only the
  tools its project needs.

## Scheduling triggers

```cron
# Ingestion sweep three times a day, project review on weekday mornings
12 6,12,17 * * *  $HOME/agent-desk-kit/agents/agent-trigger.sh assistant sweep
30 8 * * 1-5      $HOME/agent-desk-kit/agents/agent-trigger.sh desk review
*/5 * * * *       $HOME/agent-desk-kit/agents/agent-up.sh assistant
```

Each kind in `agent-trigger.sh` is one line that names a skill; the skill
holds the procedure. The front page's playbooks (`../front-page/agent/`) are
examples of such skills.
