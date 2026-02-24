#!/bin/bash
# Emit a normalized Constellagent turn event.
# Usage: emit-event.sh <agent> <turn_event_type>

AGENT="$1"
TURN_EVENT_TYPE="$2"
WS_ID="${AGENT_ORCH_WS_ID:-}"
SESSION_ID="${AGENT_ORCH_SESSION_ID:-}"

[ -z "$AGENT" ] && exit 0
[ -z "$TURN_EVENT_TYPE" ] && exit 0
[ -z "$WS_ID" ] && exit 0

EVENT_DIR="${CONSTELLAGENT_AGENT_EVENT_DIR:-/tmp/constellagent-agent-events}"
mkdir -p "$EVENT_DIR"
TARGET="$EVENT_DIR/$(date +%s%N)-$$"
TMP_TARGET="${TARGET}.tmp"
printf '{"schema":1,"agent":"%s","workspaceId":"%s","sessionId":"%s","type":"%s"}\n' "$AGENT" "$WS_ID" "$SESSION_ID" "$TURN_EVENT_TYPE" > "$TMP_TARGET"
mv "$TMP_TARGET" "$TARGET"
