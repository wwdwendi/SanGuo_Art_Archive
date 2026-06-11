import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { closeSync, createReadStream, openSync, readFileSync, writeSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

function clipSlug(inputUrl: string) {
  const url = new URL(inputUrl)
  const raw = `${url.hostname}${url.pathname}`
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'web-clip'
}

function readRequestBody(request: import('node:http').IncomingMessage) {
  return new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectBody)
  })
}

function runClipScript(targetUrl: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['scripts/clip-page.mjs', targetUrl], {
      cwd: resolve('.'),
      env: process.env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      rejectRun(new Error('网页采集超时'))
    }, 90000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolveRun({ code, stdout, stderr })
    })
  })
}

const archiveLogDir = resolve('.archive-data/logs')

async function startClipLoginBrowser(targetUrl: string) {
  await mkdir(archiveLogDir, { recursive: true })
  const logFd = openSync(join(archiveLogDir, 'clip-login-browser.log'), 'a')
  writeSync(logFd, `\n[${new Date().toISOString()}] start ${targetUrl}\n`)

  return await new Promise<number | undefined>((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, ['scripts/clip-login-browser.mjs'], {
      cwd: resolve('.'),
      detached: true,
      env: {
        ...process.env,
        CLIP_LOGIN_URL: targetUrl || 'https://www.xiaohongshu.com/explore',
      },
      stdio: ['ignore', logFd, logFd],
      windowsHide: false,
    })

    let settled = false
    let settleTimer: ReturnType<typeof setTimeout>
    const finish = (value: number | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(settleTimer)
      resolveStart(value)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(settleTimer)
      writeSync(logFd, `[${new Date().toISOString()}] error ${error.message}\n`)
      closeSync(logFd)
      rejectStart(error)
    }

    child.on('error', fail)
    child.on('exit', (code) => {
      if (code && code !== 0) {
        fail(new Error(`登录浏览器启动脚本退出：${code}`))
      }
    })

    settleTimer = setTimeout(() => {
      child.unref()
      writeSync(logFd, `[${new Date().toISOString()}] spawned pid ${child.pid}\n`)
      closeSync(logFd)
      finish(child.pid)
    }, 1200)
  })
}

async function handleWebClipLoginPost(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as { url?: unknown } : {}
  const targetUrl = typeof payload.url === 'string' && payload.url.trim()
    ? payload.url.trim()
    : 'https://www.xiaohongshu.com/explore'

  try {
    new URL(targetUrl)
  } catch {
    sendJson(response, 400, { error: '请输入有效网页链接' })
    return
  }

  const pid = await startClipLoginBrowser(targetUrl)
  sendJson(response, 202, {
    status: 'started',
    pid,
    message: '采集登录浏览器已打开，请在新窗口中完成登录，登录后关闭窗口即可保存状态。',
  })
}

async function readReusableClipFile(clipFile: string) {
  try {
    const clip = JSON.parse(await readFile(clipFile, 'utf8')) as {
      status?: string
      extractedImages?: unknown[]
    }
    if (clip?.status !== 'failed' && Array.isArray(clip.extractedImages) && clip.extractedImages.length) {
      return clip
    }
  } catch {
    // Missing or invalid cache should not block a fresh crawl attempt.
  }
  return null
}

async function readClipAfterRunFailure(clipFile: string) {
  const reusableClip = await readReusableClipFile(clipFile)
  if (reusableClip) return reusableClip

  try {
    return JSON.parse(await readFile(clipFile, 'utf8')) as unknown
  } catch {
    return null
  }
}

