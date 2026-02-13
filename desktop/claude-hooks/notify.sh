#!/bin/bash
# Claude Code hook script for Constellagent
# Writes workspace ID to a signal file so the app can show an unread indicator.
# This script is called by Claude Code's Stop and Notification hooks.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

NOTIFY_DIR="${CONSTELLAGENT_NOTIFY_DIR:-/tmp/constellagent-notify}"
mkdir -p "$NOTIFY_DIR"
TARGET="$NOTIFY_DIR/$(date +%s%N)-$$"
TMP_TARGET="${TARGET}.tmp"
printf '%s\n' "$WS_ID" > "$TMP_TARGET"
mv "$TMP_TARGET" "$TARGET"

# Clear Claude-specific activity marker.
ACTIVITY_DIR="${CONSTELLAGENT_ACTIVITY_DIR:-/tmp/constellagent-activity}"
rm -f "$ACTIVITY_DIR/$WS_ID.claude"

# Legacy cleanup: remove old shared marker only if no Codex marker remains.
if ! compgen -G "$ACTIVITY_DIR/$WS_ID.codex.*" > /dev/null; then
  rm -f "$ACTIVITY_DIR/$WS_ID"
fi
