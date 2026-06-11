import { createServer } from 'node:http'
import { closeSync, createReadStream, openSync, readFileSync, writeSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

const port = Number(process.env.ARCHIVE_API_PORT ?? 8791)
const host = process.env.ARCHIVE_API_HOST ?? '0.0.0.0'
const dataFile = resolve(process.env.ARCHIVE_DATA_FILE ?? '.archive-data/archive-db.json')
const logDir = resolve('.archive-data/logs')
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
let dbUpdateQueue = Promise.resolve()
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

function clipSlug(inputUrl) {
  const url = new URL(inputUrl)
  const raw = `${url.hostname}${url.pathname}`
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'web-clip'
}

async function readJsonBody(request) {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(chunk)
  }

  if (!chunks.length) return {}

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readDb() {
  try {
    const raw = await readFile(dataFile, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { drafts: [], items: [], assets: [] }
  }
}

async function writeDb(db) {
  await mkdir(dirname(dataFile), { recursive: true })
  const tempFile = `${dataFile}.${process.pid}.tmp`
  await writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
  await rename(tempFile, dataFile)
}

function send(response, status, payload) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sendText(response, status, message) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'text/plain; charset=utf-8',
  })
  response.end(message)
}

function getMimeType(filePath) {
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

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeSourceUrl(value) {
  const text = normalizeString(value)
  if (!text) return ''

  try {
    const url = new URL(text)
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    ;['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach((param) => {
      url.searchParams.delete(param)
    })
    url.searchParams.sort()
    return url.toString().replace(/\/$/, '')
  } catch {
    return text.replace(/#.*$/, '').replace(/\/+$/, '')
  }
}

function extractSourceUrlFromText(value) {
  const match = normalizeString(value).match(/https?:\/\/[^\s"'<>]+/i)
  return match ? normalizeSourceUrl(match[0]) : ''
}

function collectAssetSourceUrls(value) {
  if (!Array.isArray(value)) return []

  return value
    .flatMap((asset) => {
      if (!asset || typeof asset !== 'object') return []
      return [asset.sourceUrl, asset.svnPath, asset.imageUrl, asset.thumbnailUrl]
    })
    .map(normalizeSourceUrl)
    .filter(Boolean)
}

function getEntrySourceUrl(entry, relatedAssets = []) {
  return (
    normalizeSourceUrl(entry?.sourceUrl) ||
    extractSourceUrlFromText(entry?.note) ||
    extractSourceUrlFromText(entry?.extraNote) ||
    collectAssetSourceUrls(relatedAssets)[0] ||
    ''
  )
}

function findDuplicateItem(db, entry, payload) {
  const sourceUrl = getEntrySourceUrl(entry, payload.assets)
  if (!sourceUrl) return null

  const items = Array.isArray(db.items) ? db.items : []
  const dbAssets = Array.isArray(db.assets) ? db.assets : []
  const duplicate = items.find((item) => {
    if (!item || item.id === entry.id || item.status === 'deleted') return false
    const relatedAssets = dbAssets.filter((asset) => asset.linkedItemId === item.id)
    return getEntrySourceUrl(item, relatedAssets) === sourceUrl
  })

  if (!duplicate) return null

  return {
    id: duplicate.id,
    title: duplicate.title,
    sourceUrl,
    reason: '来源链接相同',
    createdAt: duplicate.createdAt ?? duplicate.savedAt ?? duplicate.updatedAt ?? '',
    createdBy: duplicate.createdBy ?? '未知',
  }
}

async function updateDb(mutator) {
  const runUpdate = dbUpdateQueue.then(async () => {
    const db = await readDb()
    const result = await mutator(db)
    await writeDb(db)
    return result
  })

  dbUpdateQueue = runUpdate.catch(() => {})
  return runUpdate
}

function isAssetRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.caption === 'string' &&
    typeof value.linkedItemId === 'string'
  )
}

function mergeAssets(existingAssets, nextAssets) {
  const merged = new Map()

  ;(Array.isArray(existingAssets) ? existingAssets : []).filter(isAssetRecord).forEach((asset) => {
    merged.set(asset.id, asset)
  })
  ;(Array.isArray(nextAssets) ? nextAssets : []).filter(isAssetRecord).forEach((asset) => {
    merged.set(asset.id, asset)
  })

  return Array.from(merged.values())
}

function ensureSvnRoot() {
  if (!svnRoot) {
    const error = new Error('SVN_WORKING_COPY_ROOT 未配置')
    error.status = 503
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
    error.status = 400
    throw error
  }

  return target
}

function toSvnPath(filePath) {
  return `/${relative(ensureSvnRoot(), filePath).replace(/\\/g, '/')}`
}

function sizeLabel(size) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

async function collectSvnFiles(folderPath, query, files) {
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

async function handleSvnFiles(url, response) {
  const root = ensureSvnRoot()
  const requestPath = url.searchParams.get('path') ?? '/'
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const folderPath = resolveSvnPath(requestPath)
  const folderStat = await stat(folderPath)

  if (!folderStat.isDirectory()) {
    const error = new Error('SVN 目录不存在')
    error.status = 404
    throw error
  }

  const rootEntries = await readdir(root, { withFileTypes: true })
  const folders = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
    .map((entry) => `/${entry.name}`)
  const files = []
  await collectSvnFiles(folderPath, query, files)
  send(response, 200, { files, folders, total: files.length, root })
}

function handleSvnFile(url, response) {
  const filePath = resolveSvnPath(url.searchParams.get('path') ?? '')
  const stream = createReadStream(filePath)

  stream.on('error', () => {
    if (!response.headersSent) sendText(response, 404, 'SVN 文件不存在')
  })
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': getMimeType(filePath),
    'Cache-Control': 'public, max-age=300',
  })
  stream.pipe(response)
}

