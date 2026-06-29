import { existsSync, readFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const imageExtensions = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'])

function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    olderThanDays: 0,
    limit: 25,
    pruneEmptyDirs: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') {
      options.apply = true
    } else if (arg === '--dry-run') {
      options.apply = false
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--older-than-days') {
      options.olderThanDays = Number(argv[index + 1] ?? 0)
      index += 1
    } else if (arg.startsWith('--older-than-days=')) {
      options.olderThanDays = Number(arg.split('=').slice(1).join('=') || 0)
    } else if (arg === '--limit') {
      options.limit = Number(argv[index + 1] ?? options.limit)
      index += 1
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.split('=').slice(1).join('=') || options.limit)
    } else if (arg === '--no-prune-empty-dirs') {
      options.pruneEmptyDirs = false
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 0) {
    throw new Error('--older-than-days must be a non-negative number')
  }
  if (!Number.isFinite(options.limit) || options.limit < 0) {
    throw new Error('--limit must be a non-negative number')
  }

  return options
}

function usage() {
  return `Usage:
  node scripts/cleanup-web-clips.mjs [--dry-run]
  node scripts/cleanup-web-clips.mjs --apply [--older-than-days 7]

Deletes unreferenced image files under the configured web-clips cache.
Default mode is dry-run. A file is kept when archive-db.json still references its /web-clips/... path.

Options:
  --apply                  Actually delete candidate image files.
  --json                   Print a machine-readable JSON summary.
  --older-than-days <n>    Only include unreferenced files older than n days. Default: 0.
  --limit <n>              Number of largest candidate folders to print. Default: 25.
  --no-prune-empty-dirs    Do not remove empty folders after deleting files.
`
}

function readConfiguredRoot(configPath) {
  try {
    const value = readFileSync(configPath, 'utf8').trim()
    return value ? resolve(value) : ''
  } catch {
    return ''
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function normalizeRelativeWebClipPath(value) {
  const text = String(value || '').trim().replace(/\\/g, '/')
  if (!text) return ''

  const webClipIndex = text.toLowerCase().indexOf('/web-clips/')
  if (webClipIndex < 0) return ''

  const rawPath = text.slice(webClipIndex + '/web-clips/'.length).split(/[?#]/)[0]
  if (!rawPath || rawPath.includes('\0')) return ''

  try {
    return decodeURIComponent(rawPath).replace(/^\/+/, '').replace(/\/+/g, '/')
  } catch {
    return rawPath.replace(/^\/+/, '').replace(/\/+/g, '/')
  }
}

function collectReferencedWebClipPaths(value, references = new Set()) {
  if (typeof value === 'string') {
    const normalized = normalizeRelativeWebClipPath(value)
    if (normalized) references.add(normalized.toLowerCase())
    return references
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectReferencedWebClipPaths(entry, references))
    return references
  }

  if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectReferencedWebClipPaths(entry, references))
  }

  return references
}

function isImageFile(filePath) {
  const dotIndex = filePath.lastIndexOf('.')
  const extension = dotIndex >= 0 ? filePath.slice(dotIndex).toLowerCase() : ''
  return imageExtensions.has(extension)
}

async function listImageFiles(root, current = root, output = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const filePath = join(current, entry.name)
    if (entry.isDirectory()) {
      await listImageFiles(root, filePath, output)
    } else if (entry.isFile() && isImageFile(entry.name)) {
      const fileStat = await stat(filePath)
      const relativePath = relative(root, filePath).split(sep).join('/')
      output.push({
        filePath,
        relativePath,
        key: relativePath.toLowerCase(),
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      })
    }
  }
  return output
}

