#!/bin/bash
# Codex notify handler: captures agent-turn-complete events
# Codex may send JSON or plain text as first argument or on stdin
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/shared.sh"
[ -z "$WS_ID" ] && exit 0

# Codex notify passes payload as first argument or on stdin
if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT=$(cat)
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Detect if payload is valid JSON
IS_JSON=false
if echo "$INPUT" | jq empty 2>/dev/null; then
  IS_JSON=true
fi

# Codex notify payload format (JSON):
#   { "type": "agent-turn-complete",
#     "turn-id": "...",
#     "cwd": "/path/to/project",
#     "input-messages": ["user prompt here"],
#     "last-assistant-message": "assistant response here" }
if [ "$IS_JSON" = true ]; then
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
  SESSION_ID=$(echo "$INPUT" | jq -r '."turn-id" // .session_id // .conversation_id // empty')
  EVENT=$(echo "$INPUT" | jq -r '.type // .event // "agent-turn-complete"')
else
  CWD=""
  SESSION_ID=""
  EVENT="agent-turn-complete"
fi

[ -z "$CWD" ] && CWD=$(pwd)
[ ! -d "$CWD/.constellagent" ] && exit 0

AGENT_TYPE="codex"

case "$EVENT" in
  agent-turn-complete)
    if [ "$IS_JSON" = true ]; then
      # Extract user prompt from input-messages array and assistant response
      USER_MSG=$(echo "$INPUT" | jq -r '(."input-messages" // [])[-1] // empty')
      ASST_MSG=$(echo "$INPUT" | jq -r '."last-assistant-message" // .summary // .message // empty')

      # Write the user prompt as a separate entry if present
      if [ -n "$USER_MSG" ]; then
        USER_INPUT=$(jq -nc --arg msg "$USER_MSG" '$msg | .[:500]')
        write_pending "$CWD" "$AGENT_TYPE" "$SESSION_ID" "UserPrompt" "$USER_INPUT" "" "$TIMESTAMP"
      fi

      # Write the assistant turn
      TOOL_INPUT=$(jq -nc --arg msg "${ASST_MSG:-}" '{summary: (if $msg == "" then null else ($msg | .[:800]) end)}')
    else
      TOOL_INPUT=$(jq -nc --arg msg "$INPUT" '{summary: ($msg | .[:800])}')
    fi
    write_pending "$CWD" "$AGENT_TYPE" "$SESSION_ID" "AssistantTurn" "$TOOL_INPUT" "" "$TIMESTAMP"

    # Output rich AgentFS context for Codex to pick up
    CTX_CONTENT=$(read_agent_context "$CWD")
    if [ -n "$CTX_CONTENT" ]; then
      echo "$CTX_CONTENT" | jq -Rs '{context: .}' 2>/dev/null
    fi
    ;;
  *)
    if [ "$IS_JSON" = true ]; then
      TOOL_INPUT=$(echo "$INPUT" | jq -c '.')
    else
      TOOL_INPUT=$(jq -nc --arg msg "$INPUT" '{message: ($msg | .[:500])}')
    fi
    write_pending "$CWD" "$AGENT_TYPE" "$SESSION_ID" "$EVENT" "$TOOL_INPUT" "" "$TIMESTAMP"
    ;;
esac

exit 0
