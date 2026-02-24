#!/bin/bash
# Claude Code PreToolUse hook for Constellagent.
# Detects AskUserQuestion tool invocations and forwards to notify hook so
# question dialogs mark the workspace unread and clear active state.

WS_ID="${AGENT_ORCH_WS_ID:-}"
[ -z "$WS_ID" ] && exit 0

INPUT=$(cat)

TOOL_NAME=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // .toolName // .tool.name // .tool?.name // empty' 2>/dev/null)
fi

MATCHED=0
if [ -n "$TOOL_NAME" ]; then
  case "$(printf '%s' "$TOOL_NAME" | tr '[:upper:]' '[:lower:]')" in
    askuserquestion|ask_user_question|ask-user-question)
      MATCHED=1
      ;;
  esac
fi

# Fallback if payload shape changes but still contains canonical tool name.
if [ "$MATCHED" -eq 0 ] && printf '%s' "$INPUT" | grep -qi 'ask[_-]*user[_-]*question'; then
  MATCHED=1
fi

[ "$MATCHED" -eq 1 ] || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/notify.sh"
