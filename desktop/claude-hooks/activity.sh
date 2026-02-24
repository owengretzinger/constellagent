#!/bin/bash
# Claude Code UserPromptSubmit hook for Constellagent.
# Emits a normalized turn_started event.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" claude turn_started

exit 0
