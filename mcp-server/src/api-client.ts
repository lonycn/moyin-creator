// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
//
// OpenAI 兼容协议客户端 — 直接 fetch，不依赖 src/lib 下的任何浏览器代码。
// 同时支持同步响应（chat/images）和异步任务轮询（视频生成走豆包/即梦风格的 task_id）。
import { ProviderConfig, pickApiKey } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

export interface ChatCompletionResult {
  content: string;
  raw: unknown;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class ApiClient {
  constructor(private readonly cfg: ProviderConfig) {}

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${pickApiKey(this.cfg.apiKey)}`,
      'Content-Type': 'application/json',
    };
  }

  /** OpenAI 兼容 /v1/chat/completions */
  async chat(args: {
    model?: string;
    messages: ChatMessage[];
    temperature?: number;
    response_format?: { type: 'json_object' | 'text' };
  }): Promise<ChatCompletionResult> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: args.model || this.cfg.chatModel,
      messages: args.messages,
      temperature: args.temperature ?? 0.7,
      ...(args.response_format ? { response_format: args.response_format } : {}),
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Chat API ${resp.status}: ${await resp.text()}`);
    }
    const data: unknown = await resp.json();
    const root = readRecord(data);
    const choices = readArray(root?.choices);
    const firstChoice = readRecord(choices[0]);
    const message = readRecord(firstChoice?.message);
    const content = readString(message?.content) ?? '';
    return { content, raw: data };
  }

  /**
   * 文生图 — OpenAI 兼容 /v1/images/generations。
   * 返回图片 URL 列表（魔因/memefast 通常返回 URL）。
   */
  async generateImage(args: {
    model?: string;
    prompt: string;
    size?: string;
    n?: number;
    referenceImages?: string[]; // base64 或 URL（取决于供应商）
  }): Promise<{ urls: string[]; raw: unknown }> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/images/generations`;
    const body: Record<string, unknown> = {
      model: args.model || this.cfg.imageModel,
      prompt: args.prompt,
      n: args.n ?? 1,
      size: args.size || '1024x1024',
    };
    if (args.referenceImages && args.referenceImages.length > 0) {
      body.image = args.referenceImages;
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Image API ${resp.status}: ${await resp.text()}`);
    }
    const data: unknown = await resp.json();
    const root = readRecord(data);
    const urls = readArray(root?.data)
      .map((item) => {
        const record = readRecord(item);
        return readString(record?.url) ?? readString(record?.image_url) ?? readString(record?.b64_json);
      })
      .filter((value): value is string => Boolean(value));
    return { urls, raw: data };
  }

  /**
   * 视频生成（异步任务）— 豆包 Seedance / 即梦风格的 task_id 协议。
   * 提交任务，返回 task_id；用 pollVideoTask 轮询。
   */
  async submitVideoTask(args: {
    model?: string;
    prompt: string;
    firstFrameImageUrl?: string;
    referenceImages?: string[];
    duration?: number;
    aspectRatio?: string;
  }): Promise<{ taskId: string; raw: unknown }> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/videos/generations`;
    const body: Record<string, unknown> = {
      model: args.model || this.cfg.videoModel,
      prompt: args.prompt,
      duration: args.duration ?? 5,
      aspect_ratio: args.aspectRatio || '16:9',
    };
    if (args.firstFrameImageUrl) body.first_frame_image = args.firstFrameImageUrl;
    if (args.referenceImages && args.referenceImages.length > 0) {
      body.reference_images = args.referenceImages;
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Video submit ${resp.status}: ${await resp.text()}`);
    }
    const data: unknown = await resp.json();
    const root = readRecord(data);
    const nestedData = readRecord(root?.data);
    const taskId = readString(root?.task_id) ?? readString(root?.id) ?? readString(nestedData?.task_id);
    if (!taskId) throw new Error(`Video submit missing task_id: ${JSON.stringify(data)}`);
    return { taskId, raw: data };
  }

  /** 查询视频任务状态 */
  async getVideoTask(taskId: string): Promise<{
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    videoUrl?: string;
    progress?: number;
    error?: string;
    raw: unknown;
  }> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/videos/generations/${taskId}`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) {
      throw new Error(`Video query ${resp.status}: ${await resp.text()}`);
    }
    const data: unknown = await resp.json();
    const root = readRecord(data);
    const output = readRecord(root?.output);
    const nestedData = readRecord(root?.data);
    const rawStatus = String(readString(root?.status) ?? readString(root?.task_status) ?? '').toLowerCase();
    let status: 'queued' | 'running' | 'succeeded' | 'failed' = 'queued';
    if (['success', 'succeeded', 'done', 'completed'].includes(rawStatus)) status = 'succeeded';
    else if (['failed', 'error', 'cancelled'].includes(rawStatus)) status = 'failed';
    else if (['running', 'processing', 'in_progress'].includes(rawStatus)) status = 'running';

    return {
      status,
      videoUrl: readString(root?.video_url) ?? readString(output?.video_url) ?? readString(nestedData?.video_url),
      progress: readNumber(root?.progress),
      error: readString(root?.error) ?? readString(root?.message),
      raw: data,
    };
  }
}

/**
 * 轮询直到任务完成或超时。
 * 不依赖 src/packages/ai-core/api/task-poller.ts（那个文件没有 Node 友好的 fetch 注入接口）。
 */
export async function pollVideoTask(
  client: ApiClient,
  taskId: string,
  opts: { intervalMs: number; timeoutMs: number; onProgress?: (p: number) => void },
): Promise<{ videoUrl: string; raw: unknown }> {
  const start = Date.now();
  while (Date.now() - start <= opts.timeoutMs) {
    const result = await client.getVideoTask(taskId);
    if (result.status === 'succeeded' && result.videoUrl) {
      return { videoUrl: result.videoUrl, raw: result.raw };
    }
    if (result.status === 'failed') {
      throw new Error(`Video task failed: ${result.error || 'unknown'}`);
    }
    if (typeof result.progress === 'number') opts.onProgress?.(result.progress);
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`Video task timeout after ${opts.timeoutMs}ms (task=${taskId})`);
}
