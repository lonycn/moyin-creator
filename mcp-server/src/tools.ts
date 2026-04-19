// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
//
// MCP 工具定义 — 把端到端「剧本 → 视频」流程拆成 LLM 友好的 tool 集合。
// 设计原则：
//   1. 每个 tool 是无状态的（接收 projectId，从 ProjectStore 读写状态）
//   2. tool 结果尽量精简，避免把整段剧本/角色库回传给 LLM 占用 context
//   3. 长任务（视频生成）的轮询在 tool 内完成，但允许指定 maxWaitSec 提前返回 task_id
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ApiClient, pollVideoTask } from './api-client.js';
import { ProjectStore } from './storage.js';
import { ServerConfig } from './config.js';

export interface ToolContext {
  client: ApiClient;
  store: ProjectStore;
  cfg: ServerConfig;
}

type JsonRecord = Record<string, unknown>;

interface ProjectMeta extends JsonRecord {
  projectId: string;
  title: string;
  synopsis: string;
  createdAt: string;
}

interface Character extends JsonRecord {
  name: string;
  description?: string;
  referenceImageUrl?: string;
  referencePrompt?: string;
}

interface Scene extends JsonRecord {
  id: string;
  title?: string;
  location?: string;
  timeOfDay?: string;
  summary?: string;
  characters?: string[];
  referenceImageUrl?: string;
  referencePrompt?: string;
}

interface ScriptData extends JsonRecord {
  title?: string;
  synopsis?: string;
  style?: string;
  characters?: Character[];
  scenes?: Scene[];
}

interface Shot extends JsonRecord {
  id: string;
  sceneId: string;
  shotType?: string;
  cameraMovement?: string;
  visualPrompt?: string;
  action?: string;
  dialogue?: string;
  duration?: number;
  videoTaskId?: string;
  videoPrompt?: string;
  videoUrl?: string;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): JsonRecord {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error('LLM did not return a JSON object');
  }
  return parsed;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function toCharacter(record: JsonRecord): Character | null {
  const name = readString(record.name);
  if (!name) return null;
  return {
    ...record,
    name,
    description: readString(record.description),
    referenceImageUrl: readString(record.referenceImageUrl),
    referencePrompt: readString(record.referencePrompt),
  };
}

function toScene(record: JsonRecord): Scene | null {
  const id = readString(record.id);
  if (!id) return null;
  return {
    ...record,
    id,
    title: readString(record.title),
    location: readString(record.location),
    timeOfDay: readString(record.timeOfDay),
    summary: readString(record.summary),
    characters: readStringArray(record.characters),
    referenceImageUrl: readString(record.referenceImageUrl),
    referencePrompt: readString(record.referencePrompt),
  };
}

function readCharacters(value: unknown): Character[] {
  return readRecordArray(value).map(toCharacter).filter((item): item is Character => item !== null);
}

