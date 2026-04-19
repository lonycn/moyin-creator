// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
//
// MCP server config — 从环境变量加载 API Key 与默认模型。
// 故意不复用 src/stores/api-config-store（依赖 Zustand + localStorage + Electron），
// MCP 走环境变量是最直接、最不易出错的方式。
import path from 'node:path';
import os from 'node:os';

export interface ProviderConfig {
  /** OpenAI 兼容协议的 base URL，例：https://api.memefast.cn/v1 */
  baseUrl: string;
  /** API Key（多个用逗号分隔可启用轮询） */
  apiKey: string;
  /** 文生图默认模型 */
  imageModel: string;
  /** 图生视频/文生视频默认模型 */
  videoModel: string;
  /** 文本对话/剧本解析默认模型 */
  chatModel: string;
}

export interface ServerConfig {
  provider: ProviderConfig;
  /** MCP server 内部数据目录，存项目 JSON、生成结果索引等 */
  dataDir: string;
  /** 单次轮询超时（毫秒） */
  pollTimeoutMs: number;
  /** 轮询间隔（毫秒） */
  pollIntervalMs: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function defaultDataDir(): string {
  return path.join(os.homedir(), '.moyin-mcp');
}

export function loadConfig(): ServerConfig {
  return {
    provider: {
      baseUrl: process.env.MOYIN_API_BASE_URL?.trim() || 'https://api.memefast.cn/v1',
      apiKey: requireEnv('MOYIN_API_KEY'),
      imageModel: process.env.MOYIN_IMAGE_MODEL?.trim() || 'gemini-3-pro-image-preview',
      videoModel: process.env.MOYIN_VIDEO_MODEL?.trim() || 'doubao-seedance-1-5-pro-251215',
      chatModel: process.env.MOYIN_CHAT_MODEL?.trim() || 'gpt-4o-mini',
    },
    dataDir: process.env.MOYIN_DATA_DIR?.trim() || defaultDataDir(),
    pollTimeoutMs: Number(process.env.MOYIN_POLL_TIMEOUT_MS) || 30 * 60 * 1000,
    pollIntervalMs: Number(process.env.MOYIN_POLL_INTERVAL_MS) || 3000,
  };
}

/** 从逗号分隔的 apiKey 字符串中按轮询取一个 */
let keyRotation = 0;
export function pickApiKey(apiKey: string): string {
  const keys = apiKey.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error('No API key available');
  const key = keys[keyRotation % keys.length];
  keyRotation += 1;
  return key;
}
