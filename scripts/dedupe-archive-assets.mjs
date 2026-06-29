import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

function readSharedArchiveRoot() {
  const envRoot = process.env.ARCHIVE_SHARED_DATA_ROOT?.trim()
  if (envRoot) return resolve(envRoot)

  try {
    const fileRoot = readFileSync(resolve('.archive-data/shared-root.txt'), 'utf8').trim()
    if (fileRoot) return resolve(fileRoot)
  } catch {
    // Fall back to the local archive data file below.
  }

  return ''
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
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

function normalizeSourceUrl(value) {
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

function extractSourceUrlFromText(value) {
  const match = normalizeString(value).match(/https?:\/\/[^\s"'<>]+/i)
  return match ? normalizeSourceUrl(match[0]) : ''
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

function readConfiguredSvnRoot() {
  const envRoot = process.env.SVN_WORKING_COPY_ROOT?.trim()
  if (envRoot) return resolve(envRoot)

  try {
    const fileRoot = readFileSync(resolve('.archive-data/svn-root.txt'), 'utf8').trim()
    return fileRoot ? resolve(fileRoot) : ''
  } catch {
    return ''
  }
}

const sharedArchiveRoot = readSharedArchiveRoot()
const archiveStorageRoot = sharedArchiveRoot || resolve('.archive-data')
const svnRoot = readConfiguredSvnRoot()

function resolveAssetLocalPath(asset) {
  const imageUrl = normalizeString(asset.imageUrl || asset.thumbnailUrl)
  const apiMatch = imageUrl.match(/^\/api\/svn\/file\?path=([^#]+)/)
  if (apiMatch && svnRoot) {
    const svnPath = decodeURIComponent(apiMatch[1]).replace(/^\/+/, '').replace(/\//g, sep)
    const relativePath = svnPath.replace(/^ArtArchive[\\/]/i, '')
    const candidates = [
      resolve(svnRoot, relativePath),
      resolve(svnRoot, svnPath),
    ]
    return candidates.find((candidate) => existsSync(candidate)) || ''
  }

  const svnPath = normalizeString(asset.svnPath).replace(/^\/+/, '').replace(/\//g, sep)
  if (svnPath && svnRoot) {
    const relativePath = svnPath.replace(/^ArtArchive[\\/]/i, '')
    const candidates = [
      resolve(svnRoot, relativePath),
      resolve(svnRoot, svnPath),
    ]
    return candidates.find((candidate) => existsSync(candidate)) || ''
  }

  const localClipPath = imageUrl.startsWith('/web-clips/')
    ? resolve(archiveStorageRoot, imageUrl.slice(1).replace(/\//g, sep))
    : ''
  if (localClipPath && existsSync(localClipPath)) return localClipPath

  const publicClipPath = imageUrl.startsWith('/web-clips/')
    ? resolve('public', imageUrl.slice(1).replace(/\//g, sep))
    : ''
  if (publicClipPath && existsSync(publicClipPath)) return publicClipPath

  return ''
}

function hashAssetFile(asset) {
  const filePath = resolveAssetLocalPath(asset)
  if (!filePath) return ''
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function assetWithContentHash(asset) {
  const existingHash = normalizeString(asset.contentHash).toLowerCase().replace(/^sha256:/, '')
  const contentHash = existingHash || hashAssetFile(asset)
  return contentHash ? { ...asset, contentHash } : asset
}

function getAssetRepresentativeScore(asset) {
  const caption = normalizeString(asset.caption)
  const sourceUrl = `${normalizeString(asset.originalUrl)} ${normalizeString(asset.sourceUrl)}`.toLowerCase()
  const mainImageScore = caption === '网页主图' ? 1_000_000 : caption.includes('主图') ? 500_000 : 0
  const qualityScore = /(mid|large|original|full)_/.test(sourceUrl) ? 10_000 : 0
  return mainImageScore + qualityScore + (Number(asset.fileSize) || 0)
}

function mergeArchiveAssets(assets) {
  const merged = new Map()
  const indexByVisualKey = new Map()
  const idMap = new Map()
  const duplicateGroups = []

  for (const rawAsset of assets.filter(isAssetRecord)) {
    const asset = assetWithContentHash(rawAsset)
    const keys = getAssetVisualKeys(asset)
    const existingId = keys.map((key) => indexByVisualKey.get(key)).find(Boolean)
    if (!existingId) {
      const nextAsset = { ...asset, visualKey: keys[0] || normalizeString(asset.visualKey) }
      merged.set(asset.id, nextAsset)
      idMap.set(asset.id, asset.id)
      keys.forEach((key) => indexByVisualKey.set(key, asset.id))
      continue
    }

    const existing = merged.get(existingId)
    const shouldReplace = getAssetRepresentativeScore(asset) > getAssetRepresentativeScore(existing)
    const keptAsset = shouldReplace
      ? { ...existing, ...asset, id: existing.id, linkedItemId: existing.linkedItemId || asset.linkedItemId, visualKey: keys[0] || existing.visualKey }
      : { ...existing, visualKey: existing.visualKey || keys[0] }
    merged.set(existingId, keptAsset)
    idMap.set(asset.id, existingId)
    keys.forEach((key) => indexByVisualKey.set(key, existingId))
    duplicateGroups.push({ from: asset.id, to: existingId, key: keys[0] || '' })
  }

  return { assets: Array.from(merged.values()), idMap, duplicateGroups }
}

function getItemSourceKey(item) {
  return (
    normalizeSourceUrl(item?.sourceUrl) ||
    extractSourceUrlFromText(item?.note) ||
    extractSourceUrlFromText(item?.extraNote) ||
    ''
  )
}

function mergeItemList(items, idMap) {
  const merged = []
  const indexBySource = new Map()
  const itemIdMap = new Map()
  const mergedItems = []

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') {
      merged.push(item)
      continue
    }

    const sourceKey = getItemSourceKey(item)
    const existingIndex = sourceKey ? indexBySource.get(sourceKey) : undefined
    const nextItem = {
      ...item,
      assetIds: remapAssetIds(item.assetIds, idMap),
      imageIds: remapAssetIds(item.imageIds, idMap),
    }

    if (existingIndex === undefined) {
      if (sourceKey) indexBySource.set(sourceKey, merged.length)
      itemIdMap.set(item.id, item.id)
      merged.push(nextItem)
      continue
    }

    const existing = merged[existingIndex]
    const existingIds = remapAssetIds([...(existing.assetIds ?? []), ...(existing.imageIds ?? [])], idMap)
    const nextIds = remapAssetIds([...(nextItem.assetIds ?? []), ...(nextItem.imageIds ?? [])], idMap)
    const assetIds = Array.from(new Set([...existingIds, ...nextIds].filter(Boolean)))
    merged[existingIndex] = {
      ...existing,
      id: existing.id,
      createdAt: existing.createdAt ?? nextItem.createdAt,
      updatedAt: existing.updatedAt || nextItem.updatedAt,
      savedAt: existing.savedAt || nextItem.savedAt,
      assetIds,
      imageIds: assetIds,
    }
    itemIdMap.set(item.id, existing.id)
    mergedItems.push({ from: item.id, to: existing.id, sourceKey })
  }

  return { items: merged, itemIdMap, mergedItems }
}

function remapAssetIds(values, idMap) {
  if (!Array.isArray(values)) return values
  return Array.from(new Set(values.map((id) => idMap.get(id) ?? id).filter(Boolean)))
}

const dataFile = resolve(process.env.ARCHIVE_DATA_FILE ?? join(archiveStorageRoot, 'archive-db.json'))
const db = JSON.parse(await readFile(dataFile, 'utf8'))
const beforeCount = Array.isArray(db.assets) ? db.assets.length : 0
const beforeItemCount = Array.isArray(db.items) ? db.items.length : 0
const { assets, idMap, duplicateGroups } = mergeArchiveAssets(Array.isArray(db.assets) ? db.assets : [])
let mergedItemGroups = []

db.assets = assets
if (Array.isArray(db.items)) {
  const mergedItemResult = mergeItemList(db.items, idMap)
  mergedItemGroups = mergedItemResult.mergedItems
  db.items = mergedItemResult.items
  for (const asset of db.assets) {
    const linkedItemId = mergedItemResult.itemIdMap.get(asset.linkedItemId) ?? asset.linkedItemId
    asset.linkedItemId = linkedItemId
  }
  db.assets = db.assets.filter((asset) => mergedItemResult.items.some((item) => item?.id === asset.linkedItemId))
}
const finalAssetCount = Array.isArray(db.assets) ? db.assets.length : 0

const backupFile = `${dataFile}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
if (existsSync(dataFile)) {
  await copyFile(dataFile, backupFile)
}
await writeFile(dataFile, `${JSON.stringify(db, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  dataFile,
  backupFile,
  beforeAssets: beforeCount,
  afterAssets: finalAssetCount,
  beforeItems: beforeItemCount,
  afterItems: Array.isArray(db.items) ? db.items.length : 0,
  mergedDuplicates: duplicateGroups.length,
  mergedItems: mergedItemGroups.length,
  sample: duplicateGroups.slice(0, 12),
  itemSample: mergedItemGroups.slice(0, 12),
}, null, 2))
