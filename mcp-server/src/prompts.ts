// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
//
// MCP Prompts — 端到端工作流模板，让连上 server 的 LLM 立刻知道怎么用。
// 在 Claude Desktop / Cursor 中会显示为可选的 slash command。
import { z } from 'zod';

export interface PromptDef {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  /** 渲染成最终 messages 数组发给 LLM */
  render: (args: Record<string, string>) => Array<{ role: 'user' | 'assistant'; content: string }>;
}

const createVideoFromScript: PromptDef = {
  name: 'create_video_from_script',
  description: '端到端：从一段剧本文本，自动生成完整视频（角色图 → 场景图 → 分镜 → 视频）。',
  arguments: [
    { name: 'title', description: '项目标题', required: true },
    { name: 'script', description: '剧本文本（纯文本/Markdown）', required: true },
    { name: 'style', description: '视觉风格，例如「2D 动漫」「写实电影」「3D 动画」', required: false },
    { name: 'shotsPerScene', description: '每个场景的分镜数（默认 3）', required: false },
  ],
  render: (args) => {
    const style = args.style || '2D 动漫';
    const shotsPerScene = args.shotsPerScene || '3';
    return [
      {
        role: 'user',
        content: `用 moyin-creator MCP 工具，把下面的剧本变成完整视频。请严格按这个工作流执行，每一步完成后再做下一步：

**项目标题**：${args.title}
**视觉风格**：${style}
**每场景分镜数**：${shotsPerScene}

**剧本**：
\`\`\`
${args.script}
\`\`\`

**执行步骤**：

1. 调用 \`create_project\`，记下 projectId。
2. 调用 \`parse_script\`（projectId, scriptText, style）解析剧本，得到角色列表和场景列表。
3. 对每个角色，调用 \`generate_character_image\` 生成参考图。**这一步可以并行**。
4. 对每个场景，调用 \`generate_scene_image\` 生成场景环境图。**这一步可以并行**。
5. 对每个场景，调用 \`generate_shots\`（shotsPerScene=${shotsPerScene}）生成分镜。
6. 对每个分镜，调用 \`generate_shot_video\` 生成视频。视频是长任务（每个 1-5 分钟），按以下策略：
   - 先并发提交所有分镜（每个 \`generate_shot_video\` 内部会自动收集场景图+角色图作为参考）
   - 用 \`maxWaitSec: 60\` 让单次 tool 调用快速返回，拿到 \`taskId\` 后用 \`get_video_task_status\` 轮询
7. 所有分镜完成后，调用 \`get_project\` 汇总，给我列出所有视频 URL。

**关键原则**：
- 每步出错立即停下，告诉我哪个角色/场景/分镜失败、错误信息
- Seedance 视频生成有硬约束（参考图 ≤9 张），\`generate_shot_video\` 已自动处理
- 不要自己编造 URL 或 ID，全部从 tool 返回值里取`,
      },
    ];
  },
};

const generateSingleShot: PromptDef = {
  name: 'generate_single_shot',
  description: '在已有项目里，对某个分镜单独重生视频（用于迭代某一个不满意的镜头）。',
  arguments: [
    { name: 'projectId', description: '项目 ID', required: true },
    { name: 'shotId', description: '分镜 ID', required: true },
    { name: 'tweakPrompt', description: '想要的调整方向（自然语言）', required: false },
  ],
  render: (args) => [
    {
      role: 'user',
      content: `用 moyin-creator MCP 重新生成单个分镜的视频。

projectId=${args.projectId}, shotId=${args.shotId}
${args.tweakPrompt ? `调整方向：${args.tweakPrompt}` : ''}

步骤：
1. \`get_project\` 拿到当前完整状态
2. ${args.tweakPrompt ? '根据调整方向，改写该分镜的 visualPrompt 或 action（直接修改后写回 shots.json — 但 MCP 没暴露写接口，因此请直接调用 generate_shot_video 时无法传 prompt，改用以下变通：让我手动确认是否需要先调 parse_script 重新生成；或直接重跑该分镜接受当前 prompt）' : '直接调用 generate_shot_video'}
3. \`generate_shot_video\`（shotId=${args.shotId}, maxWaitSec=600）
4. 返回新视频 URL`,
    },
  ],
};

const inspectProject: PromptDef = {
  name: 'inspect_project',
  description: '查看一个项目的完整状态（剧本/角色/场景/分镜/视频进度）。',
  arguments: [
    { name: 'projectId', description: '项目 ID', required: true },
  ],
  render: (args) => [
    {
      role: 'user',
      content: `用 moyin-creator MCP 的 \`get_project\` 读取 projectId="${args.projectId}" 的完整状态，给我一个清晰的报告：
- 项目元数据
- 角色总数 + 已生成参考图的数量
- 场景总数 + 已生成场景图的数量
- 分镜总数 + 已生成视频的数量、未完成的 taskId 列表
- 任何错误状态`,
    },
  ],
};

export const PROMPTS: PromptDef[] = [
  createVideoFromScript,
  generateSingleShot,
  inspectProject,
];

// 让外面也能拿到 zod schema 校验入参（虽然 MCP prompts 协议不严格要求）
export const PROMPT_ARG_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  create_video_from_script: z.object({
    title: z.string(),
    script: z.string(),
    style: z.string().optional(),
    shotsPerScene: z.string().optional(),
  }),
  generate_single_shot: z.object({
    projectId: z.string(),
    shotId: z.string(),
    tweakPrompt: z.string().optional(),
  }),
  inspect_project: z.object({
    projectId: z.string(),
  }),
};
