// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
//
// Pure web (browser) dev server config.
// 用 `npm run dev` 启动 — 不加载 electron 主进程/preload。
// Electron-only 能力（window.fileStorage / window.imageStorage 等）在浏览器下为 undefined,
// 现有代码已通过 isElectron() 检测做降级（localStorage / IndexedDB）。
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return undefined
}

function apiCorsProxyPlugin(): Plugin {
  return {
    name: 'api-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/__api_proxy', async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          })
          res.end()
          return
        }

        const urlParam = new URL(req.url || '', 'http://localhost').searchParams.get('url')
        if (!urlParam) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing ?url= parameter' }))
          return
        }

        try {
          const bodyChunks: Buffer[] = []
          for await (const chunk of req) {
            bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
          }
          const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined

          const proxyHeadersRaw = req.headers['x-proxy-headers']
          let forwardHeaders: Record<string, string> = {}
          if (typeof proxyHeadersRaw === 'string') {
            try { forwardHeaders = JSON.parse(proxyHeadersRaw) } catch { /* ignore */ }
          }

          const response = await fetch(urlParam, {
            method: req.method || 'GET',
            headers: forwardHeaders,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
          })

          const respBody = await response.arrayBuffer()
          const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }
          const ct = response.headers.get('content-type')
          if (ct) headers['Content-Type'] = ct

          res.writeHead(response.status, headers)
          res.end(Buffer.from(respBody))
        } catch (err: unknown) {
          const errorMessage = getErrorMessage(err)
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(JSON.stringify({ error: 'Proxy request failed', detail: errorMessage }))
        }
      })
    },
  }
}

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@opencut/ai-core/services/prompt-compiler': path.resolve(__dirname, './src/packages/ai-core/services/prompt-compiler.ts'),
      '@opencut/ai-core/api/task-poller': path.resolve(__dirname, './src/packages/ai-core/api/task-poller.ts'),
      '@opencut/ai-core/protocol': path.resolve(__dirname, './src/packages/ai-core/protocol/index.ts'),
      '@opencut/ai-core': path.resolve(__dirname, './src/packages/ai-core/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    open: true,
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
  },
  plugins: [
    apiCorsProxyPlugin(),
    react(),
  ],
})