function sendJson(response: import('node:http').ServerResponse, status: number, payload: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function sendText(response: import('node:http').ServerResponse, status: number, message: string) {
  response.statusCode = status
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.end(message)
}

const archiveDataFile = resolve(process.env.ARCHIVE_DATA_FILE ?? '.archive-data/archive-db.json')
const svnRootConfigFile = resolve('.archive-data/svn-root.txt')
function readConfiguredSvnRoot() {
  const envRoot = process.env.SVN_WORKING_COPY_ROOT?.trim()
  if (envRoot) return resolve(envRoot)

  try {
    const fileRoot = readFileSync(svnRootConfigFile, 'utf8').trim()
    return fileRoot ? resolve(fileRoot) : ''
  } catch {
    return ''
  }
}
const svnRoot = readConfiguredSvnRoot()
const svnMaxFiles = Number(process.env.SVN_MAX_FILES ?? 400)
let archiveDbUpdateQueue = Promise.resolve()
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

type ArchiveDb = {
  drafts?: unknown[]
  items?: unknown[]
  assets?: unknown[]
}

async function readArchiveDb() {
  try {
    return JSON.parse(await readFile(archiveDataFile, 'utf8')) as ArchiveDb
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { drafts: [], items: [], assets: [] }
  }
}

async function writeArchiveDb(db: ArchiveDb) {
  await mkdir(dirname(archiveDataFile), { recursive: true })
  const tempFile = `${archiveDataFile}.${process.pid}.tmp`
  await writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
  await rename(tempFile, archiveDataFile)
}

async function updateArchiveDb<T>(mutator: (db: ArchiveDb) => Promise<T> | T) {
  const runUpdate = archiveDbUpdateQueue.then(async () => {
    const db = await readArchiveDb()
    const result = await mutator(db)
    await writeArchiveDb(db)
    return result
  })

  archiveDbUpdateQueue = runUpdate.then(() => undefined, () => undefined)
  return runUpdate
}

function isAssetRecord(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const record = value as { id?: unknown; caption?: unknown; linkedItemId?: unknown }
  return typeof record.id === 'string' && typeof record.caption === 'string' && typeof record.linkedItemId === 'string'
}

function mergeAssets(existingAssets: unknown, nextAssets: unknown) {
  const merged = new Map<string, unknown>()

  if (Array.isArray(existingAssets)) {
    existingAssets.filter(isAssetRecord).forEach((asset) => {
      merged.set((asset as { id: string }).id, asset)
    })
  }

  if (Array.isArray(nextAssets)) {
    nextAssets.filter(isAssetRecord).forEach((asset) => {
      merged.set((asset as { id: string }).id, asset)
    })
  }

  return Array.from(merged.values())
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function getMimeType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.jpg':
    case '.jpeg':
    default:
      return 'image/jpeg'
  }
}

function ensureSvnRoot() {
  if (!svnRoot) {
    const error = new Error('SVN_WORKING_COPY_ROOT 未配置')
    Object.assign(error, { status: 503 })
    throw error
  }

  return svnRoot
}

function resolveSvnPath(inputPath = '') {
  const root = ensureSvnRoot()
  const normalized = inputPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const target = resolve(root, normalized)

  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    const error = new Error('SVN 路径越界')
    Object.assign(error, { status: 400 })
    throw error
  }

  return target
}

function toSvnPath(filePath: string) {
  return `/${relative(ensureSvnRoot(), filePath).replace(/\\/g, '/')}`
}

function sizeLabel(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

async function collectSvnFiles(folderPath: string, query: string, files: unknown[]) {
  if (files.length >= svnMaxFiles) return

  const entries = await readdir(folderPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.svn') continue

    const fullPath = join(folderPath, entry.name)
    if (entry.isDirectory()) {
      await collectSvnFiles(fullPath, query, files)
    } else if (entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase())) {
      const svnPath = toSvnPath(fullPath)
      const searchable = `${entry.name} ${svnPath}`.toLowerCase()
      if (!query || searchable.includes(query)) {
        const fileStat = await stat(fullPath)
        const imageUrl = `/api/svn/file?path=${encodeURIComponent(svnPath)}`
        files.push({
          id: `svn-${Buffer.from(svnPath).toString('base64url')}`,
          name: entry.name,
          path: svnPath,
          thumbnailUrl: imageUrl,
          previewUrl: imageUrl,
          sizeLabel: sizeLabel(fileStat.size),
          sourceType: 'SVN 图片库',
          referencePurpose: '研究线索',
          tags: ['SVN'],
        })
      }
    }

    if (files.length >= svnMaxFiles) return
  }
}

async function handleSvnFiles(url: URL, response: import('node:http').ServerResponse) {
  const root = ensureSvnRoot()
  const requestPath = url.searchParams.get('path') ?? '/'
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const folderPath = resolveSvnPath(requestPath)
  const folderStat = await stat(folderPath)

  if (!folderStat.isDirectory()) {
    const error = new Error('SVN 目录不存在')
    Object.assign(error, { status: 404 })
    throw error
  }

  const rootEntries = await readdir(root, { withFileTypes: true })
  const folders = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
    .map((entry) => `/${entry.name}`)
  const files: unknown[] = []
  await collectSvnFiles(folderPath, query, files)
  sendJson(response, 200, { files, folders, total: files.length, root })
}

