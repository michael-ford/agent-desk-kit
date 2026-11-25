#!/bin/bash
# Install (or reinstall) the launchd job that runs the inbound poller for one bot.
#   ./install.sh <bot> [label-prefix]     default prefix: com.example
# macOS only. On Linux, run `bun bridge.ts <bot>` under a systemd user service
# with Restart=always instead.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
BOT="${1:?usage: install.sh <bot> [label-prefix]}"
PREFIX="${2:-com.example}"
LABEL="$PREFIX.tg-bridge-$BOT"
BUN="$(command -v bun)" || { echo "bun not found" >&2; exit 2; }
[[ -f "$DIR/bots.json" ]] || { echo "create $DIR/bots.json first (see bots.example.json)" >&2; exit 2; }
python3 -c "import json,sys;sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])) else 1)" "$DIR/bots.json" "$BOT" \
  || { echo "bot \"$BOT\" is not in bots.json" >&2; exit 2; }

mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
JOB_PATH="$(dirname "$BUN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
sed -e "s|__LABEL__|$LABEL|g" -e "s|__BUN__|$BUN|g" -e "s|__DIR__|$DIR|g" \
    -e "s|__BOT__|$BOT|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$JOB_PATH|g" \
    "$DIR/launchd/tg-bridge.plist.template" > "$PLIST"
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL; log: $DIR/logs/$BOT.log"
