# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

**魔因漫创 (Moyin Creator)** 是一款面向 AI 影视创作者的桌面端工具（Electron + React），覆盖「剧本 → 角色 → 场景 → 导演 → S 级」五大板块的批量化生产链路。核心价值在于把多个 AI 图像/视频生成服务商串成一条流水线，并通过结构化提示词与素材引用保证角色与场景一致性。

技术栈：Electron 30 + React 18 + TypeScript + electron-vite (Vite 5) + Zustand 5 + Radix UI + Tailwind CSS 4。

## 常用命令

```bash
# Web 开发模式（默认，纯浏览器，不启动 Electron） — vite.web.config.ts
npm run dev

# 桌面端开发模式（electron-vite dev，主进程 + 渲染端）
npm run dev:desktop

# Web 构建（产物到 dist-web/）
npm run build:web

# Lint (零警告策略，max-warnings 0)
npm run lint

# 仅编译渲染/主/preload (不打包安装程序，便于排查类型/构建错误)
npx electron-vite build

# 全平台构建入口 (会先跑 electron-vite build，再调 electron-builder)
npm run build           # 按当前平台
npm run build:mac:arm64 # macOS Apple Silicon
npm run build:mac:x64   # macOS Intel
npm run build:win       # Windows NSIS
npm run build:linux

# 打包前 Windows 清理 (PowerShell, 仅 Windows 上有效)
npm run prebuild
```

注意事项：
- `npm run build` 会触发 `prebuild` 钩子，该钩子是 PowerShell 脚本，在非 Windows 平台直接跑 `npm run build` 会失败 — macOS/Linux 上请用 `build:mac:*` / `build:linux`，它们绕过 prebuild 直接走 `scripts/build-desktop.mjs`。
- 没有测试套件，也没有单测脚本。验证改动靠 `npm run lint` + `npx electron-vite build` + 手动启动 `npm run dev` 走真实流程。
- 项目无 `.cursorrules` / `.github/copilot-instructions.md`。
- **Web 模式下** Electron-only 能力（`window.fileStorage`、`window.imageStorage`、`window.electronAPI`、本地媒体文件 I/O）会失活；现有代码已通过 `isElectron()` 检测降级到 localStorage / IndexedDB，但任何依赖文件系统的功能（导入/导出项目、移动数据目录、保存图片到本地）在浏览器里不可用。修改 Electron-only 路径时记得给 Web 分支留 fallback。

## 高层架构

### 进程模型 (Electron)

- `electron/main.ts` (~1700 行)：主进程承担**几乎所有持久化与文件 I/O**，包括项目存储管理、IPC 处理、自定义 `media://` 协议、外链白名单、应用更新检查（清单 URL 在 `package.json` 的 `updateConfig` 字段）、对外部 URL 的安全转换 (`sanitizeExternalUrl`)。新增任何写盘/网络能力时优先在主进程实现，再通过 preload 暴露。
- `electron/preload.ts`：受限的 contextBridge 桥接层，是渲染进程访问主进程能力的唯一入口。
- 渲染进程 = `src/` 下的 React 应用，入口 `src/main.tsx` → `src/App.tsx`。

### 五大板块与目录映射

UI 主面板都在 `src/components/panels/` 下，每个板块同时拥有自己的 Zustand store 和 `src/lib/` 下的业务模块：

| 板块 | UI | Store | 业务逻辑 |
|------|------|-------|---------|
| 剧本 | `panels/script` | `script-store.ts` | `lib/script` |
| 角色 | `panels/characters` | `character-library-store.ts` | `lib/character` |
| 场景 | `panels/scenes` | `scene-store.ts` | `lib/scene` |
| 导演 (分镜) | `panels/director` | `director-store.ts`、`director-shot-store.ts`、`director-presets.ts` | `lib/storyboard` |
| S 级 (Seedance) | `panels/sclass` | `sclass-store.ts` | `lib/generation` |

辅助板块：素材 (`panels/media` + `media-store.ts`)、自由创作 (`panels/freedom`)、总览 (`panels/overview`)、导出 (`panels/export`)、资产 (`panels/assets`)。

### AI 核心包 `@opencut/ai-core`

位于 `src/packages/ai-core/`，通过 vite alias (`@opencut/ai-core` → `src/packages/ai-core/index.ts`) 在源码内引用，**不要直接用相对路径导入**。子模块：

- `protocol/` — AI 任务协议（请求/响应统一抽象）
- `services/prompt-compiler.ts` — 提示词编译（动作 + 镜头语言 + 对白唇形同步三层融合）
- `services/character-bible.ts` — 角色一致性「6 层身份锚点」
- `api/task-poller.ts`、`api/task-queue.ts` — 异步任务轮询与队列
- `providers/` — 服务商抽象。重要：**所有供应商当前都走 OpenAI 兼容协议**，由 `api-config-store` 动态配置，没有针对单个供应商的硬编码类。仅保留 memefast 与 RunningHub 为核心 (见 CHANGELOG v0.1.3)。

