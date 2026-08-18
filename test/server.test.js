import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { startMockLlamaServer } from "./helpers/mockLlamaServer.js";

let mock;
let LlamaCppServer;
let tmpDir;

before(async () => {
  mock = await startMockLlamaServer();
  process.env.LLAMACPP_BASE_URL = mock.url;
  ({ LlamaCppServer } = await import("../index.js"));
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llamacpp-mcp-test-"));
});

after(async () => {
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.modelId = "mock-org/mock-model-7b";
});

describe("resolveModel", () => {
  test("an explicit model argument skips the network call entirely", async () => {
    const server = new LlamaCppServer();
    const resolved = await server.resolveModel("qwen-explicit");
    assert.equal(resolved.id, "qwen-explicit");
    assert.equal(resolved.family, "qwen");
    assert.equal(mock.state.requests.length, 0);
  });

  test("auto-detects the loaded model from /v1/models and resolves its family", async () => {
    mock.state.modelId = "gemma-3-12b-it";
    const server = new LlamaCppServer();
    const resolved = await server.resolveModel(undefined);
    assert.equal(resolved.id, "gemma-3-12b-it");
    assert.equal(resolved.family, "gemma");
  });

  test("caches the auto-detected model instead of re-querying every call", async () => {
    const server = new LlamaCppServer();
    await server.resolveModel(undefined);
    await server.resolveModel(undefined);
    const modelRequests = mock.state.requests.filter((r) => r.url === "/v1/models");
    assert.equal(modelRequests.length, 1);
  });

});

describe("callLlamaCpp / tool methods", () => {
  test("generateCode sends the built messages and returns the model's content", async () => {
    const server = new LlamaCppServer();
    const result = await server.generateCode({ prompt: "add two numbers", language: "javascript" });
    const text = result.content[0].text;
    assert.match(text, /add two numbers/);
    assert.match(text, /javascript/i);

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.ok(chatRequest, "expected a request to /v1/chat/completions");
    assert.equal(chatRequest.body.messages[0].role, "system");
    assert.equal(chatRequest.body.messages[1].role, "user");
  });

  test("reviewFile reads the file server-side and includes its content and path in the prompt", async () => {
    const filePath = path.join(tmpDir, "sample.js");
    await fs.writeFile(filePath, "function add(a, b) { return a + b; }");

    const server = new LlamaCppServer();
    await server.reviewFile({ file_path: filePath, focus: "bugs" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /sample\.js/);
    assert.match(userMessage, /function add/);
    assert.match(userMessage, /bugs/);
  });

  test("reviewFile surfaces a clear error for a missing file", async () => {
    const server = new LlamaCppServer();
    await assert.rejects(
      () => server.reviewFile({ file_path: path.join(tmpDir, "does-not-exist.js"), focus: "bugs" }),
      /Failed to read file/
    );
  });

  test("analyzeFiles concatenates all requested files into one prompt", async () => {
    const fileA = path.join(tmpDir, "a.js");
    const fileB = path.join(tmpDir, "b.js");
    await fs.writeFile(fileA, "const a = 1;");
    await fs.writeFile(fileB, "const b = 2;");

    const server = new LlamaCppServer();
    await server.analyzeFiles({ file_paths: [fileA, fileB], task: "find shared patterns" });

    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    const userMessage = chatRequest.body.messages[1].content;
    assert.match(userMessage, /a\.js/);
    assert.match(userMessage, /b\.js/);
    assert.match(userMessage, /const a = 1/);
    assert.match(userMessage, /const b = 2/);
  });

  test("an explicit model argument overrides auto-detection for the actual request", async () => {
    const server = new LlamaCppServer();
    await server.generateCode({ prompt: "x", language: "python", model: "deepseek-explicit" });
    const chatRequest = mock.state.requests.find((r) => r.url === "/v1/chat/completions");
    assert.equal(chatRequest.body.model, "deepseek-explicit");
  });
});

describe("serverInfo", () => {
  test("merges /props and /v1/models into one report", async () => {
    mock.state.modelId = "qwen-2.5-coder-7b";
    mock.state.props = {
      default_generation_settings: { n_ctx: 32768 },
      total_slots: 2,
      chat_template: "{{ x }}",
    };

    const server = new LlamaCppServer();
    const result = await server.serverInfo();
    const info = JSON.parse(result.content[0].text);

    assert.equal(info.model_id, "qwen-2.5-coder-7b");
    assert.equal(info.model_family, "qwen");
    assert.equal(info.context_size, 32768);
    assert.equal(info.total_slots, 2);
    assert.equal(info.has_chat_template, true);
  });
});
