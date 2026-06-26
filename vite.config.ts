import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

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

function normalizeOcrDataUrl(value: unknown) {
  const text = normalizeString(value)
  const match = text.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) return null
  const extension = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
  return { buffer: Buffer.from(match[2], 'base64'), extension }
}

function runPaddleOcr(imagePath: string) {
  return new Promise<Record<string, unknown>>((resolveRun, rejectRun) => {
    const pythonCommand = process.env.PADDLE_OCR_PYTHON || 'python'
    const child = spawn(pythonCommand, ['scripts/paddle-ocr.py', imagePath], {
      cwd: resolve('.'),
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      rejectRun(new Error('PaddleOCR 识别超时'))
    }, Number(process.env.PADDLE_OCR_TIMEOUT_MS ?? 180000))

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
      if (code !== 0) {
        rejectRun(new Error((stderr || stdout || `PaddleOCR 退出：${code}`).trim()))
        return
      }
      try {
        resolveRun(JSON.parse(stdout.trim()) as Record<string, unknown>)
      } catch {
        rejectRun(new Error((stderr || stdout || 'PaddleOCR 没有返回有效 JSON').trim()))
      }
    })
  })
}

function shouldUseInteractiveClip(targetUrl: string) {
  try {
    const hostname = new URL(targetUrl).hostname
    return /xiaohongshu|xhslink/i.test(hostname)
  } catch {
    return false
  }
}

function shouldUseSystemChromeClip(targetUrl: string) {
  try {
    const hostname = new URL(targetUrl).hostname
    return /(^|\.)britishmuseum\.org$/i.test(hostname)
  } catch {
    return false
  }
}

function summarizeClipFailure(detail: unknown) {
  const text = String(detail || '').trim()
  if (!text) return '采集脚本没有生成结果'
  if (/Target page, context or browser has been closed|launchPersistentContext|user-data-dir/i.test(text)) {
    return '小红书采集需要连接常驻登录浏览器。请关闭旧版“登录采集浏览器”窗口，重新打开一次；之后窗口可以一直保留。'
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function runClipScript(targetUrl: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const interactiveClip = shouldUseInteractiveClip(targetUrl)
    const systemChromeClip = shouldUseSystemChromeClip(targetUrl)
    const child = spawn(process.execPath, ['scripts/clip-page.mjs', targetUrl], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        ARCHIVE_WEB_CLIPS_DIR: archiveWebClipsRoot,
        ...(interactiveClip ? { CLIP_INTERACTIVE_LOGIN: 'true' } : {}),
      },
      windowsHide: !interactiveClip,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      rejectRun(new Error('网页采集超时'))
    }, interactiveClip || systemChromeClip ? 240000 : 90000)

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

async function startClipLoginBrowser(targetUrl: string) {
  await mkdir(archiveLogsRoot, { recursive: true })
  const logFd = openSync(join(archiveLogsRoot, 'clip-login-browser.log'), 'a')
  writeSync(logFd, `\n[${new Date().toISOString()}] start ${targetUrl}\n`)
  const debugPort = Number(process.env.CLIP_LOGIN_DEBUG_PORT || 48765)

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

    const settleTimer = setTimeout(async () => {
      child.unref()
      writeSync(logFd, `[${new Date().toISOString()}] spawned pid ${child.pid}\n`)
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) })
          if (response.ok) break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
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
    message: '采集登录浏览器已打开，请在这个窗口里完成小红书登录；确认能看到笔记内容后可保持窗口打开，再点击重新读取。',
  })
}

