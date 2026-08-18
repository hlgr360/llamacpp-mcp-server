# llama.cpp MCP Bridge

This MCP (Model Context Protocol) server bridges a local **llama.cpp `llama-server`**
instance to **any MCP-speaking coding agent** — Claude Code, Cursor, Codex CLI, Cline,
Windsurf, or your own MCP client — letting you delegate coding tasks to your local models
to minimize cloud API token usage. It speaks standard MCP over stdio, so nothing here is
Claude-specific; the setup instructions below use Claude Code as the reference example
since that's what's included (`claude-mcp-config.json`), but the same `node index.js`
command works as the MCP server entry for any client.

## How It Works

Your coding agent acts as the **orchestrator**, calling tools provided by this MCP
server. The tools run on your local `llama-server`, and the agent reviews/refines the
results as needed. This approach:

- ✅ Minimizes cloud API token usage (up to 98.75% reduction with file-aware tools!)
- ✅ Leverages your local compute resources
- ✅ Works across any project/session, in any MCP-compatible client
- ✅ Lets the orchestrating agent provide oversight and corrections
- ✅ Auto-detects whichever model `llama-server` currently has loaded — no hardcoded model name

## Available Tools

### String-Based Tools (Pass code as arguments)

These tools accept code as string parameters - useful when code is already in the conversation:

1. **llamacpp_generate_code** - Generate new code from requirements
2. **llamacpp_explain_code** - Explain how code works
3. **llamacpp_review_code** - Review code for issues and improvements
4. **llamacpp_refactor_code** - Refactor code to improve quality
5. **llamacpp_fix_code** - Fix bugs or errors in code
6. **llamacpp_write_tests** - Generate unit tests
7. **llamacpp_general_task** - Execute any general coding task

### File-Aware Tools (Massive token savings!)

These tools read files directly on the MCP server, dramatically reducing conversation token usage:

8. **llamacpp_review_file** - Review a file by path (saves ~98.75% tokens vs reading + reviewing)
9. **llamacpp_explain_file** - Explain a file by path
10. **llamacpp_analyze_files** - Analyze multiple files together to understand relationships
11. **llamacpp_generate_code_with_context** - Generate code using existing files as reference patterns

### Introspection

12. **llamacpp_server_info** - Reports which model `llama-server` currently has loaded, its
    context size, slot count, and whether it has a chat template — useful for any agent to
    check what's actually running before assuming a model or capability.
13. **llamacpp_session_stats** - Reports cumulative prompt/completion/total token usage sent
    to and received from `llama-server` so far in this session, with a per-tool breakdown —
    based on the `usage` field `llama-server` returns per request. Answers "how many tokens
    have actually been offloaded to the local model instead of my own context?"

## Setup Instructions

