import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { startMockLlamaServer } from "./helpers/mockLlamaServer.js";

// Isolated in its own file/process: index.js reads LLAMACPP_BASE_URL once at
// import time, so the "server goes away" scenario needs a mock that starts
// already-closed rather than sharing a live one with other test files.
let LlamaCppServer;

before(async () => {
  const mock = await startMockLlamaServer();
  process.env.LLAMACPP_BASE_URL = mock.url;
  await mock.close();
  ({ LlamaCppServer } = await import("../index.js"));
});

describe("resolveModel against an unreachable server", () => {
  test("surfaces a friendly connection error instead of a raw ECONNREFUSED", async () => {
    const server = new LlamaCppServer();
    await assert.rejects(() => server.resolveModel(undefined), /Cannot connect to llama\.cpp server/);
  });
});
