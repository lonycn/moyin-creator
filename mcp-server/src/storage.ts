// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
//
// 文件系统持久化 — MCP server 用 JSON 文件代替 IndexedDB / localStorage。
// 项目数据按 projectId 分目录存储：
//   <dataDir>/projects/<projectId>/project.json   — 项目元数据
//   <dataDir>/projects/<projectId>/script.json    — 剧本结构化数据
//   <dataDir>/projects/<projectId>/scenes.json    — 场景列表
//   <dataDir>/projects/<projectId>/characters.json — 角色库
//   <dataDir>/projects/<projectId>/shots.json     — 分镜列表
//   <dataDir>/projects/<projectId>/assets/*.png   — 生成的图片
//   <dataDir>/projects/<projectId>/assets/*.mp4   — 生成的视频
import fs from 'node:fs/promises';
import path from 'node:path';

export class ProjectStore {
  constructor(private readonly dataDir: string) {}

  private projectDir(projectId: string): string {
    return path.join(this.dataDir, 'projects', projectId);
  }

  async ensureProjectDir(projectId: string): Promise<string> {
    const dir = this.projectDir(projectId);
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    return dir;
  }

  async readJson<T>(projectId: string, name: string): Promise<T | null> {
    const file = path.join(this.projectDir(projectId), `${name}.json`);
    try {
      const raw = await fs.readFile(file, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeJson(projectId: string, name: string, data: unknown): Promise<void> {
    await this.ensureProjectDir(projectId);
    const file = path.join(this.projectDir(projectId), `${name}.json`);
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
  }

  async writeAsset(projectId: string, filename: string, buffer: Buffer): Promise<string> {
    const dir = path.join(await this.ensureProjectDir(projectId), 'assets');
    const file = path.join(dir, filename);
    await fs.writeFile(file, buffer);
    return file;
  }

  async listProjects(): Promise<string[]> {
    const dir = path.join(this.dataDir, 'projects');
    try {
      return await fs.readdir(dir);
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}