Cloning this repo is currently required (see the note on `npx` below for why a no-clone
install isn't available yet).

### 1. Install Dependencies

```bash
npm install
```

### 2. Run `llama-server`

Start `llama-server` with a model, with **`--jinja` enabled** so it applies the model's own
chat template when this server calls `/v1/chat/completions` (recent `llama-server` builds
enable this by default — pass `--jinja` explicitly anyway if you're not sure which build
you're on, or use `--no-jinja` to opt out):

```bash
llama-server -m /path/to/model.gguf --jinja --port 8080
```

Optionally give it a friendly name with `--alias` (otherwise the model `id` reported by the
server defaults to the gguf file path, or the HuggingFace repo:tag if loaded via `-hf`).
For example, loading a model straight from HuggingFace with GPU offload and a larger
context window:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_M -ngl 999 -fa on -c 65536 --port 8080
```

For reasoning models (like the Qwen3.6 example above, or DeepSeek-R1/-V3.x), also add
`--reasoning-format deepseek` so the model's `<think>...</think>` output is split into
`message.reasoning_content` instead of leaking into `message.content` — the only field
this server reads (see "Prompt Templates" below for why that matters):

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_M -ngl 999 -fa on -c 65536 --port 8080 --reasoning-format deepseek
```

`scripts/start-llama.sh` wraps a command like this in a background `tmux` session, with a
small model-name → HuggingFace-repo lookup table you can edit for your own models:

```bash
./scripts/start-llama.sh qwen3.6   # edit the case block in the script to add your own
```

Verify it's up and see what it reports as loaded:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/v1/models
```

By default this MCP server talks to `http://localhost:8080`. Override with the
`LLAMACPP_BASE_URL` environment variable if you run `llama-server` on a different host/port:

```bash
export LLAMACPP_BASE_URL=http://localhost:8081
```

### 3. Configure Your MCP Client

Every MCP client reads roughly the same shape of config — a command to launch the server
plus its arguments — just from a different file. This repo ships `claude-mcp-config.json`
for Claude Code/Desktop as the reference example:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "llamacpp": {
      "command": "node",
      "args": ["/Users/holger/repos/github/llamacpp-mcp-server/index.js"]
    }
  }
}
```

**Note**: Update the path in `args` to match your actual installation location.

For any other MCP client (Cursor, Codex CLI, Cline, Windsurf, a custom client, etc.),
consult that client's docs for where its MCP config lives — the `mcpServers` entry itself
is the same, since this server only relies on standard MCP-over-stdio and doesn't do
anything Claude-specific.

**A note on `npx` without cloning:** `npx -y github:hlgr360/llamacpp-mcp-server` looks like it
should work the same way — it does install and resolve the `bin` entry correctly — but it
does **not** work as an MCP server: `npm exec`'s git-dependency install path routes through
`@npmcli/run-script`, which closes piped stdin immediately, before any real handshake can
happen. That's fine for one-shot CLI tools but breaks anything needing a persistent
stdio connection. This isn't a bug specific to this repo; it's how npm handles any
`github:owner/repo` spec, confirmed by testing an identical setup against a real published
MCP server via the plain npm registry, which worked fine. A published npm package (not a
git-spec install) doesn't hit this path — that's the actual way to get no-clone `npx`
support, and is planned but not yet published.

### 4. Restart Your MCP Client

After updating the configuration, restart your client (Claude Code, or whichever agent
you configured) for the changes to take effect.

## Usage

Once configured, your agent will automatically have access to the llama.cpp tools. You can:

### Direct Usage
Ask the agent to use specific tools:
- "Use llamacpp_generate_code to create a function that..."
- "Use llamacpp_review_code to check this code for issues"
- "Use llamacpp_server_info to check what model is loaded"
- "Use llamacpp_session_stats to see how many tokens have been offloaded to llama.cpp so far"

### Automatic Orchestration
Simply ask the agent to do tasks, and it will decide when to delegate to llama.cpp:
- "Write a function to parse JSON" → the agent may delegate to llama.cpp
- "Review this code" → the agent may use llama.cpp for initial review, then add insights
- "Fix this bug" → llama.cpp attempts fix, the agent verifies and corrects if needed

## Customization

### Model Selection

There's no hardcoded model anymore. Every tool call auto-detects whichever model
`llama-server` currently has loaded (via `GET /v1/models`, cached for ~30 seconds), so
switching models is just a matter of restarting `llama-server` with a different `-m`.
You can still force a specific model per call by passing an explicit `model` argument to
any tool — useful if you're running a router/`llama-swap` setup with more than one model
available.

### Prompt Templates (indexed by model family)

`prompts.js` holds the system/user prompt template for each tool, plus a sparse
`FAMILY_OVERRIDES` map keyed by model family (`gemma`, `qwen`, `deepseek`, `llama`,
`mistral`, `phi`, `codestral`, or `generic` as the fallback). The family is derived
automatically from whatever model id `llama-server` reports. To tune wording or framing
for a specific model family, add or edit an entry in `FAMILY_OVERRIDES`:

```js
export const FAMILY_OVERRIDES = {
  qwen: {
    write_tests: {
      system: "...", // overrides DEFAULT_PROMPTS.write_tests.system only for qwen models
    },
  },
};
```

Since requests go through `/v1/chat/completions` with `--jinja` enabled, `llama-server`
applies the loaded model's *own* chat template on top of whatever system/user messages we
send — so most models work well with the defaults, and overrides are only needed for
genuine framing differences (e.g. reasoning-style models).

For reasoning models (Qwen3.x, DeepSeek-R1/-V3.x, etc.), also start `llama-server` with
`--reasoning-format deepseek`. This server only ever reads `message.content` from the
response (see `callLlamaCpp` in `index.js`) — with `--reasoning-format deepseek`,
`llama-server` splits the model's `<think>...</think>` output into a separate
`message.reasoning_content` field and leaves `content` as just the final answer. Without
it, raw thinking text leaks into every tool's returned output.

### Add New Tools

Add new tools by:
1. Adding a tool definition in the `ListToolsRequestSchema` handler in `index.js`
2. Adding a `DEFAULT_PROMPTS` entry for it in `prompts.js`
3. Creating a new method (like `generateCode`, `reviewCode`, etc.) that calls
   `this.callLlamaCpp("your_tool_key", args)`
4. Adding a case in the `CallToolRequestSchema` handler

## Troubleshooting

### "Cannot connect to llama.cpp server" Error
- Ensure `llama-server` is running: `llama-server -m <model.gguf> --jinja --port 8080`
- Check it's on the expected port: `curl http://localhost:8080/health`
- Confirm `LLAMACPP_BASE_URL` (if set) matches where `llama-server` is actually listening

