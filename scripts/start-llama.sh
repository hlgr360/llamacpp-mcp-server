#!/usr/bin/env bash
set -euo pipefail

# Convenience launcher for `llama-server` in a background tmux session, with
# sane flags for this MCP bridge (--jinja is on by default in recent builds;
# --reasoning-format deepseek keeps <think> output out of message.content,
# see README.md's "Prompt Templates" section for why that matters).
#
# This is optional — you can just run llama-server yourself with whatever
# flags suit your setup. Everything below is overridable via env vars.

# ── Config (override via env vars) ─────────────────────────────────────────────
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
CTX_SIZE="${CTX_SIZE:-65536}"
PARALLEL="${PARALLEL:-1}"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"
LLAMA_SERVER="${LLAMA_SERVER:-$HOME/repos/github/llama.cpp/build/bin/llama-server}"
LOG_FILE="${LOG_FILE:-/tmp/llama-logs/llama-server.log}"

# ── Model lookup ───────────────────────────────────────────────────────────────
# Example shortcuts only — replace these with whatever models you actually use.
# MODEL_REF must be a HuggingFace repo:tag that `llama-server -hf` can resolve.
MODEL_KEY="${1:-}"
case "$MODEL_KEY" in
  qwen3.6) MODEL_REF="unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_M" ;;
  gemma4)  MODEL_REF="unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"  ;;
  *)
    echo "Usage: $0 <model>" >&2
    echo "Add your own entries to the case block in this script. Examples:" >&2
    echo "  qwen3.6  →  unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_M" >&2
    echo "  gemma4   →  unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"  >&2
    exit 1
    ;;
esac
SESSION_NAME="llama-${MODEL_KEY//./_}"

# ── Cache check ────────────────────────────────────────────────────────────────
REPO="${MODEL_REF%%:*}"
ORG="${REPO%%/*}"
REPO_NAME="${REPO##*/}"
CACHE_DIR="$HF_CACHE/models--${ORG}--${REPO_NAME}"

if [[ ! -d "$CACHE_DIR" ]]; then
  echo "Error: model not found in cache — $REPO" >&2
  echo "Please download it first: hf download $REPO" >&2
  exit 1
fi

# ── Sanity check ───────────────────────────────────────────────────────────────
if [[ ! -x "$LLAMA_SERVER" ]]; then
  echo "Error: llama-server not found: $LLAMA_SERVER" >&2
  echo "Set LLAMA_SERVER to point at your build, e.g.:" >&2
  echo "  LLAMA_SERVER=/path/to/llama-server $0 $MODEL_KEY" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

echo "Starting '$MODEL_KEY' in tmux session '$SESSION_NAME'..."
echo "  Model: $MODEL_REF"
echo "  Addr:  $HOST:$PORT  ctx=$CTX_SIZE  parallel=$PARALLEL"
echo "  Log:   $LOG_FILE"

CMD="LLAMA_CACHE='$HF_CACHE' $LLAMA_SERVER \
  -hf '$MODEL_REF' \
  --spec-type draft-mtp --spec-draft-n-max 3 \
  -ngl 999 -fa on \
  -c $CTX_SIZE --parallel $PARALLEL \
  --host $HOST --port $PORT \
  --reasoning-format deepseek \
  2>&1 | tee -a '$LOG_FILE'"

tmux new-session -d -s "$SESSION_NAME" bash -c "$CMD"
echo "Done. Attach with: tmux attach -t $SESSION_NAME"