async function handleOcrPost(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as { images?: unknown } : {}
  const images = Array.isArray(payload.images) ? payload.images : []
  if (!images.length) {
    sendJson(response, 400, { error: '请上传需要 OCR 的图片' })
    return
  }

  await mkdir(archiveOcrTempRoot, { recursive: true })
  const results: Record<string, unknown>[] = []
  for (const [index, image] of images.entries()) {
    const parsedImage = normalizeOcrDataUrl(image)
    if (!parsedImage) {
      sendJson(response, 400, { error: '图片格式无效，仅支持 JPG、PNG、WebP' })
      return
    }

    const imagePath = join(archiveOcrTempRoot, `ocr-${Date.now()}-${index}.${parsedImage.extension}`)
    try {
      await writeFile(imagePath, parsedImage.buffer)
      const result = await runPaddleOcr(imagePath)
      if (!result.ok) {
        sendJson(response, 503, { error: normalizeString(result.error) || 'PaddleOCR 识别失败' })
        return
      }
      results.push(result)
    } finally {
      await rm(imagePath, { force: true }).catch(() => {})
    }
  }

  sendJson(response, 200, {
    engine: 'paddleocr',
    text: results.map((result) => normalizeString(result.text)).filter(Boolean).join('\n\n'),
    pages: results,
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

const localArchiveDataRoot = resolve('.archive-data')
const sharedArchiveRootConfigFile = resolve('.archive-data/shared-root.txt')
function readSharedArchiveRoot() {
  const envRoot = process.env.ARCHIVE_SHARED_DATA_ROOT?.trim()
  if (envRoot) return resolve(envRoot)

  try {
    const fileRoot = readFileSync(sharedArchiveRootConfigFile, 'utf8').trim()
    if (fileRoot) return resolve(fileRoot)
  } catch {
    // Shared data root is optional for local-only development.
  }

  return ''
}

const sharedArchiveDataRoot = readSharedArchiveRoot()
const archiveStorageRoot = sharedArchiveDataRoot || localArchiveDataRoot
const archiveDataFile = resolve(process.env.ARCHIVE_DATA_FILE ?? join(archiveStorageRoot, 'archive-db.json'))
const archiveWebClipsRoot = resolve(process.env.ARCHIVE_WEB_CLIPS_DIR ?? join(archiveStorageRoot, 'web-clips'))
const archiveLogsRoot = resolve(process.env.ARCHIVE_LOG_DIR ?? join(archiveStorageRoot, 'logs'))
const archiveOcrTempRoot = resolve(process.env.ARCHIVE_OCR_TEMP_DIR ?? join(archiveStorageRoot, 'ocr-temp'))
const svnRootConfigFile = resolve('.archive-data/svn-root.txt')
const svnIndexFile = resolve(process.env.SVN_INDEX_FILE ?? join(archiveStorageRoot, 'svn-index.json'))
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
let svnRoot = readConfiguredSvnRoot()
const svnMaxFiles = Number(process.env.SVN_MAX_FILES ?? 400)
const webClipArchiveRoot = process.env.ARCHIVE_WEB_CLIP_SVN_ROOT ?? '/ArtArchive/sources/web'
const webClipPreviewRoot = process.env.ARCHIVE_WEB_CLIP_PREVIEW_ROOT ?? '/ArtArchive/preview/web'
const webClipThumbRoot = process.env.ARCHIVE_WEB_CLIP_THUMB_ROOT ?? '/ArtArchive/thumbs/web'
const defaultHomeHeroItems = [
  { id: 'hero-1', itemId: 'han-cap-system' },
  { id: 'hero-2', itemId: 'wei-armor' },
  { id: 'hero-3', itemId: 'han-scholar-robe' },
  { id: 'hero-4', itemId: 'han-brick-clothing' },
]
let svnUpdatePromise: Promise<unknown> | null = null
let svnIndexPromise: Promise<SvnIndex> | null = null
let svnIndexCache: SvnIndex | null = null
let archiveDbUpdateQueue = Promise.resolve()
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

type SvnIndexFile = {
  name: string
  path: string
  size: number
  mtimeMs: number
}

type SvnIndex = {
  version: 1
  root: string
  builtAt: string
  folders: string[]
  files: SvnIndexFile[]
}

type ArchiveDb = {
  drafts?: unknown[]
  items?: unknown[]
  assets?: unknown[]
  bookSources?: unknown[]
  bookPages?: unknown[]
  feedbacks?: unknown[]
  settings?: Record<string, unknown>
}

async function readArchiveDb() {
  try {
    const db = JSON.parse(await readFile(archiveDataFile, 'utf8')) as ArchiveDb
        db.settings = normalizeArchiveSettings(db.settings)
        normalizeArchiveDb(db)
        return db
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return { drafts: [], items: [], assets: [], settings: normalizeArchiveSettings({}) }
      }
    }

async function writeArchiveDb(db: ArchiveDb) {
  await mkdir(dirname(archiveDataFile), { recursive: true })
  const tempFile = `${archiveDataFile}.${process.pid}.tmp`
  await writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
  await rename(tempFile, archiveDataFile)
}

const archiveEventClients = new Set<import('node:http').ServerResponse>()
let archiveEventVersion = 0

function broadcastArchiveChange(reason: string) {
  archiveEventVersion += 1
  const payload = JSON.stringify({ type: 'archive-change', reason, version: archiveEventVersion, at: new Date().toISOString() })
  for (const client of archiveEventClients) {
    client.write(`event: archive-change\ndata: ${payload}\n\n`)
  }
}

function handleArchiveEvents(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: '接口只支持 GET' })
    return
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write(`event: archive-ready\ndata: ${JSON.stringify({ type: 'archive-ready', version: archiveEventVersion })}\n\n`)
  archiveEventClients.add(response)
  request.on('close', () => {
    archiveEventClients.delete(response)
  })
}

async function updateArchiveDb<T>(mutator: (db: ArchiveDb) => Promise<T> | T) {
  const runUpdate = archiveDbUpdateQueue.then(async () => {
    const db = await readArchiveDb()
    const result = await mutator(db)
    normalizeArchiveDb(db)
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

function isLikelyImagePath(value = '') {
  return /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i.test(normalizeString(value).replace(/\\/g, '/').split(/[?#]/)[0])
}

function normalizeVisualSourceUrl(value: unknown) {
  const normalized = normalizeString(value)
  if (!normalized) return ''

  try {
    const url = new URL(normalized)
    url.protocol = 'https:'
    url.hash = ''
    url.search = ''
    const parts = url.pathname.split('/')
    const fileName = parts.pop() ?? ''
    parts.push(fileName.replace(/^(preview|mid|small|thumb|thumbnail|large|zoom|original|full)_/i, ''))
    return `${url.hostname}${parts.join('/')}`.toLowerCase()
  } catch {
    return normalized
      .replace(/^(preview|mid|small|thumb|thumbnail|large|zoom|original|full)_/i, '')
      .toLowerCase()
  }
}

function getAssetVisualKeys(asset: Record<string, unknown>) {
  const values = [
    normalizeString(asset.contentHash) ? `hash:${normalizeString(asset.contentHash).toLowerCase().replace(/^sha256:/, '')}` : '',
    normalizeString(asset.visualKey),
    ...[asset.originalUrl, asset.sourceUrl]
      .filter((value) => isLikelyImagePath(normalizeString(value)))
      .map(normalizeVisualSourceUrl),
    ...[asset.imageUrl, asset.thumbnailUrl, asset.svnPath].map(normalizeVisualSourceUrl),
  ].filter(Boolean)
  return Array.from(new Set(values))
}

function getAssetRepresentativeScore(asset: Record<string, unknown>) {
  const caption = normalizeString(asset.caption)
  const sourceUrl = `${normalizeString(asset.originalUrl)} ${normalizeString(asset.sourceUrl)}`.toLowerCase()
  const mainImageScore = caption === '网页主图' ? 1_000_000 : caption.includes('主图') ? 500_000 : 0
  const qualityScore = /(mid|large|original|full)_/.test(sourceUrl) ? 10_000 : 0
  return mainImageScore + qualityScore + (Number(asset.fileSize) || 0)
}

function mergeAssetsWithVisualKeys(existingAssets: unknown, nextAssets: unknown) {
  const merged = new Map<string, unknown>()
  const indexByVisualKey = new Map<string, string>()
  const idMap = new Map<string, string>()

  const addAsset = (asset: Record<string, unknown>, preferNext = false) => {
    const keys = getAssetVisualKeys(asset)
    const existingId = keys.map((key) => indexByVisualKey.get(key)).find(Boolean)
    if (!existingId) {
      merged.set(String(asset.id), asset)
      keys.forEach((key) => indexByVisualKey.set(key, String(asset.id)))
      idMap.set(String(asset.id), String(asset.id))
      return String(asset.id)
    }

    const existing = merged.get(existingId) as Record<string, unknown>
    const shouldReplace = preferNext || getAssetRepresentativeScore(asset) > getAssetRepresentativeScore(existing)
    const keptAsset = shouldReplace
      ? { ...existing, ...asset, id: existing.id, linkedItemId: existing.linkedItemId || asset.linkedItemId }
      : existing
    merged.set(existingId, keptAsset)
    keys.forEach((key) => indexByVisualKey.set(key, existingId))
    idMap.set(String(asset.id), existingId)
    return existingId
  }

  if (Array.isArray(existingAssets)) {
    existingAssets.filter(isAssetRecord).forEach((asset) => {
      addAsset(asset as Record<string, unknown>)
    })
  }

  if (Array.isArray(nextAssets)) {
    nextAssets.filter(isAssetRecord).forEach((asset) => {
      addAsset(asset as Record<string, unknown>, merged.has((asset as { id: string }).id))
    })
  }

  return { assets: Array.from(merged.values()), idMap }
}

function uniqueStringList(values: unknown) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeString).filter(Boolean)))
}

function remapItemAssetIds(item: Record<string, unknown>, idMap: Map<string, string>) {
  return uniqueStringList([...(Array.isArray(item.assetIds) ? item.assetIds : []), ...(Array.isArray(item.imageIds) ? item.imageIds : [])])
    .map((assetId) => idMap.get(assetId) ?? assetId)
    .filter(Boolean)
}

function normalizeEntryTitleKey(value: unknown) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[|\uFF5C].*$/, '')
    .replace(/[;\uFF1B]/g, ';')
    .replace(/[\s_-]+/g, ' ')
    .trim()
}

function normalizeIdentityPath(value: unknown) {
  return normalizeString(value).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
}

function getEntryImportSourceKey(entry: Record<string, unknown> | undefined) {
  const importPath = normalizeIdentityPath(entry?.importSourcePath)
  if (importPath) return `import:${importPath}`
  const mode = normalizeString(entry?.mode)
  const id = normalizeString(entry?.id)
  if ((mode === 'markdown-import' || id.startsWith('md-')) && id) return `import-id:${id.toLowerCase()}`
  return ''
}

function getEntryIdentityKeys(entry: Record<string, unknown> | undefined, relatedAssets: unknown[] = []) {
  const sourceUrl = getEntrySourceUrl(entry, relatedAssets)
  const importSourceKey = getEntryImportSourceKey(entry)
  return [sourceUrl ? `source:${sourceUrl}` : '', importSourceKey].filter(Boolean)
}

function getEntryMergedIdentityKeys(entry: Record<string, unknown>, relatedAssets: unknown[], assetIdMap: Map<string, string>) {
  const nextItem: Record<string, unknown> & { assetIds: string[]; imageIds: string[] } = {
    ...entry,
    assetIds: remapItemAssetIds(entry, assetIdMap),
    imageIds: remapItemAssetIds(entry, assetIdMap),
  }
  const titleKey = normalizeEntryTitleKey(nextItem.title)
  const assetKeys = new Set<string>(nextItem.assetIds)

  ;(Array.isArray(relatedAssets) ? relatedAssets : []).forEach((asset) => {
    if (!asset || typeof asset !== 'object') return
    const record = asset as Record<string, unknown>
    const assetId = normalizeString(record.id)
    const mappedAssetId = assetIdMap.get(assetId) ?? assetId
    if (mappedAssetId) assetKeys.add(mappedAssetId)
    getAssetVisualKeys(record).forEach((visualKey) => assetKeys.add(`visual:${visualKey}`))
  })

  return uniqueStringList([
    ...getEntryIdentityKeys(entry, relatedAssets),
    ...(titleKey ? Array.from(assetKeys).map((assetKey) => `title-asset:${titleKey}:${assetKey}`) : []),
  ])
}

function getItemStatusRank(item: Record<string, unknown>) {
  if (item.status === 'deleted') return 4
  if (item.status === 'hidden') return 3
  if (item.status === 'active') return 2
  if (item.status === 'draft') return 1
  return 0
}

function getItemTimestamp(item: Record<string, unknown>, fields: string[]) {
  return Math.max(
    ...fields.map((field) => Date.parse(normalizeString(item[field]))).filter((time) => Number.isFinite(time)),
    0,
  )
}

function getItemCompletenessScore(item: Record<string, unknown>) {
  const assetCount = uniqueStringList([...(Array.isArray(item.assetIds) ? item.assetIds : []), ...(Array.isArray(item.imageIds) ? item.imageIds : [])]).length
  return (
    assetCount * 1000 +
    normalizeString(item.title).length * 10 +
    normalizeString(item.summary).length +
    normalizeString(item.note).length +
    normalizeString(item.extraNote).length
  )
}

function chooseItemRepresentative(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftRank = getItemStatusRank(left)
  const rightRank = getItemStatusRank(right)
  if (leftRank !== rightRank) return rightRank > leftRank ? right : left

  const leftScore = getItemCompletenessScore(left)
  const rightScore = getItemCompletenessScore(right)
  if (leftScore !== rightScore) return rightScore > leftScore ? right : left

  const leftCreated = getItemTimestamp(left, ['createdAt', 'savedAt', 'updatedAt'])
  const rightCreated = getItemTimestamp(right, ['createdAt', 'savedAt', 'updatedAt'])
  return rightCreated && leftCreated && rightCreated < leftCreated ? right : left
}

function mergeItemRecords(left: Record<string, unknown>, right: Record<string, unknown>, idMap: Map<string, string>) {
  const representative = chooseItemRepresentative(left, right)
  const secondary = representative === left ? right : left
  const assetIds = uniqueStringList([...remapItemAssetIds(left, idMap), ...remapItemAssetIds(right, idMap)])
  const createdTimes = [left, right]
    .map((item) => getItemTimestamp(item, ['createdAt', 'savedAt', 'updatedAt']))
    .filter(Boolean)
  const updatedTimes = [left, right]
    .map((item) => getItemTimestamp(item, ['updatedAt', 'savedAt', 'createdAt']))
    .filter(Boolean)
  const createdAt = createdTimes.length ? new Date(Math.min(...createdTimes)).toISOString() : representative.createdAt
  const updatedAt = updatedTimes.length ? new Date(Math.max(...updatedTimes)).toISOString() : representative.updatedAt

  return {
    ...secondary,
    ...representative,
    id: representative.id,
    createdAt,
    updatedAt,
    savedAt: updatedAt,
    assetIds,
    imageIds: assetIds,
  }
}

function mergeItemsByIdentity(items: unknown, assetsForIdentity: unknown, assetIdMap: Map<string, string>) {
  const merged: Record<string, unknown>[] = []
  const indexByIdentity = new Map<string, number>()
  const itemIdMap = new Map<string, string>()

  ;(Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    const itemId = normalizeString(record.id)
    const relatedAssets = (Array.isArray(assetsForIdentity) ? assetsForIdentity : []).filter(
      (asset) => asset && typeof asset === 'object' && (asset as Record<string, unknown>).linkedItemId === itemId,
    )
    const nextItem: Record<string, unknown> & { assetIds: string[]; imageIds: string[] } = {
      ...record,
      assetIds: remapItemAssetIds(record, assetIdMap),
      imageIds: remapItemAssetIds(record, assetIdMap),
    }
    const identityKeys = getEntryMergedIdentityKeys(nextItem, relatedAssets, assetIdMap)
    const existingIndex = identityKeys.map((key) => indexByIdentity.get(key)).find((index): index is number => index !== undefined)

    if (existingIndex === undefined || !identityKeys.length) {
      const nextIndex = merged.length
      merged.push(nextItem)
      itemIdMap.set(itemId, normalizeString(nextItem.id))
      identityKeys.forEach((key) => indexByIdentity.set(key, nextIndex))
      return
    }

    const currentItem = merged[existingIndex]
    const mergedItem = mergeItemRecords(currentItem, nextItem, assetIdMap)
    merged[existingIndex] = mergedItem
    itemIdMap.set(normalizeString(currentItem.id), normalizeString(mergedItem.id))
    itemIdMap.set(itemId, normalizeString(mergedItem.id))
    identityKeys.forEach((key) => indexByIdentity.set(key, existingIndex))
    getEntryMergedIdentityKeys(mergedItem, relatedAssets, assetIdMap).forEach((key) => indexByIdentity.set(key, existingIndex))
  })

  return { items: merged, itemIdMap }
}