function readScenes(value: unknown): Scene[] {
  return readRecordArray(value).map(toScene).filter((item): item is Scene => item !== null);
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============ Project ============

const CreateProjectInput = z.object({
  title: z.string().describe('项目标题，例如「灌篮少女 第一集」'),
  synopsis: z.string().optional().describe('项目简介，可选'),
});

const createProjectTool: ToolDef = {
  name: 'create_project',
  description: '创建一个新项目（视频创作的容器）。返回 projectId — 后续所有 tool 都需要它。',
  inputSchema: CreateProjectInput,
  handler: async (input, { store }) => {
    const projectId = `proj_${randomUUID().slice(0, 8)}`;
    const meta = {
      projectId,
      title: input.title,
      synopsis: input.synopsis || '',
      createdAt: new Date().toISOString(),
    };
    await store.writeJson(projectId, 'project', meta);
    return meta;
  },
};

const ListProjectsInput = z.object({});
const listProjectsTool: ToolDef = {
  name: 'list_projects',
  description: '列出所有已创建的项目。',
  inputSchema: ListProjectsInput,
  handler: async (_input, { store }) => {
    const ids = await store.listProjects();
    const projects: ProjectMeta[] = [];
    for (const id of ids) {
      const meta = await store.readJson<ProjectMeta>(id, 'project');
      if (meta) projects.push(meta);
    }
    return { projects };
  },
};

// ============ Script ============

const ParseScriptInput = z.object({
  projectId: z.string(),
  scriptText: z.string().describe('完整剧本文本，纯文本或 markdown'),
  style: z.string().optional().describe('视觉风格，例如「2D 动漫」「写实电影」「3D 动画」'),
});

/**
 * 用 LLM 把自由文本剧本结构化。返回简化版结构（场景标题 + 摘要 + 角色列表）。
 * 完整结构化数据已写入 script.json。
 */
const parseScriptTool: ToolDef = {
  name: 'parse_script',
  description: '把剧本文本解析为场景列表 + 角色列表。结构化结果存入项目，简略列表返回给调用者。',
  inputSchema: ParseScriptInput,
  handler: async (input, { client, store }) => {
    const sys = `你是一名剧本结构化助手。把用户提供的剧本拆为 JSON。
输出严格 JSON 格式：
{
  "title": "...",
  "synopsis": "...",
  "style": "${input.style || '2D 动漫'}",
  "characters": [{"name":"...", "description":"外貌+性格 一句话"}],
  "scenes": [{"id":"s1","title":"...","location":"...","timeOfDay":"日|夜","summary":"...","characters":["..."],"actions":["..."],"dialogues":[{"speaker":"...","text":"..."}]}]
}
不要输出任何 JSON 外的文字。`;
    const result = await client.chat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: input.scriptText },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    let parsed: JsonRecord;
    try {
      parsed = parseJsonRecord(result.content);
    } catch {
      throw new Error(`LLM did not return valid JSON: ${result.content.slice(0, 200)}`);
    }

    const scriptData: ScriptData = {
      ...parsed,
      title: readString(parsed.title),
      synopsis: readString(parsed.synopsis),
      style: readString(parsed.style),
      characters: readCharacters(parsed.characters),
      scenes: readScenes(parsed.scenes),
    };

    await store.writeJson(input.projectId, 'script', scriptData);
    await store.writeJson(input.projectId, 'characters', scriptData.characters ?? []);
    await store.writeJson(input.projectId, 'scenes', scriptData.scenes ?? []);

    return {
      title: scriptData.title,
      style: scriptData.style,
      characterCount: (scriptData.characters ?? []).length,
      sceneCount: (scriptData.scenes ?? []).length,
      characters: (scriptData.characters ?? []).map((c) => c.name),
      scenes: (scriptData.scenes ?? []).map((s) => ({ id: s.id, title: s.title, summary: s.summary })),
    };
  },
};

// ============ Characters ============

const GenerateCharacterImageInput = z.object({
  projectId: z.string(),
  characterName: z.string(),
  extraPrompt: z.string().optional().describe('额外的视觉描述，例如服装、动作'),
});

const generateCharacterImageTool: ToolDef = {
  name: 'generate_character_image',
  description: '为指定角色生成参考图（用于后续保持角色一致性）。生成后图片 URL 会回写到 characters.json。',
  inputSchema: GenerateCharacterImageInput,
  handler: async (input, { client, store }) => {
    const characters = (await store.readJson<Character[]>(input.projectId, 'characters')) || [];
    const ch = characters.find((c) => c.name === input.characterName);
    if (!ch) throw new Error(`Character not found: ${input.characterName}`);

    const script = await store.readJson<ScriptData>(input.projectId, 'script');
    const style = script?.style || '2D 动漫';

    const prompt = [
      `${style}风格`,
      `角色全身参考图：${ch.name}`,
      ch.description,
      input.extraPrompt,
      '正面站立，纯色背景，高清，角色设定参考图',
    ].filter(Boolean).join('，');

    const { urls } = await client.generateImage({ prompt, size: '1024x1024' });
    if (urls.length === 0) throw new Error('No image returned');

    ch.referenceImageUrl = urls[0];
    ch.referencePrompt = prompt;
    await store.writeJson(input.projectId, 'characters', characters);

    return { characterName: ch.name, imageUrl: urls[0], prompt };
  },
};

// ============ Scenes ============

const GenerateSceneImageInput = z.object({
  projectId: z.string(),
  sceneId: z.string(),
  extraPrompt: z.string().optional(),
});

