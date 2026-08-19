import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveFamily, buildMessages, DEFAULT_PROMPTS, FAMILY_OVERRIDES } from "../prompts.js";

describe("resolveFamily", () => {
  const cases = [
    ["unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_M", "qwen"],
    ["gemma-3-12b-it.gguf", "gemma"],
    ["deepseek-coder-v2-lite", "deepseek"],
    ["Meta-Llama-3-8B-Instruct", "llama"],
    ["mistral-7b-instruct-v0.3", "mistral"],
    ["Phi-3-mini-4k-instruct", "phi"],
    ["Codestral-22B-v0.1", "codestral"],
    ["some-completely-unknown-model", "generic"],
    [null, "generic"],
    [undefined, "generic"],
  ];

  for (const [modelId, expected] of cases) {
    test(`${modelId} -> ${expected}`, () => {
      assert.equal(resolveFamily(modelId), expected);
    });
  }
});

describe("buildMessages", () => {
  test("uses DEFAULT_PROMPTS for a family with no override", () => {
    const messages = buildMessages("generate_code", { prompt: "add two numbers", language: "javascript" }, "llama");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content, DEFAULT_PROMPTS.generate_code.system);
    assert.equal(messages[1].role, "user");
    assert.match(messages[1].content, /add two numbers/);
    assert.match(messages[1].content, /javascript/);
  });

  test("applies a family-specific system override when one exists", () => {
    const messages = buildMessages("fix_code", { code: "x", error: "boom" }, "deepseek");
    assert.notEqual(messages[0].content, DEFAULT_PROMPTS.fix_code.system);
    assert.match(messages[0].content, /step by step/);
  });

  test("falls back to the default system prompt when the family has no override for this tool", () => {
    const messages = buildMessages("generate_code", { prompt: "x", language: "python" }, "deepseek");
    assert.equal(messages[0].content, DEFAULT_PROMPTS.generate_code.system);
  });

  test("an override for one tool does not leak into another tool for the same family", () => {
    const messages = buildMessages("generate_code", { prompt: "x", language: "python" }, "qwen");
    assert.equal(messages[0].content, DEFAULT_PROMPTS.generate_code.system);
  });

  test("throws for an unregistered tool name", () => {
    assert.throws(() => buildMessages("not_a_real_tool", {}, "generic"), /No prompt template registered/);
  });

  test("review_file includes file name and path in the user message", () => {
    const messages = buildMessages(
      "review_file",
      { code: "console.log(1)", focus: "bugs", fileName: "a.js", filePath: "/tmp/a.js" },
      "generic"
    );
    assert.match(messages[1].content, /a\.js/);
    assert.match(messages[1].content, /\/tmp\/a\.js/);
    assert.match(messages[1].content, /bugs/);
  });
});

// The qwen family overrides were added after a running Qwen3.6-35B-A3B server was
// observed padding free-form output with emoji, headers, and unrequested rewrites on the
// default prompts (see the comment above FAMILY_OVERRIDES.qwen in prompts.js). These tests
// pin the override wiring itself -- not the model's actual behavior, which can only be
// checked against a live server.
describe("FAMILY_OVERRIDES.qwen", () => {
  const argsByTool = {
    write_tests: { code: "function add(a, b) { return a + b; }", framework: "node:test" },
    explain_code: { code: "const x = 1;" },
    review_code: { code: "const x = 1;", focus: "bugs" },
    review_file: { code: "1\tconst x = 1;", focus: "bugs", fileName: "a.js", filePath: "/tmp/a.js" },
    explain_file: { code: "1\tconst x = 1;", fileName: "a.js", filePath: "/tmp/a.js" },
    analyze_files: { task: "find dependencies", filesContent: "FILE: a.js\n1\tconst x = 1;" },
    general_task: { task: "summarize this" },
  };

  for (const tool of Object.keys(FAMILY_OVERRIDES.qwen)) {
    test(`${tool} uses the qwen-specific system prompt`, () => {
      const args = argsByTool[tool];
      assert.ok(args, `no test args defined for qwen-overridden tool: ${tool}`);
      const messages = buildMessages(tool, args, "qwen");
      assert.equal(messages[0].content, FAMILY_OVERRIDES.qwen[tool].system);
      assert.notEqual(messages[0].content, DEFAULT_PROMPTS[tool].system);
    });

    test(`${tool} still builds the user message with the default (non-overridden) user function`, () => {
      const args = argsByTool[tool];
      const messages = buildMessages(tool, args, "qwen");
      assert.equal(messages[1].content, DEFAULT_PROMPTS[tool].user(args));
    });
  }

  test("fix_code (a deepseek-only override) falls back to the default system prompt for qwen", () => {
    const messages = buildMessages("fix_code", { code: "x", error: "boom" }, "qwen");
    assert.equal(messages[0].content, DEFAULT_PROMPTS.fix_code.system);
  });

  // These six were added to stop the model padding free-form output with emoji, headers,
  // tables, and horizontal rules; write_tests predates that fix and is exempt (its output
  // format is already fully constrained), so it's excluded here.
  const decorationBannedTools = Object.keys(FAMILY_OVERRIDES.qwen).filter((tool) => tool !== "write_tests");

  for (const tool of decorationBannedTools) {
    test(`${tool} qwen system prompt bans emoji`, () => {
      assert.match(FAMILY_OVERRIDES.qwen[tool].system, /no emoji/i);
    });
  }
});