function normalizeArchiveDb(db: ArchiveDb) {
  const existingAssets = Array.isArray(db.assets) ? db.assets : []
  const mergedAssetResult = mergeAssetsWithVisualKeys(existingAssets, [])
  const mergedItemResult = mergeItemsByIdentity(db.items, existingAssets, mergedAssetResult.idMap)
  const validItemIds = new Set(mergedItemResult.items.map((item) => normalizeString(item.id)))

  db.items = mergedItemResult.items.map((item) => {
    const assetIds = remapItemAssetIds(item, mergedAssetResult.idMap)
    return { ...item, assetIds, imageIds: assetIds }
  })
  db.assets = (mergedAssetResult.assets as Record<string, unknown>[])
    .map((asset) => {
      const linkedItemId = normalizeString(asset.linkedItemId)
      const nextLinkedItemId = mergedItemResult.itemIdMap.get(linkedItemId) ?? linkedItemId
      return nextLinkedItemId === linkedItemId ? asset : { ...asset, linkedItemId: nextLinkedItemId }
    })
    .filter((asset) => {
      const linkedItemId = normalizeString(asset.linkedItemId)
      return !linkedItemId || validItemIds.has(linkedItemId) || linkedItemId === 'svn-import'
    })

  return db
}

function isBookSourceRecord(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const record = value as { id?: unknown; title?: unknown }
  return typeof record.id === 'string' && typeof record.title === 'string'
}

function isBookPageRecord(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const record = value as { id?: unknown; bookSourceId?: unknown; pageNumber?: unknown }
  return typeof record.id === 'string' && typeof record.bookSourceId === 'string' && typeof record.pageNumber === 'string'
}

