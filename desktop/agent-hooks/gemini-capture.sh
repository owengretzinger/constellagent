#!/bin/bash
# Gemini CLI hook: captures structured context
# Events: BeforeAgent, AfterAgent, AfterTool, SessionStart, SessionEnd
# Gemini sends JSON on stdin
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/shared.sh"
[ -z "$WS_ID" ] && exit 0

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TIMESTAMP=$(echo "$INPUT" | jq -r '.timestamp // empty')
[ -z "$TIMESTAMP" ] && TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -z "$CWD" ] && CWD=$(pwd)
[ ! -d "$CWD/.constellagent" ] && exit 0

AGENT_TYPE="gemini"
EVENT=$(echo "$INPUT" | jq -r '.event_name // .hook_event_name // empty')

case "$EVENT" in
  BeforeAgent)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '(.prompt // .input) | if type == "string" then .[:500] else . end')
    write_pending "$CWD" "$AGENT_TYPE" "$SESSION_ID" "UserPrompt" "$TOOL_INPUT" "" "$TIMESTAMP"
    # Inject rich AgentFS context on every user prompt
    CTX_CONTENT=$(read_agent_context "$CWD")
    if [ -n "$CTX_CONTENT" ]; then
      echo "$CTX_CONTENT" | jq -Rs '{context: .}'
      exit 0
    fi
    ;;
  AfterAgent)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '(.response // .output) | if type == "string" then .[:1000] else . end')
    write_pending "$CWD" "$AGENT_TYPE" "$SESSION_ID" "AssistantTurn" "$TOOL_INPUT" "" "$TIMESTAMP"
    ;;
  AfterTool)
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{i: .tool_input}')
    TOOL_RESPONSE=$(echo "$INPUT" | jq -c '.tool_response // null')
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
    write_pending_full "$CWD" "$AGENT_TYPE" "$SESSION_ID" "$TOOL" "$TOOL_INPUT" "$FILE_PATH" "$TIMESTAMP" "AfterTool" "$TOOL_RESPONSE"
    ;;
  SessionStart)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{source: (.source // "startup")}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$SESSION_ID" "SessionStart" "$TOOL_INPUT" "" "$TIMESTAMP" "SessionStart" "null"
    # Inject rich AgentFS context on session start (fallback chain)
    CTX_CONTENT=$(read_agent_context "$CWD")
    if [ -n "$CTX_CONTENT" ]; then
      echo "$CTX_CONTENT" | jq -Rs '{context: .}'
      exit 0
    fi
    ;;
  SessionEnd)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{reason: (.reason // "exit")}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$SESSION_ID" "SessionEnd" "$TOOL_INPUT" "" "$TIMESTAMP" "SessionEnd" "null"
    ;;
  *)
    exit 0
    ;;
esac

# Gemini expects JSON response on stdout
echo '{}'
exit 0