### Tools Not Appearing in Your MCP Client
- Verify the config path is correct
- Restart your client completely
- Check your client's logs for MCP connection errors

### Slow Responses / Timeouts
- **Expected behavior**: local model calls typically take 60-180 seconds depending on model size and hardware
- Consider using a smaller/faster model for simple tasks
- Adjust the timeout in `index.js` (currently 900000ms = 15 minutes, in `callLlamaCpp`)
- Ensure your machine has adequate resources for the model
- For large files, consider using smaller models or breaking the analysis into chunks

## Example Workflows

### Basic Workflow
1. **User asks**: "Create a function to validate email addresses"
2. **Agent decides**: "This is a code generation task, I'll use llamacpp_generate_code"
3. **llama.cpp generates**: Initial code implementation
4. **Agent reviews**: Checks the code, may suggest improvements or fixes
5. **Result**: User gets llama.cpp-generated code with the agent's oversight

### File-Aware Workflow (Token Saver!)
1. **User asks**: "Review the code in index.js for security issues"
2. **Agent calls**: `llamacpp_review_file` with the file path and focus="security"
3. **MCP server**: Reads index.js directly (no tokens used in conversation!)
4. **llama.cpp analyzes**: Reviews the file
5. **Agent refines**: Adds context or additional insights
6. **Token savings**: ~98.75% compared to reading the file into conversation first

### Multi-File Analysis Workflow
1. **User asks**: "How do index.js and package.json relate?"
2. **Agent calls**: `llamacpp_analyze_files` with both file paths
3. **MCP server**: Reads both files server-side
4. **llama.cpp analyzes**: Identifies dependencies, patterns, relationships
5. **Result**: Cross-file insights without sending files through the agent's conversation

This hybrid approach gives you the speed and cost savings of local models with the intelligence and quality assurance of your orchestrating agent.

## Performance Expectations

### Response Times
- **Small tasks** (simple code snippets): 20-60 seconds
- **Medium tasks** (function reviews, file analysis): 60-120 seconds
- **Large tasks** (multiple files, complex analysis): 120-180 seconds

Response time depends on:
- Your GPU/CPU capabilities
- Model size and quantization
- Task complexity
- File size for file-aware tools

### Token Usage
- **Traditional approach**: Read 700-line file (2000 tokens) + Review (2000 tokens) = **4000 tokens**
- **File-aware approach**: Call `llamacpp_review_file` with path = **~50 tokens**
- **Savings**: ~98.75% reduction in the orchestrating agent's API token usage!

## Benefits Over Pure Local or Pure Cloud

- **vs Pure llama.cpp**: Your cloud agent provides architectural guidance, catches errors, and ensures quality
- **vs Pure Cloud Agent**: Significant token savings on routine coding tasks (up to 98.75%!)
- **Best of Both**: Local compute for heavy lifting, your cloud agent for orchestration and refinement

## Project Structure

```
llamacpp-mcp-server/
├── index.js              # Main MCP server implementation
├── prompts.js            # Prompt registry, indexed by model family
├── test/                 # Automated test suite (npm test) — mocked llama-server backend
│   ├── helpers/mockLlamaServer.js
│   ├── prompts.test.js
│   ├── server.test.js
│   ├── server-unreachable.test.js
│   └── integration.test.js
├── scripts/
│   └── start-llama.sh    # Optional convenience launcher for llama-server (tmux + HF model lookup)
├── eslint.config.js      # ESLint flat config (recommended rules only, no style/formatting)
├── package.json          # Node.js dependencies
├── README.md             # This file
├── AGENTS.md             # Priming notes for coding agents working in this repo
├── TEST.md               # Manual test cases and validation guide
└── .gitignore             # Git ignore patterns
```

## Contributing & Future Improvements

Potential enhancements to consider:
- **Streaming responses**: Stream llama.cpp output for faster perceived performance
- **Router/multi-model support**: Let the optional `model` arg pick from a `llama-swap`-style
  multi-model setup instead of always using the single auto-detected model
- **Provider-agnostic core**: Target any OpenAI-compatible local server (vLLM, LM Studio, etc.)
  by swapping the base URL
- **Tool-calling passthrough**: Hand the model real tool definitions via llama-server's
  `--jinja` function-calling support instead of only returning prose
- **`/tokenize` / `/embedding` tools**: Expose those primitives directly for agents that want them
- **Caching**: Cache file contents for repeated operations
- **Glob support**: Pass patterns like `*.js` to analyze multiple files
- **Auto-context**: Automatically find and include related files
- **File writing**: Allow the model to write generated code directly to files

See `TEST.md` for detailed test cases and validation procedures.