function mergeRecordsById(existingRecords: unknown, nextRecords: unknown, predicate: (value: unknown) => boolean) {
  const merged = new Map<string, unknown>()

  if (Array.isArray(existingRecords)) {
    existingRecords.filter(predicate).forEach((record) => {
      merged.set((record as { id: string }).id, record)
    })
  }

  if (Array.isArray(nextRecords)) {
    nextRecords.filter(predicate).forEach((record) => {
      merged.set((record as { id: string }).id, record)
    })
  }

  return Array.from(merged.values())
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeSourceUrl(value: unknown) {
  const text = normalizeString(value)
  if (!text) return ''

  try {
    const url = new URL(text)
    url.hash = ''
    const britishMuseumObjectId = url.hostname.toLowerCase().endsWith('britishmuseum.org')
      ? url.pathname.match(/\/collection\/object\/([^/?#]+)/i)?.[1]
      : ''
    if (britishMuseumObjectId) return `britishmuseum:object:${britishMuseumObjectId.toLowerCase()}`
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

function extractSourceUrlFromText(value: unknown) {
  const match = normalizeString(value).match(/https?:\/\/[^\s"'<>]+/i)
  return match ? normalizeSourceUrl(match[0]) : ''
}

function collectAssetSourceUrls(value: unknown) {
  if (!Array.isArray(value)) return []

  return value
    .flatMap((asset) => {
      if (!asset || typeof asset !== 'object') return []
      const record = asset as Record<string, unknown>
      return [record.sourcePageUrl, record.originalUrl, record.sourceUrl, record.svnPath, record.imageUrl, record.thumbnailUrl]
    })
    .map(normalizeSourceUrl)
    .filter(Boolean)
}

function getEntrySourceUrl(entry: Record<string, unknown> | undefined, relatedAssets: unknown[] = []) {
  return (
    normalizeSourceUrl(entry?.sourceUrl) ||
    extractSourceUrlFromText(entry?.note) ||
    extractSourceUrlFromText(entry?.extraNote) ||
    collectAssetSourceUrls(relatedAssets)[0] ||
    ''
  )
}

function findDuplicateItem(db: ArchiveDb, entry: Record<string, unknown>, payload: Record<string, unknown>) {
  const payloadAssets = Array.isArray(payload.assets) ? payload.assets : []
  const mergedAssetResult = mergeAssetsWithVisualKeys(db.assets, payloadAssets)
  const keys = getEntryMergedIdentityKeys(entry, payloadAssets, mergedAssetResult.idMap)
  if (!keys.length) return null

  const items = Array.isArray(db.items) ? db.items : []
  const dbAssets = Array.isArray(db.assets) ? db.assets : []
  const identityIndex = new Map<string, Record<string, unknown>>()
  items.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    if (record.status === 'deleted') return
    const relatedAssets = dbAssets.filter((asset) => asset && typeof asset === 'object' && (asset as Record<string, unknown>).linkedItemId === record.id)
    getEntryMergedIdentityKeys(record, relatedAssets, mergedAssetResult.idMap).forEach((key) => {
      if (!identityIndex.has(key)) identityIndex.set(key, record)
    })
  })

  return keys
    .map((key) => identityIndex.get(key))
    .find((record) => record && record.id !== entry.id) ?? null
}

function normalizeTagName(value: unknown) {
  return normalizeString(value).replace(/\s+/g, ' ')
}

function uniqueTagValues(values: unknown[]) {
  const tags: string[] = []
  const seen = new Set<string>()

  values.forEach((value) => {
    const tag = normalizeTagName(value)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) return
    seen.add(key)
    tags.push(tag)
  })

  return tags
}

function splitTagText(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueTagValues(value.flatMap((entry) => splitTagText(entry)))
  const text = normalizeTagName(value)
  if (!text) return []
  return uniqueTagValues(text.split(/[、，,;；|｜\r\n\t]+/))
}

function replaceTagList(value: unknown, oldTag: string, newTag: string) {
  const oldKey = normalizeTagName(oldTag).toLowerCase()
  const targetTag = normalizeTagName(newTag)
  let changed = false
  const tags = splitTagText(value).map((tag) => {
    if (tag.toLowerCase() !== oldKey) return tag
    changed = true
    return targetTag
  })

  return { tags: uniqueTagValues(tags), changed }
}

function normalizeTagAliasMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const aliases: Record<string, string[]> = {}
  Object.entries(value as Record<string, unknown>).forEach(([key, aliasValue]) => {
    const tag = normalizeTagName(key)
    if (!tag) return
    const normalizedAliases = uniqueTagValues(Array.isArray(aliasValue) ? aliasValue : [aliasValue])
      .filter((alias) => alias.toLowerCase() !== tag.toLowerCase())
    if (normalizedAliases.length) aliases[tag] = normalizedAliases
  })

  return aliases
}

function normalizeArchiveSettings(settings: unknown): Record<string, unknown> {
  const record = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : {}
  const legacyHomeHeroDetailId = normalizeString(record.homeHeroDetailId) || defaultHomeHeroItems[0].itemId
  const rawHomeHeroItems = Array.isArray(record.homeHeroItems)
    ? record.homeHeroItems
    : defaultHomeHeroItems.some((entry) => entry.itemId === legacyHomeHeroDetailId)
      ? [
        { id: 'hero-legacy', itemId: legacyHomeHeroDetailId },
        ...defaultHomeHeroItems.filter((entry) => entry.itemId !== legacyHomeHeroDetailId),
      ]
      : [{ id: 'hero-legacy', itemId: legacyHomeHeroDetailId }, ...defaultHomeHeroItems]
  const homeHeroItems = rawHomeHeroItems
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => {
      const item = entry as Record<string, unknown>
      return {
        id: normalizeString(item.id) || `hero-${index + 1}`,
        itemId: normalizeString(item.itemId) || defaultHomeHeroItems[index % defaultHomeHeroItems.length].itemId,
      }
    })
    .filter((entry, index, entries) => entry.itemId && entries.findIndex((candidate) => candidate.id === entry.id) === index)
  const normalizedHomeHeroItems = homeHeroItems.length ? homeHeroItems : [...defaultHomeHeroItems]
  const hiddenLiteratureIds = Array.isArray(record.hiddenLiteratureIds)
    ? Array.from(new Set(record.hiddenLiteratureIds.map(normalizeString).filter(Boolean)))
    : []
  const featuredLiteratureIds = Array.isArray(record.featuredLiteratureIds)
    ? Array.from(new Set(record.featuredLiteratureIds.map(normalizeString).filter(Boolean)))
    : []

  return {
    homeHeroDetailId: normalizedHomeHeroItems[0]?.itemId || legacyHomeHeroDetailId,
    homeHeroItems: normalizedHomeHeroItems,
    hiddenLiteratureIds,
    featuredLiteratureIds,
    tagAliases: normalizeTagAliasMap(record.tagAliases ?? record.tagAliasMap),
    disabledTags: splitTagText(record.disabledTags ?? record.disabledTagNames),
    updatedAt: normalizeString(record.updatedAt),
  }
}

function mergeTagAliasMap(currentAliases: unknown, oldTag: string, newTag: string) {
  const aliases = normalizeTagAliasMap(currentAliases)
  const oldKey = normalizeTagName(oldTag).toLowerCase()
  const newKey = normalizeTagName(newTag).toLowerCase()
  let oldAliasKey = ''
  let targetAliasKey = ''

  Object.keys(aliases).forEach((key) => {
    const normalizedKey = normalizeTagName(key).toLowerCase()
    if (normalizedKey === oldKey) oldAliasKey = key
    if (normalizedKey === newKey) targetAliasKey = key
  })

  const targetName = targetAliasKey || normalizeTagName(newTag)
  const mergedAliases = uniqueTagValues([
    ...(targetAliasKey ? aliases[targetAliasKey] ?? [] : []),
    oldTag,
    ...(oldAliasKey ? aliases[oldAliasKey] ?? [] : []),
  ]).filter((alias) => alias.toLowerCase() !== targetName.toLowerCase())

  if (oldAliasKey) delete aliases[oldAliasKey]
  if (targetAliasKey) delete aliases[targetAliasKey]
  if (mergedAliases.length) aliases[targetName] = mergedAliases

  return aliases
}

function updateDisabledTagList(currentTags: unknown, tagName: string, disabled: boolean) {
  const tag = normalizeTagName(tagName)
  const tagKey = tag.toLowerCase()
  const nextTags = splitTagText(currentTags).filter((entry) => entry.toLowerCase() !== tagKey)
  if (disabled && tag) nextTags.push(tag)
  return uniqueTagValues(nextTags)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function migrateArchiveItemTag(record: Record<string, unknown>, oldTag: string, newTag: string, now: string, updatedBy: string) {
  let changed = false
  const categories = isPlainRecord(record.categories) ? { ...record.categories } : null

  if (categories) {
    ;['标签', 'tags', 'Tags'].forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(categories, key)) return
      const result = replaceTagList(categories[key], oldTag, newTag)
      if (!result.changed) return
      categories[key] = result.tags.join('、')
      changed = true
    })
  }

  const directTags = replaceTagList(record.tags, oldTag, newTag)
  if (directTags.changed) {
    record.tags = directTags.tags
    changed = true
  }

  if (changed) {
    if (categories) record.categories = categories
    record.updatedAt = now
    record.tagUpdatedAt = now
    record.tagUpdatedBy = updatedBy
  }

  return changed
}

function migrateArchiveAssetTag(record: Record<string, unknown>, oldTag: string, newTag: string, now: string, updatedBy: string) {
  const result = replaceTagList(record.tags, oldTag, newTag)
  if (!result.changed) return false

  record.tags = result.tags
  record.updatedAt = now
  record.tagUpdatedAt = now
  record.tagUpdatedBy = updatedBy
  return true
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

async function getSvnConfigState() {
  const root = svnRoot.trim()
  const state: {
    root: string
    configured: boolean
    valid: boolean
    source: 'runtime' | 'file' | 'none'
    configFile: string
    error?: string
  } = {
    root,
    configured: Boolean(root),
    valid: false,
    source: root ? 'runtime' : 'none',
    configFile: svnRootConfigFile,
  }

  if (!root) return state

  try {
    const rootStat = await stat(root)
    state.valid = rootStat.isDirectory()
    if (!state.valid) state.error = 'SVN 根目录不是文件夹'
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'SVN 根目录不可访问'
  }

  return state
}

async function updateSvnConfig(inputRoot: unknown) {
  const rawRoot = normalizeString(inputRoot)
  if (!rawRoot) {
    const error = new Error('请输入本机 SVN 根目录')
    Object.assign(error, { status: 400 })
    throw error
  }

  const nextRoot = resolve(rawRoot)
  const nextStat = await stat(nextRoot).catch((error) => {
    const wrapped = new Error(error instanceof Error ? `SVN 根目录不存在：${error.message}` : 'SVN 根目录不存在')
    Object.assign(wrapped, { status: 400 })
    throw wrapped
  })

  if (!nextStat.isDirectory()) {
    const error = new Error('SVN 根目录必须是文件夹')
    Object.assign(error, { status: 400 })
    throw error
  }

  await mkdir(dirname(svnRootConfigFile), { recursive: true })
  await writeFile(svnRootConfigFile, `${nextRoot}\n`, 'utf8')
  svnRoot = nextRoot
  return getSvnConfigState()
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

function sanitizeArchiveSegment(value: unknown, fallback = 'web_clip') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || fallback
}

function getArchivePlatform(sourceUrl: unknown) {
  try {
    const hostname = new URL(String(sourceUrl || '')).hostname.replace(/^www\./, '')
    if (/xiaohongshu|xhslink/i.test(hostname)) return 'xiaohongshu'
    if (/britishmuseum/i.test(hostname)) return 'british_museum'
    if (/pinterest/i.test(hostname)) return 'pinterest'
    return sanitizeArchiveSegment(hostname, 'web')
  } catch {
    return 'web'
  }
}

function getArchiveExtension(asset: Record<string, unknown>) {
  const source = String(asset.imageUrl || asset.thumbnailUrl || asset.sourceUrl || '')
  const extension = extname(source.split(/[?#]/)[0]).toLowerCase()
  return imageExtensions.has(extension) ? extension : '.jpg'
}

function getArchiveSourceHash(...values: unknown[]) {
  const source = values.map(normalizeString).filter(Boolean).join('|')
  return createHash('sha1').update(source || String(Date.now())).digest('hex').slice(0, 8)
}

function isRealSvnAsset(asset: Record<string, unknown>) {
  return String(asset.svnPath || '').trim().startsWith('/')
}

function isWebClipAsset(asset: unknown) {
  if (!asset || typeof asset !== 'object') return false
  const record = asset as Record<string, unknown>
  if (isRealSvnAsset(record)) return false
  const imageUrl = String(record.imageUrl || '')
  const thumbnailUrl = String(record.thumbnailUrl || '')
  const sourceUrl = String(record.sourceUrl || '')
  return imageUrl.startsWith('/web-clips/') || thumbnailUrl.startsWith('/web-clips/') || /^https?:\/\//i.test(imageUrl) || /^https?:\/\//i.test(sourceUrl)
}

function resolveLocalWebClipPath(asset: Record<string, unknown>) {
  const imageUrl = String(asset.imageUrl || '')
  if (!imageUrl.startsWith('/web-clips/')) return ''
  const decoded = decodeURIComponent(imageUrl.split(/[?#]/)[0]).replace(/^\/+/, '')
  const relativePath = decoded.replace(/^web-clips[\\/]/, '')
  const sharedTarget = resolve(archiveWebClipsRoot, relativePath)
  if (sharedTarget !== archiveWebClipsRoot && sharedTarget.startsWith(`${archiveWebClipsRoot}${sep}`) && existsSync(sharedTarget)) {
    return sharedTarget
  }

  const publicRoot = resolve('public')
  const legacyTarget = resolve(publicRoot, decoded)
  return legacyTarget !== publicRoot && legacyTarget.startsWith(`${publicRoot}${sep}`) ? legacyTarget : ''
}

function handleWebClipStaticFile(url: URL, response: import('node:http').ServerResponse) {
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/(?:web-clips\/?)?/, ''))
  const targetPath = resolve(archiveWebClipsRoot, relativePath)
  if (targetPath === archiveWebClipsRoot || !targetPath.startsWith(`${archiveWebClipsRoot}${sep}`)) {
    sendText(response, 403, '路径无效')
    return
  }

  const stream = createReadStream(targetPath)
  stream.on('error', () => {
    if (!response.headersSent) sendText(response, 404, '网页采集文件不存在')
  })
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Content-Type', getMimeType(targetPath))
  stream.pipe(response)
}

async function readWebClipImageBuffer(asset: Record<string, unknown>) {
  const localPath = resolveLocalWebClipPath(asset)
  if (localPath) return readFile(localPath)

  const imageUrl = String(asset.imageUrl || asset.sourceUrl || '')
  if (!/^https?:\/\//i.test(imageUrl)) {
    const error = new Error('网页采集图片缺少可归档的原图地址')
    Object.assign(error, { status: 422 })
    throw error
  }

  const response = await fetch(imageUrl)
  if (!response.ok) {
    const error = new Error(`网页采集图片下载失败：HTTP ${response.status}`)
    Object.assign(error, { status: 502 })
    throw error
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    const error = new Error(`网页采集图片响应不是图片：${contentType || 'unknown'}`)
    Object.assign(error, { status: 422 })
    throw error
  }

  return Buffer.from(await response.arrayBuffer())
}

async function archiveWebClipAsset(asset: Record<string, unknown>, payload: Record<string, unknown>, index: number) {
  if (!isWebClipAsset(asset)) return asset

  const sourcePageUrl = String(payload.sourceUrl || asset.sourceUrl || '')
  const platform = getArchivePlatform(sourcePageUrl || asset.sourceUrl || asset.imageUrl)
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const titlePart = sanitizeArchiveSegment(payload.title || asset.caption || 'web_clip')
  const extension = getArchiveExtension(asset)
  const sequence = String(index + 1).padStart(3, '0')
  const sourceHash = getArchiveSourceHash(sourcePageUrl, asset.sourceUrl, asset.imageUrl, asset.thumbnailUrl, asset.id)
  const fileName = `${platform}_${titlePart}_${sourceHash}_${yyyy}${mm}${String(now.getDate()).padStart(2, '0')}_${sequence}${extension}`
  const archivePath = `${webClipArchiveRoot}/${platform}/${yyyy}/${mm}/${fileName}`.replace(/\/+/g, '/')
  const targetPath = resolveSvnPath(archivePath)

  await mkdir(dirname(targetPath), { recursive: true })
  const localPath = resolveLocalWebClipPath(asset)
  if (localPath) {
    await copyFile(localPath, targetPath)
  } else {
    await writeFile(targetPath, await readWebClipImageBuffer(asset))
  }

  const fileStat = await stat(targetPath)
  const svnPath = toSvnPath(targetPath)
  const imageUrl = `/api/svn/file?path=${encodeURIComponent(svnPath)}`
  return {
    ...asset,
    svnPath,
    imageUrl,
    thumbnailUrl: imageUrl,
    originalUrl: String(asset.sourceUrl || asset.imageUrl || ''),
    visualKey: getAssetVisualKeys(asset)[0] || normalizeVisualSourceUrl(asset.sourceUrl) || normalizeVisualSourceUrl(asset.imageUrl),
    sourcePageUrl,
    fileName: basename(targetPath),
    fileSize: fileStat.size,
    mimeType: getMimeType(targetPath),
    previewPath: `${webClipPreviewRoot}/${platform}/${yyyy}/${mm}/${fileName}`.replace(/\/+/g, '/'),
    thumbnailPath: `${webClipThumbRoot}/${platform}/${yyyy}/${mm}/${fileName}`.replace(/\/+/g, '/'),
    archiveStatus: 'archived',
    archivedAt: now.toISOString(),
  }
}

async function archiveWebClipAssetsForPayload(payload: Record<string, unknown>, kind: 'drafts' | 'items') {
  if (kind !== 'items' || !Array.isArray(payload.assets)) return
  const archivedAssets = []

  for (const [index, asset] of payload.assets.entries()) {
    try {
      archivedAssets.push(await archiveWebClipAsset(asset as Record<string, unknown>, payload, index))
    } catch (error) {
      const record = asset as { caption?: unknown; id?: unknown }
      const message = error instanceof Error ? error.message : String(error)
      const archiveError = new Error(`图片归档失败：${record?.caption || record?.id || `第 ${index + 1} 张图片`}，${message}`)
      Object.assign(archiveError, { status: (error as { status?: number })?.status ?? 502 })
      throw archiveError
    }
  }

  payload.assets = archivedAssets
}

function sizeLabel(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

function makeSvnFileRecord({ name, svnPath, size }: { name: string; svnPath: string; size: number }) {
  const imageUrl = `/api/svn/file?path=${encodeURIComponent(svnPath)}`
  return {
    id: `svn-${Buffer.from(svnPath).toString('base64url')}`,
    name,
    path: svnPath,
    thumbnailUrl: imageUrl,
    previewUrl: imageUrl,
    sizeLabel: sizeLabel(size),
    sourceType: 'SVN 图片库',
    referencePurpose: '研究线索',
    tags: ['SVN'],
  }
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
        files.push(makeSvnFileRecord({ name: entry.name, svnPath, size: fileStat.size }))
      }
    }

    if (files.length >= svnMaxFiles) return
  }
}

async function collectSvnIndexEntries(folderPath: string, entries: SvnIndexFile[]) {
  const dirEntries = await readdir(folderPath, { withFileTypes: true })
  for (const entry of dirEntries) {
    if (entry.name === '.svn') continue

    const fullPath = join(folderPath, entry.name)
    if (entry.isDirectory()) {
      await collectSvnIndexEntries(fullPath, entries)
    } else if (entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase())) {
      const fileStat = await stat(fullPath)
      entries.push({
        name: entry.name,
        path: toSvnPath(fullPath),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      })
    }
  }
}

async function buildSvnIndex() {
  const root = ensureSvnRoot()
  if (svnIndexPromise) return svnIndexPromise

  svnIndexPromise = (async () => {
    const entries: SvnIndexFile[] = []
    await collectSvnIndexEntries(root, entries)
    const rootEntries = await readdir(root, { withFileTypes: true })
    const folders = rootEntries
      .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
      .map((entry) => `/${entry.name}`)
    const index: SvnIndex = {
      version: 1,
      root,
      builtAt: new Date().toISOString(),
      folders,
      files: entries,
    }

    await mkdir(dirname(svnIndexFile), { recursive: true })
    const tempFile = `${svnIndexFile}.${process.pid}.tmp`
    await writeFile(tempFile, `${JSON.stringify(index)}\n`, 'utf8')
    await rename(tempFile, svnIndexFile)
    svnIndexCache = index
    return index
  })().finally(() => {
    svnIndexPromise = null
  })

  return svnIndexPromise
}

async function readSvnIndex() {
  const root = ensureSvnRoot()
  if (svnIndexCache?.root === root) return svnIndexCache

  try {
    const index = JSON.parse(await readFile(svnIndexFile, 'utf8')) as SvnIndex
    if (index?.version !== 1 || index.root !== root || !Array.isArray(index.files)) return null
    svnIndexCache = index
    return index
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Read SVN index failed', error)
    return null
  }
}

function fileMatchesSvnRequest(file: SvnIndexFile, requestPath: string, query: string) {
  const normalizedRequestPath = requestPath === '/' ? '/' : `/${requestPath.replace(/^\/+|\/+$/g, '')}`
  if (normalizedRequestPath !== '/' && file.path !== normalizedRequestPath && !file.path.startsWith(`${normalizedRequestPath}/`)) {
    return false
  }

  const searchable = `${file.name} ${file.path}`.toLowerCase()
  return !query || searchable.includes(query)
}

function querySvnIndex(index: SvnIndex, requestPath: string, query: string) {
  const matchedFiles = index.files
    .filter((file) => fileMatchesSvnRequest(file, requestPath, query))
    .slice(0, svnMaxFiles)
    .map((file) => makeSvnFileRecord({ name: file.name, svnPath: file.path, size: Number(file.size) || 0 }))

  return {
    files: matchedFiles,
    folders: index.folders,
    total: matchedFiles.length,
    indexedTotal: index.files.length,
    indexed: true,
    indexBuiltAt: index.builtAt,
    root: index.root,
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

  const index = await readSvnIndex()
  if (index) {
    sendJson(response, 200, querySvnIndex(index, requestPath, query))
    return
  }

  const rootEntries = await readdir(root, { withFileTypes: true })
  const folders = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
    .map((entry) => `/${entry.name}`)
  const files: unknown[] = []
  await collectSvnFiles(folderPath, query, files)
  sendJson(response, 200, { files, folders, total: files.length, root, indexed: false })
}

async function handleSvnFile(url: URL, response: import('node:http').ServerResponse) {
  const filePath = resolveSvnPath(url.searchParams.get('path') ?? '')
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(filePath)
  } catch {
    const error = new Error('SVN file does not exist')
    Object.assign(error, { status: 404 })
    throw error
  }
  if (!fileStat.isFile()) {
    const error = new Error('SVN path is not a file')
    Object.assign(error, { status: 400 })
    throw error
  }

  const stream = createReadStream(filePath)

  stream.on('error', (error) => {
    if (!response.headersSent) {
      sendText(response, 500, error instanceof Error ? error.message : 'Failed to read SVN file')
    } else {
      response.destroy(error instanceof Error ? error : undefined)
    }
  })
  response.statusCode = 200
  response.setHeader('Content-Type', getMimeType(filePath))
  response.setHeader('Cache-Control', 'public, max-age=300')
  stream.pipe(response)
}
async function handleSvnOpen(url: URL, response: import('node:http').ServerResponse) {
  const svnPath = url.searchParams.get('path') ?? ''
  const targetPath = resolveSvnPath(svnPath)
  let targetStat: Awaited<ReturnType<typeof stat>>

  try {
    targetStat = await stat(targetPath)
  } catch {
    const error = new Error('SVN 文件不存在')
    Object.assign(error, { status: 404 })
    throw error
  }

  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args =
    process.platform === 'win32'
      ? [targetStat.isDirectory() ? targetPath : `/select,${targetPath}`]
      : [targetStat.isDirectory() ? targetPath : dirname(targetPath)]

  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
  sendJson(response, 200, { ok: true, path: svnPath })
}

function extractSvnRevision(output: unknown) {
  const text = String(output || '')
  return text.match(/(?:revision|版本)\s+(\d+)/i)?.[1] ?? ''
}

function summarizeProcessOutput(stdout: unknown, stderr: unknown) {
  const text = [stderr, stdout].map((entry) => String(entry || '').trim()).filter(Boolean).join('\n\n')
  return text.length > 4000 ? `${text.slice(-4000)}\n...` : text
}

function isMissingSvnCommandError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}

async function buildSvnIndexOnlyUpdateResult(root: string, svnCommand: string, errorMessage = '') {
  const index = await buildSvnIndex()
  const message = `未找到 SVN 命令（${svnCommand}）。已刷新本地索引 ${index.files.length} 个文件，但未从远端拉取更新。`
  return {
    ok: true,
    root,
    revision: '',
    svnUpdated: false,
    indexOnly: true,
    indexedFiles: index.files.length,
    indexBuiltAt: index.builtAt,
    stdout: '',
    stderr: errorMessage,
    warning: message,
    message,
    updatedAt: new Date().toISOString(),
  }
}

async function handleSvnUpdate(response: import('node:http').ServerResponse) {
  const root = ensureSvnRoot()
  if (svnUpdatePromise) {
    const error = new Error('SVN 更新正在运行，请稍后再试')
    Object.assign(error, { status: 409 })
    throw error
  }

  const svnCommand = process.env.SVN_COMMAND || 'svn'
  const timeoutMs = Number(process.env.SVN_UPDATE_TIMEOUT_MS ?? 600000)
  svnUpdatePromise = new Promise<{ stdout: string; stderr: string; missingCommand?: boolean; errorMessage?: string }>((resolveRun, rejectRun) => {
    const child = spawn(svnCommand, ['update', root, '--non-interactive'], {
      cwd: root,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      const error = new Error('SVN 更新超时')
      Object.assign(error, { status: 504 })
      rejectRun(error)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      if (isMissingSvnCommandError(error)) {
        resolveRun({ stdout: '', stderr: '', missingCommand: true, errorMessage: error.message })
        return
      }
      Object.assign(error, { status: 500 })
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        const error = new Error(summarizeProcessOutput(stdout, stderr) || `svn update 退出：${code}`)
        Object.assign(error, { status: 502 })
        rejectRun(error)
        return
      }

      resolveRun({ stdout, stderr })
    })
  })
    .then(async ({ stdout, stderr, missingCommand, errorMessage }) => {
      if (missingCommand) {
        return buildSvnIndexOnlyUpdateResult(root, svnCommand, errorMessage)
      }

      const revision = extractSvnRevision(stdout || stderr)
      const index = await buildSvnIndex()
      return {
        ok: true,
        root,
        revision,
        svnUpdated: true,
        indexOnly: false,
        indexedFiles: index.files.length,
        indexBuiltAt: index.builtAt,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        message: revision
          ? `SVN 已同步到 r${revision}，并刷新本地索引 ${index.files.length} 个文件。`
          : `SVN 已更新，并刷新本地索引 ${index.files.length} 个文件。`,
        updatedAt: new Date().toISOString(),
      }
    })
    .finally(() => {
    svnUpdatePromise = null
  })

  sendJson(response, 200, await svnUpdatePromise)
}

function normalizeArchivePayload(payload: Record<string, unknown>, kind: 'drafts' | 'items') {
  const now = new Date().toISOString()
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  const sourceUrl = normalizeString(payload.sourceUrl)

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
    extraNote: payload.extraNote ?? '',
    categories: payload.categories ?? {},
    assetIds: Array.isArray(payload.assetIds) ? payload.assetIds : [],
    sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs : [],
    sourceUrl,
    createdBy: normalizeString(payload.createdBy) || 'Web Clipper',
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
  await archiveWebClipAssetsForPayload(payload, kind)
  const entry = normalizeArchivePayload(payload, kind)

  if (kind === 'items' && !payload.forceCreateDuplicate) {
    const db = await readArchiveDb()
    const duplicate = findDuplicateItem(db, entry, payload)
    if (duplicate && typeof duplicate === 'object') {
      const record = duplicate as Record<string, unknown>
      sendJson(response, 409, {
        error: '疑似已存在相同资料',
        duplicate: {
          id: record.id,
          title: record.title,
          sourceUrl: getEntrySourceUrl(record, Array.isArray(db.assets) ? db.assets.filter((asset) => asset && typeof asset === 'object' && (asset as Record<string, unknown>).linkedItemId === record.id) : []),
          reason: '来源链接相同',
          createdAt: record.createdAt ?? record.savedAt ?? record.updatedAt ?? '',
          createdBy: record.createdBy ?? '未知',
        },
      })
      return
    }
  }

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
      const mergedAssetResult = mergeAssetsWithVisualKeys(db.assets, payload.assets)
      entry.assetIds = entry.assetIds.map((assetId) => mergedAssetResult.idMap.get(assetId) ?? assetId)
      list[existingIndex >= 0 ? existingIndex : 0] = {
        ...(list[existingIndex >= 0 ? existingIndex : 0] as object),
        assetIds: entry.assetIds,
        imageIds: entry.assetIds,
      }
      db.assets = mergedAssetResult.assets
      db.bookSources = mergeRecordsById(db.bookSources, payload.bookSources, isBookSourceRecord)
      db.bookPages = mergeRecordsById(db.bookPages, payload.bookPages, isBookPageRecord)
    }
  })

  broadcastArchiveChange(kind === 'items' ? 'items-saved' : 'drafts-saved')
  sendJson(response, 200, { id: entry.id, savedAt: entry.savedAt })
}

