#!/usr/bin/env bash
# Start the intake triage app on http://127.0.0.1:${INTAKE_PORT:-8766}
# Env: INTAKE_VAULT (default ~/vault), INTAKE_PORT, INTAKE_GIT=0, INTAKE_GROQ_SECRET=env:GROQ_API_KEY
set -euo pipefail
cd "$(dirname "$0")"
PORT="${INTAKE_PORT:-8766}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use (already running?). Open http://127.0.0.1:$PORT or set INTAKE_PORT." >&2
  exit 1
fi
if [[ "${1:-}" == "--open" ]]; then (sleep 1 && open "http://127.0.0.1:$PORT") & fi
exec uv run --quiet --no-project --python '>=3.11' server.py
