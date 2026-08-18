# llama.cpp MCP Server - Test Documentation

This file contains test cases and examples for validating the llama.cpp MCP server functionality, especially the file-aware tools.

## Automated Tests

Run `npm test` to check the tool routing, prompt building, and file-handling logic without needing
a running `llama-server` or waiting on real model inference — a mock HTTP backend in `test/helpers/`
stands in for `llama-server`'s `/v1/models`, `/v1/chat/completions`, and `/props` endpoints.

- `test/prompts.test.js` — `resolveFamily()` and `buildMessages()`: family detection and per-family
  prompt overrides
- `test/server.test.js` — `LlamaCppServer` methods directly: model resolution/caching, file-aware
  tools, `serverInfo`
- `test/server-unreachable.test.js` — the friendly connection-error path when `llama-server` is down
- `test/integration.test.js` — spawns the real `node index.js` entry point and drives it over MCP
  JSON-RPC (`tools/list`, `tools/call`), the same way Claude Code does

These are regression tests for the plumbing (routing, caching, error messages, prompt construction) —
they don't tell you whether a given model's actual output is good. Everything below this section is
still the manual checklist for that, run against a real `llama-server`.

## Purpose

Use this file to:
1. Verify that the MCP server is working correctly after changes
2. Test the file-aware tools that reduce token usage
3. Stress test the llama.cpp integration with real project files

## Important Notes

- **Timeout Considerations**: local model calls typically take 60-180 seconds depending on model size and hardware. Be patient!
- **Model**: no model is hardcoded — the server auto-detects whatever `llama-server` currently has loaded via `GET /v1/models`
- **Restart Required**: After modifying `index.js` or `prompts.js`, restart Claude Code to reload the MCP server

## Test Cases

### 1. Basic String-Based Tools (Original)

These tools accept code as strings - useful when code is already in context:

```
Test: llamacpp_explain_code
- Pass a small code snippet
- Verify the response explains it correctly
- Expected time: 60-120 seconds
```

```
Test: llamacpp_review_code
- Pass a code snippet with potential issues
- Check if the response identifies problems
- Expected time: 60-120 seconds
```

### 2. File-Aware Tools (New - Token Savers!)

These tools read files directly on the MCP server, reducing conversation token usage:

#### Test: llamacpp_review_file

```javascript
// Usage example:
{
  file_path: "/Users/holger/repos/github/llamacpp_mcp/index.js",
  focus: "error handling"
}
```

**Expected behavior:**
- MCP server reads the file internally
- Sends file content to llama.cpp
- Returns code review focused on error handling
- **Token savings**: File content doesn't go through Claude conversation

#### Test: llamacpp_explain_file

```javascript
// Usage example:
{
  file_path: "/Users/holger/repos/github/llamacpp_mcp/package.json",
  context: "Focus on dependencies and their purposes"
}
```

**Expected behavior:**
- MCP server reads package.json
- llama.cpp explains the file structure and dependencies
- **Token savings**: No need to read/paste file in conversation

#### Test: llamacpp_analyze_files

```javascript
// Usage example:
{
  file_paths: [
    "/Users/holger/repos/github/llamacpp_mcp/index.js",
    "/Users/holger/repos/github/llamacpp_mcp/package.json"
  ],
  task: "Analyze how the dependencies in package.json are used in index.js"
}
```

**Expected behavior:**
- MCP server reads both files
- llama.cpp analyzes relationships between them
- Returns insights about dependency usage
- **Token savings**: Multiple files read server-side

#### Test: llamacpp_generate_code_with_context

```javascript
// Usage example:
{
  prompt: "Create a new tool handler method following the same pattern",
  language: "javascript",
  context_files: ["/Users/holger/repos/github/llamacpp_mcp/index.js"]
}
```

**Expected behavior:**
- MCP server reads reference file(s)
- llama.cpp generates code matching the existing patterns
- Returns code that follows project conventions
- **Token savings**: Reference files handled server-side