function normalizePayload(payload, kind) {
  const now = new Date().toISOString()
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  const sourceUrl = normalizeSourceUrl(payload.sourceUrl) || extractSourceUrlFromText(payload.note) || collectAssetSourceUrls(payload.assets)[0] || ''

  if (kind === 'items' && !title) {
    const error = new Error('标题不能为空')
    error.status = 400
    throw error
  }

  return {
    id: payload.sourceItemId || makeId(kind === 'items' ? 'item' : 'draft'),
    mode: payload.mode ?? 'new',
    sourceItemId: payload.sourceItemId ?? null,
    type: payload.type ?? '',
    title,
    summary: payload.summary ?? '',
    note: payload.note ?? '',
    extraNote: payload.extraNote ?? '',
    categories: payload.categories ?? {},
    assetIds: Array.isArray(payload.assetIds) ? payload.assetIds : [],
    sourceUrl,
    createdBy: normalizeString(payload.createdBy) || 'Web Clipper',
    status: kind === 'items' ? 'active' : 'draft',
    savedAt: now,
    updatedAt: now,
  }
}

async function handleArchivePost(kind, request, response) {
  const payload = await readJsonBody(request)
  const entry = normalizePayload(payload, kind)

  if (kind === 'items' && !payload.forceCreateDuplicate) {
    const db = await readDb()
    const duplicate = findDuplicateItem(db, entry, payload)
    if (duplicate) {
      send(response, 409, { error: '疑似已存在相同资料', duplicate })
      return
    }
  }

  await updateDb(async (db) => {
    const list = Array.isArray(db[kind]) ? db[kind] : []
    const existingIndex = list.findIndex((item) => item.id === entry.id)

    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...entry, createdAt: list[existingIndex].createdAt ?? entry.savedAt }
    } else {
      list.unshift({ ...entry, createdAt: entry.savedAt })
    }

    db[kind] = list

    if (kind === 'items') {
      db.drafts = (Array.isArray(db.drafts) ? db.drafts : []).filter(
        (draft) => draft.sourceItemId !== entry.sourceItemId && draft.title !== entry.title,
      )
      db.assets = mergeAssets(db.assets, payload.assets)
    }
  })

  send(response, 200, { id: entry.id, savedAt: entry.savedAt })
}