### 状态管理 (Zustand)

`src/stores/` 下每个板块一个 store，普遍使用 `persist` 中间件。两条特别要点：

1. **存储迁移在启动时强制运行** — `App.tsx` 启动序列：`useAppSettingsStore.persist.rehydrate()` → `migrateToProjectStorage()` → `recoverFromLegacy()`，迁移完才解除 `isMigrating` loading 态。改动持久化结构时必须考虑写迁移函数到 `src/lib/storage-migration.ts`。
2. **API Key 轮询自动启动** — 启动迁移完成后会自动同步所有已配置 API Key 的供应商模型 (`syncProviderModels`)，把 memefast 排在最前。新增供应商接入需让 `api-config-store` 的 `syncProviderModels` 能识别它。

### 多模态引用与 GroupRefManager

S 级板块的核心架构：每张「分镜卡片」(`split-scene-card`) 自动收集角色参考图、场景参考图、首帧图，经 `GroupRefManager` 统一打包为 `@Image / @Video / @Audio` 引用素材，发送给 Seedance 2.0 API。**硬约束**：≤9 图 + ≤3 视频 + ≤3 音频，prompt ≤5000 字符。多角色/场景参考会通过 N×N 网格拼接成单张图片。改动该流程前请阅读 `CHANGELOG.md` (v0.1.3) 与 `lib/storyboard`、`lib/generation`。

### 开发期 CORS 代理

`vite.config.ts` 与 `electron.vite.config.ts` 都注册了 `/__api_proxy` 中间件用于浏览器端绕过 CORS：前端用 `fetch('/__api_proxy?url=' + encodeURIComponent(target))`，自定义请求头通过 `x-proxy-headers` 传递（JSON 字符串）。生产环境（已打包的 Electron）走 `lib/cors-fetch.ts` 直接由主进程发起请求，渲染进程不再依赖此中间件。

### 路径别名

- `@/*` → `src/*`
- `@opencut/ai-core` → `src/packages/ai-core/index.ts`
- `@opencut/ai-core/services/prompt-compiler`、`@opencut/ai-core/api/task-poller`、`@opencut/ai-core/protocol` 各自有显式别名（见 `electron.vite.config.ts` 与 `vite.config.ts`）— 添加新的 ai-core 子模块时若需对外暴露，记得**两个 config 文件都要同步**。

### MCP Server (`mcp-server/`)

独立的 Node.js 子项目，不参与桌面端/Web 端构建。把「剧本 → 角色 → 场景 → 分镜 → S 级视频」全流程暴露为 MCP tools + prompts，让 Claude Desktop / Cursor / Claude Code 能直接驱动视频生成。设计上**故意不复用 `src/lib`**（那里强依赖 Zustand store + Electron preload），改为：

- 直接 HTTP 调用 OpenAI 兼容协议（`/v1/chat/completions`、`/v1/images/generations`、`/v1/videos/generations`）
- 配置走环境变量（`MOYIN_API_KEY` 等）
- 项目数据按 `<MOYIN_DATA_DIR>/projects/<projectId>/{project,script,scenes,characters,shots}.json` 存文件系统，与桌面端的项目数据**完全隔离**
- 9 个 tool（`create_project` / `parse_script` / `generate_character_image` / `generate_scene_image` / `generate_shots` / `generate_shot_video` / `get_video_task_status` / `get_project` / `list_projects`）+ 3 个 prompt（`create_video_from_script` / `generate_single_shot` / `inspect_project`）

修改约束：
- MCP server 跟主项目共享 AI 调用模型选择思路（OpenAI 兼容 + Seedance 视频协议），但**没有代码依赖**。要改主项目的 prompt 编译/角色一致性逻辑时，不需要联动 MCP server；反之亦然。
- 详细使用方法见 `mcp-server/README.md`。

### 构建产物与缓存

`scripts/build-desktop.mjs` 把 electron-builder 缓存重定向到项目内 `.cache/`（`ELECTRON_CACHE`、`ELECTRON_BUILDER_CACHE`），并使用 staging 目录避免 Windows 文件锁定问题。最终产物在 `release/build/<platform>-<arch>/`。`out/` 已从 git 移除，不要重新跟踪。

## 编码约定（项目特有）

- TypeScript 严格模式开启，但 `noImplicitAny`、`noUnusedLocals`、`noUnusedParameters` 关闭。新代码尽量补类型，但不必为已有的 `any` 全部翻新。
- ESLint `max-warnings 0`：提交前 `npm run lint` 必须通过。
- React 仅用函数式组件 + Hooks。
- UI 用 Tailwind CSS 4 (`@tailwindcss/postcss`) 与 Radix UI primitives；不要再引入额外的 UI 框架。
- 文件头版权声明（`Copyright (c) 2025 hotflow2024 / Licensed under AGPL-3.0-or-later`）在主要源码中普遍存在，新增主要源文件时遵循该格式。
- Commit 规范：Conventional Commits (`feat:`、`fix:`、`docs:`、`refactor:`、`perf:`、`chore:` 等)。