#### Test: llamacpp_server_info

```javascript
// Usage example (no args):
{}
```

**Expected behavior:**
- Returns JSON with `model_id`, `model_family`, `context_size`, `total_slots`, `has_chat_template`
- Matches whatever model `llama-server` was started with

### 3. Stress Tests

#### Multi-File Analysis
Test analyzing 3-4 files together to verify:
- Memory handling
- Timeout management
- Quality of cross-file analysis

#### Large File Review
Test with the full index.js file (400+ lines):
- Verify timeout is sufficient (15 minutes default)
- Check if response is complete or truncated
- Test different focus areas (performance, security, best practices)

## Validation Checklist

After making changes to the MCP server:

- [ ] Run `npm test` to check routing/caching/prompt logic against the mock backend
- [ ] Run `node --check index.js` and `node --check prompts.js` to verify syntax
- [ ] Restart Claude Code to reload MCP server
- [ ] Verify new tools appear in Claude's tool list (check for `mcp__llamacpp__` prefix)
- [ ] Test at least one file-aware tool with a real project file
- [ ] Confirm `llama-server` is running (`curl http://localhost:8080/health`)
- [ ] Check that timeout warnings appear if calls take too long
- [ ] Verify error handling (try invalid file paths, and try stopping `llama-server` to confirm the friendly connection error)

## Token Usage Comparison

### Before (String-Based)
```
Claude: Read file (2000 tokens)
Claude: Call llamacpp_review_code with content (2000 tokens sent)
Total conversation tokens: ~4000
```

### After (File-Aware)
```
Claude: Call llamacpp_review_file with path (50 tokens)
MCP Server: Reads file internally (0 conversation tokens)
Total conversation tokens: ~50
```

**Savings: ~98.75% reduction in conversation tokens!**

## Common Issues

### Issue: "Cannot connect to llama.cpp server"
**Solution**: Ensure `llama-server` is running with `llama-server -m <model.gguf> --jinja --port 8080`

### Issue: "Timeout exceeded"
**Solution**:
- Expected for large files or complex tasks
- Consider using a smaller/faster model for simpler tasks
- Increase timeout in `index.js` if needed (currently 900000ms = 15 minutes, in `callLlamaCpp`)

### Issue: "Tools not appearing"
**Solution**:
- Verify `claude-mcp-config.json` (or your Claude Desktop config) has correct path to `index.js`
- Restart Claude Code completely
- Check MCP server logs for connection errors

### Issue: "File not found"
**Solution**:
- Use absolute paths
- Verify file exists before calling tool

## Example Test Session

```
1. Verify server is running:
   - Check Claude's available tools for mcp__llamacpp__ tools
   - Call llamacpp_server_info and confirm it reports the expected model

2. Simple test:
   - Use llamacpp_explain_file on package.json
   - Wait 60-120 seconds
   - Verify response makes sense

3. Advanced test:
   - Use llamacpp_analyze_files with index.js and package.json
   - Task: "Identify which npm packages are imported and used"
   - Verify cross-file analysis works

4. Token savings test:
   - Compare using llamacpp_review_code (paste file) vs llamacpp_review_file (path)
   - Observe token usage difference in conversation
```

## Future Improvements to Test

When these features are added, test them here:

- [ ] Streaming: verify partial output surfaces before the full response completes
- [ ] Router/multi-model: verify passing an explicit `model` picks the right one
- [ ] Caching: Repeated calls on same file should be faster
- [ ] Glob support: Pass patterns like `*.js` instead of individual files
- [ ] Auto-context: Server automatically finds related files
- [ ] File writing: Generate code directly to files

## Notes for Future Self

- The file-aware tools are a huge token saver - use them whenever possible!
- Don't forget the 60-180 second wait time for local model responses
- Test with real project files to ensure patterns work in practice
- Consider creating smaller test files if full project files cause timeouts
- Remember: MCP server runs in Node.js, has full file system access within its permissions