const generateSceneImageTool: ToolDef = {
  name: 'generate_scene_image',
  description: '为指定场景生成环境参考图。',
  inputSchema: GenerateSceneImageInput,
  handler: async (input, { client, store }) => {
    const scenes = (await store.readJson<Scene[]>(input.projectId, 'scenes')) || [];
    const scene = scenes.find((s) => s.id === input.sceneId);
    if (!scene) throw new Error(`Scene not found: ${input.sceneId}`);

    const script = await store.readJson<ScriptData>(input.projectId, 'script');
    const style = script?.style || '2D 动漫';

    const prompt = [
      `${style}风格`,
      `场景环境图：${scene.title}`,
      `地点：${scene.location}`,
      `时间：${scene.timeOfDay || '日'}`,
      scene.summary,
      input.extraPrompt,
      '电影级构图，无人物，环境氛围参考图',
    ].filter(Boolean).join('，');

    const { urls } = await client.generateImage({ prompt, size: '1280x720' });
    if (urls.length === 0) throw new Error('No image returned');

    scene.referenceImageUrl = urls[0];
    scene.referencePrompt = prompt;
    await store.writeJson(input.projectId, 'scenes', scenes);

    return { sceneId: scene.id, imageUrl: urls[0], prompt };
  },
};

// ============ Shots ============

const GenerateShotsInput = z.object({
  projectId: z.string(),
  sceneId: z.string(),
  shotsPerScene: z.number().int().min(1).max(8).default(3),
});

const generateShotsTool: ToolDef = {
  name: 'generate_shots',
  description: '为指定场景生成分镜列表（含每个分镜的镜头语言、视觉描述、对白）。',
  inputSchema: GenerateShotsInput,
  handler: async (input, { client, store }) => {
    const scenes = (await store.readJson<Scene[]>(input.projectId, 'scenes')) || [];
    const scene = scenes.find((s) => s.id === input.sceneId);
    if (!scene) throw new Error(`Scene not found: ${input.sceneId}`);

    const sys = `你是一名影视分镜师。根据场景信息，输出 ${input.shotsPerScene} 个分镜。
输出严格 JSON：
{"shots":[{"id":"...","shotType":"近景|中景|远景|特写","cameraMovement":"推|拉|摇|移|跟|静止","visualPrompt":"画面视觉描述","action":"角色动作","dialogue":"对白(可空)","duration":3}]}`;
    const userMsg = JSON.stringify({ scene, characterCount: input.shotsPerScene });

    const result = await client.chat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userMsg },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5,
    });

    let parsed: JsonRecord;
    try {
      parsed = parseJsonRecord(result.content);
    } catch {
      throw new Error(`LLM did not return valid JSON: ${result.content.slice(0, 200)}`);
    }

    const newShots: Shot[] = readRecordArray(parsed.shots).map((shotRecord, i) => ({
      ...shotRecord,
      id: readString(shotRecord.id) || `${input.sceneId}-shot-${i + 1}`,
      sceneId: input.sceneId,
    }));

    const allShots = (await store.readJson<Shot[]>(input.projectId, 'shots')) || [];
    const filtered = allShots.filter((s) => s.sceneId !== input.sceneId);
    await store.writeJson(input.projectId, 'shots', [...filtered, ...newShots]);

    return {
      sceneId: input.sceneId,
      count: newShots.length,
      shots: newShots.map((s) => ({ id: s.id, shotType: s.shotType, visualPrompt: s.visualPrompt })),
    };
  },
};

// ============ Video generation ============

const GenerateShotVideoInput = z.object({
  projectId: z.string(),
  shotId: z.string(),
  duration: z.number().int().min(3).max(10).default(5),
  aspectRatio: z.string().default('16:9'),
  maxWaitSec: z.number().int().default(600).describe('最长等待秒数，超时后返回 taskId 让调用者后续查询'),
});

