import { createServer } from 'node:http'
import { closeSync, createReadStream, existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

const port = Number(process.env.ARCHIVE_API_PORT ?? 8791)
const host = process.env.ARCHIVE_API_HOST ?? '0.0.0.0'
const dataFile = resolve(process.env.ARCHIVE_DATA_FILE ?? '.archive-data/archive-db.json')
const logDir = resolve('.archive-data/logs')
const ocrTempDir = resolve('.archive-data/ocr-temp')
const svnRootConfigFile = resolve('.archive-data/svn-root.txt')
const svnIndexFile = resolve(process.env.SVN_INDEX_FILE ?? '.archive-data/svn-index.json')
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
let svnUpdatePromise = null
let svnIndexPromise = null
let svnIndexCache = null
let dbUpdateQueue = Promise.resolve()
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const webClipArchiveRoot = process.env.ARCHIVE_WEB_CLIP_SVN_ROOT ?? '/ArtArchive/sources/web'
const webClipPreviewRoot = process.env.ARCHIVE_WEB_CLIP_PREVIEW_ROOT ?? '/ArtArchive/preview/web'
const webClipThumbRoot = process.env.ARCHIVE_WEB_CLIP_THUMB_ROOT ?? '/ArtArchive/thumbs/web'

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

function normalizeOcrDataUrl(value) {
  const text = normalizeString(value)
  const match = text.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) return null
  const extension = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
  return { buffer: Buffer.from(match[2], 'base64'), extension }
}

function runPaddleOcr(imagePath) {
  return new Promise((resolveRun, rejectRun) => {
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
        resolveRun(JSON.parse(stdout.trim()))
      } catch {
        rejectRun(new Error((stderr || stdout || 'PaddleOCR 没有返回有效 JSON').trim()))
      }
    })
  })
}

async function handleOcrPost(request, response) {
  const payload = await readJsonBody(request)
  const images = Array.isArray(payload.images) ? payload.images : []
  if (!images.length) {
    send(response, 400, { error: '请上传需要 OCR 的图片' })
    return
  }

  await mkdir(ocrTempDir, { recursive: true })
  const results = []
  for (const [index, image] of images.entries()) {
    const parsedImage = normalizeOcrDataUrl(image)
    if (!parsedImage) {
      send(response, 400, { error: '图片格式无效，仅支持 JPG、PNG、WebP' })
      return
    }

    const imagePath = join(ocrTempDir, `ocr-${Date.now()}-${index}.${parsedImage.extension}`)
    try {
      await writeFile(imagePath, parsedImage.buffer)
      const result = await runPaddleOcr(imagePath)
      if (!result?.ok) {
        send(response, 503, { error: result?.error || 'PaddleOCR 识别失败' })
        return
      }
      results.push(result)
    } finally {
      await rm(imagePath, { force: true }).catch(() => {})
    }
  }

  send(response, 200, {
    engine: 'paddleocr',
    text: results.map((result) => normalizeString(result.text)).filter(Boolean).join('\n\n'),
    pages: results,
  })
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

function isBookSourceRecord(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && typeof value.title === 'string'
}

function isBookPageRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.bookSourceId === 'string' &&
    typeof value.pageNumber === 'string'
  )
}

