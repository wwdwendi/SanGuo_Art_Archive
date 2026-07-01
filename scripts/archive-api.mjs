import { createServer } from 'node:http'
import { closeSync, createReadStream, existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const port = Number(process.env.ARCHIVE_API_PORT ?? 8791)
const host = process.env.ARCHIVE_API_HOST ?? '0.0.0.0'
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
const dataFile = resolve(process.env.ARCHIVE_DATA_FILE ?? join(archiveStorageRoot, 'archive-db.json'))
const webClipsRoot = resolve(process.env.ARCHIVE_WEB_CLIPS_DIR ?? join(archiveStorageRoot, 'web-clips'))
const logDir = resolve(process.env.ARCHIVE_LOG_DIR ?? join(archiveStorageRoot, 'logs'))
const ocrTempDir = resolve(process.env.ARCHIVE_OCR_TEMP_DIR ?? join(archiveStorageRoot, 'ocr-temp'))
const svnThumbCacheDir = resolve(process.env.ARCHIVE_SVN_THUMB_CACHE_DIR ?? join(archiveStorageRoot, 'svn-thumbs'))
const archiveBackupDir = resolve(process.env.ARCHIVE_BACKUP_DIR ?? join(archiveStorageRoot, 'backups'))
const archiveOperationLogFile = resolve(process.env.ARCHIVE_OPERATION_LOG_FILE ?? join(logDir, 'archive-operations.jsonl'))
const requiredSharedArchiveDataRoot = process.env.ARCHIVE_REQUIRED_SHARED_DATA_ROOT?.trim() ?? ''
const requiredArchiveDataFile = process.env.ARCHIVE_REQUIRED_DATA_FILE?.trim() ?? ''
const svnRootConfigFile = resolve('.archive-data/svn-root.txt')
const markdownImportRootConfigFile = resolve('.archive-data/markdown-import-root.txt')
const svnAuthConfigFile = resolve('.archive-data/svn-auth.env')
const summaryModelConfigFile = resolve('.archive-data/summary-model.env')
const rootEnvConfigFiles = [
  resolve('.env'),
  resolve('.env.local'),
]
const aiModelConfigFiles = [
  ...rootEnvConfigFiles,
  resolve('.archive-data/archive-ai.env'),
  summaryModelConfigFile,
  ...(sharedArchiveDataRoot
    ? [
      resolve(join(sharedArchiveDataRoot, 'archive-ai.env')),
      resolve(join(sharedArchiveDataRoot, 'summary-model.env')),
    ]
    : []),
]

function readBooleanEnv(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

const requireCenterArchiveApi = readBooleanEnv(process.env.ARCHIVE_REQUIRE_CENTER_API) || Boolean(requiredSharedArchiveDataRoot || requiredArchiveDataFile)

function normalizeGuardPath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function archiveGuardMatches(actual, expected) {
  if (!expected) return true
  return normalizeGuardPath(actual) === normalizeGuardPath(resolve(expected))
}

function getArchiveWriteGuardState() {
  const sharedRootMatches = archiveGuardMatches(sharedArchiveDataRoot, requiredSharedArchiveDataRoot)
  const dataFileMatches = archiveGuardMatches(dataFile, requiredArchiveDataFile)
  const hasSharedRoot = Boolean(sharedArchiveDataRoot)
  const writable = !requireCenterArchiveApi || (hasSharedRoot && sharedRootMatches && dataFileMatches)
  const reasons = []

  if (requireCenterArchiveApi && !hasSharedRoot) reasons.push('ARCHIVE_SHARED_DATA_ROOT 未配置，当前 API 不是中心资料库写入口')
  if (!sharedRootMatches) reasons.push('ARCHIVE_SHARED_DATA_ROOT 与要求的中心路径不一致')
  if (!dataFileMatches) reasons.push('ARCHIVE_DATA_FILE 与要求的中心文件不一致')

  return {
    required: requireCenterArchiveApi,
    writable,
    reasons,
    dataFile,
    sharedArchiveDataRoot: sharedArchiveDataRoot || null,
    requiredSharedArchiveDataRoot: requiredSharedArchiveDataRoot || null,
    requiredArchiveDataFile: requiredArchiveDataFile || null,
  }
}

function assertArchiveWriteAllowed() {
  const guard = getArchiveWriteGuardState()
  if (guard.writable) return

  const error = new Error(`当前 API 未连接中心资料库，已禁止写入：${guard.reasons.join('；')}`)
  error.status = 423
  error.guard = guard
  throw error
}

const svnIndexFile = resolve(process.env.SVN_INDEX_FILE ?? join(archiveStorageRoot, 'svn-index.json'))
const literatureSvnFolderName = '01_\u6587\u732e\u53f2\u6599'
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

function readLocalEnvFile(filePath) {
  try {
    return Object.fromEntries(
      readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const index = line.indexOf('=')
          if (index < 0) return [line, '']
          return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
        }),
    )
  } catch {
    return {}
  }
}

function getSvnAuthArgs() {
  const localAuth = readLocalEnvFile(svnAuthConfigFile)
  const username = process.env.SVN_USERNAME || localAuth.SVN_USERNAME || ''
  const password = process.env.SVN_PASSWORD || localAuth.SVN_PASSWORD || ''
  const args = []

  if (username) args.push('--username', username)
  if (password) args.push('--password', password)
  if (username || password) args.push('--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other')

  return args
}

function readLocalEnvFiles(filePaths) {
  return filePaths.reduce((env, filePath) => ({ ...env, ...readLocalEnvFile(filePath) }), {})
}

function readConfiguredMarkdownImportRoot() {
  const envRoot = process.env.ARCHIVE_MARKDOWN_IMPORT_ROOT?.trim() || process.env.ARCHIVE_IMPORT_ROOT?.trim()
  if (envRoot) return resolve(envRoot)

  try {
    const fileRoot = readFileSync(markdownImportRootConfigFile, 'utf8').trim()
    if (fileRoot) return resolve(fileRoot)
  } catch {
    // Markdown import root is optional; fall back to the repo-specific SVN folder.
  }

  return svnRoot ? join(svnRoot, '01_文献史料') : join(archiveStorageRoot, 'imports', 'cards')
}

function getSvnCommand() {
  return process.env.SVN_COMMAND || 'svn'
}

function checkSvnCommand() {
  const svnCommand = getSvnCommand()

  return new Promise((resolveCheck) => {
    const child = spawn(svnCommand, ['--version', '--quiet'], {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      resolveCheck({ command: svnCommand, available: false, error: 'svn command check timeout' })
    }, 5000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolveCheck({
        command: svnCommand,
        available: false,
        missing: isMissingSvnCommandError(error),
        error: error.message,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      const version = stdout.trim()
      resolveCheck({
        command: svnCommand,
        available: code === 0,
        version,
        error: code === 0 ? '' : summarizeProcessOutput(stdout, stderr) || `svn --version exited ${code}`,
      })
    })
  })
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
const markdownImportRoot = readConfiguredMarkdownImportRoot()
const defaultHomeHeroItems = [
  { id: 'hero-1', itemId: 'han-cap-system' },
  { id: 'hero-2', itemId: 'wei-armor' },
  { id: 'hero-3', itemId: 'han-scholar-robe' },
  { id: 'hero-4', itemId: 'han-brick-figures' },
]

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

  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''))
}

function normalizeOcrDataUrl(value) {
  const text = normalizeString(value)
  const match = text.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) return null
  const extension = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
  return { buffer: Buffer.from(match[2], 'base64'), extension }
}

function getPaddleOcrPythonCandidates() {
  const configuredPython = process.env.PADDLE_OCR_PYTHON?.trim()
  if (configuredPython) return [configuredPython]
  return process.platform === 'win32' ? ['python', 'py'] : ['python', 'python3']
}

function shouldTryNextPaddlePython(result) {
  return result?.ok === false && /PaddleOCR not installed|No module named ['"]?paddleocr/i.test(String(result?.error || ''))
}

function runPaddleOcrCommand(imagePath, pythonCommand) {
  return new Promise((resolveRun, rejectRun) => {
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
        const jsonLine = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .reverse()
          .find((line) => line.startsWith('{') && line.endsWith('}'))
        resolveRun(JSON.parse(jsonLine || stdout.trim()))
      } catch {
        rejectRun(new Error((stderr || stdout || 'PaddleOCR 没有返回有效 JSON').trim()))
      }
    })
  })
}

async function runPaddleOcr(imagePath) {
  let lastError = null
  let lastResult = null
  const candidates = getPaddleOcrPythonCandidates()

  for (const pythonCommand of candidates) {
    try {
      const result = await runPaddleOcrCommand(imagePath, pythonCommand)
      if (shouldTryNextPaddlePython(result)) {
        lastResult = result
        continue
      }
      return result
    } catch (error) {
      lastError = error
      if (error?.code !== 'ENOENT') throw error
    }
  }

  if (lastResult) return lastResult
  throw lastError || new Error(`PaddleOCR Python command not found: ${candidates.join(', ')}`)
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
    const db = JSON.parse(raw)
    db.settings = normalizeSettings(db.settings)
    return db
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { drafts: [], items: [], assets: [], settings: normalizeSettings({}) }
  }
}

const archiveWriteRetryDelays = [50, 120, 240, 480, 900, 1600, 2400]