const generateShotVideoTool: ToolDef = {
  name: 'generate_shot_video',
  description: '为指定分镜生成视频（S 级 Seedance）。会自动收集对应场景图 + 涉及角色的参考图作为多模态输入。耗时较长，返回 videoUrl 或 taskId。',
  inputSchema: GenerateShotVideoInput,
  handler: async (input, { client, store, cfg }) => {
    const shots = (await store.readJson<Shot[]>(input.projectId, 'shots')) || [];
    const shot = shots.find((s) => s.id === input.shotId);
    if (!shot) throw new Error(`Shot not found: ${input.shotId}`);

    const scenes = (await store.readJson<Scene[]>(input.projectId, 'scenes')) || [];
    const characters = (await store.readJson<Character[]>(input.projectId, 'characters')) || [];
    const scene = scenes.find((s) => s.id === shot.sceneId);

    // 收集参考图：场景图 + 角色图
    const refImages: string[] = [];
    if (scene?.referenceImageUrl) refImages.push(scene.referenceImageUrl);
    for (const ch of characters) {
      if (ch.referenceImageUrl && (scene?.characters || []).includes(ch.name)) {
        refImages.push(ch.referenceImageUrl);
      }
    }
    // Seedance 2.0 硬约束：≤9 图
    const limited = refImages.slice(0, 9);

    const prompt = [
      shot.visualPrompt,
      shot.action ? `动作：${shot.action}` : '',
      shot.dialogue ? `对白：${shot.dialogue}` : '',
      `镜头：${shot.shotType || '中景'} ${shot.cameraMovement || '静止'}`,
    ].filter(Boolean).join('。').slice(0, 4900);

    const { taskId } = await client.submitVideoTask({
      prompt,
      firstFrameImageUrl: scene?.referenceImageUrl,
      referenceImages: limited,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
    });

    shot.videoTaskId = taskId;
    shot.videoPrompt = prompt;
    await store.writeJson(input.projectId, 'shots', shots);

    const timeoutMs = Math.min(input.maxWaitSec * 1000, cfg.pollTimeoutMs);
    try {
      const { videoUrl } = await pollVideoTask(client, taskId, {
        intervalMs: cfg.pollIntervalMs,
        timeoutMs,
      });
      shot.videoUrl = videoUrl;
      await store.writeJson(input.projectId, 'shots', shots);
      return { shotId: shot.id, videoUrl, taskId, status: 'succeeded' };
    } catch (err: unknown) {
      if (getErrorMessage(err).includes('timeout')) {
        return { shotId: shot.id, taskId, status: 'pending', message: `Still running, query with get_video_task_status(taskId="${taskId}")` };
      }
      throw err;
    }
  },
};

const GetVideoTaskStatusInput = z.object({
  projectId: z.string(),
  shotId: z.string(),
});

const getVideoTaskStatusTool: ToolDef = {
  name: 'get_video_task_status',
  description: '查询某个分镜视频生成任务的当前状态（用于异步等待）。',
  inputSchema: GetVideoTaskStatusInput,
  handler: async (input, { client, store }) => {
    const shots = (await store.readJson<Shot[]>(input.projectId, 'shots')) || [];
    const shot = shots.find((s) => s.id === input.shotId);
    if (!shot?.videoTaskId) throw new Error(`No video task for shot ${input.shotId}`);
    const result = await client.getVideoTask(shot.videoTaskId);
    if (result.status === 'succeeded' && result.videoUrl) {
      shot.videoUrl = result.videoUrl;
      await store.writeJson(input.projectId, 'shots', shots);
    }
    return {
      shotId: input.shotId,
      taskId: shot.videoTaskId,
      status: result.status,
      videoUrl: result.videoUrl,
      progress: result.progress,
      error: result.error,
    };
  },
};

// ============ Project state inspection ============

const GetProjectInput = z.object({
  projectId: z.string(),
});

const getProjectTool: ToolDef = {
  name: 'get_project',
  description: '读取项目当前完整状态（剧本 + 场景 + 角色 + 分镜 + 视频生成进度）。',
  inputSchema: GetProjectInput,
  handler: async (input, { store }) => {
    const meta = await store.readJson<ProjectMeta>(input.projectId, 'project');
    if (!meta) throw new Error(`Project not found: ${input.projectId}`);
    return {
      ...meta,
      script: await store.readJson(input.projectId, 'script'),
      characters: await store.readJson(input.projectId, 'characters'),
      scenes: await store.readJson(input.projectId, 'scenes'),
      shots: await store.readJson(input.projectId, 'shots'),
    };
  },
};

export const TOOLS: ToolDef[] = [
  createProjectTool,
  listProjectsTool,
  parseScriptTool,
  generateCharacterImageTool,
  generateSceneImageTool,
  generateShotsTool,
  generateShotVideoTool,
  getVideoTaskStatusTool,
  getProjectTool,
];