async function purgeArchiveItem(itemId: string, response: import('node:http').ServerResponse) {
  const result = await updateArchiveDb((db) => {
    const items = Array.isArray(db.items) ? db.items : []
    const existing = items.find((item) => {
      if (!item || typeof item !== 'object') return false
      return (item as { id?: unknown }).id === itemId
    }) as Record<string, unknown> | undefined

    if (!existing) {
      const error = new Error('资料不存在')
      Object.assign(error, { status: 404 })
      throw error
    }

    const assetIds = new Set([
      ...(Array.isArray(existing.assetIds) ? existing.assetIds : []),
      ...(Array.isArray(existing.imageIds) ? existing.imageIds : []),
    ].filter(Boolean))

    db.items = items.filter((item) => {
      if (!item || typeof item !== 'object') return true
      return (item as { id?: unknown }).id !== itemId
    })
    db.drafts = (Array.isArray(db.drafts) ? db.drafts : []).filter((draft) => {
      if (!draft || typeof draft !== 'object') return true
      return (draft as { sourceItemId?: unknown }).sourceItemId !== itemId
    })
    db.assets = (Array.isArray(db.assets) ? db.assets : []).filter((asset) => {
      if (!asset || typeof asset !== 'object') return true
      const record = asset as { id?: unknown; linkedItemId?: unknown }
      return record.linkedItemId !== itemId && !assetIds.has(record.id)
    })
    db.feedbacks = (Array.isArray(db.feedbacks) ? db.feedbacks : []).filter((feedback) => {
      if (!feedback || typeof feedback !== 'object') return true
      return (feedback as { itemId?: unknown }).itemId !== itemId
    })

    return { id: itemId, purged: true, removedAssetCount: assetIds.size }
  })

  broadcastArchiveChange('item-purged')
  sendJson(response, 200, result)
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

  broadcastArchiveChange('item-status')
  sendJson(response, 200, result)
}

