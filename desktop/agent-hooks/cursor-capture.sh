#!/bin/bash
# Cursor hook: captures structured context
# Events: beforeSubmitPrompt, afterFileEdit, beforeShellExecution, afterShellExecution,
#         beforeReadFile, beforeMCPExecution, afterMCPExecution, sessionStart, sessionEnd,
#         preToolUse, postToolUse, subagentStop, preCompact, stop
# Cursor sends JSON on stdin
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/shared.sh"
[ -z "$WS_ID" ] && exit 0

INPUT=$(cat)
CONVERSATION_ID=$(echo "$INPUT" | jq -r '.conversation_id // empty')
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Cursor provides workspace_roots array
CWD=$(echo "$INPUT" | jq -r '.workspace_roots[0] // empty')
[ -z "$CWD" ] && CWD=$(pwd)
[ ! -d "$CWD/.constellagent" ] && exit 0

AGENT_TYPE="cursor"
EVENT=$(echo "$INPUT" | jq -r '.event // .hook_event_name // empty')

case "$EVENT" in
  beforeSubmitPrompt)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '(.prompt // .input) | if type == "string" then .[:500] else . end')
    write_pending "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "UserPrompt" "$TOOL_INPUT" "" "$TIMESTAMP"
    # Inject rich AgentFS context on every user prompt
    CTX_CONTENT=$(read_agent_context "$CWD")
    if [ -n "$CTX_CONTENT" ]; then
      jq -n --arg ctx "$CTX_CONTENT" '{
        hookSpecificOutput: {
          hookEventName: "beforeSubmitPrompt",
          additionalContext: ("Cross-agent context from AgentFS:\n" + $ctx)
        }
      }'
      exit 0
    fi
    ;;
  afterFileEdit)
    FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{file_path: .file_path, edits: [limit(5; .edits[]?) | {old: .old_string[:80], new: .new_string[:80]}]}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "Edit" "$TOOL_INPUT" "$FILE_PATH" "$TIMESTAMP" "afterFileEdit" "null"
    ;;
  beforeShellExecution)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{command: (.command // "" | .[:800]), cwd: (.cwd // "" | .[:200])}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "Bash" "$TOOL_INPUT" "" "$TIMESTAMP" "beforeShellExecution" "null"
    ;;
  afterShellExecution)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{command: (.command // "" | .[:800]), cwd: (.cwd // "" | .[:200])}')
    TOOL_RESPONSE=$(echo "$INPUT" | jq -c '{exit_code: .exit_code, output: (.output // "" | .[:2000])}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "Bash" "$TOOL_INPUT" "" "$TIMESTAMP" "afterShellExecution" "$TOOL_RESPONSE"
    ;;
  beforeReadFile)
    FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty')
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{file_path: .file_path}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "Read" "$TOOL_INPUT" "$FILE_PATH" "$TIMESTAMP" "beforeReadFile" "null"
    ;;
  beforeMCPExecution)
    SERVER=$(echo "$INPUT" | jq -r '.server_name // "mcp"')
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
    TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "mcp__${SERVER}__${TOOL}" "$TOOL_INPUT" "" "$TIMESTAMP" "beforeMCPExecution" "null"
    ;;
  afterMCPExecution)
    SERVER=$(echo "$INPUT" | jq -r '.server_name // "mcp"')
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
    TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
    TOOL_RESPONSE=$(echo "$INPUT" | jq -c '.tool_response // null')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "mcp__${SERVER}__${TOOL}" "$TOOL_INPUT" "" "$TIMESTAMP" "afterMCPExecution" "$TOOL_RESPONSE"
    ;;
  sessionStart)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{source: (.source // "startup")}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "SessionStart" "$TOOL_INPUT" "" "$TIMESTAMP" "sessionStart" "null"
    # Inject rich AgentFS context on session start (fallback chain)
    CTX_CONTENT=$(read_agent_context "$CWD")
    if [ -n "$CTX_CONTENT" ]; then
      jq -n --arg ctx "$CTX_CONTENT" '{
        hookSpecificOutput: {
          hookEventName: "sessionStart",
          additionalContext: ("Cross-agent context from AgentFS:\n" + $ctx)
        }
      }'
    else
      echo '{}'
    fi
    exit 0
    ;;
  sessionEnd)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{reason: (.reason // "exit")}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "SessionEnd" "$TOOL_INPUT" "" "$TIMESTAMP" "sessionEnd" "null"
    ;;
  preToolUse)
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
    TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "$TOOL" "$TOOL_INPUT" "" "$TIMESTAMP" "preToolUse" "null"
    ;;
  postToolUse)
    TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
    TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
    TOOL_RESPONSE=$(echo "$INPUT" | jq -c '.tool_response // null')
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "$TOOL" "$TOOL_INPUT" "$FILE_PATH" "$TIMESTAMP" "postToolUse" "$TOOL_RESPONSE"
    ;;
  subagentStop)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{status: (.status // "completed")}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "SubagentStop" "$TOOL_INPUT" "" "$TIMESTAMP" "subagentStop" "null"
    ;;
  preCompact)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{context_length: (.context_length // null)}')
    write_pending_full "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "PreCompact" "$TOOL_INPUT" "" "$TIMESTAMP" "preCompact" "null"
    ;;
  stop)
    TOOL_INPUT=$(echo "$INPUT" | jq -c '{status: (.status // "completed")}')
    write_pending "$CWD" "$AGENT_TYPE" "$CONVERSATION_ID" "AssistantTurn" "$TOOL_INPUT" "" "$TIMESTAMP"
    ;;
  *)
    exit 0
    ;;
esac

exit 0
