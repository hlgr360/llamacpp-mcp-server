// Prompt registry indexed by model family.
//
// Each tool has a DEFAULT_PROMPTS entry: a static `system` framing string and a
// `user` function that builds the per-call payload from the tool's args. A model
// family (detected from whatever model llama.cpp reports as loaded) can override
// either half in FAMILY_OVERRIDES. buildMessages() resolves the two into the
// {role, content} pairs sent to /v1/chat/completions, letting llama-server apply
// the loaded model's own chat template on top.

const FAMILY_KEYWORDS = {
  gemma: "gemma",
  qwen: "qwen",
  deepseek: "deepseek",
  llama: "llama",
  mistral: "mistral",
  phi: "phi",
  codestral: "codestral",
};

export function resolveFamily(modelId) {
  if (!modelId) return "generic";
  const lower = modelId.toLowerCase();
  for (const [needle, family] of Object.entries(FAMILY_KEYWORDS)) {
    if (lower.includes(needle)) return family;
  }
  return "generic";
}

export const DEFAULT_PROMPTS = {
  generate_code: {
    system:
      "You are a code generation assistant. Generate clean, well-commented code based on the requirements given. Respond with ONLY the code, no explanations or markdown formatting. Make sure the code is production-ready and follows best practices.",
    user: (args) => `Language: ${args.language}\n\nRequirements:\n${args.prompt}`,
  },

  explain_code: {
    system:
      "You are a code explanation assistant. Provide a clear, comprehensive explanation of what the code does, how it works, and any important patterns or considerations.",
    user: (args) =>
      `Explain the following code in detail:\n\n${args.code}${
        args.context ? `\n\nContext: ${args.context}` : ""
      }`,
  },

  review_code: {
    system:
      "You are a code review assistant. Provide specific, actionable feedback including:\n1. Issues or bugs found\n2. Potential improvements\n3. Best practice violations\n4. Security concerns (if applicable)\n\nBe concise and specific.",
    user: (args) =>
      `Review the following code with focus on ${args.focus || "general code quality"}:\n\n${args.code}`,
  },

  refactor_code: {
    system:
      "You are a code refactoring assistant. Provide the refactored code with a brief explanation of the changes made. Format your response as:\n\nREFACTORED CODE:\n[code here]\n\nCHANGES MADE:\n[brief explanation]",
    user: (args) => `Refactor the following code with the goal to ${args.goal}:\n\n${args.code}`,
  },

  fix_code: {
    system:
      "You are a debugging assistant. Provide the fixed code with a brief explanation of what was wrong and how you fixed it. Format your response as:\n\nFIXED CODE:\n[code here]\n\nEXPLANATION:\n[brief explanation of the fix]",
    user: (args) => `ERROR: ${args.error}\n\nCODE:\n${args.code}`,
  },

  write_tests: {
    system:
      "You are a test writing assistant. Generate complete, runnable tests with good coverage of different scenarios including edge cases. Include only the test code, properly formatted for the requested framework.",
    user: (args) =>
      `Write comprehensive unit tests for the following code using ${args.framework}:\n\n${args.code}`,
  },

  general_task: {
    system: "You are a coding assistant. Provide a clear, complete response to the task.",
    user: (args) =>
      `TASK: ${args.task}${args.context ? `\n\nCONTEXT:\n${args.context}` : ""}`,
  },

  review_file: {
    system:
      "You are a code review assistant. Provide specific, actionable feedback including:\n1. Issues or bugs found\n2. Potential improvements\n3. Best practice violations\n4. Security concerns (if applicable)\n\nBe concise and specific.",
    user: (args) =>
      `Review the following file with focus on ${args.focus || "general code quality"}:\n\nFILE: ${args.fileName}\nPATH: ${args.filePath}\n\nCODE:\n${args.code}${codeGraphSection(args)}`,
  },

  explain_file: {
    system:
      "You are a code explanation assistant. Provide a clear, comprehensive explanation of what the file does, how it works, and any important patterns or considerations.",
    user: (args) =>
      `Explain the following file in detail:\n\nFILE: ${args.fileName}\nPATH: ${args.filePath}\n\nCODE:\n${args.code}${
        args.context ? `\n\nContext: ${args.context}` : ""
      }${codeGraphSection(args)}`,
  },

  analyze_files: {
    system:
      "You are a code analysis assistant. Provide a comprehensive analysis addressing the task. Focus on relationships, patterns, and insights across all files.",
    user: (args) => `TASK: ${args.task}\n\n${args.filesContent}${codeGraphSection(args)}`,
  },

  generate_code_with_context: {
    system:
      "You are a code generation assistant. Generate clean, well-commented code based on the requirements given, following the patterns shown in the reference files. Respond with ONLY the code, no explanations or markdown formatting. Make sure the code is production-ready.",
    user: (args) =>
      `Language: ${args.language}\n\nREQUIREMENTS:\n${args.prompt}${args.contextSection || ""}${codeGraphSection(args)}`,
  },
};

// Shared by the four file-aware tools above: folds in CodeGraph-derived context (call
// paths, blast radius) when index.js's getCodeGraphContext() found a .codegraph/ index for
// the project, empty string otherwise.
function codeGraphSection(args) {
  return args.codeGraphContext ? `\n\nCODEGRAPH CONTEXT (call paths, blast radius):\n${args.codeGraphContext}` : "";
}

// Sparse per-family overrides. Only populate an entry where a model family
// genuinely needs different framing than the default — most families are fine
// with DEFAULT_PROMPTS as-is since llama-server applies the model's own chat
// template on top of whatever we send here.
export const FAMILY_OVERRIDES = {
  deepseek: {
    fix_code: {
      system:
        "You are a meticulous debugging assistant. Reason through the bug step by step before answering, but keep your final answer formatted as:\n\nFIXED CODE:\n[code here]\n\nEXPLANATION:\n[brief explanation of the fix]",
    },
  },
  qwen: {
    write_tests: {
      system:
        "You are a precise test-writing assistant specialized in code. Generate complete, runnable tests with good coverage of edge cases. Include only the test code, properly formatted for the requested framework — no filler commentary.",
    },
  },
};

// Sparse per-tool model-family preferences, for setups running more than one model behind
// a router (e.g. llama-swap) where auto-detection has more than one candidate to choose
// from. Each entry is an ordered list of preferred families; the first one present in
// whatever /v1/models currently reports wins. Empty by default -- with a single model
// loaded (the common case), there's nothing to choose between and this has no effect.
// Populate your own, e.g. { write_tests: ["qwen"], fix_code: ["deepseek"] }.
export const TOOL_MODEL_PREFERENCES = {};

export function buildMessages(toolName, args, family) {
  const base = DEFAULT_PROMPTS[toolName];
  if (!base) {
    throw new Error(`No prompt template registered for tool: ${toolName}`);
  }

  const override = FAMILY_OVERRIDES[family]?.[toolName];
  const system = override?.system ?? base.system;
  const buildUser = override?.user ?? base.user;

  return [
    { role: "system", content: system },
    { role: "user", content: buildUser(args) },
  ];
}
