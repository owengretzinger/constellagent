#!/bin/bash
# Claude Code hook script for Constellagent.
# Called by Claude Code Stop + Notification hooks.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

# Legacy signal file (older app versions read this).
NOTIFY_DIR="${CONSTELLAGENT_NOTIFY_DIR:-/tmp/constellagent-notify}"
mkdir -p "$NOTIFY_DIR"
TARGET="$NOTIFY_DIR/$(date +%s%N)-$$"
TMP_TARGET="${TARGET}.tmp"
printf '%s\n' "$WS_ID" > "$TMP_TARGET"
mv "$TMP_TARGET" "$TARGET"

# Normalized agent turn event (current app versions read this).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" claude awaiting_user

# Clear Claude-specific activity marker.
ACTIVITY_DIR="${CONSTELLAGENT_ACTIVITY_DIR:-/tmp/constellagent-activity}"
rm -f "$ACTIVITY_DIR/$WS_ID.claude"

# Legacy cleanup: remove old shared marker only if no Codex marker remains.
if ! compgen -G "$ACTIVITY_DIR/$WS_ID.codex.*" > /dev/null; then
  rm -f "$ACTIVITY_DIR/$WS_ID"
fi

exit 0
