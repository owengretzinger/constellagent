#!/bin/bash
# Claude Code hook script for Constellagent.
# Called by Claude Code Stop + Notification hooks.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" claude awaiting_user

exit 0