function mergeById(existingRecords, nextRecords, predicate) {
  const merged = new Map()
  ;(Array.isArray(existingRecords) ? existingRecords : []).filter(predicate).forEach((record) => {
    merged.set(record.id, record)
  })
  ;(Array.isArray(nextRecords) ? nextRecords : []).filter(predicate).forEach((record) => {
    merged.set(record.id, record)
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

async function getSvnConfigState() {
  const root = svnRoot.trim()
  const state = {
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

async function updateSvnConfig(inputRoot) {
  const rawRoot = normalizeString(inputRoot)
  if (!rawRoot) {
    const error = new Error('请输入本机 SVN 根目录')
    error.status = 400
    throw error
  }

  const nextRoot = resolve(rawRoot)
  let nextStat
  try {
    nextStat = await stat(nextRoot)
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? `SVN 根目录不存在：${error.message}` : 'SVN 根目录不存在')
    wrapped.status = 400
    throw wrapped
  }

  if (!nextStat.isDirectory()) {
    const error = new Error('SVN 根目录必须是文件夹')
    error.status = 400
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
    error.status = 400
    throw error
  }

  return target
}

function toSvnPath(filePath) {
  return `/${relative(ensureSvnRoot(), filePath).replace(/\\/g, '/')}`
}

function sanitizeArchiveSegment(value, fallback = 'web_clip') {
  return normalizeString(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || fallback
}

function getArchivePlatform(sourceUrl) {
  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, '')
    if (/xiaohongshu|xhslink/i.test(hostname)) return 'xiaohongshu'
    if (/britishmuseum/i.test(hostname)) return 'british_museum'
    if (/pinterest/i.test(hostname)) return 'pinterest'
    return sanitizeArchiveSegment(hostname, 'web')
  } catch {
    return 'web'
  }
}

function getArchiveExtension(asset) {
  const source = normalizeString(asset?.imageUrl) || normalizeString(asset?.thumbnailUrl) || normalizeString(asset?.sourceUrl)
  const extension = extname(source.split(/[?#]/)[0]).toLowerCase()
  return imageExtensions.has(extension) ? extension : '.jpg'
}

function isRealSvnAsset(asset) {
  return normalizeString(asset?.svnPath).startsWith('/')
}

function isWebClipAsset(asset) {
  if (!asset || typeof asset !== 'object' || isRealSvnAsset(asset)) return false
  const imageUrl = normalizeString(asset.imageUrl)
  const thumbnailUrl = normalizeString(asset.thumbnailUrl)
  const sourceUrl = normalizeString(asset.sourceUrl)
  return imageUrl.startsWith('/web-clips/') || thumbnailUrl.startsWith('/web-clips/') || /^https?:\/\//i.test(imageUrl) || /^https?:\/\//i.test(sourceUrl)
}

function resolveLocalWebClipPath(asset) {
  const imageUrl = normalizeString(asset?.imageUrl)
  if (!imageUrl.startsWith('/web-clips/')) return ''

  const decoded = decodeURIComponent(imageUrl.split(/[?#]/)[0]).replace(/^\/+/, '')
  const target = resolve('public', decoded)
  const publicRoot = resolve('public')
  if (target !== publicRoot && target.startsWith(`${publicRoot}${sep}`)) return target
  return ''
}

function hasLocalWebClipFile(asset) {
  const localPath = resolveLocalWebClipPath(asset)
  return Boolean(localPath && existsSync(localPath))
}

function shouldSkipUnavailableWebClipAsset(asset) {
  if (!isWebClipAsset(asset) || hasLocalWebClipFile(asset)) return false

  const downloadStatus = normalizeString(asset?.downloadStatus)
  if (downloadStatus) return downloadStatus !== 'downloaded'

  const imageUrl = normalizeString(asset?.imageUrl)
  const thumbnailUrl = normalizeString(asset?.thumbnailUrl)
  const sourceUrl = normalizeString(asset?.sourceUrl)
  const hasRemoteImage = [imageUrl, thumbnailUrl, sourceUrl].some((value) => /^https?:\/\//i.test(value))

  return hasRemoteImage
}

async function readWebClipImageBuffer(asset) {
  const localPath = resolveLocalWebClipPath(asset)
  if (localPath) return readFile(localPath)

  const imageUrl = normalizeString(asset?.imageUrl) || normalizeString(asset?.sourceUrl)
  if (!/^https?:\/\//i.test(imageUrl)) {
    const error = new Error('网页采集图片缺少可归档的原图地址')
    error.status = 422
    throw error
  }

  const response = await fetch(imageUrl)
  if (!response.ok) {
    const error = new Error(`网页采集图片下载失败：HTTP ${response.status}`)
    error.status = 502
    throw error
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) {
    const error = new Error(`网页采集图片响应不是图片：${contentType || 'unknown'}`)
    error.status = 422
    throw error
  }

  return Buffer.from(await response.arrayBuffer())
}

async function archiveWebClipAsset(asset, payload, index) {
  if (!isWebClipAsset(asset)) return asset

  const root = ensureSvnRoot()
  const sourcePageUrl = normalizeString(payload.sourceUrl) || normalizeString(asset.sourceUrl)
  const platform = getArchivePlatform(sourcePageUrl || asset.sourceUrl || asset.imageUrl)
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const titlePart = sanitizeArchiveSegment(payload.title || asset.caption || 'web_clip')
  const extension = getArchiveExtension(asset)
  const sequence = String(index + 1).padStart(3, '0')
  const fileName = `${platform}_${titlePart}_${yyyy}${mm}${String(now.getDate()).padStart(2, '0')}_${sequence}${extension}`
  const archivePath = `${webClipArchiveRoot}/${platform}/${yyyy}/${mm}/${fileName}`.replace(/\/+/g, '/')
  const targetPath = resolveSvnPath(archivePath)

  await mkdir(dirname(targetPath), { recursive: true })

  const localPath = resolveLocalWebClipPath(asset)
  if (localPath && existsSync(localPath)) {
    await copyFile(localPath, targetPath)
  } else {
    await writeFile(targetPath, await readWebClipImageBuffer(asset))
  }

  const fileStat = await stat(targetPath)
  const svnPath = toSvnPath(targetPath)
  const previewPath = `${webClipPreviewRoot}/${platform}/${yyyy}/${mm}/${fileName}`.replace(/\/+/g, '/')
  const thumbnailPath = `${webClipThumbRoot}/${platform}/${yyyy}/${mm}/${fileName}`.replace(/\/+/g, '/')
  const imageUrl = `/api/svn/file?path=${encodeURIComponent(svnPath)}`

  return {
    ...asset,
    svnPath,
    imageUrl,
    thumbnailUrl: imageUrl,
    originalUrl: normalizeString(asset.sourceUrl) || normalizeString(asset.imageUrl),
    sourcePageUrl,
    fileName: basename(targetPath),
    fileSize: fileStat.size,
    mimeType: getMimeType(targetPath),
    previewPath,
    thumbnailPath,
    archiveStatus: 'archived',
    archivedAt: now.toISOString(),
  }
}

async function archiveWebClipAssetsForPayload(payload, kind) {
  if (kind !== 'items' || !Array.isArray(payload.assets)) return payload.assets
  const archivedAssets = []

  for (const [index, asset] of payload.assets.entries()) {
    if (shouldSkipUnavailableWebClipAsset(asset)) {
      continue
    }

    try {
      archivedAssets.push(await archiveWebClipAsset(asset, payload, index))
    } catch (error) {
      if (isWebClipAsset(asset) && !hasLocalWebClipFile(asset)) {
        continue
      }

      const message = error instanceof Error ? error.message : String(error)
      const archiveError = new Error(`图片归档失败：${asset?.caption || asset?.id || `第 ${index + 1} 张图片`}，${message}`)
      archiveError.status = error?.status ?? 502
      throw archiveError
    }
  }

  payload.assets = archivedAssets
  if (Array.isArray(payload.assetIds)) {
    const archivedIds = new Set(archivedAssets.map((asset) => asset?.id).filter(Boolean))
    payload.assetIds = payload.assetIds.filter((id) => archivedIds.has(id))
  }
  return archivedAssets
}

function sizeLabel(size) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

function makeSvnFileRecord({ name, svnPath, size }) {
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
        files.push(makeSvnFileRecord({ name: entry.name, svnPath, size: fileStat.size }))
      }
    }

    if (files.length >= svnMaxFiles) return
  }
}

async function collectSvnIndexEntries(folderPath, entries) {
  const dirEntries = await readdir(folderPath, { withFileTypes: true })
  for (const entry of dirEntries) {
    if (entry.name === '.svn') continue

    const fullPath = join(folderPath, entry.name)
    if (entry.isDirectory()) {
      await collectSvnIndexEntries(fullPath, entries)
    } else if (entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase())) {
      const fileStat = await stat(fullPath)
      const svnPath = toSvnPath(fullPath)
      entries.push({
        name: entry.name,
        path: svnPath,
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
    const entries = []
    await collectSvnIndexEntries(root, entries)
    const rootEntries = await readdir(root, { withFileTypes: true })
    const folders = rootEntries
      .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
      .map((entry) => `/${entry.name}`)
    const index = {
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
  if (svnIndexCache?.root === ensureSvnRoot()) return svnIndexCache

  try {
    const index = JSON.parse(await readFile(svnIndexFile, 'utf8'))
    if (index?.version !== 1 || index.root !== ensureSvnRoot() || !Array.isArray(index.files)) return null
    svnIndexCache = index
    return index
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('Read SVN index failed', error)
    return null
  }
}

function fileMatchesSvnRequest(file, requestPath, query) {
  const normalizedRequestPath = requestPath === '/' ? '/' : `/${requestPath.replace(/^\/+|\/+$/g, '')}`
  const normalizedFilePath = String(file.path || '')
  if (normalizedRequestPath !== '/' && normalizedFilePath !== normalizedRequestPath && !normalizedFilePath.startsWith(`${normalizedRequestPath}/`)) {
    return false
  }

  const searchable = `${file.name || ''} ${normalizedFilePath}`.toLowerCase()
  return !query || searchable.includes(query)
}

function querySvnIndex(index, requestPath, query) {
  const matchedFiles = index.files
    .filter((file) => fileMatchesSvnRequest(file, requestPath, query))
    .slice(0, svnMaxFiles)
    .map((file) => makeSvnFileRecord({ name: file.name, svnPath: file.path, size: Number(file.size) || 0 }))

  return {
    files: matchedFiles,
    folders: Array.isArray(index.folders) ? index.folders : [],
    total: matchedFiles.length,
    indexedTotal: index.files.length,
    indexed: true,
    indexBuiltAt: index.builtAt,
    root: index.root,
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

  const index = await readSvnIndex()
  if (index) {
    send(response, 200, querySvnIndex(index, requestPath, query))
    return
  }

  const rootEntries = await readdir(root, { withFileTypes: true })
  const folders = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
    .map((entry) => `/${entry.name}`)
  const files = []
  await collectSvnFiles(folderPath, query, files)
  send(response, 200, { files, folders, total: files.length, root, indexed: false })
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

async function handleSvnOpen(url, response) {
  const svnPath = url.searchParams.get('path') ?? ''
  const targetPath = resolveSvnPath(svnPath)
  let targetStat

  try {
    targetStat = await stat(targetPath)
  } catch {
    const error = new Error('SVN 文件不存在')
    error.status = 404
    throw error
  }

  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args =
    process.platform === 'win32'
      ? [targetStat.isDirectory() ? targetPath : `/select,${targetPath}`]
      : [targetStat.isDirectory() ? targetPath : dirname(targetPath)]

  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
  send(response, 200, { ok: true, path: svnPath })
}

function extractSvnRevision(output) {
  const text = String(output || '')
  return text.match(/(?:revision|版本)\s+(\d+)/i)?.[1] ?? ''
}

function summarizeProcessOutput(stdout, stderr) {
  const text = [stderr, stdout].map((entry) => String(entry || '').trim()).filter(Boolean).join('\n\n')
  return text.length > 4000 ? `${text.slice(-4000)}\n...` : text
}

async function handleSvnUpdate(response) {
  const root = ensureSvnRoot()
  if (svnUpdatePromise) {
    const error = new Error('SVN 更新正在运行，请稍后再试')
    error.status = 409
    throw error
  }

  const svnCommand = process.env.SVN_COMMAND || 'svn'
  const timeoutMs = Number(process.env.SVN_UPDATE_TIMEOUT_MS ?? 600000)
  svnUpdatePromise = new Promise((resolveRun, rejectRun) => {
    const child = spawn(svnCommand, ['update', root, '--non-interactive'], {
      cwd: root,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      const error = new Error('SVN 更新超时')
      error.status = 504
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
      error.status = 500
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        const error = new Error(summarizeProcessOutput(stdout, stderr) || `svn update 退出：${code}`)
        error.status = 502
        rejectRun(error)
        return
      }

      resolveRun({ stdout, stderr })
    })
  })
    .then(async ({ stdout, stderr }) => {
      const index = await buildSvnIndex()
      return {
        ok: true,
        root,
        revision: extractSvnRevision(stdout || stderr),
        indexedFiles: index.files.length,
        indexBuiltAt: index.builtAt,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        updatedAt: new Date().toISOString(),
      }
    })
    .finally(() => {
    svnUpdatePromise = null
  })

  send(response, 200, await svnUpdatePromise)
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
    sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs : [],
    sourceUrl,
    createdBy: normalizeString(payload.createdBy) || 'Web Clipper',
    status: kind === 'items' ? 'active' : 'draft',
    savedAt: now,
    updatedAt: now,
  }
}

async function handleArchivePost(kind, request, response) {
  const payload = await readJsonBody(request)
  await archiveWebClipAssetsForPayload(payload, kind)
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
      db.bookSources = mergeById(db.bookSources, payload.bookSources, isBookSourceRecord)
      db.bookPages = mergeById(db.bookPages, payload.bookPages, isBookPageRecord)
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

async function purgeArchiveItem(itemId, response) {
  const result = await updateDb(async (db) => {
    const items = Array.isArray(db.items) ? db.items : []
    const existing = items.find((item) => item.id === itemId)

    if (!existing) {
      const error = new Error('资料不存在')
      error.status = 404
      throw error
    }

    const assetIds = new Set([
      ...(Array.isArray(existing.assetIds) ? existing.assetIds : []),
      ...(Array.isArray(existing.imageIds) ? existing.imageIds : []),
    ].filter(Boolean))

    db.items = items.filter((item) => item.id !== itemId)
    db.drafts = (Array.isArray(db.drafts) ? db.drafts : []).filter((draft) => draft.sourceItemId !== itemId)
    db.assets = (Array.isArray(db.assets) ? db.assets : []).filter(
      (asset) => asset?.linkedItemId !== itemId && !assetIds.has(asset?.id),
    )
    db.feedbacks = (Array.isArray(db.feedbacks) ? db.feedbacks : []).filter((feedback) => feedback?.itemId !== itemId)

    const removedAssetCount = assetIds.size
    return { id: itemId, purged: true, removedAssetCount }
  })

  send(response, 200, result)
}

async function handleArchiveItemMutation(itemId, action, request, response) {
  if (action === 'purge') {
    await purgeArchiveItem(itemId, response)
    return
  }

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

function shouldUseInteractiveClip(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname
    return /xiaohongshu|xhslink/i.test(hostname)
  } catch {
    return false
  }
}

function summarizeClipFailure(detail) {
  const text = String(detail || '').trim()
  if (!text) return '采集脚本没有生成结果'
  if (/Target page, context or browser has been closed|launchPersistentContext|user-data-dir/i.test(text)) {
    return '小红书采集需要连接常驻登录浏览器。请关闭旧版“登录采集浏览器”窗口，重新打开一次；之后窗口可以一直保留。'
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function runClipScript(targetUrl) {
  return new Promise((resolveRun, rejectRun) => {
    const interactiveClip = shouldUseInteractiveClip(targetUrl)
    const child = spawn(process.execPath, ['scripts/clip-page.mjs', targetUrl], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        ...(interactiveClip ? { CLIP_INTERACTIVE_LOGIN: 'true' } : {}),
      },
      windowsHide: !interactiveClip,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      rejectRun(new Error('网页采集超时'))
    }, interactiveClip ? 240000 : 90000)

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
  const debugPort = Number(process.env.CLIP_LOGIN_DEBUG_PORT || 48765)

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

    settleTimer = setTimeout(async () => {
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
      finish(resolveStart, child.pid)
    }, 1200)
  })
}

async function readReusableClipFile(clipFile) {
  try {
    const clip = JSON.parse(await readFile(clipFile, 'utf8'))
    if (clip?.status !== 'failed' && Array.isArray(clip.extractedImages) && clip.extractedImages.length) {
      const clipUrl = normalizeString(clip.normalizedUrl) || normalizeString(clip.inputUrl)
      const isBritishMuseumClip = /(^|\.)britishmuseum\.org/i.test(new URL(clipUrl).hostname)
      const hasFailedImageDownloads = clip.extractedImages.some((image) => normalizeString(image?.downloadStatus) === 'failed')
      if (isBritishMuseumClip && hasFailedImageDownloads) return null
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
    message: '采集登录浏览器已打开，请在这个窗口里完成小红书登录；确认能看到笔记内容后可保持窗口打开，再点击重新读取。',
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
    const fallbackClip = await readReusableClipFile(clipFile)
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
    const message = summarizeClipFailure(detail || (error instanceof Error ? error.message : '采集脚本没有生成结果'))
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

    if (url.pathname === '/api/svn/config') {
      if (request.method === 'GET') {
        send(response, 200, await getSvnConfigState())
        return
      }

      if (request.method === 'POST') {
        const payload = await readJsonBody(request)
        send(response, 200, await updateSvnConfig(payload.root))
        return
      }

      send(response, 405, { error: '接口只支持 GET/POST' })
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

    if (request.method === 'POST' && url.pathname === '/api/svn/open') {
      await handleSvnOpen(url, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/svn/update') {
      await handleSvnUpdate(response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/archive/items') {
      const db = await readDb()
      send(response, 200, {
        items: db.items ?? [],
        assets: db.assets ?? [],
        bookSources: db.bookSources ?? [],
        bookPages: db.bookPages ?? [],
        feedbacks: db.feedbacks ?? [],
      })
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

    const archiveItemPurgeMatch = url.pathname.match(/^\/api\/archive\/items\/([^/]+)\/purge$/)
    if (archiveItemPurgeMatch && request.method === 'DELETE') {
      await handleArchiveItemMutation(decodeURIComponent(archiveItemPurgeMatch[1]), 'purge', request, response)
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

    if (request.method === 'POST' && url.pathname === '/api/archive/ocr') {
      await handleOcrPost(request, response)
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
