#!/bin/bash
# Codex notify hook script for Constellagent.
# Called by Codex `notify` after a turn finishes.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" codex awaiting_user

exit 0