async function applyArchiveItemStatus(itemId, nextStatus, updatedBy, response) {
  const allowedStatuses = new Set(['draft', 'active', 'hidden', 'deleted'])

  if (!allowedStatuses.has(nextStatus)) {
    send(response, 400, { error: '资料状态无效' })
    return
  }

  const result = await updateDb(async (db) => {
    const list = Array.isArray(db.items) ? db.items : []
    const existingIndex = list.findIndex((item) => item.id === itemId)

    if (existingIndex < 0) {
      const error = new Error('资料不存在')
      error.status = 404
      throw error
    }

    const now = new Date().toISOString()
    const nextItem = {
      ...list[existingIndex],
      status: nextStatus,
      updatedAt: now,
      statusUpdatedAt: now,
      statusUpdatedBy: updatedBy,
    }

    if (nextStatus === 'deleted') {
      nextItem.deletedAt = now
      nextItem.deletedBy = updatedBy
    }

    list[existingIndex] = nextItem
    db.items = list

    return { id: nextItem.id, status: nextStatus, updatedAt: now }
  })

  send(response, 200, result)
}

async function handleArchiveItemMutation(itemId, action, request, response) {
  const payload = action === 'patch' ? await readJsonBody(request) : {}
  const nextStatus = action === 'delete' ? 'deleted' : normalizeString(payload.status)
  const updatedBy = normalizeString(payload.updatedBy) || '管理员'
  await applyArchiveItemStatus(itemId, nextStatus, updatedBy, response)
}

async function handleArchiveItemStatusPost(request, response) {
  const payload = await readJsonBody(request)
  const itemId = normalizeString(payload.itemId)

  if (!itemId) {
    send(response, 400, { error: '资料 ID 不能为空' })
    return
  }

  await applyArchiveItemStatus(
    itemId,
    normalizeString(payload.status),
    normalizeString(payload.updatedBy) || '管理员',
    response,
  )
}

async function handleArchiveFeedbackPost(request, response) {
  const payload = await readJsonBody(request)
  const itemId = normalizeString(payload.itemId)
  const itemTitle = normalizeString(payload.itemTitle)
  const feedbackType = normalizeString(payload.feedbackType) || '资料问题'
  const message = normalizeString(payload.message)

  if (!itemId) {
    send(response, 400, { error: '资料 ID 不能为空' })
    return
  }

  if (!message) {
    send(response, 400, { error: '请填写反馈说明' })
    return
  }

  const now = new Date().toISOString()
  const feedback = {
    id: makeId('feedback'),
    itemId,
    itemTitle,
    feedbackType,
    message,
    pageUrl: normalizeString(payload.pageUrl),
    sourceUrl: normalizeString(payload.sourceUrl),
    createdBy: normalizeString(payload.createdBy) || '当前用户',
    createdAt: now,
    status: 'open',
  }

  await updateDb(async (db) => {
    const feedbacks = Array.isArray(db.feedbacks) ? db.feedbacks : []
    feedbacks.unshift(feedback)
    db.feedbacks = feedbacks
  })

  send(response, 200, feedback)
}