function summarizeByClipFolder(files) {
  const groups = new Map()
  for (const file of files) {
    const clipFolder = file.relativePath.split('/')[0] || '(root)'
    const group = groups.get(clipFolder) ?? { folder: clipFolder, count: 0, bytes: 0 }
    group.count += 1
    group.bytes += file.size
    groups.set(clipFolder, group)
  }
  return Array.from(groups.values()).sort((left, right) => right.bytes - left.bytes || right.count - left.count)
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

async function pruneEmptyDirs(root, files) {
  const dirs = Array.from(new Set(files.map((file) => {
    const parts = file.relativePath.split('/')
    parts.pop()
    return parts
  }).flatMap((parts) => parts.map((_, index) => parts.slice(0, index + 1).join('/')))))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)

  let removed = 0
  for (const dir of dirs) {
    const dirPath = resolve(root, dir)
    if (dirPath === root || !dirPath.startsWith(`${root}${sep}`)) continue
    try {
      await rm(dirPath, { recursive: false })
      removed += 1
    } catch {
      // Directory is not empty or has already gone away.
    }
  }
  return removed
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const repoRoot = process.cwd()
  const sharedRoot = process.env.ARCHIVE_SHARED_DATA_ROOT?.trim()
    ? resolve(process.env.ARCHIVE_SHARED_DATA_ROOT)
    : readConfiguredRoot(resolve(repoRoot, '.archive-data/shared-root.txt'))
  const archiveStorageRoot = sharedRoot || resolve(repoRoot, '.archive-data')
  const dataFile = resolve(process.env.ARCHIVE_DATA_FILE ?? join(archiveStorageRoot, 'archive-db.json'))
  const webClipsRoot = resolve(process.env.ARCHIVE_WEB_CLIPS_DIR ?? join(archiveStorageRoot, 'web-clips'))

  if (!existsSync(dataFile)) throw new Error(`archive-db.json not found: ${dataFile}`)
  if (!existsSync(webClipsRoot)) throw new Error(`web-clips root not found: ${webClipsRoot}`)

  const db = readJson(dataFile)
  const references = collectReferencedWebClipPaths(db)
  const files = await listImageFiles(webClipsRoot)
  const cutoffMs = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000
  const candidates = files
    .filter((file) => !references.has(file.key))
    .filter((file) => options.olderThanDays <= 0 || file.mtimeMs < cutoffMs)
    .sort((left, right) => right.size - left.size)

  const candidateBytes = candidates.reduce((sum, file) => sum + file.size, 0)
  const referencedCount = files.length - files.filter((file) => !references.has(file.key)).length
  const mode = options.apply ? 'APPLY' : 'DRY-RUN'
  const groups = summarizeByClipFolder(candidates).slice(0, options.limit)
  const result = {
    ok: true,
    mode,
    applied: options.apply,
    dataFile,
    webClipsRoot,
    imageFileCount: files.length,
    referencedImageFileCount: referencedCount,
    candidateCount: candidates.length,
    candidateBytes,
    olderThanDays: options.olderThanDays,
    largestCandidateFolders: groups,
    deletedCount: 0,
    deletedBytes: 0,
    removedEmptyDirCount: 0,
  }

  if (!options.apply) {
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log(`[${mode}] web-clips cleanup`)
    console.log(`dataFile: ${dataFile}`)
    console.log(`webClipsRoot: ${webClipsRoot}`)
    console.log(`image files: ${files.length}`)
    console.log(`referenced image files kept: ${referencedCount}`)
    console.log(`delete candidates: ${candidates.length} (${formatBytes(candidateBytes)})`)
    if (options.olderThanDays > 0) console.log(`age filter: older than ${options.olderThanDays} day(s)`)

    if (groups.length) {
      console.log('\nLargest candidate folders:')
      groups.forEach((group) => {
        console.log(`- ${group.folder}: ${group.count} file(s), ${formatBytes(group.bytes)}`)
      })
    }

    console.log('\nNo files deleted. Re-run with --apply to delete these unreferenced images.')
    return
  }

  let deleted = 0
  for (const file of candidates) {
    await rm(file.filePath, { force: true })
    deleted += 1
  }
  const removedDirs = options.pruneEmptyDirs ? await pruneEmptyDirs(webClipsRoot, candidates) : 0
  result.deletedCount = deleted
  result.deletedBytes = candidateBytes
  result.removedEmptyDirCount = removedDirs

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`[${mode}] web-clips cleanup`)
  console.log(`dataFile: ${dataFile}`)
  console.log(`webClipsRoot: ${webClipsRoot}`)
  console.log(`image files: ${files.length}`)
  console.log(`referenced image files kept: ${referencedCount}`)
  console.log(`delete candidates: ${candidates.length} (${formatBytes(candidateBytes)})`)
  if (options.olderThanDays > 0) console.log(`age filter: older than ${options.olderThanDays} day(s)`)

  if (groups.length) {
    console.log('\nLargest candidate folders:')
    groups.forEach((group) => {
      console.log(`- ${group.folder}: ${group.count} file(s), ${formatBytes(group.bytes)}`)
    })
  }

  console.log(`\nDeleted ${deleted} image file(s), ${formatBytes(candidateBytes)} total.`)
  if (options.pruneEmptyDirs) console.log(`Removed ${removedDirs} empty folder(s).`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
