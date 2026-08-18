# Changelog

## Version 2.4.0 - CodeGraph context enrichment

### Features
- The file-aware tools (`llamacpp_review_file`, `llamacpp_explain_file`,
  `llamacpp_analyze_files`, `llamacpp_generate_code_with_context`) now automatically fold
  in `codegraph explore`'s output (call paths, blast radius) when the target project has a
  CodeGraph index (`.codegraph/` directory present) — a materially better review than one
  that only sees a file in isolation. Strictly best-effort: no `.codegraph/`, no `codegraph`
  binary on `PATH`, a slow response (5s timeout), or any other failure all silently fall
  back to no enrichment. The binary is overridable via `CODEGRAPH_BIN` (mainly for tests).

## Version 2.3.0 - Glob support for multi-file tools

### Features
- `llamacpp_analyze_files` (`file_paths`) and `llamacpp_generate_code_with_context`
  (`context_files`) now accept glob patterns (e.g. `src/**/*.js`) alongside plain literal
  paths, expanded server-side via Node's built-in `fs.glob`. Expansion is capped at 50
  matched files with a clear error if exceeded, so a broad pattern can't silently balloon a
  request into hundreds of files and enormous token usage sent to the local model.
  `llamacpp_review_file`/`llamacpp_explain_file` are unchanged (still single-file tools).

### Breaking Changes
- **`engines.node` raised from `>=18.0.0` to `>=22.0.0`** — required for the built-in
  `fs.glob`/`fs.promises.glob` API used above. No new runtime dependency was added; this
  project has consistently preferred Node built-ins over dependencies (`node:test` over a
  test framework, a hand-rolled mock server over `nock`/`msw`) and this follows the same
  reasoning.

## Version 2.2.0 - Router/multi-model support

### Features
- `resolveModel` now accepts a `toolName` and, when `/v1/models` reports more than one
  loaded model (e.g. behind a `llama-swap`-style router), consults a new
  `TOOL_MODEL_PREFERENCES` map in `prompts.js` — a sparse, empty-by-default list of
  preferred model families per tool — before falling back to whichever model is listed
  first. A single-model setup (the common case) is completely unaffected: no preferences
  configured means identical behavior to before.
- The model-list cache (`fetchAvailableModels`, replacing the old single-model
  `resolveModel` cache) is now shared across tools rather than tracking one resolved model,
  so multiple tools resolving against the same model list still only cost one `/v1/models`
  request within the 30s TTL.

## Version 2.1.0 - Tokenize and semantic similarity tools

### Features
- New `llamacpp_tokenize` tool: reports how many tokens a piece of text would consume
  according to the currently loaded tokenizer, via `llama-server`'s native `/tokenize`
  endpoint. Returns just `{ token_count }` by default; pass `include_tokens: true` to also
  get the raw token ID array.
- New `llamacpp_semantic_similarity` tool: ranks candidate texts by semantic similarity to
  a query via `llama-server`'s OpenAI-compatible `/v1/embeddings` endpoint (requires
  `llama-server` to be started with `--embeddings`). Deliberately returns similarity scores
  only, never raw embedding vectors — a 768-4096 float vector serialized as tool output
  would dump thousands of tokens back into the calling agent's context, undermining this
  project's entire token-savings premise.

## Version 2.0.1 - Fix npx/global-install startup bug

### Fixes
- **Critical**: `llamacpp-mcp-server@2.0.0` silently failed to start whenever invoked
  through a symlink — which is exactly how npm's `node_modules/.bin/<name>` mechanism (and
  therefore every `npx` or global install) always invokes a package's bin. The "only
  auto-start when run directly" guard added in 2.0.0 compared `import.meta.url` against
  the raw `process.argv[1]`; that matches for `node index.js` but never matches through a
  symlink, since `import.meta.url` resolves through it while `argv[1]` doesn't. The result
  was a clean, silent exit with zero output — no error, just nothing happening. Fixed by
  realpath-resolving `process.argv[1]` before comparing.
- Added `test/bin-symlink.test.js`: a regression test that invokes `index.js` through a
  real symlink and verifies the server actually starts, since the existing integration
  test (`node index.js` directly) can't exercise this failure mode at all.
- **Correction**: 2.0.0's changelog claimed `npx github:hlgr360/llamacpp-mcp-server`
  doesn't work because "npm's git-dependency install path closes piped stdin immediately."
  That diagnosis was wrong — it was this same symlink bug the whole time, reproducible with
  a plain `node` invocation through a symlink and no npm/npx involved at all. Both
  `npx github:hlgr360/llamacpp-mcp-server` and `npx llamacpp-mcp-server` (from the npm
  registry, once this version is published) work correctly.

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
- Added a `bin` entry (`llamacpp-mcp-server` → `index.js`) enabling `npx`-based installs,
  both directly from GitHub (`npx github:hlgr360/llamacpp-mcp-server`) and from the npm
  registry. See 2.0.1 for a startup bug this introduced and its fix.
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