function handleSvnFile(url: URL, response: import('node:http').ServerResponse) {
  const filePath = resolveSvnPath(url.searchParams.get('path') ?? '')
  const stream = createReadStream(filePath)

  stream.on('error', () => {
    if (!response.headersSent) sendText(response, 404, 'SVN 文件不存在')
  })
  response.statusCode = 200
  response.setHeader('Content-Type', getMimeType(filePath))
  response.setHeader('Cache-Control', 'public, max-age=300')
  stream.pipe(response)
}

function normalizeArchivePayload(payload: Record<string, unknown>, kind: 'drafts' | 'items') {
  const now = new Date().toISOString()
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''

  if (kind === 'items' && !title) {
    const error = new Error('标题不能为空')
    Object.assign(error, { status: 400 })
    throw error
  }

  return {
    id:
      typeof payload.sourceItemId === 'string' && payload.sourceItemId
        ? payload.sourceItemId
        : `${kind === 'items' ? 'item' : 'draft'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    mode: payload.mode ?? 'new',
    sourceItemId: payload.sourceItemId ?? null,
    type: payload.type ?? '',
    title,
    summary: payload.summary ?? '',
    note: payload.note ?? '',
    categories: payload.categories ?? {},
    assetIds: Array.isArray(payload.assetIds) ? payload.assetIds : [],
    status: kind === 'items' ? 'active' : 'draft',
    savedAt: now,
    updatedAt: now,
  }
}

async function handleArchivePost(
  kind: 'drafts' | 'items',
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
  const entry = normalizeArchivePayload(payload, kind)

  await updateArchiveDb((db) => {
    const list = Array.isArray(db[kind]) ? db[kind] : []
    const existingIndex = list.findIndex((item) => {
      if (!item || typeof item !== 'object') return false
      return (item as { id?: unknown }).id === entry.id
    })

    if (existingIndex >= 0) {
      list[existingIndex] = { ...(list[existingIndex] as object), ...entry }
    } else {
      list.unshift(entry)
    }

    db[kind] = list

    if (kind === 'items') {
      db.drafts = (Array.isArray(db.drafts) ? db.drafts : []).filter((draft) => {
        if (!draft || typeof draft !== 'object') return true
        const existing = draft as { sourceItemId?: unknown; title?: unknown }
        return existing.sourceItemId !== entry.sourceItemId && existing.title !== entry.title
      })
      db.assets = mergeAssets(db.assets, payload.assets)
    }
  })

  sendJson(response, 200, { id: entry.id, savedAt: entry.savedAt })
}

async function handleArchiveItemStatusPost(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
  const itemId = normalizeString(payload.itemId)
  const nextStatus = normalizeString(payload.status)
  const allowedStatuses = new Set(['draft', 'active', 'hidden', 'deleted'])

  if (!itemId) {
    sendJson(response, 400, { error: '资料 ID 不能为空' })
    return
  }

  if (!allowedStatuses.has(nextStatus)) {
    sendJson(response, 400, { error: '资料状态无效' })
    return
  }

  const result = await updateArchiveDb((db) => {
    const list = Array.isArray(db.items) ? db.items : []
    const existingIndex = list.findIndex((item) => {
      if (!item || typeof item !== 'object') return false
      return (item as { id?: unknown }).id === itemId
    })

    if (existingIndex < 0) {
      const error = new Error('资料不存在')
      Object.assign(error, { status: 404 })
      throw error
    }

    const now = new Date().toISOString()
    const updatedBy = normalizeString(payload.updatedBy) || '管理员'
    const nextItem = {
      ...(list[existingIndex] as object),
      status: nextStatus,
      updatedAt: now,
      statusUpdatedAt: now,
      statusUpdatedBy: updatedBy,
    } as Record<string, unknown>

    if (nextStatus === 'deleted') {
      nextItem.deletedAt = now
      nextItem.deletedBy = updatedBy
    }

    list[existingIndex] = nextItem
    db.items = list

    return { id: itemId, status: nextStatus, updatedAt: now }
  })

  sendJson(response, 200, result)
}

function archiveDevServerPlugin() {
  return {
    name: 'archive-dev-server',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/archive/drafts', async (request, response) => {
        try {
          if (request.method === 'GET') {
            const db = await readArchiveDb()
            sendJson(response, 200, { drafts: db.drafts ?? [] })
            return
          }

          if (request.method === 'POST') {
            await handleArchivePost('drafts', request, response)
            return
          }

          sendJson(response, 405, { error: '接口只支持 GET 或 POST' })
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '草稿服务异常',
          })
        }
      })

      server.middlewares.use('/api/archive/items/status', async (request, response) => {
        try {
          if (request.method === 'POST') {
            await handleArchiveItemStatusPost(request, response)
            return
          }

          sendJson(response, 405, { error: '接口只支持 POST' })
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '资料库服务异常',
          })
        }
      })

      server.middlewares.use('/api/archive/items', async (request, response) => {
        try {
          if (request.method === 'GET') {
            const db = await readArchiveDb()
            sendJson(response, 200, { items: db.items ?? [], assets: db.assets ?? [] })
            return
          }

          if (request.method === 'POST') {
            await handleArchivePost('items', request, response)
            return
          }

          sendJson(response, 405, { error: '接口只支持 GET 或 POST' })
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '资料库服务异常',
          })
        }
      })

      server.middlewares.use('/api/archive/web-clips/login', async (
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
      ) => {
        try {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: '接口只支持 POST' })
            return
          }

          await handleWebClipLoginPost(request, response)
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '登录浏览器启动失败',
          })
        }
      })

      server.middlewares.use('/api/archive/web-clips', async (
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
      ) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: '接口只支持 POST' })
          return
        }

        try {
          const body = await readRequestBody(request)
          const payload = body ? JSON.parse(body) as { url?: unknown } : {}
          const targetUrl = typeof payload.url === 'string' ? payload.url.trim() : ''

          if (!targetUrl) {
            sendJson(response, 400, { error: '请输入网页链接' })
            return
          }

          const slug = clipSlug(targetUrl)
          const clipFile = resolve('public', 'web-clips', slug, 'clip.json')
          const cachedClip = await readReusableClipFile(clipFile)
          if (cachedClip) {
            sendJson(response, 200, cachedClip)
            return
          }

          let runResult
          try {
            runResult = await runClipScript(targetUrl)
          } catch (error) {
            const fallbackClip = await readClipAfterRunFailure(clipFile)
            if (fallbackClip) {
              sendJson(response, 200, fallbackClip)
              return
            }
            throw error
          }

          try {
            sendJson(response, 200, JSON.parse(await readFile(clipFile, 'utf8')))
          } catch (error) {
            const detail = runResult.stderr.trim() || runResult.stdout.trim()
            sendJson(response, runResult.code === 0 ? 500 : 502, {
              error: detail || (error instanceof Error ? error.message : '采集脚本没有生成结果'),
            })
          }
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : '采集服务异常' })
        }
      })

      server.middlewares.use('/api/svn/files', async (request, response) => {
        try {
          if (request.method !== 'GET') {
            sendJson(response, 405, { error: '接口只支持 GET' })
            return
          }

          const url = new URL(request.url ?? '/', 'http://localhost')
          await handleSvnFiles(url, response)
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : 'SVN 服务异常',
          })
        }
      })

      server.middlewares.use('/api/svn/file', (request, response) => {
        try {
          if (request.method !== 'GET') {
            sendText(response, 405, '接口只支持 GET')
            return
          }

          const url = new URL(request.url ?? '/', 'http://localhost')
          handleSvnFile(url, response)
        } catch (error) {
          sendText(response, (error as { status?: number }).status ?? 500, error instanceof Error ? error.message : 'SVN 服务异常')
        }
      })

      server.middlewares.use('/api/svn/thumb', (request, response) => {
        try {
          if (request.method !== 'GET') {
            sendText(response, 405, '接口只支持 GET')
            return
          }

          const url = new URL(request.url ?? '/', 'http://localhost')
          handleSvnFile(url, response)
        } catch (error) {
          sendText(response, (error as { status?: number }).status ?? 500, error instanceof Error ? error.message : 'SVN 服务异常')
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [archiveDevServerPlugin(), react()],
  server: {
    proxy: {
      '/api/archive': 'http://127.0.0.1:8791',
    },
  },
})
