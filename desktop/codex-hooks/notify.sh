#!/bin/bash
# Codex notify hook script for Constellagent.
# Called by Codex `notify` after a turn finishes.

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
"$SCRIPT_DIR/../agent-hooks/emit-event.sh" codex awaiting_user

# Clear Codex-specific activity markers for this workspace.
ACTIVITY_DIR="${CONSTELLAGENT_ACTIVITY_DIR:-/tmp/constellagent-activity}"
rm -f "$ACTIVITY_DIR/$WS_ID.codex."*

# Legacy cleanup: remove old shared marker only if Claude isn't marked active.
if [ ! -f "$ACTIVITY_DIR/$WS_ID.claude" ]; then
  rm -f "$ACTIVITY_DIR/$WS_ID"
fi
exit 0
