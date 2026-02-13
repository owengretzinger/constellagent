#!/bin/bash
# Codex notify hook script for Constellagent.
# Called by Codex `notify` after the agent finishes a turn.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

NOTIFY_DIR="${CONSTELLAGENT_NOTIFY_DIR:-/tmp/constellagent-notify}"
mkdir -p "$NOTIFY_DIR"
TARGET="$NOTIFY_DIR/$(date +%s%N)-$$"
TMP_TARGET="${TARGET}.tmp"
printf '%s\n' "$WS_ID" > "$TMP_TARGET"
mv "$TMP_TARGET" "$TARGET"

# Clear activity marker — Codex finished this turn.
ACTIVITY_DIR="${CONSTELLAGENT_ACTIVITY_DIR:-/tmp/constellagent-activity}"
rm -f "$ACTIVITY_DIR/$WS_ID"
exit 0
