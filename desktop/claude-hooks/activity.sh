#!/bin/bash
# Claude Code UserPromptSubmit hook for Constellagent
# Touches a marker file so the app knows this workspace has an active Claude session.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

ACTIVITY_DIR="${CONSTELLAGENT_ACTIVITY_DIR:-/tmp/constellagent-activity}"
mkdir -p "$ACTIVITY_DIR"
touch "$ACTIVITY_DIR/$WS_ID.claude"
exit 0
