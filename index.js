#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { buildMessages, resolveFamily } from "./prompts.js";

const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL || "http://localhost:8080";
const MODEL_CACHE_TTL_MS = 30_000;

const MODEL_ARG_SCHEMA = {
  type: "string",
  description:
    "Optional model override. If omitted, the model currently loaded by the llama.cpp server is auto-detected.",
};

class LlamaCppServer {
  constructor() {
    this.server = new Server(
      {
        name: "llamacpp-mcp-server",
        version: "2.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.modelCache = null;
    this.modelCacheAt = 0;

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
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

  async resolveModel(explicitModel) {
    if (explicitModel) {
      return { id: explicitModel, family: resolveFamily(explicitModel) };
    }

    const now = Date.now();
    if (this.modelCache && now - this.modelCacheAt < MODEL_CACHE_TTL_MS) {
      return this.modelCache;
    }

    try {
      const response = await axios.get(`${LLAMACPP_BASE_URL}/v1/models`, {
        timeout: 5000,
      });
      const model = response.data?.data?.[0];
      if (!model?.id) {
        throw new Error("llama.cpp server reported no loaded model");
      }

      const resolved = { id: model.id, family: resolveFamily(model.id) };
      this.modelCache = resolved;
      this.modelCacheAt = now;
      return resolved;
    } catch (error) {
      this.modelCache = null;
      if (error.code === "ECONNREFUSED") {
        throw new Error(this.connectionErrorMessage());
      }
      throw new Error(`Failed to discover model from llama.cpp server: ${error.message}`);
    }
  }

  async callLlamaCpp(toolName, args) {
    const { model: explicitModel, ...promptArgs } = args;
    const resolved = await this.resolveModel(explicitModel);
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

      return response.data.choices[0].message.content;
    } catch (error) {
      if (error.code === "ECONNREFUSED") {
        throw new Error(this.connectionErrorMessage());
      }
      throw new Error(`llama.cpp error: ${error.message}`);
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
      throw new Error(`Failed to read file ${filePath}: ${error.message}`);
    }
  }

  async reviewFile(args) {
    const { file_path, focus, model } = args;
    const code = await this.readFile(file_path);
    const fileName = path.basename(file_path);

    const response = await this.callLlamaCpp("review_file", {
      code,
      focus,
      fileName,
      filePath: file_path,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async explainFile(args) {
    const { file_path, context, model } = args;
    const code = await this.readFile(file_path);
    const fileName = path.basename(file_path);

    const response = await this.callLlamaCpp("explain_file", {
      code,
      context,
      fileName,
      filePath: file_path,
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async analyzeFiles(args) {
    const { file_paths, task, model } = args;

    const filesContent = await Promise.all(
      file_paths.map(async (filePath) => {
        const content = await this.readFile(filePath);
        const fileName = path.basename(filePath);
        return `FILE: ${fileName}\nPATH: ${filePath}\n\nCODE:\n${content}\n\n${"=".repeat(80)}\n`;
      })
    );

    const response = await this.callLlamaCpp("analyze_files", {
      task,
      filesContent: filesContent.join("\n"),
      model,
    });
    return { content: [{ type: "text", text: response }] };
  }

  async generateCodeWithContext(args) {
    const { prompt, language, context_files, model } = args;

    let contextSection = "";
    if (context_files && context_files.length > 0) {
      const contextContent = await Promise.all(
        context_files.map(async (filePath) => {
          const content = await this.readFile(filePath);
          const fileName = path.basename(filePath);
          return `EXAMPLE FILE: ${fileName}\n${content}\n\n${"=".repeat(80)}\n`;
        })
      );
      contextSection = `\n\nREFERENCE FILES (for context and patterns):\n${contextContent.join("\n")}`;
    }

    const response = await this.callLlamaCpp("generate_code_with_context", {
      prompt,
      language,
      contextSection,
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
        throw new Error(this.connectionErrorMessage());
      }
      throw new Error(`Failed to fetch llama.cpp server info: ${error.message}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`llama.cpp MCP server running on stdio (target: ${LLAMACPP_BASE_URL})`);
  }
}

const server = new LlamaCppServer();
server.run();
