# Changelog

## Version 2.0.0 - llama.cpp backend

### Breaking Changes
- Switched backend from Ollama (`/api/generate`, `localhost:11434`) to llama.cpp's
  `llama-server` (`/v1/chat/completions`, `localhost:8080` by default, overridable via
  `LLAMACPP_BASE_URL`)
- All 11 tools renamed from `ollama_*` to `llamacpp_*`
- Server name changed to `llamacpp-mcp-server`

### Features
- **No hardcoded model**: `DEFAULT_MODEL`/`FALLBACK_MODEL` constants removed. The server
  auto-detects whichever model `llama-server` currently has loaded via `GET /v1/models`
  (cached ~30s), with an optional per-call `model` argument to override
- **Prompts indexed by model family**: new `prompts.js` holds a `DEFAULT_PROMPTS` registry
  per tool plus a sparse `FAMILY_OVERRIDES` map keyed by detected model family (`gemma`,
  `qwen`, `deepseek`, `llama`, `mistral`, `phi`, `codestral`, `generic`)
- **Structured chat requests**: tool calls now send `{system, user}` messages through
  `/v1/chat/completions` instead of hand-built raw prompt strings, letting `llama-server`
  (with `--jinja`) apply the loaded model's own chat template
- New `llamacpp_server_info` tool: reports loaded model id/family, context size, slot
  count, and chat-template presence
- **Automated test suite**: `npm test` (`node --test`) covers model resolution/caching,
  prompt building, file-aware tools, and the real MCP `tools/list`/`tools/call` routing
  against a mocked `llama-server`, no real model or network needed. `index.js` now exports
  `LlamaCppServer` and only auto-starts when run directly, so it's importable by tests
- **`AGENTS.md`**: priming notes for coding agents working in this repo
- New `llamacpp_session_stats` tool: reports cumulative prompt/completion/total token usage
  sent to/from `llama-server` so far in this session, with a per-tool breakdown, based on
  the `usage` field `llama-server` returns per request
- **`scripts/start-llama.sh`**: optional convenience launcher for `llama-server` in a
  background `tmux` session, with a small model-name → HuggingFace-repo lookup table
- **ESLint**: flat config with `@eslint/js`'s recommended ruleset only (no style/formatting
  rules), run via `npm run lint`. Fixed everything it flagged, including 7 re-thrown errors
  that now pass `{ cause: error }` so the original stack isn't lost
- Added a `bin` entry (`llamacpp-mcp-server` → `index.js`) in preparation for publishing to
  npm. `npx github:hlgr360/llamacpp-mcp-server` was tried as a no-clone, no-publish alternative but
  doesn't work: npm's git-dependency install path closes piped stdin immediately, breaking
  any stdio-based MCP server. A real npm registry publish is still the plan.
- Repo transferred from `klopotek-rein` to `hlgr360` on GitHub, ahead of publishing to npm
  under the same personal account

### Notes
- `--jinja` is enabled by default on recent `llama-server` builds (no longer needs passing
  explicitly, though it's harmless to)
- Reasoning models (Qwen3.x, DeepSeek-R1/-V3.x) need `--reasoning-format deepseek` on
  `llama-server`, otherwise `<think>` output leaks into `message.content` — the only field
  `callLlamaCpp` reads

## Version 1.0.0 - Initial Release

### Features

#### Core MCP Server
- Implemented MCP server using `@modelcontextprotocol/sdk`
- Ollama integration via HTTP API (localhost:11434)
- Default model: `gemma3:27b` with `gemma3:4b` fallback
- 120-second timeout for Ollama requests
- Proper error handling for connection issues

#### String-Based Tools (7 tools)
Tools that accept code as string parameters:
1. `ollama_generate_code` - Generate new code from requirements
2. `ollama_explain_code` - Explain how code works
3. `ollama_review_code` - Review code for issues and improvements
4. `ollama_refactor_code` - Refactor code to improve quality
5. `ollama_fix_code` - Fix bugs or errors in code
6. `ollama_write_tests` - Generate unit tests
7. `ollama_general_task` - Execute any general coding task

#### File-Aware Tools (4 tools) - Major Innovation!
Tools that read files directly on the MCP server, providing massive token savings:
8. `ollama_review_file` - Review a file by path
9. `ollama_explain_file` - Explain a file by path
10. `ollama_analyze_files` - Analyze multiple files together
11. `ollama_generate_code_with_context` - Generate code using reference files

**Token Savings**: File-aware tools reduce conversation token usage by ~98.75% compared to traditional read-then-analyze workflows.

### Documentation
- Comprehensive README.md with setup instructions
- Detailed test.md with test cases and validation procedures
- .gitignore for clean repository
- CHANGELOG.md (this file)

### Technical Details
- Node.js 18+ required
- ES modules (`"type": "module"`)
- Dependencies: `@modelcontextprotocol/sdk`, `axios`
- Cross-platform support (Windows, macOS, Linux)
- Absolute file paths required for file-aware tools

### Performance Characteristics
- Small tasks: 30-90 seconds
- Medium tasks: 90-180 seconds
- Large tasks: 180-300 seconds
- Token savings: Up to 98.75% with file-aware tools

### Known Limitations
- Timeouts can occur with large models on slower hardware (expected)
- No streaming responses (synchronous only)
- No caching of file contents (reads on every call)
- Requires Ollama to be running locally

### Future Enhancement Ideas
- File content caching for repeated operations
- Glob pattern support for multi-file operations
- Streaming responses for better UX
- Auto-context: automatically find related files
- File writing capabilities
- Configurable timeout per tool
- Model selection hints based on task complexity
