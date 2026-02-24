#!/bin/bash
# Emit a normalized Constellagent turn event.
# Usage: emit-event.sh <agent> <turn_event_type> [turn_outcome]

AGENT="$1"
RAW_TURN_EVENT_TYPE="$2"
TURN_OUTCOME="$3"
WS_ID="${AGENT_ORCH_WS_ID:-}"
SESSION_ID="${AGENT_ORCH_SESSION_ID:-}"

[ -z "$AGENT" ] && exit 0
[ -z "$RAW_TURN_EVENT_TYPE" ] && exit 0
[ -z "$WS_ID" ] && exit 0

TURN_EVENT_TYPE=""
case "$RAW_TURN_EVENT_TYPE" in
  turn_started)
    TURN_EVENT_TYPE="turn_started"
    TURN_OUTCOME=""
    ;;
  awaiting_user)
    TURN_EVENT_TYPE="awaiting_user"
    ;;
  # Back-compat aliases: normalize to awaiting_user with outcome metadata.
  turn_completed)
    TURN_EVENT_TYPE="awaiting_user"
    [ -n "$TURN_OUTCOME" ] || TURN_OUTCOME="success"
    ;;
  turn_failed)
    TURN_EVENT_TYPE="awaiting_user"
    [ -n "$TURN_OUTCOME" ] || TURN_OUTCOME="failed"
    ;;
  *)
    exit 0
    ;;
esac

EVENT_DIR="${CONSTELLAGENT_AGENT_EVENT_DIR:-/tmp/constellagent-agent-events}"
mkdir -p "$EVENT_DIR"
TARGET="$EVENT_DIR/$(date +%s%N)-$$"
TMP_TARGET="${TARGET}.tmp"

if [ "$TURN_EVENT_TYPE" = "awaiting_user" ] && [ -n "$TURN_OUTCOME" ]; then
  printf '{"schema":1,"agent":"%s","workspaceId":"%s","sessionId":"%s","type":"%s","outcome":"%s"}\n' \
    "$AGENT" "$WS_ID" "$SESSION_ID" "$TURN_EVENT_TYPE" "$TURN_OUTCOME" > "$TMP_TARGET"
else
  printf '{"schema":1,"agent":"%s","workspaceId":"%s","sessionId":"%s","type":"%s"}\n' \
    "$AGENT" "$WS_ID" "$SESSION_ID" "$TURN_EVENT_TYPE" > "$TMP_TARGET"
fi

mv "$TMP_TARGET" "$TARGET"
