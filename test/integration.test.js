import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { startMockLlamaServer } from "./helpers/mockLlamaServer.js";

// Runs the actual `node index.js` entry point as a subprocess and talks MCP
// JSON-RPC over its stdio, the same way Claude Code does. Unlike server.test.js
// (which calls class methods directly), this exercises the real tool-schema
// registration and request-routing switch in setupToolHandlers().

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "index.js");

let mock;
let proc;
let buffer = "";
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

function waitForResponse(id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === id) {
          clearInterval(iv);
          resolve(parsed);
          return;
        }
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for response id ${id}`));
      }
    }, 20);
  });
}

before(async () => {
  mock = await startMockLlamaServer();
  proc = spawn("node", [INDEX_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LOCAL_LLM_BASE_URL: mock.url },
  });
  proc.stdout.on("data", (d) => (buffer += d.toString()));

  send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.1" },
  });
  await waitForResponse(1);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

after(async () => {
  proc.kill();
  await mock.close();
});

test("tools/list exposes all 15 local_llm_* tools", async () => {
  const id = send("tools/list", {});
  const response = await waitForResponse(id);
  const names = response.result.tools.map((t) => t.name);
  assert.equal(names.length, 15);
  assert.ok(names.every((n) => n.startsWith("local_llm_")));
  assert.ok(names.includes("local_llm_server_info"));
  assert.ok(names.includes("local_llm_session_stats"));
  assert.ok(names.includes("local_llm_tokenize"));
  assert.ok(names.includes("local_llm_semantic_similarity"));
});

test("tools/call routes local_llm_generate_code through to the local LLM backend", async () => {
  const id = send("tools/call", {
    name: "local_llm_generate_code",
    arguments: { prompt: "reverse a string", language: "python" },
  });
  const response = await waitForResponse(id);
  assert.match(response.result.content[0].text, /reverse a string/);
});

test("tools/call returns a friendly error payload for an unknown tool instead of crashing", async () => {
  const id = send("tools/call", { name: "not_a_real_tool", arguments: {} });
  const response = await waitForResponse(id);
  assert.match(response.result.content[0].text, /Unknown tool/);
});

test("tools/call on local_llm_server_info reports the mock model", async () => {
  const id = send("tools/call", { name: "local_llm_server_info", arguments: {} });
  const response = await waitForResponse(id);
  const info = JSON.parse(response.result.content[0].text);
  assert.equal(info.model_id, "mock-org/mock-model-7b");
});

test("tools/call on local_llm_session_stats reflects the earlier generate_code call", async () => {
  const id = send("tools/call", { name: "local_llm_session_stats", arguments: {} });
  const response = await waitForResponse(id);
  const stats = JSON.parse(response.result.content[0].text);
  assert.equal(stats.calls, 1);
  assert.equal(stats.promptTokens, 10);
  assert.equal(stats.completionTokens, 20);
  assert.equal(stats.totalTokens, 30);
  assert.deepEqual(stats.perTool.generate_code, { calls: 1, promptTokens: 10, completionTokens: 20, totalTokens: 30 });
});