function isRetryableArchiveWriteError(error) {
  return ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function replaceArchiveFile(tempFile, targetFile) {
  let lastError = null

  for (let attempt = 0; attempt <= archiveWriteRetryDelays.length; attempt += 1) {
    try {
      await rename(tempFile, targetFile)
      return
    } catch (error) {
      lastError = error
      if (!isRetryableArchiveWriteError(error) || attempt >= archiveWriteRetryDelays.length) break
      await delay(archiveWriteRetryDelays[attempt])
    }
  }

  if (!isRetryableArchiveWriteError(lastError)) throw lastError

  for (let attempt = 0; attempt <= archiveWriteRetryDelays.length; attempt += 1) {
    try {
      await copyFile(tempFile, targetFile)
      await rm(tempFile, { force: true })
      return
    } catch (error) {
      lastError = error
      if (!isRetryableArchiveWriteError(error) || attempt >= archiveWriteRetryDelays.length) break
      await delay(archiveWriteRetryDelays[attempt])
    }
  }

  throw lastError
}

function makeArchiveBackupName(operation = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const action = String(operation.action || 'archive-db-write')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'archive-db-write'
  return `archive-db.${timestamp}.${action}.json`
}

async function backupArchiveDb(operation = {}) {
  if (readBooleanEnv(process.env.ARCHIVE_BACKUP_DISABLED)) return ''
  if (!existsSync(dataFile)) return ''

  await mkdir(archiveBackupDir, { recursive: true })
  const backupFile = join(archiveBackupDir, makeArchiveBackupName(operation))
  await copyFile(dataFile, backupFile)
  return backupFile
}

async function appendArchiveOperationLog(operation = {}, db, backupFile = '') {
  const entry = {
    at: new Date().toISOString(),
    action: operation.action || 'archive-db-write',
    actor: operation.actor || '',
    targetId: operation.targetId || '',
    targetTitle: operation.targetTitle || '',
    backupFile,
    dataFile,
    counts: {
      items: Array.isArray(db.items) ? db.items.length : 0,
      drafts: Array.isArray(db.drafts) ? db.drafts.length : 0,
      assets: Array.isArray(db.assets) ? db.assets.length : 0,
      bookSources: Array.isArray(db.bookSources) ? db.bookSources.length : 0,
      bookPages: Array.isArray(db.bookPages) ? db.bookPages.length : 0,
    },
  }

  await mkdir(dirname(archiveOperationLogFile), { recursive: true })
  await appendFile(archiveOperationLogFile, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function writeDb(db, operation = {}) {
  await mkdir(dirname(dataFile), { recursive: true })
  const backupFile = await backupArchiveDb(operation)
  const tempFile = `${dataFile}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
  try {
    await replaceArchiveFile(tempFile, dataFile)
    await appendArchiveOperationLog(operation, db, backupFile)
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {})
    throw error
  }
}

const archiveEventClients = new Set()
let archiveEventVersion = 0

function broadcastArchiveChange(reason) {
  archiveEventVersion += 1
  const payload = JSON.stringify({ type: 'archive-change', reason, version: archiveEventVersion, at: new Date().toISOString() })
  for (const client of archiveEventClients) {
    client.write(`event: archive-change\ndata: ${payload}\n\n`)
  }
}

function handleArchiveEvents(request, response) {
  if (request.method !== 'GET') {
    send(response, 405, { error: '接口只支持 GET' })
    return
  }

  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

let sharpLoader
function loadSharp() {
  if (!sharpLoader) {
    sharpLoader = import('sharp').then((module) => module.default ?? module)
  }
  return sharpLoader
}

function getSvnThumbWidth(url) {
  const parsed = Number(url.searchParams.get('w') ?? 128)
  return Number.isFinite(parsed) ? Math.max(64, Math.min(360, Math.round(parsed))) : 128
}

function supportsSvnThumbnail(filePath) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(getMimeType(filePath))
}

function getSvnThumbCachePath(filePath, fileStat, width) {
  const cacheKey = createHash('sha1')
    .update(filePath)
    .update(String(fileStat.mtimeMs))
    .update(String(fileStat.size))
    .update(String(width))
    .digest('hex')
  return join(svnThumbCacheDir, `${cacheKey}.webp`)
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeOcrText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : ''
}

function normalizeTagName(value) {
  return normalizeString(value).replace(/\s+/g, ' ')
}

function uniqueTagValues(values) {
  const tags = []
  const seen = new Set()

  values.forEach((value) => {
    const tag = normalizeTagName(value)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) return
    seen.add(key)
    tags.push(tag)
  })

  return tags
}

function splitTagText(value) {
  if (Array.isArray(value)) return uniqueTagValues(value.flatMap((entry) => splitTagText(entry)))
  const text = normalizeTagName(value)
  if (!text) return []
  return uniqueTagValues(text.split(/[、，,;；|｜\r\n\t]+/))
}

function replaceTagList(value, oldTag, newTag) {
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

function normalizeTagAliasMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const aliases = {}
  Object.entries(value).forEach(([key, aliasValue]) => {
    const tag = normalizeTagName(key)
    if (!tag) return
    const normalizedAliases = uniqueTagValues(Array.isArray(aliasValue) ? aliasValue : [aliasValue])
      .filter((alias) => alias.toLowerCase() !== tag.toLowerCase())
    if (normalizedAliases.length) aliases[tag] = normalizedAliases
  })

  return aliases
}

function mergeTagAliasMap(currentAliases, oldTag, newTag) {
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

function updateDisabledTagList(currentTags, tagName, disabled) {
  const tag = normalizeTagName(tagName)
  const tagKey = tag.toLowerCase()
  const nextTags = splitTagText(currentTags).filter((entry) => entry.toLowerCase() !== tagKey)
  if (disabled && tag) nextTags.push(tag)
  return uniqueTagValues(nextTags)
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function migrateArchiveItemTag(record, oldTag, newTag, now, updatedBy) {
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

function migrateArchiveAssetTag(record, oldTag, newTag, now, updatedBy) {
  const result = replaceTagList(record.tags, oldTag, newTag)
  if (!result.changed) return false

  record.tags = result.tags
  record.updatedAt = now
  record.tagUpdatedAt = now
  record.tagUpdatedBy = updatedBy
  return true
}

function clipForSummaryModel(value, maxLength = 1800) {
  const text = normalizeString(value).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.floor(maxLength * 0.72))}\n...\n${text.slice(-Math.floor(maxLength * 0.28))}`
}

function getArchiveModelEnv(name, fallback = '', aliases = []) {
  const localEnv = readLocalEnvFiles(aiModelConfigFiles)
  const names = [name, ...aliases]
  for (const key of names) {
    const value = normalizeString(process.env[key]) || normalizeString(localEnv[key])
    if (value) return value
  }
  return fallback
}

function isPlaceholderModelValue(value) {
  const text = normalizeString(value).toLowerCase()
  return (
    !text ||
    text.includes('api.example.com') ||
    text.includes('your-model-name') ||
    text.includes('your-api-key') ||
    text === 'your-model-name' ||
    text === 'your-api-key'
  )
}

function getArchiveModelDiagnostics() {
  const endpoint = getArchiveModelEnv('ARCHIVE_SUMMARY_MODEL_URL', '', ['ARCHIVE_AI_MODEL_URL', 'ARCHIVE_MODEL_URL'])
  const baseUrl = getArchiveModelEnv('ARCHIVE_SUMMARY_MODEL_BASE_URL', getArchiveModelEnv('OPENAI_BASE_URL', ''), [
    'ARCHIVE_AI_MODEL_BASE_URL',
    'ARCHIVE_MODEL_BASE_URL',
  ])
  const model = getArchiveModelEnv('ARCHIVE_SUMMARY_MODEL_NAME', getArchiveModelEnv('OPENAI_MODEL', ''), [
    'ARCHIVE_AI_MODEL_NAME',
    'ARCHIVE_MODEL_NAME',
  ])
  const apiKey = getArchiveModelEnv('ARCHIVE_SUMMARY_MODEL_API_KEY', getArchiveModelEnv('OPENAI_API_KEY', ''), [
    'ARCHIVE_AI_MODEL_API_KEY',
    'ARCHIVE_MODEL_API_KEY',
  ])
  const timeoutMs = Number(getArchiveModelEnv('ARCHIVE_SUMMARY_MODEL_TIMEOUT_MS', '45000', [
    'ARCHIVE_AI_MODEL_TIMEOUT_MS',
    'ARCHIVE_MODEL_TIMEOUT_MS',
  ]))
  const missing = []

  if (isPlaceholderModelValue(endpoint) && isPlaceholderModelValue(baseUrl)) missing.push('ARCHIVE_AI_MODEL_BASE_URL')
  if (isPlaceholderModelValue(model)) missing.push('ARCHIVE_AI_MODEL_NAME')

  return {
    endpoint,
    baseUrl,
    model,
    hasApiKey: Boolean(apiKey) && !isPlaceholderModelValue(apiKey),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45000,
    configFiles: aiModelConfigFiles.filter((filePath) => existsSync(filePath)),
    candidateConfigFiles: aiModelConfigFiles,
    missing,
  }
}

function getSummaryModelConfig() {
  const diagnostics = getArchiveModelDiagnostics()
  const endpoint = isPlaceholderModelValue(diagnostics.endpoint) ? '' : diagnostics.endpoint
  const baseUrl = isPlaceholderModelValue(diagnostics.baseUrl) ? '' : diagnostics.baseUrl
  const model = isPlaceholderModelValue(diagnostics.model) ? '' : diagnostics.model
  const apiKey = getArchiveModelEnv('ARCHIVE_SUMMARY_MODEL_API_KEY', getArchiveModelEnv('OPENAI_API_KEY', ''), [
    'ARCHIVE_AI_MODEL_API_KEY',
    'ARCHIVE_MODEL_API_KEY',
  ])

  if (!endpoint && !baseUrl) {
    const error = new Error('未配置摘要/分类模型接口，请设置 ARCHIVE_AI_MODEL_BASE_URL、ARCHIVE_SUMMARY_MODEL_BASE_URL 或对应 MODEL_URL')
    error.status = 503
    error.code = 'ARCHIVE_AI_NOT_CONFIGURED'
    error.diagnostics = diagnostics
    throw error
  }

  if (!model) {
    const error = new Error('未配置摘要/分类模型名称，请设置 ARCHIVE_AI_MODEL_NAME 或 ARCHIVE_SUMMARY_MODEL_NAME')
    error.status = 503
    error.code = 'ARCHIVE_AI_NOT_CONFIGURED'
    error.diagnostics = diagnostics
    throw error
  }

  return {
    endpoint: endpoint || `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    model,
    apiKey: isPlaceholderModelValue(apiKey) ? '' : apiKey,
    timeoutMs: diagnostics.timeoutMs,
    diagnostics,
  }
}

function getArchiveAiStatus() {
  try {
    const config = getSummaryModelConfig()
    const diagnostics = config.diagnostics ?? getArchiveModelDiagnostics()
    return {
      configured: true,
      model: config.model,
      provider: config.endpoint.replace(/\/chat\/completions\/?$/, ''),
      timeoutMs: config.timeoutMs,
      hasApiKey: diagnostics.hasApiKey,
      configFiles: diagnostics.configFiles,
      candidateConfigFiles: diagnostics.candidateConfigFiles,
      missing: [],
      message: '摘要与分类模型已配置',
    }
  } catch (error) {
    const diagnostics = error?.diagnostics ?? getArchiveModelDiagnostics()
    return {
      configured: false,
      model: '',
      provider: '',
      timeoutMs: 0,
      hasApiKey: diagnostics.hasApiKey,
      configFiles: diagnostics.configFiles,
      candidateConfigFiles: diagnostics.candidateConfigFiles,
      missing: diagnostics.missing,
      message: error instanceof Error ? error.message : '摘要与分类模型未配置',
    }
  }
}

function buildSummaryPrompt(payload) {
  const sections = [
    ['标题', payload.title],
    ['正文', payload.note],
    ['网页读取字段', payload.webFields],
    ['图片 OCR 文字', payload.imageOcrText],
    ['分类信息', payload.categoryInfo],
    ['图片信息', payload.imageInfo],
  ]
    .map(([label, value]) => {
      const text = clipForSummaryModel(value)
      return text ? `【${label}】\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  return [
    '你是“三国美术资料库”的资料编目助手。',
    '请根据输入资料生成一句中文简介，要求：',
    '1. 100 字以内，必须是中文，单句即可。',
    '2. 优先概括资料本体、图像内容、形制线索、考据或设计参考价值。',
    '3. 不要输出来源链接、URL、使用限制、版权说明、字段名、OCR 标题或“网页读取资料”等过程性文字。',
    '4. 不要编造输入中没有的年代、馆藏、材质或身份信息；不确定时可写“可作为……参考”。',
    '5. 只返回 JSON：{"summary":"..."}，不要返回 Markdown。',
    '',
    sections || '【资料】\n暂无有效内容',
  ].join('\n')
}

function cleanSummaryModelText(value) {
  let text = normalizeString(value)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.summary === 'string') text = parsed.summary
  } catch {
    const match = text.match(/"summary"\s*:\s*"([^"]+)"/)
    if (match) text = match[1]
  }

  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^(简介|摘要|summary)\s*[：:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

function parseModelJsonObject(value) {
  const text = normalizeString(value)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

function buildClassificationPrompt(payload) {
  const options = payload.options && typeof payload.options === 'object' ? payload.options : {}
  const optionText = Object.entries(options)
    .map(([field, values]) => {
      const list = Array.isArray(values) ? values.map(normalizeString).filter(Boolean).slice(0, 80) : []
      return list.length ? `${field}: ${list.join(' / ')}` : ''
    })
    .filter(Boolean)
    .join('\n')
  const sections = [
    ['标题', payload.title],
    ['正文', payload.note],
    ['补充内容', payload.extraNote],
    ['网页读取字段', payload.webFields],
    ['图片文字与说明', payload.imageInfo],
    ['当前分类', payload.currentCategories],
  ]
    .map(([label, value]) => {
      const text = clipForSummaryModel(value)
      return text ? `【${label}】\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')

  return [
    '你是“三国美术资料库”的资料分类助手。',
    '请根据输入资料选择最匹配的分类，只能从候选项里取值；无法判断就返回空字符串，不要编造新分类。',
    '物品类型需要优先判断资料本体：建筑模型、楼阁、城池等应归为“建筑空间”；盘、碗、炉、陶器等归为“器物工艺”；画像、壁画、图像资料归为“壁画图像”；衣袍冠帽甲胄归入对应服饰或甲胄冠帽。',
    '只返回 JSON，不要返回 Markdown。格式：{"type":"","categories":{"时代":"","服装类别":"","器物类别":"","图像类别":"","建筑类别":"","纹样类别":"","来源类型":"","参考性质":"","使用用途":"","标签":""}}',
    '',
    '【候选项】',
    optionText || '无候选项',
    '',
    sections || '【资料】\n暂无有效内容',
  ].join('\n')
}

function cleanClassificationModelResult(value, options = {}) {
  const parsed = parseModelJsonObject(value)
  if (!parsed || typeof parsed !== 'object') return { type: '', categories: {} }
  const categories = parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {}
  const optionMap = options && typeof options === 'object' ? options : {}
  const pickAllowed = (field, candidate) => {
    const value = normalizeString(candidate)
    if (!value) return ''
    const allowed = Array.isArray(optionMap[field]) ? optionMap[field].map(normalizeString).filter(Boolean) : []
    return allowed.includes(value) ? value : ''
  }
  const type = pickAllowed('物品类型', parsed.type)
  const cleanedCategories = Object.fromEntries(
    Object.keys(optionMap)
      .filter((field) => field !== '物品类型')
      .map((field) => [field, pickAllowed(field, categories[field])])
      .filter(([, value]) => Boolean(value)),
  )
  return { type, categories: cleanedCategories }
}

async function callArchiveModel(prompt, maxTokens = 260) {
  const config = getSummaryModelConfig()
  const headers = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  const modelResponse = await fetch(config.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: '你是严格的中文资料编目助手，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  const modelPayload = await modelResponse.json().catch(() => null)
  if (!modelResponse.ok) {
    const message =
      normalizeString(modelPayload?.error?.message) ||
      normalizeString(modelPayload?.message) ||
      `模型返回 ${modelResponse.status}`
    const error = new Error(message)
    error.status = modelResponse.status >= 400 && modelResponse.status < 600 ? modelResponse.status : 502
    throw error
  }
  return {
    content: normalizeString(modelPayload?.choices?.[0]?.message?.content),
    config,
  }
}

function getTextLanguageStats(value) {
  const text = normalizeString(value)
  return {
    latin: (text.match(/[A-Za-z]/g) ?? []).length,
    cjk: (text.match(/[\u3400-\u9fff]/g) ?? []).length,
  }
}

function hasMostlyLatinText(value) {
  const { latin, cjk } = getTextLanguageStats(value)
  return latin >= 24 && latin > Math.max(24, cjk * 1.2)
}

function isUsableAiWebClipTranslation(translation) {
  if (!translation || typeof translation !== 'object') return false
  const title = normalizeString(translation.title)
  const summary = normalizeString(translation.summary)
  const fields = Array.isArray(translation.fields) ? translation.fields : []
  const combined = [
    title,
    summary,
    ...fields.map((field) => `${normalizeString(field?.label)} ${normalizeString(field?.value)}`),
  ].filter(Boolean).join('\n')
  const { cjk } = getTextLanguageStats(combined)
  return cjk > 0 && !hasMostlyLatinText(summary || combined)
}

function shouldTranslateWebClipWithModel(clip) {
  if (!clip || clip.status === 'failed') return false
  if (isUsableAiWebClipTranslation(clip.translationZh) && normalizeString(clip.translationZh.generatedBy).startsWith('archive-ai-translation-model')) return false
  const text = [
    clip.pageTitle,
    clip.summary,
    clip.pageDescription,
    clip.extractedText,
    ...(Array.isArray(clip.extractedFields) ? clip.extractedFields.flatMap((field) => [field?.label, field?.value]) : []),
    clip.translationZh?.summary,
    ...(Array.isArray(clip.translationZh?.fields) ? clip.translationZh.fields.map((field) => field?.value) : []),
  ].filter(Boolean).join('\n')
  return hasMostlyLatinText(text)
}

function buildWebClipTranslationPrompt(clip) {
  const fields = Array.isArray(clip.extractedFields)
    ? clip.extractedFields
      .map((field) => ({
        label: normalizeString(field?.label),
        value: clipForSummaryModel(field?.value, 700),
      }))
      .filter((field) => field.label || field.value)
      .slice(0, 16)
    : []

  const payload = {
    title: normalizeString(clip.pageTitle || clip.itemDraft?.title),
    summary: clipForSummaryModel(clip.summary || clip.pageDescription || clip.itemDraft?.summary, 1600),
    fields,
    extractedText: clipForSummaryModel(clip.extractedText, 2200),
    sourceUrl: normalizeString(clip.normalizedUrl || clip.inputUrl),
  }

  return [
    '你是“三国美术资料库”的网页采集翻译助手。',
    '请把以下网页采集资料完整翻译为中文，尤其要翻译 summary、description、object type、materials、culture、date、dimensions 等字段。',
    '要求：',
    '1. 输出必须是简体中文；不要大面积保留英文原句。',
    '2. 博物馆名、专有名词、藏品编号、年代编号可以保留原文或中英混排。',
    '3. 不要编造原文没有的信息；无法确定的内容直接忠实翻译。',
    '4. summary 控制在 160 字以内，适合作为资料简介。',
    '5. fields 需要逐项翻译 label 和 value；不要输出来源链接字段。',
    '6. 只返回 JSON，不要 Markdown。',
    'JSON 格式：{"title":"","summary":"","fields":[{"label":"","value":""}],"extractedText":""}',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

function cleanWebClipTranslationModelResult(content, clip, modelName) {
  const parsed = parseModelJsonObject(content)
  if (!parsed || typeof parsed !== 'object') return null
  const fields = Array.isArray(parsed.fields)
    ? parsed.fields
      .map((field) => ({
        label: normalizeString(field?.label),
        value: normalizeString(field?.value),
      }))
      .filter((field) => field.label || field.value)
      .filter((field) => !/来源链接|source url|url/i.test(field.label))
      .slice(0, 16)
    : []
  const title = normalizeString(parsed.title)
  const summary = normalizeString(parsed.summary)
  const extractedText = normalizeString(parsed.extractedText) || [title, summary, ...fields.map((field) => `${field.label}: ${field.value}`)].filter(Boolean).join('\n')

  const translation = {
    language: 'zh-CN',
    title,
    summary,
    fields,
    extractedText,
    generatedBy: `archive-ai-translation-model:${modelName}`,
  }

  return isUsableAiWebClipTranslation(translation) ? translation : null
}

async function enhanceWebClipTranslation(clip, clipFile = '') {
  if (!shouldTranslateWebClipWithModel(clip)) return clip

  try {
    const { content, config } = await callArchiveModel(buildWebClipTranslationPrompt(clip), 1100)
    const translationZh = cleanWebClipTranslationModelResult(content, clip, config.model)
    if (!translationZh) throw new Error('翻译模型没有返回有效中文译文')

    const nextClip = {
      ...clip,
      translationZh,
      itemDraft: {
        ...(clip.itemDraft ?? {}),
        title: translationZh.title || clip.itemDraft?.title || clip.pageTitle || clip.normalizedUrl || clip.inputUrl,
        summary: translationZh.summary || clip.itemDraft?.summary || clip.summary || clip.pageDescription || '',
      },
    }

    if (clipFile) {
      await writeFile(clipFile, `${JSON.stringify(nextClip, null, 2)}\n`, 'utf8')
    }

    return nextClip
  } catch (error) {
    console.warn(`[archive-api] web clip translation skipped: ${error instanceof Error ? error.message : String(error)}`)
    return clip
  }
}

async function handleArchiveSummaryPost(request, response) {
  const payload = await readJsonBody(request)
  const hasInput = ['title', 'note', 'webFields', 'imageOcrText', 'categoryInfo', 'imageInfo']
    .some((key) => normalizeString(payload[key]))
  if (!hasInput) {
    send(response, 400, { error: '请先填写标题、正文、网页字段、图片 OCR 或分类信息' })
    return
  }

  const { content, config } = await callArchiveModel(buildSummaryPrompt(payload), 180)
  const summary = cleanSummaryModelText(content)
  if (!summary) {
    const error = new Error('摘要模型没有返回有效简介')
    error.status = 502
    throw error
  }

  send(response, 200, {
    summary,
    model: config.model,
    provider: config.endpoint,
  })
}

async function handleArchiveClassificationPost(request, response) {
  const payload = await readJsonBody(request)
  const hasInput = ['title', 'note', 'extraNote', 'webFields', 'imageInfo', 'currentCategories']
    .some((key) => normalizeString(payload[key]))
  if (!hasInput) {
    send(response, 400, { error: '请先填写标题、正文、图片或分类信息' })
    return
  }

  const { content, config } = await callArchiveModel(buildClassificationPrompt(payload), 320)
  const result = cleanClassificationModelResult(content, payload.options)
  if (!result.type && !Object.keys(result.categories).length) {
    const error = new Error('分类模型没有返回有效分类')
    error.status = 502
    throw error
  }

  send(response, 200, {
    ...result,
    model: config.model,
    provider: config.endpoint,
  })
}

function normalizeOptionalNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsedValue = Number(value)
    return Number.isFinite(parsedValue) ? parsedValue : undefined
  }
  return undefined
}

function normalizeSettingsStringList(value) {
  return Array.isArray(value) ? value.map(normalizeString).filter(Boolean) : []
}

function normalizeCategoryGroupConfig(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const optionOverrides = {}

  if (record.optionOverrides && typeof record.optionOverrides === 'object' && !Array.isArray(record.optionOverrides)) {
    Object.entries(record.optionOverrides).forEach(([key, overrideValue]) => {
      if (!overrideValue || typeof overrideValue !== 'object' || Array.isArray(overrideValue)) return
      const label = normalizeString(overrideValue.label)
      const disabled = overrideValue.disabled === true
      if (label || disabled) optionOverrides[key] = { ...(label ? { label } : {}), ...(disabled ? { disabled } : {}) }
    })
  }

  return {
    customOptions: normalizeSettingsStringList(record.customOptions),
    optionOverrides,
    optionOrder: normalizeSettingsStringList(record.optionOrder),
  }
}

function normalizeCategoryConfig(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const groups = {}

  if (record.groups && typeof record.groups === 'object' && !Array.isArray(record.groups)) {
    Object.entries(record.groups).forEach(([key, groupValue]) => {
      groups[key] = normalizeCategoryGroupConfig(groupValue)
    })
  }

  return {
    selectedGroupKey: normalizeString(record.selectedGroupKey) || undefined,
    groups,
  }
}

function normalizeOptionalSettingsNumber(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(max, Math.max(min, parsed))
}

function normalizeHomeFeaturedCards(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .slice(0, 6)
    .map((entry, index) => ({
      id: normalizeString(entry.id) || `featured-${index + 1}`,
      itemId: normalizeString(entry.itemId),
      assetId: normalizeString(entry.assetId),
      title: normalizeString(entry.title),
      description: normalizeString(entry.description),
      countLabel: normalizeString(entry.countLabel),
    }))
    .filter((entry, index, entries) => entry.itemId && entries.findIndex((candidate) => candidate.id === entry.id) === index)
}

function normalizeSettings(settings) {
  const record = settings && typeof settings === 'object' ? settings : {}
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
    .map((entry, index) => ({
      id: normalizeString(entry.id) || `hero-${index + 1}`,
      itemId: normalizeString(entry.itemId) || defaultHomeHeroItems[index % defaultHomeHeroItems.length].itemId,
      modelUrl: normalizeString(entry.modelUrl),
      modelScale: normalizeOptionalSettingsNumber(entry.modelScale, 0.35, 3),
    }))
    .filter((entry, index, entries) => entry.itemId && entries.findIndex((candidate) => candidate.id === entry.id) === index)
  const normalizedHomeHeroItems = homeHeroItems.length ? homeHeroItems : [...defaultHomeHeroItems]
  const homeHeroDetailId = normalizedHomeHeroItems[0]?.itemId || legacyHomeHeroDetailId
  const hiddenLiteratureIds = Array.isArray(record.hiddenLiteratureIds)
    ? Array.from(new Set(record.hiddenLiteratureIds.map(normalizeString).filter(Boolean)))
    : []
  const literatureFavoriteIds = Array.isArray(record.literatureFavoriteIds)
    ? Array.from(new Set(record.literatureFavoriteIds.map(normalizeString).filter(Boolean)))
    : []
  const featuredLiteratureIds = Array.isArray(record.featuredLiteratureIds)
    ? Array.from(new Set(record.featuredLiteratureIds.map(normalizeString).filter(Boolean)))
    : []
  const literatureTypeOptions = Array.isArray(record.literatureTypeOptions)
    ? Array.from(new Set(record.literatureTypeOptions.map(normalizeString).filter(Boolean)))
    : splitTagText(record.literatureTypeOptions)
  const literatureFilterTags = Array.isArray(record.literatureFilterTags)
    ? Array.from(new Set(record.literatureFilterTags.map(normalizeString).filter(Boolean)))
    : splitTagText(record.literatureFilterTags)
  return {
    homeHeroDetailId,
    homeHeroItems: normalizedHomeHeroItems,
    homeFeaturedCards: normalizeHomeFeaturedCards(record.homeFeaturedCards),
    hiddenLiteratureIds,
    literatureFavoriteIds,
    featuredLiteratureIds,
    literatureTypeOptions,
    literatureFilterTags,
    tagAliases: normalizeTagAliasMap(record.tagAliases ?? record.tagAliasMap),
    disabledTags: splitTagText(record.disabledTags ?? record.disabledTagNames),
    categoryConfig: normalizeCategoryConfig(record.categoryConfig),
    updatedAt: normalizeString(record.updatedAt),
  }
}

function readSettingsPatch(payload) {
  const rawSettings = payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'settings')
    ? payload.settings
    : payload
  return rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings) ? rawSettings : {}
}

function normalizeImportKey(key) {
  return normalizeString(key).toLowerCase().replace(/[\s_-]+/g, '')
}

function splitImportList(value) {
  if (Array.isArray(value)) return value.map(normalizeString).filter(Boolean)
  return normalizeString(value)
    .split(/[,\n，、|;；]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseImportScalar(value) {
  const text = normalizeString(value)
  if (!text) return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim()
  }
  return text
}

function parseMarkdownFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) return { meta: {}, body: text.trim() }

  const endIndex = text.indexOf('\n---', 4)
  if (endIndex < 0) return { meta: {}, body: text.trim() }

  const frontmatter = text.slice(4, endIndex).trim()
  const body = text.slice(endIndex + 4).trim()
  const meta = {}
  let currentKey = ''

  for (const line of frontmatter.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue

    const listMatch = line.match(/^\s*-\s*(.+)$/)
    if (listMatch && currentKey) {
      meta[currentKey] = [...splitImportList(meta[currentKey]), parseImportScalar(listMatch[1])]
      continue
    }

    const match = line.match(/^([^:]+):\s*(.*)$/)
    if (!match) continue
    currentKey = match[1].trim()
    const rawValue = match[2].trim()
    meta[currentKey] = rawValue.startsWith('[') && rawValue.endsWith(']')
      ? rawValue.slice(1, -1).split(',').map(parseImportScalar).filter(Boolean)
      : parseImportScalar(rawValue)
  }

  return { meta, body }
}

function readImportMeta(meta, aliases, fallback = '') {
  const aliasSet = new Set(aliases.map(normalizeImportKey))
  for (const [key, value] of Object.entries(meta)) {
    if (aliasSet.has(normalizeImportKey(key))) return value
  }
  return fallback
}

function readImportText(meta, aliases, fallback = '') {
  return normalizeString(readImportMeta(meta, aliases, fallback))
}

function readImportList(meta, aliases, fallback = []) {
  const value = readImportMeta(meta, aliases, '')
  const list = splitImportList(value)
  return list.length ? list : fallback
}

function markdownTitle(body, filePath) {
  const heading = body.split('\n').map((line) => line.trim()).find((line) => line.startsWith('# '))
  return heading ? heading.replace(/^#+\s*/, '').trim() : basename(filePath, extname(filePath))
}

function markdownSummary(body) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !/^#+\s*/.test(entry) && !/^!\[/.test(entry) && !/^```/.test(entry) && !/^\s*- /.test(entry))
  return paragraphs[0] ?? ''
}

function markdownBodyWithoutTitle(body) {
  return body.replace(/^# .*(?:\n+|$)/, '').trim()
}

function slugifyImportId(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || getArchiveSourceHash(value)
}

function parseImportNumber(value) {
  const text = normalizeString(value)
  if (!text) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeImportStatus(value) {
  const status = normalizeString(value)
  return ['draft', 'active', 'hidden', 'deleted'].includes(status) ? status : 'active'
}

async function walkImportMarkdownFiles(root) {
  const files = []
  async function walk(directory) {
    let entries = []
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && ['.md', '.markdown'].includes(extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }
  }
  await walk(root)
  return files
}

function isImportMarkdownFileName(fileName) {
  return ['.md', '.markdown'].includes(extname(fileName).toLowerCase())
}

function isImportImageFile(filePath) {
  return imageExtensions.has(extname(filePath).toLowerCase())
}

async function listDirectImportImages(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .filter(isImportImageFile)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN', { numeric: true }))
}

async function walkImportImageDirectories(root, markdownDirectories) {
  const directories = []

  async function walk(directory) {
    let entries = []
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return
    }

    const hasMarkdown = entries.some((entry) => entry.isFile() && isImportMarkdownFileName(entry.name))
    const imageCount = entries.filter((entry) => entry.isFile() && isImportImageFile(entry.name)).length
    if (directory !== root && imageCount > 0 && !hasMarkdown && !markdownDirectories.has(directory)) {
      directories.push(directory)
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.isDirectory()) await walk(join(directory, entry.name))
    }
  }

  await walk(root)
  return directories
}

async function findImportImages(markdownPath, meta) {
  const directory = dirname(markdownPath)
  const explicitImages = readImportList(meta, ['images', 'image', '图片', '图片文件'])
  const imagePaths = []

  for (const image of explicitImages) {
    const resolved = resolve(directory, image)
    if (resolved.startsWith(`${directory}${sep}`) || resolved === directory) {
      try {
        const imageStat = await stat(resolved)
        if (imageStat.isFile() && imageExtensions.has(extname(resolved).toLowerCase())) imagePaths.push(resolved)
      } catch {
        // Missing explicit images are ignored so one bad line does not block the batch.
      }
    }
  }

  if (imagePaths.length) return Array.from(new Set(imagePaths))

  const stem = basename(markdownPath, extname(markdownPath)).toLowerCase()
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .filter((filePath) => {
      const extension = extname(filePath).toLowerCase()
      if (!imageExtensions.has(extension)) return false
      const name = basename(filePath, extension).toLowerCase()
      return name === stem || name.startsWith(`${stem}_`) || name.startsWith(`${stem}-`)
    })
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN', { numeric: true }))
}

function getImportFileUrl(filePath) {
  if (svnRoot && (filePath === svnRoot || filePath.startsWith(`${svnRoot}${sep}`))) {
    return `/api/svn/file?path=${encodeURIComponent(toSvnPath(filePath))}`
  }

  if (filePath === markdownImportRoot || filePath.startsWith(`${markdownImportRoot}${sep}`)) {
    return `/api/archive/import-file?path=${encodeURIComponent(relative(markdownImportRoot, filePath).replace(/\\/g, '/'))}`
  }

  return ''
}

async function handleMarkdownImportFile(url, response) {
  const inputPath = url.searchParams.get('path') ?? ''
  const normalized = inputPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const targetPath = resolve(markdownImportRoot, normalized)
  const extension = extname(targetPath).toLowerCase()

  if (targetPath !== markdownImportRoot && !targetPath.startsWith(`${markdownImportRoot}${sep}`)) {
    sendText(response, 400, 'Import file path is out of range')
    return
  }

  if (!imageExtensions.has(extension)) {
    sendText(response, 415, 'Only imported image files can be served')
    return
  }

  try {
    const fileStat = await stat(targetPath)
    if (!fileStat.isFile()) {
      sendText(response, 404, 'Import file does not exist')
      return
    }

    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': getMimeType(targetPath),
      'Cache-Control': 'public, max-age=3600',
    })
    createReadStream(targetPath).pipe(response)
  } catch {
    sendText(response, 404, 'Import file does not exist')
  }
}

async function makeImportedCardFromMarkdown(markdownPath) {
  const raw = await readFile(markdownPath, 'utf8')
  const { meta, body } = parseMarkdownFrontmatter(raw)
  const fileStem = basename(markdownPath, extname(markdownPath))
  const explicitId = readImportText(meta, ['id', '编号'])
  const id = `md-${slugifyImportId(explicitId || relative(markdownImportRoot, markdownPath))}`
  const title = readImportText(meta, ['title', '标题', 'name', '名称'], markdownTitle(body, markdownPath))
  const summary = readImportText(meta, ['summary', '摘要', 'description', '描述'], markdownSummary(body))
  const note = readImportText(meta, ['note', '说明', '备注'], markdownBodyWithoutTitle(body) || summary)
  const sourceUrl = normalizeSourceUrl(readImportText(meta, ['sourceUrl', 'source', '来源链接', 'url']))
  const now = new Date().toISOString()
  const updatedAt = normalizeString((await stat(markdownPath)).mtime.toISOString()) || now
  const imagePaths = await findImportImages(markdownPath, meta)
  const tags = readImportList(meta, ['tags', 'tag', '标签'], ['Markdown导入'])
  const sourceTypes = readImportList(meta, ['sourceType', 'sourceTypes', '来源类型'], ['本地批量整理'])
  const referencePurposes = readImportList(meta, ['referencePurpose', 'referencePurposes', '参考性质'], ['资料整理'])
  const usageHints = readImportList(meta, ['usageHint', 'usageHints', '使用用途'], ['造型参考'])
  const itemType = readImportText(meta, ['type', 'itemType', '物品类型', '类型'], '待分类资料')
  const itemCategory = readImportList(meta, ['category', 'categories', '服装类别', '物品类别'], [itemType])
  const assetIds = imagePaths.map((imagePath, index) => `${id}-img-${String(index + 1).padStart(2, '0')}`)
  const markdownSvnPath = svnRoot && markdownPath.startsWith(`${svnRoot}${sep}`) ? toSvnPath(markdownPath) : markdownPath

  return {
    item: {
      id,
      mode: 'markdown-import',
      sourceItemId: id,
      type: itemType,
      title,
      summary,
      note,
      extraNote: readImportText(meta, ['extraNote', '补充说明']),
      categories: {
        '时代': readImportText(meta, ['period', '时代'], '未分期'),
        '身份类型': readImportList(meta, ['identityTypes', '身份类型'], ['待分类']).join('、'),
        '职官类型': readImportList(meta, ['officialTypes', '职官类型'], ['未分类']).join('、'),
        '服装类别': itemCategory.join('、'),
        '物品类型': itemType,
        '物品类别': itemCategory.join('、'),
        '来源类型': sourceTypes.join('、'),
        '参考性质': referencePurposes.join('、'),
        '使用用途': usageHints.join('、'),
        '标签': tags.join('、'),
      },
      assetIds,
      sourceRefs: [],
      sourceUrl,
      timelineEnabled: readImportText(meta, ['timelineEnabled', '时间线']) === 'true',
      timelineLabel: readImportText(meta, ['timelineLabel', '时间线标签']),
      startYear: parseImportNumber(readImportText(meta, ['startYear', '开始年份'])),
      endYear: parseImportNumber(readImportText(meta, ['endYear', '结束年份'])),
      timelineWeight: parseImportNumber(readImportText(meta, ['timelineWeight', '时间线权重'])),
      createdBy: readImportText(meta, ['createdBy', '整理人'], 'Markdown批量导入'),
      status: normalizeImportStatus(readImportText(meta, ['status', '状态'], 'active')),
      importSourcePath: markdownSvnPath,
      savedAt: updatedAt,
      updatedAt,
      createdAt: updatedAt,
    },
    assets: imagePaths.map((imagePath, index) => {
      const svnPath = svnRoot && imagePath.startsWith(`${svnRoot}${sep}`) ? toSvnPath(imagePath) : imagePath
      return {
        id: assetIds[index],
        caption: readImportList(meta, ['captions', 'caption', '图片说明'])[index] || `${title} ${index + 1}`,
        imageType: readImportText(meta, ['imageType', '图片类型'], '本地整理图片'),
        sourceType: sourceTypes[0] ?? '本地批量整理',
        referencePurpose: referencePurposes[0] ?? '资料整理',
        tags,
        svnPath,
        tile: index % 8,
        linkedItemId: id,
        imageUrl: getImportFileUrl(imagePath),
        thumbnailUrl: getImportFileUrl(imagePath),
        sourceUrl,
        sourcePageUrl: sourceUrl,
        fileName: basename(imagePath),
        archiveStatus: 'archived',
        downloadStatus: 'downloaded',
      }
    }),
    manifest: {
      id,
      title,
      markdownPath: markdownSvnPath,
      imageCount: imagePaths.length,
      fileStem,
    },
  }
}

async function makeImportedCardFromImageDirectory(directory) {
  const imagePaths = await listDirectImportImages(directory)
  const title = basename(directory)
  const id = `md-dir-${slugifyImportId(relative(markdownImportRoot, directory))}`
  const now = new Date().toISOString()
  const updatedAt = normalizeString((await stat(directory)).mtime.toISOString()) || now
  const sourcePath = svnRoot && directory.startsWith(`${svnRoot}${sep}`) ? toSvnPath(directory) : directory
  const sourceTypes = ['本地批量整理']
  const referencePurposes = ['资料整理']
  const usageHints = ['图录参考']
  const tags = [title, '图录导入']
  const itemType = '文献图录'
  const itemCategory = ['器物图录']
  const assetIds = imagePaths.map((imagePath, index) => `${id}-img-${String(index + 1).padStart(2, '0')}`)

  return {
    item: {
      id,
      mode: 'markdown-import',
      sourceItemId: id,
      type: itemType,
      title,
      summary: `${title}，共 ${imagePaths.length} 页本地图录图片。`,
      note: `由本地文件夹自动导入：${relative(markdownImportRoot, directory).replace(/\\/g, '/')}`,
      extraNote: '',
      categories: {
        '时代': '未分期',
        '身份类型': '待分类',
        '职官类型': '未分类',
        '服装类别': itemCategory.join('、'),
        '物品类型': itemType,
        '物品类别': itemCategory.join('、'),
        '来源类型': sourceTypes.join('、'),
        '参考性质': referencePurposes.join('、'),
        '使用用途': usageHints.join('、'),
        '标签': tags.join('、'),
      },
      assetIds,
      sourceRefs: [],
      sourceUrl: '',
      timelineEnabled: false,
      timelineLabel: '',
      createdBy: '图片文件夹自动导入',
      status: 'active',
      importSourcePath: sourcePath,
      savedAt: updatedAt,
      updatedAt,
      createdAt: updatedAt,
    },
    assets: imagePaths.map((imagePath, index) => {
      const svnPath = svnRoot && imagePath.startsWith(`${svnRoot}${sep}`) ? toSvnPath(imagePath) : imagePath
      return {
        id: assetIds[index],
        caption: `${title} ${index + 1}`,
        imageType: '图录页',
        sourceType: sourceTypes[0],
        referencePurpose: referencePurposes[0],
        tags,
        svnPath,
        tile: index % 8,
        linkedItemId: id,
        imageUrl: getImportFileUrl(imagePath),
        thumbnailUrl: getImportFileUrl(imagePath),
        sourceUrl: '',
        sourcePageUrl: '',
        fileName: basename(imagePath),
        archiveStatus: 'archived',
        downloadStatus: 'downloaded',
      }
    }),
    manifest: {
      id,
      title,
      sourcePath,
      imageCount: imagePaths.length,
      fileStem: title,
      kind: 'image-directory',
    },
  }
}

function isImportedMarkdownItem(item) {
  return normalizeString(item?.mode) === 'markdown-import' || normalizeString(item?.id).startsWith('md-')
}

async function syncMarkdownImports(db) {
  const markdownFiles = await walkImportMarkdownFiles(markdownImportRoot)
  const markdownDirectories = new Set(markdownFiles.map((filePath) => dirname(filePath)))
  const importedCards = []
  for (const filePath of markdownFiles) {
    importedCards.push(await makeImportedCardFromMarkdown(filePath))
  }

  const imageDirectories = await walkImportImageDirectories(markdownImportRoot, markdownDirectories)
  for (const directory of imageDirectories) {
    importedCards.push(await makeImportedCardFromImageDirectory(directory))
  }

  const existingItems = Array.isArray(db.items) ? db.items : []
  const existingAssets = Array.isArray(db.assets) ? db.assets : []
  const deletedIdentityKeys = new Set()

  existingItems.forEach((item) => {
    if (!item || typeof item !== 'object' || item.status !== 'deleted') return
    const relatedAssets = existingAssets.filter((asset) => asset?.linkedItemId === item.id)
    getEntryIdentityKeys(item, relatedAssets).forEach((key) => deletedIdentityKeys.add(key))
  })

  const activeImportedCards = importedCards.filter((card) => {
    const keys = getEntryIdentityKeys(card.item, card.assets)
    return !keys.some((key) => deletedIdentityKeys.has(key))
  })
  const importedItemIds = new Set(activeImportedCards.map((card) => card.item.id))
  const importedAssetIds = new Set(activeImportedCards.flatMap((card) => card.assets.map((asset) => asset.id)))
  activeImportedCards.forEach((card) => {
    const existingItem = existingItems.find((item) => item?.id === card.item.id)
    assertImportedItemCanReplace(existingItem, card.item)
  })

  db.items = [
    ...activeImportedCards.map((card) => card.item),
    ...existingItems.filter((item) => !importedItemIds.has(item?.id) && (!isImportedMarkdownItem(item) || item?.status === 'deleted')),
  ]
  db.assets = [
    ...activeImportedCards.flatMap((card) => card.assets),
    ...existingAssets.filter((asset) => !importedAssetIds.has(asset?.id) && !importedItemIds.has(asset?.linkedItemId)),
  ]
  const svnAddResult = await svnAddFiles([
    ...markdownFiles.filter((filePath) => svnRoot && filePath.startsWith(`${svnRoot}${sep}`)),
    ...activeImportedCards
      .flatMap((card) => card.assets.map((asset) => asset.svnPath))
      .filter((pathValue) => normalizeString(pathValue).startsWith('/'))
      .map((svnPath) => resolveSvnPath(svnPath)),
  ])
  db.imports = {
    ...(db.imports && typeof db.imports === 'object' ? db.imports : {}),
    markdown: {
      root: markdownImportRoot,
      syncedAt: new Date().toISOString(),
      count: activeImportedCards.length,
      skippedDeleted: importedCards.length - activeImportedCards.length,
      svnAdd: svnAddResult,
      items: activeImportedCards.map((card) => card.manifest),
    },
  }

  return db.imports.markdown
}

async function syncMarkdownImportsToDb() {
  let result = { root: markdownImportRoot, syncedAt: new Date().toISOString(), count: 0, items: [] }
  await updateDb(async (db) => {
    result = await syncMarkdownImports(db)
  }, {
    action: 'markdown-imports-sync',
    actor: '系统同步',
    targetId: markdownImportRoot,
  })
  return result
}

async function getMarkdownImportState() {
  const db = await readDb()
  const current = db.imports?.markdown && typeof db.imports.markdown === 'object'
    ? db.imports.markdown
    : { root: markdownImportRoot, syncedAt: '', count: 0, items: [] }
  return { ...current, root: markdownImportRoot }
}

function normalizeSourceUrl(value) {
  const text = normalizeString(value)
  if (!text) return ''

  try {
    const url = new URL(text)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    url.hash = ''
    const britishMuseumObjectId = hostname.endsWith('britishmuseum.org')
      ? url.pathname.match(/\/collection\/object\/([^/?#]+)/i)?.[1]
      : ''
    if (britishMuseumObjectId) return `britishmuseum:object:${britishMuseumObjectId.toLowerCase()}`
    const xiaohongshuObjectId = hostname.endsWith('xiaohongshu.com')
      ? url.pathname.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/i)?.[1]
      : ''
    if (xiaohongshuObjectId) return `xiaohongshu:note:${xiaohongshuObjectId.toLowerCase()}`
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

function normalizeIdentityPath(value) {
  return normalizeString(value)
    .replace(/\\/g, '/')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
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

function getEntryImportSourceKey(entry) {
  const importPath = normalizeIdentityPath(entry?.importSourcePath)
  if (importPath) return `import:${importPath}`
  const mode = normalizeString(entry?.mode)
  const id = normalizeString(entry?.id)
  if ((mode === 'markdown-import' || id.startsWith('md-')) && id) return `import-id:${id.toLowerCase()}`
  return ''
}

function normalizeEntryTitleKey(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[|\uFF5C].*$/, '')
    .replace(/[;\uFF1B]/g, ';')
    .replace(/[\s_-]+/g, ' ')
    .trim()
}

function getEntryIdentityKeys(entry, relatedAssets = []) {
  const sourceUrl = getEntrySourceUrl(entry, relatedAssets)
  const importSourceKey = getEntryImportSourceKey(entry)
  return [sourceUrl ? `source:${sourceUrl}` : '', importSourceKey].filter(Boolean)
}

function getDbIdentityIndex(db, assetIdMap = new Map()) {
  const index = new Map()
  const items = Array.isArray(db.items) ? db.items : []
  const dbAssets = Array.isArray(db.assets) ? db.assets : []

  items.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const relatedAssets = dbAssets.filter((asset) => asset?.linkedItemId === item.id)
    getEntryMergedIdentityKeys(item, relatedAssets, assetIdMap).forEach((key) => {
      if (!index.has(key)) index.set(key, item)
    })
  })

  return index
}

function findDuplicateItem(db, entry, payload) {
  const payloadAssets = Array.isArray(payload.assets) ? payload.assets : []
  const mergedAssetResult = mergeAssetsWithVisualKeys(db.assets, payloadAssets)
  const keys = getEntryMergedIdentityKeys(entry, payloadAssets, mergedAssetResult.idMap)
  if (!keys.length) return null

  const identityIndex = getDbIdentityIndex(db, mergedAssetResult.idMap)
  const duplicate = keys
    .map((key) => identityIndex.get(key))
    .find((item) => item && item.id !== entry.id)

  if (!duplicate) return null

  return {
    id: duplicate.id,
    title: duplicate.title,
    sourceUrl: getEntrySourceUrl(duplicate),
    reason: '来源链接相同',
    createdAt: duplicate.createdAt ?? duplicate.savedAt ?? duplicate.updatedAt ?? '',
    status: duplicate.status ?? 'active',
    createdBy: duplicate.createdBy ?? '未知',
  }
}

async function updateDb(mutator, operation = {}) {
  const runUpdate = dbUpdateQueue.then(async () => {
    assertArchiveWriteAllowed()
    const db = await readDb()
    const result = await mutator(db)
    normalizeArchiveDb(db)
    await writeDb(db, operation)
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

function isLikelyImagePath(value = '') {
  return /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i.test(normalizeString(value).replace(/\\/g, '/').split(/[?#]/)[0])
}

function normalizeVisualSourceUrl(value) {
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

function getAssetVisualKeys(asset) {
  const values = [
    normalizeString(asset.contentHash) ? `hash:${normalizeString(asset.contentHash).toLowerCase().replace(/^sha256:/, '')}` : '',
    normalizeString(asset.visualKey),
    ...[asset.originalUrl, asset.sourceUrl]
      .filter((value) => isLikelyImagePath(value))
      .map(normalizeVisualSourceUrl),
    ...[asset.imageUrl, asset.thumbnailUrl, asset.svnPath].map(normalizeVisualSourceUrl),
  ].filter(Boolean)
  return Array.from(new Set(values))
}

async function hashFileContent(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

function getAssetRepresentativeScore(asset) {
  const caption = normalizeString(asset.caption)
  const sourceUrl = `${normalizeString(asset.originalUrl)} ${normalizeString(asset.sourceUrl)}`.toLowerCase()
  const mainImageScore = caption === '网页主图' ? 1_000_000 : caption.includes('主图') ? 500_000 : 0
  const qualityScore = /(mid|large|original|full)_/.test(sourceUrl) ? 10_000 : 0
  return mainImageScore + qualityScore + (Number(asset.fileSize) || 0)
}

function mergeAssetsWithVisualKeys(existingAssets, nextAssets) {
  const merged = new Map()
  const indexByVisualKey = new Map()
  const idMap = new Map()

  const addAsset = (asset, preferNext = false) => {
    const keys = getAssetVisualKeys(asset)
    const existingId = keys.map((key) => indexByVisualKey.get(key)).find(Boolean)
    if (!existingId) {
      merged.set(asset.id, asset)
      keys.forEach((key) => indexByVisualKey.set(key, asset.id))
      idMap.set(asset.id, asset.id)
      return asset.id
    }

    const existing = merged.get(existingId)
    const shouldReplace = preferNext || getAssetRepresentativeScore(asset) > getAssetRepresentativeScore(existing)
    const keptAsset = shouldReplace
      ? { ...existing, ...asset, id: existing.id, linkedItemId: asset.linkedItemId || existing.linkedItemId }
      : existing
    merged.set(existingId, keptAsset)
    keys.forEach((key) => indexByVisualKey.set(key, existingId))
    idMap.set(asset.id, existingId)
    return existingId
  }

  ;(Array.isArray(existingAssets) ? existingAssets : []).filter(isAssetRecord).forEach((asset) => {
    addAsset(asset)
  })
  ;(Array.isArray(nextAssets) ? nextAssets : []).filter(isAssetRecord).forEach((asset) => {
    addAsset(asset, merged.has(asset.id))
  })

  return { assets: Array.from(merged.values()), idMap }
}

function uniqueStringList(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeString).filter(Boolean)))
}

function remapItemAssetIds(item, idMap) {
  return uniqueStringList([...(Array.isArray(item.assetIds) ? item.assetIds : []), ...(Array.isArray(item.imageIds) ? item.imageIds : [])])
    .map((assetId) => idMap.get(assetId) ?? assetId)
    .filter(Boolean)
}

function getEntryMergedIdentityKeys(entry, relatedAssets, assetIdMap) {
  return uniqueStringList(getEntryIdentityKeys(entry, relatedAssets))
}

function getItemStatusRank(item) {
  if (item?.status === 'deleted') return 4
  if (item?.status === 'hidden') return 3
  if (item?.status === 'active') return 2
  if (item?.status === 'draft') return 1
  return 0
}

function getItemTimestamp(item, fields) {
  return Math.max(
    ...fields.map((field) => Date.parse(normalizeString(item?.[field]))).filter((time) => Number.isFinite(time)),
    0,
  )
}

function getItemCompletenessScore(item) {
  const assetCount = uniqueStringList([...(Array.isArray(item?.assetIds) ? item.assetIds : []), ...(Array.isArray(item?.imageIds) ? item.imageIds : [])]).length
  return (
    assetCount * 1000 +
    normalizeString(item?.title).length * 10 +
    normalizeString(item?.summary).length +
    normalizeString(item?.note).length +
    normalizeString(item?.extraNote).length
  )
}

function chooseItemRepresentative(left, right) {
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

function mergeItemRecords(left, right, idMap) {
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

function mergeItemsByIdentity(items, assetsForIdentity, assetIdMap) {
  const merged = []
  const indexByIdentity = new Map()
  const itemIdMap = new Map()

  ;(Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== 'object') return
    const relatedAssets = (Array.isArray(assetsForIdentity) ? assetsForIdentity : []).filter((asset) => asset?.linkedItemId === item.id)
    const nextItem = {
      ...item,
      assetIds: remapItemAssetIds(item, assetIdMap),
      imageIds: remapItemAssetIds(item, assetIdMap),
    }
    const identityKeys = getEntryMergedIdentityKeys(nextItem, relatedAssets, assetIdMap)
    const existingIndex = identityKeys.map((key) => indexByIdentity.get(key)).find((index) => index !== undefined)

    if (existingIndex === undefined || !identityKeys.length) {
      const nextIndex = merged.length
      merged.push(nextItem)
      itemIdMap.set(item.id, nextItem.id)
      identityKeys.forEach((key) => indexByIdentity.set(key, nextIndex))
      return
    }

    const currentItem = merged[existingIndex]
    const mergedItem = mergeItemRecords(currentItem, nextItem, assetIdMap)
    merged[existingIndex] = mergedItem
    itemIdMap.set(currentItem.id, mergedItem.id)
    itemIdMap.set(item.id, mergedItem.id)
    identityKeys.forEach((key) => indexByIdentity.set(key, existingIndex))
    getEntryMergedIdentityKeys(mergedItem, relatedAssets, assetIdMap).forEach((key) => indexByIdentity.set(key, existingIndex))
  })

  return { items: merged, itemIdMap }
}

function normalizeArchiveDb(db) {
  const existingAssets = Array.isArray(db.assets) ? db.assets : []
  const mergedAssetResult = mergeAssetsWithVisualKeys(existingAssets, [])
  const mergedItemResult = mergeItemsByIdentity(db.items, existingAssets, mergedAssetResult.idMap)
  const validItemIds = new Set(mergedItemResult.items.map((item) => item.id))

  db.items = mergedItemResult.items.map((item) => {
    const assetIds = remapItemAssetIds(item, mergedAssetResult.idMap)
    return { ...item, assetIds, imageIds: assetIds }
  })
  const activeAssetIdsByItemId = new Map(
    db.items.map((item) => [item.id, new Set(uniqueStringList([...(Array.isArray(item.assetIds) ? item.assetIds : []), ...(Array.isArray(item.imageIds) ? item.imageIds : [])]))]),
  )
  db.assets = mergedAssetResult.assets
    .map((asset) => {
      const linkedItemId = mergedItemResult.itemIdMap.get(asset.linkedItemId) ?? asset.linkedItemId
      return linkedItemId === asset.linkedItemId ? asset : { ...asset, linkedItemId }
    })
    .filter((asset) => {
      if (!asset.linkedItemId || asset.linkedItemId === 'svn-import') return true
      if (!validItemIds.has(asset.linkedItemId)) return false
      const activeAssetIds = activeAssetIdsByItemId.get(asset.linkedItemId)
      return !activeAssetIds?.size || activeAssetIds.has(asset.id)
    })

  return db
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

function normalizeBookSourceRecord(value) {
  if (!isBookSourceRecord(value)) return null
  return { ...value }
}

function normalizeBookPageRecords(sourceId, pages) {
  return (Array.isArray(pages) ? pages : [])
    .filter(isBookPageRecord)
    .map((page, index) => ({
      ...page,
      bookSourceId: sourceId,
      pageNumber: normalizeString(page.pageNumber) || String(index + 1).padStart(3, '0'),
      keywords: Array.isArray(page.keywords) ? page.keywords : [],
      linkedArchiveItemIds: Array.isArray(page.linkedArchiveItemIds) ? page.linkedArchiveItemIds : [],
    }))
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
    svnCommand: await checkSvnCommand(),
    workingCopy: false,
    warnings: [],
  }

  if (!root) return state

  try {
    const rootStat = await stat(root)
    state.valid = rootStat.isDirectory()
    if (!state.valid) state.error = 'SVN 根目录不是文件夹'
    state.workingCopy = existsSync(join(root, '.svn'))
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'SVN 根目录不可访问'
  }

  if (state.valid && !state.workingCopy) {
    state.warnings.push('当前路径可访问，但未检测到 .svn 工作副本标记；请确认它是 SVN checkout 根目录。')
  }
  if (!state.svnCommand.available) {
    state.warnings.push(`未找到 SVN 命令（${state.svnCommand.command}）；只能浏览本地文件和重建索引，不能执行 svn update/add。`)
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

async function findExistingSvnOpenTarget(targetPath) {
  const root = ensureSvnRoot()
  let currentPath = targetPath

  while (currentPath === root || currentPath.startsWith(`${root}${sep}`)) {
    try {
      const targetStat = await stat(currentPath)
      return { path: currentPath, stat: targetStat, exact: currentPath === targetPath }
    } catch {
      const parentPath = dirname(currentPath)
      if (parentPath === currentPath) break
      currentPath = parentPath
    }
  }

  const rootStat = await stat(root)
  return { path: root, stat: rootStat, exact: false }
}

function toSvnPath(filePath) {
  return `/${relative(ensureSvnRoot(), filePath).replace(/\\/g, '/')}`
}

function getSvnPathFromApiFileUrl(value = '') {
  const text = normalizeString(value)
  if (!text) return ''
  if (!text.includes('/api/svn/file') && !text.includes('/api/svn/thumb')) return text

  try {
    const url = new URL(text, 'http://localhost')
    return normalizeString(url.searchParams.get('path') ?? '')
  } catch {
    return ''
  }
}

function resolveLiteraturePageImagePath(page) {
  const svnPath = normalizeString(page?.svnPath) || getSvnPathFromApiFileUrl(page?.imagePath)
  if (!svnPath) {
    const error = new Error('当前页面没有可 OCR 的 SVN 图片路径')
    error.status = 400
    throw error
  }
  return { svnPath, filePath: resolveSvnPath(svnPath) }
}

function resolveLiteraturePageOcrPath(source, page, imageFilePath, pageCount = 0) {
  const pageOcrSvnPath = normalizeString(page?.ocrTextPath)
  if (pageOcrSvnPath) return resolveSvnPath(pageOcrSvnPath)

  const sourceOcrSvnPath = normalizeString(source?.ocrTextPath)
  if (sourceOcrSvnPath) {
    const sourceOcrPath = resolveSvnPath(sourceOcrSvnPath)
    if (extname(sourceOcrPath).toLowerCase() === '.txt' && pageCount <= 1) return sourceOcrPath
    const ocrDirectory = extname(sourceOcrPath) ? dirname(sourceOcrPath) : sourceOcrPath
    return join(ocrDirectory, `${basename(imageFilePath, extname(imageFilePath))}.txt`)
  }

  return join(dirname(imageFilePath), 'OCR', `${basename(imageFilePath, extname(imageFilePath))}.txt`)
}

function hashLiteratureId(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function normalizeSvnIdentityPath(value = '') {
  return normalizeString(value).replace(/\\/g, '/').replace(/^\/+/, '/').replace(/\/+$/, '').toLowerCase()
}

function getLiteratureRoot() {
  const configuredRoot = process.env.ARCHIVE_LITERATURE_ROOT?.trim()
  if (configuredRoot) return resolve(configuredRoot)
  return join(ensureSvnRoot(), literatureSvnFolderName)
}

function getLiteratureSourceTypeFromTitle(title) {
  if (/论文|研究|考述|综述/.test(title)) return '论文研究'
  if (/图录|图册|画册|目录/.test(title)) return '展览图录'
  if (/三国志|后汉书|汉书|史记|资治通鉴|会要|通典|志|书|传/.test(title)) return '史料典籍'
  return '现代书籍'
}

function getLiteratureTitleMetadata(title) {
  return {
    sourceType: getLiteratureSourceTypeFromTitle(title),
    dynasty: /秦汉|秦|汉/.test(title) ? '秦汉' : /三国|魏|蜀|吴/.test(title) ? '三国' : '',
  }
}

async function readLiteratureFolderMetadata(folderName, folderPath) {
  try {
    const entries = await readdir(folderPath, { withFileTypes: true })
    const markdownFiles = entries
      .filter((entry) => entry.isFile() && isImportMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }))
    if (!markdownFiles.length) return { title: folderName, imageNames: [], tags: [] }

    const preferredMarkdown = markdownFiles.find((fileName) => basename(fileName, extname(fileName)) === folderName) ?? markdownFiles[0]
    const markdownPath = join(folderPath, preferredMarkdown)
    const raw = await readFile(markdownPath, 'utf8')
    const { meta, body } = parseMarkdownFrontmatter(raw)

    return {
      markdownPath: toSvnPath(markdownPath),
      meta,
      body,
      title: readImportText(meta, ['title', '标题', 'name', '名称'], markdownTitle(body, markdownPath) || folderName),
      summary: readImportText(meta, ['summary', '摘要', 'description', '描述'], markdownSummary(body)),
      noteBody: markdownBodyWithoutTitle(body),
      subtitle: readImportText(meta, ['subtitle', '副标题'], ''),
      author: readImportText(meta, ['author', '作者', 'editor', '编者'], ''),
      publisher: readImportText(meta, ['publisher', '出版社', 'source', '来源'], ''),
      dynasty: readImportText(meta, ['dynasty', '朝代', '年代'], ''),
      sourceType: readImportText(meta, ['source_type', 'sourceType', '文献类型', '类型'], ''),
      language: readImportText(meta, ['language', '语言'], ''),
      fileFormat: readImportText(meta, ['file_format', 'fileFormat', 'format', '格式'], ''),
      pageCount: readImportText(meta, ['page_count', 'pageCount', '页数'], ''),
      volumeCount: readImportText(meta, ['volume_count', 'volumeCount', '卷数'], ''),
      scanStatus: readImportText(meta, ['scan_status', 'scanStatus'], ''),
      ocrStatus: readImportText(meta, ['ocr_status', 'ocrStatus'], ''),
      sourcePath: readImportText(meta, ['source_path', 'sourcePath', 'svn_path', 'svnPath'], ''),
      archiveCode: readImportText(meta, ['archive_code', 'archiveCode'], ''),
      bookCode: readImportText(meta, ['book_code', 'bookCode'], ''),
      chapterCode: readImportText(meta, ['chapter_code', 'chapterCode'], ''),
      chapterTitle: readImportText(meta, ['chapter_title', 'chapterTitle'], ''),
      assetType: readImportText(meta, ['asset_type', 'assetType'], ''),
      sequenceRange: readImportText(meta, ['sequence_range', 'sequenceRange'], ''),
      cover: readImportText(meta, ['cover', '封面'], ''),
      imageNames: readImportList(meta, ['images', '图片'], []),
      tags: readImportList(meta, ['tags', '标签'], []),
      relatedLiteratureNoteIds: readImportList(meta, ['related_literature', 'relatedLiterature', 'relatedLiteratureNoteIds', '关联文献'], []),
    }
  } catch (error) {
    console.warn('[literature-sync] failed to read markdown metadata:', folderPath, error.message)
    return { title: folderName, imageNames: [], tags: [] }
  }
}

function formatChineseOrdinal(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  if (number <= 10) return number === 10 ? '十' : digits[number]
  if (number < 20) return `十${digits[number % 10]}`
  const tens = Math.floor(number / 10)
  const ones = number % 10
  return `${digits[tens]}十${ones ? digits[ones] : ''}`
}

function getSyncedLiteraturePageInfo(title, fileName, fallbackIndex, literatureMeta = {}) {
  const stem = basename(fileName, extname(fileName)).trim()
  const fallbackTitle = stem || String(fallbackIndex + 1)
  const structuredMatch = stem.match(/^([A-Za-z0-9]+)_CH(\d{2,})_([A-Za-z0-9]+)_(\d{3,})(?:[_-](.+))?$/i)
  const bookCodeCoverMatch = stem.match(/^([A-Za-z0-9]+)_(\d{3,})(?:[_-](.+))?$/i)
  const archivePrefixes = splitImportList(literatureMeta.archiveCode).map((code) => code.toLowerCase())
  const stemKey = stem.toLowerCase()
  const matchedPrefixIndex = archivePrefixes.findIndex((prefix) => stemKey.startsWith(`${prefix}_`))
  const matchesMarkdownPrefix = archivePrefixes.length ? matchedPrefixIndex >= 0 : true
  if (bookCodeCoverMatch && Number(bookCodeCoverMatch[2]) === 0) {
    return {
      chapter: '封面',
      pageNumber: '封面',
      label: normalizeString(bookCodeCoverMatch[3]) || '封面',
      sequence: 0,
    }
  }
  if (structuredMatch && matchesMarkdownPrefix) {
    const chapterCode = Number(structuredMatch[2])
    const sequence = Number(structuredMatch[4])
    const suffix = normalizeString(structuredMatch[5])
    if (sequence === 0 || /封面|cover/i.test(suffix)) {
      return {
        chapter: '封面',
        pageNumber: '封面',
        label: suffix || '封面',
        sequence,
      }
    }
    const displayChapterNumber = matchedPrefixIndex >= 0 ? matchedPrefixIndex + 1 : (chapterCode === 0 ? 1 : chapterCode)
    const pageTitle = `第${formatChineseOrdinal(sequence)}页`
    return {
      chapter: `第${formatChineseOrdinal(displayChapterNumber)}章`,
      pageNumber: String(sequence),
      label: suffix || pageTitle,
      sequence,
    }
  }

  const cleanTitle = title.trim()
  const fallbackLabel = cleanTitle
    ? stem.replace(new RegExp(`^${cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[_\\-\\s]*`), '').trim() || fallbackTitle
    : fallbackTitle
  return {
    chapter: fallbackLabel,
    pageNumber: String(fallbackIndex + 1),
    label: fallbackLabel,
    sequence: fallbackIndex + 1,
  }
}

async function collectLiteratureImageFiles(folderPath, files = []) {
  const entries = await readdir(folderPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.svn') continue
    const fullPath = join(folderPath, entry.name)
    if (entry.isDirectory()) {
      await collectLiteratureImageFiles(fullPath, files)
    } else if (entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase())) {
      const fileStat = await stat(fullPath)
      files.push({ filePath: fullPath, name: entry.name, mtimeMs: fileStat.mtimeMs, size: fileStat.size })
    }
  }
  return files.sort((left, right) => toSvnPath(left.filePath).localeCompare(toSvnPath(right.filePath), 'zh-CN', { numeric: true }))
}

function findExistingLiteratureSourceByPath(sources, svnPath) {
  const targetPath = normalizeSvnIdentityPath(svnPath)
  return sources.find((source) => (
    normalizeSvnIdentityPath(source?.svnOriginalPath) === targetPath ||
    normalizeSvnIdentityPath(source?.scanFolderPath) === targetPath
  ))
}

function buildSyncedLiteratureRecords(folderName, folderPath, existingSource, existingPages, now) {
  return collectLiteratureImageFiles(folderPath).then(async (imageFiles) => {
    if (!imageFiles.length) return null
    const folderSvnPath = toSvnPath(folderPath)
    const literatureMeta = await readLiteratureFolderMetadata(folderName, folderPath)
    const title = literatureMeta.title || folderName
    const markdownSummaryText = literatureMeta.summary || ''
    const sourceId = normalizeString(existingSource?.id) || `lit-svn-${hashLiteratureId(folderSvnPath.toLowerCase())}`
    const bookCodeCoverName = literatureMeta.bookCode ? `${literatureMeta.bookCode}_0000`.toLowerCase() : ''
    const bookCodeCoverFile = bookCodeCoverName
      ? imageFiles.find((file) => basename(file.name, extname(file.name)).toLowerCase() === bookCodeCoverName)
      : undefined
    const coverFile = bookCodeCoverFile ?? imageFiles.find((file) => file.name === literatureMeta.cover) ?? imageFiles[0]
    const coverSvnPath = toSvnPath(coverFile.filePath)
    const existingPageMap = new Map(
      existingPages
        .filter((page) => page.bookSourceId === sourceId)
        .map((page) => [page.id, page]),
    )
    const pages = imageFiles.map((file, index) => {
      const svnPath = toSvnPath(file.filePath)
      const pageId = `lit-page-${hashLiteratureId(svnPath.toLowerCase())}`
      const pageInfo = getSyncedLiteraturePageInfo(title, file.name, index, literatureMeta)
      const existingPage = existingPageMap.get(pageId)
      return {
        ...existingPage,
        id: pageId,
        bookSourceId: sourceId,
        pageNumber: pageInfo.pageNumber,
        chapter: pageInfo.chapter,
        title: pageInfo.label,
        imagePath: `/api/svn/file?path=${encodeURIComponent(svnPath)}`,
        ocrText: existingPage?.ocrText ?? '',
        correctedText: existingPage?.correctedText ?? '',
        keywords: Array.from(new Set([...(Array.isArray(existingPage?.keywords) ? existingPage.keywords : []), folderName, literatureMeta.archiveCode, literatureMeta.bookCode, literatureMeta.chapterCode, file.name, pageInfo.chapter, pageInfo.label].filter(Boolean))),
        linkedArchiveItemIds: Array.isArray(existingPage?.linkedArchiveItemIds) ? existingPage.linkedArchiveItemIds : [],
        svnPath,
        fileName: file.name,
        fileSize: file.size,
        fileMtimeMs: file.mtimeMs,
        importMode: 'svn-literature-sync',
      }
    })

    const source = {
      ...(existingSource ?? {}),
      id: sourceId,
      title,
      subtitle: literatureMeta.subtitle || title,
      author: literatureMeta.author || '',
      publisher: literatureMeta.publisher || '',
      dynasty: literatureMeta.dynasty || '',
      sourceType: literatureMeta.sourceType || '',
      format: literatureMeta.fileFormat || '',
      pageCount: pages.length,
      volumeCount: literatureMeta.volumeCount || existingSource?.volumeCount || '1',
      note: markdownSummaryText,
      tags: Array.from(new Set(literatureMeta.tags.filter(Boolean))),
      coverImagePath: `/api/svn/file?path=${encodeURIComponent(coverSvnPath)}`,
      svnOriginalPath: folderSvnPath,
      scanFolderPath: folderSvnPath,
      sourcePath: literatureMeta.sourcePath,
      markdownPath: literatureMeta.markdownPath,
      markdownSummary: literatureMeta.summary,
      markdownBody: literatureMeta.noteBody,
      archiveCode: literatureMeta.archiveCode,
      bookCode: literatureMeta.bookCode,
      chapterCode: literatureMeta.chapterCode,
      chapterTitle: literatureMeta.chapterTitle,
      assetType: literatureMeta.assetType,
      sequenceRange: literatureMeta.sequenceRange,
      relatedLiteratureNoteIds: literatureMeta.relatedLiteratureNoteIds,
      ocrStatus: literatureMeta.ocrStatus,
      scanStatus: literatureMeta.scanStatus,
      syncStatus: '已同步',
      lastSyncedAt: now,
      updatedBy: 'SVN 自动同步',
      updatedAt: now,
      importMode: 'svn-literature-sync',
    }

    return { source, pages }
  })
}

async function syncLiteratureFolders(db) {
  if (!svnRoot) return { root: '', count: 0, pageCount: 0, skipped: true }
  const root = getLiteratureRoot()
  let rootStat
  try {
    rootStat = await stat(root)
  } catch {
    return { root, count: 0, pageCount: 0, skipped: true }
  }
  if (!rootStat.isDirectory()) return { root, count: 0, pageCount: 0, skipped: true }

  const now = new Date().toISOString()
  const existingSources = Array.isArray(db.bookSources) ? db.bookSources.filter(isBookSourceRecord) : []
  const existingPages = Array.isArray(db.bookPages) ? db.bookPages.filter(isBookPageRecord) : []
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== '.svn')
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))
  const records = []

  for (const entry of entries) {
    const folderPath = join(root, entry.name)
    const folderSvnPath = toSvnPath(folderPath)
    const existingSource = findExistingLiteratureSourceByPath(existingSources, folderSvnPath)
    const record = await buildSyncedLiteratureRecords(entry.name, folderPath, existingSource, existingPages, now)
    if (record) records.push(record)
  }

  const syncedSourceIds = new Set(records.map((record) => record.source.id))
  const syncedPageIds = new Set(records.flatMap((record) => record.pages.map((page) => page.id)))
  db.bookSources = mergeById(
    existingSources.filter((source) => source.importMode !== 'svn-literature-sync' || syncedSourceIds.has(source.id)),
    records.map((record) => record.source),
    isBookSourceRecord,
  )
  db.bookPages = mergeById(
    existingPages.filter((page) => !syncedSourceIds.has(page.bookSourceId) || syncedPageIds.has(page.id)),
    records.flatMap((record) => record.pages),
    isBookPageRecord,
  )
  db.imports = {
    ...(db.imports ?? {}),
    literatureFolders: {
      root,
      syncedAt: now,
      count: records.length,
      pageCount: records.reduce((sum, record) => sum + record.pages.length, 0),
      sources: records.map((record) => ({
        id: record.source.id,
        title: record.source.title,
        path: record.source.scanFolderPath,
        pageCount: record.pages.length,
      })),
    },
  }
  return db.imports.literatureFolders
}

async function syncLiteratureFoldersToDb() {
  let result = { root: '', syncedAt: new Date().toISOString(), count: 0, pageCount: 0 }
  await updateDb(async (db) => {
    result = await syncLiteratureFolders(db)
  })
  return result
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

function getArchiveSourceHash(...values) {
  const source = values.map(normalizeString).filter(Boolean).join('|')
  return createHash('sha1').update(source || String(Date.now())).digest('hex').slice(0, 8)
}

function isRealSvnAsset(asset) {
  return normalizeString(asset?.svnPath).startsWith('/')
}

function isWebClipAsset(asset) {
  if (!asset || typeof asset !== 'object' || isRealSvnAsset(asset)) return false
  const imageUrl = normalizeString(asset.imageUrl)
  const thumbnailUrl = normalizeString(asset.thumbnailUrl)
  const sourceUrl = normalizeString(asset.sourceUrl)
  return imageUrl.includes('/web-clips/') || thumbnailUrl.includes('/web-clips/') || /^https?:\/\//i.test(imageUrl) || /^https?:\/\//i.test(sourceUrl)
}

function resolveLocalWebClipPath(asset) {
  const imageUrl = normalizeString(asset?.imageUrl)
  const rawPath = (() => {
    try {
      return /^https?:\/\//i.test(imageUrl) ? new URL(imageUrl).pathname : imageUrl
    } catch {
      return imageUrl
    }
  })()
  const webClipIndex = rawPath.indexOf('/web-clips/')
  if (webClipIndex < 0) return ''

  const decoded = decodeURIComponent(rawPath.slice(webClipIndex).split(/[?#]/)[0]).replace(/^\/+/, '')
  const relativePath = decoded.replace(/^web-clips[\\/]/, '')
  const sharedTarget = resolve(webClipsRoot, relativePath)
  if (sharedTarget !== webClipsRoot && sharedTarget.startsWith(`${webClipsRoot}${sep}`) && existsSync(sharedTarget)) {
    return sharedTarget
  }

  const target = resolve('public', decoded)
  const publicRoot = resolve('public')
  if (target !== publicRoot && target.startsWith(`${publicRoot}${sep}`)) return target
  return ''
}

function handleWebClipStaticFile(url, response) {
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/web-clips\/?/, ''))
  const targetPath = resolve(webClipsRoot, relativePath)
  if (targetPath === webClipsRoot || !targetPath.startsWith(`${webClipsRoot}${sep}`)) {
    sendText(response, 403, '路径无效')
    return
  }

  const stream = createReadStream(targetPath)
  stream.on('error', () => {
    if (!response.headersSent) sendText(response, 404, '网页采集文件不存在')
  })
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'Content-Type': getMimeType(targetPath),
  })
  stream.pipe(response)
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
  const sourceHash = getArchiveSourceHash(sourcePageUrl, asset.sourceUrl, asset.imageUrl, asset.thumbnailUrl, asset.id)
  const fileName = `${platform}_${titlePart}_${sourceHash}_${yyyy}${mm}${String(now.getDate()).padStart(2, '0')}_${sequence}${extension}`
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
  const contentHash = await hashFileContent(targetPath)
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
    visualKey: getAssetVisualKeys(asset)[0] || normalizeVisualSourceUrl(asset.sourceUrl) || normalizeVisualSourceUrl(asset.imageUrl),
    contentHash,
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
    if (!isWebClipAsset(asset)) {
      archivedAssets.push(asset)
      continue
    }

    if (shouldSkipUnavailableWebClipAsset(asset)) {
      console.warn(`[archive-api] skip unavailable web clip image: ${asset?.caption || asset?.id || index + 1}`)
      continue
    }

    try {
      archivedAssets.push(await archiveWebClipAsset(asset, payload, index))
    } catch (error) {
      if (isWebClipAsset(asset) && !hasLocalWebClipFile(asset)) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[archive-api] skip failed web clip image: ${asset?.caption || asset?.id || index + 1} - ${message}`)
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

function makeSvnFileRecord({ name, svnPath, size, mtimeMs }) {
  const versionParam = Number.isFinite(Number(mtimeMs)) ? `&v=${Math.round(Number(mtimeMs))}` : ''
  const imageUrl = `/api/svn/file?path=${encodeURIComponent(svnPath)}${versionParam}`
  return {
    id: `svn-${Buffer.from(svnPath).toString('base64url')}`,
    name,
    path: svnPath,
    thumbnailUrl: imageUrl,
    previewUrl: imageUrl,
    mtimeMs: Number.isFinite(Number(mtimeMs)) ? Number(mtimeMs) : undefined,
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
        files.push(makeSvnFileRecord({ name: entry.name, svnPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs }))
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
    .map((file) => makeSvnFileRecord({ name: file.name, svnPath: file.path, size: Number(file.size) || 0, mtimeMs: Number(file.mtimeMs) || 0 }))

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
  const refreshIndex = url.searchParams.get('refresh') === '1'
  const folderPath = resolveSvnPath(requestPath)
  const folderStat = await stat(folderPath)

  if (!folderStat.isDirectory()) {
    const error = new Error('SVN 目录不存在')
    error.status = 404
    throw error
  }

  const index = refreshIndex ? await buildSvnIndex() : await readSvnIndex()
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

async function handleSvnFile(url, response) {
  const filePath = resolveSvnPath(url.searchParams.get('path') ?? '')
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    const error = new Error('SVN file does not exist')
    error.status = 404
    throw error
  }
  if (!fileStat.isFile()) {
    const error = new Error('SVN path is not a file')
    error.status = 400
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
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': getMimeType(filePath),
    'Cache-Control': 'public, max-age=300',
  })
  stream.pipe(response)
}

async function handleSvnThumb(url, response) {
  const filePath = resolveSvnPath(url.searchParams.get('path') ?? '')
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    const error = new Error('SVN file does not exist')
    error.status = 404
    throw error
  }
  if (!fileStat.isFile()) {
    const error = new Error('SVN path is not a file')
    error.status = 400
    throw error
  }
  if (!supportsSvnThumbnail(filePath)) {
    await handleSvnFile(url, response)
    return
  }

  const width = getSvnThumbWidth(url)
  const cachePath = getSvnThumbCachePath(filePath, fileStat, width)
  let cacheReady = false
  try {
    const cacheStat = await stat(cachePath)
    cacheReady = cacheStat.isFile()
  } catch {
    cacheReady = false
  }

  if (!cacheReady) {
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      const sharp = await loadSharp()
      await sharp(filePath)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 72, effort: 4 })
        .toFile(cachePath)
    } catch (error) {
      console.error('Failed to generate SVN thumbnail', error)
      await handleSvnFile(url, response)
      return
    }
  }

  const stream = createReadStream(cachePath)
  stream.on('error', (error) => {
    if (!response.headersSent) {
      sendText(response, 500, error instanceof Error ? error.message : 'Failed to read SVN thumbnail')
    } else {
      response.destroy(error instanceof Error ? error : undefined)
    }
  })
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=86400, immutable',
  })
  stream.pipe(response)
}
async function handleSvnOpen(url, response) {
  const svnPath = url.searchParams.get('path') ?? ''
  const targetPath = resolveSvnPath(svnPath)
  const openTarget = await findExistingSvnOpenTarget(targetPath)
  const openPath = openTarget.path

  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args =
    process.platform === 'win32'
      ? [openTarget.stat.isDirectory() ? openPath : `/select,${openPath}`]
      : [openTarget.stat.isDirectory() ? openPath : dirname(openPath)]

  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
  send(response, 200, {
    ok: true,
    path: svnPath,
    openedPath: toSvnPath(openTarget.stat.isDirectory() ? openPath : dirname(openPath)),
    exact: openTarget.exact,
  })
}

function extractSvnRevision(output) {
  const text = String(output || '')
  return text.match(/(?:revision|版本)\s+(\d+)/i)?.[1] ?? ''
}

function summarizeProcessOutput(stdout, stderr) {
  const text = [stderr, stdout].map((entry) => String(entry || '').trim()).filter(Boolean).join('\n\n')
  return text.length > 4000 ? `${text.slice(-4000)}\n...` : text
}

function isMissingSvnCommandError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'ENOENT')
}

async function buildSvnIndexOnlyUpdateResult(root, svnCommand, errorMessage = '') {
  const index = await buildSvnIndex()
  const literatureSync = await syncLiteratureFoldersToDb()
  const message = `未找到 SVN 命令（${svnCommand}）。已刷新本地索引 ${index.files.length} 个文件，但未从远端拉取更新。`
  return {
    ok: true,
    root,
    revision: '',
    svnUpdated: false,
    indexOnly: true,
    indexedFiles: index.files.length,
    literatureSources: literatureSync.count ?? 0,
    literaturePages: literatureSync.pageCount ?? 0,
    indexBuiltAt: index.builtAt,
    stdout: '',
    stderr: errorMessage,
    warning: message,
    message,
    updatedAt: new Date().toISOString(),
  }
}

async function handleSvnUpdate(response) {
  const root = ensureSvnRoot()
  if (svnUpdatePromise) {
    const error = new Error('SVN 更新正在运行，请稍后再试')
    error.status = 409
    throw error
  }

  const svnCommand = getSvnCommand()
  const timeoutMs = Number(process.env.SVN_UPDATE_TIMEOUT_MS ?? 600000)
  svnUpdatePromise = new Promise((resolveRun, rejectRun) => {
    const child = spawn(svnCommand, ['update', root, '--non-interactive', ...getSvnAuthArgs()], {
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
      if (isMissingSvnCommandError(error)) {
        resolveRun({ stdout: '', stderr: '', missingCommand: true, errorMessage: error.message })
        return
      }
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
    .then(async ({ stdout, stderr, missingCommand, errorMessage }) => {
      if (missingCommand) {
        return buildSvnIndexOnlyUpdateResult(root, svnCommand, errorMessage)
      }

      const revision = extractSvnRevision(stdout || stderr)
      const index = await buildSvnIndex()
      const literatureSync = await syncLiteratureFoldersToDb()
      return {
        ok: true,
        root,
        revision,
        svnUpdated: true,
        indexOnly: false,
        indexedFiles: index.files.length,
        literatureSources: literatureSync.count ?? 0,
        literaturePages: literatureSync.pageCount ?? 0,
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

  send(response, 200, await svnUpdatePromise)
}

function svnAddFiles(filePaths) {
  const paths = Array.from(new Set(filePaths.filter(Boolean)))
  if (!paths.length || !svnRoot) return Promise.resolve({ ok: true, skipped: true, count: 0 })

  return new Promise((resolveRun) => {
    const child = spawn(getSvnCommand(), ['add', '--parents', '--force', ...paths, '--non-interactive', ...getSvnAuthArgs()], {
      cwd: svnRoot,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      resolveRun({ ok: false, count: paths.length, error: 'svn add timeout' })
    }, Number(process.env.SVN_ADD_TIMEOUT_MS ?? 120000))

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolveRun({ ok: false, count: paths.length, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolveRun({ ok: true, count: paths.length })
      } else {
        resolveRun({ ok: false, count: paths.length, error: summarizeProcessOutput(stdout, stderr) || `svn add exited ${code}` })
      }
    })
  })
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
    timelineEnabled: payload.timelineEnabled === true,
    timelineLabel: normalizeString(payload.timelineLabel),
    startYear: normalizeOptionalNumber(payload.startYear),
    endYear: normalizeOptionalNumber(payload.endYear),
    timelineWeight: normalizeOptionalNumber(payload.timelineWeight),
    createdBy: normalizeString(payload.createdBy) || 'Web Clipper',
    status: kind === 'items' ? 'active' : 'draft',
    savedAt: now,
    updatedAt: now,
  }
}

function assertExpectedUpdatedAt(expectedUpdatedAt, existingRecord, label) {
  const expected = normalizeString(expectedUpdatedAt)
  if (!expected || !existingRecord) return

  const current = normalizeString(existingRecord.updatedAt) || normalizeString(existingRecord.savedAt)
  if (!current || current === expected) return

  const error = new Error(`${label}已被别人更新，请刷新后再保存。`)
  error.status = 409
  error.conflict = {
    id: existingRecord.id,
    expectedUpdatedAt: expected,
    currentUpdatedAt: current,
  }
  throw error
}

function getRecordUpdatedTime(record) {
  const timestamp = Date.parse(normalizeString(record?.updatedAt) || normalizeString(record?.savedAt) || normalizeString(record?.createdAt))
  return Number.isFinite(timestamp) ? timestamp : 0
}

function assertImportedItemCanReplace(existingRecord, importedRecord) {
  if (!existingRecord || !importedRecord) return
  if (normalizeString(existingRecord.status) === 'deleted') return

  const currentTime = getRecordUpdatedTime(existingRecord)
  const importedTime = getRecordUpdatedTime(importedRecord)
  if (!currentTime || !importedTime || currentTime <= importedTime) return

  const error = new Error('资料已被别人更新，请刷新后再保存。')
  error.status = 409
  error.conflict = {
    id: existingRecord.id,
    expectedUpdatedAt: normalizeString(importedRecord.updatedAt) || normalizeString(importedRecord.savedAt),
    currentUpdatedAt: normalizeString(existingRecord.updatedAt) || normalizeString(existingRecord.savedAt),
  }
  throw error
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
      assertExpectedUpdatedAt(payload.expectedUpdatedAt, list[existingIndex], kind === 'items' ? '资料' : '草稿')
      list[existingIndex] = { ...list[existingIndex], ...entry, createdAt: list[existingIndex].createdAt ?? entry.savedAt }
    } else {
      list.unshift({ ...entry, createdAt: entry.savedAt })
    }

    db[kind] = list

    if (kind === 'items') {
      db.drafts = (Array.isArray(db.drafts) ? db.drafts : []).filter(
        (draft) => draft.sourceItemId !== entry.sourceItemId && draft.title !== entry.title,
      )
      const existingAssets = Array.isArray(db.assets) ? db.assets : []
      const nextAssetIds = new Set(entry.assetIds)
      const nextAssets = Array.isArray(payload.assets) ? payload.assets : []
      const nextAssetIdValues = new Set(nextAssets.map((asset) => asset?.id).filter(Boolean))
      const isEditingExistingItem = Boolean(payload.sourceItemId)
      const keptAssets = isEditingExistingItem
        ? existingAssets.filter((asset) => {
          if (!asset || typeof asset !== 'object') return false
          if (nextAssetIdValues.has(asset.id)) return false
          if (asset.linkedItemId === entry.id) return nextAssetIds.has(asset.id)
          return true
        })
        : existingAssets
      const mergedAssetResult = mergeAssetsWithVisualKeys(keptAssets, nextAssets)
      entry.assetIds = entry.assetIds.map((assetId) => mergedAssetResult.idMap.get(assetId) ?? assetId)
      list[existingIndex >= 0 ? existingIndex : 0] = { ...list[existingIndex >= 0 ? existingIndex : 0], assetIds: entry.assetIds, imageIds: entry.assetIds }
      db.assets = mergedAssetResult.assets
      db.bookSources = mergeById(db.bookSources, payload.bookSources, isBookSourceRecord)
      db.bookPages = mergeById(db.bookPages, payload.bookPages, isBookPageRecord)
    }
  }, {
    action: kind === 'items' ? (payload.mode === 'edit' ? 'archive-item-update' : 'archive-item-save') : 'archive-draft-save',
    actor: normalizeString(payload.createdBy) || normalizeString(entry.createdBy),
    targetId: entry.id,
    targetTitle: entry.title,
  })

  broadcastArchiveChange(kind === 'items' ? 'items-saved' : 'drafts-saved')
  send(response, 200, { id: entry.id, savedAt: entry.savedAt })
}

async function applyArchiveItemStatus(itemId, nextStatus, updatedBy, response, fallbackPayload = {}) {
  const allowedStatuses = new Set(['draft', 'active', 'hidden', 'deleted'])

  if (!allowedStatuses.has(nextStatus)) {
    send(response, 400, { error: '资料状态无效' })
    return
  }

  const result = await updateDb(async (db) => {
    const list = Array.isArray(db.items) ? db.items : []
    let existingIndex = list.findIndex((item) => item.id === itemId)
    const now = new Date().toISOString()

    if (existingIndex < 0 && fallbackPayload.item && typeof fallbackPayload.item === 'object') {
      const snapshot = fallbackPayload.item
      const snapshotAssetIds = uniqueStringList([
        ...(Array.isArray(snapshot.assetIds) ? snapshot.assetIds : []),
        ...(Array.isArray(snapshot.imageIds) ? snapshot.imageIds : []),
      ])
      const nextAssets = (Array.isArray(fallbackPayload.assets) ? fallbackPayload.assets : [])
        .filter(isAssetRecord)
        .map((asset) => ({ ...asset, linkedItemId: itemId }))
      const mergedAssetResult = nextAssets.length
        ? mergeAssetsWithVisualKeys(Array.isArray(db.assets) ? db.assets : [], nextAssets)
        : { assets: Array.isArray(db.assets) ? db.assets : [], idMap: new Map() }
      if (nextAssets.length) db.assets = mergedAssetResult.assets
      const nextAssetIds = uniqueStringList(
        snapshotAssetIds.map((assetId) => mergedAssetResult.idMap.get(assetId) ?? assetId),
      )
      const savedAt = normalizeString(snapshot.savedAt) || normalizeString(snapshot.createdAt) || now

      list.unshift({
        ...snapshot,
        id: itemId,
        sourceItemId: normalizeString(snapshot.sourceItemId) || itemId,
        assetIds: nextAssetIds,
        imageIds: nextAssetIds,
        savedAt,
        createdAt: normalizeString(snapshot.createdAt) || savedAt,
        updatedAt: normalizeString(snapshot.updatedAt) || savedAt,
      })
      existingIndex = 0
    }

    if (existingIndex < 0) {
      const error = new Error('资料不存在')
      error.status = 404
      throw error
    }

    assertExpectedUpdatedAt(fallbackPayload.expectedUpdatedAt, list[existingIndex], '资料')

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
  }, {
    action: `archive-item-status-${nextStatus}`,
    actor: updatedBy,
    targetId: itemId,
  })

  broadcastArchiveChange('item-status')
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
  }, {
    action: 'archive-item-purge',
    actor: '管理员',
    targetId: itemId,
  })

  broadcastArchiveChange('item-purged')
  send(response, 200, result)
}

function findArchiveItemIndexForTimelineUpdate(db, itemId, payload) {
  const items = Array.isArray(db.items) ? db.items : []
  const directIndex = items.findIndex((item) => item?.id === itemId)
  if (directIndex >= 0) return directIndex

  const archiveCode = normalizeString(payload.archiveCode).toLowerCase()
  if (archiveCode) {
    const codeIndex = items.findIndex((item) =>
      [item?.archiveCode, item?.code, item?.uniqueCode, item?.itemCode]
        .map((value) => normalizeString(value).toLowerCase())
        .includes(archiveCode),
    )
    if (codeIndex >= 0) return codeIndex
  }

  const sourceUrl = normalizeSourceUrl(payload.sourceUrl)
  if (sourceUrl) {
    const assets = Array.isArray(db.assets) ? db.assets : []
    const sourceIndex = items.findIndex((item) => {
      const relatedAssets = assets.filter((asset) => asset?.linkedItemId === item?.id)
      return normalizeSourceUrl(getEntrySourceUrl(item, relatedAssets)) === sourceUrl
    })
    if (sourceIndex >= 0) return sourceIndex
  }

  const title = normalizeString(payload.title)
  if (title && !(payload.item && typeof payload.item === 'object')) {
    return items.findIndex((item) => normalizeString(item?.title) === title)
  }

  return -1
}

async function handleArchiveItemTimelinePost(itemId, request, response) {
  const payload = await readJsonBody(request)
  const result = await updateDb(async (db) => {
    const list = Array.isArray(db.items) ? db.items : []
    const existingIndex = findArchiveItemIndexForTimelineUpdate(db, itemId, payload)

    if (existingIndex < 0 && payload.item && typeof payload.item === 'object') {
      list.unshift({
        ...payload.item,
        id: itemId,
        sourceItemId: payload.item.sourceItemId ?? itemId,
      })
    } else if (existingIndex < 0) {
      const error = new Error('资料不存在')
      error.status = 404
      throw error
    }

    const targetIndex = existingIndex >= 0 ? existingIndex : 0
    const snapshot = payload.item && typeof payload.item === 'object' ? payload.item : {}
    const currentItem = list[targetIndex] ?? {}
    const existing = {
      ...currentItem,
      ...snapshot,
      id: currentItem.id ?? itemId,
      sourceItemId: currentItem.sourceItemId ?? snapshot.sourceItemId ?? itemId,
      updatedAt: currentItem.updatedAt ?? snapshot.updatedAt,
    }
    assertExpectedUpdatedAt(payload.expectedUpdatedAt, existing, '资料')

    const now = new Date().toISOString()
    const nextItem = {
      ...existing,
      timelineEnabled: payload.timelineEnabled === true,
      timelineLabel: normalizeString(payload.timelineLabel),
      startYear: normalizeOptionalNumber(payload.startYear),
      endYear: normalizeOptionalNumber(payload.endYear),
      timelineWeight: normalizeOptionalNumber(payload.timelineWeight),
      updatedAt: now,
      statusUpdatedAt: now,
      statusUpdatedBy: normalizeString(payload.updatedBy) || '管理员',
    }

    list[targetIndex] = nextItem
    db.items = list

    return {
      id: nextItem.id,
      timelineEnabled: nextItem.timelineEnabled,
      timelineLabel: nextItem.timelineLabel,
      startYear: nextItem.startYear,
      endYear: nextItem.endYear,
      timelineWeight: nextItem.timelineWeight,
      updatedAt: now,
    }
  }, {
    action: 'archive-item-timeline-update',
    actor: normalizeString(payload.updatedBy) || '管理员',
    targetId: itemId,
    targetTitle: normalizeString(payload.item?.title),
  })

  broadcastArchiveChange('item-timeline')
  send(response, 200, result)
}

async function handleArchiveItemMutation(itemId, action, request, response) {
  if (action === 'purge') {
    await purgeArchiveItem(itemId, response)
    return
  }

  if (action === 'patch') {
    await patchArchiveItemRecord(itemId, request, response)
    return
  }

  const payload = {}
  const nextStatus = action === 'delete' ? 'deleted' : normalizeString(payload.status)
  const updatedBy = normalizeString(payload.updatedBy) || '管理员'
  await applyArchiveItemStatus(itemId, nextStatus, updatedBy, response)
}

async function patchArchiveItemRecord(itemId, request, response) {
  const payload = await readJsonBody(request)
  const result = await updateDb(async (db) => {
    const list = Array.isArray(db.items) ? db.items : []
    let existingIndex = list.findIndex((item) => item?.id === itemId || item?.sourceItemId === itemId)
    const now = new Date().toISOString()
    const snapshot = payload.item && typeof payload.item === 'object' ? payload.item : {}

    if (existingIndex < 0 && snapshot && typeof snapshot === 'object') {
      list.unshift({
        ...snapshot,
        id: itemId,
        sourceItemId: normalizeString(snapshot.sourceItemId) || itemId,
      })
      existingIndex = 0
    }

    if (existingIndex < 0) {
      const error = new Error('资料不存在')
      error.status = 404
      throw error
    }

    const requestedAssetIds = uniqueStringList([
      ...(Array.isArray(payload.assetIds) ? payload.assetIds : []),
      ...(Array.isArray(payload.imageIds) ? payload.imageIds : []),
    ])
    const hasAssetPatch = Array.isArray(payload.assetIds) || Array.isArray(payload.imageIds)
    const unlinkAssetIdSet = new Set(uniqueStringList(Array.isArray(payload.unlinkAssetIds) ? payload.unlinkAssetIds : []))
    const nextAssets = (Array.isArray(payload.assets) ? payload.assets : [])
      .filter(isAssetRecord)
      .map((asset) => ({ ...asset, linkedItemId: itemId }))
    const mergedAssetResult = nextAssets.length
      ? mergeAssetsWithVisualKeys(Array.isArray(db.assets) ? db.assets : [], nextAssets)
      : { assets: Array.isArray(db.assets) ? db.assets : [], idMap: new Map() }
    if (nextAssets.length) db.assets = mergedAssetResult.assets
    if (unlinkAssetIdSet.size) {
      db.assets = (Array.isArray(db.assets) ? db.assets : []).map((asset) => (
        isAssetRecord(asset) && unlinkAssetIdSet.has(asset.id)
          ? { ...asset, linkedItemId: '' }
          : asset
      ))
    }
    const nextAssetIds = uniqueStringList(requestedAssetIds.map((assetId) => mergedAssetResult.idMap.get(assetId) ?? assetId))
    const existing = list[existingIndex]
    assertExpectedUpdatedAt(payload.expectedUpdatedAt, existing, '资料')

    const patchFields = {}
    ;['sourceUrl', 'extraNote', 'summary', 'note'].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(payload, field)) {
        patchFields[field] = normalizeString(payload[field])
      }
    })
    const nextItem = {
      ...snapshot,
      ...existing,
      ...patchFields,
      id: existing.id ?? itemId,
      sourceItemId: existing.sourceItemId ?? snapshot.sourceItemId ?? itemId,
      assetIds: hasAssetPatch ? nextAssetIds : existing.assetIds,
      imageIds: hasAssetPatch ? nextAssetIds : existing.imageIds,
      updatedAt: now,
      statusUpdatedAt: now,
      statusUpdatedBy: normalizeString(payload.updatedBy) || '管理员',
    }

    list[existingIndex] = nextItem
    db.items = list

    return {
      id: nextItem.id,
      assetIds: Array.isArray(nextItem.assetIds) ? nextItem.assetIds : [],
      updatedAt: now,
    }
  }, {
    action: 'archive-item-patch',
    actor: normalizeString(payload.updatedBy) || '管理员',
    targetId: itemId,
    targetTitle: normalizeString(payload.item?.title),
  })

  broadcastArchiveChange('item-patched')
  send(response, 200, result)
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
    payload,
  )
}

async function handleArchiveTagRenamePost(request, response) {
  const payload = await readJsonBody(request)
  const oldTag = normalizeTagName(payload.oldTag)
  const newTag = normalizeTagName(payload.newTag)
  const updatedBy = normalizeString(payload.updatedBy) || '管理员'
  const rawMode = normalizeString(payload.mode)
  const mode = ['rename', 'merge', 'disable', 'enable'].includes(rawMode) ? rawMode : 'rename'

  if (!oldTag || ((mode === 'rename' || mode === 'merge') && !newTag)) {
    send(response, 400, { error: mode === 'disable' || mode === 'enable' ? '标签不能为空' : '原标签和目标标签不能为空' })
    return
  }

  if ((mode === 'rename' || mode === 'merge') && oldTag.toLowerCase() === newTag.toLowerCase()) {
    send(response, 400, { error: '目标标签与原标签相同' })
    return
  }

  const now = new Date().toISOString()
  let result = {
    tag: newTag || oldTag,
    previousTag: oldTag,
    alias: oldTag,
    mode,
    updatedItemCount: 0,
    updatedAssetCount: 0,
  }

  await updateDb(async (db) => {
    const items = Array.isArray(db.items) ? db.items : []
    const assets = Array.isArray(db.assets) ? db.assets : []
    let updatedItemCount = 0
    let updatedAssetCount = 0

    const currentSettings = normalizeSettings(db.settings)
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
    db.settings = normalizeSettings({
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
  send(response, 200, result)
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

  broadcastArchiveChange('feedback-created')
  send(response, 200, feedback)
}

async function handleArchiveFeedbackStatusPost(feedbackId, request, response) {
  const id = normalizeString(feedbackId)
  const payload = await readJsonBody(request)
  const status = normalizeString(payload.status)

  if (!id) {
    send(response, 400, { error: '反馈 ID 不能为空' })
    return
  }

  if (!['open', 'resolved'].includes(status)) {
    send(response, 400, { error: '反馈状态无效' })
    return
  }

  const now = new Date().toISOString()
  let updatedFeedback = null
  await updateDb(async (db) => {
    const feedbacks = Array.isArray(db.feedbacks) ? db.feedbacks : []
    db.feedbacks = feedbacks.map((feedback) => {
      if (feedback?.id !== id) return feedback
      updatedFeedback = {
        ...feedback,
        status,
        handledBy: normalizeString(payload.handledBy),
        handledAt: status === 'resolved' ? now : '',
      }
      return updatedFeedback
    })
  })

  if (!updatedFeedback) {
    send(response, 404, { error: '未找到反馈记录' })
    return
  }

  broadcastArchiveChange('feedback-status-updated')
  send(response, 200, updatedFeedback)
}

async function handleLiteraturePost(request, response) {
  const payload = await readJsonBody(request)
  const source = normalizeBookSourceRecord(payload.source)

  if (!source) {
    send(response, 400, { error: '文献来源信息不完整' })
    return
  }

  const pages = normalizeBookPageRecords(source.id, payload.pages)

  await updateDb(async (db) => {
    const existingSources = Array.isArray(db.bookSources) ? db.bookSources : []
    const existingSource = existingSources.find((entry) => entry?.id === source.id)
    assertExpectedUpdatedAt(payload.expectedUpdatedAt, existingSource, '文献')
    db.bookSources = mergeById(db.bookSources, [source], isBookSourceRecord)
    const existingPages = Array.isArray(db.bookPages) ? db.bookPages : []
    db.bookPages = mergeById(
      existingPages.filter((page) => page?.bookSourceId !== source.id),
      pages,
      isBookPageRecord,
    )
  })

  broadcastArchiveChange('literature-saved')
  send(response, 200, { source, pages })
}

async function handleLiteratureOcrPost(request, response) {
  const payload = await readJsonBody(request)
  const sourceId = normalizeString(payload.sourceId)
  const pageId = normalizeString(payload.pageId)

  if (!sourceId || !pageId) {
    send(response, 400, { error: '文献 ID 和页面 ID 不能为空' })
    return
  }

  let resultPayload = null
  await updateDb(async (db) => {
    const sources = Array.isArray(db.bookSources) ? db.bookSources : []
    const pages = Array.isArray(db.bookPages) ? db.bookPages : []
    const source = sources.find((entry) => entry?.id === sourceId)
    const page = pages.find((entry) => entry?.id === pageId && entry?.bookSourceId === sourceId)

    if (!source) {
      const error = new Error('未找到文献档案')
      error.status = 404
      throw error
    }
    if (!page) {
      const error = new Error('未找到文献页面')
      error.status = 404
      throw error
    }

    const { svnPath: imageSvnPath, filePath: imageFilePath } = resolveLiteraturePageImagePath(page)
    const imageStat = await stat(imageFilePath).catch(() => null)
    if (!imageStat?.isFile()) {
      const error = new Error('当前页面图片文件不存在，无法 OCR')
      error.status = 404
      throw error
    }

    const ocrResult = await runPaddleOcr(imageFilePath)
    if (!ocrResult?.ok) {
      const error = new Error(ocrResult?.error || 'PaddleOCR 识别失败')
      error.status = 503
      throw error
    }

    const text = normalizeString(ocrResult.text)
    const ocrFilePath = resolveLiteraturePageOcrPath(source, page, imageFilePath, pages.filter((entry) => entry?.bookSourceId === sourceId).length)
    await mkdir(dirname(ocrFilePath), { recursive: true })
    await writeFile(ocrFilePath, text ? `${text}\n` : '', 'utf8')
    const ocrTextPath = toSvnPath(ocrFilePath)
    const now = new Date().toISOString()
    const updatedPage = {
      ...page,
      imagePath: page.imagePath || `/api/svn/file?path=${encodeURIComponent(imageSvnPath)}`,
      svnPath: page.svnPath || imageSvnPath,
      ocrText: text,
      correctedText: text,
      ocrTextPath,
      ocrUpdatedAt: now,
    }
    const updatedSource = {
      ...source,
      ocrStatus: text ? '已完成' : '未识别到文本',
      scanStatus: `OCR 已更新：${page.title || page.pageNumber}`,
      ocrTextPath: source.ocrTextPath || toSvnPath(dirname(ocrFilePath)),
      updatedBy: 'PaddleOCR',
      updatedAt: now,
    }

    db.bookSources = mergeById(sources, [updatedSource], isBookSourceRecord)
    db.bookPages = mergeById(pages, [updatedPage], isBookPageRecord)
    resultPayload = {
      source: updatedSource,
      page: updatedPage,
      text,
      ocrTextPath,
      imagePath: imageSvnPath,
      engine: ocrResult.engine || 'paddleocr',
      readingMode: ocrResult.readingMode || 'horizontal',
      lineCount: Number(ocrResult.lineCount) || 0,
      updatedAt: now,
    }
  })

  broadcastArchiveChange('literature-page-ocr-updated')
  send(response, 200, resultPayload)
}

async function handleLiteratureOcrTextPost(request, response) {
  const payload = await readJsonBody(request)
  const sourceId = normalizeString(payload.sourceId)
  const pageId = normalizeString(payload.pageId)
  const text = normalizeOcrText(payload.text)
  const hasText = text.trim().length > 0

  if (!sourceId || !pageId) {
    send(response, 400, { error: '文献 ID 和页面 ID 不能为空' })
    return
  }

  let resultPayload = null
  await updateDb(async (db) => {
    const sources = Array.isArray(db.bookSources) ? db.bookSources : []
    const pages = Array.isArray(db.bookPages) ? db.bookPages : []
    const source = sources.find((entry) => entry?.id === sourceId)
    const page = pages.find((entry) => entry?.id === pageId && entry?.bookSourceId === sourceId)

    if (!source) {
      const error = new Error('未找到文献档案')
      error.status = 404
      throw error
    }
    if (!page) {
      const error = new Error('未找到文献页面')
      error.status = 404
      throw error
    }

    const { svnPath: imageSvnPath, filePath: imageFilePath } = resolveLiteraturePageImagePath(page)
    const ocrFilePath = resolveLiteraturePageOcrPath(source, page, imageFilePath, pages.filter((entry) => entry?.bookSourceId === sourceId).length)
    await mkdir(dirname(ocrFilePath), { recursive: true })
    await writeFile(ocrFilePath, text, 'utf8')

    const now = new Date().toISOString()
    const ocrTextPath = toSvnPath(ocrFilePath)
    const updatedPage = {
      ...page,
      imagePath: page.imagePath || `/api/svn/file?path=${encodeURIComponent(imageSvnPath)}`,
      svnPath: page.svnPath || imageSvnPath,
      ocrText: page.ocrText || text,
      correctedText: text,
      ocrTextPath,
      ocrUpdatedAt: now,
    }
    const updatedSource = {
      ...source,
      ocrStatus: hasText ? '已校对' : source.ocrStatus,
      scanStatus: `OCR 校正文已更新：${page.title || page.pageNumber}`,
      ocrTextPath: source.ocrTextPath || toSvnPath(dirname(ocrFilePath)),
      updatedBy: normalizeString(payload.updatedBy) || 'OCR Editor',
      updatedAt: now,
    }

    db.bookSources = mergeById(sources, [updatedSource], isBookSourceRecord)
    db.bookPages = mergeById(pages, [updatedPage], isBookPageRecord)
    resultPayload = {
      source: updatedSource,
      page: updatedPage,
      text,
      ocrTextPath,
      imagePath: imageSvnPath,
      engine: 'manual-edit',
      readingMode: 'manual',
      lineCount: hasText ? text.split(/\r?\n/).filter((line) => line.trim()).length : 0,
      updatedAt: now,
    }
  })

  broadcastArchiveChange('literature-page-ocr-text-updated')
  send(response, 200, resultPayload)
}

async function handleLiteratureDelete(sourceId, response) {
  const id = normalizeString(sourceId)
  if (!id) {
    send(response, 400, { error: '文献 ID 不能为空' })
    return
  }

  let deleted = false
  let removedPageCount = 0

  await updateDb(async (db) => {
    const sources = Array.isArray(db.bookSources) ? db.bookSources : []
    const pages = Array.isArray(db.bookPages) ? db.bookPages : []
    deleted = sources.some((source) => source?.id === id)
    removedPageCount = pages.filter((page) => page?.bookSourceId === id).length
    db.bookSources = sources.filter((source) => source?.id !== id)
    db.bookPages = pages.filter((page) => page?.bookSourceId !== id)
    db.settings = normalizeSettings({
      ...(db.settings ?? {}),
      hiddenLiteratureIds: [...(normalizeSettings(db.settings).hiddenLiteratureIds ?? []), id],
      updatedAt: new Date().toISOString(),
    })
  })

  broadcastArchiveChange('literature-deleted')
  send(response, 200, { id, deleted, removedPageCount })
}

async function handleArchiveSettingsPost(request, response) {
  const payload = await readJsonBody(request)
  const settingsPatch = readSettingsPatch(payload)
  let savedSettings = normalizeSettings({})

  await updateDb(async (db) => {
    const currentSettings = normalizeSettings(db.settings)
    assertExpectedUpdatedAt(payload.expectedUpdatedAt, currentSettings, '后台配置')
    db.settings = normalizeSettings({ ...currentSettings, ...settingsPatch })
    savedSettings = db.settings
  })

  broadcastArchiveChange('settings-saved')
  send(response, 200, { settings: savedSettings })
}

function countArchiveSnapshot(db) {
  return {
    drafts: Array.isArray(db.drafts) ? db.drafts.length : 0,
    items: Array.isArray(db.items) ? db.items.length : 0,
    assets: Array.isArray(db.assets) ? db.assets.length : 0,
    bookSources: Array.isArray(db.bookSources) ? db.bookSources.length : 0,
    bookPages: Array.isArray(db.bookPages) ? db.bookPages.length : 0,
    feedbacks: Array.isArray(db.feedbacks) ? db.feedbacks.length : 0,
  }
}

async function handleArchiveSnapshotReplacePost(request, response) {
  const payload = await readJsonBody(request)
  const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : null
  if (!snapshot || payload.confirmReplace !== true) {
    send(response, 400, { error: '需要提供 snapshot 并设置 confirmReplace=true' })
    return
  }

  const nextDb = {
    drafts: Array.isArray(snapshot.drafts) ? snapshot.drafts : [],
    items: Array.isArray(snapshot.items) ? snapshot.items : [],
    assets: Array.isArray(snapshot.assets) ? snapshot.assets : [],
    bookSources: Array.isArray(snapshot.bookSources) ? snapshot.bookSources : [],
    bookPages: Array.isArray(snapshot.bookPages) ? snapshot.bookPages : [],
    feedbacks: Array.isArray(snapshot.feedbacks) ? snapshot.feedbacks : [],
    settings: normalizeSettings(snapshot.settings),
    imports: snapshot.imports && typeof snapshot.imports === 'object' ? snapshot.imports : {},
  }

  await writeDb(nextDb, {
    action: 'archive-db-snapshot-replace',
    actor: normalizeString(payload.actor) || 'Codex',
    targetId: normalizeString(payload.source) || 'archive-db.json',
  })

  broadcastArchiveChange('archive-snapshot-replaced')
  send(response, 200, {
    ok: true,
    counts: countArchiveSnapshot(nextDb),
    settings: nextDb.settings,
  })
}

function shouldUseInteractiveClip(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname
    return /xiaohongshu|xhslink/i.test(hostname)
  } catch {
    return false
  }
}

function shouldUseExtendedClipTimeout(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname
    return /(^|\.)britishmuseum\.org$/i.test(hostname)
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
    const extendedClipTimeout = shouldUseExtendedClipTimeout(targetUrl)
    const child = spawn(process.execPath, ['scripts/clip-page.mjs', targetUrl], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        ARCHIVE_WEB_CLIPS_DIR: webClipsRoot,
        ...(interactiveClip ? { CLIP_INTERACTIVE_LOGIN: 'true' } : {}),
      },
      windowsHide: !interactiveClip,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      rejectRun(new Error('网页采集超时'))
    }, interactiveClip || extendedClipTimeout ? 240000 : 90000)

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

function runWebClipCleanup({ apply = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const args = ['scripts/cleanup-web-clips.mjs', apply ? '--apply' : '--dry-run', '--json', '--limit', '12']
    const child = spawn(process.execPath, args, {
      cwd: resolve('.'),
      env: {
        ...process.env,
        ARCHIVE_WEB_CLIPS_DIR: webClipsRoot,
        ARCHIVE_DATA_FILE: dataFile,
        ARCHIVE_SHARED_DATA_ROOT: archiveStorageRoot,
      },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      rejectRun(new Error('网页抓取缓存清理超时'))
    }, 120000)

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
        rejectRun(new Error(summarizeProcessOutput(stdout, stderr) || `cleanup-web-clips exited ${code}`))
        return
      }

      try {
        resolveRun(JSON.parse(stdout))
      } catch {
        rejectRun(new Error('网页抓取缓存清理结果无法解析'))
      }
    })
  })
}

async function handleWebClipCleanup(request, response) {
  if (request.method === 'GET') {
    send(response, 200, await runWebClipCleanup({ apply: false }))
    return
  }

  if (request.method === 'POST') {
    const payload = await readJsonBody(request)
    if (payload?.apply !== true) {
      send(response, 400, { error: '请先预览候选项，再确认 apply=true 后执行清理' })
      return
    }

    send(response, 200, await runWebClipCleanup({ apply: true }))
    return
  }

  send(response, 405, { error: '接口只支持 GET/POST' })
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
      const isDpmClip = /(^|\.)dpm\.org\.cn$/i.test(new URL(clipUrl).hostname) && /\/collection\//i.test(new URL(clipUrl).pathname)
      const hasFailedImageDownloads = clip.extractedImages.some((image) => normalizeString(image?.downloadStatus) === 'failed')
      if (isBritishMuseumClip && hasFailedImageDownloads) return null
      if (isDpmClip) {
        const summaryText = normalizeString(clip.summary || clip.pageDescription || clip.extractedText)
        const hasDpmFields = Array.isArray(clip.extractedFields) && clip.extractedFields.some((field) => ['藏品名称', '馆藏类别', '馆藏编号'].includes(normalizeString(field?.label)))
        const hasOnlyCollectionImages = clip.extractedImages.every((image) => /https?:\/\/img\.dpm\.org\.cn\/Uploads\/Picture\//i.test(normalizeString(image?.sourceUrl)))
        const hasDpmMuseumType = ['博物馆网页', '馆藏资料'].includes(normalizeString(clip.suggestedSourceType)) || ['博物馆网页', '馆藏资料'].includes(normalizeString(clip.sourceDraft?.sourceType))
        if (summaryText.length < 30 || !hasDpmFields || !hasOnlyCollectionImages || !hasDpmMuseumType) return null
      }
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

  const clipFile = resolve(webClipsRoot, slug, 'clip.json')
  const cachedClip = await readReusableClipFile(clipFile)
  if (cachedClip) {
    send(response, 200, await enhanceWebClipTranslation(cachedClip, clipFile))
    return
  }

  let runResult
  try {
    runResult = await runClipScript(targetUrl)
  } catch (error) {
    const fallbackClip = await readReusableClipFile(clipFile)
    if (fallbackClip) {
      send(response, 200, await enhanceWebClipTranslation(fallbackClip, clipFile))
      return
    }
    throw error
  }

  try {
    const clip = JSON.parse(await readFile(clipFile, 'utf8'))
    send(response, 200, await enhanceWebClipTranslation(clip, clipFile))
  } catch (error) {
    const detail = runResult.stderr.trim() || runResult.stdout.trim()
    const message = summarizeClipFailure(detail || (error instanceof Error ? error.message : '采集脚本没有生成结果'))
    send(response, runResult.code === 0 ? 500 : 502, { error: message })
  }
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    const appBasePath = (process.env.VITE_APP_BASE || '/art_archive/').replace(/\/+$/, '')
    if (appBasePath && appBasePath !== '/' && url.pathname.startsWith(`${appBasePath}/`)) {
      url.pathname = url.pathname.slice(appBasePath.length) || '/'
    }

    if (request.method === 'OPTIONS') {
      send(response, 204, {})
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/archive/health') {
      send(response, 200, {
        ok: true,
        host,
        port,
        dataFile,
        webClipsRoot,
        markdownImportRoot,
        sharedArchiveDataRoot: sharedArchiveDataRoot || null,
        svnRoot: svnRoot || null,
        archiveBackupDir,
        archiveOperationLogFile,
        writeGuard: getArchiveWriteGuardState(),
      })
      return
    }

    if (request.method === 'GET' && url.pathname.startsWith('/web-clips/')) {
      handleWebClipStaticFile(url, response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/archive/import-file') {
      await handleMarkdownImportFile(url, response)
      return
    }

    if (url.pathname === '/api/archive/events') {
      handleArchiveEvents(request, response)
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

    if (request.method === 'GET' && url.pathname === '/api/svn/file') {
      await handleSvnFile(url, response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/svn/thumb') {
      await handleSvnThumb(url, response)
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
      await syncMarkdownImportsToDb()
      await syncLiteratureFoldersToDb()
      const db = await readDb()
      normalizeArchiveDb(db)
      await writeDb(db)
      send(response, 200, {
        items: db.items ?? [],
        assets: db.assets ?? [],
        bookSources: db.bookSources ?? [],
        bookPages: db.bookPages ?? [],
        feedbacks: db.feedbacks ?? [],
        settings: normalizeSettings(db.settings),
      })
      return
    }

    if (url.pathname === '/api/archive/imports/literature') {
      if (request.method === 'POST') {
        const result = await syncLiteratureFoldersToDb()
        broadcastArchiveChange('literature-folders-synced')
        send(response, 200, result)
        return
      }

      if (request.method === 'GET') {
        const db = await readDb()
        const current = db.imports?.literatureFolders && typeof db.imports.literatureFolders === 'object'
          ? db.imports.literatureFolders
          : { root: getLiteratureRoot(), syncedAt: '', count: 0, pageCount: 0, sources: [] }
        send(response, 200, current)
        return
      }

      send(response, 405, { error: '接口只支持 GET/POST' })
      return
    }

    if (url.pathname === '/api/archive/imports/markdown') {
      if (request.method === 'GET') {
        send(response, 200, await getMarkdownImportState())
        return
      }

      if (request.method === 'POST') {
        const result = await syncMarkdownImportsToDb()
        broadcastArchiveChange('markdown-imports-synced')
        send(response, 200, result)
        return
      }

      send(response, 405, { error: '接口只支持 GET/POST' })
      return
    }

    if (url.pathname === '/api/archive/settings') {
      if (request.method === 'GET') {
        const db = await readDb()
        send(response, 200, { settings: normalizeSettings(db.settings) })
        return
      }

      if (request.method === 'POST') {
        await handleArchiveSettingsPost(request, response)
        return
      }

      send(response, 405, { error: '接口只支持 GET/POST' })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/snapshot/replace') {
      await handleArchiveSnapshotReplacePost(request, response)
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

    if (request.method === 'POST' && url.pathname === '/api/archive/tags/rename') {
      await handleArchiveTagRenamePost(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/summarize') {
      await handleArchiveSummaryPost(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/classify') {
      await handleArchiveClassificationPost(request, response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/archive/ai/status') {
      send(response, 200, getArchiveAiStatus())
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/feedback') {
      await handleArchiveFeedbackPost(request, response)
      return
    }

    const feedbackStatusMatch = url.pathname.match(/^\/api\/archive\/feedback\/([^/]+)\/status$/)
    if (feedbackStatusMatch && request.method === 'POST') {
      await handleArchiveFeedbackStatusPost(decodeURIComponent(feedbackStatusMatch[1]), request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/literature') {
      await handleLiteraturePost(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/literature/ocr') {
      await handleLiteratureOcrPost(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/literature/ocr-text') {
      await handleLiteratureOcrTextPost(request, response)
      return
    }

    const literatureDeleteMatch = url.pathname.match(/^\/api\/archive\/literature\/([^/]+)$/)
    if (literatureDeleteMatch && request.method === 'DELETE') {
      await handleLiteratureDelete(decodeURIComponent(literatureDeleteMatch[1]), response)
      return
    }

    const archiveItemPurgeMatch = url.pathname.match(/^\/api\/archive\/items\/([^/]+)\/purge$/)
    if (archiveItemPurgeMatch && request.method === 'DELETE') {
      await handleArchiveItemMutation(decodeURIComponent(archiveItemPurgeMatch[1]), 'purge', request, response)
      return
    }

    const archiveItemTimelineMatch = url.pathname.match(/^\/api\/archive\/items\/([^/]+)\/timeline$/)
    if (archiveItemTimelineMatch && request.method === 'POST') {
      await handleArchiveItemTimelinePost(decodeURIComponent(archiveItemTimelineMatch[1]), request, response)
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

    if (url.pathname === '/api/archive/web-clips/cleanup') {
      await handleWebClipCleanup(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/archive/web-clips/login') {
      await handleWebClipLoginPost(request, response)
      return
    }

    send(response, 404, { error: '接口不存在' })
  } catch (error) {
    send(response, error.status ?? 500, {
      error: error instanceof Error ? error.message : '服务异常',
      code: typeof error?.code === 'string' ? error.code : undefined,
      diagnostics: error?.diagnostics,
      guard: error?.guard,
    })
  }
}

createServer(handleRequest).listen(port, host, () => {
  console.log(`Archive API listening at http://${host}:${port}`)
  console.log(`Archive data file: ${dataFile}`)
})
