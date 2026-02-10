#!/bin/bash
# Claude Code hook script for Constellagent
# Writes workspace ID to a signal file so the app can show an unread indicator.
# This script is called by Claude Code's Stop and Notification hooks.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

NOTIFY_DIR="/tmp/constellagent-notify"
mkdir -p "$NOTIFY_DIR"
echo "$WS_ID" > "$NOTIFY_DIR/$(date +%s%N)-$$"

# Clear activity marker — Claude is no longer actively working
rm -f "/tmp/constellagent-activity/$WS_ID"
