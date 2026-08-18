# AGENTS.md

Priming notes for any coding agent (Claude Code, Codex, Cursor, etc.) working in this
repo. For user-facing docs see `README.md`; for manual validation see `TEST.md`.

## What this is

A Node.js MCP server (`index.js`) that bridges a local `llama-server` (llama.cpp's
OpenAI-compatible server) to MCP-speaking coding agents, exposing 13 `llamacpp_*` tools.
`prompts.js` holds the system/user prompt templates, indexed by tool and by detected
model family.

## Commands

```bash
npm install     # install deps (@modelcontextprotocol/sdk, axios) + devDeps (eslint)
npm test        # run the automated suite (node --test) — mocked backend, ~250ms, no llama-server needed
npm run lint    # ESLint (flat config, recommended rules only — no style/formatting rules)
npm start        # run the MCP server on stdio (needs a real llama-server on LLAMACPP_BASE_URL)
node --check index.js && node --check prompts.js   # quick syntax check
```

Running against a **real** `llama-server` requires it to already be up (default
`http://localhost:8080`, override via `LLAMACPP_BASE_URL`). `npm test` does not need this —
`test/helpers/mockLlamaServer.js` stands in for it.

## Architecture, in one pass

- `index.js` — `LlamaCppServer` class: registers tools (`ListToolsRequestSchema`), routes
  calls (`CallToolRequestSchema`), resolves/caches the currently-loaded model
  (`resolveModel`, 30s TTL), and sends chat requests (`callLlamaCpp` →
  `POST /v1/chat/completions`). File-aware tools (`review_file`, `explain_file`,
  `analyze_files`, `generate_code_with_context`) read files server-side before calling
  `callLlamaCpp`, which is the whole point of this project — it saves the orchestrating
  agent from having to paste file contents into its own context.
  Exports `LlamaCppServer` and only auto-starts (`server.run()`) when run directly (guarded
  by `import.meta.url`), so tests can import the class without booting a stdio server.
  `callLlamaCpp` also records each response's `usage` field on `this.tokenStats`
  (`recordTokenUsage`), which `llamacpp_session_stats` reports back — an in-memory,
  per-process counter, so it naturally scopes to one client session and resets on restart.
- `prompts.js` — `DEFAULT_PROMPTS[toolName]` gives `{system, user(args)}`; sparse
  `FAMILY_OVERRIDES[family][toolName]` overrides either half for models that need
  different framing. `resolveFamily(modelId)` does simple substring matching (gemma, qwen,
  deepseek, llama, mistral, phi, codestral → else `generic`). `llama-server` still applies
  the model's *own* Jinja chat template on top of whatever these produce — this file only
  controls the system/user framing text, not template syntax.

## Conventions to follow

- **Adding a tool**: (1) tool definition in `ListToolsRequestSchema` handler, (2) a
  `DEFAULT_PROMPTS` entry in `prompts.js`, (3) a method on `LlamaCppServer` calling
  `this.callLlamaCpp("your_tool_key", args)`, (4) a case in the `CallToolRequestSchema`
  switch. Keep the tool name prefixed `llamacpp_`.
- **No hardcoded models.** Model is always auto-detected via `resolveModel`, with an
  optional per-call `model` arg override. Don't reintroduce a default/fallback model
  constant.
- **File-aware tools take absolute paths** and read files inside the MCP server process —
  don't ask the orchestrating agent to paste file contents when a `*_file`/`*_files` tool
  variant exists for that purpose.
- **`callLlamaCpp` only reads `message.content`** from the chat-completion response, never
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

- Single 15-minute request timeout (`callLlamaCpp`), intentionally generous for slow local
  hardware — don't "fix" this down without checking `TEST.md`'s timing notes.
- `LLAMACPP_BASE_URL` is read once at module import time as a top-level constant; it can't
  be changed per-instance at runtime. Tests that need a fresh backend URL do so in their
  own file/process (see `test/server-unreachable.test.js`).
- `index.js`'s shebang line and its `bin` entry in `package.json` exist for a future
  published npm package (`npx llamacpp-mcp-server`), not yet published. Don't remove
  either. Note: `npx github:hlgr360/llamacpp_mcp` (git-spec install) looks like it should
  work but doesn't — `npm exec`'s git-dependency path closes piped stdin immediately via
  `@npmcli/run-script`, before any MCP handshake can happen. See README's "A note on npx
  without cloning" for details; only a real registry publish avoids that code path.
