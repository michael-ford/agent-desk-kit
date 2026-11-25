#!/bin/bash
# Paseo provider launch wrapper for a Telegram-connected agent.
#
#   ~/.paseo/config.json  agents.providers.claude-<bot>.command =
#       ["/path/to/agent-desk-kit/bridge/claude-bot.sh", "<bot>"]
#   (or point the provider at a per-agent shim that execs this; see agents/)
#
# Paseo drives Claude Code headless (Agent SDK, stream-json). In that mode
# channels don't deliver inbound messages and plugin MCP servers aren't
# started, so Telegram is split: bridge.ts polls inbound and sends it in
# through paseo-agent-send.sh, and this wrapper gives the session the
# send-only tools (outbound-mcp.ts, MCP server name "telegram").
#
# Paseo also calls the provider command for probes (`--version`, auth status);
# only the real session launch (the SDK passes --input-format) gets the extras.
#
# Per-bot extra flags come from bots.json "extraArgs" (e.g. ["--chrome"]).
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
CLAUDE="${CLAUDE_BIN:-$(command -v claude)}"
BUN="${BUN_BIN:-$(command -v bun)}"
DIR="$(cd "$(dirname "$0")" && pwd)"
BOTS_JSON="${BOTS_JSON:-$DIR/bots.json}"

BOT="${1:?usage: claude-bot.sh <bot> <claude args...>}"; shift

is_session=0
for a in "$@"; do
  [[ "$a" == --input-format* ]] && is_session=1
done
[[ $is_session -eq 1 ]] || exec "$CLAUDE" "$@"

# Slow stdio MCP servers need a real boot window.
export MCP_TIMEOUT=60000 MCP_TOOL_TIMEOUT=120000

EXTRA=()
while IFS= read -r arg; do
  [[ -n "$arg" ]] && EXTRA+=("$arg")
done < <(python3 -c "import json,sys;[print(a) for a in json.load(open(sys.argv[1])).get(sys.argv[2],{}).get('extraArgs',[])]" "$BOTS_JSON" "$BOT" 2>/dev/null || true)

MCP_JSON='{"mcpServers":{"telegram":{"type":"stdio","command":"'"$BUN"'","args":["'"$DIR"'/outbound-mcp.ts","'"$BOT"'"]}}}'
# --mcp-config is variadic, so it MUST stay last or it swallows the SDK's args.
exec "$CLAUDE" ${EXTRA[@]+"${EXTRA[@]}"} "$@" --mcp-config "$MCP_JSON"
