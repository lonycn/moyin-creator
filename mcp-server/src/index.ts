#!/usr/bin/env node
// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
//
// Moyin Creator MCP Server 入口。
// 通过 stdio 协议与 MCP 客户端（Claude Desktop / Cursor / Claude Code）通信。
//
// 启动前需设置环境变量：
//   MOYIN_API_KEY        — 必填，OpenAI 兼容 API Key（多个用逗号分隔）
//   MOYIN_API_BASE_URL   — 可选，默认 https://api.memefast.cn/v1
//   MOYIN_IMAGE_MODEL    — 可选，默认 gemini-3-pro-image-preview
//   MOYIN_VIDEO_MODEL    — 可选，默认 doubao-seedance-1-5-pro-251215
//   MOYIN_CHAT_MODEL     — 可选，默认 gpt-4o-mini
//   MOYIN_DATA_DIR       — 可选，默认 ~/.moyin-mcp
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { ApiClient } from './api-client.js';
import { ProjectStore } from './storage.js';
import { TOOLS, type ToolContext } from './tools.js';
import { PROMPTS } from './prompts.js';

type JsonSchema = Record<string, unknown>;
type ZodObjectSchema = z.ZodObject<z.ZodRawShape>;

function getInnerType(field: z.ZodTypeAny): z.ZodTypeAny {
  let current = field;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    current = current.removeDefault();
  }
  return current;
}

async function main() {
  const cfg = loadConfig();
  const ctx: ToolContext = {
    cfg,
    client: new ApiClient(cfg.provider),
    store: new ProjectStore(cfg.dataDir),
  };

  const server = new Server(
    { name: 'moyin-creator', version: '0.1.0' },
    { capabilities: { tools: {}, prompts: {} } },
  );

  // Convert each tool's zod schema → JSONSchema for MCP listing.
  const toolList = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
    const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
    const result = await tool.handler(parsed, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  });

  // Prompts — 工作流模板，让客户端用户能一键执行端到端流程
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = PROMPTS.find((p) => p.name === req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    for (const def of prompt.arguments) {
      if (def.required && !args[def.name]) {
        throw new Error(`Missing required prompt argument: ${def.name}`);
      }
    }
    const messages = prompt.render(args).map((m) => ({
      role: m.role,
      content: { type: 'text' as const, text: m.content },
    }));
    return { description: prompt.description, messages };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 进程保活由 stdio transport 控制
}

/**
 * 极简的 zod → JSONSchema 转换。仅支持 ZodObject + 常见基本类型，
 * 够 MCP tool 的描述用，避免引入额外依赖（zod-to-json-schema 也可，但这里手写更可控）。
 */
function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('Only ZodObject schemas are supported for MCP tool inputSchema');
  }
  const shape = schema.shape;
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const typedValue = value as z.ZodTypeAny;
    properties[key] = zodFieldToJsonSchema(typedValue);
    if (!typedValue.isOptional()) {
      required.push(key);
    }
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function zodFieldToJsonSchema(field: z.ZodTypeAny): JsonSchema {
  const description = field.description;
  const base = (() => {
    const inner = getInnerType(field);

    if (inner instanceof z.ZodString) return { type: 'string' };
    if (inner instanceof z.ZodNumber) return { type: 'number' };
    if (inner instanceof z.ZodBoolean) return { type: 'boolean' };
    if (inner instanceof z.ZodArray) return { type: 'array', items: zodFieldToJsonSchema(inner._def.type) };
    if (inner instanceof z.ZodEnum) return { type: 'string', enum: inner.options };
    if (inner instanceof z.ZodObject) return zodToJsonSchema(inner as ZodObjectSchema);
    return { type: 'string' };
  })();
  return description ? { ...base, description } : base;
}

main().catch((err) => {
  console.error('[moyin-mcp] fatal:', err);
  process.exit(1);
});