async function handleArchiveTagRenamePost(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
  const oldTag = normalizeTagName(payload.oldTag)
  const newTag = normalizeTagName(payload.newTag)
  const updatedBy = normalizeString(payload.updatedBy) || '管理员'
  const rawMode = normalizeString(payload.mode)
  const mode = (['rename', 'merge', 'disable', 'enable'].includes(rawMode) ? rawMode : 'rename') as 'rename' | 'merge' | 'disable' | 'enable'

  if (!oldTag || ((mode === 'rename' || mode === 'merge') && !newTag)) {
    sendJson(response, 400, { error: mode === 'disable' || mode === 'enable' ? '标签不能为空' : '原标签和目标标签不能为空' })
    return
  }

  if ((mode === 'rename' || mode === 'merge') && oldTag.toLowerCase() === newTag.toLowerCase()) {
    sendJson(response, 400, { error: '目标标签与原标签相同' })
    return
  }

  const now = new Date().toISOString()
  let result: Record<string, unknown> = {
    tag: newTag || oldTag,
    previousTag: oldTag,
    alias: oldTag,
    mode,
    updatedItemCount: 0,
    updatedAssetCount: 0,
  }

  await updateArchiveDb((db) => {
    const items = Array.isArray(db.items) ? db.items : []
    const assets = Array.isArray(db.assets) ? db.assets : []
    let updatedItemCount = 0
    let updatedAssetCount = 0

    const currentSettings = normalizeArchiveSettings(db.settings)
    let tagAliases = currentSettings.tagAliases
    let disabledTags = splitTagText(currentSettings.disabledTags)

    if (mode === 'rename' || mode === 'merge') {
      items.forEach((item) => {
        if (!isPlainRecord(item)) return
        if (migrateArchiveItemTag(item, oldTag, newTag, now, updatedBy)) updatedItemCount += 1
      })

      assets.forEach((asset) => {
        if (!isPlainRecord(asset)) return
        if (migrateArchiveAssetTag(asset, oldTag, newTag, now, updatedBy)) updatedAssetCount += 1
      })

      tagAliases = mergeTagAliasMap(currentSettings.tagAliases, oldTag, newTag)
      const oldTagWasDisabled = disabledTags.some((tag) => tag.toLowerCase() === oldTag.toLowerCase())
      disabledTags = updateDisabledTagList(disabledTags, oldTag, false)
      if (mode === 'rename' && oldTagWasDisabled) disabledTags = updateDisabledTagList(disabledTags, newTag, true)
    } else {
      disabledTags = updateDisabledTagList(disabledTags, oldTag, mode === 'disable')
    }

    db.items = items
    db.assets = assets
    db.settings = normalizeArchiveSettings({
      ...currentSettings,
      tagAliases,
      disabledTags,
      updatedAt: now,
    })

    result = {
      tag: newTag || oldTag,
      previousTag: oldTag,
      alias: oldTag,
      mode,
      updatedItemCount,
      updatedAssetCount,
      disabledTags,
      settings: db.settings,
    }
  })

  broadcastArchiveChange(mode === 'disable' || mode === 'enable' ? 'tags-status-updated' : 'tags-renamed')
  sendJson(response, 200, result)
}

