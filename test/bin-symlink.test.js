import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { mkdtemp, symlink, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { startMockLlamaServer } from "./helpers/mockLlamaServer.js";

// Regression test for a real bug that shipped to npm (2.0.0): the "only
// auto-start when run directly" guard compared import.meta.url against the
// raw process.argv[1], which never matches when index.js is invoked through
// a symlink -- exactly how npm's node_modules/.bin/<name> mechanism (and
// therefore every `npx`/global install) always invokes a package's bin.
// Direct `node index.js` invocation (what test/integration.test.js exercises)
// can't catch this class of bug, since there's no symlink involved.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "..", "index.js");

let mock;
let binDir;
let symlinkPath;

before(async () => {
  mock = await startMockLlamaServer();
  binDir = await mkdtemp(path.join(tmpdir(), "llamacpp-mcp-bin-"));
  symlinkPath = path.join(binDir, "llamacpp-mcp-server");
  await symlink(INDEX_PATH, symlinkPath);
});

after(async () => {
  await mock.close();
  await rm(binDir, { recursive: true, force: true });
});

test("running index.js through a symlink (simulating npm's bin mechanism) still starts the server", async () => {
  const proc = spawn("node", [symlinkPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LLAMACPP_BASE_URL: mock.url },
  });

  let buffer = "";
  proc.stdout.on("data", (d) => (buffer += d.toString()));

  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
    }) + "\n"
  );

  try {
    const response = await new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        for (const line of buffer.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === 1) {
              clearInterval(iv);
              resolve(parsed);
              return;
            }
          } catch {
            // not JSON, or not our response line yet
          }
        }
        if (Date.now() - start > 5000) {
          clearInterval(iv);
          reject(new Error(`server never responded through the symlink; stdout was: ${JSON.stringify(buffer)}`));
        }
      }, 20);
    });

    assert.equal(response.result.serverInfo.name, "llamacpp-mcp-server");
  } finally {
    proc.kill();
  }
});
