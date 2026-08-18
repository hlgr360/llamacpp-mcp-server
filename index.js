#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs/promises";
import { realpathSync } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildMessages, resolveFamily, TOOL_MODEL_PREFERENCES } from "./prompts.js";

const execFileAsync = promisify(execFile);

const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL || "http://localhost:8080";
const MODEL_CACHE_TTL_MS = 30_000;
const GLOB_METACHARACTERS = /[*?[{]/;
const MAX_GLOB_MATCHES = 50;
const CODEGRAPH_CONTEXT_CHAR_LIMIT = 4000;
const CODEGRAPH_TIMEOUT_MS = 5000;

const MODEL_ARG_SCHEMA = {
  type: "string",
  description:
    "Optional model override. If omitted, the model currently loaded by the llama.cpp server is auto-detected.",
};

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Expands any glob patterns (entries containing *, ?, [, or {) into absolute file paths;
// plain literal paths pass through unchanged. Relative patterns resolve against
// process.cwd(). Throws if the total expansion exceeds MAX_GLOB_MATCHES, so a broad
// pattern like "**/*.js" can't silently balloon a request into hundreds of files.
async function expandFilePaths(patterns) {
  const expanded = [];
  for (const pattern of patterns) {
    if (!GLOB_METACHARACTERS.test(pattern)) {
      expanded.push(pattern);
      continue;
    }
    for await (const match of fs.glob(pattern)) {
      expanded.push(path.resolve(match));
    }
  }

  if (expanded.length > MAX_GLOB_MATCHES) {
    throw new Error(
      `Glob pattern(s) matched ${expanded.length} files, which exceeds the limit of ${MAX_GLOB_MATCHES}. Narrow your pattern(s).`
    );
  }

  return expanded;
}

// Best-effort CodeGraph enrichment: if the target project has a .codegraph/ index, runs
// `codegraph explore <query>` and folds its output (call paths, blast radius) into the
// prompt sent to the local model. Returns null on any failure -- no .codegraph/ directory,
// the `codegraph` binary missing from PATH, a timeout, or a non-zero exit -- since this is
// strictly additive and must never block a tool response or require CodeGraph to be
// installed. The binary name is overridable via CODEGRAPH_BIN for testing.
async function getCodeGraphContext(query, cwd = process.cwd()) {
  try {
    await fs.access(path.join(cwd, ".codegraph"));
  } catch {
    return null;
  }

  try {
    const bin = process.env.CODEGRAPH_BIN || "codegraph";
    const { stdout } = await execFileAsync(bin, ["explore", query], {
      cwd,
      timeout: CODEGRAPH_TIMEOUT_MS,
    });
    return stdout.slice(0, CODEGRAPH_CONTEXT_CHAR_LIMIT);
  } catch {
    return null;
  }
}

class LlamaCppServer {
  constructor() {
    this.server = new Server(
      {
        name: "llamacpp-mcp-server",
        version: "2.4.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.modelsCache = null;
    this.modelsCacheAt = 0;
    this.tokenStats = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, perTool: {} };

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "llamacpp_generate_code",
          description: "Generate code using your local llama.cpp server. Use this for writing new functions, classes, or code snippets. Provide detailed requirements and context.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Detailed description of the code to generate, including requirements, language, and context",
              },
              language: {
                type: "string",
                description: "Programming language (e.g., javascript, python, rust)",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["prompt", "language"],
          },
        },
        {
          name: "llamacpp_explain_code",
          description: "Explain how code works using your local llama.cpp server. Use this to understand complex code sections, algorithms, or patterns.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to explain",
              },
              context: {
                type: "string",
                description: "Additional context about what you want to understand",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code"],
          },
        },
        {
          name: "llamacpp_review_code",
          description: "Review code for issues, bugs, or improvements using your local llama.cpp server. Use this for code quality checks and suggestions.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to review",
              },
              focus: {
                type: "string",
                description: "What to focus on (e.g., 'performance', 'security', 'best practices', 'bugs')",
                default: "general code quality",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code"],
          },
        },
        {
          name: "llamacpp_refactor_code",
          description: "Refactor code to improve quality, readability, or structure using your local llama.cpp server.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to refactor",
              },
              goal: {
                type: "string",
                description: "Refactoring goal (e.g., 'improve readability', 'reduce complexity', 'modernize syntax')",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code", "goal"],
          },
        },
        {
          name: "llamacpp_fix_code",
          description: "Fix bugs or errors in code using your local llama.cpp server. Provide the broken code and error details.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code with issues",
              },
              error: {
                type: "string",
                description: "Error message or description of the problem",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code", "error"],
          },
        },
        {
          name: "llamacpp_write_tests",
          description: "Generate unit tests for code using your local llama.cpp server.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "The code to write tests for",
              },
              framework: {
                type: "string",
                description: "Testing framework to use (e.g., 'jest', 'pytest', 'mocha')",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["code", "framework"],
          },
        },
        {
          name: "llamacpp_general_task",
          description: "Execute any general coding task using your local llama.cpp server. Use this for tasks that don't fit other categories.",
          inputSchema: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "Detailed description of the task to perform",
              },
              context: {
                type: "string",
                description: "Any relevant context, code, or background information",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["task"],
          },
        },
        {
          name: "llamacpp_review_file",
          description: "Review a file by path using your local llama.cpp server. The MCP server reads the file directly, reducing token usage.",
          inputSchema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Absolute path to the file to review",
              },
              focus: {
                type: "string",
                description: "What to focus on (e.g., 'performance', 'security', 'best practices', 'bugs')",
                default: "general code quality",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["file_path"],
          },
        },
        {
          name: "llamacpp_explain_file",
          description: "Explain a file by path using your local llama.cpp server. The MCP server reads the file directly, reducing token usage.",
          inputSchema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Absolute path to the file to explain",
              },
              context: {
                type: "string",
                description: "Additional context about what you want to understand",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["file_path"],
          },
        },
        {
          name: "llamacpp_analyze_files",
          description: "Analyze multiple files together using your local llama.cpp server. Useful for understanding relationships between files.",
          inputSchema: {
            type: "object",
            properties: {
              file_paths: {
                type: "array",
                items: { type: "string" },
                description: "Array of absolute paths to files to analyze together",
              },
              task: {
                type: "string",
                description: "What analysis to perform (e.g., 'find dependencies', 'check consistency', 'summarize architecture')",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["file_paths", "task"],
          },
        },
        {
          name: "llamacpp_generate_code_with_context",
          description: "Generate code using your local llama.cpp server with context from existing files. Reads reference files to understand patterns.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Detailed description of the code to generate",
              },
              language: {
                type: "string",
                description: "Programming language (e.g., javascript, python, rust)",
              },
              context_files: {
                type: "array",
                items: { type: "string" },
                description: "Array of file paths to use as context/examples",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["prompt", "language"],
          },
        },
        {
          name: "llamacpp_server_info",
          description: "Report which model the local llama.cpp server currently has loaded, its context size, and its capabilities. Use this to check what's actually running before assuming a model or capability.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "llamacpp_session_stats",
          description: "Report cumulative token usage sent to/received from the local llama.cpp server so far in this session, with a per-tool breakdown. Use this to see how many tokens have been offloaded from the orchestrating agent's own context.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "llamacpp_tokenize",
          description: "Count how many tokens a piece of text would consume according to the local llama.cpp server's currently loaded tokenizer. Useful for checking context-window fit before sending large content.",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The text to tokenize",
              },
              include_tokens: {
                type: "boolean",
                description: "If true, also return the raw token ID array (omitted by default to keep output small)",
                default: false,
              },
            },
            required: ["text"],
          },
        },
        {
          name: "llamacpp_semantic_similarity",
          description: "Rank a list of candidate texts by semantic similarity to a query, using the local llama.cpp server's embedding model. Returns similarity scores only, never raw embedding vectors, to keep output small.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The text to compare candidates against",
              },
              candidates: {
                type: "array",
                items: { type: "string" },
                description: "Texts to rank by similarity to the query",
              },
              model: MODEL_ARG_SCHEMA,
            },
            required: ["query", "candidates"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "llamacpp_generate_code":
            return await this.generateCode(args);
          case "llamacpp_explain_code":
            return await this.explainCode(args);
          case "llamacpp_review_code":
            return await this.reviewCode(args);
          case "llamacpp_refactor_code":
            return await this.refactorCode(args);
          case "llamacpp_fix_code":
            return await this.fixCode(args);
          case "llamacpp_write_tests":
            return await this.writeTests(args);
          case "llamacpp_general_task":
            return await this.generalTask(args);
          case "llamacpp_review_file":
            return await this.reviewFile(args);
          case "llamacpp_explain_file":
            return await this.explainFile(args);
          case "llamacpp_analyze_files":
            return await this.analyzeFiles(args);
          case "llamacpp_generate_code_with_context":
            return await this.generateCodeWithContext(args);
          case "llamacpp_server_info":
            return await this.serverInfo();
          case "llamacpp_session_stats":
            return this.sessionStats();
          case "llamacpp_tokenize":
            return await this.tokenize(args);
          case "llamacpp_semantic_similarity":
            return await this.semanticSimilarity(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  connectionErrorMessage() {
    return `Cannot connect to llama.cpp server. Make sure llama-server is running (default: ${LLAMACPP_BASE_URL}).`;
  }

  async fetchAvailableModels() {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCacheAt < MODEL_CACHE_TTL_MS) {
      return this.modelsCache;
    }

    try {
      const response = await axios.get(`${LLAMACPP_BASE_URL}/v1/models`, {
        timeout: 5000,
      });
      const models = response.data?.data ?? [];
      if (models.length === 0) {
        throw new Error("llama.cpp server reported no loaded model");
      }

      this.modelsCache = models;
      this.modelsCacheAt = now;
      return models;
    } catch (error) {
      this.modelsCache = null;
      if (error.code === "ECONNREFUSED") {
        throw new Error(this.connectionErrorMessage(), { cause: error });
      }
      throw new Error(`Failed to discover model from llama.cpp server: ${error.message}`, { cause: error });
    }
  }

  // Picks a model when the caller didn't specify one. With a single model loaded (the
  // common case), always resolves to it. Behind a multi-model router (e.g. llama-swap),
  // consults TOOL_MODEL_PREFERENCES for the given tool before falling back to whichever
  // model /v1/models lists first.
  async resolveModel(explicitModel, toolName) {
    if (explicitModel) {
      return { id: explicitModel, family: resolveFamily(explicitModel) };
    }

    const models = await this.fetchAvailableModels();

    const preferredFamilies = TOOL_MODEL_PREFERENCES[toolName];
    if (preferredFamilies) {
      for (const family of preferredFamilies) {
        const match = models.find((model) => resolveFamily(model.id) === family);
        if (match) return { id: match.id, family };
      }
    }

    const [first] = models;
    return { id: first.id, family: resolveFamily(first.id) };
  }

  async callLlamaCpp(toolName, args) {
    const { model: explicitModel, ...promptArgs } = args;
    const resolved = await this.resolveModel(explicitModel, toolName);
    const messages = buildMessages(toolName, promptArgs, resolved.family);

    try {
      const response = await axios.post(
        `${LLAMACPP_BASE_URL}/v1/chat/completions`,
        {
          model: resolved.id,
          messages,
          stream: false,
        },
        {
          timeout: 900000, // 15 minute timeout (overly long, to account for slow local models)
        }
      );

      this.recordTokenUsage(toolName, response.data.usage);
      return response.data.choices[0].message.content;
    } catch (error) {
      if (error.code === "ECONNREFUSED") {
        throw new Error(this.connectionErrorMessage(), { cause: error });
      }
      throw new Error(`llama.cpp error: ${error.message}`, { cause: error });
    }
  }

  recordTokenUsage(toolName, usage) {
    if (!usage) return;
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

    this.tokenStats.calls += 1;
    this.tokenStats.promptTokens += promptTokens;
    this.tokenStats.completionTokens += completionTokens;
    this.tokenStats.totalTokens += totalTokens;

    const perTool = this.tokenStats.perTool[toolName] ?? {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    perTool.calls += 1;
    perTool.promptTokens += promptTokens;
    perTool.completionTokens += completionTokens;
    perTool.totalTokens += totalTokens;
    this.tokenStats.perTool[toolName] = perTool;
  }

  sessionStats() {
    return { content: [{ type: "text", text: JSON.stringify(this.tokenStats, null, 2) }] };
  }

  async tokenize(args) {
    const { text, include_tokens } = args;
    try {
      const response = await axios.post(
        `${LLAMACPP_BASE_URL}/tokenize`,
        { content: text },
        { timeout: 10000 }
      );
      const tokens = response.data?.tokens ?? [];
      const info = { token_count: tokens.length };
      if (include_tokens) info.tokens = tokens;
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    } catch (error) {
      if (error.code === "ECONNREFUSED") {
        throw new Error(this.connectionErrorMessage(), { cause: error });
      }
      throw new Error(`Failed to tokenize text: ${error.message}`, { cause: error });
    }
  }

  async semanticSimilarity(args) {
    const { query, candidates, model: explicitModel } = args;
    const resolved = await this.resolveModel(explicitModel, "semantic_similarity");

    try {
      const response = await axios.post(
        `${LLAMACPP_BASE_URL}/v1/embeddings`,
        { model: resolved.id, input: [query, ...candidates] },
        { timeout: 60000 }
      );

      const vectors = response.data?.data?.map((entry) => entry.embedding) ?? [];
      const [queryVector, ...candidateVectors] = vectors;

      const results = candidateVectors
        .map((vector, index) => ({
          candidate: index,
          score: Math.round(cosineSimilarity(queryVector, vector) * 10000) / 10000,
        }))
        .sort((a, b) => b.score - a.score);

      return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
    } catch (error) {
      if (error.code === "ECONNREFUSED") {
        throw new Error(this.connectionErrorMessage(), { cause: error });
      }
      throw new Error(`Failed to compute semantic similarity: ${error.message}`, { cause: error });
    }
  }

  async generateCode(args) {
    const response = await this.callLlamaCpp("generate_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async explainCode(args) {
    const response = await this.callLlamaCpp("explain_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async reviewCode(args) {
    const response = await this.callLlamaCpp("review_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async refactorCode(args) {
    const response = await this.callLlamaCpp("refactor_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async fixCode(args) {
    const response = await this.callLlamaCpp("fix_code", args);
    return { content: [{ type: "text", text: response }] };
  }

  async writeTests(args) {
    const response = await this.callLlamaCpp("write_tests", args);
    return { content: [{ type: "text", text: response }] };
  }

  async generalTask(args) {
    const response = await this.callLlamaCpp("general_task", args);
    return { content: [{ type: "text", text: response }] };
  }

  async readFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return content;
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error.message}`, { cause: error });
    }
  }

  async reviewFile(args) {
    const { file_path, focus, model } = args;
    const code = await this.readFile(file_path);
    const fileName = path.basename(file_path);
    const codeGraphContext = await getCodeGraphContext(fileName);

    const response = await this.callLlamaCpp("review_file", {
      code,
      focus,
      fileName,
      filePath: file_path,
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async explainFile(args) {
    const { file_path, context, model } = args;
    const code = await this.readFile(file_path);
    const fileName = path.basename(file_path);
    const codeGraphContext = await getCodeGraphContext(fileName);

    const response = await this.callLlamaCpp("explain_file", {
      code,
      context,
      fileName,
      filePath: file_path,
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async analyzeFiles(args) {
    const { file_paths, task, model } = args;
    const expandedPaths = await expandFilePaths(file_paths);

    const filesContent = await Promise.all(
      expandedPaths.map(async (filePath) => {
        const content = await this.readFile(filePath);
        const fileName = path.basename(filePath);
        return `FILE: ${fileName}\nPATH: ${filePath}\n\nCODE:\n${content}\n\n${"=".repeat(80)}\n`;
      })
    );
    const codeGraphContext = await getCodeGraphContext(expandedPaths.map((p) => path.basename(p)).join(" "));

    const response = await this.callLlamaCpp("analyze_files", {
      task,
      filesContent: filesContent.join("\n"),
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async generateCodeWithContext(args) {
    const { prompt, language, context_files, model } = args;

    let contextSection = "";
    let codeGraphContext = null;
    if (context_files && context_files.length > 0) {
      const expandedContextFiles = await expandFilePaths(context_files);
      const contextContent = await Promise.all(
        expandedContextFiles.map(async (filePath) => {
          const content = await this.readFile(filePath);
          const fileName = path.basename(filePath);
          return `EXAMPLE FILE: ${fileName}\n${content}\n\n${"=".repeat(80)}\n`;
        })
      );
      contextSection = `\n\nREFERENCE FILES (for context and patterns):\n${contextContent.join("\n")}`;
      codeGraphContext = await getCodeGraphContext(expandedContextFiles.map((p) => path.basename(p)).join(" "));
    }

    const response = await this.callLlamaCpp("generate_code_with_context", {
      prompt,
      language,
      contextSection,
      codeGraphContext,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async serverInfo() {
    try {
      const [propsResponse, modelsResponse] = await Promise.all([
        axios.get(`${LLAMACPP_BASE_URL}/props`, { timeout: 5000 }),
        axios.get(`${LLAMACPP_BASE_URL}/v1/models`, { timeout: 5000 }),
      ]);

      const model = modelsResponse.data?.data?.[0];
      const props = propsResponse.data;

      const info = {
        base_url: LLAMACPP_BASE_URL,
        model_id: model?.id ?? null,
        model_family: model?.id ? resolveFamily(model.id) : null,
        context_size: props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null,
        total_slots: props?.total_slots ?? null,
        has_chat_template: Boolean(props?.chat_template),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    } catch (error) {
      if (error.code === "ECONNREFUSED") {
        throw new Error(this.connectionErrorMessage(), { cause: error });
      }
      throw new Error(`Failed to fetch llama.cpp server info: ${error.message}`, { cause: error });
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
    console.error(`llama.cpp MCP server running on stdio (target: ${LLAMACPP_BASE_URL})`);
  }
}

export { LlamaCppServer };

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const server = new LlamaCppServer();
  server.run();
}
