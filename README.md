# llama.cpp MCP Server for Claude Code

This MCP (Model Context Protocol) server bridges a local **llama.cpp `llama-server`**
instance to Claude Code (or any MCP-speaking coding agent), letting you delegate coding
tasks to your local models to minimize API token usage.

## How It Works

Claude Code acts as an **orchestrator**, calling tools provided by this MCP server. The
tools run on your local `llama-server`, and Claude reviews/refines the results as needed.
This approach:

- ✅ Minimizes Anthropic API token usage (up to 98.75% reduction with file-aware tools!)
- ✅ Leverages your local compute resources
- ✅ Works across any Claude Code project/session
- ✅ Allows Claude to provide oversight and corrections
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

## Setup Instructions

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
server defaults to the gguf file path):

```bash
llama-server -m /path/to/gemma-3-12b.gguf --jinja --port 8080 --alias gemma3-12b
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

### 3. Configure Claude Code

Add this MCP server to your Claude Code configuration. The config file location depends on your OS:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the following to your config (or merge with existing `mcpServers`):

```json
{
  "mcpServers": {
    "llamacpp": {
      "command": "node",
      "args": ["/Users/holger/repos/github/llamacpp_mcp/index.js"]
    }
  }
}
```

**Note**: Update the path in `args` to match your actual installation location.

### 4. Restart Claude Code

After updating the configuration, restart Claude Code for the changes to take effect.

## Usage

Once configured, Claude Code will automatically have access to the llama.cpp tools. You can:

### Direct Usage
Ask Claude to use specific tools:
- "Use llamacpp_generate_code to create a function that..."
- "Use llamacpp_review_code to check this code for issues"
- "Use llamacpp_server_info to check what model is loaded"

### Automatic Orchestration
Simply ask Claude to do tasks, and it will decide when to delegate to llama.cpp:
- "Write a function to parse JSON" → Claude may delegate to llama.cpp
- "Review this code" → Claude may use llama.cpp for initial review, then add insights
- "Fix this bug" → llama.cpp attempts fix, Claude verifies and corrects if needed

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

### Tools Not Appearing in Claude Code
- Verify the config path is correct
- Restart Claude Code completely
- Check Claude Code logs for MCP connection errors

### Slow Responses / Timeouts
- **Expected behavior**: local model calls typically take 60-180 seconds depending on model size and hardware
- Consider using a smaller/faster model for simple tasks
- Adjust the timeout in `index.js` (currently 900000ms = 15 minutes, in `callLlamaCpp`)
- Ensure your machine has adequate resources for the model
- For large files, consider using smaller models or breaking the analysis into chunks

## Example Workflows

### Basic Workflow
1. **User asks**: "Create a function to validate email addresses"
2. **Claude decides**: "This is a code generation task, I'll use llamacpp_generate_code"
3. **llama.cpp generates**: Initial code implementation
4. **Claude reviews**: Checks the code, may suggest improvements or fixes
5. **Result**: User gets llama.cpp-generated code with Claude's oversight

### File-Aware Workflow (Token Saver!)
1. **User asks**: "Review the code in index.js for security issues"
2. **Claude calls**: `llamacpp_review_file` with the file path and focus="security"
3. **MCP server**: Reads index.js directly (no tokens used in conversation!)
4. **llama.cpp analyzes**: Reviews the file
5. **Claude refines**: Adds context or additional insights
6. **Token savings**: ~98.75% compared to reading the file into conversation first

### Multi-File Analysis Workflow
1. **User asks**: "How do index.js and package.json relate?"
2. **Claude calls**: `llamacpp_analyze_files` with both file paths
3. **MCP server**: Reads both files server-side
4. **llama.cpp analyzes**: Identifies dependencies, patterns, relationships
5. **Result**: Cross-file insights without sending files through Claude conversation

This hybrid approach gives you the speed and cost savings of local models with the intelligence and quality assurance of Claude.

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
- **Savings**: ~98.75% reduction in Claude API token usage!

## Benefits Over Pure Local or Pure Cloud

- **vs Pure llama.cpp**: Claude provides architectural guidance, catches errors, and ensures quality
- **vs Pure Claude**: Significant token savings on routine coding tasks (up to 98.75%!)
- **Best of Both**: Local compute for heavy lifting, Claude for orchestration and refinement

## Project Structure

```
llamacpp_mcp/
├── index.js              # Main MCP server implementation
├── prompts.js            # Prompt registry, indexed by model family
├── test/                 # Automated test suite (npm test) — mocked llama-server backend
│   ├── helpers/mockLlamaServer.js
│   ├── prompts.test.js
│   ├── server.test.js
│   ├── server-unreachable.test.js
│   └── integration.test.js
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
- **`/tokenize` / `/embedding` tools**: Expose those primitives directly for non-Claude agents
- **Caching**: Cache file contents for repeated operations
- **Glob support**: Pass patterns like `*.js` to analyze multiple files
- **Auto-context**: Automatically find and include related files
- **File writing**: Allow the model to write generated code directly to files

See `TEST.md` for detailed test cases and validation procedures.
