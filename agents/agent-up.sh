#!/bin/bash
# Health check for one Telegram-connected Paseo agent. Idempotent, quiet on
# success; run it from cron or launchd every few minutes.
#
#   agent-up.sh <bot> [label-prefix]     default prefix: com.example
#
# Checks: the agent exists in Paseo and isn't archived; the bot's inbound poller
# is alive (restarts its launchd job if not). It never creates a new agent: a
# fresh one would lose the agent's conversation. The agent's own process starts
# lazily on the next prompt, so there is nothing to "boot".
# Exit codes: 0 ok, 2 agent missing/archived or config, 3 poller won't start.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
KIT="${AGENT_DESK_KIT:-$(cd "$(dirname "$0")/.." && pwd)}"
BOTS_JSON="${BOTS_JSON:-$KIT/bridge/bots.json}"
BOT="${1:?usage: agent-up.sh <bot> [label-prefix]}"
JOB="${2:-com.example}.tg-bridge-$BOT"

read -r AGENT_FILE STATE_DIR < <(python3 -c "
import json,os,sys
c=json.load(open(sys.argv[1]))[sys.argv[2]]
print(os.path.expanduser(c['agentIdFile']), os.path.expanduser(c['stateDir']))" "$BOTS_JSON" "$BOT") \
  || { echo "ERROR: bot $BOT not in $BOTS_JSON" >&2; exit 2; }

AGENT="$(cat "$AGENT_FILE" 2>/dev/null || true)"
[[ -n "$AGENT" ]] || { echo "ERROR: no agent id in $AGENT_FILE" >&2; exit 2; }

status="$(paseo inspect "$AGENT" --json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print('archived' if d.get('Archived') else d.get('Status',''))" 2>/dev/null || echo missing)"
case "$status" in
  missing|archived|'') echo "ERROR: agent $AGENT ($BOT) is $status in Paseo" >&2; exit 2 ;;
esac

# A `closed` agent is only a problem if the last send to it failed.
FAILED="${PASEO_SEND_FAILED_DIR:-$HOME/.agent-desk/send-failed}/$BOT"
[[ -f "$FAILED" ]] && echo "WARN: last send to $BOT failed: $(cat "$FAILED")" >&2

PIDFILE="$STATE_DIR/bot.pid"
poller_alive() { local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"; [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }
poller_alive && exit 0

echo "[$(date '+%F %T')] $BOT poller down; kickstarting $JOB" >&2
launchctl print "gui/$(id -u)/$JOB" >/dev/null 2>&1 \
  || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$JOB.plist"
launchctl kickstart -k "gui/$(id -u)/$JOB"
for _ in $(seq 1 20); do poller_alive && exit 0; sleep 1; done
echo "ERROR: $BOT poller not up after kickstart; see $KIT/bridge/logs/$BOT.log" >&2
exit 3
