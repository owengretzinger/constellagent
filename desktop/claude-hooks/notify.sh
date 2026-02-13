#!/bin/bash
# Claude Code hook script for Constellagent
# Writes workspace ID to a signal file so the app can show an unread indicator.
# This script is called by Claude Code's Stop and Notification hooks.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

NOTIFY_DIR="/tmp/constellagent-notify"
mkdir -p "$NOTIFY_DIR"
echo "$WS_ID" > "$NOTIFY_DIR/$(date +%s%N)-$$"

ACTIVITY_DIR="/tmp/constellagent-activity"

# Clear Claude-specific activity marker.
rm -f "$ACTIVITY_DIR/$WS_ID.claude"

# Legacy cleanup: remove old shared marker only if no Codex marker remains.
if ! compgen -G "$ACTIVITY_DIR/$WS_ID.codex.*" > /dev/null; then
  rm -f "$ACTIVITY_DIR/$WS_ID"
fi
