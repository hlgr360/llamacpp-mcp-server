#!/usr/bin/env bash
# PreToolUse gate on Read: nudges Claude toward the local_llm_* file-aware tools
# (local_llm_review_file / explain_file / analyze_files) instead of reading a
# whole file into its own context, IF the local LLM server is actually reachable.
#
# Enforcement: hard deny on the first Read of a given file per session, one
# retry allowed -- if Claude reads the same exact path again this session
# (e.g. because it genuinely needs to Edit it), that second Read goes through.
#
# Fails open (allows the Read) whenever the local LLM server isn't running,
# so this never breaks a project that just doesn't have it up.

set -euo pipefail

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"')

allow() { printf '{}'; exit 0; }

[ -z "$file_path" ] && allow

# Skip low-value/binary/dependency targets -- not what local_llm's file tools are for.
case "$file_path" in
  */node_modules/*|*/.git/*|*/dist/*|*/build/*|*/vendor/*|*/.venv/*) allow ;;
  *.lock|*package-lock.json|*yarn.lock|*pnpm-lock.yaml) allow ;;
  *.png|*.jpg|*.jpeg|*.gif|*.pdf|*.ico|*.woff|*.woff2|*.ttf|*.min.js|*.map) allow ;;
esac

# Skip tiny files -- a 60-180s local-model round trip isn't worth it (per local-llm-mcp's
# own memory: "skip the offload for trivial/mechanical lookups... single small file").
size=$(wc -c < "$file_path" 2>/dev/null || printf 0)
[ "${size:-0}" -lt 300 ] && allow

STATE_DIR="/tmp/claude-local-llm-gate"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${session_id}.seen"
touch "$STATE_FILE"

# Already denied once this session -- let the retry through.
grep -qF "$file_path" "$STATE_FILE" 2>/dev/null && allow

# Connectivity gate: only enforce if a local LLM server is actually up.
BASE_URL="${LOCAL_LLM_BASE_URL:-http://localhost:8080}"
curl -sf --max-time 1 "$BASE_URL/v1/models" >/dev/null 2>&1 || allow

printf '%s\n' "$file_path" >> "$STATE_FILE"

jq -n --arg reason "Use a local_llm_* tool first (local_llm_review_file, local_llm_explain_file, or local_llm_analyze_files) -- it reads this file server-side at a fraction of the token cost of Read. If you already need this exact Read (e.g. right before an Edit), retry it once and it will go through." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