function runClipScript(targetUrl) {
  return new Promise((resolveRun, rejectRun) => {
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

async function startClipLoginBrowser(targetUrl) {
  await mkdir(logDir, { recursive: true })
  const logFd = openSync(join(logDir, 'clip-login-browser.log'), 'a')
  writeSync(logFd, `\n[${new Date().toISOString()}] start ${targetUrl}\n`)

  return await new Promise((resolveStart, rejectStart) => {
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
    let settleTimer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(settleTimer)
      callback(value)
    }

    child.on('error', (error) => {
      if (settled) return
      writeSync(logFd, `[${new Date().toISOString()}] error ${error.message}\n`)
      closeSync(logFd)
      finish(rejectStart, error)
    })

    child.on('exit', (code) => {
      if (settled) return
      if (code && code !== 0) {
        writeSync(logFd, `[${new Date().toISOString()}] exited ${code}\n`)
        closeSync(logFd)
        finish(rejectStart, new Error(`登录浏览器启动脚本退出：${code}`))
      }
    })

    settleTimer = setTimeout(() => {
      child.unref()
      writeSync(logFd, `[${new Date().toISOString()}] spawned pid ${child.pid}\n`)
      closeSync(logFd)
      finish(resolveStart, child.pid)
    }, 1200)
  })
}

async function readClipAfterRunFailure(clipFile) {
  const clip = await readReusableClipFile(clipFile)
  if (clip) return clip

  try {
    return JSON.parse(await readFile(clipFile, 'utf8'))
  } catch {
    return null
  }
}

async function readReusableClipFile(clipFile) {
  try {
    const clip = JSON.parse(await readFile(clipFile, 'utf8'))
    if (clip?.status !== 'failed' && Array.isArray(clip.extractedImages) && clip.extractedImages.length) {
      return clip
    }
  } catch {
    // Missing or invalid cache should not block a fresh crawl attempt.
  }
  return null
}

async function handleWebClipLoginPost(request, response) {
  const payload = await readJsonBody(request)
  const targetUrl = typeof payload.url === 'string' && payload.url.trim()
    ? payload.url.trim()
    : 'https://www.xiaohongshu.com/explore'

  try {
    new URL(targetUrl)
  } catch {
    send(response, 400, { error: '请输入有效网页链接' })
    return
  }

  const pid = await startClipLoginBrowser(targetUrl)
  send(response, 202, {
    status: 'started',
    pid,
    message: '采集登录浏览器已打开，请在新窗口中完成登录，登录后关闭窗口即可保存状态。',
  })
}

async function handleWebClipPost(request, response) {
  const payload = await readJsonBody(request)
  const targetUrl = typeof payload.url === 'string' ? payload.url.trim() : ''

  if (!targetUrl) {
    send(response, 400, { error: '请输入网页链接' })
    return
  }

  let slug = ''
  try {
    slug = clipSlug(targetUrl)
  } catch {
    send(response, 400, { error: '请输入有效网页链接' })
    return
  }

  const clipFile = resolve('public', 'web-clips', slug, 'clip.json')
  const cachedClip = await readReusableClipFile(clipFile)
  if (cachedClip) {
    send(response, 200, cachedClip)
    return
  }

  let runResult
  try {
    runResult = await runClipScript(targetUrl)
  } catch (error) {
    const fallbackClip = await readClipAfterRunFailure(clipFile)
    if (fallbackClip) {
      send(response, 200, fallbackClip)
      return
    }
    throw error
  }

  try {
    const clip = JSON.parse(await readFile(clipFile, 'utf8'))
    send(response, 200, clip)
  } catch (error) {
    const detail = runResult.stderr.trim() || runResult.stdout.trim()
    const message = detail || (error instanceof Error ? error.message : '采集脚本没有生成结果')
    send(response, runResult.code === 0 ? 500 : 502, { error: message })
  }
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

    if (request.method === 'OPTIONS') {
      send(response, 204, {})
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/archive/health') {
      send(response, 200, { ok: true, host, port, dataFile, svnRoot: svnRoot || null })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/svn/files') {
      await handleSvnFiles(url, response)
      return
    }

    if (request.method === 'GET' && (url.pathname === '/api/svn/file' || url.pathname === '/api/svn/thumb')) {
      handleSvnFile(url, response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/archive/items') {
      const db = await readDb()
      send(response, 200, { items: db.items ?? [], assets: db.assets ?? [] })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/archive/drafts') {
      const db = await readDb()
      send(response, 200, { drafts: db.drafts ?? [] })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/items/status') {
      await handleArchiveItemStatusPost(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/feedback') {
      await handleArchiveFeedbackPost(request, response)
      return
    }

    const archiveItemMatch = url.pathname.match(/^\/api\/archive\/items\/([^/]+)$/)
    if (archiveItemMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
      await handleArchiveItemMutation(
        decodeURIComponent(archiveItemMatch[1]),
        request.method === 'DELETE' ? 'delete' : 'patch',
        request,
        response,
      )
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/items') {
      await handleArchivePost('items', request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/drafts') {
      await handleArchivePost('drafts', request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/web-clips') {
      await handleWebClipPost(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/web-clips/login') {
      await handleWebClipLoginPost(request, response)
      return
    }

    send(response, 404, { error: '接口不存在' })
  } catch (error) {
    send(response, error.status ?? 500, { error: error instanceof Error ? error.message : '服务异常' })
  }
}

createServer(handleRequest).listen(port, host, () => {
  console.log(`Archive API listening at http://${host}:${port}`)
  console.log(`Archive data file: ${dataFile}`)
})
