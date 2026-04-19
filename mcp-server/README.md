# Moyin Creator MCP Server

把魔因漫创的「剧本 → 角色 → 场景 → 分镜 → S 级视频」全流程暴露为 MCP tools，让 LLM（Claude Desktop / Cursor / Claude Code）可以直接驱动视频生成。

## 安装

```bash
cd mcp-server
npm install
npm run build
```

## 配置

在 MCP 客户端配置中注入环境变量：

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `MOYIN_API_KEY` | ✅ | — | OpenAI 兼容 API Key（多个用逗号分隔自动轮询） |
| `MOYIN_API_BASE_URL` | | `https://api.memefast.cn/v1` | OpenAI 兼容协议 base URL |
| `MOYIN_IMAGE_MODEL` | | `gemini-3-pro-image-preview` | 文生图默认模型 |
| `MOYIN_VIDEO_MODEL` | | `doubao-seedance-1-5-pro-251215` | 视频生成默认模型（支持 Seedance） |
| `MOYIN_CHAT_MODEL` | | `gpt-4o-mini` | 剧本结构化用的对话模型 |
| `MOYIN_DATA_DIR` | | `~/.moyin-mcp` | 项目数据/资产存储目录 |

### Claude Desktop 配置示例

`~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "moyin-creator": {
      "command": "node",
      "args": ["/绝对路径/moyin-creator/mcp-server/dist/index.js"],
      "env": {
        "MOYIN_API_KEY": "sk-xxx,sk-yyy",
        "MOYIN_VIDEO_MODEL": "doubao-seedance-1-5-pro-251215"
      }
    }
  }
}
```

### Claude Code 配置示例

```bash
claude mcp add moyin-creator \
  --env MOYIN_API_KEY=sk-xxx \
  -- node /绝对路径/moyin-creator/mcp-server/dist/index.js
```

## Tools 一览

| Tool | 用途 |
|------|------|
| `create_project` | 新建项目，返回 `projectId` |
| `list_projects` | 列出全部项目 |
| `parse_script` | 把剧本文本解析为结构化场景/角色 |
| `generate_character_image` | 为角色生成参考图（保证一致性） |
| `generate_scene_image` | 为场景生成环境图 |
| `generate_shots` | 为某场景生成分镜列表 |
| `generate_shot_video` | 为分镜生成 S 级视频（自动收集场景图+角色图） |
| `get_video_task_status` | 查询视频生成进度（异步任务） |
| `get_project` | 读取项目完整状态 |

## Prompts（工作流模板）

Server 同时暴露 MCP **prompts**，连上后客户端会列出可选的预制工作流，参数填入即可一键执行：

| Prompt | 用途 |
|--------|------|
| `create_video_from_script` | 端到端：剧本文本 → 完整视频（角色图/场景图/分镜/视频全自动） |
| `generate_single_shot` | 重新生成单个分镜（用于迭代不满意的镜头） |
| `inspect_project` | 查看项目当前完整状态 |

在 Claude Desktop / Cursor 中，这些 prompt 通常显示为 `/moyin-creator:create_video_from_script` 之类的 slash 命令。

## 端到端示例

不用 prompt 时，直接对话：

```
你: 用魔因 MCP 帮我创建一个项目「咖啡馆相遇」，剧本如下：……
LLM 调用顺序:
  create_project          → projectId
  parse_script            → scenes/characters
  generate_character_image (×N)
  generate_scene_image    (×N)
  generate_shots          (×N)
  generate_shot_video     (×N)  ← 长任务，自动轮询或异步
```

用 prompt 时：调用 `create_video_from_script` 把 `title` + `script` 填进去，LLM 会按预设流程逐步执行。

## 开发

```bash
npm run dev      # tsc --watch
npm run inspect  # 用官方 inspector 调试 tool
```

## 注意

- **协议假设**：MCP server 假设供应商兼容 OpenAI `/v1/chat/completions`、`/v1/images/generations`、`/v1/videos/generations` 路由。RunningHub 的视角矩阵 API 暂未集成。
- **不复用 Electron 主进程**：MCP server 是独立 Node.js 进程，存储走文件系统（`~/.moyin-mcp/projects/<projectId>/`），不读写魔因桌面端的项目数据。
- **轮询超时**：视频生成默认最长等 10 分钟（`maxWaitSec` 参数可调），超时返回 `taskId`，调用者用 `get_video_task_status` 续查。
