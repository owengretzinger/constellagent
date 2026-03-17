#!/bin/bash
# Shared helpers for Constellagent agent hooks
# Source this file from individual capture scripts

WS_ID="${AGENT_ORCH_WS_ID:-}"

get_head() {
  local dir="${1:-.}"
  git -C "$dir" rev-parse HEAD 2>/dev/null || echo ""
}

write_pending() {
  local cwd="$1" agent="$2" sid="$3" tool="$4" input="$5" file="$6" ts="$7"
  local repo="$cwd/.constellagent"
  [ ! -d "$repo" ] && return 0
  local pending_dir="$repo/.pending"
  mkdir -p "$pending_dir"
  local head
  head=$(get_head "$cwd")
  # Default empty input to null so the JSON stays valid
  [ -z "$input" ] && input="null"
  printf '{"ws":"%s","agent":"%s","sid":"%s","tool":"%s","input":%s,"file":"%s","ts":"%s","head":"%s"}\n' \
    "$WS_ID" "$agent" "$sid" "$tool" "$input" "${file:-}" "$ts" "$head" \
    > "$pending_dir/$(date +%s)-$RANDOM.json"
}

write_pending_full() {
  local cwd="$1" agent="$2" sid="$3" tool="$4" input="$5" file="$6" ts="$7" event_type="$8" tool_response="$9"
  local repo="$cwd/.constellagent"
  [ ! -d "$repo" ] && return 0
  local pending_dir="$repo/.pending"
  mkdir -p "$pending_dir"
  local head
  head=$(get_head "$cwd")
  # Default empty input/response to null so the JSON stays valid
  [ -z "$input" ] && input="null"
  [ -z "$tool_response" ] && tool_response="null"
  printf '{"ws":"%s","agent":"%s","sid":"%s","tool":"%s","input":%s,"file":"%s","ts":"%s","head":"%s","event_type":"%s","tool_response":%s}\n' \
    "$WS_ID" "$agent" "$sid" "$tool" "$input" "${file:-}" "$ts" "$head" "${event_type:-}" "$tool_response" \
    > "$pending_dir/$(date +%s)-$RANDOM.json"
}

# Read the best available sliding window context for the current workspace.
# Prefers per-workspace file, falls back to global, then activity.md.
# Usage: CONTEXT=$(read_sliding_window "$CWD")
read_sliding_window() {
  local cwd="$1"
  local repo="$cwd/.constellagent"
  local ws_file="$repo/context/sliding-window-${WS_ID}.md"
  local global_file="$repo/context/sliding-window.md"
  local activity_file="$repo/context/activity.md"

  if [ -n "$WS_ID" ] && [ -f "$ws_file" ]; then
    head -c 4000 "$ws_file"
  elif [ -f "$global_file" ]; then
    head -c 4000 "$global_file"
  elif [ -f "$activity_file" ]; then
    tail -30 "$activity_file"
  fi
}

# Read the rich agent context generated from the AgentFS database.
# Prefers per-workspace agent-context, falls back to global, then sliding window.
# Usage: CONTEXT=$(read_agent_context "$CWD")
read_agent_context() {
  local cwd="$1"
  local repo="$cwd/.constellagent"
  local ws_ctx="$repo/context/agent-context-${WS_ID}.md"
  local global_ctx="$repo/context/agent-context.md"

  if [ -n "$WS_ID" ] && [ -f "$ws_ctx" ]; then
    head -c 6000 "$ws_ctx"
  elif [ -f "$global_ctx" ]; then
    head -c 6000 "$global_ctx"
  else
    # Fall back to sliding window
    read_sliding_window "$cwd"
  fi
}
