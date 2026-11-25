#!/bin/bash
# Deliver one prompt to a bot's Paseo agent WITHOUT interrupting a live turn.
#
# Usage: paseo-agent-send.sh <bot> [--wait|--steer] <prompt | --prompt-file PATH>
#   <bot>     key in bots.json; resolves the agent id file
#   --wait    block until the resulting turn finishes (e.g. a nightly /compact)
#   --steer   if the agent is mid-turn, steer the message into that turn
#             instead of waiting for idle (the Telegram bridge uses this, so a
#             message you send mid-task reaches the agent now)
#
# Why this exists: `paseo send` to a RUNNING agent interrupts the in-flight
# turn; it does not queue. Every sender (Telegram bridge, scheduled triggers,
# the new-tab and triage buttons, nightly jobs) goes through this script, which
# serialises senders with a per-bot lock and waits for idle before sending.
# Exit codes: 0 sent, 2 usage/config, 3 lock timeout, 4 send failed.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

DIR="$(cd "$(dirname "$0")" && pwd)"
BOT="${1:?usage: paseo-agent-send.sh <bot> [--wait] <prompt | --prompt-file PATH>}"; shift
WAIT=0
if [[ "${1:-}" == "--wait" ]]; then WAIT=1; shift; fi
STEER=0
if [[ "${1:-}" == "--steer" ]]; then STEER=1; shift; fi
if [[ "${1:-}" == "--prompt-file" ]]; then
  PROMPT="$(cat "${2:?--prompt-file needs a path}")"
else
  PROMPT="${1:?missing prompt}"
fi
[[ -n "$PROMPT" ]] || { echo "empty prompt" >&2; exit 2; }

BOTS_JSON="${BOTS_JSON:-$DIR/bots.json}"
ID_FILE="$(python3 -c "import json,os,sys;c=json.load(open(sys.argv[1]))[sys.argv[2]];print(os.path.expanduser(c['agentIdFile']))" "$BOTS_JSON" "$BOT" 2>/dev/null)" \
  || { echo "unknown bot: $BOT" >&2; exit 2; }
AGENT="$(cat "$ID_FILE" 2>/dev/null || true)"
[[ -n "$AGENT" ]] || { echo "no agent id in $ID_FILE" >&2; exit 2; }

IDLE_TIMEOUT="${PASEO_SEND_IDLE_TIMEOUT:-1800}"   # max wait for the agent to go idle
LOCK_TIMEOUT="${PASEO_SEND_LOCK_TIMEOUT:-2400}"   # max wait for another sender
LOCK="${TMPDIR:-/tmp}/paseo-agent-send.$BOT.lock"

log() { printf '[%s] paseo-agent-send %s: %s\n' "$(date '+%F %T')" "$BOT" "$*" >&2; }

# Send-failure marker for a health check: a Paseo agent showing `closed`
# counts as down only if the last send to it failed (see agents/agent-up.sh).
FAILED_DIR="${PASEO_SEND_FAILED_DIR:-$HOME/.agent-desk/send-failed}"
mark_failed() { mkdir -p "$FAILED_DIR" && printf '%s %s\n' "$(date '+%F %T')" "$*" > "$FAILED_DIR/$BOT" || true; }
clear_failed() { rm -f "$FAILED_DIR/$BOT" || true; }

# --- steer into a running turn (Telegram messages) ----------------------------
# A message you send mid-turn reaches the agent now, not after the turn.
if (( STEER )) && [[ "$(paseo inspect "$AGENT" --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('Status',''))" 2>/dev/null)" == "running" ]]; then
  paseo send --no-wait --behavior steer "$AGENT" --prompt "$PROMPT" >/dev/null \
    || { log "steer failed"; mark_failed "steer failed"; exit 4; }
  clear_failed
  log "steered into running turn"
  exit 0
fi

# --- per-bot lock (mkdir is atomic; owner pid lets us break a stale lock) ---
deadline=$(( $(date +%s) + LOCK_TIMEOUT ))
until mkdir "$LOCK" 2>/dev/null; do
  owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then
    log "breaking stale lock held by dead pid $owner"
    rm -rf "$LOCK"; continue
  fi
  (( $(date +%s) < deadline )) || { log "lock timeout after ${LOCK_TIMEOUT}s"; exit 3; }
  sleep 2
done
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

status() {
  paseo inspect "$AGENT" --json 2>/dev/null \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('Status',''))" 2>/dev/null || true
}

# --- wait for idle -----------------------------------------------------------
if [[ "$(status)" == "running" ]]; then
  log "agent busy; waiting up to ${IDLE_TIMEOUT}s for idle"
  paseo wait "$AGENT" --timeout "$IDLE_TIMEOUT" >/dev/null 2>&1 \
    || log "still busy after ${IDLE_TIMEOUT}s; sending anyway (will interrupt)"
fi

# --- send ------------------------------------------------------------------
if (( WAIT )); then
  paseo send "$AGENT" --prompt "$PROMPT" >/dev/null || { log "send failed"; mark_failed "send failed (--wait)"; exit 4; }
  clear_failed
  log "sent + turn finished"
  exit 0
fi

paseo send --no-wait "$AGENT" --prompt "$PROMPT" >/dev/null || { log "send failed"; mark_failed "send failed"; exit 4; }
clear_failed
# Hold the lock until the daemon reports the turn started, so the next sender's
# idle check can't slip in between accept and start and interrupt it.
for _ in $(seq 1 20); do
  [[ "$(status)" == "running" ]] && break
  sleep 1
done
log "sent"
