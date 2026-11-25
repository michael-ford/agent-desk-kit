#!/bin/bash
# Per-agent Paseo provider shim. Copy it next to the project the agent lives in
# (e.g. <project>/desk/desk-claude.sh), set BOT, and point a Paseo provider at it:
#
#   ~/.paseo/config.json  agents.providers.claude-desk =
#     { "extends": "claude", "label": "Project desk (Telegram)",
#       "command": ["/abs/path/to/desk-claude.sh"] }
#
# Real sessions (the SDK passes --input-format) also get the agent's own
# instructions: persona/CLAUDE.md in an --add-dir directory, with
# CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1, so they load as memory and
# survive compaction. Under Paseo, --append-system-prompt-file and a --settings
# SessionStart hook do not reach the session; use this instead.
# Probes (--version, auth) go through unchanged.
set -euo pipefail
BOT="desk"                                   # the bot's key in bridge/bots.json
KIT="${AGENT_DESK_KIT:-$HOME/agent-desk-kit}" # where you cloned this kit
DIR="$(cd "$(dirname "$0")" && pwd)"

for a in "$@"; do
  if [[ "$a" == --input-format* ]]; then
    export CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1
    # --add-dir is variadic; the SDK's args that follow all start with --, so it takes only this path.
    exec "$KIT/bridge/claude-bot.sh" "$BOT" --add-dir "$DIR/persona" "$@"
  fi
done
exec "$KIT/bridge/claude-bot.sh" "$BOT" "$@"
