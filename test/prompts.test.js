import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveFamily, buildMessages, DEFAULT_PROMPTS } from "../prompts.js";

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
