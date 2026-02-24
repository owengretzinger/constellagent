#!/bin/bash
# Emit a normalized Constellagent turn event.
# Usage: emit-event.sh <agent> <turn_event_type> [turn_outcome]

AGENT="$1"
TURN_EVENT_TYPE="$2"
TURN_OUTCOME="$3"
WS_ID="${AGENT_ORCH_WS_ID:-}"
SESSION_ID="${AGENT_ORCH_SESSION_ID:-}"

[ -z "$AGENT" ] && exit 0
[ -z "$TURN_EVENT_TYPE" ] && exit 0
[ -z "$WS_ID" ] && exit 0

case "$TURN_EVENT_TYPE" in
  turn_started|awaiting_user)
    ;;
  *)
    exit 0
    ;;
esac

if [ -n "$TURN_OUTCOME" ]; then
  case "$TURN_OUTCOME" in
    success|failed)
      ;;
    *)
      TURN_OUTCOME=""
      ;;
  esac
fi

# running state has no outcome metadata
if [ "$TURN_EVENT_TYPE" = "turn_started" ]; then
  TURN_OUTCOME=""
fi

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
