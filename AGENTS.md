# AGENTS.md

Priming notes for any coding agent (Claude Code, Codex, Cursor, etc.) working in this
repo. For user-facing docs see `README.md`; for manual validation see `TEST.md`.

## What this is

A Node.js MCP server (`index.js`) that bridges a local OpenAI-compatible LLM server —
`llama-server` (llama.cpp), vLLM, LM Studio, etc. — to MCP-speaking coding agents, exposing
15 `local_llm_*` tools. `llama-server` is the primary worked example and the only backend
this project's own test suite runs against (see README's "Using a Different Backend"
section for pointing at something else). `prompts.js` holds the system/user prompt
templates, indexed by tool and by detected model family.

## Commands

```bash
npm install     # install deps (@modelcontextprotocol/sdk, axios) + devDeps (eslint)
npm test        # run the automated suite (node --test) — mocked backend, ~250ms, no llama-server needed
npm run lint    # ESLint (flat config, recommended rules only — no style/formatting rules)
npm start        # run the MCP server on stdio (needs a real llama-server on LOCAL_LLM_BASE_URL)
node --check index.js && node --check prompts.js   # quick syntax check
```

Running against a **real** `llama-server` requires it to already be up (default
`http://localhost:8080`, override via `LOCAL_LLM_BASE_URL`). `npm test` does not need this —
`test/helpers/mockLlamaServer.js` stands in for it.

## Architecture, in one pass

- `index.js` — `LocalLlmServer` class: registers tools (`ListToolsRequestSchema`), routes
  calls (`CallToolRequestSchema`), resolves/caches the currently-loaded model
  (`resolveModel`, 30s TTL), and sends chat requests (`callLocalLlm` →
  `POST /v1/chat/completions`). File-aware tools (`review_file`, `explain_file`,
  `analyze_files`, `generate_code_with_context`) read files server-side before calling
  `callLocalLlm`, which is the whole point of this project — it saves the orchestrating
  agent from having to paste file contents into its own context.
  Exports `LocalLlmServer` and only auto-starts (`server.run()`) when run directly (guarded
  by `import.meta.url`), so tests can import the class without booting a stdio server.
  `callLocalLlm` also records each response's `usage` field on `this.tokenStats`
  (`recordTokenUsage`), which `local_llm_session_stats` reports back — an in-memory,
  per-process counter, so it naturally scopes to one client session and resets on restart.
  Every request includes a `max_tokens: MAX_TOKENS` ceiling (default 16384, override via
  `LOCAL_LLM_MAX_TOKENS`) — reasoning models have no natural output limit otherwise, and a
  single call can spend an unbounded number of hidden `<think>` tokens before answering.
  `finish_reason === "length"` appends a truncation warning rather than silently returning
  a cut-off answer. `TOOL_REASONING_OVERRIDES[toolName]` (in `prompts.js`, empty by default)
  optionally sets `chat_template_kwargs: { enable_thinking }` per tool — confirmed ~50x
  faster (28s → 541ms) for a trivial `generate_code` call with thinking disabled. Not a
  standard OpenAI field; it's Qwen3-specific and silently ignored by templates that don't
  recognize it.
  `getCodeGraphContext(query, cwd)` is a best-effort helper the four file-aware tools call:
  if `cwd` (default `process.cwd()`) has a `.codegraph/` directory, it shells out to
  `codegraph explore <query>` (binary overridable via `CODEGRAPH_BIN`, mainly for tests) and
  folds the output into the prompt; any failure (no `.codegraph/`, missing binary, timeout)
  returns `null` silently — never a hard dependency.
- `prompts.js` — `DEFAULT_PROMPTS[toolName]` gives `{system, user(args)}`; sparse
  `FAMILY_OVERRIDES[family][toolName]` overrides either half for models that need
  different framing. `resolveFamily(modelId)` does simple substring matching (gemma, qwen,
  deepseek, llama, mistral, phi, codestral → else `generic`). `llama-server` still applies
  the model's *own* Jinja chat template on top of whatever these produce — this file only
  controls the system/user framing text, not template syntax.

## Conventions to follow

- **Adding a tool**: (1) tool definition in `ListToolsRequestSchema` handler, (2) a
  `DEFAULT_PROMPTS` entry in `prompts.js`, (3) a method on `LocalLlmServer` calling
  `this.callLocalLlm("your_tool_key", args)`, (4) a case in the `CallToolRequestSchema`
  switch. Keep the tool name prefixed `local_llm_`.
- **No hardcoded models.** Model is always auto-detected via `resolveModel`, with an
  optional per-call `model` arg override. Don't reintroduce a default/fallback model
  constant.
- **File-aware tools take absolute paths** and read files inside the MCP server process —
  don't ask the orchestrating agent to paste file contents when a `*_file`/`*_files` tool
  variant exists for that purpose.
- **`callLocalLlm` only reads `message.content`** from the chat-completion response, never
  `message.reasoning_content`. If you add handling for reasoning output, keep in mind the
  server needs `--reasoning-format deepseek` for those to even be split apart — see
  README's "Prompt Templates" section.
- After changing `index.js`/`prompts.js`: run `npm test` and `npm run lint`, and if you
  touched request/response shapes, re-verify against a real `llama-server` (`npm start`, or
  the MCP JSON-RPC smoke test pattern in `test/integration.test.js`) since the mocked
  backend won't catch a real model producing a genuinely different response shape.
- Re-thrown errors in a `catch` block should pass `{ cause: error }` to `new Error(...)` (ESLint's
  `preserve-caught-error` rule enforces this) so the original stack isn't lost.

## Known constraints

- Single 15-minute request timeout (`callLocalLlm`), intentionally generous for slow local
  hardware — don't "fix" this down without checking `TEST.md`'s timing notes.
- `LOCAL_LLM_BASE_URL` is read once at module import time as a top-level constant; it can't
  be changed per-instance at runtime. Tests that need a fresh backend URL do so in their
  own file/process (see `test/server-unreachable.test.js`).
- `index.js`'s shebang line, its `bin` entry in `package.json`, and the
  `import.meta.url === file://${realpathSync(process.argv[1])}` auto-start guard are all
  load-bearing for `npx local-llm-mcp` / `npx github:hlgr360/local-llm-mcp`
  to work. **Don't simplify that guard back to comparing `process.argv[1]` directly** —
  npm's `node_modules/.bin/<name>` mechanism always invokes a package's bin through a
  symlink, and `import.meta.url` resolves through it while a non-realpath'd `argv[1]`
  doesn't, so they'd silently never match. This exact regression shipped in 2.0.0 (fixed
  in 2.0.1) — see `test/bin-symlink.test.js`, which is the only test that can catch it,
  since a direct `node index.js` invocation (no symlink) can't reproduce the bug.
- `test/server.test.js` `chdir`s into its temp directory for the whole file, specifically
  so `getCodeGraphContext`'s default `process.cwd()` doesn't accidentally find *this
  repo's own* real `.codegraph/` index during test runs (which happened once — tests got
  10x slower and non-hermetic before this fix). Keep that `chdir` if you add more tests
  here; don't assume `process.cwd()` is a safe default to rely on in tests.