async function handleArchiveSettingsPost(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
  const settings = normalizeArchiveSettings(payload.settings ?? payload)
  let savedSettings = settings

  await updateArchiveDb((db) => {
    db.settings = normalizeArchiveSettings({ ...(db.settings ?? {}), ...settings })
    savedSettings = db.settings
  })

  broadcastArchiveChange('settings-saved')
  sendJson(response, 200, { settings: savedSettings })
}

async function handleArchiveFeedbackPost(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
  const itemId = normalizeString(payload.itemId)
  const itemTitle = normalizeString(payload.itemTitle)
  const feedbackType = normalizeString(payload.feedbackType) || '资料问题'
  const message = normalizeString(payload.message)

  if (!itemId) {
    sendJson(response, 400, { error: '资料 ID 不能为空' })
    return
  }

  if (!message) {
    sendJson(response, 400, { error: '请填写反馈说明' })
    return
  }

  const now = new Date().toISOString()
  const feedback = {
    id: `feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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

  await updateArchiveDb((db) => {
    const feedbacks = Array.isArray(db.feedbacks) ? db.feedbacks : []
    feedbacks.unshift(feedback)
    db.feedbacks = feedbacks
  })

  broadcastArchiveChange('feedback-created')
  sendJson(response, 200, feedback)
}

async function handleArchiveFeedbackStatusPost(
  feedbackId: string,
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const id = normalizeString(feedbackId)
  const body = await readRequestBody(request)
  const payload = body ? JSON.parse(body) as Record<string, unknown> : {}
  const status = normalizeString(payload.status)

  if (!id) {
    sendJson(response, 400, { error: '反馈 ID 不能为空' })
    return
  }

  if (!['open', 'resolved'].includes(status)) {
    sendJson(response, 400, { error: '反馈状态无效' })
    return
  }

  const now = new Date().toISOString()
  let updatedFeedback: Record<string, unknown> | null = null
  await updateArchiveDb((db) => {
    const feedbacks = Array.isArray(db.feedbacks) ? db.feedbacks : []
    db.feedbacks = feedbacks.map((feedback) => {
      if (!feedback || typeof feedback !== 'object') return feedback
      const record = feedback as Record<string, unknown>
      if (record.id !== id) return feedback
      updatedFeedback = {
        ...record,
        status,
        handledBy: normalizeString(payload.handledBy),
        handledAt: status === 'resolved' ? now : '',
      }
      return updatedFeedback
    })
  })

  if (!updatedFeedback) {
    sendJson(response, 404, { error: '未找到反馈记录' })
    return
  }

  broadcastArchiveChange('feedback-status-updated')
  sendJson(response, 200, updatedFeedback)
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

      server.middlewares.use('/api/archive/feedback', async (request, response) => {
        try {
          const requestUrl = request.url ? new URL(request.url, 'http://localhost') : null
          const feedbackStatusMatch = requestUrl?.pathname.match(
            /^(?:\/api\/archive\/feedback)?\/([^/]+)\/status$/,
          )

          if (feedbackStatusMatch) {
            if (request.method !== 'POST') {
              sendJson(response, 405, { error: '接口只支持 POST' })
              return
            }

            await handleArchiveFeedbackStatusPost(decodeURIComponent(feedbackStatusMatch[1]), request, response)
            return
          }

          if (request.method === 'POST') {
            await handleArchiveFeedbackPost(request, response)
            return
          }

          sendJson(response, 405, { error: '接口只支持 POST' })
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '反馈提交失败',
          })
        }
      })

      server.middlewares.use('/api/archive/events', (request, response) => {
        handleArchiveEvents(request, response)
      })

      server.middlewares.use('/api/archive/settings', async (request, response) => {
        try {
          if (request.method === 'GET') {
            const db = await readArchiveDb()
            sendJson(response, 200, { settings: normalizeArchiveSettings(db.settings) })
            return
          }

          if (request.method === 'POST') {
            await handleArchiveSettingsPost(request, response)
            return
          }

          sendJson(response, 405, { error: '接口只支持 GET 或 POST' })
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '配置保存失败',
          })
        }
      })

      server.middlewares.use('/api/archive/tags/rename', async (request, response) => {
        try {
          if (request.method === 'POST') {
            await handleArchiveTagRenamePost(request, response)
            return
          }

          sendJson(response, 405, { error: '接口只支持 POST' })
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '标签处理失败',
          })
        }
      })

      server.middlewares.use('/api/archive/health', (request, response) => {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: '接口只支持 GET' })
          return
        }
        sendJson(response, 200, {
          ok: true,
          dataFile: archiveDataFile,
          webClipsRoot: archiveWebClipsRoot,
          sharedArchiveDataRoot: sharedArchiveDataRoot || null,
          svnRoot: svnRoot || null,
        })
      })

      server.middlewares.use('/api/archive/items', async (request, response) => {
        try {
          const requestUrl = request.url ? new URL(request.url, 'http://localhost') : null
          const purgeMatch = requestUrl?.pathname.match(/^\/([^/]+)\/purge$/)
          if (purgeMatch) {
            if (request.method !== 'DELETE') {
              sendJson(response, 405, { error: '接口只支持 DELETE' })
              return
            }
            await purgeArchiveItem(decodeURIComponent(purgeMatch[1]), response)
            return
          }

          if (request.method === 'GET') {
            const db = await readArchiveDb()
            sendJson(response, 200, {
              items: db.items ?? [],
              assets: db.assets ?? [],
              bookSources: db.bookSources ?? [],
              bookPages: db.bookPages ?? [],
              feedbacks: db.feedbacks ?? [],
              settings: normalizeArchiveSettings(db.settings),
            })
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

      server.middlewares.use('/api/archive/ocr', async (
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
      ) => {
        try {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: '接口只支持 POST' })
            return
          }

          await handleOcrPost(request, response)
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : 'OCR 服务异常',
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
          const clipFile = resolve(archiveWebClipsRoot, slug, 'clip.json')
          const cachedClip = await readReusableClipFile(clipFile)
          if (cachedClip) {
            sendJson(response, 200, cachedClip)
            return
          }

          let runResult
          try {
            runResult = await runClipScript(targetUrl)
          } catch (error) {
            const fallbackClip = await readReusableClipFile(clipFile)
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
              error: summarizeClipFailure(detail || (error instanceof Error ? error.message : '采集脚本没有生成结果')),
            })
          }
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : '采集服务异常' })
        }
      })

      server.middlewares.use('/api/svn/config', async (request, response) => {
        try {
          if (request.method === 'GET') {
            sendJson(response, 200, await getSvnConfigState())
            return
          }

          if (request.method === 'POST') {
            const body = await readRequestBody(request)
            const payload = body ? JSON.parse(body) as { root?: unknown } : {}
            sendJson(response, 200, await updateSvnConfig(payload.root))
            return
          }

          sendJson(response, 405, { error: '接口只支持 GET/POST' })
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : 'SVN 配置保存失败',
          })
        }
      })

      server.middlewares.use('/web-clips', (request, response) => {
        try {
          if (request.method !== 'GET') {
            sendText(response, 405, '接口只支持 GET')
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          handleWebClipStaticFile(url, response)
        } catch (error) {
          sendText(response, (error as { status?: number }).status ?? 500, error instanceof Error ? error.message : '网页采集文件服务异常')
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

      server.middlewares.use('/api/svn/file', async (request, response) => {
        try {
          if (request.method !== 'GET') {
            sendText(response, 405, '接口只支持 GET')
            return
          }

          const url = new URL(request.url ?? '/', 'http://localhost')
          await handleSvnFile(url, response)
        } catch (error) {
          sendText(response, (error as { status?: number }).status ?? 500, error instanceof Error ? error.message : 'SVN 服务异常')
        }
      })

      server.middlewares.use('/api/svn/open', async (request, response) => {
        try {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: '接口只支持 POST' })
            return
          }

          const url = new URL(request.url ?? '/', 'http://localhost')
          await handleSvnOpen(url, response)
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : '打开 SVN 失败',
          })
        }
      })

      server.middlewares.use('/api/svn/update', async (request, response) => {
        try {
          if (request.method !== 'POST') {
            sendJson(response, 405, { error: '接口只支持 POST' })
            return
          }

          await handleSvnUpdate(response)
        } catch (error) {
          sendJson(response, (error as { status?: number }).status ?? 500, {
            error: error instanceof Error ? error.message : 'SVN 更新失败',
          })
        }
      })

      server.middlewares.use('/api/svn/thumb', async (request, response) => {
        try {
          if (request.method !== 'GET') {
            sendText(response, 405, '接口只支持 GET')
            return
          }

          const url = new URL(request.url ?? '/', 'http://localhost')
          await handleSvnFile(url, response)
        } catch (error) {
          sendText(response, (error as { status?: number }).status ?? 500, error instanceof Error ? error.message : 'SVN 服务异常')
        }
      })

    },
  }
}

const appBase = process.env.VITE_APP_BASE || '/'

// https://vite.dev/config/
export default defineConfig({
  base: appBase,
  plugins: [archiveDevServerPlugin(), react()],
  server: {
    allowedHosts: true,
    proxy: {
      '/api/archive': 'http://127.0.0.1:8791',
    },
  },
})
