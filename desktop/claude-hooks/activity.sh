#!/bin/bash
# Claude Code UserPromptSubmit hook for Constellagent.
# Marks workspace activity and emits a normalized turn_started event.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

ACTIVITY_DIR="${CONSTELLAGENT_ACTIVITY_DIR:-/tmp/constellagent-activity}"
mkdir -p "$ACTIVITY_DIR"
touch "$ACTIVITY_DIR/$WS_ID.claude"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" claude turn_started

exit 0
