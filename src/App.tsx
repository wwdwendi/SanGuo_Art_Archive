import { Fragment, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Canvas, useFrame } from '@react-three/fiber'
import { Center, ContactShadows, OrbitControls, useGLTF } from '@react-three/drei'
import type { Group } from 'three'
import { createWorker, PSM } from 'tesseract.js'
import {
  AlertTriangle,
  ArrowUp,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  CloudOff,
  Copy,
  Download,
  ExternalLink,
  Grab,
  Maximize2,
  Minus,
  FilePenLine,
  FileText,
  FolderOpen,
  Funnel,
  Globe2,
  Grid3X3,
  ImageIcon,
  Layers3,
  Link2,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Share2,
  Star,
  Tag,
  Upload,
  User,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide-react'
import './App.css'
import { assets, collectionItems, filterGroups, type Asset, type CollectionItem, type Period } from './data'
import { PERIOD_ORDER, buildTimelineResponse, type TimelineCardItem, type TimelineCategoryKey, type TimelineQuery } from './timeline'

type View = 'home' | 'library' | 'images' | 'literature' | 'timeline' | 'detail' | 'edit' | 'admin'
type EditorMode = 'new' | 'edit' | 'duplicate'
type GalleryDialog = 'svn-picker' | 'add-source' | 'tag-picker' | 'sync-status' | 'web-clip' | 'book-scan' | null
type WebClipStatus = 'pending' | 'processing' | 'success' | 'partial_success' | 'failed'
type WebClipDownloadStatus = 'not_downloaded' | 'downloaded' | 'failed'
type UserRole = 'member' | 'admin'
type GalleryOcrStatus = 'queued' | 'processing' | 'done' | 'failed'
type LibraryViewMode = 'visual' | 'reader'
type GalleryOcrEntry = {
  status: GalleryOcrStatus
  text: string
  error?: string
  updatedAt?: string
}

const GALLERY_PAGE_SIZE_OPTIONS = [24, 48, 96]

type ArchiveEditorPayload = {
  mode: EditorMode
  sourceItemId: string | null
  type: string
  title: string
  summary: string
  note: string
  extraNote: string
  categories: Record<string, string>
  assetIds: string[]
  assets?: Asset[]
  sourceUrl?: string
  sourceRefs?: ArchiveItemSourceRef[]
  timelineEnabled?: boolean
  timelineLabel?: string
  startYear?: number
  endYear?: number
  timelineWeight?: number
  bookSources?: BookSource[]
  bookPages?: BookPage[]
  createdBy?: string
  forceCreateDuplicate?: boolean
  savedAt: string
  savedAtLabel: string
}

type TimelineAdminConfig = {
  timelineEnabled: boolean
  timelineLabel: string
  startYear?: number
  endYear?: number
  timelineWeight?: number
}

type WebClipSaveMode = 'create' | 'update'

type ArchiveDuplicateMatch = {
  id: string
  title: string
  reason: string
  sourceUrl?: string
  createdAt?: string
  createdBy?: string
}

class ArchiveDuplicateError extends Error {
  duplicate: ArchiveDuplicateMatch

  constructor(message: string, duplicate: ArchiveDuplicateMatch) {
    super(message)
    this.name = 'ArchiveDuplicateError'
    this.duplicate = duplicate
  }
}

type WebClipExtractField = {
  label: string
  value: string
}

type WebClipImage = {
  id: string
  imageUrl: string
  thumbnailUrl?: string
  sourceUrl?: string
  width?: number
  height?: number
  altText?: string
  caption?: string
  selected: boolean
  downloadStatus: WebClipDownloadStatus
  assetId?: string
  errorMessage?: string
}

type SourceDraft = {
  title: string
  sourceType: string
  referencePurposes: string[]
  usageHints: string[]
  usageRestriction: string
  sourceUrl: string
}

type ArchiveItemDraft = {
  title: string
  summary: string
  collectionType: string
  tags: string[]
}

type WebClipTranslation = {
  language: 'zh-CN'
  title?: string
  summary?: string
  extractedText?: string
  fields?: WebClipExtractField[]
  generatedBy?: string
}

type WebClipImport = {
  id: string
  inputUrl: string
  normalizedUrl?: string
  platform?: string
  pageTitle?: string
  pageDescription?: string
  extractedText?: string
  extractedFields?: WebClipExtractField[]
  summary?: string
  extractedImages: WebClipImage[]
  suggestedCollectionType?: string
  suggestedSourceType?: string
  suggestedReferencePurpose?: string[]
  suggestedUsageHints?: string[]
  suggestedTags?: string[]
  usageRestriction?: string
  sourceDraft?: SourceDraft
  itemDraft?: ArchiveItemDraft
  translationZh?: WebClipTranslation
  status: WebClipStatus
  errorMessage?: string
  createdBy: string
  createdAt: string
}

type SvnApiFile = {
  id?: string
  assetId?: string
  name: string
  path: string
  thumbnailUrl?: string
  previewUrl?: string
  imageType?: string
  sourceType?: string
  referencePurpose?: string
  tags?: string[]
  sizeLabel?: string
}

type SvnApiResponse = {
  files: SvnApiFile[]
  folders?: string[]
  total?: number
  indexed?: boolean
  indexedTotal?: number
  indexBuiltAt?: string
}

type SvnUpdateResponse = {
  ok?: boolean
  revision?: string
  indexedFiles?: number
  indexBuiltAt?: string
  stdout?: string
  stderr?: string
  updatedAt?: string
  error?: string
}

type SvnPickerFile = {
  id: string
  name: string
  path: string
  thumbnailUrl?: string
  sizeLabel: string
  asset: Asset
}

type BookScanRecognition = {
  title: string
  author: string
  publisher: string
  pageLabel: string
  isbn: string
  year: string
  summary: string
  note: string
  tags: string[]
  sourceTitle: string
}

type BookScanImport = {
  id: string
  source: BookSource
  pages: BookPage[]
  text: string
  recognition: BookScanRecognition
  sourceRef: ArchiveItemSourceRef
}

type BookScanSelectedFile = {
  originalName: string
  previewUrl: string
  ocrFile: File
}

const uniqueValues = (values: string[]) => Array.from(new Set(values))
const sourceTypePriority = [
  '史料典籍',
  '考古报告',
  '博物馆 / 馆藏',
  '现代书籍',
  '论文研究',
  '网络资料',
  '内部整理',
]

const sourceTypeOptions = sourceTypePriority.map((value) => ({ value, label: value }))
function getStandardSourceTypes(values: Array<string | undefined>) {
  const mapped = values.flatMap((value) => {
    const text = value?.trim()
    if (!text) return []
    if (sourceTypePriority.includes(text)) return [text]
    if (/史料|典籍|古籍|正史|后汉书|三国志|舆服志|文献记录/.test(text)) return ['史料典籍']
    if (/考古|报告|发掘|简报|出土文物图像/.test(text)) return ['考古报告']
    if (/博物馆|馆藏|藏品|museum|collection|展览/.test(text)) return ['博物馆 / 馆藏']
    if (/现代书籍|图书|书籍|出版|图录|著作/.test(text)) return ['现代书籍']
    if (/论文|研究资料|期刊|学术|硕士|博士|cnki|知网/.test(text)) return ['论文研究']
    if (/网页|网站|网络|资料网站|博物馆网页|社交媒体|小红书|微博|pinterest|google 艺术与文化|artsandculture|web clip|链接/.test(text)) return ['网络资料']
    if (/内部|团队|整理|创作者|作者|复原作者|模型作者|手办作者|服装服饰|服饰复原/.test(text)) return ['内部整理']
    return []
  })

  return uniqueValues(mapped)
}

const sortSourceTypes = (values: string[]) => {
  const priority = new Map(sourceTypePriority.map((value, index) => [value, index]))
  return uniqueValues(values.flatMap((value) => getStandardSourceTypes([value]))).sort((left, right) => {
    const leftIndex = priority.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightIndex = priority.get(right) ?? Number.MAX_SAFE_INTEGER
    if (leftIndex !== rightIndex) return leftIndex - rightIndex
    return left.localeCompare(right, 'zh-CN')
  })
}
const defaultView: View = 'home'
const defaultSelectedItemId = collectionItems[0].id
const pageStateKey = 'three-kingdoms-art-archive:page-state'
const roleStateKey = 'three-kingdoms-art-archive:user-role'
const librarySortStateKey = 'three-kingdoms-art-archive:library-sort-mode'
const homeFeaturedStateKey = 'three-kingdoms-art-archive:home-featured'
const runtimeArchiveKey = 'three-kingdoms-art-archive:runtime-archive'
const notificationReadAtKey = 'three-kingdoms-art-archive:notification-read-at'
const galleryOcrCacheKey = 'three-kingdoms-art-archive:gallery-ocr-v4'
const galleryPerPageStateKey = 'three-kingdoms-art-archive:gallery-per-page'
const libraryFilterSectionsStateKey = 'three-kingdoms-art-archive:library-filter-sections'
const galleryFilterSectionsStateKey = 'three-kingdoms-art-archive:gallery-filter-sections'
const hiddenLiteratureStateKey = 'three-kingdoms-art-archive:hidden-literature'
const literaturePageStateKey = 'three-kingdoms-art-archive:literature-state'
const archiveLinkParam = 'archive'
const legacyItemLinkParam = 'item'
const literatureBookLinkParam = 'literatureBook'
const publicArchiveIdPrefix = 'sga'
const views = new Set<View>(['home', 'library', 'images', 'literature', 'timeline', 'detail', 'edit', 'admin'])
const appBaseUrl = import.meta.env.BASE_URL.replace(/\/$/, '')
const appPath = (path: string) => `${appBaseUrl}${path}`
const routePath = (path: string) => `${appBaseUrl}${path}` || '/'
const svnApiBaseUrl = (import.meta.env.VITE_SVN_API_BASE_URL ?? appPath('/api/svn')).replace(/\/$/, '')
const archiveApiBaseUrl = (import.meta.env.VITE_ARCHIVE_API_BASE_URL ?? appPath('/api/archive')).replace(/\/$/, '')
const archiveEventsUrl = `${archiveApiBaseUrl}/events`
const webClipsBaseUrl = appPath('/web-clips')

function resolveLocalAssetUrl(value = '') {
  const path = value.trim()
  if (!path || isHttpUrl(path) || /^(data|blob):/i.test(path)) return path
  if (appBaseUrl && path.startsWith(`${appBaseUrl}/`)) return path
  return path.startsWith('/') ? appPath(path) : path
}

type PaddleOcrResponse = {
  engine?: string
  text?: string
  error?: string
}

type RuntimeArchiveSnapshot = {
  items: CollectionItem[]
  assets: Asset[]
  bookSources: BookSource[]
  bookPages: BookPage[]
  feedbacks: ArchiveFeedback[]
  settings?: ArchiveSettings
}

type HomeHeroExhibitConfig = {
  id: string
  itemId: string
}

type ArchiveSettings = {
  homeHeroDetailId?: string
  homeHeroItems?: HomeHeroExhibitConfig[]
  updatedAt?: string
}

const defaultHomeHeroItems: HomeHeroExhibitConfig[] = [
  { id: 'hero-1', itemId: 'han-cap-system' },
  { id: 'hero-2', itemId: 'wei-armor' },
  { id: 'hero-3', itemId: 'han-scholar-robe' },
  { id: 'hero-4', itemId: 'han-brick-clothing' },
]

const defaultArchiveSettings: ArchiveSettings = {
  homeHeroDetailId: defaultHomeHeroItems[0].itemId,
  homeHeroItems: defaultHomeHeroItems,
  updatedAt: '',
}

type ArchiveApiRecord = {
  id?: unknown
  mode?: unknown
  sourceItemId?: unknown
  type?: unknown
  title?: unknown
  summary?: unknown
  note?: unknown
  extraNote?: unknown
  categories?: unknown
  assetIds?: unknown
  sourceUrl?: unknown
  sourceRefs?: unknown
  createdAt?: unknown
  createdBy?: unknown
  status?: unknown
  savedAt?: unknown
  updatedAt?: unknown
  startYear?: unknown
  endYear?: unknown
  timelineLabel?: unknown
  timelineEnabled?: unknown
  timelineWeight?: unknown
}

type ArchiveItemsResponse = {
  items?: ArchiveApiRecord[]
  assets?: Asset[]
  bookSources?: BookSource[]
  bookPages?: BookPage[]
  feedbacks?: ArchiveFeedback[]
  settings?: ArchiveSettings
}

type ArchiveFeedback = {
  id: string
  itemId: string
  itemTitle: string
  feedbackType: string
  message: string
  pageUrl?: string
  sourceUrl?: string
  createdBy: string
  createdAt: string
  status: 'open' | 'resolved' | string
}

type AppNotification = {
  id: string
  kind: 'success' | 'review' | 'sync-error' | 'web-clip'
  title: string
  body: string
  timeLabel: string
  actionView: View
  createdAt: number
}

type BookSourceType = '史料典籍' | '现代书籍' | '展览图录' | '论文研究'

type BookSource = {
  id: string
  title: string
  author?: string
  publisher?: string
  publishYear?: number
  periodRange?: string
  isbn?: string
  sourceType: BookSourceType
  archiveCode?: string
  chapter?: string
  note?: string
  usageRestriction?: string
  scanFolderPath?: string
  subtitle?: string
  dynasty?: string
  format?: string
  language?: string
  edition?: string
  pageCount?: number
  volumeCount?: string
  tags?: string[]
  coverImagePath?: string
  svnOriginalPath?: string
  pdfPath?: string
  thumbnailPath?: string
  ocrTextPath?: string
  syncStatus?: string
  lastSyncedAt?: string
  citationFormat?: string
  importantPages?: string
  excerpt?: string
  researchNote?: string
  maintainerNote?: string
  relatedArchiveItemIds?: string[]
  updatedBy?: string
  updatedAt?: string
}

type BookPage = {
  id: string
  bookSourceId: string
  pageNumber: string
  chapter?: string
  imagePath: string
  ocrText?: string
  correctedText?: string
  keywords: string[]
  linkedArchiveItemIds: string[]
}

type LiteratureMode = 'home' | 'search' | 'detail' | 'reader' | 'edit'
type LiteraturePageState = {
  mode: LiteratureMode
  activeBookId?: string
  searchSeed?: string
  scrollY?: number
}
type LiteratureFloatingPhase = 'enter' | 'present' | 'exit'
type LiteratureCatalogBook = {
  id: string
  title: string
  shortTitle: string
  author: string
  dynasty: string
  category: string
  source: string
  format: string
  ocrStatus: string
  ocrRate: number
  totalPages: number
  volumes: string
  summary: string
  svnPath?: string
  palette: string
  accent: string
  coverImage?: string
  archiveItemId?: string
  pages: BookPage[]
}

function getLiteratureBookUrl(book: LiteratureCatalogBook) {
  if (typeof window === 'undefined') return book.id

  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('view', 'literature')
  url.searchParams.set(literatureBookLinkParam, book.id)
  return url.toString()
}

function readRequestedLiteratureBookId() {
  if (typeof window === 'undefined') return ''

  const params = new URLSearchParams(window.location.search)
  return params.get(literatureBookLinkParam)?.trim() ?? ''
}

type ArchiveItemSourceRef = {
  sourceId: string
  pageIds?: string[]
  pageNumberText?: string
  quoteText?: string
  note?: string
}

async function postArchivePayload(path: 'drafts' | 'items', payload: ArchiveEditorPayload) {
  const response = await fetch(`${archiveApiBaseUrl}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null) as { error?: string; duplicate?: ArchiveDuplicateMatch } | null
    if (response.status === 409 && errorPayload?.duplicate) {
      throw new ArchiveDuplicateError(errorPayload.error ?? '疑似已存在相同资料', errorPayload.duplicate)
    }
    throw new Error(errorPayload?.error ?? `资料库服务返回 ${response.status}`)
  }

  return response.json() as Promise<{ id: string; savedAt: string }>
}

async function updateArchiveItemStatus(itemId: string, status: CollectionItem['status'], updatedBy: string) {
  const response = await fetch(`${archiveApiBaseUrl}/items/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, status, updatedBy }),
  })

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(errorPayload?.error ?? `资料库服务返回 ${response.status}`)
  }

  return response.json() as Promise<{ id: string; status: CollectionItem['status']; updatedAt: string }>
}

async function purgeArchiveItem(itemId: string) {
  const response = await fetch(`${archiveApiBaseUrl}/items/${encodeURIComponent(itemId)}/purge`, { method: 'DELETE' })
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({} as { error?: string }))
    throw new Error(errorPayload?.error ?? `资料库服务返回 ${response.status}`)
  }
  return response.json() as Promise<{ id: string; purged: boolean; removedAssetCount: number }>
}

async function submitArchiveFeedback(payload: {
  itemId: string
  itemTitle: string
  feedbackType: string
  message: string
  pageUrl: string
  sourceUrl?: string
  createdBy: string
}) {
  const response = await fetch(`${archiveApiBaseUrl}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorPayload?.error ?? `反馈提交失败：${response.status}`)
  }

  return response.json() as Promise<{ id: string; createdAt: string }>
}

async function saveArchiveSettings(settings: ArchiveSettings) {
  const response = await fetch(`${archiveApiBaseUrl}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorPayload?.error ?? `设置保存失败：${response.status}`)
  }

  return response.json() as Promise<{ settings: ArchiveSettings }>
}

async function saveLiteratureBookRecord(source: BookSource, pages: BookPage[]) {
  const response = await fetch(`${archiveApiBaseUrl}/literature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, pages }),
  })

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(errorPayload?.error ?? `文献档案保存失败：${response.status}`)
  }

  return response.json() as Promise<{ source: BookSource; pages: BookPage[] }>
}

async function fetchArchiveSnapshot(): Promise<RuntimeArchiveSnapshot> {
  const normalizePayload = (payload: ArchiveItemsResponse): RuntimeArchiveSnapshot => ({
    items: (payload.items ?? []).map(mapArchiveApiRecord).filter(Boolean) as CollectionItem[],
    assets: Array.isArray(payload.assets) ? payload.assets.filter(isAssetRecord) : [],
    bookSources: Array.isArray(payload.bookSources) ? payload.bookSources.filter(isBookSourceRecord) : [],
    bookPages: Array.isArray(payload.bookPages) ? payload.bookPages.filter(isBookPageRecord) : [],
    feedbacks: Array.isArray(payload.feedbacks) ? payload.feedbacks.filter(isArchiveFeedbackRecord) : [],
    settings: normalizeArchiveSettings(payload.settings),
  })

  const fetchStaticSnapshot = async () => {
    const staticResponse = await fetch(appPath('/archive-db.json'), { cache: 'no-store' }).catch(() => null)
    return staticResponse?.ok ? normalizePayload((await staticResponse.json()) as ArchiveItemsResponse) : null
  }

  const response = await fetch(`${archiveApiBaseUrl}/items`, { cache: 'no-store' }).catch(() => null)

  if (!response?.ok) {
    const staticSnapshot = await fetchStaticSnapshot()
    if (staticSnapshot) return staticSnapshot

    const errorPayload = await response?.json().catch(() => null) as { error?: string } | null
    throw new Error(errorPayload?.error ?? `资料库服务${response ? `返回 ${response.status}` : '不可用'}`)
  }

  return normalizePayload((await response.json()) as ArchiveItemsResponse)
}
const svnImageFolders = [
  '/',
  '/01_文献史料',
  '/02_出土文物',
  '/03_画像壁画',
  '/04_服饰形制',
  '/05_冠帽发式',
  '/06_甲胄兵器',
  '/07_纹样材质',
  '/08_复原参考',
  '/09_角色设计参考',
  '/99_待整理',
  '/ArtArchive',
]

type PageState = {
  view: View
  selectedItemId: string
}

type ArchiveHistoryState = {
  archiveApp?: true
  view?: View
  selectedItemId?: string
}

type ArchiveLinkRequest = {
  kind: 'public' | 'legacy'
  value: string
}

function isView(value: unknown): value is View {
  return typeof value === 'string' && views.has(value as View)
}

function readRequestedView(): View | null {
  if (typeof window === 'undefined') return null

  const url = new URL(window.location.href)
  const requestedView = url.searchParams.get('view')?.trim()
  if (isView(requestedView)) return requestedView

  const basePath = routePath('/')
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  const adminPath = routePath('/admin/')
  if (path === adminPath || (!appBaseUrl && path === '/admin/')) return 'admin'
  if (basePath !== '/' && path === basePath) return 'home'

  return null
}

function createPublicArchiveId(itemId: string) {
  return `${publicArchiveIdPrefix}-${stableHash(itemId)}`
}

function getArchiveItemCode(item: CollectionItem) {
  return createPublicArchiveId(item.id).toUpperCase()
}

function readArchiveLinkRequest(): ArchiveLinkRequest | null {
  if (typeof window === 'undefined') return null

  const params = new URLSearchParams(window.location.search)
  const publicId = params.get(archiveLinkParam)?.trim()
  if (publicId) return { kind: 'public', value: publicId }

  const legacyId = params.get(legacyItemLinkParam)?.trim()
  if (legacyId) return { kind: 'legacy', value: legacyId }

  return null
}

function resolveArchiveLinkRequest(request: ArchiveLinkRequest | null, items: CollectionItem[] = collectionItems) {
  if (!request) return null
  if (request.kind === 'legacy') return request.value

  const normalizedValue = request.value.toLowerCase()
  return items.find((item) => (
    createPublicArchiveId(item.id) === normalizedValue ||
    item.id.toLowerCase() === normalizedValue
  ))?.id ?? null
}

function readRequestedArchiveItemId(items: CollectionItem[] = collectionItems) {
  return resolveArchiveLinkRequest(readArchiveLinkRequest(), items)
}

function getArchiveDetailUrl(item: CollectionItem) {
  if (typeof window === 'undefined') return createPublicArchiveId(item.id)

  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set(archiveLinkParam, createPublicArchiveId(item.id))
  return url.toString()
}

function replaceArchiveDetailUrl(itemId: string) {
  if (typeof window === 'undefined') return

  const item = collectionItems.find((entry) => entry.id === itemId)
  if (!item) return

  const nextUrl = getArchiveDetailUrl(item)
  if (nextUrl !== window.location.href) {
    window.history.replaceState(window.history.state, '', nextUrl)
  }
}

function clearArchiveDetailUrl() {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  if (!url.searchParams.has(archiveLinkParam) && !url.searchParams.has(legacyItemLinkParam)) return

  url.searchParams.delete(archiveLinkParam)
  url.searchParams.delete(legacyItemLinkParam)
  window.history.replaceState(window.history.state, '', url.toString())
}

function getArchiveViewUrl(nextView: View, selectedItemId: string) {
  if (typeof window === 'undefined') return ''

  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.pathname = routePath('/')

  if (nextView === 'detail') {
    const item = collectionItems.find((entry) => entry.id === selectedItemId)
    if (item) url.searchParams.set(archiveLinkParam, createPublicArchiveId(item.id))
  } else if (nextView === 'admin') {
    url.pathname = routePath('/admin/')
  } else if (nextView !== 'home') {
    url.searchParams.set('view', nextView)
  }

  return url.toString()
}

function pushArchiveHistory(nextView: View, selectedItemId: string) {
  if (typeof window === 'undefined') return

  const nextUrl = getArchiveViewUrl(nextView, selectedItemId)
  const nextState: ArchiveHistoryState = { archiveApp: true, view: nextView, selectedItemId }
  const currentState = window.history.state as ArchiveHistoryState | null
  const shouldPush =
    nextUrl !== window.location.href ||
    currentState?.view !== nextView ||
    currentState?.selectedItemId !== selectedItemId

  if (nextUrl && shouldPush) {
    window.history.pushState(nextState, '', nextUrl)
  } else {
    window.history.replaceState(nextState, '', nextUrl || window.location.href)
  }
}

function readPageState(): PageState {
  if (typeof window === 'undefined') {
    return { view: defaultView, selectedItemId: defaultSelectedItemId }
  }

  if (readRequestedLiteratureBookId()) {
    return { view: 'literature', selectedItemId: defaultSelectedItemId }
  }

  const requestedItemId = readRequestedArchiveItemId()
  if (requestedItemId) {
    return { view: 'detail', selectedItemId: requestedItemId }
  }

  const requestedView = readRequestedView()
  if (requestedView && requestedView !== 'detail') {
    return { view: requestedView, selectedItemId: defaultSelectedItemId }
  }

  try {
    const raw = window.sessionStorage.getItem(pageStateKey)
    if (!raw) return { view: defaultView, selectedItemId: defaultSelectedItemId }

    const stored = JSON.parse(raw) as Partial<PageState>
    const selectedItemExists = collectionItems.some((item) => item.id === stored.selectedItemId)

    return {
      view: isView(stored.view) ? stored.view : defaultView,
      selectedItemId: selectedItemExists ? stored.selectedItemId! : defaultSelectedItemId,
    }
  } catch {
    return { view: defaultView, selectedItemId: defaultSelectedItemId }
  }
}

function readUserRole(): UserRole {
  if (typeof window === 'undefined') return 'admin'

  try {
    if (readRequestedView() === 'admin') return 'admin'

    const raw = window.localStorage.getItem(roleStateKey)
    return raw === 'member' || raw === 'admin' ? raw : 'admin'
  } catch {
    return 'admin'
  }
}

function readHiddenLiteratureIds() {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(hiddenLiteratureStateKey) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())) : []
  } catch {
    return []
  }
}

function writeHiddenLiteratureIds(ids: string[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(hiddenLiteratureStateKey, JSON.stringify(Array.from(new Set(ids))))
}

function isLiteratureMode(value: unknown): value is LiteratureMode {
  return value === 'home' || value === 'search' || value === 'detail' || value === 'reader' || value === 'edit'
}

function readLiteraturePageState(): LiteraturePageState {
  if (typeof window === 'undefined') return { mode: 'home' }
  try {
    const raw = window.sessionStorage.getItem(literaturePageStateKey)
    if (!raw) return { mode: 'home' }
    const stored = JSON.parse(raw) as Partial<LiteraturePageState>
    return {
      mode: isLiteratureMode(stored.mode) ? stored.mode : 'home',
      activeBookId: typeof stored.activeBookId === 'string' ? stored.activeBookId : undefined,
      searchSeed: typeof stored.searchSeed === 'string' ? stored.searchSeed : '',
      scrollY: typeof stored.scrollY === 'number' && Number.isFinite(stored.scrollY) ? Math.max(0, stored.scrollY) : 0,
    }
  } catch {
    return { mode: 'home' }
  }
}

function writeLiteraturePageState(state: LiteraturePageState) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(literaturePageStateKey, JSON.stringify(state))
  } catch {
    // Ignore storage failures so refresh recovery never blocks the UI.
  }
}

function normalizeArchiveSettings(settings: unknown): ArchiveSettings {
  if (!settings || typeof settings !== 'object') return { ...defaultArchiveSettings, homeHeroItems: [...defaultHomeHeroItems] }
  const record = settings as Partial<ArchiveSettings>
  const legacyHomeHeroDetailId = typeof record.homeHeroDetailId === 'string' && record.homeHeroDetailId.trim()
    ? record.homeHeroDetailId
    : defaultArchiveSettings.homeHeroDetailId!
  const rawHomeHeroItems = Array.isArray(record.homeHeroItems)
    ? record.homeHeroItems
    : [{ id: 'hero-1', itemId: legacyHomeHeroDetailId }, ...defaultHomeHeroItems.filter((entry) => entry.itemId !== legacyHomeHeroDetailId)]
  const homeHeroItems = rawHomeHeroItems
    .filter((entry) => Boolean(entry) && typeof entry === 'object')
    .map((entry) => entry as Partial<HomeHeroExhibitConfig>)
    .map((entry, index) => ({
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id : `hero-${index + 1}`,
      itemId: typeof entry.itemId === 'string' && entry.itemId.trim() ? entry.itemId : defaultHomeHeroItems[index % defaultHomeHeroItems.length].itemId,
    }))
    .filter((entry, index, entries) => entry.itemId && entries.findIndex((candidate) => candidate.id === entry.id) === index)

  const normalizedHomeHeroItems = homeHeroItems.length ? homeHeroItems : [...defaultHomeHeroItems]
  const homeHeroDetailId = normalizedHomeHeroItems[0]?.itemId ?? legacyHomeHeroDetailId

  return {
    ...defaultArchiveSettings,
    homeHeroDetailId,
    homeHeroItems: normalizedHomeHeroItems,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

function isArchiveSettingsNewer(left?: ArchiveSettings, right?: ArchiveSettings) {
  const leftTime = Date.parse(left?.updatedAt ?? '')
  const rightTime = Date.parse(right?.updatedAt ?? '')
  if (!Number.isFinite(leftTime)) return false
  if (!Number.isFinite(rightTime)) return true
  return leftTime > rightTime
}

function mergeArchiveSettingsWithLocal(serverSettings: ArchiveSettings | undefined, localSettings: ArchiveSettings | undefined) {
  const normalizedServerSettings = normalizeArchiveSettings(serverSettings)
  const normalizedLocalSettings = normalizeArchiveSettings(localSettings)
  return isArchiveSettingsNewer(normalizedLocalSettings, normalizedServerSettings) ? normalizedLocalSettings : normalizedServerSettings
}

function readRuntimeArchiveSnapshot(): RuntimeArchiveSnapshot {
  if (typeof window === 'undefined') return { items: [], assets: [], bookSources: [], bookPages: [], feedbacks: [], settings: defaultArchiveSettings }

  try {
    const raw = window.localStorage.getItem(runtimeArchiveKey)
    if (!raw) return { items: [], assets: [], bookSources: [], bookPages: [], feedbacks: [], settings: defaultArchiveSettings }
    const snapshot = JSON.parse(raw) as Partial<RuntimeArchiveSnapshot>
    return {
      items: Array.isArray(snapshot.items) ? snapshot.items : [],
      assets: Array.isArray(snapshot.assets) ? snapshot.assets : [],
      bookSources: Array.isArray(snapshot.bookSources) ? snapshot.bookSources.filter(isBookSourceRecord) : [],
      bookPages: Array.isArray(snapshot.bookPages) ? snapshot.bookPages.filter(isBookPageRecord) : [],
      feedbacks: Array.isArray(snapshot.feedbacks) ? snapshot.feedbacks.filter(isArchiveFeedbackRecord) : [],
      settings: normalizeArchiveSettings(snapshot.settings),
    }
  } catch {
    return { items: [], assets: [], bookSources: [], bookPages: [], feedbacks: [], settings: defaultArchiveSettings }
  }
}

function writeRuntimeArchiveSnapshot(snapshot: RuntimeArchiveSnapshot) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(runtimeArchiveKey, JSON.stringify(snapshot))
}

function readNotificationReadAt() {
  if (typeof window === 'undefined') return 0

  try {
    const raw = window.localStorage.getItem(notificationReadAtKey)
    if (!raw) return 0
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function writeNotificationReadAt(value: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(notificationReadAtKey, String(value))
}

function readBooleanMapState(key: string): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  } catch {
    return {}
  }
}

function writeBooleanMapState(key: string, value: Partial<Record<string, boolean>>) {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(
    key,
    JSON.stringify(Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))),
  )
}

function readGalleryPerPage() {
  if (typeof window === 'undefined') return 24

  try {
    const value = Number(window.localStorage.getItem(galleryPerPageStateKey))
    return [24, 48, 96].includes(value) ? value : 24
  } catch {
    return 24
  }
}

function writeGalleryPerPage(value: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(galleryPerPageStateKey, String(value))
}

function isGalleryOcrEntry(value: unknown): value is GalleryOcrEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<GalleryOcrEntry>
  return (
    (record.status === 'queued' || record.status === 'processing' || record.status === 'done' || record.status === 'failed') &&
    typeof record.text === 'string'
  )
}

function readGalleryOcrCache(): Record<string, GalleryOcrEntry> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(galleryOcrCacheKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, GalleryOcrEntry] => isGalleryOcrEntry(entry[1])))
  } catch {
    return {}
  }
}

function writeGalleryOcrCache(cache: Record<string, GalleryOcrEntry>) {
  if (typeof window === 'undefined') return

  const entries = Object.entries(cache)
    .sort((left, right) => Date.parse(right[1].updatedAt ?? '') - Date.parse(left[1].updatedAt ?? ''))
    .slice(0, 300)
  window.localStorage.setItem(galleryOcrCacheKey, JSON.stringify(Object.fromEntries(entries)))
}

function writeClipboardTextWithTextarea(text: string) {
  if (typeof document === 'undefined') return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'

  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, text.length)

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

async function writeClipboardText(text: string) {
  if (writeClipboardTextWithTextarea(text)) return true

  if (!navigator.clipboard?.writeText) return false

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function installRuntimeArchiveSnapshot(snapshot: RuntimeArchiveSnapshot) {
  snapshot.items.forEach((item) => {
    const existingIndex = collectionItems.findIndex((entry) => entry.id === item.id)
    if (existingIndex >= 0) {
      collectionItems[existingIndex] = item
    } else {
      collectionItems.unshift(item)
    }
  })
  snapshot.assets.forEach((asset) => {
    const existingIndex = assets.findIndex((entry) => entry.id === asset.id)
    if (existingIndex >= 0) {
      assets[existingIndex] = asset
    } else {
      assets.unshift(asset)
    }
  })
}

function mergeRuntimeArchiveSnapshots(...snapshots: RuntimeArchiveSnapshot[]): RuntimeArchiveSnapshot {
  const mergedItems = new Map<string, CollectionItem>()
  const mergedAssets = new Map<string, Asset>()
  const mergedBookSources = new Map<string, BookSource>()
  const mergedBookPages = new Map<string, BookPage>()
  const mergedFeedbacks = new Map<string, ArchiveFeedback>()

  snapshots.forEach((snapshot) => {
    snapshot.items.forEach((item) => mergedItems.set(item.id, item))
    snapshot.assets.forEach((asset) => mergedAssets.set(asset.id, asset))
    snapshot.bookSources.forEach((source) => mergedBookSources.set(source.id, source))
    snapshot.bookPages.forEach((page) => mergedBookPages.set(page.id, page))
    snapshot.feedbacks.forEach((feedback) => mergedFeedbacks.set(feedback.id, feedback))
  })

  return {
    items: Array.from(mergedItems.values()),
    assets: Array.from(mergedAssets.values()),
    bookSources: Array.from(mergedBookSources.values()),
    bookPages: Array.from(mergedBookPages.values()),
    feedbacks: Array.from(mergedFeedbacks.values()).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    settings: normalizeArchiveSettings(snapshots.reduce((settings, snapshot) => ({ ...settings, ...snapshot.settings }), defaultArchiveSettings)),
  }
}

function formatNotificationTimeLabel(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '刚刚'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 60 * 60_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  if (diff < 24 * 60 * 60_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

function buildAppNotifications(snapshot: RuntimeArchiveSnapshot): AppNotification[] {
  const feedbackNotifications = snapshot.feedbacks
    .filter((feedback) => feedback.status !== 'resolved')
    .slice(0, 2)
    .map((feedback) => {
      const createdAt = Date.parse(feedback.createdAt) || Date.now()
      return {
        id: `feedback-${feedback.id}`,
        kind: 'review' as const,
        title: '待处理反馈',
        body: `${feedback.itemTitle || '未命名资料'} · ${feedback.feedbackType}`,
        timeLabel: formatNotificationTimeLabel(createdAt),
        actionView: 'admin' as View,
        createdAt,
      }
    })

  const duplicateGroups = getDuplicateSourceGroups(snapshot.items)
  const duplicateNotification = duplicateGroups.length
    ? [{
        id: `duplicates-${duplicateGroups[0].sourceUrl}`,
        kind: 'review' as const,
        title: '疑似重复资料',
        body: `${duplicateGroups[0].items.length} 条资料共用相近来源`,
        timeLabel: '最近更新',
        actionView: 'admin' as View,
        createdAt: Math.max(
          ...duplicateGroups[0].items.map((item) => Date.parse(item.updatedAt || item.createdAt || '') || 0),
          Date.now(),
        ),
      }]
    : []

  const hiddenCount = snapshot.items.filter((item) => item.status === 'hidden').length
  const deletedCount = snapshot.items.filter((item) => item.status === 'deleted').length
  const archiveNotification =
    hiddenCount + deletedCount > 0
      ? [{
          id: 'archive-status',
          kind: 'sync-error' as const,
          title: '资料状态更新',
          body: `${hiddenCount} 条已隐藏，${deletedCount} 条已删除`,
          timeLabel: '当前',
          actionView: 'admin' as View,
          createdAt: Date.now(),
        }]
      : []

  const notifications = [...feedbackNotifications, ...duplicateNotification, ...archiveNotification]
  if (notifications.length) return notifications.slice(0, 4)

  return [
    {
      id: 'no-notices',
      kind: 'success' as const,
      title: '暂无新通知',
      body: '当前没有待处理反馈或异常状态',
      timeLabel: '刚刚',
      actionView: 'library' as View,
      createdAt: 0,
    },
  ]
}

function stableHash(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0
  }
  return Math.abs(hash).toString(36)
}

function toText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function toOptionalNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsedValue = Number(value)
    return Number.isFinite(parsedValue) ? parsedValue : undefined
  }
  return undefined
}

function extractFirstUrl(value: string) {
  return value.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? ''
}

function isArchiveItemStatus(value: unknown): value is CollectionItem['status'] {
  return value === 'draft' || value === 'active' || value === 'hidden' || value === 'deleted'
}

function isArchiveItemVisible(item: CollectionItem) {
  return item.status === 'active'
}

function getItemAssets(item: CollectionItem, extraAssets: Asset[] = []) {
  const assetPool = extraAssets.length ? [...assets, ...extraAssets] : assets
  const imageIds = item.imageIds.filter(Boolean)
  const imageIdAssets = imageIds.map((id) => assetPool.find((asset) => asset.id === id)).filter(Boolean) as Asset[]
  if (imageIds.length) return imageIdAssets

  const matchedAssets = assetPool.filter((asset) => asset.linkedItemId === item.id)
  return Array.from(new Map(matchedAssets.map((asset) => [asset.id, asset])).values())
}

function getAssetLinkedItem(asset: Asset) {
  return (
    collectionItems.find((item) => item.id === asset.linkedItemId) ??
    collectionItems.find((item) => item.imageIds.includes(asset.id))
  )
}

function getItemImageCount(item: CollectionItem) {
  return getItemAssets(item).length
}

function getItemSourceUrl(item: CollectionItem) {
  return item.sourceUrl || extractFirstUrl(item.shortNote) || extractFirstUrl(item.extraNote ?? '')
}

function getEditorSourceEntry(item: CollectionItem) {
  return item.sourceUrl || item.tags.find((tag) => tag.includes('·') || /书|志|经|传/.test(tag)) || ''
}

function buildArchivePayloadFromItem(item: CollectionItem, updates: Partial<ArchiveEditorPayload> = {}): ArchiveEditorPayload {
  const savedAt = new Date()
  const itemType = getItemType(item)
  const itemCategories = getItemCategories(item)

  return {
    mode: 'edit',
    sourceItemId: item.id,
    type: itemType,
    title: item.title,
    summary: item.summary,
    note: item.shortNote,
    extraNote: item.extraNote ?? '',
    categories: {
      时代: item.period,
      物品类型: itemType,
      物品类别: itemCategories.join('、'),
      身份类型: item.identityTypes.join('、'),
      职官类型: item.officialTypes.join('、'),
      服装类别: itemCategories.join('、'),
      来源类型: item.sourceTypes.join('、'),
      参考性质: item.referencePurposes.join('、'),
      使用用途: getStandardUsageHints(item.usageHints).join('、'),
      标签: item.tags.join('、'),
    },
    assetIds: item.imageIds,
    assets: getItemAssets(item),
    sourceUrl: item.sourceUrl,
    sourceRefs: item.sourceRefs ?? [],
    timelineEnabled: item.timelineEnabled === true,
    timelineLabel: item.timelineLabel ?? '',
    startYear: item.startYear,
    endYear: item.endYear,
    timelineWeight: item.timelineWeight,
    createdBy: item.createdBy,
    savedAt: savedAt.toISOString(),
    savedAtLabel: savedAt.toLocaleTimeString('zh-CN', { hour12: false }),
    ...updates,
  }
}

function normalizeDuplicateSourceUrl(value: string) {
  const text = value.trim()
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

function isDuplicateSuspect(item: CollectionItem) {
  if (item.status !== 'active') return false
  const sourceUrl = normalizeDuplicateSourceUrl(getItemSourceUrl(item))
  if (!sourceUrl) return false

  return collectionItems.some((entry) => (
    entry.id !== item.id &&
    entry.status === 'active' &&
    normalizeDuplicateSourceUrl(getItemSourceUrl(entry)) === sourceUrl
  ))
}

function getDuplicateSourceGroups(items: CollectionItem[]) {
  const groups = new Map<string, CollectionItem[]>()

  items.forEach((item) => {
    if (item.status !== 'active') return
    const sourceUrl = normalizeDuplicateSourceUrl(getItemSourceUrl(item))
    if (!sourceUrl) return
    groups.set(sourceUrl, [...(groups.get(sourceUrl) ?? []), item])
  })

  return Array.from(groups.entries())
    .map(([sourceUrl, groupItems]) => ({
      sourceUrl,
      items: [...groupItems].sort((left, right) => {
        const leftDate = Date.parse(left.createdAt ?? left.updatedAt)
        const rightDate = Date.parse(right.createdAt ?? right.updatedAt)
        return (Number.isFinite(leftDate) ? leftDate : 0) - (Number.isFinite(rightDate) ? rightDate : 0)
      }),
    }))
    .filter((group) => group.items.length > 1)
}

function getWebClipSourceCandidates(clipImport: WebClipImport) {
  return uniqueValues([
    clipImport.normalizedUrl,
    clipImport.inputUrl,
    clipImport.sourceDraft?.sourceUrl,
    ...(clipImport.extractedFields ?? []).flatMap((field) => [field.value, extractFirstUrl(field.value)]),
    ...clipImport.extractedImages.flatMap((image) => [image.sourceUrl, image.imageUrl]),
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeDuplicateSourceUrl)
    .filter(Boolean))
}

function getItemSourceCandidates(item: CollectionItem) {
  return uniqueValues([
    item.sourceUrl,
    extractFirstUrl(item.shortNote),
    extractFirstUrl(item.extraNote ?? ''),
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeDuplicateSourceUrl)
    .filter(Boolean))
}

function findWebClipExistingItem(clipImport: WebClipImport | null, items: CollectionItem[]) {
  if (!clipImport || clipImport.status === 'failed') return null
  const sourceUrls = new Set(getWebClipSourceCandidates(clipImport))
  if (!sourceUrls.size) return null
  return items.find((item) => item.status === 'active' && getItemSourceCandidates(item).some((sourceUrl) => sourceUrls.has(sourceUrl))) ?? null
}

function getStatusLabel(status: CollectionItem['status']) {
  if (status === 'draft') return '草稿'
  if (status === 'hidden') return '已隐藏'
  if (status === 'deleted') return '已删除'
  return '正常展示'
}

function formatItemDate(value?: string) {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN')
}

function splitCategoryValue(value: unknown) {
  return toText(value)
    .split(/[、,，;；\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function categoryList(categories: Record<string, unknown>, key: string, fallback: string[]) {
  const values = splitCategoryValue(categories[key])
  return values.length ? values : fallback
}

function resolvePeriod(value: unknown): Period {
  const period = toText(value) as Period
  return (filterGroups.period as readonly string[]).includes(period) ? period : collectionItems[0].period
}

function isAssetRecord(value: unknown): value is Asset {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<Asset>
  return typeof record.id === 'string' && typeof record.caption === 'string' && typeof record.linkedItemId === 'string'
}

function isBookSourceRecord(value: unknown): value is BookSource {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<BookSource>
  return typeof record.id === 'string' && typeof record.title === 'string' && typeof record.sourceType === 'string'
}

function isBookPageRecord(value: unknown): value is BookPage {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<BookPage>
  return (
    typeof record.id === 'string' &&
    typeof record.bookSourceId === 'string' &&
    typeof record.pageNumber === 'string' &&
    typeof record.imagePath === 'string' &&
    Array.isArray(record.keywords) &&
    Array.isArray(record.linkedArchiveItemIds)
  )
}

function isArchiveFeedbackRecord(value: unknown): value is ArchiveFeedback {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ArchiveFeedback>
  return (
    typeof record.id === 'string' &&
    typeof record.itemId === 'string' &&
    typeof record.feedbackType === 'string' &&
    typeof record.message === 'string' &&
    typeof record.createdAt === 'string'
  )
}

function isArchiveItemSourceRefRecord(value: unknown): value is ArchiveItemSourceRef {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ArchiveItemSourceRef>
  return (
    typeof record.sourceId === 'string' &&
    (record.pageIds === undefined || Array.isArray(record.pageIds)) &&
    (record.pageNumberText === undefined || typeof record.pageNumberText === 'string') &&
    (record.quoteText === undefined || typeof record.quoteText === 'string') &&
    (record.note === undefined || typeof record.note === 'string')
  )
}

function mapArchiveApiRecord(record: ArchiveApiRecord): CollectionItem | null {
  const id = toText(record.id)
  const title = toText(record.title)

  if (!id || !title) return null

  const categories = record.categories && typeof record.categories === 'object'
    ? record.categories as Record<string, unknown>
    : {}
  const type = toText(record.type)
  const summary = toText(record.summary)
  const note = toText(record.note)
  const extraNote = toText(record.extraNote)
  const savedAt = toText(record.updatedAt) || toText(record.savedAt) || new Date().toISOString()
  const assetIds = Array.isArray(record.assetIds) ? record.assetIds.filter((assetId): assetId is string => typeof assetId === 'string') : []
  const sourceTypes = categoryList(categories, '来源类型', [type || '团队资料库'])
  const referencePurposes = categoryList(categories, '参考性质', ['研究线索'])
  const usageHints = categoryList(categories, '使用用途', ['资料整理'])
  const tags = categoryList(categories, '标签', [type].filter(Boolean))
  const itemType = toText(categories['物品类型']) || type || '未分类'
  const itemCategories = categoryList(
    categories,
    '物品类别',
    categoryList(categories, '服装类别', [itemType || '待分类']),
  )

  return {
    id,
    title,
    summary: summary || note || '团队同步资料，等待补充摘要。',
    shortNote: note || summary || '团队同步资料，等待补充说明。',
    extraNote,
    period: resolvePeriod(categories['时代']),
    itemType,
    identityTypes: categoryList(categories, '身份类型', ['待分类']),
    officialTypes: categoryList(categories, '职官类型', ['未分类']),
    costumeCategories: itemCategories,
    regions: ['团队资料库'],
    sourceTypes,
    referencePurposes,
    usageHints,
    tags,
    imageIds: assetIds,
    sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs.filter(isArchiveItemSourceRefRecord) : [],
    sourceUrl: toText(record.sourceUrl) || extractFirstUrl(note) || extractFirstUrl(extraNote),
    startYear: toOptionalNumber(record.startYear),
    endYear: toOptionalNumber(record.endYear),
    timelineLabel: toText(record.timelineLabel) || undefined,
    timelineEnabled: typeof record.timelineEnabled === 'boolean' ? record.timelineEnabled : undefined,
    timelineWeight: toOptionalNumber(record.timelineWeight),
    updatedAt: savedAt.slice(0, 10),
    createdAt: toText(record.createdAt) || toText(record.savedAt),
    createdBy: toText(record.createdBy) || 'Web Clipper',
    status: isArchiveItemStatus(record.status) ? record.status : 'active',
  }
}

function createSlug(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/https?:\/\//g, '')
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72) || `web-clip-${Date.now()}`
  )
}

function buildArchiveRecordFromWebClip(clipImport: WebClipImport): RuntimeArchiveSnapshot {
  const now = new Date()
  const title =
    clipImport.translationZh?.title ||
    clipImport.itemDraft?.title ||
    clipImport.pageTitle ||
    clipImport.normalizedUrl ||
    clipImport.inputUrl
  const originalSummary = clipImport.summary || clipImport.pageDescription || clipImport.extractedText || ''
  const summary = clipImport.translationZh?.summary || originalSummary || '网页采集资料，待补充摘要。'
  const fullNote = originalSummary || summary
  const itemId = `web-${createSlug(title)}-${now.getTime()}`
  const selectedImages = clipImport.extractedImages.filter((image) => image.selected && image.downloadStatus !== 'failed')
  const sourceType = getStandardSourceTypes([clipImport.suggestedSourceType, clipImport.sourceDraft?.sourceType, '网络资料'])[0] ?? '网络资料'
  const referencePurposes = clipImport.suggestedReferencePurpose?.length
    ? clipImport.suggestedReferencePurpose
    : clipImport.sourceDraft?.referencePurposes?.length
      ? clipImport.sourceDraft.referencePurposes
      : ['研究线索']
  const usageHints = clipImport.suggestedUsageHints?.length
    ? clipImport.suggestedUsageHints
    : clipImport.sourceDraft?.usageHints?.length
      ? clipImport.sourceDraft.usageHints
      : ['资料线索']
  const tags = uniqueValues([
    ...(clipImport.suggestedTags ?? []),
    clipImport.suggestedCollectionType ?? '',
    clipImport.platform ?? '',
    '网页采集',
  ].filter((value): value is string => Boolean(value)))

  const createdAssets = selectedImages.map((image, index): Asset => ({
    id: `${itemId}-img-${index + 1}`,
    caption: image.caption || image.altText || `${title} 图 ${index + 1}`,
    imageType: '网页采集图片',
    sourceType,
    referencePurpose: referencePurposes[0] ?? '研究线索',
    tags,
    svnPath: '',
    tile: index % 8,
    linkedItemId: itemId,
    imageUrl: image.imageUrl,
    thumbnailUrl: image.thumbnailUrl ?? image.imageUrl,
    sourceUrl: image.sourceUrl ?? clipImport.normalizedUrl ?? clipImport.inputUrl,
    downloadStatus: image.downloadStatus,
  }))

  const imageIds = createdAssets.map((asset) => asset.id)
  const item: CollectionItem = {
    id: itemId,
    title,
    summary,
    shortNote: fullNote,
    extraNote: [
      clipImport.translationZh && originalSummary && summary !== originalSummary ? `原文摘要：${originalSummary}` : '',
      clipImport.normalizedUrl ? `来源链接：${clipImport.normalizedUrl}` : '',
      clipImport.usageRestriction ? `使用限制：${clipImport.usageRestriction}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    period: collectionItems[0].period,
    timelineEnabled: false,
    identityTypes: ['待分类'],
    officialTypes: ['未分类'],
    costumeCategories: [clipImport.suggestedCollectionType || '网页资料'],
    regions: [clipImport.platform || '网页来源'],
    sourceTypes: [sourceType],
    referencePurposes,
    usageHints,
    tags,
    imageIds,
    sourceUrl: clipImport.normalizedUrl ?? clipImport.inputUrl,
    createdAt: now.toISOString(),
    createdBy: clipImport.createdBy,
    updatedAt: now.toISOString().slice(0, 10),
    status: 'active',
  }

  return { items: [item], assets: createdAssets, bookSources: [], bookPages: [], feedbacks: [], settings: defaultArchiveSettings }
}

const broadIdentityTypeValues = new Set(filterGroups.identityTypes)
const normalizeOfficialTypeOption = (value: string) => broadIdentityTypeValues.has(value) ? '' : value
const archiveItemTypeOptions = ['服装服饰', '甲胄冠帽', '器物工艺', '壁画图像', '建筑空间', '纹样材质'] as const
const itemTypeRules: Array<{ value: string; keywords: string[] }> = [
  { value: '建筑空间', keywords: ['建筑', '建筑模型', '楼阁', '楼', '阙', '望楼', '城池', '宫殿', '墓葬空间', 'watchtower', 'tower', 'palace'] },
  { value: '器物工艺', keywords: ['器物', '青铜', '铜器', '陶器', '陶俑', '漆器', '玉器', '香炉', '鼎', '壶', '兵器', '带钩', '车马器', 'bronze', 'jade'] },
  { value: '壁画图像', keywords: ['画像', '画像砖', '壁画', '墓室图像', '拓片', '文献插图', 'mural', 'relief'] },
  { value: '甲胄冠帽', keywords: ['甲胄', '铠甲', '札甲', '短甲', '盔', '冠帽', '头冠', '官帽', '武官冠', '赤幞', '赤帻', '平上帻', '帻', '冠饰', '羽饰', '羽毛', 'helmet', 'armor'] },
  { value: '纹样材质', keywords: ['纹样', '云气纹', '织锦', '边饰', '材质', '织物', 'pattern', 'textile'] },
  { value: '服装服饰', keywords: ['服装', '服饰', '袍服', '深衣', '常服', '衣褶', '衣', '袍', '腰带', '鞋履', '披挂', 'robe', 'costume'] },
]
const categoryItemTypeRules: Array<{ value: string; categories: string[] }> = [
  { value: '建筑空间', categories: ['建筑', '城池', '宫殿', '楼阁', '墓葬空间', '建筑构件', '室内陈设'] },
  { value: '器物工艺', categories: ['器物', '陶俑', '青铜器', '兵器', '生活器物', '车马器', '带钩', '漆器', '玉器'] },
  { value: '壁画图像', categories: ['画像砖', '壁画', '拓片', '墓室图像', '文献插图', '陶俑图像'] },
  { value: '甲胄冠帽', categories: ['甲胄', '铠甲', '札甲', '短甲', '盔', '武冠', '冠帽', '头冠', '官帽', '帻', '赤幞', '赤帻', '平上帻'] },
  { value: '纹样材质', categories: ['纹样', '织锦', '云气纹', '边饰', '色彩', '材质'] },
  { value: '服装服饰', categories: ['服装', '服饰', '袍服', '深衣', '常服', '冠帽', '头冠', '官帽', '帻', '披挂', '腰带', '鞋履'] },
]

function isArchiveItemType(value: string) {
  return (archiveItemTypeOptions as readonly string[]).includes(value)
}

function inferItemTypeFromCategories(categories: string[]) {
  const normalizedCategories = categories.map((category) => category.trim()).filter(Boolean)
  const exactMatch = categoryItemTypeRules.find((rule) => (
    rule.categories.some((category) => normalizedCategories.includes(category))
  ))
  if (exactMatch) return exactMatch.value

  const fuzzyMatch = categoryItemTypeRules.find((rule) => (
    rule.categories.some((category) => normalizedCategories.some((value) => value.includes(category) || category.includes(value)))
  ))
  return fuzzyMatch?.value ?? ''
}

function inferItemTypeFromValues(values: string[], fallback = '未分类') {
  const text = values.filter(Boolean).join(' ').toLowerCase()
  if (!text) return fallback

  let bestType = fallback
  let bestScore = 0
  itemTypeRules.forEach((rule) => {
    const score = rule.keywords.reduce((total, keyword) => (
      text.includes(keyword.toLowerCase()) ? total + keyword.length : total
    ), 0)
    if (score > bestScore) {
      bestScore = score
      bestType = rule.value
    }
  })

  return bestType
}

function getItemType(item: CollectionItem) {
  const categoryType = inferItemTypeFromCategories(item.costumeCategories)
  if (categoryType) return categoryType

  const explicitType = item.itemType?.trim() ?? ''
  if (isArchiveItemType(explicitType)) return explicitType

  return inferItemTypeFromValues([
    item.title,
    item.summary,
    item.shortNote,
    item.extraNote ?? '',
    ...item.costumeCategories,
    ...item.sourceTypes,
    ...item.referencePurposes,
    ...item.usageHints,
    ...item.tags,
  ], item.costumeCategories[0] || '未分类')
}

function getItemCategories(item: CollectionItem) {
  const categories = item.costumeCategories.filter((category) => !['网页资料', '团队资料库', '待分类', '未分类'].includes(category))
  return uniqueValues([...(categories.length ? categories : [getItemType(item)]), ...categories].filter(Boolean))
}

function getDetailSupportNote(item: CollectionItem) {
  const text = [
    item.title,
    item.summary,
    item.shortNote,
    item.extraNote ?? '',
    ...item.costumeCategories,
    ...item.tags,
  ].join(' ')

  if (/Bi disc, made of yellow-white jade\. Remains of three dragon ornament on the edge\./i.test(text)) {
    return '玉璧，由黄白色玉制成。边缘残留三条龙纹装饰。'
  }

  const itemType = getItemType(item)
  if (itemType === '器物工艺') {
    return '本条目综合馆藏说明、材质、纹饰与出土或传世信息，提供器物形制、工艺细节和图像转化参考。'
  }
  if (itemType === '建筑空间') {
    return '本条目综合建筑形制、空间结构与图像资料，提供场景复原、比例关系和构件细节参考。'
  }
  if (itemType === '壁画图像') {
    return '本条目综合图像题材、人物关系与时代线索，提供画面内容、服饰形象和视觉证据参考。'
  }
  if (itemType === '纹样材质') {
    return '本条目综合纹样、材质和工艺线索，提供装饰结构、色彩关系与材质表现参考。'
  }
  if (itemType === '甲胄冠帽') {
    return '本条目综合冠帽、甲胄或头部装饰资料，提供身份识别、形制结构和角色设定参考。'
  }

  return '本条目综合文献记录、图像资料与考古出土形象，提供服装轮廓、细节与穿搭理解参考。'
}

const officialTypeOptions = uniqueValues([
  ...collectionItems.flatMap((item) => item.officialTypes).filter((value) => !broadIdentityTypeValues.has(value)),
  '中央官',
  '州郡官',
  '郡县官',
  '将军',
  '军吏',
  '无明确官职',
  '未分类',
  '待分类',
])

const standardUsageHintOptions = ['造型参考', '图像参考', '结构参考', '纹样材质', '场景参考', '资料线索'] as const
type StandardUsageHint = (typeof standardUsageHintOptions)[number]
const standardReferenceUsageOptions = ['史实依据', '研究线索', '形制结构参考', '造型参考', '纹样材质参考', '图像表现参考', '复原设计参考', '场景参考'] as const
type StandardReferenceUsage = (typeof standardReferenceUsageOptions)[number]

type CategoryFacetGroup = {
  label: string
  options: string[]
  aliases?: string[]
  optionAliases?: Record<string, string[]>
}

const categoryFacetGroups: CategoryFacetGroup[] = [
  {
    label: '服饰',
    aliases: ['服装', '服装服饰'],
    options: ['袍服', '腰带', '鞋履', '发式', '配饰'],
    optionAliases: {
      配饰: ['服饰配件', '带钩'],
    },
  },
  {
    label: '甲胄',
    aliases: ['甲衣'],
    options: ['铠甲', '甲片 / 构件', '护具'],
    optionAliases: {
      '甲片 / 构件': ['甲片', '甲胄构件', '局部甲件', '札甲', '短甲'],
      护具: ['披挂', '护臂', '护腿'],
    },
  },
  {
    label: '冠帽',
    aliases: ['头冠', '官帽', '头饰', '武冠'],
    options: ['冠', '弁', '帻', '巾'],
    optionAliases: {
      冠: ['礼冠', '官帽', '进贤冠类', '武冠', '头冠'],
      帻: ['平上帻类', '头巾 / 帻'],
      巾: ['头巾'],
    },
  },
  {
    label: '器物',
    aliases: ['器物工艺'],
    options: ['青铜器', '玉器', '漆器', '陶俑', '兵器', '车马器', '生活器物'],
  },
  {
    label: '图像',
    aliases: ['壁画 / 图像', '壁画图像', '图像资料'],
    options: ['壁画', '画像砖', '画像石', '墓室图像', '文献插图'],
    optionAliases: {
      画像石: ['拓片'],
      墓室图像: ['墓葬图像'],
      文献插图: ['书籍插图'],
    },
  },
  {
    label: '建筑',
    aliases: ['建筑空间'],
    options: ['宫殿', '楼阁', '城池', '墓葬空间', '建筑构件'],
    optionAliases: {
      建筑构件: ['室内陈设'],
    },
  },
  {
    label: '纹样',
    aliases: ['纹样材质'],
    options: ['云气纹', '边饰', '织锦', '几何纹', '材质肌理'],
    optionAliases: {
      材质肌理: ['材质', '肌理', '色彩', '织物'],
    },
  },
]

const categoryPrimaryValues = new Set(categoryFacetGroups.map((group) => group.label))
const categorySourceOnlyValues = new Set(['网页资料', '俑藏资料', '团队资料库', '研究线索', '资料线索', '角色设定', '轮廓参考', '材质参考', '待分类', '未分类'])
const categoryFacetOptions = categoryFacetGroups.flatMap((group) => [group.label, ...group.options])

function categoryOptionMatches(value: string, option: string, aliases: string[] = []) {
  const normalizedValue = value.trim()
  if (!normalizedValue || categorySourceOnlyValues.has(normalizedValue)) return false
  return [option, ...aliases].some((candidate) => (
    normalizedValue === candidate || normalizedValue.includes(candidate) || candidate.includes(normalizedValue)
  ))
}

function getCategoryFacetGroupForValue(value: string) {
  return categoryFacetGroups.find((group) => (
    categoryOptionMatches(value, group.label, group.aliases) ||
    group.options.some((option) => categoryOptionMatches(value, option, group.optionAliases?.[option]))
  ))
}

function getItemCategoryFacetValues(item: CollectionItem) {
  const rawCategories = getItemCategories(item)
  const values = new Set<string>()

  rawCategories.forEach((category) => {
    if (categorySourceOnlyValues.has(category)) return
    categoryFacetGroups.forEach((group) => {
      if (categoryOptionMatches(category, group.label, group.aliases)) {
        values.add(group.label)
      }
      group.options.forEach((option) => {
        if (categoryOptionMatches(category, option, group.optionAliases?.[option])) {
          values.add(group.label)
          values.add(option)
        }
      })
    })
  })

  if (!values.size) {
    const inferredGroup = getCategoryFacetGroupForValue(getItemType(item))
    if (inferredGroup) values.add(inferredGroup.label)
  }

  return [...values]
}

function itemMatchesCategoryFilters(item: CollectionItem, active: string[]) {
  if (!active.length) return true

  const itemValues = getItemCategoryFacetValues(item)
  const selectedGroups = categoryFacetGroups.filter((group) => active.includes(group.label))
  if (!selectedGroups.length) return active.some((value) => itemValues.includes(value))

  return selectedGroups.some((group) => {
    if (!itemValues.includes(group.label)) return false
    const selectedChildren = group.options.filter((option) => active.includes(option))
    return !selectedChildren.length || selectedChildren.some((option) => itemValues.includes(option))
  })
}

function getCategoryFilterNextValues(current: string[], value: string) {
  if (categoryPrimaryValues.has(value)) {
    const group = categoryFacetGroups.find((entry) => entry.label === value)
    if (!group) return current
    if (current.includes(value)) {
      return current.filter((entry) => entry !== value && !group.options.includes(entry))
    }
    return [...current, value]
  }

  const group = getCategoryFacetGroupForValue(value)
  const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
  if (!group || next.includes(group.label)) return next
  return [group.label, ...next]
}

const usageHintAliasMap: Record<string, readonly StandardUsageHint[]> = {
  轮廓参考: ['造型参考'],
  形制参考: ['造型参考'],
  身份参考: ['造型参考'],
  角色设定: ['造型参考'],
  穿搭理解: ['造型参考'],
  设计转化参考: ['造型参考'],
  视觉灵感参考: ['造型参考'],
  图像表现: ['图像参考'],
  局部细节参考: ['图像参考', '纹样材质'],
  结构参考: ['结构参考'],
  器物参考: ['结构参考'],
  建筑结构参考: ['结构参考'],
  材质参考: ['纹样材质'],
  纹样参考: ['纹样材质'],
  场景参考: ['场景参考'],
  建筑空间参考: ['场景参考'],
  资料线索: ['资料线索'],
  研究线索: ['资料线索'],
  名词参考: ['资料线索'],
  地域参考: ['资料线索'],
  需进一步核实: ['资料线索'],
  需核实: ['资料线索'],
  待核实: ['资料线索'],
  待核实参考: ['资料线索'],
  网页资料: ['资料线索'],
}

function getStandardUsageHints(values: Array<string | undefined>): StandardUsageHint[] {
  const mapped = values.flatMap<StandardUsageHint>((value) => {
    const text = value?.trim()
    if (!text) return []
    if (standardUsageHintOptions.includes(text as StandardUsageHint)) return [text as StandardUsageHint]
    if (usageHintAliasMap[text]) return [...usageHintAliasMap[text]]
    if (/轮廓|穿搭|形制|身份|角色|造型|设计转化|视觉灵感|配色/.test(text)) return ['造型参考']
    if (/图像表现|画像|壁画|构图|姿态|画面|风格/.test(text)) return ['图像参考']
    if (/结构|甲片|构件|器物结构|建筑结构|服装结构|甲胄结构/.test(text)) return ['结构参考']
    if (/纹样|材质|织物|布料|金属|陶器|木构|漆器|肌理|色彩/.test(text)) return ['纹样材质']
    if (/场景|陈设|宴饮|出行|仪仗|生活场景|建筑空间/.test(text)) return ['场景参考']
    if (/资料|线索|核实|待核实|网页|链接|名词|地域/.test(text)) return ['资料线索']
    return []
  })

  return uniqueValues(mapped) as StandardUsageHint[]
}

const referenceUsageAliasMap: Record<string, readonly StandardReferenceUsage[]> = {
  史实依据: ['史实依据'],
  研究线索: ['研究线索'],
  资料线索: ['研究线索'],
  复原参考: ['复原设计参考'],
  设计转化参考: ['复原设计参考'],
  细节工艺参考: ['形制结构参考', '纹样材质参考'],
  图像资料: ['图像表现参考'],
  视觉灵感参考: ['图像表现参考'],
  形制参考: ['形制结构参考'],
  造型参考: ['造型参考'],
  图像参考: ['图像表现参考'],
  结构参考: ['形制结构参考'],
  纹样材质: ['纹样材质参考'],
  场景参考: ['场景参考'],
  文献记录: [],
  待核实参考: [],
}

function getStandardReferenceUsages(referencePurposes: Array<string | undefined>, usageHints: Array<string | undefined>) {
  const mapped = [...referencePurposes, ...getStandardUsageHints(usageHints)].flatMap<StandardReferenceUsage>((value) => {
    const text = value?.trim()
    if (!text) return []
    if (standardReferenceUsageOptions.includes(text as StandardReferenceUsage)) return [text as StandardReferenceUsage]
    if (referenceUsageAliasMap[text]) return referenceUsageAliasMap[text]
    if (/史实|考古|出土|馆藏/.test(text)) return ['史实依据']
    if (/研究|线索|资料/.test(text)) return ['研究线索']
    if (/形制|结构|构件|甲片|器物结构|建筑结构|服装结构|甲胄结构/.test(text)) return ['形制结构参考']
    if (/轮廓|穿搭|身份|角色|造型/.test(text)) return ['造型参考']
    if (/纹样|材质|织物|布料|金属|陶器|木构|漆器|肌理|色彩|工艺|细节/.test(text)) return ['纹样材质参考']
    if (/图像|画像|壁画|视觉|构图|姿态|画面|风格/.test(text)) return ['图像表现参考']
    if (/复原|设计|转化|还原/.test(text)) return ['复原设计参考']
    if (/场景|陈设|宴饮|出行|仪仗|生活场景|建筑空间/.test(text)) return ['场景参考']
    return []
  })

  return uniqueValues(mapped) as StandardReferenceUsage[]
}

function formatStandardReferenceUsages(item: Pick<CollectionItem, 'referencePurposes' | 'usageHints'>, fallback = '研究线索') {
  return getStandardReferenceUsages(item.referencePurposes, item.usageHints).join(' / ') || fallback
}

const facetOptions = {
  itemTypes: uniqueValues([
    ...archiveItemTypeOptions,
    ...collectionItems.map((item) => getItemType(item)),
    '未分类',
  ]),
  period: filterGroups.period,
  identityTypes: filterGroups.identityTypes,
  officialTypes: officialTypeOptions,
  costumeCategories: categoryFacetOptions,
  sourceTypes: sortSourceTypes([...sourceTypePriority, ...collectionItems.flatMap((item) => item.sourceTypes)]),
  referenceUsages: [...standardReferenceUsageOptions],
  referencePurposes: uniqueValues([...filterGroups.referencePurposes, '视觉灵感参考', '待核实参考', '形制参考']),
  usageHints: [...standardUsageHintOptions],
  tags: uniqueValues(collectionItems.flatMap((item) => item.tags)),
} as const

type FilterKey = keyof typeof facetOptions
type FilterState = Record<FilterKey, string[]>
type LibrarySortMode = 'relevance' | 'updated' | 'period'
type HomeFeaturedCardConfig = {
  id: string
  itemId: string
  assetId?: string
  title?: string
  description?: string
  countLabel?: string
}

type HomeFeaturedCard = {
  config: HomeFeaturedCardConfig
  item: CollectionItem
  asset: Asset
  title: string
  description: string
  countLabel: string
  query: string
}

const defaultHomeFeaturedConfig: HomeFeaturedCardConfig[] = [
  {
    id: 'featured-costume',
    itemId: 'han-scholar-robe',
    assetId: 'img-robe-01',
    title: '服装服饰',
    description: '汉服、深衣、袍服等服饰形制与纹样',
    countLabel: '1,248 条资料',
  },
  {
    id: 'featured-armor',
    itemId: 'wei-armor',
    assetId: 'img-armor-01',
    title: '甲胄冠帽',
    description: '铠甲、头盔及相关防护装备资料',
    countLabel: '986 条资料',
  },
  {
    id: 'featured-object',
    itemId: 'jinxian-cap',
    assetId: 'img-cap-01',
    title: '器物工艺',
    description: '青铜器、兵器、生活器物与工艺参考',
    countLabel: '1,537 条资料',
  },
  {
    id: 'featured-mural',
    itemId: 'han-brick-figures',
    assetId: 'img-brick-01',
    title: '壁画图像',
    description: '墓室壁画、画像石与图像资料',
    countLabel: '2,113 条资料',
  },
  {
    id: 'featured-architecture',
    itemId: 'western-jin-portrait-clothing',
    assetId: 'img-pattern-01',
    title: '建筑空间',
    description: '城池、宫殿、楼阁与建筑空间资料',
    countLabel: '732 条资料',
  },
  {
    id: 'featured-pattern',
    itemId: 'wei-civil-robe',
    assetId: 'img-detail-01',
    title: '纹样材质',
    description: '纹样、装饰、材质与工艺资料',
    countLabel: '658 条资料',
  },
]

function isLibrarySortMode(value: unknown): value is LibrarySortMode {
  return value === 'relevance' || value === 'updated' || value === 'period'
}

function readLibrarySortMode(): LibrarySortMode {
  try {
    const storedMode = window.localStorage.getItem(librarySortStateKey)
    return isLibrarySortMode(storedMode) ? storedMode : 'relevance'
  } catch {
    return 'relevance'
  }
}

function writeLibrarySortMode(value: LibrarySortMode) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(librarySortStateKey, value)
  } catch {
    // Ignore storage failures so sorting still works for the current session.
  }
}

function isHomeFeaturedCardConfig(value: unknown): value is HomeFeaturedCardConfig {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<HomeFeaturedCardConfig>
  return typeof record.id === 'string' && typeof record.itemId === 'string'
}

function normalizeHomeFeaturedConfig(
  configs: HomeFeaturedCardConfig[],
  itemPool: CollectionItem[] = collectionItems,
  assetPool: Asset[] = assets,
) {
  return defaultHomeFeaturedConfig.map((fallback) => {
    const stored = configs.find((entry) => entry.id === fallback.id)
    const itemId = itemPool.some((item) => item.id === stored?.itemId) ? stored!.itemId : fallback.itemId
    const item = itemPool.find((entry) => entry.id === itemId) ?? collectionItems.find((entry) => entry.id === itemId) ?? itemPool[0] ?? collectionItems[0]
    const itemAssets = getItemAssets(item, assetPool)
    const fallbackAssetId = itemAssets[0]?.id ?? fallback.assetId
    const storedAssetBelongsToItem = itemAssets.some((asset) => asset.id === stored?.assetId)
    return {
      ...fallback,
      ...stored,
      itemId,
      assetId: storedAssetBelongsToItem ? stored?.assetId : fallbackAssetId,
    }
  })
}

function readHomeFeaturedConfig(): HomeFeaturedCardConfig[] {
  if (typeof window === 'undefined') return defaultHomeFeaturedConfig

  try {
    const raw = window.localStorage.getItem(homeFeaturedStateKey)
    if (!raw) return defaultHomeFeaturedConfig
    const stored = JSON.parse(raw)
    return normalizeHomeFeaturedConfig(Array.isArray(stored) ? stored.filter(isHomeFeaturedCardConfig) : [])
  } catch {
    return defaultHomeFeaturedConfig
  }
}

function writeHomeFeaturedConfig(configs: HomeFeaturedCardConfig[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(homeFeaturedStateKey, JSON.stringify(configs))
}

function resolveHomeFeaturedCards(
  configs: HomeFeaturedCardConfig[],
  itemPool: CollectionItem[] = collectionItems,
  assetPool: Asset[] = assets,
): HomeFeaturedCard[] {
  return normalizeHomeFeaturedConfig(configs, itemPool, assetPool).map((config) => {
    const item = itemPool.find((entry) => entry.id === config.itemId) ?? collectionItems.find((entry) => entry.id === config.itemId) ?? itemPool[0] ?? collectionItems[0]
    const itemAssets = getItemAssets(item, assetPool)
    const itemAsset = itemAssets[0] ?? getItemCover(item.id, itemPool, assetPool)
    const asset = itemAssets.find((entry) => entry.id === config.assetId) ?? itemAsset ?? assets[0]
    const title = item.title
    const description = item.shortNote || item.summary
    const countLabel = config.countLabel?.trim() || `${getItemImageCount(item)} 张图片`
    const query = item.title

    return { config, item, asset, title, description, countLabel, query }
  })
}

function createEmptyFilterState(): FilterState {
  return {
    itemTypes: [],
    period: [],
    identityTypes: [],
    officialTypes: [],
    costumeCategories: [],
    sourceTypes: [],
    referenceUsages: [],
    referencePurposes: [],
    usageHints: [],
    tags: [],
  }
}

function getSearchTerms(query: string) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function getSearchTermVariants(term: string) {
  const variants = [term]
  if (term.includes('帽') && !variants.includes('冠')) variants.push('冠')
  if (term.includes('冠') && !variants.includes('帽')) variants.push('帽')
  return variants
}

function searchValueMatchesTerm(value: string, term: string) {
  const normalizedValue = value.toLowerCase()
  const compactValue = normalizedValue.replace(/\s+/g, '')
  return getSearchTermVariants(term).some((variant) => {
    const normalizedVariant = variant.toLowerCase()
    const compactVariant = normalizedVariant.replace(/\s+/g, '')
    return normalizedValue.includes(normalizedVariant) || Boolean(compactVariant && compactValue.includes(compactVariant))
  })
}

function getLibrarySearchValues(item: CollectionItem) {
  return [
    getArchiveItemCode(item),
    createPublicArchiveId(item.id),
    item.id,
    item.title,
    item.summary,
    item.shortNote,
    item.extraNote ?? '',
    item.period,
    getItemType(item),
    ...getItemCategories(item),
    ...item.identityTypes,
    ...item.officialTypes,
    ...item.regions,
    ...item.sourceTypes,
    ...getStandardSourceTypes(item.sourceTypes),
    ...item.referencePurposes,
    ...item.usageHints,
    ...getStandardUsageHints(item.usageHints),
    ...getStandardReferenceUsages(item.referencePurposes, item.usageHints),
    ...item.tags,
    item.sourceUrl ?? '',
  ].filter(Boolean)
}

function matchesLibraryQuery(item: CollectionItem, query: string) {
  const terms = getSearchTerms(query)
  if (!terms.length) return true

  const searchableValues = getLibrarySearchValues(item).map((value) => value.toLowerCase())
  return terms.every((term) => searchableValues.some((value) => searchValueMatchesTerm(value, term)))
}

function isLiteratureItem(item: CollectionItem) {
  const values = [
    item.title,
    item.summary,
    item.shortNote,
    item.extraNote ?? '',
    ...item.sourceTypes,
    ...item.referencePurposes,
    ...item.usageHints,
    ...item.tags,
  ]
  return values.some((value) => /文献|书籍|史料|论文|图录|舆服志|扫描|OCR/i.test(value))
}

function getLibraryMatchLabels(item: CollectionItem, query: string) {
  const terms = getSearchTerms(query)
  if (!terms.length) return []

  const explainableValues = [
    getItemType(item),
    ...getItemCategories(item),
    ...item.tags,
    ...item.identityTypes,
    ...item.officialTypes,
    item.period,
    ...item.sourceTypes,
    ...getStandardSourceTypes(item.sourceTypes),
    ...item.referencePurposes,
    ...item.usageHints,
    ...getStandardUsageHints(item.usageHints),
    ...getStandardReferenceUsages(item.referencePurposes, item.usageHints),
    ...item.regions,
  ]

  const labels = explainableValues.filter((value, index) => {
    if (!value || explainableValues.indexOf(value) !== index) return false
    return terms.some((term) => searchValueMatchesTerm(value, term))
  })

  if (labels.length) return labels.slice(0, 4)
  if (terms.some((term) => searchValueMatchesTerm(item.title, term))) return ['标题命中']
  if (terms.some((term) => searchValueMatchesTerm(item.summary, term))) return ['摘要命中']
  return []
}

function getCompactArchiveTitle(title: string) {
  return title
    .replace(/\s*[-–—]\s*Google\s+艺术与文化\s*$/i, '')
    .replace(/\s*\|\s*[A-Za-z][^|]*$/u, '')
    .replace(/\s+/g, ' ')
    .trim() || title
}

function getLibrarySearchScore(item: CollectionItem, query: string) {
  const terms = getSearchTerms(query)
  if (!terms.length) return 0

  const groups: Array<{ weight: number; values: string[] }> = [
    { weight: 160, values: [getArchiveItemCode(item), createPublicArchiveId(item.id), item.id] },
    { weight: 120, values: [item.title] },
    { weight: 100, values: [getItemType(item), ...getItemCategories(item), ...item.tags] },
    { weight: 70, values: [item.summary] },
    { weight: 45, values: [item.period, ...item.identityTypes, ...item.officialTypes] },
    { weight: 30, values: [...item.sourceTypes, ...getStandardSourceTypes(item.sourceTypes), ...item.referencePurposes, ...item.usageHints, ...getStandardUsageHints(item.usageHints), ...getStandardReferenceUsages(item.referencePurposes, item.usageHints), ...item.regions] },
    { weight: 10, values: [item.sourceUrl ?? ''] },
  ]

  return terms.reduce((score, term) => {
    const bestWeight = groups.reduce(
      (best, group) => group.values.some((value) => value && searchValueMatchesTerm(value, term)) ? Math.max(best, group.weight) : best,
      0,
    )
    return score + bestWeight
  }, 0)
}

function getItemUpdatedTime(item: CollectionItem) {
  const timestamp = Date.parse(item.updatedAt ?? item.createdAt ?? '')
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function compareLibraryItems(left: CollectionItem, right: CollectionItem, sortMode: LibrarySortMode, query: string) {
  const relevance =
    getLibrarySearchScore(right, query) - getLibrarySearchScore(left, query) ||
    (right.timelineWeight ?? 0) - (left.timelineWeight ?? 0) ||
    (left.startYear ?? 9999) - (right.startYear ?? 9999)

  if (sortMode === 'updated') {
    return getItemUpdatedTime(right) - getItemUpdatedTime(left) || relevance
  }

  if (sortMode === 'period') {
    return (left.startYear ?? 9999) - (right.startYear ?? 9999) || relevance
  }

  return relevance
}

const facetSections: Array<{ key: FilterKey; title: string }> = [
  { key: 'itemTypes', title: '物品类型' },
  { key: 'period', title: '时代' },
  { key: 'identityTypes', title: '身份类型' },
  { key: 'officialTypes', title: '职官类型' },
  { key: 'costumeCategories', title: '物品类别' },
  { key: 'sourceTypes', title: '来源类型' },
  { key: 'referenceUsages', title: '参考用途' },
  { key: 'tags', title: '标签' },
]

const editorCategoryFields = [
  '时代',
  '身份类型',
  '职官类型',
  '服装类别',
  '器物类别',
  '图像类别',
  '建筑类别',
  '纹样类别',
  '来源类型',
  '参考性质',
  '使用用途',
  '标签',
] as const
const officialCategoryField = editorCategoryFields[2]
type EditorCategoryField = (typeof editorCategoryFields)[number]

const editorCategoryOptionMap: Record<EditorCategoryField, string[]> = {
  时代: [...facetOptions.period],
  身份类型: [...facetOptions.identityTypes],
  职官类型: [...facetOptions.officialTypes],
  服装类别: [...facetOptions.costumeCategories],
  器物类别: uniqueValues([...facetOptions.costumeCategories, '陶俑', '青铜器', '兵器', '生活器物', '车马器', '带钩', '漆器', '玉器']),
  图像类别: uniqueValues([...facetOptions.costumeCategories, '画像砖', '壁画', '拓片', '墓室图像', '文献插图', '陶俑图像']),
  建筑类别: uniqueValues([...facetOptions.costumeCategories, '城池', '宫殿', '楼阁', '墓葬空间', '建筑构件', '室内陈设']),
  纹样类别: uniqueValues([...facetOptions.costumeCategories, '纹样', '织锦', '云气纹', '边饰', '色彩', '材质']),
  来源类型: [...facetOptions.sourceTypes],
  参考性质: [...facetOptions.referencePurposes],
  使用用途: [...facetOptions.usageHints],
  标签: [...facetOptions.tags],
}

const editorCategoryInferenceRules: Record<EditorCategoryField, Array<{ value: string; keywords: string[] }>> = {
  时代: [
    { value: '东汉末', keywords: ['汉末', '东汉末年'] },
    { value: '东汉', keywords: ['东汉', '汉代', '后汉'] },
    { value: '魏', keywords: ['曹魏', '魏国'] },
    { value: '蜀', keywords: ['蜀汉', '蜀国'] },
    { value: '吴', keywords: ['孙吴', '吴国'] },
    { value: '三国', keywords: ['三国时期'] },
    { value: '西晋初', keywords: ['西晋', '晋初'] },
  ],
  身份类型: [
    { value: '文官', keywords: ['士大夫', '官吏', '文臣', '郎官', '五官中郎将'] },
    { value: '武官', keywords: ['武将', '将军', '兵士', '军士', '甲士', '武官', '三国演义剧组'] },
    { value: '士人', keywords: ['儒生', '士族'] },
    { value: '侍从 / 仪仗', keywords: ['侍从', '仪仗', '随从'] },
  ],
  职官类型: [
    { value: '文官', keywords: ['士大夫', '官吏', '文臣', '郎官'] },
    { value: '武官', keywords: ['武将', '将军', '兵士', '军士', '甲士', '武官'] },
    { value: '将军', keywords: ['武将', '统帅', '五官中郎将', '中郎将'] },
    { value: '州郡官', keywords: ['州郡', '郡守'] },
    { value: '无明确官职', keywords: ['士人', '陶俑', '画像砖人物'] },
  ],
  服装类别: [
    { value: '甲胄', keywords: ['铠', '铠甲', '甲衣', '札甲', '肩甲', '短甲'] },
    { value: '冠帽', keywords: ['冠', '帽', '帻', '盔', '头部', '头冠', '官帽', '武官冠', '赤幞', '赤帻', '平上帻', '羽毛', '羽饰', '冠饰', '赤壁冠'] },
    { value: '袍服', keywords: ['袍', '衣', '服', '深衣', '常服', '宽袖', '大袖', '戏服', '服化道'] },
    { value: '披挂', keywords: ['披挂', '肩披'] },
    { value: '腰带', keywords: ['带', '腰带', '系带', '带钩'] },
    { value: '纹样', keywords: ['纹', '纹样', '织锦', '云气纹', '装饰'] },
  ],
  器物类别: [
    { value: '陶俑', keywords: ['陶俑', '俑', '厨丁俑'] },
    { value: '青铜器', keywords: ['青铜', '铜器', '鼎', '壶'] },
    { value: '兵器', keywords: ['兵器', '刀', '剑', '戟', '矛'] },
    { value: '生活器物', keywords: ['器皿', '器物', '盘', '碗', '俎', '厨具'] },
    { value: '带钩', keywords: ['带钩', '腰带构件'] },
  ],
  图像类别: [
    { value: '画像砖', keywords: ['画像砖', '砖画'] },
    { value: '壁画', keywords: ['壁画', '墓室壁画'] },
    { value: '拓片', keywords: ['拓片', '拓本'] },
    { value: '文献插图', keywords: ['插图', '图谱'] },
    { value: '陶俑图像', keywords: ['陶俑图像', '俑像'] },
  ],
  建筑类别: [
    { value: '城池', keywords: ['城池', '城墙', '城门'] },
    { value: '宫殿', keywords: ['宫殿', '殿'] },
    { value: '楼阁', keywords: ['楼阁', '楼', '阙', '望楼', 'watchtower', 'tower', 'central watchtower', '建筑模型'] },
    { value: '墓葬空间', keywords: ['墓室', '墓葬'] },
  ],
  纹样类别: [
    { value: '云气纹', keywords: ['云气纹', '云纹'] },
    { value: '织锦', keywords: ['织锦', '锦'] },
    { value: '边饰', keywords: ['边饰', '衣缘'] },
    { value: '材质', keywords: ['材质', '皮革', '织物'] },
  ],
  来源类型: [
    { value: '史料典籍', keywords: ['史料', '典籍', '后汉书', '三国志', '舆服志'] },
    { value: '考古报告', keywords: ['考古', '报告', '出土', '发掘', '简报'] },
    { value: '博物馆 / 馆藏', keywords: ['博物馆', '馆藏', '藏品'] },
    { value: '现代书籍', keywords: ['文献', '书籍', '著作', '舆服志'] },
    { value: '论文研究', keywords: ['论文', '研究', '期刊', '学术'] },
    { value: '网络资料', keywords: ['google 艺术与文化', 'artsandculture.google', '网站', '网页', '网页采集', 'web clip', '小红书', 'xiaohongshu', 'xhs', 'pinterest', '微博', '社交媒体'] },
    { value: '内部整理', keywords: ['整理', '内部'] },
  ],
  参考性质: [
    { value: '史实依据', keywords: ['史实', '考古', '出土', '馆藏'] },
    { value: '图像资料', keywords: ['画像', '壁画', '拓片', '陶俑'] },
    { value: '复原参考', keywords: ['复原', '还原'] },
    { value: '细节工艺参考', keywords: ['细节', '工艺', '材质', '纹样', '结构'] },
    { value: '设计转化参考', keywords: ['设计', '转化', '角色'] },
    { value: '文献记录', keywords: ['文献', '记载', '舆服志'] },
    { value: '视觉灵感参考', keywords: ['剧照', '电视剧', '三国演义', '影视', '服化道'] },
    { value: '待核实参考', keywords: ['小红书', '网页采集', '待核实', '不能随便', '错误', '吐槽'] },
    { value: '形制参考', keywords: ['形制', '冠服', '冠帽', '羽饰'] },
  ],
  使用用途: [
    { value: '造型参考', keywords: ['轮廓', '形制', '冠服', '穿搭', '叠穿', '身份', '角色', '设定', '设计'] },
    { value: '图像参考', keywords: ['画像', '壁画', '图像', '照片', '视觉'] },
    { value: '结构参考', keywords: ['结构', '层次', '局部', '细节', '肩甲', '系带', '头部', '器物', '建筑模型', 'watchtower', '楼阁'] },
    { value: '纹样材质', keywords: ['材质', '皮革', '织物', '纹样', '配色', '色彩', '云纹'] },
    { value: '场景参考', keywords: ['场景', '地域', '建筑', '空间', '行军', '水战'] },
    { value: '资料线索', keywords: ['网页采集', '小红书', '链接', '资料线索'] },
  ],
  标签: [
    { value: '画像砖', keywords: ['画像砖', '拓片'] },
    { value: '甲胄', keywords: ['铠', '铠甲', '札甲'] },
    { value: '袍服', keywords: ['袍', '深衣', '常服'] },
    { value: '冠帽', keywords: ['冠', '帽', '帻', '盔', '羽毛', '羽饰'] },
    { value: '建筑', keywords: ['建筑', '建筑模型', 'watchtower', '楼阁'] },
    { value: '文官', keywords: ['文官', '士大夫'] },
    { value: '武官', keywords: ['武官', '武将', '将军'] },
    { value: '纹样', keywords: ['纹样', '织锦'] },
  ],
}

function inferEditorCategoryValue(field: EditorCategoryField, text: string, currentValue = '', forceRefresh = false) {
  const normalizedText = text.toLowerCase()
  const normalizedCurrentValue = field === officialCategoryField ? normalizeOfficialTypeOption(currentValue) : currentValue
  let bestValue = normalizedCurrentValue
  let bestScore = 0

  const candidateValues = uniqueValues([
    ...editorCategoryOptionMap[field],
    ...editorCategoryInferenceRules[field].map((rule) => rule.value),
  ]).filter((option) => field !== officialCategoryField || !broadIdentityTypeValues.has(option))

  candidateValues.forEach((option) => {
    let score = normalizedText.includes(option.toLowerCase()) ? 8 : 0
    editorCategoryInferenceRules[field]
      .filter((rule) => rule.value === option)
      .forEach((rule) => {
        rule.keywords.forEach((keyword) => {
          if (normalizedText.includes(keyword.toLowerCase())) score += Math.max(5, keyword.length)
        })
      })

    if (score > bestScore) {
      bestScore = score
      bestValue = option
    }
  })

  if (forceRefresh && bestScore === 0) return normalizedCurrentValue
  return bestValue
}

const editorTypeOptions: FancySelectOption[] = [
  { value: '', label: '请选择物品类型' },
  ...archiveItemTypeOptions.map((type) => ({ value: type, label: type })),
]

const editorTypeInferenceRules = itemTypeRules

function inferEditorType(text: string, currentType: string, forceRefresh = false) {
  const normalizedText = text.toLowerCase()
  let bestType = currentType
  let bestScore = 0

  editorTypeInferenceRules.forEach((rule) => {
    const score = rule.keywords.reduce((total, keyword) => (
      normalizedText.includes(keyword.toLowerCase()) ? total + keyword.length : total
    ), 0)

    if (score > bestScore) {
      bestScore = score
      bestType = rule.value
    }
  })

  if (forceRefresh && bestScore === 0) return currentType
  return bestType
}

function getPrimaryCategoryField(type: string): EditorCategoryField {
  if (type === '器物工艺') return '器物类别'
  if (type === '壁画图像') return '图像类别'
  if (type === '建筑空间') return '建筑类别'
  if (type === '纹样材质') return '纹样类别'
  return '服装类别'
}

function getMainCategoryFieldsForType(type: string): EditorCategoryField[] {
  const primaryField = getPrimaryCategoryField(type)
  if (primaryField === '服装类别') return ['时代', '身份类型', '职官类型', '服装类别']
  return ['时代', primaryField]
}

const bookScanKeywordRules = [
  { value: '冠帽', keywords: ['冠', '帽', '巾', '帻', '头巾', '进贤冠', '武冠'] },
  { value: '袍服', keywords: ['袍', '衣', '服', '深衣', '襦', '裳', '袖', '领', '襟'] },
  { value: '甲胄', keywords: ['甲', '胄', '铠', ' armor', 'helmet', '胫甲'] },
  { value: '腰带', keywords: ['带', '腰带', '带钩', '革带'] },
  { value: '纹样', keywords: ['纹', '纹样', '锦', '织物', '云气', '边饰'] },
]

function extractBookScanField(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const value = match?.[1]?.replace(/\s+/g, ' ').trim()
    if (value) return value
  }
  return ''
}

function getBookScanTitle(text: string, fileNames: string[]) {
  const explicitTitle = extractBookScanField(text, [
    /(?:书名|题名|标题|篇名)[:：]\s*([^\n\r]+)/i,
    /《([^》]{2,80})》/,
  ])
  if (explicitTitle) return explicitTitle.replace(/^《|》$/g, '')

  const firstReadableLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(line) && line.length >= 4 && line.length <= 80)
  if (firstReadableLine) return firstReadableLine.replace(/^《|》$/g, '')

  return fileNames[0]?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') || '书籍扫描资料'
}

function inferBookScanTags(text: string) {
  const normalizedText = text.toLowerCase()
  return uniqueValues([
    ...bookScanKeywordRules
      .filter((rule) => rule.keywords.some((keyword) => normalizedText.includes(keyword.toLowerCase())))
      .map((rule) => rule.value),
    '书籍扫描',
    'OCR',
  ])
}

function countMatches(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0
}

type BookScanOcrCleanMode = 'auto' | 'manual'

function shouldDropBookScanOcrLine(line: string, mode: BookScanOcrCleanMode = 'auto') {
  const normalizedLine = line.trim()
  if (!normalizedLine) return true
  if (/isbn|issn|doi|https?:\/\//i.test(normalizedLine)) return false

  const chineseCount = countMatches(normalizedLine, /[\u3400-\u9fff]/g)
  const latinCount = countMatches(normalizedLine, /[A-Za-z]/g)
  const digitCount = countMatches(normalizedLine, /\d/g)
  const contentCount = chineseCount + latinCount + digitCount
  if (!contentCount) return true

  const latinRatio = latinCount / contentCount
  if (mode === 'manual') {
    const compactLength = normalizedLine.replace(/\s+/g, '').length
    const shortMixedNoise = compactLength <= 10 && latinCount + digitCount >= Math.max(1, chineseCount)
    const mostlySymbols = countMatches(normalizedLine, /[^\u3400-\u9fffA-Za-z0-9\s]/g) > contentCount
    if (contentCount <= 2) return true
    if (chineseCount <= 3 && compactLength <= 3 && /\s/.test(normalizedLine)) return true
    if (chineseCount <= 1 && contentCount <= 6) return true
    if (chineseCount < 3 && shortMixedNoise) return true
    if (chineseCount < 4 && mostlySymbols) return true
  }
  if (chineseCount === 0 && latinCount >= 3) return true
  if (chineseCount < 4 && latinRatio > 0.45 && latinCount >= 4) return true
  return false
}

function sortBookScanFiles(files: File[]) {
  return [...files].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }))
}

function cleanBookScanOcrArtifacts(line: string, mode: BookScanOcrCleanMode) {
  let cleanedLine = line
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/[|]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .trim()

  if (mode === 'manual') {
    cleanedLine = cleanedLine
      .replace(/(^|\s)[A-Za-z]{1,3}[.,;:'"()/-]*(?=\s|$)/g, ' ')
      .replace(/(^|\s)\d{1,2}(?=\s|$)/g, ' ')
      .replace(/[<>{}[\]\\_^~`]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  return cleanedLine
}

function safeCleanBookScanOcrText(text: string, mode: BookScanOcrCleanMode = 'auto') {
  const cleanedLines = text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => cleanBookScanOcrArtifacts(line, mode))
    .map((line) => {
      const chineseCount = countMatches(line, /[\u3400-\u9fff]/g)
      if (chineseCount < 4 || /isbn|issn|doi|https?:\/\//i.test(line)) return line
      return line
        .replace(/\b[A-Z][A-Z\s.,;:'"()/-]{5,}\b/g, '')
        .replace(/\b[A-Za-z]{2,}(?:[.,;:'"()/-]+\s*){1,}/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    })
    .filter((line) => !shouldDropBookScanOcrLine(line, mode))

  return cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function loadBookScanImage(sourceUrl: string) {
  return new Promise<HTMLImageElement>((resolveLoad, rejectLoad) => {
    const image = new Image()
    try {
      const imageUrl = new URL(sourceUrl, window.location.href)
      if (imageUrl.origin !== window.location.origin) {
        image.crossOrigin = 'anonymous'
      }
    } catch {
      // Leave browser default loading behavior for blob/data/object URLs.
    }
    image.onload = () => resolveLoad(image)
    image.onerror = () => rejectLoad(new Error('Image decode failed'))
    image.src = sourceUrl
  })
}

async function resizeBookScanImage(file: File, maxSide: number, quality = 0.84) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadBookScanImage(objectUrl)
    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolveBlob) => canvas.toBlob(resolveBlob, 'image/jpeg', quality))
    if (!blob) throw new Error('Image compression failed')
    const resizedFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    return { file: resizedFile, dataUrl }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function prepareBookScanOcrImage(file: File, maxSide = 3200, minLongSide = 2400) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadBookScanImage(objectUrl)
    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    const sourceMaxSide = Math.max(sourceWidth, sourceHeight)
    const scale = sourceMaxSide > maxSide ? maxSide / sourceMaxSide : sourceMaxSide < minLongSide ? Math.min(2, minLongSide / sourceMaxSide) : 1
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.filter = 'grayscale(1) contrast(1.35) brightness(1.06)'
    context.drawImage(image, 0, 0, width, height)
    context.filter = 'none'

    const imageData = context.getImageData(0, 0, width, height)
    const { data } = imageData
    for (let index = 0; index < data.length; index += 4) {
      const value = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114)
      const adjusted = Math.max(0, Math.min(255, (value - 128) * 1.12 + 142))
      data[index] = adjusted
      data[index + 1] = adjusted
      data[index + 2] = adjusted
      data[index + 3] = 255
    }
    context.putImageData(imageData, 0, 0)

    const blob = await new Promise<Blob | null>((resolveBlob) => canvas.toBlob(resolveBlob, 'image/png'))
    if (!blob) throw new Error('Image preprocessing failed')
    return new File([blob], file.name.replace(/\.[^.]+$/, '.ocr.png'), { type: 'image/png' })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolveRead, rejectRead) => {
    const reader = new FileReader()
    reader.onload = () => resolveRead(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => rejectRead(reader.error ?? new Error('Image read failed'))
    reader.readAsDataURL(file)
  })
}

function safeCleanGalleryOcrText(text: string) {
  const cleaned = text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
        .replace(/[|｜]/g, '')
        .replace(/[^\S\n]+/g, ' ')
        .trim(),
    )
    .filter((line) => {
      if (!line) return false
      const cjkCount = countMatches(line, /[\u3400-\u9fff]/g)
      const latinCount = countMatches(line, /[A-Za-z]/g)
      const digitCount = countMatches(line, /\d/g)
      return cjkCount + latinCount + digitCount >= 2
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const compact = cleaned.replace(/\s+/g, '')
  const aliases = [
    /赤[幞愤憤惯慣幟帧幀]/.test(compact) || /平上[帻幘幀帧屿帳帐]/.test(compact)
      ? '赤幞 赤帻 平上帻'
      : '',
    /[黃黄][帻幘幀帧]/.test(compact) ? '黄帻' : '',
    /進賢冠|进贤冠|准賢冠|淮賢冠/.test(compact) ? '进贤冠' : '',
  ].filter(Boolean)

  return [...new Set([cleaned, ...aliases])].filter(Boolean).join('\n')
}

async function resizeImageUrlForGalleryOcr(sourceUrl: string, maxSide = 1500, quality = 0.9) {
  const image = await loadBookScanImage(sourceUrl)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Canvas unavailable')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

async function createGalleryOcrInput(asset: Asset) {
  const sourceUrls = uniqueValues([
    getArchivePathApiUrl(asset.thumbnailPath),
    asset.thumbnailUrl ?? '',
    asset.imageUrl ?? '',
    getSvnImageApiUrl(asset.svnPath),
    getAssetOriginalImageUrl(asset),
  ].filter(Boolean))

  let lastError: unknown
  for (const sourceUrl of sourceUrls) {
    try {
      return await resizeImageUrlForGalleryOcr(sourceUrl)
    } catch (error) {
      lastError = error
    }
  }

  try {
    const { blob, fileName } = await createAssetImageBlob(asset)
    return new File([blob], fileName, { type: blob.type || 'image/jpeg' })
  } catch {
    if (lastError instanceof Error) throw lastError
    throw new Error('图片无法用于 OCR')
  }
}

async function recognizeBookScanFilesWithPaddle(files: File[], onProgress: (message: string) => void) {
  onProgress('正在调用 PaddleOCR')
  const images = await Promise.all(files.map((file) => readFileAsDataUrl(file)))
  const response = await fetch(`${archiveApiBaseUrl}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images }),
  })
  const payload = await response.json().catch(() => ({} as PaddleOcrResponse)) as PaddleOcrResponse
  if (!response.ok) {
    throw new Error(payload.error || 'PaddleOCR 服务不可用')
  }

  return safeCleanBookScanOcrText(payload.text ?? '')
}

function buildBookScanRecognition(text: string, fileNames: string[]): BookScanRecognition {
  const title = getBookScanTitle(text, fileNames)
  const author = extractBookScanField(text, [
    /(?:作者|著者|编著|主编|编者)[:：]\s*([^\n\r]+)/i,
    /([^\n\r]{2,24})\s*(?:著|编著|主编)/,
  ])
  const publisher = extractBookScanField(text, [
    /(?:出版社|出版者|出版)[:：]\s*([^\n\r]+)/i,
    /([^\n\r]{2,40}出版社)/,
  ])
  const pageLabel = extractBookScanField(text, [
    /(?:页码|页|page|p\.)[:：]?\s*([0-9ivxlcdmIVXLCDM\-–—至到 ]{1,24})/i,
    /第\s*([0-9一二三四五六七八九十百零〇\-–—至到 ]{1,24})\s*页/,
  ])
  const isbn = extractBookScanField(text, [/(ISBN(?:-1[03])?[:：]?\s*[0-9Xx\-\s]{10,24})/i])
  const year = extractBookScanField(text, [
    /(?:出版年|出版时间|年份)[:：]\s*((?:19|20)\d{2})/,
    /((?:19|20)\d{2})\s*年/,
  ])
  const tags = inferBookScanTags(text)
  const sourceParts = [title, author, publisher, year].filter(Boolean)
  const sourceTitle = sourceParts.length ? sourceParts.join(' / ') : title
  const cleanedText = safeCleanBookScanOcrText(text)

  return {
    title,
    author,
    publisher,
    pageLabel,
    isbn,
    year,
    summary: `${title} 的书籍扫描识别资料，包含 ${fileNames.length} 张扫描图。`,
    note: [
      cleanedText ? `OCR识别文本：\n${cleanedText}` : 'OCR未识别到稳定文本，可手动补充书名、页码和出处。',
      sourceTitle ? `来源条目：${sourceTitle}` : '',
      pageLabel ? `页码：${pageLabel}` : '',
      isbn ? isbn : '',
    ].filter(Boolean).join('\n\n'),
    tags,
    sourceTitle,
  }
}

const bookScanOcrProfiles = [
  { label: '正文页', pagesegMode: PSM.SINGLE_BLOCK },
  { label: '图文混排', pagesegMode: PSM.SPARSE_TEXT },
]

function scoreBookScanOcrCandidate(text: string, confidence = 0) {
  const cleanedText = safeCleanBookScanOcrText(text)
  const chineseCount = countMatches(cleanedText, /[\u3400-\u9fff]/g)
  const latinCount = countMatches(cleanedText, /[A-Za-z]/g)
  const digitCount = countMatches(cleanedText, /\d/g)
  const lineCount = cleanedText.split('\n').filter(Boolean).length
  return chineseCount * 4 + latinCount + digitCount + lineCount * 8 + Math.max(0, confidence) * 1.5
}

async function recognizeBookScanFiles(files: File[], onProgress: (message: string) => void) {
  const worker = await createWorker('chi_sim+eng', 1, {
    logger: (message) => {
      if (message.status) onProgress(`${message.status} ${Math.round((message.progress || 0) * 100)}%`)
    },
  })

  try {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    })
    const texts: string[] = []
    for (const [index, file] of files.entries()) {
      let bestText = ''
      let bestScore = -1
      for (const [profileIndex, profile] of bookScanOcrProfiles.entries()) {
        onProgress(`正在识别第 ${index + 1} / ${files.length} 张（${profile.label}）`)
        await worker.setParameters({
          tessedit_pageseg_mode: profile.pagesegMode,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
        })
        const result = await worker.recognize(file, { rotateAuto: true })
        const cleanedText = safeCleanBookScanOcrText(result.data.text)
        const score = scoreBookScanOcrCandidate(cleanedText, result.data.confidence)
        if (score > bestScore) {
          bestText = cleanedText
          bestScore = score
        }
        if (profileIndex === 0 && score >= 220 && result.data.confidence >= 45) break
      }
      texts.push(bestText)
    }
    return texts.filter(Boolean).join('\n\n')
  } finally {
    await worker.terminate()
  }
}

function buildBookScanRecords(
  files: Array<{ name: string; size: number; previewUrl: string }>,
  recognition: BookScanRecognition,
) {
  const sourceId = `book-source-${stableHash(`${recognition.title}-${recognition.author}-${recognition.publisher}`)}`
  const source: BookSource = {
    id: sourceId,
    title: recognition.title || '未命名图书来源',
    author: recognition.author || undefined,
    publisher: recognition.publisher || undefined,
    publishYear: recognition.year ? Number(recognition.year) : undefined,
    isbn: recognition.isbn || undefined,
    sourceType: recognition.title.includes('志') || recognition.title.includes('书') ? '史料典籍' : '现代书籍',
    chapter: recognition.pageLabel ? `页码 ${recognition.pageLabel}` : undefined,
    note: recognition.note,
    usageRestriction: '内部研究参考，使用前需确认版权和扫描来源',
  }
  const pages = files.map((file, index): BookPage => {
    const fallbackPageNumber = String(index + 1)
    const pageNumber = files.length === 1 && recognition.pageLabel ? recognition.pageLabel : fallbackPageNumber
    return {
      id: `book-page-${stableHash(`${sourceId}-${file.name}-${file.size}-${index}`)}`,
      bookSourceId: sourceId,
      pageNumber,
      chapter: source.chapter,
      imagePath: file.previewUrl,
      ocrText: recognition.note,
      correctedText: recognition.note,
      keywords: recognition.tags,
      linkedArchiveItemIds: [],
    }
  })
  const sourceRef: ArchiveItemSourceRef = {
    sourceId,
    pageIds: pages.map((page) => page.id),
    pageNumberText: pages.map((page) => `P${page.pageNumber}`).join('、'),
    quoteText: recognition.note.slice(0, 320),
    note: recognition.sourceTitle,
  }

  return { source, pages, sourceRef }
}

const navItems: { view: View; label: string }[] = [
  { view: 'home', label: '首页' },
  { view: 'library', label: '资料库' },
  { view: 'images', label: '图片库' },
  { view: 'literature', label: '文献库' },
  { view: 'timeline', label: '时间线' },
]

const adminNavItems = ['内容配置', '内容治理', '系统维护', '操作日志']

function identifyWebClipPlatform(inputUrl: string) {
  try {
    const url = new URL(inputUrl)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()

    if (host.includes('britishmuseum.org')) {
      return {
        platform: 'British Museum',
        sourceType: '博物馆 / 馆藏',
        referencePurposes: ['史实依据', '形制参考'],
        usageHints: ['结构参考', '纹样材质'],
        usageRestriction: '需查看原网页版权说明',
        collectionType: '器物工艺',
        tags: ['馆藏', '器物', '博物馆'],
      }
    }

    if (host.includes('xiaohongshu') || host.includes('xhslink')) {
      return {
        platform: '小红书',
        sourceType: '小红书图文',
        referencePurposes: ['视觉灵感参考', '研究线索', '待核实参考'],
        usageHints: ['造型参考', '资料线索'],
        usageRestriction: '内部参考 / 需确认授权 / 不建议直接公开展示',
        collectionType: '视觉参考',
        tags: ['小红书', '灵感', '待核实'],
      }
    }

    if (host.includes('pinterest')) {
      return {
        platform: 'Pinterest',
        sourceType: 'Pinterest 图文',
        referencePurposes: ['视觉灵感参考', '待核实参考'],
        usageHints: ['造型参考', '纹样材质', '资料线索'],
        usageRestriction: '内部参考 / 需确认授权 / 不建议直接公开展示',
        collectionType: '视觉参考',
        tags: ['Pinterest', '灵感', '待核实'],
      }
    }

    if (host.includes('museum') || host.includes('collection')) {
      return {
        platform: host,
        sourceType: '网络资料',
        referencePurposes: ['史实依据', '形制参考'],
        usageHints: ['结构参考', '图像参考', '纹样材质'],
        usageRestriction: '需查看原网页版权说明',
        collectionType: '馆藏资料',
        tags: ['博物馆', '馆藏', '史实依据'],
      }
    }

    return {
      platform: host,
      sourceType: '普通网页素材',
      referencePurposes: ['研究线索', '待核实参考'],
      usageHints: ['资料线索'],
      usageRestriction: '需确认来源与授权',
      collectionType: '网页资料',
      tags: ['网页资料', '待核实'],
    }
  } catch {
    return undefined
  }
}

function getWebClipUrlParts(inputUrl: string) {
  try {
    const url = new URL(inputUrl)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    const pathSegments = url.pathname.split('/').filter(Boolean)
    return { url, host, pathSegments }
  } catch {
    return undefined
  }
}

const textFromHtml = (html: string) => {
  const element = document.createElement('textarea')
  element.innerHTML = html
  return element.value.replace(/\s+/g, ' ').trim()
}

const absoluteUrl = (value: string | null | undefined, baseUrl: string) => {
  if (!value) return undefined
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return undefined
  }
}

const getMetaContent = (doc: Document, selector: string) =>
  doc.querySelector<HTMLMetaElement>(selector)?.content.trim() || undefined

const webClipSlug = (inputUrl: string) => {
  try {
    const url = new URL(inputUrl)
    return (
      `${url.hostname}${url.pathname}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120) || 'web-clip'
    )
  } catch {
    return ''
  }
}

const englishWebClipLabelMap: Record<string, string> = {
  'Object Type': '器物类型',
  'Museum number': '馆藏编号',
  Description: '说明',
  'Cultures/periods': '文化/时期',
  'Production date': '制作年代',
  'Production place': '制作地点',
  'Production placeMade in': '制作地点',
  'Made in': '制作地点',
  Findspot: '发现地',
  Materials: '材质',
  Dimensions: '尺寸',
  DimensionsDiameter: '尺寸',
  Diameter: '直径',
  Location: '馆内状态',
  Subjects: '主题',
  'Acquisition name': '取得来源',
  'Funder name': '资助来源',
  'Acquisition date': '取得日期',
  Department: '部门',
  'Registration number': '登记编号',
  Conservation: '保护修复',
}

const webClipPhraseTranslations: Array<[RegExp, string]> = [
  [/\bbi \| British Museum/gi, '玉璧 | 大英博物馆'],
  [/Bi disc, made of yellow-white jade\. Remains of three dragon ornament on the edge\./gi, '玉璧，由黄白色玉制成。边缘残留三条龙纹装饰。'],
  [/bowl \| British Museum/gi, '碗 | 大英博物馆'],
  [/Bowl\. Made of gold inlaid bronze\./gi, '金错青铜碗。'],
  [/Bowl\. Animal head\. Made of bronze\./gi, '兽首青铜碗。'],
  [/boshanlu; censer \| British Museum/gi, '博山炉；香炉 | 大英博物馆'],
  [
    /Censer\. Bronze censer in shape called boshanlu \(or boshan xiang lu\), and cover\. With forested mountains and holes for chain attachment \. On a foot\./gi,
    '香炉。青铜香炉，形制称为博山炉（或博山香炉），带盖。饰有层叠山林，并有用于系链的孔。带足。',
  ],
  [/Found\/Acquired: ChinaAsia: China/gi, '发现/取得：中国（亚洲）'],
  [/Made in: ChinaAsia: China/gi, '中国（亚洲）'],
  [/ChinaAsia: China/gi, '中国（亚洲）'],
  [/Diameter: ([\d.]+) centimetres/gi, '直径：$1 厘米'],
  [/On display \(Gallery 33, Display Case 6a, Section 1\)/gi, '展出中（33号展厅，6a展柜，第1单元）'],
  [/Height: ([\d.]+) centimetres \(at cover\)/gi, '高度：$1 厘米（含盖）'],
  [/Purchased from: John Sparks, Ltd/gi, '购自：John Sparks, Ltd'],
  [/Purchased from: George Eumorfopoulos/gi, '购自：George Eumorfopoulos'],
  [/Funded by: Brooke Sewell Bequest/gi, '由 Brooke Sewell 遗赠基金资助'],
  [/Treatment: 27 Nov 1992/gi, '处理：1992年11月27日'],
  [/Han dynasty/gi, '汉代'],
  [/1stC BC \(circa\)/gi, '约公元前1世纪'],
  [/Not on display/gi, '未展出'],
  [/landscape/gi, '山水景观'],
  [/gold inlaid/gi, '金错'],
  [/inlaid/gi, '镶嵌'],
  [/\bBi disc\b/gi, '玉璧'],
  [/yellow-white jade/gi, '黄白色玉'],
  [/three dragon ornament/gi, '三条龙纹装饰'],
  [/dragon/gi, '龙'],
  [/jade/gi, '玉'],
  [/\bbowl\b/gi, '碗'],
  [/bronze/gi, '青铜'],
  [/Asia/gi, '亚洲'],
  [/British Museum/gi, '大英博物馆'],
  [/boshan xiang lu/gi, '博山香炉'],
  [/boshanlu/gi, '博山炉'],
  [/censer/gi, '香炉'],
]

const looksLikeForeignWebClip = (clip: WebClipImport) => {
  const text = [
    clip.pageTitle,
    clip.summary,
    clip.pageDescription,
    ...(clip.extractedFields ?? [])
      .filter((field) => !['来源站点', '来源链接'].includes(field.label))
      .flatMap((field) => [field.label, field.value]),
  ]
    .filter(Boolean)
    .join(' ')
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  return latinCount >= 24 && cjkCount < latinCount * 0.08
}

const translateWebClipTextToZh = (value = '') => {
  let translated = value.trim()
  webClipPhraseTranslations.forEach(([pattern, replacement]) => {
    translated = translated.replace(pattern, replacement)
  })
  translated = translated
    .replace(/\s+\./g, '。')
    .replace(/\. /g, '。')
    .replace(/\.$/g, '。')
    .replace(/; /g, '；')
  return translated
}

const translateWebClipFieldToZh = (field: WebClipExtractField): WebClipExtractField => ({
  label: englishWebClipLabelMap[field.label] ?? translateWebClipTextToZh(field.label),
  value: translateWebClipTextToZh(field.value),
})

const buildWebClipTranslationZh = (clip: WebClipImport): WebClipTranslation | undefined => {
  if (clip.translationZh || !looksLikeForeignWebClip(clip)) return clip.translationZh

  const fields = (clip.extractedFields ?? [])
    .filter((field) => !['来源站点', '来源链接'].includes(field.label))
    .map(translateWebClipFieldToZh)
  const title = translateWebClipTextToZh(clip.pageTitle || clip.itemDraft?.title || '')
  const summary = translateWebClipTextToZh(clip.summary || clip.pageDescription || '')

  if (!title && !summary && !fields.length) return undefined

  return {
    language: 'zh-CN',
    title,
    summary,
    fields,
    extractedText: [title, summary, ...fields.map((field) => `${field.label}: ${field.value}`)].filter(Boolean).join('\n'),
    generatedBy: 'local-rule-translator',
  }
}

const normalizeScriptClip = (clip: WebClipImport, fallbackUrl: string): WebClipImport => {
  const normalizedClip: WebClipImport = {
    ...clip,
    inputUrl: clip.inputUrl || fallbackUrl,
    extractedImages: (clip.extractedImages ?? []).map((image, index) => {
      const downloadStatus = image.downloadStatus ?? 'downloaded'
      return {
        ...image,
        id: image.id || `clip-img-${index + 1}`,
        imageUrl: resolveLocalAssetUrl(image.imageUrl),
        thumbnailUrl: image.thumbnailUrl ? resolveLocalAssetUrl(image.thumbnailUrl) : undefined,
        selected: downloadStatus === 'failed' ? false : (image.selected ?? index === 0),
        downloadStatus,
      }
    }),
    status: clip.status ?? 'success',
    createdBy: clip.createdBy || 'clip-page.mjs',
    createdAt: clip.createdAt || new Date().toISOString(),
  }
  const translationZh = buildWebClipTranslationZh(normalizedClip)
  return {
    ...normalizedClip,
    translationZh,
    itemDraft: translationZh
      ? {
          ...normalizedClip.itemDraft,
          title: translationZh.title || normalizedClip.itemDraft?.title || normalizedClip.pageTitle || fallbackUrl,
          summary: translationZh.summary || normalizedClip.itemDraft?.summary || normalizedClip.summary || '',
          collectionType: normalizedClip.itemDraft?.collectionType || normalizedClip.suggestedCollectionType || '网页资料',
          tags: normalizedClip.itemDraft?.tags || normalizedClip.suggestedTags || ['网页资料'],
        }
      : normalizedClip.itemDraft,
  }
}

async function fetchServerWebClip(normalizedUrl: string): Promise<WebClipImport | undefined> {
  const slug = webClipSlug(normalizedUrl)
  const readLocalClip = async () => {
    if (!slug) return undefined
    const localResponse = await fetch(`${webClipsBaseUrl}/${slug}/clip.json`, { cache: 'no-store' })
    if (!localResponse.ok) return undefined
    const localClip = normalizeScriptClip((await localResponse.json()) as WebClipImport, normalizedUrl)
    return localClip.status === 'failed' ? undefined : localClip
  }

  try {
    const response = await fetch(`${archiveApiBaseUrl}/web-clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: normalizedUrl }),
    })

    if (!response.ok) {
      if (response.status === 404) return undefined
      const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
      const localClip = await readLocalClip().catch(() => undefined)
      if (localClip) return localClip
      throw new Error(errorPayload?.error ?? `采集服务返回 ${response.status}`)
    }

    return normalizeScriptClip((await response.json()) as WebClipImport, normalizedUrl)
  } catch (error) {
    const localClip = await readLocalClip().catch(() => undefined)
    if (localClip) return localClip
    if (error instanceof TypeError) return undefined
    throw error
  }
}

async function startWebClipLoginSession(inputUrl: string): Promise<string> {
  const response = await fetch(`${archiveApiBaseUrl}/web-clips/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: inputUrl }),
  })

  const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null
  if (!response.ok) {
    throw new Error(payload?.error ?? `登录浏览器启动失败：${response.status}`)
  }

  return payload?.message ?? '采集登录浏览器已打开，请在这个窗口里登录；确认能看到笔记内容后可保持窗口打开。'
}

const collectWebClipImages = (doc: Document, baseUrl: string): WebClipImage[] => {
  const seen = new Set<string>()
  const candidates: Array<{ url?: string; caption?: string; alt?: string }> = [
    {
      url: getMetaContent(doc, 'meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"]'),
      caption: '网页主图',
      alt: getMetaContent(doc, 'meta[property="og:image:alt"], meta[name="twitter:image:alt"]'),
    },
  ]

  doc.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const imageUrl = image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-original')
    candidates.push({
      url: imageUrl || undefined,
      caption: image.getAttribute('title') || undefined,
      alt: image.alt || undefined,
    })
  })

  return candidates
    .map((candidate) => ({
      ...candidate,
      url: absoluteUrl(candidate.url, baseUrl),
    }))
    .filter((candidate): candidate is { url: string; caption?: string; alt?: string } => {
      if (!candidate.url || seen.has(candidate.url)) return false
      seen.add(candidate.url)
      return /^https?:\/\//.test(candidate.url)
    })
    .slice(0, 12)
    .map((candidate, index) => ({
      id: `clip-img-${index + 1}`,
      imageUrl: candidate.url,
      thumbnailUrl: candidate.url,
      altText: candidate.alt,
      caption: candidate.caption || candidate.alt || `网页图片 ${index + 1}`,
      selected: false,
      downloadStatus: 'not_downloaded',
    }))
}

async function createWebClipImport(inputUrl: string): Promise<WebClipImport> {
  const trimmedUrl = inputUrl.trim()
  const platform = identifyWebClipPlatform(trimmedUrl)
  const urlParts = getWebClipUrlParts(trimmedUrl)
  const now = new Date().toISOString()

  if (!trimmedUrl || !platform) {
    return {
      id: `clip-${Date.now()}`,
      inputUrl: trimmedUrl,
      extractedImages: [],
      status: 'failed',
      errorMessage: '请输入有效网页链接',
      createdBy: '当前用户',
      createdAt: now,
    }
  }

  const normalizedUrl = urlParts?.url.toString() ?? trimmedUrl
  const slug = webClipSlug(normalizedUrl)

  try {
    const serverClip = await fetchServerWebClip(normalizedUrl)
    if (serverClip) return serverClip
  } catch (error) {
    return {
      id: `clip-${Date.now()}`,
      inputUrl: trimmedUrl,
      normalizedUrl,
      platform: platform.platform,
      extractedImages: [],
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : String(error),
      createdBy: '当前用户',
      createdAt: now,
    }
  }

  if (slug) {
    try {
      const localResponse = await fetch(`${webClipsBaseUrl}/${slug}/clip.json`, { cache: 'no-store' })
      if (localResponse.ok) {
        const localClip = normalizeScriptClip((await localResponse.json()) as WebClipImport, normalizedUrl)
        if (localClip.status !== 'failed') return localClip
      }
    } catch {
      // Fall through to direct browser read, then report a truthful failure if that is blocked.
    }
  }

  let html: string
  try {
    const response = await fetch(normalizedUrl, { mode: 'cors' })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    html = await response.text()
  } catch (error) {
    return {
      id: `clip-${Date.now()}`,
      inputUrl: trimmedUrl,
      normalizedUrl,
      platform: platform.platform,
      extractedImages: [],
      status: 'failed',
      errorMessage:
        error instanceof TypeError
          ? '无法直接读取该网页内容。可先用本地采集脚本生成真实结果，或手动补充标题、图片和说明；系统不会用占位图或编造摘要代替'           : `无法读取该网页内容：${error instanceof Error ? error.message : String(error)}`,
      createdBy: '当前用户',
      createdAt: now,
    }
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pageTitle =
    getMetaContent(doc, 'meta[property="og:title"], meta[name="twitter:title"]') ||
    doc.querySelector('title')?.textContent?.trim() ||
    ''
  const summary =
    getMetaContent(doc, 'meta[property="og:description"], meta[name="description"], meta[name="twitter:description"]') ||
    ''
  const extractedImages = collectWebClipImages(doc, normalizedUrl)

  if (!pageTitle && !summary && !extractedImages.length) {
    return {
      id: `clip-${Date.now()}`,
      inputUrl: trimmedUrl,
      normalizedUrl,
      platform: platform.platform,
      extractedImages: [],
      status: 'failed',
      errorMessage: '网页已返回内容，但没有解析到标题、摘要或图片；系统不会生成假摘要或假图片',
      createdBy: '当前用户',
      createdAt: now,
    }
  }

  const extractedFields: WebClipExtractField[] = [
    ...(pageTitle ? [{ label: '页面标题', value: textFromHtml(pageTitle) }] : []),
    { label: '来源站点', value: platform.platform },
    { label: '来源链接', value: normalizedUrl },
    ...(summary ? [{ label: '页面摘要', value: textFromHtml(summary) }] : []),
  ]

  const suggestedTags = uniqueValues(platform.tags)
  const itemDraft = {
    title: pageTitle || normalizedUrl,
    summary,
    collectionType: platform.collectionType,
    tags: suggestedTags,
  }
  const sourceDraft = {
    title: pageTitle,
    sourceType: platform.sourceType,
    referencePurposes: platform.referencePurposes,
    usageHints: platform.usageHints,
    usageRestriction: platform.usageRestriction,
    sourceUrl: normalizedUrl,
  }

  return {
    id: `clip-${Date.now()}`,
    inputUrl: trimmedUrl,
    normalizedUrl,
    platform: platform.platform,
    pageTitle,
    pageDescription: summary,
    extractedText: [pageTitle, summary, normalizedUrl].filter(Boolean).join('\n'),
    extractedFields,
    summary,
    extractedImages,
    suggestedCollectionType: platform.collectionType,
    suggestedSourceType: platform.sourceType,
    suggestedReferencePurpose: platform.referencePurposes,
    suggestedUsageHints: platform.usageHints,
    suggestedTags,
    usageRestriction: platform.usageRestriction,
    sourceDraft,
    itemDraft,
    status: summary && extractedImages.length ? 'success' : 'partial_success',
    createdBy: '当前用户',
    createdAt: now,
  }
}

const tileOffset = (tile: number) => {
  const col = tile % 4
  const row = tile > 3 ? 1 : 0
  return { left: `${col * -100}%`, top: `${row * -100}%` }
}

const contactSheetPath = appPath('/assets/archive-contact-sheet.png')
const contactSheetColumns = 4
const contactSheetRows = 2

function isHttpUrl(value = '') {
  return /^https?:\/\//i.test(value.trim())
}

function isPlaceholderSvnPath(value = '') {
  const path = value.trim()
  return path === '/Costume' || path.startsWith('/Costume/')
}

function isRealSvnPath(value = '') {
  const path = value.trim()
  return Boolean(path && !isHttpUrl(path) && !isPlaceholderSvnPath(path) && !path.startsWith('/web-clips/') && !path.startsWith('/api/'))
}

function getSvnImageApiUrl(path = '') {
  const svnPath = path.trim()
  return isRealSvnPath(svnPath) ? `${svnApiBaseUrl}/file?path=${encodeURIComponent(svnPath)}` : ''
}

function getArchivePathApiUrl(path?: string) {
  return path && isRealSvnPath(path) ? getSvnImageApiUrl(path) : ''
}

function getAssetDisplayImageUrl(asset: Asset) {
  const directImageUrl = resolveLocalAssetUrl(asset.thumbnailUrl || asset.imageUrl || '')
  if (directImageUrl) return directImageUrl
  return getArchivePathApiUrl(asset.thumbnailPath) || (asset.linkedItemId === 'svn-import' ? getSvnImageApiUrl(asset.svnPath) : '')
}

function getAssetSourceUrl(asset: Asset) {
  return asset.originalUrl || asset.sourceUrl || (isHttpUrl(asset.svnPath) ? asset.svnPath : '') || resolveLocalAssetUrl(asset.imageUrl || asset.thumbnailUrl || '')
}

function getAssetOriginalImageUrl(asset: Asset) {
  const remoteOriginalUrl = asset.originalUrl || asset.sourceUrl || (isHttpUrl(asset.svnPath) ? asset.svnPath : '')
  return remoteOriginalUrl || resolveLocalAssetUrl(asset.imageUrl || asset.thumbnailUrl || '') || getArchivePathApiUrl(asset.thumbnailPath) || (asset.linkedItemId === 'svn-import' ? getSvnImageApiUrl(asset.svnPath) : '')
}

function getAssetFileName(asset: Asset) {
  const sourceExtension = (asset.svnPath || getAssetSourceUrl(asset)).split(/[?#]/)[0].split('.').pop()?.toLowerCase()
  const extension = sourceExtension === 'png' ? 'png' : 'jpg'
  const safeName = asset.caption
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return `${safeName || asset.id}.${extension}`
}

function loadContactSheetImage() {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片资源加载失败'))
    image.src = contactSheetPath
  })
}

async function createAssetImageBlob(asset: Asset) {
  const image = await loadContactSheetImage()
  const tileWidth = Math.floor(image.naturalWidth / contactSheetColumns)
  const tileHeight = Math.floor(image.naturalHeight / contactSheetRows)
  const col = asset.tile % contactSheetColumns
  const row = Math.floor(asset.tile / contactSheetColumns)
  const canvas = document.createElement('canvas')
  canvas.width = tileWidth
  canvas.height = tileHeight
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('当前浏览器无法生成图')
  }

  context.drawImage(image, col * tileWidth, row * tileHeight, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)

  const fileName = getAssetFileName(asset)
  const mimeType = fileName.endsWith('.png') ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result)
        } else {
          reject(new Error('图片生成失败'))
        }
      },
      mimeType,
      0.94,
    )
  })

  return { blob, fileName }
}

function AssetThumb({ asset, className = '' }: { asset: Asset; className?: string }) {
  const imageUrl = getAssetDisplayImageUrl(asset)
  const fallbackUrl = getSvnImageApiUrl(asset.svnPath)
  const [currentImageUrl, setCurrentImageUrl] = useState(imageUrl)

  useEffect(() => {
    setCurrentImageUrl(imageUrl)
  }, [imageUrl])

  return (
    <div
      className={`asset-thumb ${className}`}
      role="img"
      aria-label={asset.caption}
    >
      {currentImageUrl ? (
        <img
          className="asset-direct-image"
          src={currentImageUrl}
          alt=""
          onError={() => setCurrentImageUrl(currentImageUrl !== fallbackUrl && fallbackUrl ? fallbackUrl : '')}
        />
      ) : (
        <span className="asset-tile-window" aria-hidden="true">
          <img className="asset-tile-image" src={contactSheetPath} alt="" style={tileOffset(asset.tile)} />
        </span>
      )}
    </div>
  )
}

function App() {
  const initialPageState = useMemo(() => readPageState(), [])
  const [userRole, setUserRole] = useState<UserRole>(() => readUserRole())
  const [runtimeArchive, setRuntimeArchive] = useState<RuntimeArchiveSnapshot>(() => {
    const snapshot = readRuntimeArchiveSnapshot()
    installRuntimeArchiveSnapshot(snapshot)
    return snapshot
  })
  const archiveSettingsRef = useRef<ArchiveSettings>(normalizeArchiveSettings(runtimeArchive.settings))
  const [view, setView] = useState<View>(initialPageState.view)
  const [query, setQuery] = useState('')
  const [selectedItemId, setSelectedItemId] = useState(initialPageState.selectedItemId)
  const [archiveLinkRequestActive, setArchiveLinkRequestActive] = useState(() => readArchiveLinkRequest() !== null)
  const [lightboxAsset, setLightboxAsset] = useState<Asset | null>(null)
  const [toastMessage, setToastMessage] = useState('')
  const [notificationReadAt, setNotificationReadAt] = useState(() => readNotificationReadAt())
  const [showBackToTop, setShowBackToTop] = useState(false)
  const [librarySortMode, setLibrarySortMode] = useState<LibrarySortMode>(() => readLibrarySortMode())
  const [homeFeaturedConfig, setHomeFeaturedConfig] = useState<HomeFeaturedCardConfig[]>(() => readHomeFeaturedConfig())
  const homeFeaturedConfigRef = useRef<HomeFeaturedCardConfig[]>(homeFeaturedConfig)
  const [galleryDialog, setGalleryDialog] = useState<GalleryDialog>(null)
  const [literatureNavResetKey, setLiteratureNavResetKey] = useState(0)
  const [editorState, setEditorState] = useState<{ mode: EditorMode; sourceItemId?: string }>({ mode: 'new' })
  const [editorAssetIds, setEditorAssetIds] = useState<string[]>([])
  const [bookScanDraft, setBookScanDraft] = useState<BookScanImport | null>(null)
  const [pendingDuplicateSave, setPendingDuplicateSave] = useState<{ clipImport: WebClipImport; duplicate: ArchiveDuplicateMatch } | null>(null)
  const [filters, setFilters] = useState<FilterState>(() => createEmptyFilterState())
  const notifications = useMemo(() => buildAppNotifications(runtimeArchive), [runtimeArchive])
  const unreadNotificationCount = useMemo(
    () => notifications.filter((notification) => notification.createdAt > notificationReadAt).length,
    [notificationReadAt, notifications],
  )
  const markAllNotificationsRead = () => {
    const now = Date.now()
    setNotificationReadAt(now)
    writeNotificationReadAt(now)
  }
  const changeLibrarySortMode = (mode: LibrarySortMode) => {
    setLibrarySortMode(mode)
    writeLibrarySortMode(mode)
  }
  const applyView = (nextView: View, options: { pushHistory?: boolean; itemId?: string } = {}) => {
    const nextSelectedItemId = options.itemId ?? selectedItemId
    if (options.itemId) setSelectedItemId(options.itemId)
    setView(nextView)
    if (options.pushHistory) {
      pushArchiveHistory(nextView, nextSelectedItemId)
      setArchiveLinkRequestActive(false)
    }
  }
  const allArchiveItems = useMemo(
    () => mergeRuntimeArchiveSnapshots({ items: collectionItems, assets: [], bookSources: [], bookPages: [], feedbacks: [], settings: defaultArchiveSettings }, runtimeArchive).items,
    [runtimeArchive],
  )
  const allArchiveAssets = useMemo(
    () => mergeRuntimeArchiveSnapshots({ items: [], assets, bookSources: [], bookPages: [], feedbacks: [], settings: defaultArchiveSettings }, runtimeArchive).assets,
    [runtimeArchive],
  )

  useEffect(() => {
    try {
      window.sessionStorage.setItem(pageStateKey, JSON.stringify({ view, selectedItemId }))
    } catch {
      // Ignore storage failures so blocked session storage does not break navigation.
    }

    if (archiveLinkRequestActive) {
      const requestedItemId = readRequestedArchiveItemId(collectionItems)
      if (!requestedItemId || view !== 'detail' || selectedItemId !== requestedItemId) {
        return
      }
    }

    if (view === 'detail') {
      replaceArchiveDetailUrl(selectedItemId)
      setArchiveLinkRequestActive(false)
    } else if (!archiveLinkRequestActive) {
      clearArchiveDetailUrl()
    }
  }, [archiveLinkRequestActive, runtimeArchive, selectedItemId, view])

  useEffect(() => {
    const syncFromHistory = (event: PopStateEvent) => {
      const state = event.state as ArchiveHistoryState | null
      const requestedItemId = readRequestedArchiveItemId(collectionItems)

      if (state?.archiveApp && isView(state.view)) {
        if (state.selectedItemId && collectionItems.some((item) => item.id === state.selectedItemId)) {
          setSelectedItemId(state.selectedItemId)
        }
        setView(state.view)
        setArchiveLinkRequestActive(false)
        return
      }

      if (requestedItemId) {
        setSelectedItemId(requestedItemId)
        setView('detail')
        setArchiveLinkRequestActive(true)
        return
      }

      const requestedView = readRequestedView()
      if (requestedView && requestedView !== 'detail') {
        setView(requestedView)
        setArchiveLinkRequestActive(false)
        return
      }

      setView('library')
      setArchiveLinkRequestActive(false)
    }

    const requestedItemId = readRequestedArchiveItemId(collectionItems)
    if (requestedItemId && view === 'detail') {
      window.history.replaceState(
        { archiveApp: true, view: 'library', selectedItemId } satisfies ArchiveHistoryState,
        '',
        getArchiveViewUrl('library', selectedItemId),
      )
      window.history.pushState(
        { archiveApp: true, view: 'detail', selectedItemId: requestedItemId } satisfies ArchiveHistoryState,
        '',
        getArchiveViewUrl('detail', requestedItemId),
      )
    } else {
      window.history.replaceState(
        { archiveApp: true, view, selectedItemId } satisfies ArchiveHistoryState,
        '',
        window.location.href,
      )
    }
    window.addEventListener('popstate', syncFromHistory)
    return () => window.removeEventListener('popstate', syncFromHistory)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(roleStateKey, userRole)
    } catch {
      // Ignore storage failures so role switching remains in-memory.
    }
  }, [userRole])

  useEffect(() => {
    writeLibrarySortMode(librarySortMode)
  }, [librarySortMode])

  useEffect(() => {
    archiveSettingsRef.current = normalizeArchiveSettings(runtimeArchive.settings)
  }, [runtimeArchive.settings])

  useEffect(() => {
    homeFeaturedConfigRef.current = normalizeHomeFeaturedConfig(homeFeaturedConfig, allArchiveItems, allArchiveAssets)
  }, [allArchiveAssets, allArchiveItems, homeFeaturedConfig])

  useEffect(() => {
    try {
      writeHomeFeaturedConfig(normalizeHomeFeaturedConfig(homeFeaturedConfig, allArchiveItems, allArchiveAssets))
    } catch {
      // Ignore storage failures so homepage featured edits remain in-memory.
    }
  }, [allArchiveAssets, allArchiveItems, homeFeaturedConfig])

  useEffect(() => {
    const updateBackToTop = () => {
      setShowBackToTop(window.scrollY > 420)
    }

    updateBackToTop()
    window.addEventListener('scroll', updateBackToTop, { passive: true })
    return () => window.removeEventListener('scroll', updateBackToTop)
  }, [])

  useEffect(() => {
    if (userRole !== 'admin' && view === 'admin') {
      setView('library')
    }
  }, [userRole, view])

  const isAdmin = userRole === 'admin'
  const currentUserName = isAdmin ? '管理员' : '当前用户'
  const homeFeaturedCards = useMemo(
    () => resolveHomeFeaturedCards(homeFeaturedConfig, allArchiveItems, allArchiveAssets),
    [allArchiveAssets, allArchiveItems, homeFeaturedConfig],
  )
  const visibleItems = allArchiveItems.filter(isArchiveItemVisible)
  const selectedItem =
    (isAdmin ? allArchiveItems : visibleItems).find((item) => item.id === selectedItemId) ??
    visibleItems[0] ??
    allArchiveItems[0] ??
    collectionItems[0]
  const editorSourceItem = editorState.sourceItemId
    ? allArchiveItems.find((item) => item.id === editorState.sourceItemId)
    : undefined
  const canEditItem = (item: CollectionItem) =>
    item.status !== 'deleted' && (isAdmin || item.createdBy === currentUserName)

  const results = useMemo(() => {
    const matchedItems = visibleItems.filter((item) => {
      const matchesQuery = matchesLibraryQuery(item, query)
      const matchesFilters = (Object.keys(filters) as FilterKey[]).every((key) => {
        const active = filters[key]
        if (!active.length) return true
        if (key === 'costumeCategories') return itemMatchesCategoryFilters(item, active)
        return active.some((value) => getItemFacetValues(item, key).includes(value))
      })
      return matchesQuery && matchesFilters
    })
    return [...matchedItems].sort((a, b) => compareLibraryItems(a, b, librarySortMode, query))
  }, [filters, librarySortMode, query, visibleItems])

  useEffect(() => {
    const requestedItemId = readRequestedArchiveItemId(collectionItems)
    if (!requestedItemId) return

    if (selectedItemId !== requestedItemId) {
      setSelectedItemId(requestedItemId)
    }
    if (view !== 'detail') {
      setView('detail')
    }
  }, [runtimeArchive, selectedItemId, view])

  const visibleAssets = useMemo(() => {
    const itemIds = new Set(results.map((item) => item.id))
    const visibleItemIds = new Set(visibleItems.map((item) => item.id))
    return assets.filter((asset) => {
      const linkedItem = getAssetLinkedItem(asset)
      const linkedItemId = linkedItem?.id ?? asset.linkedItemId
      return itemIds.has(linkedItemId) || (!query.trim() && visibleItemIds.has(linkedItemId))
    })
  }, [query, results, visibleItems])

  const scanPageResults = useMemo(() => {
    const terms = getSearchTerms(query)
    if (!terms.length) return []
    return runtimeArchive.bookPages
      .map((page) => ({
        page,
        source: runtimeArchive.bookSources.find((source) => source.id === page.bookSourceId),
      }))
      .filter((entry): entry is { page: BookPage; source: BookSource } => Boolean(entry.source))
      .filter(({ page, source }) => {
        const searchable = [
          source.title,
          source.author ?? '',
          source.publisher ?? '',
          source.isbn ?? '',
          source.sourceType,
          source.chapter ?? '',
          page.pageNumber,
          page.chapter ?? '',
          page.ocrText ?? '',
          page.correctedText ?? '',
          ...page.keywords,
        ].join(' ').toLowerCase()
        return terms.every((term) => searchable.includes(term))
      })
      .slice(0, 50)
  }, [query, runtimeArchive.bookPages, runtimeArchive.bookSources])
  const literatureSources = useMemo(() => {
    return runtimeArchive.bookSources.map((source) => ({
      source,
      pages: runtimeArchive.bookPages.filter((page) => page.bookSourceId === source.id),
    }))
  }, [runtimeArchive.bookPages, runtimeArchive.bookSources])
  const literatureItems = useMemo(() => visibleItems.filter(isLiteratureItem), [visibleItems])
  const literatureSummaryStats = useMemo(
    () => getLiteratureSummaryStats(getLiteratureCatalogBooks(literatureSources, literatureItems)),
    [literatureItems, literatureSources],
  )

  const openDetail = (id: string) => {
    applyView('detail', { itemId: id, pushHistory: true })
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }))
  }

  const openEditor = (mode: EditorMode, sourceItem?: CollectionItem) => {
    setEditorState({ mode, sourceItemId: sourceItem?.id })
    setEditorAssetIds(sourceItem ? sourceItem.imageIds : [])
    setBookScanDraft(null)
    applyView('edit', { pushHistory: true })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggleFilter = (key: FilterKey, value: string) => {
    setFilters((current) => {
      const active = current[key]
      return {
        ...current,
        [key]: key === 'costumeCategories'
          ? getCategoryFilterNextValues(active, value)
          : active.includes(value) ? active.filter((item) => item !== value) : [...active, value],
      }
    })
  }

  const removeFilter = (key: FilterKey, value: string) => {
    setFilters((current) => ({
      ...current,
      [key]: key === 'costumeCategories' && categoryPrimaryValues.has(value)
        ? getCategoryFilterNextValues(current[key], value)
        : current[key].filter((item) => item !== value),
    }))
  }

  const clearLibraryFilters = () => {
    setQuery('')
    setFilters(createEmptyFilterState())
  }

  const notify = (message: string) => {
    setToastMessage(message)
    window.setTimeout(() => setToastMessage(''), 1800)
  }

  const refreshArchiveFromServer = async () => {
    const serverSnapshot = await fetchArchiveSnapshot()
    setRuntimeArchive(() => {
      const nextSettings = mergeArchiveSettingsWithLocal(serverSnapshot.settings, archiveSettingsRef.current)
      const nextSnapshot = {
        ...serverSnapshot,
        settings: nextSettings,
      }
      archiveSettingsRef.current = nextSettings
      installRuntimeArchiveSnapshot(nextSnapshot)
      writeRuntimeArchiveSnapshot(nextSnapshot)
      return nextSnapshot
    })
  }

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const serverSnapshot = await fetchArchiveSnapshot()
        if (cancelled) return
        setRuntimeArchive(() => {
          const nextSettings = mergeArchiveSettingsWithLocal(serverSnapshot.settings, archiveSettingsRef.current)
          const nextSnapshot = {
            ...serverSnapshot,
            settings: nextSettings,
          }
          archiveSettingsRef.current = nextSettings
          installRuntimeArchiveSnapshot(nextSnapshot)
          writeRuntimeArchiveSnapshot(nextSnapshot)
          return nextSnapshot
        })
      } catch (error) {
        console.warn('Archive API refresh failed', error)
      }
    }

    refresh()
    const intervalId = window.setInterval(refresh, 15000)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !('EventSource' in window)) return undefined

    let closed = false
    let refreshTimer = 0
    const refreshSoon = () => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        if (!closed) {
          refreshArchiveFromServer().catch((error) => {
            console.warn('Archive realtime refresh failed', error)
          })
        }
      }, 120)
    }

    const source = new EventSource(archiveEventsUrl)
    source.addEventListener('archive-change', refreshSoon)
    source.onerror = () => {
      console.warn('Archive realtime connection interrupted; polling fallback remains active.')
    }

    return () => {
      closed = true
      window.clearTimeout(refreshTimer)
      source.close()
    }
  }, [])

  const copyText = async (text: string) => {
    const copied = await writeClipboardText(text)
    if (copied) {
      notify('已复制')
      return true
    }

    notify('复制失败，请手动复制')
    return false
  }

  const openSvnPath = async (path: string) => {
    const svnPath = path.trim()
    if (!svnPath) {
      notify('没有可打开的 SVN 路径')
      return false
    }

    try {
      const response = await fetch(`${svnApiBaseUrl}/open?path=${encodeURIComponent(svnPath)}`, { method: 'POST' })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({} as { error?: string }))
        throw new Error(payload.error || `SVN 服务返回 ${response.status}`)
      }
      notify('已打开 SVN 位置')
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : '打开 SVN 失败')
      return false
    }
  }

  const applySvnImageSelection = (selectedAssets: Asset[]) => {
    const currentSettings = normalizeArchiveSettings(archiveSettingsRef.current)
    const nextSnapshot = mergeRuntimeArchiveSnapshots(runtimeArchive, { items: [], assets: selectedAssets, bookSources: [], bookPages: [], feedbacks: [], settings: currentSettings })
    installRuntimeArchiveSnapshot({ items: [], assets: selectedAssets, bookSources: [], bookPages: [], feedbacks: [], settings: currentSettings })
    archiveSettingsRef.current = normalizeArchiveSettings(nextSnapshot.settings)
    writeRuntimeArchiveSnapshot(nextSnapshot)
    setRuntimeArchive(nextSnapshot)
    setEditorAssetIds(selectedAssets.map((asset) => asset.id))
    setGalleryDialog(null)
    notify(`已选择 ${selectedAssets.length} 张图片`)
  }

  const saveLiteratureBook = async (source: BookSource, pages: BookPage[]) => {
    const cleanedPages = pages.map((page, index) => ({
      ...page,
      id: page.id || `${source.id}-page-${index + 1}`,
      bookSourceId: source.id,
      pageNumber: page.pageNumber || String(index + 1).padStart(3, '0'),
      imagePath: page.imagePath || source.coverImagePath || '/assets/literature-reader-page.png',
      keywords: Array.isArray(page.keywords) ? page.keywords : [],
      linkedArchiveItemIds: Array.isArray(page.linkedArchiveItemIds) ? page.linkedArchiveItemIds : [],
    }))
    const savedSource: BookSource = {
      ...source,
      updatedBy: currentUserName,
      updatedAt: new Date().toISOString(),
    }
    const installBookSnapshot = (nextSource: BookSource, nextPages: BookPage[]) => {
      setRuntimeArchive((current) => {
        const nextSnapshot: RuntimeArchiveSnapshot = {
          ...current,
          bookSources: [...current.bookSources.filter((entry) => entry.id !== nextSource.id), nextSource],
          bookPages: [...current.bookPages.filter((page) => page.bookSourceId !== nextSource.id), ...nextPages],
          settings: normalizeArchiveSettings(current.settings),
        }
        writeRuntimeArchiveSnapshot(nextSnapshot)
        return nextSnapshot
      })
    }

    installBookSnapshot(savedSource, cleanedPages)

    try {
      const result = await saveLiteratureBookRecord(savedSource, cleanedPages)
      installBookSnapshot(result.source, result.pages)
      notify('文献档案已保存入库')
    } catch (error) {
      notify(`文献档案已暂存本机，写入资料库失败：${error instanceof Error ? error.message : '请检查资料库服务'}`)
    }
  }

  const saveWebClipAsArchiveItem = async (clipImport: WebClipImport, saveMode: WebClipSaveMode = 'create') => {
    const nextRecord = buildArchiveRecordFromWebClip(clipImport)
    const builtItem = nextRecord.items[0]
    const existingItem = saveMode === 'update' ? findWebClipExistingItem(clipImport, allArchiveItems) : null
    const item = existingItem ? { ...builtItem, id: existingItem.id, createdAt: existingItem.createdAt, status: existingItem.status } : builtItem
    const recordAssets = existingItem
      ? nextRecord.assets.map((asset) => ({
          ...asset,
          id: asset.id.replace(builtItem.id, existingItem.id),
          linkedItemId: existingItem.id,
        }))
      : nextRecord.assets
    item.imageIds = recordAssets.map((asset) => asset.id)
    const savedAt = new Date()

    try {
      const itemType = getItemType(item)
      const itemCategories = getItemCategories(item)
      await postArchivePayload('items', {
        mode: existingItem ? 'edit' : 'new',
        sourceItemId: item.id,
        type: itemType,
        title: item.title,
        summary: item.summary,
        note: item.shortNote,
        extraNote: item.extraNote ?? '',
        categories: {
          时代: item.period,
          物品类型: itemType,
          物品类别: itemCategories.join('、'),
          身份类型: item.identityTypes.join('、'),
          职官类型: item.officialTypes.join('、'),
          服装类别: itemCategories.join('、'),
          来源类型: item.sourceTypes.join('、'),
          参考性质: item.referencePurposes.join('、'),
          使用用途: getStandardUsageHints(item.usageHints).join('、'),
          标签: item.tags.join('、'),
        },
        assetIds: item.imageIds,
        assets: recordAssets,
        sourceUrl: item.sourceUrl,
        createdBy: existingItem?.createdBy ?? item.createdBy,
        forceCreateDuplicate: Boolean(pendingDuplicateSave?.clipImport.id === clipImport.id),
        savedAt: savedAt.toISOString(),
        savedAtLabel: savedAt.toLocaleTimeString('zh-CN', { hour12: false }),
      })
      setGalleryDialog(null)
      openDetail(item.id)
      await refreshArchiveFromServer()
      notify('已自动保存为共享资料')
    } catch (error) {
      if (error instanceof ArchiveDuplicateError) {
        setPendingDuplicateSave({ clipImport, duplicate: error.duplicate })
        notify('疑似已存在相同资料')
        return
      }
      notify(`已保存在本机，写入共享资料库失败：${error instanceof Error ? error.message : '请检查资料库服务'}`)
    }
  }

  const importBookScanToEditor = (bookScan: BookScanImport) => {
    const nextSnapshot = mergeRuntimeArchiveSnapshots(runtimeArchive, {
      items: [],
      assets: [],
      bookSources: [bookScan.source],
      bookPages: bookScan.pages,
      feedbacks: [],
    })
    writeRuntimeArchiveSnapshot(nextSnapshot)
    setRuntimeArchive(nextSnapshot)
    setBookScanDraft(bookScan)
    setGalleryDialog(null)
    if (view !== 'edit') applyView('edit', { pushHistory: true })
    notify(`已识别 ${bookScan.pages.length} 张图书扫描件`)
  }

  const updateItemStatus = async (item: CollectionItem, status: CollectionItem['status']) => {
    try {
      await updateArchiveItemStatus(item.id, status, currentUserName)
      await refreshArchiveFromServer()
      if (status !== 'active' && selectedItemId === item.id) {
        setSelectedItemId(visibleItems[0]?.id ?? collectionItems[0].id)
        setView('library')
      }
      notify(
        status === 'hidden'
          ? '资料已隐藏'
          : status === 'deleted'
            ? '资料已软删除，SVN 原始图片未删除'
            : '资料已恢复',
      )
    } catch (error) {
      notify(`操作失败：${error instanceof Error ? error.message : '请检查资料库服务'}`)
    }
  }

  const purgeItem = async (item: CollectionItem) => {
    try {
      const result = await purgeArchiveItem(item.id)
      await refreshArchiveFromServer()
      if (selectedItemId === item.id) {
        setSelectedItemId(visibleItems[0]?.id ?? collectionItems[0].id)
        setView('library')
      }
      notify(`资料已彻底删除，已移除 ${result.removedAssetCount} 条关联图片记录`)
    } catch (error) {
      notify(`彻底删除失败：${error instanceof Error ? error.message : '请检查资料库服务'}`)
    }
  }

  const mergeDuplicateItem = async (primaryItem: CollectionItem, duplicateItem: CollectionItem) => {
    if (primaryItem.id === duplicateItem.id) return
    if (duplicateItem.status !== 'active') {
      notify('该重复资料已处理')
      return
    }
    try {
      await updateArchiveItemStatus(duplicateItem.id, 'hidden', currentUserName)
      await refreshArchiveFromServer()
      notify('已合并重复资料：重复条目已隐藏，主条目保留')
    } catch (error) {
      notify(`合并失败：${error instanceof Error ? error.message : '请检查资料库服务'}`)
    }
  }
  const saveTimelineAdminConfig = async (item: CollectionItem, config: TimelineAdminConfig) => {
    try {
      await postArchivePayload('items', buildArchivePayloadFromItem(item, {
        timelineEnabled: config.timelineEnabled,
        timelineLabel: config.timelineLabel.trim(),
        startYear: config.startYear,
        endYear: config.endYear,
        timelineWeight: config.timelineWeight,
        savedAt: new Date().toISOString(),
        savedAtLabel: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      }))
      await refreshArchiveFromServer()
      notify('时间线配置已保存')
    } catch (error) {
      notify(`时间线配置保存失败：${error instanceof Error ? error.message : '请检查资料库服务'}`)
      throw error
    }
  }
  const updateHomeFeaturedCard = (cardId: string, updates: Partial<HomeFeaturedCardConfig>) => {
    const currentConfig = normalizeHomeFeaturedConfig(homeFeaturedConfigRef.current, allArchiveItems, allArchiveAssets)
    const nextConfig = currentConfig.map((entry) => (entry.id === cardId ? { ...entry, ...updates } : entry))
    homeFeaturedConfigRef.current = normalizeHomeFeaturedConfig(nextConfig, allArchiveItems, allArchiveAssets)
    setHomeFeaturedConfig(homeFeaturedConfigRef.current)
  }
  const updateArchiveSettings = (updates: Partial<ArchiveSettings>) => {
    const nextSettings = normalizeArchiveSettings({ ...archiveSettingsRef.current, ...updates, updatedAt: new Date().toISOString() })
    archiveSettingsRef.current = nextSettings
    setRuntimeArchive((current) => {
      const nextSnapshot = {
        ...current,
        settings: nextSettings,
      }
      writeRuntimeArchiveSnapshot(nextSnapshot)
      return nextSnapshot
    })
  }
  const archiveSettings = normalizeArchiveSettings(runtimeArchive.settings)
  const saveHomeFeaturedCards = async () => {
    const normalized = normalizeHomeFeaturedConfig(homeFeaturedConfigRef.current, allArchiveItems, allArchiveAssets)
    homeFeaturedConfigRef.current = normalized
    const savedSettings = normalizeArchiveSettings(archiveSettingsRef.current)
    writeHomeFeaturedConfig(normalized)
    setHomeFeaturedConfig(normalized)
    setRuntimeArchive((current) => {
      const nextSnapshot = mergeRuntimeArchiveSnapshots(current, { items: [], assets: [], bookSources: [], bookPages: [], feedbacks: [], settings: savedSettings })
      archiveSettingsRef.current = normalizeArchiveSettings(nextSnapshot.settings)
      writeRuntimeArchiveSnapshot(nextSnapshot)
      return nextSnapshot
    })

    try {
      const result = await saveArchiveSettings(savedSettings)
      const returnedSettings = normalizeArchiveSettings(result.settings)
      archiveSettingsRef.current = returnedSettings
      setRuntimeArchive((current) => {
        const nextSnapshot = mergeRuntimeArchiveSnapshots(current, { items: [], assets: [], bookSources: [], bookPages: [], feedbacks: [], settings: returnedSettings })
        writeRuntimeArchiveSnapshot(nextSnapshot)
        return nextSnapshot
      })
      notify('已保存首页配置')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('接口不存在') || message.includes('404')) {
        notify('已保存到本地，当前后端未提供设置接口')
        return
      }
      notify(`已保存到本地，后端同步失败：${message || '请检查资料库服务'}`)
    }
  }
  const handleHeaderViewChange = (nextView: View) => {
    if (nextView === 'literature') {
      writeLiteraturePageState({ mode: 'home', scrollY: 0 })
      setLiteratureNavResetKey((key) => key + 1)
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }))
    }
    if (view === 'literature' && nextView === 'literature') {
      return
    }
    applyView(nextView, { pushHistory: true })
  }
  const viewTransitionKey =
    view === 'detail'
      ? `detail-${selectedItemId}`
      : view === 'edit'
        ? `edit-${editorState.mode}-${editorState.sourceItemId ?? 'new'}`
        : view

  return (
    <div className={view === 'home' || view === 'literature' ? `app home-app${view === 'literature' ? ' literature-app' : ''}` : 'app'}>
      <Header
        view={view}
        setView={handleHeaderViewChange}
        userRole={userRole}
        setUserRole={setUserRole}
        notifications={notifications}
        notificationReadAt={notificationReadAt}
        unreadNotificationCount={unreadNotificationCount}
        onMarkAllNotificationsRead={markAllNotificationsRead}
      />
      <div className="view-transition-stage" key={viewTransitionKey}>
        {view === 'home' && (
          <Home
            setView={(nextView) => applyView(nextView, { pushHistory: true })}
            setQuery={setQuery}
            openDetail={openDetail}
            featuredCards={homeFeaturedCards}
            homeHeroDetailId={archiveSettings.homeHeroDetailId}
            homeHeroItems={archiveSettings.homeHeroItems}
            items={visibleItems}
            literatureStats={literatureSummaryStats}
          />
        )}
        {view === 'library' && (
          <Library
            query={query}
            setQuery={setQuery}
            results={results}
            scanPageResults={scanPageResults}
            filters={filters}
            toggleFilter={toggleFilter}
            removeFilter={removeFilter}
            clearFilters={clearLibraryFilters}
            sortMode={librarySortMode}
            setSortMode={changeLibrarySortMode}
            openDetail={openDetail}
            openEditor={(item) => openEditor('edit', item)}
            copyText={copyText}
            isAdmin={isAdmin}
            onHideItem={(item) => updateItemStatus(item, 'hidden')}
            onDeleteItem={(item) => updateItemStatus(item, 'deleted')}
            startNewItem={() => openEditor('new')}
            openWebClip={() => setGalleryDialog('web-clip')}
          />
        )}
        {view === 'images' && (
          <ImageLibrary
            visibleAssets={visibleAssets}
            setLightboxAsset={setLightboxAsset}
            openDetail={openDetail}
            startNewItem={() => openEditor('new')}
          />
        )}
        {view === 'literature' && (
          <LiteratureLibrary
            key={literatureNavResetKey}
            sources={literatureSources}
            items={literatureItems}
            initialBookId={readRequestedLiteratureBookId()}
            openArchiveDetail={openDetail}
            openBookScan={() => setGalleryDialog('book-scan')}
            copyText={copyText}
            isAdmin={isAdmin}
            currentUserName={currentUserName}
            saveLiteratureBook={saveLiteratureBook}
          />
        )}
        {view === 'timeline' && <Timeline items={visibleItems} openDetail={openDetail} setLightboxAsset={setLightboxAsset} />}
        {view === 'admin' && isAdmin && (
          <AdminConsole
            items={allArchiveItems}
            assetPool={allArchiveAssets}
            feedbacks={runtimeArchive.feedbacks}
            openDetail={openDetail}
            openEditor={(item) => openEditor('edit', item)}
            copyText={copyText}
            onHideItem={(item) => updateItemStatus(item, 'hidden')}
            onDeleteItem={(item) => updateItemStatus(item, 'deleted')}
            onRestoreItem={(item) => updateItemStatus(item, 'active')}
            onPurgeItem={purgeItem}
            onMergeDuplicate={mergeDuplicateItem}
            featuredCards={homeFeaturedCards}
            onUpdateFeaturedCard={updateHomeFeaturedCard}
            onSaveFeaturedCards={saveHomeFeaturedCards}
            onSaveTimelineConfig={saveTimelineAdminConfig}
            homeHeroDetailId={archiveSettings.homeHeroDetailId}
            homeHeroItems={archiveSettings.homeHeroItems}
            onUpdateSettings={updateArchiveSettings}
          />
        )}
        {view === 'detail' && (
          <Detail
            key={selectedItem.id}
            item={selectedItem}
            bookSources={runtimeArchive.bookSources}
            bookPages={runtimeArchive.bookPages}
            setLightboxAsset={setLightboxAsset}
            setView={(nextView) => applyView(nextView, { pushHistory: true })}
            canEdit={canEditItem(selectedItem)}
            editItem={() => openEditor('edit', selectedItem)}
            openDetail={openDetail}
            copyText={copyText}
            openSvnPath={openSvnPath}
            notify={notify}
            createdBy={currentUserName}
            onFeedbackSubmitted={refreshArchiveFromServer}
          />
        )}
        {view === 'edit' && (
          <Editor
            key={`${editorState.mode}-${editorState.sourceItemId ?? 'new'}`}
            mode={editorState.mode}
            sourceItem={editorSourceItem}
            assetPool={allArchiveAssets}
            editorAssetIds={editorAssetIds}
            setEditorAssetIds={setEditorAssetIds}
            setView={(nextView) => applyView(nextView, { pushHistory: true })}
            openGalleryDialog={setGalleryDialog}
            bookScanDraft={bookScanDraft}
            notify={notify}
            onItemSaved={refreshArchiveFromServer}
            createdBy={currentUserName}
          />
        )}
      </div>
      {lightboxAsset && (
        <Lightbox
          asset={lightboxAsset}
          close={() => setLightboxAsset(null)}
          openDetail={openDetail}
          copyText={copyText}
          openSvnPath={openSvnPath}
        />
      )}
      {galleryDialog && (
        <GalleryWorkflowDialog
          kind={galleryDialog}
          close={() => setGalleryDialog(null)}
          copyText={copyText}
          startNewItem={() => openEditor('new')}
          selectedAssetIds={editorAssetIds}
          onSvnSelected={applySvnImageSelection}
          onWebClipSaved={saveWebClipAsArchiveItem}
          findExistingWebClipItem={(clipImport) => findWebClipExistingItem(clipImport, allArchiveItems)}
          onBookScanImported={importBookScanToEditor}
          notify={notify}
        />
      )}
      {pendingDuplicateSave && (
        <DuplicateArchiveDialog
          duplicate={pendingDuplicateSave.duplicate}
          close={() => setPendingDuplicateSave(null)}
          openExisting={(itemId: string) => {
            setPendingDuplicateSave(null)
            setGalleryDialog(null)
            openDetail(itemId)
          }}
          continueSave={() => saveWebClipAsArchiveItem(pendingDuplicateSave.clipImport)}
        />
      )}
      <button
        type="button"
        className={showBackToTop ? 'back-to-top visible' : 'back-to-top'}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        aria-label="返回顶部"
        tabIndex={showBackToTop ? 0 : -1}
      >
        <ArrowUp size={20} />
      </button>
      <Toast message={toastMessage} />
    </div>
  )
}

function Header({
  view,
  setView,
  userRole,
  setUserRole,
  notifications,
  notificationReadAt,
  unreadNotificationCount,
  onMarkAllNotificationsRead,
}: {
  view: View
  setView: (view: View) => void
  userRole: UserRole
  setUserRole: (role: UserRole) => void
  notifications: AppNotification[]
  notificationReadAt: number
  unreadNotificationCount: number
  onMarkAllNotificationsRead: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const activeView = view === 'detail' || view === 'edit' ? 'library' : view
  const isAdminView = activeView === 'admin'
  const go = (nextView: View) => {
    setView(nextView)
    setMenuOpen(false)
    setNoticeOpen(false)
  }
  const switchRole = (role: UserRole) => {
    setUserRole(role)
    if (role !== 'admin' && view === 'admin') {
      go('library')
    }
  }

  return (
    <header className={isAdminView ? 'topbar admin-topbar' : 'topbar'}>
      <div className="topbar-inner">
      <button className="brand" type="button" onClick={() => go('home')}>
        <img className="brand-logo" src={appPath('/costume-library-logo.png')} alt="" aria-hidden="true" />
        <span>
          <strong>{isAdminView ? '三国美术资料库 · 管理后台' : '三国美术资料库'}</strong>
          <small>{isAdminView ? 'ADMIN CONSOLE' : 'THREE KINGDOMS ART ARCHIVE'}</small>
        </span>
      </button>
      <nav>
        {isAdminView
          ? adminNavItems.map((label, index) => (
            <button
              key={label}
              className={index === 0 ? 'active' : 'disabled'}
              type="button"
              disabled={index !== 0}
              aria-disabled={index !== 0}
              onClick={() => {
                if (index === 0) go('admin')
              }}
            >
              {label}
            </button>
          ))
          : navItems.map((item) => (
            <button
              key={item.view}
              className={activeView === item.view ? 'active' : ''}
              type="button"
              onClick={() => go(item.view)}
            >
              {item.label}
            </button>
          ))}
      </nav>
      <div className="top-actions">
        <div className="role-switch" aria-label="当前角色">
          <button
            type="button"
            className={userRole === 'member' ? 'active' : ''}
            onClick={() => switchRole('member')}
          >
            成员
          </button>
          <button
            type="button"
            className={userRole === 'admin' ? 'active' : ''}
            onClick={() => switchRole('admin')}
          >
            {isAdminView ? '管理员模式' : '管理员'}
          </button>
        </div>
        <button
          className={[
            isAdminView ? 'admin-entry admin-exit-entry' : 'admin-entry',
            userRole !== 'admin' ? 'admin-entry-hidden' : '',
          ].filter(Boolean).join(' ')}
          type="button"
          onClick={() => go(isAdminView ? 'library' : 'admin')}
          aria-hidden={userRole !== 'admin'}
          aria-label={isAdminView ? '退出后台，返回资料库' : '进入管理后台'}
          tabIndex={userRole === 'admin' ? 0 : -1}
        >
          {isAdminView ? <LogOut size={16} /> : <Lock size={16} />}
          {isAdminView ? '退出后台' : '管理后台'}
        </button>
        <div className="top-popover-wrap">
          <button
            className="icon-button notify-button"
            type="button"
            aria-label="通知"
            aria-expanded={noticeOpen}
            onClick={() => {
              setNoticeOpen((open) => !open)
            }}
          >
            <Bell size={19} />
            {unreadNotificationCount > 0 && <span />}
          </button>
          {noticeOpen && (
            <div className="top-popover notification-popover">
              <header>
                <span>
                  <strong>通知</strong>
                  <small>项目同步与采集状态</small>
                </span>
                <button type="button" onClick={onMarkAllNotificationsRead} disabled={!unreadNotificationCount}>全部已读</button>
              </header>
              <div className="notification-list">
                {notifications.map((notification) => {
                  const isUnread = notification.createdAt > 0 && notification.createdAt > notificationReadAt
                  const Icon =
                    notification.kind === 'success'
                      ? Check
                      : notification.kind === 'sync-error'
                        ? CloudOff
                        : notification.kind === 'web-clip'
                          ? Globe2
                          : AlertTriangle
                  return (
                    <button
                      type="button"
                      className={`notification-item ${notification.kind}${isUnread ? ' unread' : ''}`}
                      key={notification.id}
                      onClick={() => go(notification.actionView === 'admin' && userRole !== 'admin' ? 'library' : notification.actionView)}
                    >
                      <i><Icon size={16} /></i>
                      <span>
                        <strong>{notification.title}</strong>
                        <small>{notification.body}</small>
                        <em>{notification.timeLabel}</em>
                      </span>
                    </button>
                  )
                })}
              </div>
              <button type="button" className="notification-foot" onClick={() => go(userRole === 'admin' ? 'admin' : 'library')}>
                查看资料库状态
              </button>
            </div>
          )}
        </div>
        <button
          className="icon-button compact-menu"
          type="button"
          aria-label="菜单"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Menu size={18} />
        </button>
      </div>
      </div>
      {menuOpen && (
        <div className="mobile-nav">
          {isAdminView
            ? adminNavItems.map((label, index) => (
              <button
                key={label}
                className={index === 0 ? 'active' : 'disabled'}
                type="button"
                disabled={index !== 0}
                aria-disabled={index !== 0}
                onClick={() => {
                  if (index === 0) go('admin')
                }}
              >
                {label}
              </button>
            ))
            : navItems.map((item) => (
              <button
                key={item.view}
                className={activeView === item.view ? 'active' : ''}
                type="button"
                onClick={() => go(item.view)}
              >
                {item.label}
              </button>
            ))}
          {userRole === 'admin' && (
            <button
              className={activeView === 'admin' ? 'admin-exit-mobile' : ''}
              type="button"
              onClick={() => go(isAdminView ? 'library' : 'admin')}
            >
              {isAdminView ? '退出后台' : '管理后台'}
            </button>
          )}
        </div>
      )}
    </header>
  )
}

type HanCategoryIconKind = 'costume' | 'armor' | 'vessel' | 'mural' | 'architecture' | 'headwear' | 'pattern'

function HanCategoryIcon({ kind, size = 65 }: { kind: HanCategoryIconKind; size?: number }) {
  return (
    <span
      className={`han-category-icon han-category-icon-${kind}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}

const fallbackLiteratureBooks: LiteratureCatalogBook[] = [
  {
    id: 'lit-sanguozhi',
    title: '三国志（陈寿）',
    shortTitle: '三国志',
    author: '陈寿',
    dynasty: '西晋',
    category: '史书典籍',
    source: '国家图书馆藏本',
    format: 'PDF · OCR',
    ocrStatus: '已完成',
    ocrRate: 98,
    totalPages: 1200,
    volumes: '共 65 卷',
    summary: '记载三国时期魏、蜀、吴三国的历史，全书六十五卷，是研究三国历史最重要的史料之一。',
    svnPath: 'trunk/library/sanguozhi',
    palette: '#9f8057',
    accent: '#4a3524',
    coverImage: '/assets/literature-covers/sanguozhi.png',
    pages: [],
  },
  {
    id: 'lit-houhanshu',
    title: '后汉书',
    shortTitle: '后汉书',
    author: '范晔',
    dynasty: '南朝宋',
    category: '史书典籍',
    source: '商务印书馆影印本',
    format: 'PDF · OCR',
    ocrStatus: '已完成',
    ocrRate: 92,
    totalPages: 120,
    volumes: '共 120 卷',
    summary: '记载东汉一代的历史，包含纪、志、传等内容，对研究汉末年至三国时期的历史具有重要参考价值。',
    svnPath: 'trunk/library/houhanshu',
    palette: '#6f7980',
    accent: '#28323a',
    coverImage: '/assets/literature-covers/houhanshu.png',
    pages: [],
  },
  {
    id: 'lit-zizhitongjian',
    title: '资治通鉴',
    shortTitle: '资治通鉴',
    author: '司马光',
    dynasty: '北宋',
    category: '史书典籍',
    source: '国家图书馆藏本',
    format: 'PDF · OCR',
    ocrStatus: '部分完成',
    ocrRate: 89,
    totalPages: 294,
    volumes: '共 294 卷',
    summary: '编年体通史巨著，其中卷六十四至卷九十六记载三国时期历史，史料详实。',
    svnPath: 'trunk/library/zizhitongjian',
    palette: '#9b8058',
    accent: '#46311e',
    coverImage: '/assets/literature-covers/zizhitongjian.png',
    pages: [],
  },
  {
    id: 'lit-sanguohuiyao',
    title: '三国会要',
    shortTitle: '三国会要',
    author: '王溥',
    dynasty: '宋',
    category: '古籍善本',
    source: '四部丛刊影印本',
    format: 'PDF · OCR',
    ocrStatus: '已完成',
    ocrRate: 85,
    totalPages: 40,
    volumes: '共 40 卷',
    summary: '汇集三国时期史料的类书，对历代有关三国的记载进行辑录、考辨与评议。',
    svnPath: 'trunk/library/sanguohuiyao',
    palette: '#d1ad72',
    accent: '#654225',
    coverImage: '/assets/literature-covers/sanguohuiyao.png',
    pages: [],
  },
  {
    id: 'lit-weishu',
    title: '魏书',
    shortTitle: '魏书',
    author: '魏收',
    dynasty: '北齐',
    category: '史书典籍',
    source: '国家图书馆藏本',
    format: 'PDF · OCR',
    ocrStatus: '已完成',
    ocrRate: 91,
    totalPages: 130,
    volumes: '共 130 卷',
    summary: '记载北魏历史的纪传体史书，保留制度、礼仪与人物传记等重要材料。',
    svnPath: 'trunk/library/weishu',
    palette: '#6b5132',
    accent: '#3b2819',
    coverImage: '/assets/literature-covers/weishu.png',
    pages: [],
  },
  {
    id: 'lit-wushu',
    title: '吴书',
    shortTitle: '吴书',
    author: '韦昭等',
    dynasty: '唐',
    category: '史书典籍',
    source: '国家图书馆藏本',
    format: 'PDF · OCR',
    ocrStatus: '已完成',
    ocrRate: 88,
    totalPages: 60,
    volumes: '共 60 卷',
    summary: '记载孙吴史事的佚史辑本，适合对照三国时期吴地制度与人物材料。',
    svnPath: 'trunk/library/wushu',
    palette: '#a46d3d',
    accent: '#5d3520',
    coverImage: '/assets/literature-covers/wushu.png',
    pages: [],
  },
  {
    id: 'lit-shuji',
    title: '蜀记',
    shortTitle: '蜀记',
    author: '常璩',
    dynasty: '西晋',
    category: '史书典籍',
    source: '国家图书馆藏本',
    format: 'PDF · OCR',
    ocrStatus: '已完成',
    ocrRate: 87,
    totalPages: 40,
    volumes: '共 40 卷',
    summary: '辑录蜀地史事与人物材料，可与《三国志》蜀书互证。',
    svnPath: 'trunk/library/shuji',
    palette: '#d9c0a0',
    accent: '#7a5b39',
    coverImage: '/assets/literature-covers/shuji.png',
    pages: [],
  },
  {
    id: 'lit-sanguozhijijie',
    title: '三国志集解',
    shortTitle: '三国志集解',
    author: '卢弼',
    dynasty: '南宋',
    category: '古籍善本',
    source: '四部丛刊影印本',
    format: 'PDF · OCR',
    ocrStatus: '已完成',
    ocrRate: 93,
    totalPages: 720,
    volumes: '共 72 卷',
    summary: '汇集历代注疏与考证，是研读《三国志》的重要参考文献。',
    svnPath: 'trunk/library/sanguozhijijie',
    palette: '#b69258',
    accent: '#6d4b26',
    coverImage: '/assets/literature-covers/sanguozhijijie.png',
    pages: [],
  },
]

const literatureCoverImageByKey: Record<string, string> = {
  houhanshu: '/assets/literature-covers/houhanshu.png',
  'lit-houhanshu': '/assets/literature-covers/houhanshu.png',
  'lit-sanguohuiyao': '/assets/literature-covers/sanguohuiyao.png',
  'lit-sanguozhi': '/assets/literature-covers/sanguozhi.png',
  'lit-sanguozhijijie': '/assets/literature-covers/sanguozhijijie.png',
  'lit-shuji': '/assets/literature-covers/shuji.png',
  'lit-weishu': '/assets/literature-covers/weishu.png',
  'lit-wushu': '/assets/literature-covers/wushu.png',
  'lit-zizhitongjian': '/assets/literature-covers/zizhitongjian.png',
  sanguohuiyao: '/assets/literature-covers/sanguohuiyao.png',
  sanguozhi: '/assets/literature-covers/sanguozhi.png',
  sanguozhijijie: '/assets/literature-covers/sanguozhijijie.png',
  shuji: '/assets/literature-covers/shuji.png',
  weishu: '/assets/literature-covers/weishu.png',
  wushu: '/assets/literature-covers/wushu.png',
  zizhitongjian: '/assets/literature-covers/zizhitongjian.png',
}

function formatBookTitle(title: string) {
  const cleanTitle = title.trim()
  if (!cleanTitle) return ''
  if (cleanTitle.startsWith('《') && cleanTitle.endsWith('》')) return cleanTitle
  return `《${cleanTitle}》`
}

function getLiteratureCoverImage(book: LiteratureCatalogBook) {
  const keyText = [book.id, book.title, book.shortTitle, book.svnPath].join(' ').toLowerCase()
  if (keyText.includes('sanguozhijijie')) return literatureCoverImageByKey.sanguozhijijie
  if (keyText.includes('sanguohuiyao')) return literatureCoverImageByKey.sanguohuiyao
  if (keyText.includes('zizhitongjian')) return literatureCoverImageByKey.zizhitongjian
  if (keyText.includes('houhanshu')) return literatureCoverImageByKey.houhanshu
  if (keyText.includes('sanguozhi')) return literatureCoverImageByKey.sanguozhi
  if (keyText.includes('weishu')) return literatureCoverImageByKey.weishu
  if (keyText.includes('wushu')) return literatureCoverImageByKey.wushu
  if (keyText.includes('shuji')) return literatureCoverImageByKey.shuji
  return literatureCoverImageByKey[book.id] ?? ''
}

type LiteratureSummaryStat = {
  label: string
  value: number
  unit: string
  description: string
  Icon: typeof BookOpen
}

const literatureSummaryDefinitions: Omit<LiteratureSummaryStat, 'value'>[] = [
  {
    label: '\u53e4\u7c4d\u5584\u672c',
    unit: '\u90e8',
    description: '\u6536\u5f55\u7ecf\u53f2\u5b50\u96c6\u4e0e\u5584\u672c\u53e4\u7c4d',
    Icon: BookOpen,
  },
  {
    label: '\u53f2\u4e66\u5178\u7c4d',
    unit: '\u90e8',
    description: '\u4e09\u56fd\u53ca\u76f8\u5173\u53f2\u4e66\u5178\u7c4d\u6761\u76ee',
    Icon: FileText,
  },
  {
    label: '\u8003\u53e4\u62a5\u544a',
    unit: '\u4efd',
    description: '\u51fa\u571f\u9057\u5740\u3001\u5893\u846c\u4e0e\u5668\u7269\u8d44\u6599',
    Icon: Globe2,
  },
  {
    label: '\u56fe\u5f55',
    unit: '\u518c',
    description: '\u56fe\u50cf\u3001\u7248\u753b\u4e0e\u9986\u85cf\u56fe\u5f55\u5165\u53e3',
    Icon: ImageIcon,
  },
  {
    label: '\u8bba\u6587',
    unit: '\u7bc7',
    description: '\u7814\u7a76\u8bba\u6587\u4e0e\u4e13\u9898\u7efc\u8ff0\u7d22\u5f15',
    Icon: FilePenLine,
  },
]

function getLiteratureSummaryCategory(book: LiteratureCatalogBook) {
  if (literatureSummaryDefinitions.some((definition) => definition.label === book.category)) return book.category
  return '\u53f2\u4e66\u5178\u7c4d'
}

function getLiteratureSummaryStats(books: LiteratureCatalogBook[]): LiteratureSummaryStat[] {
  const counts = new Map(literatureSummaryDefinitions.map((definition) => [definition.label, 0]))
  books.forEach((book) => {
    const category = getLiteratureSummaryCategory(book)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  })
  return literatureSummaryDefinitions.map((definition) => ({
    ...definition,
    value: counts.get(definition.label) ?? 0,
  }))
}

function getLiteratureSummaryTotal(stats: LiteratureSummaryStat[]) {
  return stats.reduce((total, stat) => total + stat.value, 0)
}

function formatSummaryCount(value: number) {
  return value.toLocaleString('en-US')
}

function getLiteratureCatalogBooks(
  sources: Array<{ source: BookSource; pages: BookPage[] }>,
  items: CollectionItem[],
): LiteratureCatalogBook[] {
  const sourceBooks = sources.map(({ source, pages }, index): LiteratureCatalogBook => {
    const fallback = fallbackLiteratureBooks[index % fallbackLiteratureBooks.length]
    const book = {
      ...fallback,
      id: source.id,
      title: source.title,
      shortTitle: source.subtitle || source.title.replace(/[（(].*?[）)]/g, '').slice(0, 8),
      author: source.author || fallback.author,
      dynasty: source.dynasty || (source.publishYear ? `${source.publishYear}` : fallback.dynasty),
      category: source.sourceType === '论文研究' ? '论文' : source.sourceType === '展览图录' ? '图录' : '史书典籍',
      source: source.publisher || source.sourceType,
      format: source.format || (pages.length ? '扫描件 · OCR' : fallback.format),
      ocrStatus: pages.some((page) => page.correctedText || page.ocrText) ? '已完成' : '待 OCR',
      ocrRate: pages.some((page) => page.correctedText || page.ocrText) ? 98 : 0,
      totalPages: source.pageCount || pages.length || fallback.totalPages,
      volumes: source.volumeCount || source.chapter || fallback.volumes,
      summary: source.note || fallback.summary,
      svnPath: source.svnOriginalPath || source.scanFolderPath || fallback.svnPath,
      pages,
    }
    return {
      ...book,
      coverImage: source.coverImagePath || getLiteratureCoverImage(book) || fallback.coverImage,
    }
  })

  const itemBooks = items.slice(0, Math.max(0, 8 - sourceBooks.length)).map((item, index): LiteratureCatalogBook => {
    const fallback = fallbackLiteratureBooks[(index + sourceBooks.length) % fallbackLiteratureBooks.length]
    const book = {
      ...fallback,
      id: `item-${item.id}`,
      title: item.title,
      shortTitle: getCompactArchiveTitle(item.title).slice(0, 8),
      author: getItemType(item) || item.sourceTypes[0] || '资料条目',
      dynasty: item.period || fallback.dynasty,
      source: item.sourceTypes[0] || fallback.source,
      summary: item.summary || item.shortNote || fallback.summary,
      archiveItemId: item.id,
    }
    return {
      ...book,
      coverImage: getLiteratureCoverImage(book) || fallback.coverImage,
    }
  })

  return [...sourceBooks, ...fallbackLiteratureBooks, ...itemBooks]
    .filter((book, index, books) => books.findIndex((entry) => entry.id === book.id) === index)
    .slice(0, 12)
}

function LiteratureLibrary({
  sources,
  items,
  initialBookId,
  openArchiveDetail,
  openBookScan,
  copyText,
  isAdmin,
  currentUserName,
  saveLiteratureBook,
}: {
  sources: Array<{ source: BookSource; pages: BookPage[] }>
  items: CollectionItem[]
  initialBookId?: string
  openArchiveDetail: (id: string) => void
  openBookScan: () => void
  copyText: (text: string) => Promise<boolean>
  isAdmin: boolean
  currentUserName: string
  saveLiteratureBook: (source: BookSource, pages: BookPage[]) => void
}) {
  const [hiddenLiteratureIds, setHiddenLiteratureIds] = useState<string[]>(() => readHiddenLiteratureIds())
  const isLiteratureHidden = (bookId: string) => hiddenLiteratureIds.includes(bookId)
  const books = useMemo(
    () => getLiteratureCatalogBooks(sources, items).filter((book) => !hiddenLiteratureIds.includes(book.id)),
    [hiddenLiteratureIds, items, sources],
  )
  const summaryStats = useMemo(() => getLiteratureSummaryStats(books), [books])
  const summaryTotal = getLiteratureSummaryTotal(summaryStats)
  const homeShelfBooks = useMemo(() => {
    const byId = new Map(books.map((book) => [book.id, book]))
    const preferredBookEntries = [
      'lit-sanguozhi',
      'lit-zizhitongjian',
      'lit-houhanshu',
      'lit-sanguohuiyao',
      'lit-weishu',
      'lit-wushu',
      'lit-shuji',
      'lit-sanguozhijijie',
    ]
      .map((id, index) => {
        if (isLiteratureHidden(id)) return null
        const book = byId.get(id) ?? fallbackLiteratureBooks[index % fallbackLiteratureBooks.length]
        return { book, index }
      })
      .filter((entry): entry is { book: LiteratureCatalogBook; index: number } => Boolean(entry))

    const shelfBooks: LiteratureCatalogBook[] = preferredBookEntries.map(({ book, index }) => ({
      ...book,
      id: book.id.startsWith('lit-') ? book.id : `home-shelf-${book.id}`,
      title: [
        '三国志（陈寿）',
        '资治通鉴',
        '后汉书',
        '三国会要',
        '魏书',
        '吴书',
        '蜀记',
        '三国志集解',
      ][index],
      shortTitle: ['三国志', '资治通鉴', '后汉书', '三国会要', '魏书', '吴书', '蜀记', '三国志集解'][index],
      author: ['陈寿', '司马光', '范晔', '王溥', '魏收', '韦昭等', '常璩', '卢弼'][index],
      dynasty: ['西晋', '北宋', '南朝', '宋', '北齐', '唐', '西晋', '南宋'][index],
      category: index === 3 || index === 7 ? '古籍善本' : '史书典籍',
      palette: ['#9f8057', '#bba27c', '#6f7980', '#d1ad72', '#6b5132', '#a46d3d', '#d9c0a0', '#b69258'][index],
      accent: ['#4a3524', '#6a5236', '#28323a', '#654225', '#3b2819', '#5d3520', '#7a5b39', '#6d4b26'][index],
      coverImage: [
        appPath('/assets/literature-covers/sanguozhi.png'),
        appPath('/assets/literature-covers/zizhitongjian.png'),
        appPath('/assets/literature-covers/houhanshu.png'),
        appPath('/assets/literature-covers/sanguohuiyao.png'),
        appPath('/assets/literature-covers/weishu.png'),
        appPath('/assets/literature-covers/wushu.png'),
        appPath('/assets/literature-covers/shuji.png'),
        appPath('/assets/literature-covers/sanguozhijijie.png'),
      ][index],
    }))
    const preferredIds = new Set(shelfBooks.map((book) => book.id))
    return [...shelfBooks, ...books.filter((book) => !preferredIds.has(book.id))].slice(0, 12)
  }, [books, hiddenLiteratureIds])
  const initialLiteraturePageState = useMemo(() => readLiteraturePageState(), [])
  const hasDirectBookRequest = Boolean(initialBookId)
  const getInitialLiteratureBook = () => {
    const preferredBookId = initialBookId || initialLiteraturePageState.activeBookId || 'lit-sanguozhi'
    return books.find((book) => book.id === preferredBookId) ?? homeShelfBooks.find((book) => book.id === preferredBookId) ?? homeShelfBooks[0] ?? books[0]
  }
  const [mode, setMode] = useState<LiteratureMode>(() => (hasDirectBookRequest ? 'detail' : initialLiteraturePageState.mode))
  const [activeBook, setActiveBook] = useState<LiteratureCatalogBook>(getInitialLiteratureBook)
  const [floatingBook, setFloatingBook] = useState<LiteratureCatalogBook | null>(() => homeShelfBooks.find((book) => book.id === 'lit-sanguozhi') ?? homeShelfBooks[0] ?? books[0])
  const [floatingPhase, setFloatingPhase] = useState<LiteratureFloatingPhase>('present')
  const [floatingBookCycle, setFloatingBookCycle] = useState(0)
  const [searchSeed, setSearchSeed] = useState(() => (hasDirectBookRequest ? '' : initialLiteraturePageState.searchSeed ?? ''))
  const shelfScrollRef = useRef<HTMLDivElement | null>(null)
  const shelfDragRef = useRef({ active: false, pointerId: 0, startX: 0, scrollLeft: 0, moved: false, targetBookId: '' })
  const suppressNextShelfClickRef = useRef(false)
  const literatureScrollRestoredRef = useRef(false)
  const [featuredFavoriteIds, setFeaturedFavoriteIds] = useState<string[]>([])
  const [featuredAdminMenuOpen, setFeaturedAdminMenuOpen] = useState(false)

  useEffect(() => {
    if (!homeShelfBooks.some((book) => book.id === activeBook.id)) setActiveBook(homeShelfBooks[0] ?? books[0])
  }, [activeBook.id, books, homeShelfBooks])

  useEffect(() => {
    if (!initialBookId) return
    const requestedBook = books.find((book) => book.id === initialBookId) ?? homeShelfBooks.find((book) => book.id === initialBookId)
    if (!requestedBook) return
    setActiveBook(requestedBook)
    setFloatingBook(requestedBook)
    setFloatingPhase('present')
    setMode('detail')
  }, [books, homeShelfBooks, initialBookId])

  useEffect(() => {
    writeLiteraturePageState({
      mode,
      activeBookId: activeBook.id,
      searchSeed,
      scrollY: typeof window === 'undefined' ? 0 : window.scrollY,
    })
  }, [activeBook.id, mode, searchSeed])

  useEffect(() => {
    if (hasDirectBookRequest || literatureScrollRestoredRef.current) return
    literatureScrollRestoredRef.current = true
    const scrollY = initialLiteraturePageState.scrollY ?? 0
    if (scrollY <= 0) return
    const timer = window.setTimeout(() => window.scrollTo({ top: scrollY, behavior: 'auto' }), 0)
    return () => window.clearTimeout(timer)
  }, [hasDirectBookRequest, initialLiteraturePageState.scrollY])

  useEffect(() => {
    let frame = 0
    const writeScrollPosition = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        writeLiteraturePageState({
          mode,
          activeBookId: activeBook.id,
          searchSeed,
          scrollY: window.scrollY,
        })
      })
    }
    window.addEventListener('scroll', writeScrollPosition, { passive: true })
    return () => {
      window.removeEventListener('scroll', writeScrollPosition)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [activeBook.id, mode, searchSeed])

  const chooseBook = (book: LiteratureCatalogBook) => {
    setActiveBook(book)
    setFloatingBook(book)
    setFloatingBookCycle((current) => current + 1)
    setFloatingPhase('enter')
  }
  const openEditBook = (book: LiteratureCatalogBook) => {
    setActiveBook(book)
    setMode('edit')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
  const archiveLiteratureBook = (book: LiteratureCatalogBook) => {
    const nextHiddenIds = Array.from(new Set([...hiddenLiteratureIds, book.id]))
    setHiddenLiteratureIds(nextHiddenIds)
    writeHiddenLiteratureIds(nextHiddenIds)
    const nextBook = books.find((entry) => entry.id !== book.id) ?? homeShelfBooks.find((entry) => entry.id !== book.id)
    if (nextBook) setActiveBook(nextBook)
    setMode('search')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
  const openReader = (book: LiteratureCatalogBook) => {
    setActiveBook(book)
    setMode('reader')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
  const openSearchPage = (seed = '') => {
    setSearchSeed(seed)
    setMode('search')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
  const copyCitation = async (book: LiteratureCatalogBook) => {
    await copyText(`${book.author}：${formatBookTitle(book.shortTitle)}，${book.source}，${book.dynasty}。`)
  }
  const shareBook = async (book: LiteratureCatalogBook) => {
    await copyText(getLiteratureBookUrl(book))
  }
  const toggleFeaturedFavorite = (bookId: string) => {
    setFeaturedFavoriteIds((current) => (current.includes(bookId) ? current.filter((id) => id !== bookId) : [...current, bookId]))
  }
  const scrollShelf = (direction: -1 | 1) => {
    const rail = shelfScrollRef.current
    if (!rail) return
    rail.scrollBy({ left: direction * Math.max(rail.clientWidth * 0.72, 360), behavior: 'smooth' })
  }
  const selectShelfBook = (book: LiteratureCatalogBook, options: { fromPointerUp?: boolean } = {}) => {
    if (suppressNextShelfClickRef.current && !options.fromPointerUp) return
    if (shelfDragRef.current.moved) return
    const delay = window.scrollY > 120 ? 180 : 0
    window.scrollTo({ top: 0, behavior: delay ? 'smooth' : 'auto' })
    window.setTimeout(() => chooseBook(book), delay)
  }
  const selectShelfBookById = (bookId: string) => {
    const book = homeShelfBooks.find((entry) => entry.id === bookId)
    if (book) selectShelfBook(book, { fromPointerUp: true })
  }
  const handleShelfPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = shelfScrollRef.current
    if (!rail) return
    const targetBookId =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.literature-book-item')?.dataset.bookId ?? '' : ''
    shelfDragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: rail.scrollLeft,
      moved: false,
      targetBookId,
    }
    rail.setPointerCapture(event.pointerId)
  }
  const handleShelfPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = shelfScrollRef.current
    const drag = shelfDragRef.current
    if (!rail || !drag.active) return
    const deltaX = event.clientX - drag.startX
    if (Math.abs(deltaX) > 10) drag.moved = true
    rail.scrollLeft = drag.scrollLeft - deltaX
  }
  const endShelfDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = shelfScrollRef.current
    if (rail?.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId)
    shelfDragRef.current.active = false
    shelfDragRef.current.moved = false
    shelfDragRef.current.targetBookId = ''
  }
  const handleShelfPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = shelfScrollRef.current
    if (rail?.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId)
    const drag = shelfDragRef.current
    const shouldSelectBook = drag.active && !drag.moved && Boolean(drag.targetBookId)
    drag.active = false
    if (shouldSelectBook) {
      suppressNextShelfClickRef.current = true
      selectShelfBookById(drag.targetBookId)
    }
    window.setTimeout(() => {
      drag.moved = false
      drag.targetBookId = ''
      suppressNextShelfClickRef.current = false
    }, 0)
  }

  useEffect(() => {
    if (floatingPhase !== 'enter') return
    const timer = window.setTimeout(() => setFloatingPhase('present'), 980)
    return () => window.clearTimeout(timer)
  }, [floatingPhase, floatingBook?.id])

  if (mode === 'search') {
    return (
      <LiteratureSearchPage
        books={books}
        initialQuery={searchSeed}
        backHome={() => setMode('home')}
        openReader={openReader}
        openDetail={(book) => {
          setActiveBook(book)
          setMode('detail')
        }}
        copyCitation={copyCitation}
        isAdmin={isAdmin}
        openEditBook={openEditBook}
      />
    )
  }

  if (mode === 'detail') {
    return (
      <LiteratureDetailPage
        book={activeBook}
        books={books}
        relatedBooks={books.filter((book) => book.id !== activeBook.id).slice(0, 3)}
        backToSearch={() => setMode('home')}
        openReader={() => openReader(activeBook)}
        openArchiveDetail={openArchiveDetail}
        openRelated={(book) => {
          setActiveBook(book)
          setMode('detail')
        }}
        copyCitation={copyCitation}
        copyText={copyText}
        openBookScan={openBookScan}
        isAdmin={isAdmin}
        openEditBook={() => openEditBook(activeBook)}
      />
    )
  }

  if (mode === 'edit') {
    const sourceEntry = sources.find((entry) => entry.source.id === activeBook.id)
    return (
      <LiteratureEditPage
        book={activeBook}
        source={sourceEntry?.source}
        pages={sourceEntry?.pages ?? activeBook.pages}
        currentUserName={currentUserName}
        backToDetail={() => setMode('detail')}
        copyText={copyText}
        onArchiveBook={() => archiveLiteratureBook(activeBook)}
        saveLiteratureBook={(source, pages) => {
          saveLiteratureBook(source, pages)
          setActiveBook({
            ...activeBook,
            title: source.title,
            shortTitle: source.subtitle || source.title.replace(/[（(].*?[）)]/g, '').slice(0, 8),
            author: source.author || activeBook.author,
            dynasty: source.dynasty || (source.publishYear ? `${source.publishYear}` : activeBook.dynasty),
            category: source.sourceType === '论文研究' ? '论文' : source.sourceType === '展览图录' ? '图录' : '史书典籍',
            source: source.publisher || source.sourceType,
            format: source.format || activeBook.format,
            totalPages: source.pageCount || pages.length || activeBook.totalPages,
            volumes: source.volumeCount || source.chapter || activeBook.volumes,
            summary: source.note || activeBook.summary,
            svnPath: source.svnOriginalPath || source.scanFolderPath || activeBook.svnPath,
            coverImage: source.coverImagePath || activeBook.coverImage,
            pages,
          })
          setMode('detail')
        }}
      />
    )
  }

  if (mode === 'reader') {
    return <LiteratureReaderPage book={activeBook} backToDetail={() => setMode('detail')} copyCitation={() => copyCitation(activeBook)} />
  }

  return (
    <main className="literature-page">
      <section className="literature-hero">
        <div className="literature-hero-backdrop" aria-hidden="true" />
        <div className="literature-hero-model">
          {floatingBook && <FloatingLiteratureBook key={`${floatingBook.id}-${floatingBookCycle}`} book={floatingBook} phase={floatingPhase} />}
        </div>
        <div className="literature-hero-copy">
          <h1>{'\u6587\u732e\u68c0\u7d22'}</h1>
          <p className="literature-hero-en">TEXTUAL ARCHIVE</p>
          <p className="literature-hero-subtitle">
            {'\u6536\u5f55\u53e4\u7c4d\u3001\u8bba\u6587\u3001\u56fe\u5f55\u4e0e\u8003\u53e4\u62a5\u544a\uff0c\u652f\u6301\u5168\u6587\u68c0\u7d22\u3001\u539f\u4ef6\u9605\u8bfb\u3001'}
            <br />
            {'\u8d44\u6599\u6458\u5f55\u4e0e\u5f15\u7528\u8ffd\u6eaf\u3002'}
          </p>
          <button type="button" className="literature-hero-primary" onClick={() => openSearchPage()}>
            探索文献库
            <ChevronRight size={18} />
          </button>
        </div>
        <aside className="literature-feature-card">
          <span className="literature-feature-eyebrow">当前文献</span>
          <LiteratureBookCover book={activeBook} size="large" />
          <div className="literature-feature-info">
            <h2>{formatBookTitle(activeBook.title)}</h2>
            <dl>
              <div><dt>作者</dt><dd>{activeBook.author}</dd></div>
              <div><dt>类别</dt><dd>{activeBook.category}</dd></div>
              <div><dt>格式</dt><dd>{activeBook.format}</dd></div>
              <div><dt>页数</dt><dd>共 {activeBook.totalPages} 页</dd></div>
              <div><dt>OCR 状态</dt><dd>{activeBook.ocrStatus}</dd></div>
              <div><dt>来源</dt><dd>{activeBook.source}</dd></div>
            </dl>
          </div>
          <div className="literature-feature-actions">
            <button type="button" onClick={() => openReader(activeBook)}>
              <BookOpen size={17} />
              打开文献
            </button>
            {isAdmin && (
              <span className="literature-admin-more-wrap">
                <button
                  type="button"
                  className="secondary-control"
                  aria-expanded={featuredAdminMenuOpen}
                  onClick={() => setFeaturedAdminMenuOpen((open) => !open)}
                >
                  <MoreHorizontal size={16} />
                  更多
                </button>
                {featuredAdminMenuOpen && (
                  <span className="literature-more-menu literature-feature-admin-menu">
                    <button type="button" onClick={() => openEditBook(activeBook)}>
                      <FilePenLine size={15} /> 编辑元信息
                    </button>
                    <button type="button" onClick={openBookScan}>
                      <Download size={15} /> 替换文件
                    </button>
                    <button type="button" onClick={openBookScan}>
                      <RefreshCw size={15} /> 重新 OCR
                    </button>
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="literature-feature-tools">
            <button
              type="button"
              className={featuredFavoriteIds.includes(activeBook.id) ? 'active' : ''}
              onClick={() => toggleFeaturedFavorite(activeBook.id)}
            >
              <Tag size={15} /> 加入书架
            </button>
            <button type="button" onClick={() => copyCitation(activeBook)}>
              <Copy size={15} /> 引用
            </button>
            <button type="button" onClick={() => shareBook(activeBook)}>
              <Share2 size={15} /> 分享
            </button>
          </div>
        </aside>
      </section>
      <section className="literature-carousel" aria-label="推荐文献书架">
        <div className="literature-carousel-head">
          <h2>精选文献</h2>
          <div><span /><button type="button" onClick={() => openSearchPage()}>查看全部 <ChevronRight size={16} /></button></div>
        </div>
        <div className="literature-book-rail">
          <button type="button" className="literature-rail-arrow" aria-label="上一组文献" onClick={() => scrollShelf(-1)}><ChevronRight size={18} /></button>
          <div
            className="literature-book-shelf-scroll"
            ref={shelfScrollRef}
            onPointerDown={handleShelfPointerDown}
            onPointerMove={handleShelfPointerMove}
            onPointerUp={handleShelfPointerUp}
            onPointerCancel={endShelfDrag}
          >
            <div className="literature-book-track">
              {homeShelfBooks.map((book) => (
                <button
                  type="button"
                  className={activeBook.id === book.id ? 'literature-book-item active' : 'literature-book-item'}
                  data-book-id={book.id}
                  key={book.id}
                  onClick={() => selectShelfBook(book)}
                >
                  <LiteratureBookCover book={book} />
                  <strong>{formatBookTitle(book.shortTitle)}</strong>
                  <span>{book.author}{' \u00b7 ' }{book.dynasty}</span>
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="literature-rail-arrow next" aria-label="下一组文献" onClick={() => scrollShelf(1)}><ChevronRight size={18} /></button>
        </div>
      </section>
      <section className="literature-summary-section" aria-label="资料总览">
        <div className="literature-summary-head">
          <div>
            <h2>{'\u8d44\u6599\u603b\u89c8'}</h2>
            <p>{`\u4e09\u56fd\u5386\u53f2\u8d44\u6599\u5e93\u5f53\u524d\u6536\u5f55 ${formatSummaryCount(summaryTotal)} \u6761\u8d44\u6599\uff0c\u8986\u76d6\u53e4\u7c4d\u3001\u53f2\u4e66\u3001\u8003\u53e4\u3001\u56fe\u5f55\u4e0e\u8bba\u6587\u7814\u7a76\u3002`}</p>
          </div>
        </div>
        <div className="literature-summary-grid">
          {summaryStats.map((entry) => {
            const { label, value, unit, description, Icon } = entry
            return (
              <button
                type="button"
                className="literature-summary-card"
                key={label}
                onClick={() => openSearchPage(label)}
              >
                <div>
                  <span className="literature-summary-card-head"><Icon size={21} /><strong>{label}</strong></span>
                  <p><span>{formatSummaryCount(value)}</span><small>{unit}</small></p>
                  <em>{description}</em>
                </div>
              </button>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function LiteratureSearchPage({
  books,
  initialQuery = '',
  backHome,
  openDetail,
  openReader,
  copyCitation,
  isAdmin,
  openEditBook,
}: {
  books: LiteratureCatalogBook[]
  initialQuery?: string
  backHome: () => void
  openDetail: (book: LiteratureCatalogBook) => void
  openReader: (book: LiteratureCatalogBook) => void
  copyCitation: (book: LiteratureCatalogBook) => void
  isAdmin: boolean
  openEditBook: (book: LiteratureCatalogBook) => void
}) {
  const TEXT = {
    all: '\u5168\u90e8',
    library: '\u6587\u732e\u5e93',
    searchTitle: '\u6587\u732e\u68c0\u7d22',
    searchIntro: '\u68c0\u7d22\u53e4\u7c4d\u3001\u8bba\u6587\u3001\u56fe\u5f55\u4e0e\u8003\u53e4\u62a5\u544a\uff0c\u67e5\u770b\u626b\u63cf\u539f\u4ef6\u3001OCR \u6587\u672c\u53ca\u5f15\u7528\u6765\u6e90\u3002',
    filterTitle: '\u7b5b\u9009\u6761\u4ef6',
    reset: '\u91cd\u7f6e',
    clearFilters: '\u6e05\u7a7a\u7b5b\u9009\u6761\u4ef6',
    categoryTitle: '\u6587\u732e\u7c7b\u578b',
    ancientBooks: '\u53e4\u7c4d\u5584\u672c',
    classics: '\u53f2\u4e66\u5178\u7c4d',
    archaeology: '\u8003\u53e4\u62a5\u544a',
    catalog: '\u56fe\u5f55',
    papers: '\u8bba\u6587',
    unitBook: '\u90e8',
    unitReport: '\u4efd',
    unitCatalog: '\u518c',
    unitPaper: '\u7bc7',
    dynasty: '\u671d\u4ee3',
    author: '\u4f5c\u8005',
    source: '\u6765\u6e90',
    ocrStatus: 'OCR\u72b6\u6001',
    tags: '\u6807\u7b7e',
    westJin: '\u897f\u664b',
    southernDynasty: '\u5357\u671d',
    song: '\u5b8b',
    northernSong: '\u5317\u5b8b',
    chenShou: '\u9648\u5bff',
    fanYe: '\u8303\u6654',
    simaGuang: '\u53f8\u9a6c\u5149',
    wangChang: '\u738b\u6636',
    nationalLibrary: '\u56fd\u5bb6\u56fe\u4e66\u9986\u85cf\u672c',
    commercialPress: '\u5546\u52a1\u5370\u4e66\u9986\u5f71\u5370\u672c',
    siku: '\u56db\u90e8\u4e1b\u520a\u5f71\u5370\u672c',
    done: '\u5df2\u5b8c\u6210',
    partialDone: '\u90e8\u5206\u5b8c\u6210',
    pendingOcr: '\u5f85 OCR',
    costumeSystem: '\u670d\u9970\u5236\u5ea6',
    capClothing: '\u51a0\u670d',
    historicalMaterial: '\u53f2\u6599',
    textualResearch: '\u8003\u8bc1',
    resultPrefix: '\u5171',
    resultSuffix: '\u6761\u7ed3\u679c',
    placeholder: '\u641c\u7d22\u6587\u732e\u3001\u4e66\u540d\u3001\u4f5c\u8005\u3001\u5173\u952e\u8bcd\u3001OCR \u5168\u6587...',
    relevance: '\u76f8\u5173\u5ea6',
    pagesFirst: '\u9875\u6570\u4f18\u5148',
    ocrCompletion: 'OCR \u5b8c\u6210\u5ea6',
    gridView: '\u7f51\u683c\u89c6\u56fe',
    listView: '\u5217\u8868\u89c6\u56fe',
    sourcePrefix: '\u6765\u6e90\uff1a',
    match: 'OCR\u5b8c\u6210\u5ea6',
    detail: '\u67e5\u770b\u8be6\u60c5',
    read: '\u5f00\u59cb\u9605\u8bfb',
    favorite: '\u52a0\u5165\u4e66\u67b6',
    citation: '\u5f15\u7528',
  }
  const categoryLabels = [TEXT.ancientBooks, TEXT.classics, TEXT.archaeology, TEXT.catalog, TEXT.papers]
  const seededCategory = categoryLabels.includes(initialQuery) ? initialQuery : TEXT.all
  const seededQuery = seededCategory === TEXT.all ? initialQuery : ''
  const [query, setQuery] = useState(seededQuery)
  const [activeCategory, setActiveCategory] = useState(seededCategory)
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [openFilterGroups, setOpenFilterGroups] = useState<string[]>([TEXT.categoryTitle])
  const [sortMode, setSortMode] = useState<'relevance' | 'pages' | 'ocr'>('relevance')
  const [favoriteIds, setFavoriteIds] = useState<string[]>([])
  const [openMoreBookId, setOpenMoreBookId] = useState('')

  const categoryCounts = useMemo(() => books.reduce<Record<string, number>>((acc, book) => {
    acc[book.category] = (acc[book.category] ?? 0) + 1
    return acc
  }, {}), [books])

  const categoryStats = [
    { label: TEXT.all, count: books.length },
    { label: TEXT.ancientBooks, count: categoryCounts[TEXT.ancientBooks] ?? 0 },
    { label: TEXT.classics, count: categoryCounts[TEXT.classics] ?? 0 },
    { label: TEXT.archaeology, count: categoryCounts[TEXT.archaeology] ?? 0 },
    { label: TEXT.catalog, count: categoryCounts[TEXT.catalog] ?? 0 },
    { label: TEXT.papers, count: categoryCounts[TEXT.papers] ?? 0 },
  ] as const
  const visibleCategoryStats = categoryStats.filter((entry) => entry.label === TEXT.all || entry.count > 0)

  const countOptions = (values: string[]) =>
    Object.entries(values.reduce<Record<string, number>>((acc, value) => {
      if (!value) return acc
      acc[value] = (acc[value] ?? 0) + 1
      return acc
    }, {}))
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'zh-Hans-CN'))
      .slice(0, 6)
      .map(([label, count]) => [label, count.toLocaleString()] as const)

  const getBookTags = (book: LiteratureCatalogBook) =>
    [book.category, book.dynasty, book.ocrStatus, ...book.summary.match(/服饰|冠服|冠帽|史料|考证|制度|礼制|人物|图像|陶俑|甲胄/g) ?? []]

  const filterGroups = [
    {
      title: TEXT.categoryTitle,
      icon: FileText,
      options: countOptions(books.map((book) => book.category)),
    },
    { title: TEXT.dynasty, icon: Clock3, options: countOptions(books.map((book) => book.dynasty)) },
    { title: TEXT.author, icon: User, options: countOptions(books.map((book) => book.author)) },
    { title: TEXT.source, icon: FolderOpen, options: countOptions(books.map((book) => book.source)) },
    { title: TEXT.ocrStatus, icon: Check, options: countOptions(books.map((book) => book.ocrStatus)) },
    { title: TEXT.tags, icon: Tag, options: countOptions(books.flatMap((book) => getBookTags(book))) },
  ]

  const toggleFilter = (value: string) => {
    setSelectedTypes((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]))
  }

  const toggleFilterGroup = (title: string) => {
    setOpenFilterGroups((current) => (current.includes(title) ? current.filter((item) => item !== title) : [...current, title]))
  }

  const clearFilters = () => {
    setQuery('')
    setSelectedTypes([])
    setActiveCategory(TEXT.all)
  }

  const getBookMatch = (book: LiteratureCatalogBook) => Math.max(74, Math.min(98, book.ocrRate || 86))

  const filteredBooks = books
    .filter((book) => {
      const searchText = [book.title, book.shortTitle, book.author, book.category, book.source, book.summary].join(' ').toLowerCase()
      const queryMatched = getSearchTerms(query).every((term) => searchText.includes(term.toLowerCase()))
      const categoryMatched = activeCategory === TEXT.all ? true : book.category === activeCategory
      const filterMatched = selectedTypes.length === 0 || selectedTypes.some((value) => searchText.includes(value.toLowerCase()))
      return queryMatched && categoryMatched && filterMatched
    })
    .sort((first, second) => {
      const classicOrder = ['lit-sanguozhi', 'lit-houhanshu', 'lit-zizhitongjian', 'lit-sanguohuiyao']
      if (sortMode === 'pages') return second.totalPages - first.totalPages
      if (sortMode === 'ocr') return second.ocrRate - first.ocrRate
      return (classicOrder.includes(first.id) ? classicOrder.indexOf(first.id) : 99) - (classicOrder.includes(second.id) ? classicOrder.indexOf(second.id) : 99)
    })

  return (
    <main className="literature-page literature-search-page">
      <section className="literature-search-hero">
        <div className="literature-page-breadcrumb" aria-label="文献检索路径">
          <button type="button" className="literature-crumb-link" onClick={backHome}>{TEXT.library}</button>
          <span>/</span>
          <em>{TEXT.searchTitle}</em>
        </div>
        <h1>{TEXT.searchTitle}</h1>
        <p>{TEXT.searchIntro}</p>
      </section>
      <section className="literature-search-layout">
        <aside className="literature-filter-panel">
          <div className="literature-filter-head">
            <h2>{TEXT.filterTitle}</h2>
            <button type="button" onClick={clearFilters}><RefreshCw size={15} /> {TEXT.reset}</button>
          </div>
          {filterGroups.map((group) => {
            const Icon = group.icon
            const isOpen = openFilterGroups.includes(group.title)
            return (
              <div className={`literature-filter-group ${isOpen ? 'open' : ''}`} key={group.title}>
                <button type="button" className="literature-filter-group-title" onClick={() => toggleFilterGroup(group.title)}>
                  <span><Icon size={15} /> {group.title}</span>
                  <ChevronDown size={15} />
                </button>
                {isOpen && group.options.map(([label, count]) => (
                  <label key={label}>
                    <input type="checkbox" checked={selectedTypes.includes(label)} onChange={() => toggleFilter(label)} />
                    <span>{label}</span>
                    <small>{count}</small>
                  </label>
                ))}
              </div>
            )
          })}
          <button type="button" className="literature-clear-filters" onClick={clearFilters}>{TEXT.clearFilters}</button>
        </aside>

        <section className="literature-search-main">
          <div className="literature-type-tabs" aria-label="文献类型快捷筛选">
            {visibleCategoryStats.map(({ label, count }) => (
              <button
                type="button"
                className={activeCategory === label ? 'active' : ''}
                key={label}
                onClick={() => setActiveCategory(label)}
                aria-pressed={activeCategory === label}
              >
                <strong>{label}</strong>
                <span>{count.toLocaleString()}</span>
              </button>
            ))}
          </div>
          <section className="literature-result-area">
            <div className="literature-result-toolbar">
              <label>
                <Search size={16} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={TEXT.placeholder} />
              </label>
              <strong>{TEXT.resultPrefix} {filteredBooks.length.toLocaleString()} {TEXT.resultSuffix}</strong>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}>
                <option value="relevance">{TEXT.relevance}</option>
                <option value="pages">{TEXT.pagesFirst}</option>
                <option value="ocr">{TEXT.ocrCompletion}</option>
              </select>
              <button type="button" className="literature-view-button" aria-label={TEXT.gridView}><Grid3X3 size={17} /></button>
              <button type="button" className="literature-view-button active" aria-label={TEXT.listView}><Menu size={17} /></button>
            </div>
            <div className="literature-result-list">
              {filteredBooks.map((book) => (
                <article className="literature-result-row" key={book.id}>
                  <button type="button" className="literature-result-cover" onClick={() => openDetail(book)}><LiteratureBookCover book={book} /></button>
                  <div className="literature-result-main">
                    <h2>{formatBookTitle(book.title)}</h2>
                    <span>{book.author}{' \u00b7 ' }{book.dynasty}</span>
                    <p>{book.summary}</p>
                    <div>
                      <small>{TEXT.sourcePrefix}{book.source}</small>
                      <small>{book.format.includes('PDF') ? 'PDF' : book.format}</small>
                      <small className="ocr-done">{book.ocrStatus}</small>
                    </div>
                  </div>
                  <div className="literature-result-match">{TEXT.match}<strong>{getBookMatch(book)}%</strong></div>
                  <div className="literature-result-actions">
                    <button type="button" onClick={() => openReader(book)}>{TEXT.read}</button>
                    <button type="button" className="secondary-control" onClick={() => openDetail(book)}>{TEXT.detail}</button>
                    <div>
                      <button type="button" className={favoriteIds.includes(book.id) ? 'active' : ''} onClick={() => setFavoriteIds((current) => (current.includes(book.id) ? current.filter((id) => id !== book.id) : [...current, book.id]))}>
                        <Star size={16} /> {TEXT.favorite}
                      </button>
                      <button type="button" onClick={() => copyCitation(book)}><Copy size={15} /> {TEXT.citation}</button>
                      {isAdmin && (
                        <span className="literature-more-wrap">
                          <button
                            type="button"
                            aria-expanded={openMoreBookId === book.id}
                            onClick={() => setOpenMoreBookId((current) => (current === book.id ? '' : book.id))}
                          >
                            <MoreHorizontal size={15} /> 更多
                          </button>
                          {openMoreBookId === book.id && (
                            <span className="literature-more-menu">
                              <button type="button" onClick={() => openEditBook(book)}>
                                <FilePenLine size={15} /> 编辑文献
                              </button>
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </section>
      </section>
    </main>
  )
}


function LiteratureDetailPage({
  book,
  books,
  relatedBooks,
  backToSearch,
  openReader,
  openRelated,
  openArchiveDetail,
  copyCitation,
  copyText,
  openBookScan,
  isAdmin,
  openEditBook,
}: {
  book: LiteratureCatalogBook
  books: LiteratureCatalogBook[]
  relatedBooks: LiteratureCatalogBook[]
  backToSearch: () => void
  openReader: () => void
  openRelated: (book: LiteratureCatalogBook) => void
  openArchiveDetail: (id: string) => void
  copyCitation: (book: LiteratureCatalogBook) => void
  copyText: (text: string) => Promise<boolean>
  openBookScan: () => void
  isAdmin: boolean
  openEditBook: () => void
}) {
  const [favorite, setFavorite] = useState(false)
  const [adminMenuOpen, setAdminMenuOpen] = useState(false)
  const currentBookIndex = Math.max(0, books.findIndex((entry) => entry.id === book.id))
  const previousBook = books.length > 1 ? books[(currentBookIndex - 1 + books.length) % books.length] : undefined
  const nextBook = books.length > 1 ? books[(currentBookIndex + 1) % books.length] : undefined
  const previewPages = [
    { label: '封面', image: '' },
    { label: '目录', image: appPath('/assets/literature-reader-thumb.png') },
    { label: '卷一', image: appPath('/assets/literature-reader-thumb.png') },
    { label: '卷二', image: appPath('/assets/literature-reader-thumb.png') },
    { label: '札记', image: appPath('/assets/literature-reader-thumb.png') },
  ]
  const chapterRows = [
    ['本纪', '共 3 卷', '志', '共 30 卷'],
    ['传', '共 86 卷', '表', '共 5 卷'],
    ['赞', '共 12 卷', '', ''],
  ]
  const shareDetail = async () => {
    const formattedTitle = formatBookTitle(book.title)
    const shareText = `${formattedTitle}｜${book.source}`
    const detailUrl = getLiteratureBookUrl(book)
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ title: formattedTitle, text: shareText, url: detailUrl })
        return
      } catch {
        // Fall through to copying the URL when native share is cancelled or unavailable.
      }
    }
    await copyText(detailUrl)
  }

  return (
    <main className="literature-page literature-detail-page">
      <div className="literature-page-breadcrumb" aria-label="文献详情路径">
        <button type="button" className="literature-crumb-link" onClick={backToSearch}>{'\u6587\u732e\u5e93'}</button>
        <span>/</span>
        <em>{'\u6587\u732e\u8be6\u60c5'}</em>
      </div>
      <section className="literature-detail-hero">
        <div className="literature-detail-stage">
          <button type="button" aria-label="上一本文献" onClick={() => previousBook && openRelated(previousBook)} disabled={!previousBook}><ChevronRight size={18} /></button>
          <div className="literature-detail-book-display">
            <LiteratureBookCover book={book} size="large" />
          </div>
          <button type="button" className="next" aria-label="下一本文献" onClick={() => nextBook && openRelated(nextBook)} disabled={!nextBook}><ChevronRight size={18} /></button>
          <div className="literature-page-thumbs" aria-label="页面缩略图">
            <button type="button" aria-label="上一组页面"><ChevronRight size={15} /></button>
            {previewPages.map((page, index) => (
              <span className={index === 0 ? 'active' : ''} key={page.label}>
                {page.image ? <img src={page.image} alt={page.label} /> : <LiteratureBookCover book={book} />}
              </span>
            ))}
            <button type="button" className="next" aria-label="下一组页面"><ChevronRight size={15} /></button>
          </div>
        </div>
        <div className="literature-detail-info">
          {isAdmin && (
            <div className="literature-detail-admin">
              <button type="button" className="secondary-control" onClick={openEditBook}>
                <FilePenLine size={16} /> 编辑
              </button>
              <span className="literature-admin-more-wrap">
                <button
                  type="button"
                  className="secondary-control"
                  aria-expanded={adminMenuOpen}
                  onClick={() => setAdminMenuOpen((open) => !open)}
                >
                  <MoreHorizontal size={16} /> 更多
                </button>
                {adminMenuOpen && (
                  <span className="literature-more-menu literature-detail-admin-menu">
                    <button type="button" onClick={openBookScan}>
                      <Download size={15} /> 替换文件
                    </button>
                    <button type="button" onClick={openBookScan}>
                      <RefreshCw size={15} /> 重新 OCR
                    </button>
                  </span>
                )}
              </span>
            </div>
          )}
          <h1>{formatBookTitle(book.title)}</h1>
          <p>{book.summary}</p>
          <div className="literature-meta-grid">
            <Info label="作者" value={book.author} />
            <Info label="类别" value={book.category} />
            <Info label="朝代" value={book.dynasty} />
            <Info label="格式" value={book.format} />
            <Info label="来源" value={book.source} />
            <Info label="OCR 状态" value={`${book.ocrStatus}${book.ocrRate ? `（${book.ocrRate}%）` : ''}`} />
            <Info label="册数 / 页数" value={`${book.volumes} / 共 ${book.totalPages} 页`} />
            <Info label="SVN 来源" value={book.svnPath ?? 'trunk/library/sanguozhi'} />
          </div>
          <div className="literature-detail-actions">
            <button type="button" onClick={openReader}><BookOpen size={17} /> 打开文献</button>
            {book.archiveItemId && <button type="button" className="secondary-control" onClick={() => openArchiveDetail(book.archiveItemId!)}>查看资料条目</button>}
            <button type="button" className={favorite ? 'secondary-control active' : 'secondary-control'} onClick={() => setFavorite((current) => !current)}><Star size={16} /> 收藏</button>
            <button type="button" className="secondary-control" onClick={() => copyCitation(book)}><Copy size={16} /> 引用</button>
            <button type="button" className="secondary-control" onClick={shareDetail}><Share2 size={16} /> 分享</button>
          </div>
        </div>
      </section>
      <section className="literature-detail-grid">
        <article>
          <h2><BookOpen size={18} /> 内容简介</h2>
          <p>{formatBookTitle(book.shortTitle)}由西晋史学家陈寿所著，记载自东汉末年至西晋初年近百年的历史。全书以纪、志、传、表等体例组织，是研究三国历史、制度、人物与典章服饰的重要史料之一。</p>
        </article>
        <article>
          <h2><FileText size={18} /> 目录 / 章节结构</h2>
          <div className="literature-chapter-grid">
            {chapterRows.map(([leftTitle, leftCount, rightTitle, rightCount]) => (
              <Fragment key={`${leftTitle}-${rightTitle}`}>
                <button type="button" onClick={openReader}><span>{leftTitle}</span><small>{leftCount}</small><ChevronRight size={15} /></button>
                {rightTitle && <button type="button" onClick={openReader}><span>{rightTitle}</span><small>{rightCount}</small><ChevronRight size={15} /></button>}
              </Fragment>
            ))}
          </div>
        </article>
        <article>
          <h2><FolderOpen size={18} /> 来源信息</h2>
          <dl className="literature-source-info">
            <div><dt>藏品来源</dt><dd>{book.source}</dd></div>
            <div><dt>版本信息</dt><dd>明万历刻本</dd></div>
            <div><dt>数字化时间</dt><dd>2021-06-18</dd></div>
            <div><dt>扫描提供</dt><dd>国家图书馆数字资源部</dd></div>
            <div><dt>SVN 路径</dt><dd><code>{book.svnPath ?? 'trunk/library/sanguozhi'}（版本：r1287）</code></dd></div>
            <div><dt>备注</dt><dd>该版本为通行本，内容较完整，适合研究引用。</dd></div>
          </dl>
        </article>
        <article>
          <div className="literature-card-head">
            <h2><FileText size={18} /> 相关文献</h2>
            <button type="button" onClick={backToSearch}>查看更多 <ChevronRight size={15} /></button>
          </div>
          <div className="literature-related-row">
            {relatedBooks.map((related) => (
              <button type="button" key={related.id} onClick={() => openRelated(related)}>
                <LiteratureBookCover book={related} />
                <span className="literature-related-meta"><strong>{formatBookTitle(related.shortTitle)}</strong><small>{related.author} · {related.dynasty}</small><em>{related.volumes}</em></span>
              </button>
            ))}
          </div>
        </article>
      </section>
    </main>
  )
}

const literatureEditTabs = ['基础信息', '文件与 SVN', '页面与 OCR', '关联资料', '引用与备注', '修改记录'] as const
type LiteratureEditTab = (typeof literatureEditTabs)[number]
const literatureSourceTypeOptions: Array<{ value: BookSourceType; label: string }> = [
  { value: '史料典籍', label: '史书典籍' },
  { value: '现代书籍', label: '现代书籍' },
  { value: '展览图录', label: '图录' },
  { value: '论文研究', label: '论文' },
]
const literatureLanguageOptions = ['中文', '日文', '英文']

function getLiteratureEditTabIcon(tab: LiteratureEditTab) {
  if (tab === '基础信息') return <Grid3X3 size={15} />
  if (tab === '文件与 SVN') return <FolderOpen size={15} />
  if (tab === '页面与 OCR') return <FileText size={15} />
  if (tab === '关联资料') return <Link2 size={15} />
  if (tab === '引用与备注') return <FilePenLine size={15} />
  return <Clock3 size={15} />
}

function getBookSourceTypeFromCategory(category: string): BookSourceType {
  if (category.includes('论文')) return '论文研究'
  if (category.includes('图录')) return '展览图录'
  if (category.includes('现代')) return '现代书籍'
  return '史料典籍'
}

function splitLiteratureTokens(value: string) {
  return value
    .split(/[,，、\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function getLiteratureArchiveCode(book: Pick<LiteratureCatalogBook, 'id' | 'title'>, source?: BookSource) {
  if (source?.archiveCode?.trim()) return source.archiveCode.trim()
  const year = source?.updatedAt ? new Date(source.updatedAt).getFullYear() : 2024
  const safeYear = Number.isFinite(year) ? year : 2024
  const sequence = (Number.parseInt(stableHash(`${source?.id ?? book.id}-${source?.title ?? book.title}`), 36) % 10000)
    .toString()
    .padStart(4, '0')
  return `LIT-TKA-${safeYear}-${sequence}`
}

function LiteratureDarkSelect<Value extends string>({
  label,
  value,
  options,
  required,
  onChange,
}: {
  label: string
  value: Value
  options: Array<Value | { value: Value; label: string }>
  required?: boolean
  onChange: (value: Value) => void
}) {
  const [open, setOpen] = useState(false)
  const normalizedOptions = options.map((option) => (typeof option === 'string' ? { value: option as Value, label: option } : option))
  const activeOption = normalizedOptions.find((option) => option.value === value) ?? normalizedOptions[0]

  return (
    <label className="literature-custom-select-field">
      <span>{label} {required && <em>*</em>}</span>
      <button type="button" className={open ? 'literature-custom-select open' : 'literature-custom-select'} onClick={() => setOpen((current) => !current)}>
        {activeOption?.label ?? value}
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="literature-custom-select-menu" role="listbox">
          {normalizedOptions.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'selected' : ''}
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </label>
  )
}

export function LiteratureEditPage({
  book,
  source,
  pages,
  currentUserName,
  backToDetail,
  copyText,
  onArchiveBook,
  saveLiteratureBook,
}: {
  book: LiteratureCatalogBook
  source?: BookSource
  pages: BookPage[]
  currentUserName: string
  backToDetail: () => void
  copyText: (text: string) => Promise<boolean>
  onArchiveBook: () => void
  saveLiteratureBook: (source: BookSource, pages: BookPage[]) => void
}) {
  const defaultSource: BookSource = {
    id: book.id,
    title: book.title,
    subtitle: book.shortTitle,
    author: book.author,
    dynasty: book.dynasty,
    periodRange: source?.periodRange ?? (source?.publishYear ? String(source.publishYear) : ''),
    publisher: book.source,
    sourceType: getBookSourceTypeFromCategory(book.category),
    archiveCode: getLiteratureArchiveCode(book, source),
    format: book.format,
    pageCount: book.totalPages,
    volumeCount: book.volumes,
    note: book.summary,
    coverImagePath: book.coverImage,
    svnOriginalPath: book.svnPath,
    scanFolderPath: book.svnPath,
    syncStatus: book.svnPath ? '已记录路径' : '未记录路径',
    tags: [book.category, book.dynasty].filter(Boolean),
    relatedArchiveItemIds: book.archiveItemId ? [book.archiveItemId] : [],
  }
  const [activeTab, setActiveTab] = useState<LiteratureEditTab>('基础信息')
  const [sourceDraft, setSourceDraft] = useState<BookSource>(() => ({ ...defaultSource, ...source }))
  const [pageDrafts, setPageDrafts] = useState<BookPage[]>(() => pages.map((page) => ({ ...page })))
  const [selectedPageId, setSelectedPageId] = useState(pageDrafts[0]?.id ?? '')
  const [tagText, setTagText] = useState(() => (source?.tags?.length ? source.tags : defaultSource.tags ?? []).join('，'))
  const [tagInput, setTagInput] = useState('')
  const [relatedText, setRelatedText] = useState(() => (source?.relatedArchiveItemIds?.length ? source.relatedArchiveItemIds : defaultSource.relatedArchiveItemIds ?? []).join('，'))

  const selectedPage = pageDrafts.find((page) => page.id === selectedPageId) ?? pageDrafts[0]
  const archiveCode = getLiteratureArchiveCode(book, sourceDraft)
  const ocrReady = pageDrafts.some((page) => page.correctedText || page.ocrText)
  const svnReady = Boolean(sourceDraft.svnOriginalPath || sourceDraft.scanFolderPath || sourceDraft.pdfPath)
  const lastModifiedLabel = sourceDraft.updatedAt ? new Date(sourceDraft.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '本次保存后生成'
  const tagItems = splitLiteratureTokens(tagText)
  const copyArchiveCode = () => copyText(archiveCode)
  const confirmArchiveBook = () => {
    const confirmed = window.confirm('确认将该文献移出文献库？该操作不会删除 SVN 原始文件，也不会删除资料库原始条目。')
    if (confirmed) onArchiveBook()
  }
  const setLiteratureTags = (tags: string[]) => {
    setTagText(Array.from(new Set(tags.filter(Boolean))).join('，'))
  }
  const addLiteratureTag = (value: string) => {
    const nextTags = splitLiteratureTokens(value)
    if (!nextTags.length) return
    setLiteratureTags([...tagItems, ...nextTags])
    setTagInput('')
  }
  const removeLiteratureTag = (tag: string) => {
    setLiteratureTags(tagItems.filter((entry) => entry !== tag))
  }
  const handleTagKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== ',' && event.key !== '，') return
    event.preventDefault()
    addLiteratureTag(tagInput)
  }
  const updateSourceDraft = <Key extends keyof BookSource>(key: Key, value: BookSource[Key]) => {
    setSourceDraft((current) => ({ ...current, [key]: value }))
  }
  const updatePageDraft = (pageId: string, updates: Partial<BookPage>) => {
    setPageDrafts((current) => current.map((page) => (page.id === pageId ? { ...page, ...updates } : page)))
  }
  const addPageDraft = () => {
    const nextIndex = pageDrafts.length + 1
    const nextPage: BookPage = {
      id: `${sourceDraft.id}-page-${Date.now()}`,
      bookSourceId: sourceDraft.id,
      pageNumber: String(nextIndex).padStart(3, '0'),
      chapter: '',
      imagePath: '',
      ocrText: '',
      correctedText: '',
      keywords: [],
      linkedArchiveItemIds: [],
    }
    setPageDrafts((current) => [...current, nextPage])
    setSelectedPageId(nextPage.id)
  }
  const removeSelectedPage = () => {
    if (!selectedPage) return
    const nextPages = pageDrafts.filter((page) => page.id !== selectedPage.id)
    setPageDrafts(nextPages)
    setSelectedPageId(nextPages[0]?.id ?? '')
  }
  const saveDraft = () => {
    const normalizedSource: BookSource = {
      ...sourceDraft,
      title: sourceDraft.title.trim() || book.title,
      pageCount: Number.isFinite(Number(sourceDraft.pageCount)) ? Number(sourceDraft.pageCount) : pageDrafts.length,
      archiveCode,
      tags: splitLiteratureTokens(tagText),
      relatedArchiveItemIds: splitLiteratureTokens(relatedText),
      updatedBy: currentUserName,
      updatedAt: new Date().toISOString(),
    }
    saveLiteratureBook(normalizedSource, pageDrafts)
  }
  const syncLiteratureSvnStatus = () => {
    const nextSource: BookSource = {
      ...sourceDraft,
      title: sourceDraft.title.trim() || book.title,
      pageCount: Number.isFinite(Number(sourceDraft.pageCount)) ? Number(sourceDraft.pageCount) : pageDrafts.length,
      archiveCode,
      tags: splitLiteratureTokens(tagText),
      relatedArchiveItemIds: splitLiteratureTokens(relatedText),
      syncStatus: svnReady ? '已记录路径' : '未绑定路径',
      lastSyncedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      updatedBy: currentUserName,
      updatedAt: new Date().toISOString(),
    }
    setSourceDraft(nextSource)
    saveLiteratureBook(nextSource, pageDrafts)
  }
  const svnRows = [
    {
      label: 'SVN 根路径',
      value: sourceDraft.svnOriginalPath || sourceDraft.scanFolderPath || '未绑定',
      actionLabel: '复制路径',
      disabled: !sourceDraft.svnOriginalPath && !sourceDraft.scanFolderPath,
      onClick: () => copyText(sourceDraft.svnOriginalPath || sourceDraft.scanFolderPath || ''),
    },
    {
      label: 'PDF 文件路径',
      value: sourceDraft.pdfPath || '未绑定',
      actionLabel: '复制路径',
      disabled: !sourceDraft.pdfPath,
      onClick: () => copyText(sourceDraft.pdfPath || ''),
    },
    {
      label: '扫描文件夹路径',
      value: sourceDraft.scanFolderPath || '未绑定',
      actionLabel: '复制路径',
      disabled: !sourceDraft.scanFolderPath,
      onClick: () => copyText(sourceDraft.scanFolderPath || ''),
    },
    {
      label: 'OCR 文本路径',
      value: sourceDraft.ocrTextPath || '未绑定',
      actionLabel: '查看 OCR',
      disabled: false,
      onClick: () => setActiveTab('页面与 OCR'),
    },
    {
      label: '封面图路径',
      value: sourceDraft.coverImagePath || '未绑定',
      actionLabel: '复制路径',
      disabled: !sourceDraft.coverImagePath,
      onClick: () => copyText(sourceDraft.coverImagePath || ''),
    },
  ]

  return (
    <main className="literature-page literature-edit-page">
      <section className="literature-edit-shell">
        <header className="literature-edit-header">
          <button type="button" className="literature-back-link" onClick={backToDetail}><ChevronRight size={16} /> 返回详情</button>
          <div>
            <h1>编辑文献资料</h1>
            <span>最后修改：{sourceDraft.updatedBy || currentUserName} · {lastModifiedLabel} · 状态：草稿</span>
            <p>维护文献元数据、SVN 路径、页码 OCR、关联关系与引用备注。原始文件仍保存在 SVN。</p>
          </div>
          <div className="literature-edit-header-actions">
            <button type="button" className="secondary-control" onClick={backToDetail}>取消</button>
            <button type="button" className="secondary-control" onClick={backToDetail}><BookOpen size={16} /> 预览</button>
            <button type="button" className="secondary-control" onClick={saveDraft}>保存草稿</button>
            <button type="button" onClick={saveDraft}><Save size={16} /> 保存并更新</button>
          </div>
        </header>

        <div className="literature-edit-layout">
          <section className="literature-edit-main">
            <div className="literature-edit-tabs" role="tablist" aria-label="文献编辑分区">
              <strong className="literature-edit-tabs-title">文献编辑</strong>
              {literatureEditTabs.map((tab) => (
                <button type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? 'active' : ''} key={tab} onClick={() => setActiveTab(tab)}>
                  <span className="literature-edit-tab-icon" aria-hidden="true">{getLiteratureEditTabIcon(tab)}</span>
                  <span>{tab}</span>
                </button>
              ))}
              <button type="button" className="literature-edit-danger-action" onClick={confirmArchiveBook}>
                <X size={15} /> 归档 / 移出文献库
              </button>
            </div>

            {activeTab === '基础信息' && (
              <div className="literature-edit-panel literature-basic-edit-panel">
                <section className="literature-edit-form-group literature-basic-card wide">
                  <div className="literature-form-section-head">
                    <div>
                      <h2>基础信息</h2>
                      <p>资料的核心元数据，用于检索、展示与引用。</p>
                    </div>
                  </div>
                  <div className="literature-code-field">
                    <span>资料编号 <em>系统自动生成，可用于检索与引用</em></span>
                    <strong>{archiveCode}</strong>
                    <button type="button" className="secondary-control" onClick={copyArchiveCode}><Copy size={14} /> 复制</button>
                  </div>
                  <div className="literature-edit-subgroup">
                    <strong>文献身份</strong>
                    <div className="literature-edit-field-grid identity-grid">
                    <label>文献名称 <em>*</em><input value={sourceDraft.title} onChange={(event) => updateSourceDraft('title', event.target.value)} /></label>
                    <label>副标题 / 卷册名<input value={sourceDraft.subtitle ?? ''} maxLength={50} onChange={(event) => updateSourceDraft('subtitle', event.target.value)} placeholder="如：卷三十 · 舆服志" /></label>
                    <label>作者 / 编者 <em>*</em><input value={sourceDraft.author ?? ''} onChange={(event) => updateSourceDraft('author', event.target.value)} /></label>
                    <label>朝代 <em>*</em><input value={sourceDraft.dynasty ?? ''} onChange={(event) => updateSourceDraft('dynasty', event.target.value)} /></label>
                    <label>年代<input value={sourceDraft.periodRange ?? ''} onChange={(event) => updateSourceDraft('periodRange', event.target.value)} placeholder="280–290" /></label>
                    </div>
                  </div>
                  <div className="literature-edit-subgroup">
                    <strong>文献属性</strong>
                    <div className="literature-edit-field-grid attribute-grid">
                    <LiteratureDarkSelect label="文献类型" value={sourceDraft.sourceType} required options={literatureSourceTypeOptions} onChange={(value) => updateSourceDraft('sourceType', value)} />
                    <label>格式 <em>*</em><input value={sourceDraft.format ?? ''} onChange={(event) => updateSourceDraft('format', event.target.value)} /></label>
                    <LiteratureDarkSelect label="语言" value={sourceDraft.language ?? '中文'} options={literatureLanguageOptions} onChange={(value) => updateSourceDraft('language', value)} />
                    <label>页数 / 卷数 <em>*</em><input type="number" min="0" value={sourceDraft.pageCount ?? 0} onChange={(event) => updateSourceDraft('pageCount', Number(event.target.value))} /></label>
                    <label>卷数<input type="number" min="0" inputMode="numeric" value={sourceDraft.volumeCount ?? ''} onChange={(event) => updateSourceDraft('volumeCount', event.target.value.replace(/\D/g, ''))} /></label>
                    </div>
                  </div>
                  <div className="literature-edit-subgroup">
                    <strong>版本与来源</strong>
                    <div className="literature-edit-field-grid literature-source-grid">
                    <label>版本 / 刊本<input value={sourceDraft.edition ?? ''} onChange={(event) => updateSourceDraft('edition', event.target.value)} placeholder="四部丛刊影印本" /></label>
                    <label>来源说明 <em>*</em><input value={sourceDraft.publisher ?? ''} maxLength={100} onChange={(event) => updateSourceDraft('publisher', event.target.value)} /></label>
                    <label className="wide">一句简介<textarea maxLength={200} value={sourceDraft.note ?? ''} onChange={(event) => updateSourceDraft('note', event.target.value)} /></label>
                    </div>
                  </div>
                  <div className="literature-edit-subgroup">
                    <strong>标签</strong>
                    <label className="literature-tags-field">
                      <div className="literature-tag-editor">
                        {tagItems.map((tag) => (
                          <button
                            type="button"
                            key={tag}
                            onClick={() => removeLiteratureTag(tag)}
                            title="点击移除标签"
                          >
                            {tag}<X size={12} />
                          </button>
                        ))}
                        <input
                          value={tagInput}
                          onChange={(event) => setTagInput(event.target.value)}
                          onKeyDown={handleTagKeyDown}
                          onBlur={() => addLiteratureTag(tagInput)}
                          placeholder="输入标签，回车添加"
                        />
                      </div>
                    </label>
                  </div>
                  <div className="literature-cover-resource">
                    <LiteratureBookCover book={{ ...book, coverImage: sourceDraft.coverImagePath || book.coverImage }} />
                    <div>
                      <span>封面图</span>
                      <strong>{sourceDraft.coverImagePath?.split('/').pop() || '未绑定封面'}</strong>
                      <small>{sourceDraft.coverImagePath || '请选择封面图路径'}</small>
                    </div>
                    <div className="literature-cover-actions">
                      <button type="button" className="secondary-control" onClick={() => copyText(sourceDraft.coverImagePath || '')}><Copy size={14} /> 复制路径</button>
                    </div>
                  </div>
                </section>
                <section className="literature-edit-form-group literature-svn-summary-card wide">
                  <div className="literature-card-head">
                    <h2>文件与 SVN</h2>
                    <button type="button" className="secondary-control" onClick={syncLiteratureSvnStatus}><RefreshCw size={14} /> 同步 SVN 状态</button>
                  </div>
                  <div className="literature-svn-table">
                    {svnRows.map((row) => (
                      <div className="literature-svn-row" key={row.label}>
                        <span>{row.label}</span>
                        <strong>{row.value}</strong>
                        <em>{sourceDraft.syncStatus || '已同步'}</em>
                        <button type="button" className="secondary-control" onClick={row.onClick} disabled={row.disabled}>{row.actionLabel}</button>
                      </div>
                    ))}
                  </div>
                  <footer>
                    <span>最后同步时间：{sourceDraft.lastSyncedAt || lastModifiedLabel}</span>
                    <span>文件状态：{sourceDraft.syncStatus || '已同步'}</span>
                  </footer>
                </section>
              </div>
            )}

            {activeTab === '文件与 SVN' && (
              <div className="literature-edit-panel">
                <label className="wide">SVN 原始文件路径<input value={sourceDraft.svnOriginalPath ?? ''} onChange={(event) => updateSourceDraft('svnOriginalPath', event.target.value)} /></label>
                <label className="wide">PDF 路径<input value={sourceDraft.pdfPath ?? ''} onChange={(event) => updateSourceDraft('pdfPath', event.target.value)} /></label>
                <label className="wide">扫描图片文件夹路径<input value={sourceDraft.scanFolderPath ?? ''} onChange={(event) => updateSourceDraft('scanFolderPath', event.target.value)} /></label>
                <label className="wide">缩略图路径<input value={sourceDraft.thumbnailPath ?? ''} onChange={(event) => updateSourceDraft('thumbnailPath', event.target.value)} /></label>
                <label className="wide">OCR 文本路径<input value={sourceDraft.ocrTextPath ?? ''} onChange={(event) => updateSourceDraft('ocrTextPath', event.target.value)} /></label>
                <label>文件同步状态<input value={sourceDraft.syncStatus ?? ''} onChange={(event) => updateSourceDraft('syncStatus', event.target.value)} /></label>
                <label>最后同步时间<input value={sourceDraft.lastSyncedAt ?? ''} onChange={(event) => updateSourceDraft('lastSyncedAt', event.target.value)} /></label>
                <div className="literature-edit-real-actions">
                  <button type="button" className="secondary-control" onClick={() => copyText(sourceDraft.svnOriginalPath || sourceDraft.scanFolderPath || '')}>
                    <Copy size={15} /> 复制 SVN 路径
                  </button>
                </div>
              </div>
            )}

            {activeTab === '页面与 OCR' && (
              <div className="literature-ocr-editor">
                <aside>
                  <div>
                    <strong>页码</strong>
                    <button type="button" onClick={addPageDraft}><Plus size={14} /> 新增页</button>
                  </div>
                  {pageDrafts.map((page) => (
                    <button type="button" className={selectedPage?.id === page.id ? 'active' : ''} key={page.id} onClick={() => setSelectedPageId(page.id)}>
                      第 {page.pageNumber} 页 <small>{page.chapter || '未分卷'}</small>
                    </button>
                  ))}
                </aside>
                <section>
                  {selectedPage ? (
                    <>
                      <div className="literature-edit-panel single">
                        <label>页码<input value={selectedPage.pageNumber} onChange={(event) => updatePageDraft(selectedPage.id, { pageNumber: event.target.value })} /></label>
                        <label>卷册 / 章节<input value={selectedPage.chapter ?? ''} onChange={(event) => updatePageDraft(selectedPage.id, { chapter: event.target.value })} /></label>
                        <label className="wide">扫描图路径<input value={selectedPage.imagePath} onChange={(event) => updatePageDraft(selectedPage.id, { imagePath: event.target.value })} /></label>
                        <label className="wide">关键词<input value={selectedPage.keywords.join('，')} onChange={(event) => updatePageDraft(selectedPage.id, { keywords: splitLiteratureTokens(event.target.value) })} /></label>
                        <label className="wide">关联资料条目 ID<input value={selectedPage.linkedArchiveItemIds.join('，')} onChange={(event) => updatePageDraft(selectedPage.id, { linkedArchiveItemIds: splitLiteratureTokens(event.target.value) })} /></label>
                        <label className="wide">OCR 原文<textarea value={selectedPage.ocrText ?? ''} onChange={(event) => updatePageDraft(selectedPage.id, { ocrText: event.target.value })} /></label>
                        <label className="wide">人工校正文<textarea value={selectedPage.correctedText ?? ''} onChange={(event) => updatePageDraft(selectedPage.id, { correctedText: event.target.value })} /></label>
                      </div>
                      <button type="button" className="secondary-control literature-remove-page" onClick={removeSelectedPage}>移除当前页</button>
                    </>
                  ) : (
                    <div className="literature-edit-empty">当前文献还没有页码记录，请先新增页。</div>
                  )}
                </section>
              </div>
            )}

            {activeTab === '关联资料' && (
              <div className="literature-edit-panel">
                <label className="wide">关联资料条目 ID<textarea value={relatedText} onChange={(event) => setRelatedText(event.target.value)} /></label>
                <label className="wide">关联图片 / 时代 / 身份 / 分类备注<textarea value={sourceDraft.maintainerNote ?? ''} onChange={(event) => updateSourceDraft('maintainerNote', event.target.value)} /></label>
              </div>
            )}

            {activeTab === '引用与备注' && (
              <div className="literature-edit-panel">
                <label className="wide">推荐引用方式<input value={sourceDraft.citationFormat ?? ''} onChange={(event) => updateSourceDraft('citationFormat', event.target.value)} /></label>
                <label className="wide">重要页码<input value={sourceDraft.importantPages ?? ''} onChange={(event) => updateSourceDraft('importantPages', event.target.value)} /></label>
                <label className="wide">摘录内容<textarea value={sourceDraft.excerpt ?? ''} onChange={(event) => updateSourceDraft('excerpt', event.target.value)} /></label>
                <label className="wide">考据备注<textarea value={sourceDraft.researchNote ?? ''} onChange={(event) => updateSourceDraft('researchNote', event.target.value)} /></label>
                <label className="wide">使用限制 / 版权说明<textarea value={sourceDraft.usageRestriction ?? ''} onChange={(event) => updateSourceDraft('usageRestriction', event.target.value)} /></label>
              </div>
            )}

            {activeTab === '修改记录' && (
              <div className="literature-edit-log">
                <div><span>最近修改人</span><strong>{sourceDraft.updatedBy || currentUserName}</strong></div>
                <div><span>最近修改时间</span><strong>{sourceDraft.updatedAt ? new Date(sourceDraft.updatedAt).toLocaleString('zh-CN') : '本次保存后生成'}</strong></div>
                <div><span>存储策略</span><strong>前端维护索引、OCR 与关联；原始 PDF / 扫描图仍保存在 SVN。</strong></div>
              </div>
            )}
          </section>

          <aside className="literature-edit-side">
            <section className="literature-edit-side-card">
              <span>文献预览</span>
              <LiteratureBookCover book={{ ...book, coverImage: sourceDraft.coverImagePath || book.coverImage, title: sourceDraft.title || book.title, shortTitle: sourceDraft.subtitle || book.shortTitle }} size="large" />
              <h2>{sourceDraft.title || book.title}</h2>
              <p>{sourceDraft.author || book.author}</p>
              <div className="literature-edit-badges">
                <em>{book.category}</em>
                <em>{sourceDraft.format || book.format}</em>
                <em>{ocrReady ? 'OCR 已完成' : '待 OCR'}</em>
              </div>
              <button type="button" className="literature-side-code" onClick={copyArchiveCode}>
                <span>资料编号</span>
                <strong>{archiveCode}</strong>
                <Copy size={13} />
              </button>
            </section>
            <section className="literature-edit-side-card">
              <span>文献状态</span>
              <dl>
                <div><dt>编辑状态</dt><dd>草稿中</dd></div>
                <div><dt>OCR 状态</dt><dd>{ocrReady ? '已完成' : '未识别'}</dd></div>
                <div><dt>SVN 状态</dt><dd>{sourceDraft.syncStatus || (svnReady ? '已记录路径' : '未绑定')}</dd></div>
                <div><dt>页码记录</dt><dd>{pageDrafts.length} 页</dd></div>
                <div><dt>维护人</dt><dd>{sourceDraft.updatedBy || currentUserName}</dd></div>
                <div><dt>最近修改</dt><dd>{lastModifiedLabel}</dd></div>
              </dl>
            </section>
            <section className="literature-edit-side-card">
              <span>快捷操作</span>
              <button type="button" className="secondary-control" onClick={backToDetail}><BookOpen size={15} /> 打开阅读</button>
              <button type="button" className="secondary-control" onClick={() => copyText(sourceDraft.svnOriginalPath || sourceDraft.scanFolderPath || '')} disabled={!svnReady}><Copy size={15} /> 复制 SVN 路径</button>
              <button type="button" className="secondary-control" onClick={copyArchiveCode}><Copy size={15} /> 复制资料编号</button>
            </section>
          </aside>
        </div>
      </section>
    </main>
  )
}

void LiteratureEditPage

function LiteratureReaderPage({
  book,
  backToDetail,
  copyCitation,
}: {
  book: LiteratureCatalogBook
  backToDetail: () => void
  copyCitation: () => void
}) {
  const [ocrOpen, setOcrOpen] = useState(true)
  const [pageNumber, setPageNumber] = useState(128)
  const chapterGroups = [
    { title: '三国志卷一　魏书一', chapters: ['武帝纪第一', '文帝纪第二', '明帝纪第三', '齐王芳传第四', '高贵乡公髦传第五'] },
    { title: '三国志卷二　魏书二', chapters: [] },
    { title: '三国志卷三　魏书三', chapters: [] },
    { title: '三国志卷四　魏书四', chapters: [] },
    { title: '三国志卷五　吴书一', chapters: [] },
    { title: '三国志卷七　吴书三', chapters: [] },
    { title: '三国志卷十　蜀书一', chapters: [] },
  ]
  const previewPages = [126, 127, 128, 129, 130, 131, 132, 133]
  return (
    <main className="literature-page literature-reader-page">
      <aside className="literature-reader-sidebar">
        <button type="button" className="literature-back-link" onClick={backToDetail}><ChevronRight size={16} /> 返回文献库</button>
        <h1>{formatBookTitle(book.title)}</h1>
        <small>{book.author} · {book.category} · 共 {book.totalPages} 页</small>
        <div className="literature-reader-tabs" role="tablist" aria-label="阅读器侧栏">
          <button type="button" className="active">目录</button>
          <button type="button" disabled>书签</button>
          <button type="button" disabled>笔记</button>
        </div>
        <label className="literature-reader-search">
          <Search size={16} />
          <input aria-label="搜索章节" placeholder="搜索章节" disabled />
        </label>
        <div className="literature-reader-tree" aria-label="文献目录">
          {chapterGroups.map((group, groupIndex) => (
            <section key={group.title}>
              <button type="button" className={groupIndex === 0 ? 'open' : ''} disabled>
                <ChevronRight size={14} />
                {group.title}
              </button>
              {group.chapters.map((chapter, chapterIndex) => (
                <button
                  type="button"
                  className={chapterIndex === 0 ? 'active child' : 'child'}
                  key={chapter}
                  disabled={chapterIndex !== 0}
                >
                  {chapter}
                </button>
              ))}
            </section>
          ))}
        </div>
        <div className="literature-reading-progress">
          <span>阅读进度 12%</span>
          <i />
        </div>
      </aside>
      <section className="literature-reader-main">
        <div className="literature-reader-toolbar">
          <button type="button" className="icon-tool active" disabled><Grab size={17} /></button>
          <div className="literature-reader-zoom">
            <button type="button" disabled aria-label="缩小"><ZoomOut size={16} /></button>
            <Minus size={14} />
            <button type="button" disabled aria-label="放大"><ZoomIn size={16} /></button>
          </div>
          <button type="button" className="value-tool" disabled>56% <ChevronDown size={13} /></button>
          <label>页码 <input value={pageNumber} onChange={(event) => setPageNumber(Number(event.target.value) || 1)} /> / {book.totalPages}</label>
          <button type="button" disabled>跳转</button>
          <button type="button" className={ocrOpen ? 'active' : ''} onClick={() => setOcrOpen((open) => !open)}>OCR</button>
          <button type="button" disabled><BookOpen size={15} /> 对阅读</button>
          <span className="toolbar-spacer" />
          <button type="button" disabled><Download size={16} /> 下载 PDF</button>
          <button type="button" onClick={copyCitation}><Copy size={16} /> 复制引用</button>
          <button type="button" disabled><Maximize2 size={16} /> 全屏</button>
        </div>
        <div className="literature-reader-content">
          <div className="literature-page-spread">
            <img src={appPath('/assets/literature-reader-page.png')} alt={`${formatBookTitle(book.shortTitle)} 第 ${pageNumber} 页扫描图`} />
          </div>
          {ocrOpen && (
            <aside className="literature-ocr-panel">
              <div className="literature-ocr-tabs" role="tablist" aria-label="OCR 面板">
                <button type="button" className="active">OCR 文本</button>
                <button type="button" disabled>笔记与批注</button>
              </div>
              <button type="button" disabled><Copy size={15} /><Download size={15} /> 导出文本</button>
              <h2>武帝纪第一</h2>
              <p>武帝沛国谯人也。姓曹氏，讳操，字孟德。</p>
              <p>太祖少机警，有权谋，而任侠放荡，不治行业。</p>
              <p>年二十，举孝廉为郎，除洛阳北部尉。迁顿丘令。</p>
              <p>时黄巾贼起，众数十万，所在攻城略地，官军皆望风而降，操独身率骑，收合散卒，得数千人，与贼战，斩首数百，贼乃引去。</p>
              <footer><span>OCR 准确率：{book.ocrRate || 98}%</span><span>来源：{book.source}</span></footer>
            </aside>
          )}
        </div>
        <div className="literature-reader-thumbs" aria-label="页面缩略图">
          <button type="button" className="literature-rail-arrow" aria-label="上一组页面" disabled><ChevronRight size={18} /></button>
          {previewPages.map((page) => (
            <button
              type="button"
              className={page === pageNumber ? 'active' : ''}
              key={page}
              onClick={() => setPageNumber(page)}
            >
              <span><img src={appPath('/assets/literature-reader-thumb.png')} alt="" /></span>
              <small>{page}</small>
            </button>
          ))}
          <button type="button" className="literature-rail-arrow next" aria-label="下一组页面" disabled><ChevronRight size={18} /></button>
        </div>
      </section>
    </main>
  )
}

function LiteratureBookCover({ book, size = 'normal' }: { book: LiteratureCatalogBook; size?: 'normal' | 'large' | 'floating' }) {
  const coverImage = book.coverImage || getLiteratureCoverImage(book)
  if (coverImage) {
    return (
      <span className={`literature-book-cover image-cover ${size}`} aria-hidden="true">
        <img src={coverImage} alt="" draggable={false} />
      </span>
    )
  }

  return (
    <span className={`literature-book-cover ${size}`} style={{ '--book-color': book.palette, '--book-accent': book.accent } as Record<string, string>} aria-hidden="true">
      <i />
      <em>{formatBookTitle(book.shortTitle)}</em>
      <small />
    </span>
  )
}

function FloatingLiteratureBook({ book, phase }: { book: LiteratureCatalogBook; phase: LiteratureFloatingPhase }) {
  return <div className={`literature-floating-book ${phase}`} aria-hidden="true"><LiteratureBookCover book={book} size="floating" /></div>
}

type QuickLink = { label: string; iconKind: HanCategoryIconKind; action: 'search' | 'images' }

function Home({
  setView,
  setQuery,
  openDetail,
  featuredCards,
  homeHeroDetailId,
  homeHeroItems,
  items,
  literatureStats,
}: {
  setView: (view: View) => void
  setQuery: (query: string) => void
  openDetail: (id: string) => void
  featuredCards: HomeFeaturedCard[]
  homeHeroDetailId?: string
  homeHeroItems?: HomeHeroExhibitConfig[]
  items: CollectionItem[]
  literatureStats: LiteratureSummaryStat[]
}) {
  const literatureSummaryTotal = getLiteratureSummaryTotal(literatureStats)
  const quickLinks: QuickLink[] = [
    { label: '服饰', iconKind: 'costume', action: 'search' },
    { label: '甲胄', iconKind: 'armor', action: 'search' },
    { label: '冠帽', iconKind: 'headwear', action: 'search' },
    { label: '器物', iconKind: 'vessel', action: 'search' },
    { label: '图像', iconKind: 'mural', action: 'images' },
    { label: '建筑', iconKind: 'architecture', action: 'search' },
    { label: '纹样', iconKind: 'pattern', action: 'search' },
  ]
  const timelinePreview = [
    {
      label: '\u4e1c\u6c49\u672b\u5e74',
      years: '184 - 220',
      title: '\u4e1c\u6c49\u672b\u5e74',
      summary: '\u9ec4\u5dfe\u8d77\u4e49\u540e\uff0c\u7fa4\u96c4\u5e76\u8d77\uff0c\u5929\u4e0b\u5927\u4e71\uff0c\u4e3a\u4e09\u56fd\u9f0e\u7acb\u7684\u5f62\u6210\u5960\u5b9a\u57fa\u7840\u3002',
      asset: assets.find((asset) => asset.id === 'img-brick-01') ?? assets[0],
    },
    {
      label: '\u9b4f',
      years: '220 - 265',
      title: '\u9b4f',
      asset: assets.find((asset) => asset.id === 'img-cap-01') ?? assets[0],
    },
    {
      label: '\u8700\u6c49',
      years: '221 - 263',
      title: '\u8700\u6c49',
      asset: assets.find((asset) => asset.id === 'img-figurine-01') ?? assets[0],
    },
    {
      label: '\u5434',
      years: '222 - 280',
      title: '\u5434',
      asset: assets.find((asset) => asset.id === 'img-pattern-01') ?? assets[0],
      active: true,
    },
  ]
  const heroItemIds = (homeHeroItems?.length
    ? homeHeroItems
    : [{ id: 'hero-legacy', itemId: homeHeroDetailId ?? defaultHomeHeroItems[0].itemId }, ...defaultHomeHeroItems.slice(1)]
  )
    .map((entry) => entry.itemId)
    .filter((itemId, index, itemIds) => itemId && itemIds.indexOf(itemId) === index)
  const heroItems = (heroItemIds.length ? heroItemIds : defaultHomeHeroItems.map((entry) => entry.itemId))
    .map((itemId) => items.find((item) => item.id === itemId) ?? collectionItems.find((item) => item.id === itemId))
    .filter((item): item is CollectionItem => Boolean(item))
  const resolvedHeroItems = heroItems.length ? heroItems : defaultHomeHeroItems
    .map((entry) => collectionItems.find((item) => item.id === entry.itemId))
    .filter((item): item is CollectionItem => Boolean(item))
  const heroBackgrounds = [
    appPath('/assets/home-hero-bg.png'),
    appPath('/assets/home-hero-bg-2.png'),
    appPath('/assets/home-hero-bg-3.png'),
    appPath('/assets/home-hero-bg-4.png'),
  ]
  const [heroIndex, setHeroIndex] = useState(0)
  useEffect(() => {
    setHeroIndex((current) => Math.min(current, Math.max(0, resolvedHeroItems.length - 1)))
  }, [resolvedHeroItems.length])
  const activeHeroItem = resolvedHeroItems[heroIndex] ?? resolvedHeroItems[0]
  const configuredHeroDetailItem = activeHeroItem
  const defaultHeroFeature = {
    detailId: activeHeroItem.id,
    title: activeHeroItem.title,
    meta: `${activeHeroItem.period} · ${activeHeroItem.sourceTypes[0] ?? '资料'}`,
    summary: activeHeroItem.summary,
    tags: [...activeHeroItem.costumeCategories, ...activeHeroItem.identityTypes, ...activeHeroItem.referencePurposes].slice(0, 4),
  }
  const activeHeroFeature =
    heroIndex === 0
      ? {
          detailId: configuredHeroDetailItem?.id ?? 'han-cap-system',
          title: configuredHeroDetailItem?.title ?? '赤幞',
          meta: configuredHeroDetailItem ? `${configuredHeroDetailItem.period} · ${configuredHeroDetailItem.sourceTypes[0] ?? '资料'}` : '东汉 · 冠帽',
          summary:
            configuredHeroDetailItem?.summary ??
            '赤幞，形制为东汉平上帻，因颜色多为赤色，故又称为“赤帻”，只有水军服“黄帻”。帻是东汉士人、武人较为普遍的首服，起初为身份低下的仆从所戴，随着时间发展，地位逐渐提高。这种帻的顶部到了东汉中期已演变为硬壳，东汉晚期，平上帻后部逐渐增高，为常见首服。',
          tags: configuredHeroDetailItem
            ? [...configuredHeroDetailItem.costumeCategories, ...configuredHeroDetailItem.identityTypes, ...configuredHeroDetailItem.referencePurposes].slice(0, 4)
            : ['赤幞', '平上帻', '东汉', '冠帽'],
        }
      : defaultHeroFeature
  const heroAsset = getItemAssets(activeHeroItem)[0] ?? assets[0]
  const heroBackgroundStyle = {
    '--home-hero-bg': `url('${heroBackgrounds[heroIndex % heroBackgrounds.length]}')`,
  } as CSSProperties
  const moveHero = (direction: -1 | 1) => {
    setHeroIndex((current) => (current + direction + resolvedHeroItems.length) % resolvedHeroItems.length)
  }

  return (
    <main className="home-page">
      <section className="home-hero" style={heroBackgroundStyle}>
        <div className="home-hero-inner">
          <div className="home-hero-copy">
            <h1>三国美术资料库</h1>
            <p className="home-hero-en">THREE KINGDOMS ART ARCHIVE</p>
            <p className="home-hero-subtitle">
              收录东汉末年至三国时期的服饰、甲胄、器物、壁画、建筑、纹样与场景等美术资料，为研究与创作提供高质量的视觉参考。
            </p>
            <button
              type="button"
              className="home-hero-primary"
              onClick={() => {
                setQuery('')
                setView('library')
              }}
            >
              进入资料库
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="home-hero-figure">
            <ArmorShowcaseScene />
          </div>
          <aside className="home-hero-feature">
            <small className="home-feature-kicker">当前展品</small>
            <h2>{activeHeroFeature.title}</h2>
            <span>{activeHeroFeature.meta}</span>
            <p>{activeHeroFeature.summary}</p>
            <TagRow tags={activeHeroFeature.tags} />
            <button type="button" onClick={() => openDetail(activeHeroFeature.detailId)}>
              查看资料
              <ChevronRight size={18} />
            </button>
          </aside>
          <div className="home-hero-controls" aria-label="首页主视觉切换">
            <button type="button" aria-label="上一" onClick={() => moveHero(-1)}>
              <ChevronRight size={18} />
            </button>
            {resolvedHeroItems.map((item, index) => (
              <button
                type="button"
                className={index === heroIndex ? 'active' : ''}
                key={item.id}
                aria-label={`切换到${item.title}`}
                onClick={() => setHeroIndex(index)}
              />
            ))}
            <button type="button" aria-label="下一" onClick={() => moveHero(1)}>
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </section>

      <section className="home-section home-category-section">
        <div className="home-section-head">
          <h2>资料分类</h2>
        </div>
        <div className="home-quick-entry" aria-label="资料分类入口">
          {quickLinks.map((link) => (
            <button
              type="button"
              key={link.label}
              onClick={() => {
                setQuery(link.label)
                setView(link.action === 'images' ? 'images' : 'library')
              }}
            >
              <HanCategoryIcon kind={link.iconKind} />
              <span>{link.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-section home-featured-section">
        <div className="home-section-head">
          <h2>精选资料</h2>
          <button type="button" className="home-text-link" onClick={() => setView('library')}>
            查看全部
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="home-featured-grid">
          {featuredCards.map((category) => (
            <button
              type="button"
              className="home-feature-card"
              key={category.config.id}
              onClick={() => {
                setQuery(category.query)
                setView('library')
              }}
            >
              <AssetThumb asset={category.asset} />
              <span>
                <strong>{category.title}</strong>
                <small>{category.description}</small>
                <em>{category.countLabel}</em>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-section home-timeline-preview">
        <div className="home-section-head">
          <span>
            <h2>物象纪年</h2>
            <small>循时代脉络，观东汉末至三国间服饰、甲胄、器物、图像与建筑之形制流变。</small>
          </span>
          <button type="button" className="home-text-link" onClick={() => setView('timeline')}>
            查看完整时间线
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="home-timeline-line">
          {timelinePreview.map((item) => (
            <div className={item.active ? 'active' : ''} key={item.label}>
              <span>{item.label}</span>
              <small>{item.years}</small>
              <i />
            </div>
          ))}
        </div>
        <div className="home-timeline-cards">
          <article className="home-timeline-main-card">
            <AssetThumb asset={heroAsset} />
            <span>
              <strong>{timelinePreview[0].title}</strong>
              <small>{timelinePreview[0].years}</small>
              <p>{timelinePreview[0].summary}</p>
              <button type="button" className="secondary-control" onClick={() => setView('timeline')}>
                浏览该时期资料
                <ChevronRight size={15} />
              </button>
            </span>
          </article>
          {timelinePreview.slice(1, 4).map((item) => (
            <button type="button" className="home-timeline-card" key={item.title} onClick={() => setView('timeline')}>
              <AssetThumb asset={item.asset} />
              <span>
                <strong>{item.title}</strong>
                <small>{item.years}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-stats-band" aria-label="资料库数据概览">
        <div className="home-section-head">
          <h2>资料总览</h2>
          <p>{`三国历史资料库当前收录 ${formatSummaryCount(literatureSummaryTotal)} 条资料，覆盖古籍、史书、考古、图录与论文研究。`}</p>
        </div>
        <div className="home-stat-grid">
          {literatureStats.map(({ label, value, unit, description, Icon }) => (
            <article className="home-stat-card" key={label as string}>
              <span className="home-stat-card-head">
                <Icon size={20} />
                <em>{label}</em>
              </span>
              <strong>
                {formatSummaryCount(value)}
                <small>{unit}</small>
              </strong>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}

function Library({
  query,
  setQuery,
  results,
  scanPageResults,
  filters,
  toggleFilter,
  removeFilter,
  clearFilters,
  sortMode,
  setSortMode,
  openDetail,
  openEditor,
  copyText,
  isAdmin,
  onHideItem,
  onDeleteItem,
  startNewItem,
  openWebClip,
}: {
  query: string
  setQuery: (query: string) => void
  results: CollectionItem[]
  scanPageResults: Array<{ page: BookPage; source: BookSource }>
  filters: FilterState
  toggleFilter: (key: FilterKey, value: string) => void
  removeFilter: (key: FilterKey, value: string) => void
  clearFilters: () => void
  sortMode: LibrarySortMode
  setSortMode: (mode: LibrarySortMode) => void
  openDetail: (id: string) => void
  openEditor: (item: CollectionItem) => void
  copyText: (text: string) => void
  isAdmin: boolean
  onHideItem: (item: CollectionItem) => void
  onDeleteItem: (item: CollectionItem) => void
  startNewItem: () => void
  openWebClip: () => void
}) {
  const [expandedSections, setExpandedSections] = useState<Partial<Record<FilterKey, boolean>>>(
    () => readBooleanMapState(libraryFilterSectionsStateKey) as Partial<Record<FilterKey, boolean>>,
  )
  const [currentPage, setCurrentPage] = useState(1)
  const [perPage, setPerPage] = useState(40)
  const [openResultMenuId, setOpenResultMenuId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<LibraryViewMode>('visual')
  const activeFilters = (Object.keys(filters) as FilterKey[]).flatMap((key) =>
    filters[key].map((value) => ({ key, value })),
  )
  const activeFilterKey = activeFilters.map((filter) => `${filter.key}:${filter.value}`).sort().join('|')
  const trimmedQuery = query.trim()
  const hasActiveCriteria = Boolean(trimmedQuery || activeFilters.length)
  const displayResults = results
  const libraryResults = displayResults
  const totalResults = libraryResults.length
  const totalPages = Math.max(1, Math.ceil(totalResults / perPage))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const paginationPages = getPaginationPages(safeCurrentPage, totalPages)
  const visualResults = libraryResults.slice((safeCurrentPage - 1) * perPage, safeCurrentPage * perPage)
  const isEmptySearch = hasActiveCriteria && displayResults.length === 0
  useEffect(() => {
    setCurrentPage(1)
    setOpenResultMenuId(null)
  }, [activeFilterKey, perPage, query, sortMode])

  useEffect(() => {
    if (currentPage !== safeCurrentPage) {
      setCurrentPage(safeCurrentPage)
    }
  }, [currentPage, safeCurrentPage])

  useEffect(() => {
    setOpenResultMenuId(null)
  }, [safeCurrentPage])

  const toggleLibraryFilterSection = (sectionKey: FilterKey) => {
    setExpandedSections((current) => {
      const next = { ...current, [sectionKey]: !current[sectionKey] }
      writeBooleanMapState(libraryFilterSectionsStateKey, next)
      return next
    })
  }

  return (
    <main className="library-page">
      <aside className="library-filters">
        <div className="filter-head">
          <h2>
            <Funnel size={22} />
            筛选条件
          </h2>
          <button type="button" className="filter-clear" onClick={clearFilters} disabled={!hasActiveCriteria}>
            清空
          </button>
        </div>
        {facetSections.map((section) => (
          <FilterSection
            key={section.key}
            section={section}
            filters={filters}
            expanded={Boolean(expandedSections[section.key])}
            toggleFilter={toggleFilter}
            toggleExpanded={() => toggleLibraryFilterSection(section.key)}
          />
        ))}
      </aside>
      <section className="library-results-pane">
        <div className="library-page-head">
          <div className="library-title-block">
            <p className="eyebrow">Archive Index</p>
            <h1>资料库</h1>
            <p>浏览、筛选并管理研究资料条目</p>
          </div>
          <div className="library-head-actions">
            <button type="button" className="secondary-control web-clip-entry" onClick={openWebClip}>
              <Globe2 size={17} />
              从网页采集
            </button>
            <button type="button" className="new-item-button" onClick={startNewItem}>
              <Plus size={17} />
              新建资料
            </button>
          </div>
        </div>
        <SearchRow query={query} setQuery={setQuery} placeholder="搜索时代、类别、关键词..." />
        {hasActiveCriteria && (
          <div className="active-filter-row" aria-label="筛选快捷项">
            {trimmedQuery && (
              <button type="button" className="filter-chip active" onClick={() => setQuery('')} aria-label={`移除搜索 ${trimmedQuery}`}>
                搜索：{trimmedQuery}
                <X size={13} />
              </button>
            )}
            {activeFilters.map((pill) => (
              <button
                type="button"
                className="filter-chip active"
                key={`${pill.key}-${pill.value}`}
                onClick={() => removeFilter(pill.key, pill.value)}
                aria-label={`移除筛选 ${pill.value}`}
              >
                {pill.value}
                <X size={13} />
              </button>
            ))}
            <button type="button" className="filter-clear-inline" onClick={clearFilters}>
              清空全部
            </button>
          </div>
        )}
        <div className="library-toolbar">
          <span>共 {totalResults} 条结果</span>
          <div className="toolbar-actions">
            <div className="library-view-tabs" role="tablist" aria-label="列表显示模式">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'visual'}
                className={viewMode === 'visual' ? 'library-view-tab active' : 'library-view-tab'}
                onClick={() => setViewMode('visual')}
              >
                <ImageIcon size={15} />
                图文视图
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'reader'}
                className={viewMode === 'reader' ? 'library-view-tab active' : 'library-view-tab'}
                onClick={() => {
                  setOpenResultMenuId(null)
                  setViewMode('reader')
                }}
              >
                <Menu size={15} />
                简洁列表
              </button>
            </div>
            <label>
              排序
              <FancySelect
                ariaLabel="资料排序"
                value={sortMode}
                onChange={(value) => setSortMode(value as LibrarySortMode)}
                options={[
                  { value: 'relevance', label: '相关度' },
                  { value: 'updated', label: '最近更新' },
                  { value: 'period', label: '年代' },
                ]}
              />
            </label>
          </div>
        </div>
        {scanPageResults.length > 0 && (
          <section className="scan-page-results">
            <div className="scan-page-results-head">
              <div>
                <p className="eyebrow">Book Scan Pages</p>
                <h2>扫描页结果</h2>
              </div>
              <span>{scanPageResults.length} 页</span>
            </div>
            <div className="scan-page-result-list">
              {scanPageResults.slice(0, 12).map(({ page, source }) => (
                <article key={page.id}>
                  <img src={page.imagePath} alt={`${formatBookTitle(source.title)} P${page.pageNumber}`} />
                  <div>
                    <strong>{formatBookTitle(source.title)} P{page.pageNumber}</strong>
                    <span>{[source.author, source.publisher, page.chapter].filter(Boolean).join(' / ')}</span>
                    <p>{(page.correctedText || page.ocrText || '').slice(0, 160) || '暂无 OCR 文本'}</p>
                    <TagRow tags={page.keywords.slice(0, 6)} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
        {isEmptySearch ? (
          <EmptyLibraryResults startNewItem={startNewItem} clearFilters={clearFilters} openWebClip={openWebClip} />
        ) : (
          <>
            <div className={viewMode === 'reader' ? 'result-list reader-result-list' : 'result-list'}>
              {visualResults.map((item, index) => {
                const itemMenuId = `${safeCurrentPage}-${index}-${item.id}`
                return (
                  viewMode === 'reader' ? (
                    <ReaderResultItem
                      key={`${item.id}-${index}`}
                      item={item}
                      query={query}
                      openDetail={openDetail}
                      index={index}
                    />
                  ) : (
                    <ResultItem
                      key={`${item.id}-${index}`}
                      item={item}
                      query={query}
                      openDetail={(id) => {
                        setOpenResultMenuId(null)
                        openDetail(id)
                      }}
                      openEditor={openEditor}
                      copyText={copyText}
                      isAdmin={isAdmin}
                      onHideItem={onHideItem}
                      onDeleteItem={onDeleteItem}
                      index={index}
                      menuOpen={openResultMenuId === itemMenuId}
                      toggleMenu={() => setOpenResultMenuId((current) => (current === itemMenuId ? null : itemMenuId))}
                      closeMenu={() => setOpenResultMenuId(null)}
                    />
                  )
                )
              })}
            </div>
            <div className="library-pagination" aria-label="分页">
              <button
                type="button"
                className="secondary-control"
                disabled={safeCurrentPage === 1}
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                aria-label="上一页"
              >
                <ChevronRight size={16} className="pager-prev-icon" />
              </button>
              {paginationPages.map((page, index) => (
                <Fragment key={page}>
                  {index > 0 && page - paginationPages[index - 1] > 1 && <span>...</span>}
                  <button
                    type="button"
                    className={page === safeCurrentPage ? 'pager-page active' : 'pager-page'}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                </Fragment>
              ))}
              <button
                type="button"
                className="secondary-control"
                disabled={safeCurrentPage === totalPages}
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                aria-label="下一页"
              >
                <ChevronRight size={16} />
              </button>
              <FancySelect
                ariaLabel="每页数量"
                value={String(perPage)}
                onChange={(nextValue) => {
                  setPerPage(Number(nextValue))
                  setCurrentPage(1)
                }}
                options={[
                  { value: '20', label: '20 条/页' },
                  { value: '40', label: '40 条/页' },
                  { value: '80', label: '80 条/页' },
                ]}
              />
            </div>
          </>
        )}
      </section>
    </main>
  )
}

type AdminConsoleTab = 'hero' | 'featured' | 'timeline' | 'feedback' | 'duplicates' | 'hidden' | 'deleted'

function AdminConsole({
  items,
  assetPool,
  feedbacks,
  openDetail,
  openEditor,
  copyText,
  onHideItem,
  onDeleteItem,
  onRestoreItem,
  onPurgeItem,
  onMergeDuplicate,
  featuredCards,
  onUpdateFeaturedCard,
  onSaveFeaturedCards,
  onSaveTimelineConfig,
  homeHeroDetailId,
  homeHeroItems,
  onUpdateSettings,
}: {
  items: CollectionItem[]
  assetPool: Asset[]
  feedbacks: ArchiveFeedback[]
  openDetail: (id: string) => void
  openEditor: (item: CollectionItem) => void
  copyText: (text: string) => void
  onHideItem: (item: CollectionItem) => void
  onDeleteItem: (item: CollectionItem) => void
  onRestoreItem: (item: CollectionItem) => void
  onPurgeItem: (item: CollectionItem) => void
  onMergeDuplicate: (primaryItem: CollectionItem, duplicateItem: CollectionItem) => Promise<void>
  featuredCards: HomeFeaturedCard[]
  onUpdateFeaturedCard: (cardId: string, updates: Partial<HomeFeaturedCardConfig>) => void
  onSaveFeaturedCards: () => void | Promise<void>
  onSaveTimelineConfig: (item: CollectionItem, config: TimelineAdminConfig) => Promise<void>
  homeHeroDetailId?: string
  homeHeroItems?: HomeHeroExhibitConfig[]
  onUpdateSettings: (updates: Partial<ArchiveSettings>) => void
}) {
  const [activeTab, setActiveTab] = useState<AdminConsoleTab>('timeline')
  const [selectedTimelineItemId, setSelectedTimelineItemId] = useState<string | null>(null)
  const duplicateGroups = getDuplicateSourceGroups(items)
  const hiddenItems = items.filter((item) => item.status === 'hidden')
  const deletedItems = items.filter((item) => item.status === 'deleted')
  const openFeedbacks = feedbacks.filter((feedback) => feedback.status !== 'resolved')
  const activeDuplicateCount = duplicateGroups.reduce((count, group) => count + Math.max(0, group.items.length - 1), 0)
  const selectableHeroItems = items.filter((item) => item.status !== 'deleted')
  const timelineConfigItems = items
    .filter((item) => item.status !== 'deleted')
    .sort((left, right) =>
      Number(right.timelineEnabled === true) - Number(left.timelineEnabled === true) ||
      (right.timelineWeight ?? 0) - (left.timelineWeight ?? 0) ||
      left.title.localeCompare(right.title, 'zh-CN'),
    )
  const selectedTimelineItem =
    timelineConfigItems.find((item) => item.id === selectedTimelineItemId) ??
    timelineConfigItems.find((item) => item.timelineEnabled) ??
    timelineConfigItems[0]
  const configuredHomeHeroItems = (homeHeroItems?.length
    ? homeHeroItems
    : [{ id: 'hero-legacy', itemId: homeHeroDetailId ?? selectableHeroItems[0]?.id ?? defaultHomeHeroItems[0].itemId }]
  ).filter((entry) => entry.itemId)
  const activeHeroItems = configuredHomeHeroItems
    .map((entry) => ({
      config: entry,
      item: selectableHeroItems.find((item) => item.id === entry.itemId) ?? items.find((item) => item.id === entry.itemId),
    }))
    .filter((entry): entry is { config: HomeHeroExhibitConfig; item: CollectionItem } => Boolean(entry.item))
  const commitHomeHeroItems = (nextItems: HomeHeroExhibitConfig[]) => {
    const normalizedItems = nextItems.length ? nextItems : [{
      id: `hero-${Date.now()}`,
      itemId: selectableHeroItems[0]?.id ?? defaultHomeHeroItems[0].itemId,
    }]
    onUpdateSettings({
      homeHeroDetailId: normalizedItems[0]?.itemId,
      homeHeroItems: normalizedItems,
    })
  }
  const updateHomeHeroItem = (configId: string, itemId: string) => {
    commitHomeHeroItems(configuredHomeHeroItems.map((entry) => (entry.id === configId ? { ...entry, itemId } : entry)))
  }
  const addHomeHeroItem = () => {
    const usedItemIds = new Set(configuredHomeHeroItems.map((entry) => entry.itemId))
    const nextItem = selectableHeroItems.find((item) => !usedItemIds.has(item.id)) ?? selectableHeroItems[0] ?? collectionItems[0]
    commitHomeHeroItems([...configuredHomeHeroItems, { id: `hero-${Date.now()}`, itemId: nextItem.id }])
  }
  const removeHomeHeroItem = (configId: string) => {
    commitHomeHeroItems(configuredHomeHeroItems.filter((entry) => entry.id !== configId))
  }
  const tabs: Array<{ key: AdminConsoleTab; label: string; count: number }> = [
    { key: 'hero', label: '当前展品', count: activeHeroItems.length },
    { key: 'featured', label: '首页精选', count: featuredCards.length },
    { key: 'timeline', label: '时间线配置', count: timelineConfigItems.filter((item) => item.timelineEnabled).length },
    { key: 'feedback', label: '用户反馈', count: openFeedbacks.length },
    { key: 'duplicates', label: '疑似重复', count: activeDuplicateCount },
    { key: 'hidden', label: '已隐藏', count: hiddenItems.length },
    { key: 'deleted', label: '软删除', count: deletedItems.length },
  ]
  const sidebarGroups: Array<{ title: string; tabs: AdminConsoleTab[]; inactive?: Array<{ label: string; icon: ReactNode }> }> = [
    { title: '内容配置', tabs: ['hero', 'featured', 'timeline'] },
    { title: '内容治理', tabs: ['duplicates', 'feedback', 'hidden', 'deleted'] },
    {
      title: '系统维护',
      tabs: [],
      inactive: [
        { label: '分类配置', icon: <Grid3X3 size={17} /> },
        { label: '标签配置', icon: <Tag size={17} /> },
      ],
    },
  ]
  const tabIcons: Record<AdminConsoleTab, ReactNode> = {
    hero: <FolderOpen size={17} />,
    featured: <Star size={17} />,
    timeline: <Clock3 size={17} />,
    duplicates: <Copy size={17} />,
    feedback: <MessageSquare size={17} />,
    hidden: <CloudOff size={17} />,
    deleted: <X size={17} />,
  }
  const summaryEntryClass = (tab: AdminConsoleTab) => activeTab === tab ? 'admin-summary-entry active' : 'admin-summary-entry'

  return (
    <main className="admin-page admin-console-shell">
      <aside className="admin-sidebar" aria-label="管理控制台导航">
        <div className="admin-sidebar-head">
          <strong>管理控制台</strong>
        </div>
        {sidebarGroups.map((group) => (
          <div className="admin-sidebar-group" key={group.title}>
            <p>{group.title}</p>
            {group.tabs.map((tabKey) => {
              const tab = tabs.find((entry) => entry.key === tabKey)
              if (!tab) return null
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={activeTab === tab.key ? 'active' : ''}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <span>
                    {tabIcons[tab.key]}
                    {tab.label}
                  </span>
                  {tab.count > 0 && <em>{tab.count}</em>}
                </button>
              )
            })}
            {group.inactive?.map((item) => (
              <button key={item.label} type="button" disabled>
                <span>
                  {item.icon}
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        ))}
        <div className="admin-sidebar-foot">
          <span>© 2026 三国美术资料库</span>
          <span>版本 v1.0.0</span>
        </div>
      </aside>

      <section className="admin-main-panel">
        <section className="admin-head">
          <div>
            <p className="eyebrow">Admin Console</p>
            <h1>{activeTab === 'timeline' ? '后台管理' : tabs.find((tab) => tab.key === activeTab)?.label ?? '后台管理'}</h1>
            <p>统一处理首页精选、时间线配置、重复资料、反馈与内容状态管理。</p>
          </div>
        </section>

        <section className="admin-summary" aria-label="管理统计">
          <button type="button" className={summaryEntryClass('hero')} onClick={() => setActiveTab('hero')}>
            <ImageIcon size={18} strokeWidth={1.55} />
            <strong>{activeHeroItems.length}</strong>
            <span>当前展品</span>
          </button>
          <button type="button" className={summaryEntryClass('featured')} onClick={() => setActiveTab('featured')}>
            <Star size={18} strokeWidth={1.55} />
            <strong>{featuredCards.length}</strong>
            <span>首页精选</span>
          </button>
          <button type="button" className={summaryEntryClass('timeline')} onClick={() => setActiveTab('timeline')}>
            <Clock3 size={18} strokeWidth={1.55} />
            <strong>{timelineConfigItems.filter((item) => item.timelineEnabled).length}</strong>
            <span>时间线资料</span>
          </button>
          <button type="button" className={summaryEntryClass('duplicates')} onClick={() => setActiveTab('duplicates')}>
            <Copy size={18} strokeWidth={1.55} />
            <strong>{activeDuplicateCount}</strong>
            <span>待处理重复</span>
          </button>
          <button type="button" className={summaryEntryClass('feedback')} onClick={() => setActiveTab('feedback')}>
            <MessageSquare size={18} strokeWidth={1.55} />
            <strong>{openFeedbacks.length}</strong>
            <span>待处理反馈</span>
          </button>
          <button type="button" className={summaryEntryClass('hidden')} onClick={() => setActiveTab('hidden')}>
            <CloudOff size={18} strokeWidth={1.55} />
            <strong>{hiddenItems.length} / {deletedItems.length}</strong>
            <span>已隐藏 / 软删除</span>
          </button>
        </section>

        <div className="admin-risk-strip">
          管理员模式 · 所有修改将写入操作记录 · 删除不会移除 SVN 原始图片文件
        </div>

        <section className="admin-workspace">

        {activeTab === 'hero' && (
          <div className="admin-section-list">
            <section className="admin-featured-toolbar admin-hero-config-panel">
              <div>
                <h2>当前展品</h2>
                <p>配置首页 3D 展示区的轮播展品。每一条都会对应一个资料库条目，首页切换展品时，右侧资料卡和“查看资料”按钮会同步切换。</p>
              </div>
              <div className="admin-featured-save-group">
                <button type="button" className="secondary-control" onClick={addHomeHeroItem}>
                  <Plus size={15} />
                  增加当前展品
                </button>
                <button type="button" className="secondary-control" onClick={onSaveFeaturedCards}>
                  <Save size={15} />
                  保存配置
                </button>
              </div>
            </section>
            <div className="admin-hero-config-list">
              {activeHeroItems.map(({ config, item }, index) => {
                const heroItemAsset = getItemAssets(item)[0]
                return (
                  <article className="admin-hero-linked-card" key={config.id}>
                    {heroItemAsset ? <AssetThumb asset={heroItemAsset} /> : <div className="admin-hero-empty-thumb">暂无图片</div>}
                    <div className="admin-hero-row-main">
                      <label>
                        <span>当前展品 {index + 1}</span>
                        <FancySelect
                          ariaLabel={`首页当前展品 ${index + 1}`}
                          value={item.id}
                          options={selectableHeroItems.map((optionItem) => ({
                            value: optionItem.id,
                            label: `${optionItem.title} · ${optionItem.period}`,
                          }))}
                          onChange={(value) => updateHomeHeroItem(config.id, value)}
                        />
                      </label>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.period} · {item.sourceTypes[0] ?? getItemType(item)}</small>
                        <p>{item.summary}</p>
                      </span>
                    </div>
                    <div className="admin-hero-row-actions">
                      <button type="button" className="secondary-control" onClick={() => openDetail(item.id)}>
                        查看资料
                        <ChevronRight size={15} />
                      </button>
                      <button type="button" className="secondary-control" onClick={() => openEditor(item)}>
                        <FilePenLine size={15} />
                        编辑资料
                      </button>
                      <button
                        type="button"
                        className="secondary-control danger"
                        disabled={configuredHomeHeroItems.length <= 1}
                        onClick={() => removeHomeHeroItem(config.id)}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </div>
        )}

        {activeTab === 'featured' && (
          <div className="admin-section-list">
            <section className="admin-featured-toolbar">
              <div>
                <h2>首页精选资料</h2>
                <p>调整首页“精选资料”的关联资料、配图、标题、说明和统计显示。当前展品请在“当前展品”面板中配置。</p>
              </div>
              <div className="admin-featured-save-group">
                <button type="button" className="secondary-control" onClick={onSaveFeaturedCards}>
                  <Save size={15} />
                  保存配置
                </button>
              </div>
            </section>
            {featuredCards.map((card, index) => (
              <AdminFeaturedCardRow
                key={card.config.id}
                card={card}
                index={index}
                items={items}
                assetPool={assetPool}
                openDetail={openDetail}
                onUpdateFeaturedCard={onUpdateFeaturedCard}
              />
            ))}
          </div>
        )}

        {activeTab === 'timeline' && (
          <div className="admin-section-list">
            <section className="admin-module-head admin-timeline-module-head">
              <div>
                <h2>时间线配置</h2>
                <p>在后台直接维护资料是否进入时间线、展示时间、起止年份和代表权重。代表权重只影响同一时代下的代表卡排序，不代表史实可信度。</p>
              </div>
              <div className="admin-module-actions">
                <button type="button" className="secondary-control">
                  <Download size={15} />
                  导出配置
                </button>
                <button type="button" className="secondary-control">
                  <FileText size={15} />
                  操作日志
                </button>
                <button type="button" className="primary-control compact">
                  <Save size={15} />
                  批量保存
                </button>
              </div>
            </section>
            <div className="admin-table-toolbar">
              <label className="admin-search-field">
                <Search size={16} />
                <input placeholder="搜索资料标题 / 编码" />
              </label>
              <select defaultValue="">
                <option value="">时代</option>
              </select>
              <select defaultValue="">
                <option value="">分类</option>
              </select>
              <select defaultValue="">
                <option value="">是否进入时间线</option>
              </select>
              <select defaultValue="weight">
                <option value="weight">代表权重</option>
              </select>
            </div>
            <div className="admin-timeline-table-wrap">
              {timelineConfigItems.length ? (
                <table className="admin-timeline-table">
                  <thead>
                    <tr>
                      <th aria-label="选择" />
                      <th>资料</th>
                      <th>分类</th>
                      <th>时代</th>
                      <th>展示时间</th>
                      <th>起始年份</th>
                      <th>结束年份</th>
                      <th>代表权重</th>
                      <th>进入时间线</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timelineConfigItems.map((item) => (
                      <AdminTimelineConfigRow
                        key={item.id}
                        item={item}
                        openDetail={openDetail}
                        onSelect={() => setSelectedTimelineItemId(item.id)}
                        selected={selectedTimelineItem?.id === item.id}
                        onSaveTimelineConfig={onSaveTimelineConfig}
                      />
                    ))}
                  </tbody>
                </table>
              ) : (
                <AdminEmptyState title="暂无可配置资料" body="新建或恢复资料后，可在这里配置时间线展示。" />
              )}
            </div>
            {timelineConfigItems.length > 0 && (
              <div className="admin-table-footer">
                <span>共 {timelineConfigItems.length} 条</span>
                <select defaultValue="20">
                  <option value="20">20 条/页</option>
                </select>
                <button type="button" aria-label="上一页"><ChevronRight size={15} /></button>
                <button type="button" className="active">1</button>
                <button type="button" aria-label="下一页"><ChevronRight size={15} /></button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'feedback' && (
          <div className="admin-section-list">
            {feedbacks.length ? (
              feedbacks.map((feedback) => (
                <AdminFeedbackRow
                  key={feedback.id}
                  feedback={feedback}
                  item={items.find((entry) => entry.id === feedback.itemId)}
                  openDetail={openDetail}
                  copyText={copyText}
                />
              ))
            ) : (
              <AdminEmptyState title="暂无反馈" body="用户提交资料反馈后，会显示在这里。" />
            )}
          </div>
        )}

        {activeTab === 'duplicates' && (
          <div className="admin-section-list">
            {duplicateGroups.length ? (
              duplicateGroups.map((group) => {
                const primaryItem = group.items.find((item) => item.status === 'active') ?? group.items[0]
                const duplicateItems = group.items.filter((item) => item.id !== primaryItem.id)

                return (
                  <section className="admin-group" key={group.sourceUrl}>
                    <div className="admin-group-head">
                      <div>
                        <h2>来源链接相同</h2>
                        <code>{group.sourceUrl}</code>
                      </div>
                      <span>{duplicateItems.length} 条待处理</span>
                    </div>
                    <AdminRecordRow
                      item={primaryItem}
                      tone="primary"
                      label="主条目"
                      openDetail={openDetail}
                      openEditor={openEditor}
                      copyText={copyText}
                      onHideItem={primaryItem.status === 'hidden' || primaryItem.status === 'deleted' ? undefined : onHideItem}
                      onDeleteItem={primaryItem.status === 'deleted' ? undefined : onDeleteItem}
                      onRestoreItem={primaryItem.status === 'hidden' ? onRestoreItem : undefined}
                    />
                    {duplicateItems.map((item) => (
                      <AdminRecordRow
                        key={item.id}
                        item={item}
                        label="疑似重复"
                        openDetail={openDetail}
                        openEditor={openEditor}
                        copyText={copyText}
                        onHideItem={item.status === 'hidden' ? undefined : onHideItem}
                        onDeleteItem={item.status === 'deleted' ? undefined : onDeleteItem}
                        onRestoreItem={item.status === 'hidden' ? onRestoreItem : undefined}
                        onMergeItem={() => onMergeDuplicate(primaryItem, item)}
                      />
                    ))}
                  </section>
                )
              })
            ) : (
              <AdminEmptyState title="暂无疑似重复资料" body="当前没有命中相同来源链接的资料。" />
            )}
          </div>
        )}

        {activeTab === 'hidden' && (
          <div className="admin-section-list">
            {hiddenItems.length ? (
              hiddenItems.map((item) => (
                <AdminRecordRow
                  key={item.id}
                  item={item}
                  label="已隐藏"
                  openDetail={openDetail}
                  openEditor={openEditor}
                  copyText={copyText}
                  onRestoreItem={onRestoreItem}
                  onDeleteItem={onDeleteItem}
                />
              ))
            ) : (
              <AdminEmptyState title="暂无隐藏资料" body="隐藏资料会从普通列表、搜索、图片库和时间线中移除。" />
            )}
          </div>
        )}

        {activeTab === 'deleted' && (
          <div className="admin-section-list">
            {deletedItems.length ? (
              deletedItems.map((item) => (
                <AdminRecordRow
                  key={item.id}
                  item={item}
                  label="已软删除"
                  openDetail={openDetail}
                  openEditor={openEditor}
                  copyText={copyText}
                  onRestoreItem={onRestoreItem}
                  onPurgeItem={onPurgeItem}
                />
              ))
            ) : (
              <AdminEmptyState title="暂无软删除资料" body="软删除记录会保留在数据库中，可恢复，也可在确认后彻底删除记录。" />
            )}
          </div>
        )}
        </section>
      </section>
      {activeTab === 'timeline' && selectedTimelineItem && (
        <AdminTimelineEditPanel
          item={selectedTimelineItem}
          openDetail={openDetail}
          copyText={copyText}
          onSaveTimelineConfig={onSaveTimelineConfig}
        />
      )}
    </main>
  )
}

function AdminFeaturedCardRow({
  card,
  index,
  items,
  assetPool,
  openDetail,
  onUpdateFeaturedCard,
}: {
  card: HomeFeaturedCard
  index: number
  items: CollectionItem[]
  assetPool: Asset[]
  openDetail: (id: string) => void
  onUpdateFeaturedCard: (cardId: string, updates: Partial<HomeFeaturedCardConfig>) => void
}) {
  const activeItems = items.filter((item) => item.status !== 'deleted')
  const itemOptions = activeItems.map((item) => ({
    value: item.id,
    label: `${item.title} · ${item.period}`,
  }))
  const rowAssets = getItemAssets(card.item, assetPool)
  const previewAsset = rowAssets.find((asset) => asset.id === card.config.assetId) ?? rowAssets[0]
  const assetOptions = rowAssets.length
    ? rowAssets.map((asset) => ({
        value: asset.id,
        label: `${asset.caption} · ${asset.sourceType}`,
      }))
    : [{ value: '', label: '当前资料暂无图片' }]

  return (
    <article className="admin-featured-row">
      <button type="button" className="admin-featured-preview" onClick={() => openDetail(card.item.id)}>
        {previewAsset ? <AssetThumb asset={previewAsset} /> : <div className="admin-featured-empty-thumb">暂无图片</div>}
      </button>
      <div className="admin-featured-main">
        <div className="admin-record-title">
          <button type="button" className="title-button" onClick={() => openDetail(card.item.id)}>
            精选位 {index + 1}
          </button>
          <span>{card.item.title}</span>
        </div>
        <div className="admin-featured-selects">
          <label>
            <span>关联资料</span>
            <FancySelect
              ariaLabel={`精选位 ${index + 1} 关联资料`}
              value={card.item.id}
              options={itemOptions}
              onChange={(itemId) => {
                const nextItem = items.find((item) => item.id === itemId)
                const nextAsset = nextItem ? getItemAssets(nextItem, assetPool)[0] : undefined
                onUpdateFeaturedCard(card.config.id, { itemId, assetId: nextAsset?.id, title: '', description: '', countLabel: '' })
              }}
            />
          </label>
          <label>
            <span>展示图片</span>
            <FancySelect
              ariaLabel={`精选位 ${index + 1} 展示图片`}
              value={previewAsset?.id ?? ''}
              options={assetOptions}
              onChange={(assetId) => {
                if (!assetId) return
                onUpdateFeaturedCard(card.config.id, { assetId })
              }}
            />
          </label>
        </div>
      </div>
      <div className="admin-featured-fields">
        <label>
          <span>显示标题</span>
          <input
            value={card.config.title ?? ''}
            onChange={(event) => onUpdateFeaturedCard(card.config.id, { title: event.target.value })}
            placeholder={card.item.title}
          />
        </label>
        <label>
          <span>说明文字</span>
          <textarea
            value={card.config.description ?? ''}
            onChange={(event) => onUpdateFeaturedCard(card.config.id, { description: event.target.value })}
            placeholder={card.item.summary}
            rows={2}
          />
        </label>
        <label>
          <span>统计显示</span>
          <input
            value={card.config.countLabel ?? ''}
            onChange={(event) => onUpdateFeaturedCard(card.config.id, { countLabel: event.target.value })}
            placeholder={`${getItemImageCount(card.item)} 张图片`}
          />
        </label>
      </div>
    </article>
  )
}

function parseTimelineAdminNumber(value: string) {
  const trimmedValue = value.trim()
  if (!trimmedValue) return undefined
  const parsedValue = Number(trimmedValue)
  return Number.isFinite(parsedValue) ? parsedValue : undefined
}

function AdminTimelineConfigRow({
  item,
  openDetail,
  onSelect,
  selected,
  onSaveTimelineConfig,
}: {
  item: CollectionItem
  openDetail: (id: string) => void
  onSelect: () => void
  selected: boolean
  onSaveTimelineConfig: (item: CollectionItem, config: TimelineAdminConfig) => Promise<void>
}) {
  const [timelineEnabled, setTimelineEnabled] = useState(item.timelineEnabled === true)
  const [timelineLabel, setTimelineLabel] = useState(item.timelineLabel ?? '')
  const [startYearText, setStartYearText] = useState(item.startYear?.toString() ?? '')
  const [endYearText, setEndYearText] = useState(item.endYear?.toString() ?? '')
  const [timelineWeightText, setTimelineWeightText] = useState(item.timelineWeight?.toString() ?? '50')
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'failed'>('idle')
  const coverAsset = getItemAssets(item)[0] ?? assets[0]

  useEffect(() => {
    setTimelineEnabled(item.timelineEnabled === true)
    setTimelineLabel(item.timelineLabel ?? '')
    setStartYearText(item.startYear?.toString() ?? '')
    setEndYearText(item.endYear?.toString() ?? '')
    setTimelineWeightText(item.timelineWeight?.toString() ?? '50')
    setSaveState('idle')
  }, [item.id, item.timelineEnabled, item.timelineLabel, item.startYear, item.endYear, item.timelineWeight])

  const markDirty = () => setSaveState('idle')
  const saveConfig = async () => {
    setSaving(true)
    try {
      await onSaveTimelineConfig(item, {
        timelineEnabled,
        timelineLabel,
        startYear: parseTimelineAdminNumber(startYearText),
        endYear: parseTimelineAdminNumber(endYearText),
        timelineWeight: parseTimelineAdminNumber(timelineWeightText),
      })
      setSaveState('saved')
    } catch {
      setSaveState('failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className={`${timelineEnabled ? 'enabled ' : ''}${selected ? 'selected' : ''}`} onClick={onSelect}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={`选择 ${item.title}`}
        />
      </td>
      <td>
        <div className="admin-table-item-cell">
          <button type="button" className="admin-timeline-cover" onClick={(event) => {
            event.stopPropagation()
            openDetail(item.id)
          }}>
            <AssetThumb asset={coverAsset} />
          </button>
          <span>
            <button type="button" className="title-button" onClick={(event) => {
              event.stopPropagation()
              openDetail(item.id)
            }}>
              {item.title}
            </button>
            <code>{getArchiveItemCode(item)}</code>
          </span>
        </div>
      </td>
      <td>{getItemType(item)}</td>
      <td>{item.period}</td>
      <td>
        <input
          value={timelineLabel}
          onChange={(event) => {
            markDirty()
            setTimelineLabel(event.target.value)
          }}
          placeholder="约 220-265"
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <td>
        <input
          type="number"
          inputMode="numeric"
          value={startYearText}
          onChange={(event) => {
            markDirty()
            setStartYearText(event.target.value)
          }}
          placeholder="220"
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <td>
        <input
          type="number"
          inputMode="numeric"
          value={endYearText}
          onChange={(event) => {
            markDirty()
            setEndYearText(event.target.value)
          }}
          placeholder="265"
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <td>
        <input
          type="number"
          inputMode="numeric"
          min="0"
          max="100"
          value={timelineWeightText}
          onChange={(event) => {
            markDirty()
            setTimelineWeightText(event.target.value)
          }}
          placeholder="50"
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <td>
        <label className="admin-table-switch" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={timelineEnabled}
            onChange={(event) => {
              markDirty()
              setTimelineEnabled(event.target.checked)
            }}
          />
          <span>{timelineEnabled ? '是' : '否'}</span>
        </label>
      </td>
      <td>
        <div className="admin-timeline-actions">
          {saveState !== 'idle' && (
            <span className={saveState}>
              {saveState === 'saved' ? '已保存' : '保存失败'}
            </span>
          )}
          <button type="button" className="secondary-control" onClick={(event) => {
            event.stopPropagation()
            saveConfig()
          }} disabled={saving}>
            <FilePenLine size={14} />
            {saving ? '保存中' : '编辑'}
          </button>
        </div>
      </td>
    </tr>
  )
}

function AdminTimelineEditPanel({
  item,
  openDetail,
  copyText,
  onSaveTimelineConfig,
}: {
  item: CollectionItem
  openDetail: (id: string) => void
  copyText: (text: string) => void
  onSaveTimelineConfig: (item: CollectionItem, config: TimelineAdminConfig) => Promise<void>
}) {
  const [timelineEnabled, setTimelineEnabled] = useState(item.timelineEnabled === true)
  const [timelineLabel, setTimelineLabel] = useState(item.timelineLabel ?? '')
  const [startYearText, setStartYearText] = useState(item.startYear?.toString() ?? '')
  const [endYearText, setEndYearText] = useState(item.endYear?.toString() ?? '')
  const [timelineWeightText, setTimelineWeightText] = useState(item.timelineWeight?.toString() ?? '50')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTimelineEnabled(item.timelineEnabled === true)
    setTimelineLabel(item.timelineLabel ?? '')
    setStartYearText(item.startYear?.toString() ?? '')
    setEndYearText(item.endYear?.toString() ?? '')
    setTimelineWeightText(item.timelineWeight?.toString() ?? '50')
  }, [item.id, item.timelineEnabled, item.timelineLabel, item.startYear, item.endYear, item.timelineWeight])

  const saveConfig = async () => {
    setSaving(true)
    try {
      await onSaveTimelineConfig(item, {
        timelineEnabled,
        timelineLabel,
        startYear: parseTimelineAdminNumber(startYearText),
        endYear: parseTimelineAdminNumber(endYearText),
        timelineWeight: parseTimelineAdminNumber(timelineWeightText),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside className="admin-edit-panel" aria-label="编辑时间线配置">
      <div className="admin-edit-panel-head">
        <div>
          <h2>编辑时间线配置</h2>
        </div>
        <button type="button" className="icon-button" onClick={() => openDetail(item.id)} aria-label="查看资料详情">
          <ChevronRight size={18} />
        </button>
      </div>
      <section className="admin-edit-card admin-edit-record-card">
        <p>资料名</p>
        <strong>{item.title}</strong>
        <div className="admin-edit-code">
          <span>编码</span>
          <code>{getArchiveItemCode(item)}</code>
          <button type="button" className="icon-button" onClick={() => copyText(getArchiveItemCode(item))} aria-label="复制编码">
            <Copy size={15} />
          </button>
        </div>
      </section>
      <section className="admin-edit-card">
        <label className="admin-edit-switch">
          <span>是否进入时间线</span>
          <input
            type="checkbox"
            checked={timelineEnabled}
            onChange={(event) => setTimelineEnabled(event.target.checked)}
          />
        </label>
        <label>
          <span>展示时间</span>
          <input value={timelineLabel} onChange={(event) => setTimelineLabel(event.target.value)} placeholder="约 120-220" />
        </label>
        <div className="admin-edit-grid">
          <label>
            <span>起始年份</span>
            <input type="number" inputMode="numeric" value={startYearText} onChange={(event) => setStartYearText(event.target.value)} />
          </label>
          <label>
            <span>结束年份</span>
            <input type="number" inputMode="numeric" value={endYearText} onChange={(event) => setEndYearText(event.target.value)} />
          </label>
        </div>
        <label>
          <span>代表权重</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            max="100"
            value={timelineWeightText}
            onChange={(event) => setTimelineWeightText(event.target.value)}
          />
        </label>
        <label className="admin-edit-switch">
          <span>是否设为该时代代表资料</span>
          <input
            type="checkbox"
            checked={Number(timelineWeightText || 0) >= 90}
            onChange={(event) => setTimelineWeightText(event.target.checked ? '95' : '50')}
          />
        </label>
      </section>
      <section className="admin-edit-card">
        <label>
          <span>说明</span>
          <textarea placeholder="可填写补充说明（选填）" maxLength={300} />
          <small>0 / 300</small>
        </label>
      </section>
      <div className="admin-edit-panel-actions">
        <button type="button" className="secondary-control">
          取消
        </button>
        <button type="button" className="primary-control compact" onClick={saveConfig} disabled={saving}>
          {saving ? '保存中' : '保存配置'}
        </button>
      </div>
    </aside>
  )
}

function AdminFeedbackRow({
  feedback,
  item,
  openDetail,
  copyText,
}: {
  feedback: ArchiveFeedback
  item?: CollectionItem
  openDetail: (id: string) => void
  copyText: (text: string) => void
}) {
  return (
    <article className="admin-feedback-row">
      <div className="admin-feedback-main">
        <div className="admin-record-title">
          <button
            type="button"
            className="title-button"
            onClick={() => item && openDetail(item.id)}
            disabled={!item}
          >
            {feedback.itemTitle || item?.title || feedback.itemId}
          </button>
          <span>{feedback.feedbackType}</span>
          <em>{feedback.status === 'resolved' ? '已处理' : '待处理'}</em>
        </div>
        <p>{feedback.message}</p>
        <div className="admin-record-meta">
          <span>提交时间：{formatItemDate(feedback.createdAt)}</span>
          <span>提交人：{feedback.createdBy || '未知'}</span>
          {feedback.pageUrl && <code>{feedback.pageUrl}</code>}
        </div>
      </div>
      <div className="admin-record-actions">
        {item && (
          <button type="button" className="secondary-control" onClick={() => openDetail(item.id)}>
            <BookOpen size={15} />
            查看资料
          </button>
        )}
        {feedback.pageUrl && (
          <button type="button" className="secondary-control" onClick={() => copyText(feedback.pageUrl || '')}>
            <Copy size={15} />
            复制链接
          </button>
        )}
        {feedback.sourceUrl && (
          <button type="button" className="secondary-control" onClick={() => copyText(feedback.sourceUrl || '')}>
            <ExternalLink size={15} />
            复制来源
          </button>
        )}
      </div>
    </article>
  )
}

function AdminRecordRow({
  item,
  label,
  tone,
  openDetail,
  openEditor,
  copyText,
  onHideItem,
  onDeleteItem,
  onRestoreItem,
  onPurgeItem,
  onMergeItem,
}: {
  item: CollectionItem
  label: string
  tone?: 'primary'
  openDetail: (id: string) => void
  openEditor: (item: CollectionItem) => void
  copyText: (text: string) => void
  onHideItem?: (item: CollectionItem) => void
  onDeleteItem?: (item: CollectionItem) => void
  onRestoreItem?: (item: CollectionItem) => void
  onPurgeItem?: (item: CollectionItem) => void
  onMergeItem?: () => Promise<void>
}) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false)
  const [mergePending, setMergePending] = useState(false)
  const cover = getItemAssets(item)[0] ?? assets[0]
  const sourceUrl = getItemSourceUrl(item)
  const detailUrl = getArchiveDetailUrl(item)
  const mergeItem = async () => {
    if (!onMergeItem || mergePending) return
    setMergePending(true)
    try {
      await onMergeItem()
    } finally {
      setMergePending(false)
    }
  }

  return (
    <article className={tone === 'primary' ? 'admin-record-row primary' : 'admin-record-row'}>
      <button type="button" className="admin-record-cover" onClick={() => openDetail(item.id)}>
        <AssetThumb asset={cover} />
      </button>
      <div className="admin-record-main">
        <div className="admin-record-title">
          <button type="button" className="title-button" onClick={() => openDetail(item.id)}>
            {item.title}
          </button>
          <span>{label}</span>
          <em>{getStatusLabel(item.status)}</em>
        </div>
        <p>{item.summary}</p>
        <div className="admin-record-meta">
          <span>创建时间：{formatItemDate(item.createdAt ?? item.updatedAt)}</span>
          <span>创建人：{item.createdBy || '未知'}</span>
          {sourceUrl && <code>{sourceUrl}</code>}
        </div>
      </div>
      <div className="admin-record-actions">
        <button type="button" className="secondary-control" onClick={() => openDetail(item.id)}>
          <BookOpen size={15} />
          查看
        </button>
        {item.status !== 'deleted' && (
          <button type="button" className="secondary-control" onClick={() => openEditor(item)}>
            <FilePenLine size={15} />
            编辑
          </button>
        )}
        <button type="button" className="secondary-control" onClick={() => copyText(detailUrl)}>
          <Copy size={15} />
          复制链接
        </button>
        {onMergeItem && item.status === 'active' && (
          <button type="button" className="secondary-control" onClick={mergeItem} disabled={mergePending}>
            <Layers3 size={15} />
            {mergePending ? '合并中' : '合并重复'}
          </button>
        )}
        {onRestoreItem && (
          <button type="button" className="secondary-control" onClick={() => onRestoreItem(item)}>
            <RefreshCw size={15} />
            恢复
          </button>
        )}
        {onPurgeItem && item.status === 'deleted' && (
          <div className={purgeConfirmOpen ? 'admin-delete-wrap confirm-open' : 'admin-delete-wrap'}>
            <button type="button" className="secondary-control danger" onClick={() => setPurgeConfirmOpen(true)}>
              <X size={15} />
              彻底删除
            </button>
            {purgeConfirmOpen && (
              <div className="menu-confirm-panel admin-confirm-panel" role="dialog" aria-label="确认彻底删除该资料">
                <strong>确认彻底删除？</strong>
                <p>该操作会从资料库数据库中移除这条资料、关联图片记录和反馈记录，无法恢复。SVN 原始文件不会被删除。</p>
                <div>
                  <button type="button" className="secondary-control" onClick={() => setPurgeConfirmOpen(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPurgeConfirmOpen(false)
                      onPurgeItem(item)
                    }}
                  >
                    确认彻底删除
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {onHideItem && (
          <button type="button" className="secondary-control" onClick={() => onHideItem(item)}>
            <CloudOff size={15} />
            隐藏
          </button>
        )}
        {onDeleteItem && (
          <div className={deleteConfirmOpen ? 'admin-delete-wrap confirm-open' : 'admin-delete-wrap'}>
            <button type="button" className="secondary-control danger" onClick={() => setDeleteConfirmOpen(true)}>
              <X size={15} />
              删除
            </button>
            {deleteConfirmOpen && (
              <div className="menu-confirm-panel admin-confirm-panel" role="dialog" aria-label="确认删除资料记录">
                <strong>确认删除资料记录？</strong>
                <p>该操作只会删除资料记录及其关联关系，不会删除已同步到 SVN 的原始图片文件。</p>
                <div>
                  <button type="button" className="secondary-control" onClick={() => setDeleteConfirmOpen(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteConfirmOpen(false)
                      onDeleteItem(item)
                    }}
                  >
                    确认删除资料记录
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

function AdminEmptyState({ title, body }: { title: string; body: string }) {
  return (
    <section className="admin-empty-state">
      <AlertTriangle size={24} />
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  )
}

function EmptyLibraryResults({
  startNewItem,
  clearFilters,
  openWebClip,
}: {
  startNewItem: () => void
  clearFilters: () => void
  openWebClip: () => void
}) {
  return (
    <section className="empty-results library-empty-results" aria-label="空搜索结">
      <span className="empty-results-illustration" aria-hidden="true" />
      <h2>没有找到匹配资料</h2>
      <p>可以调整关键词或筛选条件，也可以直接新建一条资料</p>
      <div>
        <button type="button" onClick={startNewItem}>
          <Plus size={17} />
          新建资料
        </button>
        <button type="button" className="secondary-control" onClick={openWebClip}>
          <Globe2 size={17} />
          从网页采集
        </button>
        <button type="button" className="secondary-control" onClick={clearFilters}>
          清空条件
        </button>
      </div>
    </section>
  )
}

function getItemFacetValues(item: CollectionItem, key: FilterKey): string[] {
  if (key === 'itemTypes') return [getItemType(item)]
  if (key === 'costumeCategories') return getItemCategoryFacetValues(item)
  if (key === 'period') return [item.period]
  if (key === 'sourceTypes') return getStandardSourceTypes(item.sourceTypes)
  if (key === 'referenceUsages') return getStandardReferenceUsages(item.referencePurposes, item.usageHints)
  if (key === 'usageHints') return getStandardUsageHints(item.usageHints)
  return item[key] as string[]
}

function FilterSection({
  section,
  filters,
  expanded,
  toggleFilter,
  toggleExpanded,
}: {
  section: { key: FilterKey; title: string }
  filters: FilterState
  expanded: boolean
  toggleFilter: (key: FilterKey, value: string) => void
  toggleExpanded: () => void
}) {
  const options = [...facetOptions[section.key]]
  const visibleOptionLimit = section.key === 'referenceUsages' ? 8 : 4
  const visibleOptions = expanded ? options : options.slice(0, visibleOptionLimit)
  const getOptionCount = (value: string) => collectionItems.filter((item) => (
    section.key === 'costumeCategories'
      ? itemMatchesCategoryFilters(item, [value])
      : getItemFacetValues(item, section.key).includes(value)
  )).length

  return (
    <div className={expanded ? 'filter-group expanded' : 'filter-group'}>
      <button type="button" className="filter-group-title" onClick={toggleExpanded}>
        <h3>{section.title}</h3>
        <span>{expanded ? '-' : '+'}</span>
      </button>
      {expanded && (
        section.key === 'costumeCategories' ? (
          <div className="filter-options category-filter-options">
            {categoryFacetGroups.map((group) => {
              const groupActive = filters.costumeCategories.includes(group.label)
              return (
                <div className={groupActive ? 'category-filter-group active' : 'category-filter-group'} key={group.label}>
                  <label className="category-filter-primary">
                    <input
                      type="checkbox"
                      checked={groupActive}
                      onChange={() => toggleFilter(section.key, group.label)}
                    />
                    <span>{group.label}</span>
                    <small>{getOptionCount(group.label)}</small>
                  </label>
                  {groupActive && (
                    <div className="category-filter-children">
                      {group.options.map((value) => (
                        <label key={value}>
                          <input
                            type="checkbox"
                            checked={filters.costumeCategories.includes(value)}
                            onChange={() => toggleFilter(section.key, value)}
                          />
                          <span>{value}</span>
                          <small>{getOptionCount(value)}</small>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="filter-options">
            {visibleOptions.map((value) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={filters[section.key].includes(value)}
                  onChange={() => toggleFilter(section.key, value)}
                />
                <span>{value}</span>
                <small>{getOptionCount(value)}</small>
              </label>
            ))}
          </div>
        )
      )}
    </div>
  )
}

function SearchRow({
  query,
  setQuery,
  placeholder,
}: {
  query: string
  setQuery: (query: string) => void
  placeholder: string
}) {
  return (
    <div className="search-row library-search-row">
      <Search size={22} />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} />
    </div>
  )
}

type FancySelectOption = {
  value: string
  label: string
}

function FancySelect({
  ariaLabel,
  value,
  defaultValue,
  options,
  onChange,
  className = '',
}: {
  ariaLabel: string
  value?: string
  defaultValue?: string
  options: FancySelectOption[]
  onChange?: (value: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [internalValue, setInternalValue] = useState(defaultValue ?? options[0]?.value ?? '')
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedValue = value ?? internalValue
  const selectedOption = options.find((option) => option.value === selectedValue) ?? options[0]

  useEffect(() => {
    if (!open) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current || typeof window === 'undefined') return

    const rootRect = rootRef.current.getBoundingClientRect()
    const menuRect = menuRef.current.getBoundingClientRect()
    const viewportGap = 16
    const spaceBelow = window.innerHeight - rootRect.bottom - viewportGap
    const spaceAbove = rootRect.top - viewportGap
    setDropUp(spaceBelow < menuRect.height && spaceAbove > spaceBelow)
  }, [open, options.length])

  const chooseOption = (nextValue: string) => {
    if (value === undefined) {
      setInternalValue(nextValue)
    }
    onChange?.(nextValue)
    setOpen(false)
  }

  return (
    <div className={`fancy-select ${open ? 'open' : ''} ${dropUp ? 'drop-up' : ''} ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className="fancy-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedOption?.label ?? '请选择'}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="fancy-select-menu" role="listbox" aria-label={ariaLabel} ref={menuRef}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === selectedValue}
              className={option.value === selectedValue ? 'selected' : ''}
              key={option.value}
              onClick={() => chooseOption(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultItem({
  item,
  query,
  openDetail,
  openEditor,
  copyText,
  isAdmin,
  onHideItem,
  onDeleteItem,
  index,
  menuOpen,
  toggleMenu,
  closeMenu,
}: {
  item: CollectionItem
  query: string
  openDetail: (id: string) => void
  openEditor: (item: CollectionItem) => void
  copyText: (text: string) => void
  isAdmin: boolean
  onHideItem: (item: CollectionItem) => void
  onDeleteItem: (item: CollectionItem) => void
  index: number
  menuOpen: boolean
  toggleMenu: () => void
  closeMenu: () => void
}) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const cover = assets.find((asset) => asset.id === item.imageIds[0]) ?? assets[0]
  const itemType = getItemType(item)
  const itemCategories = getItemCategories(item)
  const pathParts = [
    itemType,
    item.period,
    item.identityTypes[0],
    item.officialTypes[0],
    itemCategories[0],
  ].filter(Boolean)
  const imageCount = getItemImageCount(item)
  const sourceBadge = item.referencePurposes.includes('史实依据') ? '史实依据' : item.referencePurposes[0]
  const duplicateSuspect = isDuplicateSuspect(item)
  const detailUrl = getArchiveDetailUrl(item)
  const archiveCode = getArchiveItemCode(item)
  const matchLabels = getLibraryMatchLabels(item, query)
  const sourceSummary = item.sourceTypes.slice(0, 2).join(' / ') || '内部整理'
  const referenceTags = item.referencePurposes.slice(0, 3)

  useEffect(() => {
    if (!menuOpen) setDeleteConfirmOpen(false)
  }, [menuOpen])

  const openFromCard = () => openDetail(item.id)
  const shouldIgnoreCardClick = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, [role="menu"], .menu-confirm-panel'))

  return (
    <article
      className={`result-item ${menuOpen ? 'result-menu-open' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 42}ms` }}
      tabIndex={0}
      aria-label={`查看资料详情：${item.title}`}
      onClick={(event) => {
        if (shouldIgnoreCardClick(event.target)) return
        openFromCard()
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openFromCard()
        }
      }}
    >
      <button type="button" className="result-cover" onClick={() => openDetail(item.id)}>
        <AssetThumb asset={cover} />
      </button>
      <div className="result-body">
        <div className="result-title-row">
          <button type="button" className="title-button" onClick={() => openDetail(item.id)}>
            {item.title.replace('（宽袍大袖）', '')}
          </button>
          {duplicateSuspect && <span className="duplicate-badge">疑似重复</span>}
        </div>
        <button type="button" className="archive-code-pill result-code-pill" onClick={() => copyText(archiveCode)} aria-label={`复制资料编码 ${archiveCode}`}>
          <Copy size={13} />
          {archiveCode}
        </button>
        <p>{item.summary}</p>
        <div className="result-facts" aria-label="资料关键信息">
          {pathParts.map((part, pathIndex) => (
            <span key={`${part}-${pathIndex}`}>{part}</span>
          ))}
        </div>
        <div className="result-source-line">
          <span>来源</span>
          <strong>{sourceSummary}</strong>
        </div>
        {matchLabels.length > 0 && (
          <div className="result-match-row">
            <span>匹配</span>
            {matchLabels.map((label) => (
              <em key={label}>{label}</em>
            ))}
          </div>
        )}
        <TagRow tags={[...referenceTags, ...item.tags].slice(0, 5)} />
      </div>
      <aside className="result-meta">
        <strong>
          <ImageIcon size={16} />
          {imageCount} 张图
        </strong>
        <span className={sourceBadge === '史实依据' ? 'evidence-badge' : 'reference-badge'}>{sourceBadge}</span>
        <button type="button" className="secondary-control result-open-button" onClick={() => openDetail(item.id)}>
          <BookOpen size={15} />
          查看资料
        </button>
        <div className="more-menu-wrap result-more-wrap">
          <button
            type="button"
            className="icon-button result-more-button"
            aria-label="更多操作"
            aria-expanded={menuOpen}
            onClick={toggleMenu}
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen && (
            <div className="more-menu" role="menu">
              <button
                type="button"
                className="more-menu-item"
                role="menuitem"
                onClick={() => {
                  closeMenu()
                  openDetail(item.id)
                }}
              >
                <BookOpen size={15} />
                查看详情
              </button>
              <button
                type="button"
                className="more-menu-item"
                role="menuitem"
                onClick={() => {
                  closeMenu()
                  copyText(detailUrl)
                }}
              >
                <Copy size={15} />
                复制链接
              </button>
              <button
                type="button"
                className="more-menu-item"
                role="menuitem"
                onClick={() => {
                  closeMenu()
                  copyText(archiveCode)
                }}
              >
                <Copy size={15} />
                复制编码
              </button>
              {isAdmin && (
                <>
                  <button
                    type="button"
                    className="more-menu-item"
                    role="menuitem"
                    onClick={() => {
                      closeMenu()
                      openEditor(item)
                    }}
                  >
                    <FilePenLine size={15} />
                    编辑资料
                  </button>
                  <button
                    type="button"
                    className="more-menu-item"
                    role="menuitem"
                    onClick={() => {
                      onHideItem(item)
                      closeMenu()
                    }}
                  >
                    <CloudOff size={15} />
                    隐藏资料
                  </button>
                  <button
                    type="button"
                    className="more-menu-item danger"
                    role="menuitem"
                    onPointerDown={(event) => {
                      event.preventDefault()
                      setDeleteConfirmOpen(true)
                    }}
                    onClick={() => {
                      setDeleteConfirmOpen(true)
                    }}
                  >
                    <X size={15} />
                    删除资料
                  </button>
                  {deleteConfirmOpen && (
                    <div className="menu-confirm-panel" role="dialog" aria-label="确认删除资料记录">
                      <strong>确认删除资料记录？</strong>
                      <p>该操作只会删除资料记录及其关联关系，不会删除已同步到 SVN 的原始图片文件。</p>
                      <div>
                        <button type="button" className="secondary-control" onClick={() => setDeleteConfirmOpen(false)}>
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteConfirmOpen(false)
                            closeMenu()
                            onDeleteItem(item)
                          }}
                        >
                          确认删除资料记录
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </aside>
    </article>
  )
}

function ReaderResultItem({
  item,
  query,
  openDetail,
  index,
}: {
  item: CollectionItem
  query: string
  openDetail: (id: string) => void
  index: number
}) {
  const itemType = getItemType(item)
  const itemCategories = getItemCategories(item)
  const pathParts = [
    itemType,
    item.period,
    item.identityTypes[0],
    item.officialTypes[0],
    itemCategories[0],
  ].filter(Boolean)
  const imageCount = getItemImageCount(item)
  const sourceBadge = item.referencePurposes.includes('史实依据') ? '史实依据' : item.referencePurposes[0]
  const matchLabels = getLibraryMatchLabels(item, query)
  const sourceSummary = item.sourceTypes.slice(0, 2).join(' / ') || '内部整理'
  const tags = [...item.referencePurposes.slice(0, 2), ...item.tags].slice(0, 4)

  return (
    <article
      className="reader-result-item"
      style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
      tabIndex={0}
      aria-label={`阅读资料摘要：${item.title}`}
      onClick={() => openDetail(item.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openDetail(item.id)
        }
      }}
    >
      <div className="reader-result-main">
        <div className="reader-result-title-row">
          <button
            type="button"
            className="title-button"
            onClick={(event) => {
              event.stopPropagation()
              openDetail(item.id)
            }}
          >
            {item.title.replace('（宽袍大袖）', '')}
          </button>
          <span>{imageCount} 图</span>
          {sourceBadge && <em>{sourceBadge}</em>}
        </div>
        <p>{item.summary}</p>
        <div className="reader-result-facts">
          <span>{sourceSummary}</span>
          {pathParts.map((part, pathIndex) => (
            <span key={`${part}-${pathIndex}`}>{part}</span>
          ))}
        </div>
        {matchLabels.length > 0 && (
          <div className="reader-result-match">
            {matchLabels.map((label) => (
              <em key={label}>匹配 {label}</em>
            ))}
          </div>
        )}
      </div>
      <TagRow tags={tags} />
    </article>
  )
}

function TagRow({ tags }: { tags: string[] }) {
  return (
    <div className="tag-row">
      {tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  )
}

function ImageLibrary({
  visibleAssets,
  setLightboxAsset,
  openDetail,
  startNewItem,
}: {
  visibleAssets: Asset[]
  setLightboxAsset: (asset: Asset) => void
  openDetail: (id: string) => void
  startNewItem: () => void
}) {
  const [imageQuery, setImageQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [filtersTouched, setFiltersTouched] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [perPage, setPerPage] = useState(() => readGalleryPerPage())
  const [perPageOpen, setPerPageOpen] = useState(false)
  const [ocrEntries, setOcrEntries] = useState<Record<string, GalleryOcrEntry>>(() => readGalleryOcrCache())
  const [ocrProgressText, setOcrProgressText] = useState('')
  const [ocrScanVersion, setOcrScanVersion] = useState(0)
  const [expandedGallerySections, setExpandedGallerySections] = useState<Record<string, boolean>>(
    () => readBooleanMapState(galleryFilterSectionsStateKey),
  )
  const galleryCards = useMemo(() => visibleAssets.map(buildGalleryCardFromAsset), [visibleAssets])
  const galleryAssetIdsKey = useMemo(() => galleryCards.map((card) => card.asset.id).join('|'), [galleryCards])
  const filterSections = useMemo(() => buildGalleryFilterSections(galleryCards), [galleryCards])
  const imageCards = galleryCards
    .filter((card) => {
      const linkedItem = getAssetLinkedItem(card.asset)
      const ocrEntry = ocrEntries[card.asset.id]
      const terms = getSearchTerms(imageQuery)
      const searchableValues = [
        card.title,
        card.relation,
        card.asset.caption,
        card.asset.imageType,
        card.asset.sourceType,
        card.asset.referencePurpose,
        card.asset.svnPath,
        card.asset.sourceUrl ?? '',
        card.asset.originalUrl ?? '',
        card.asset.sourcePageUrl ?? '',
        card.asset.fileName ?? '',
        ocrEntry?.status === 'done' ? ocrEntry.text : '',
        ...card.tags,
        ...card.filters,
        ...(linkedItem ? getLibrarySearchValues(linkedItem) : []),
      ].filter(Boolean).map((value) => value.toLowerCase())
      const matchesQuery =
        !terms.length || terms.every((term) => searchableValues.some((value) => searchValueMatchesTerm(value, term)))
      const matchesFilters =
        !filtersTouched || !activeFilters.length || activeFilters.some((filter) => card.filters.includes(filter))
      return matchesQuery && matchesFilters
    })
  const totalPages = Math.max(1, Math.ceil(imageCards.length / perPage))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const pageStart = (safeCurrentPage - 1) * perPage
  const visibleImageCards = imageCards.slice(pageStart, pageStart + perPage)
  const pageNumbers = Array.from({ length: Math.min(5, totalPages) }, (_, index) => index + 1)
  const trimmedImageQuery = imageQuery.trim()
  const hasGalleryCriteria = Boolean(trimmedImageQuery || (filtersTouched && activeFilters.length))
  const ocrStats = useMemo(() => {
    const entries = galleryCards.map((card) => ocrEntries[card.asset.id])
    return {
      total: galleryCards.length,
      done: entries.filter((entry) => entry?.status === 'done').length,
      processing: entries.filter((entry) => entry?.status === 'processing' || entry?.status === 'queued').length,
      failed: entries.filter((entry) => entry?.status === 'failed').length,
    }
  }, [galleryCards, ocrEntries])

  const toggleGalleryFilter = (value: string) => {
    setCurrentPage(1)
    setFiltersTouched(true)
    setActiveFilters((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    )
  }
  const toggleGalleryFilterSection = (sectionTitle: string, defaultExpanded: boolean) => {
    setExpandedGallerySections((current) => {
      const next = { ...current, [sectionTitle]: !(current[sectionTitle] ?? defaultExpanded) }
      writeBooleanMapState(galleryFilterSectionsStateKey, next)
      return next
    })
  }
  const clearGalleryFilters = () => {
    setCurrentPage(1)
    setImageQuery('')
    setFiltersTouched(false)
    setActiveFilters([])
  }
  const choosePerPage = (nextPerPage: number) => {
    setCurrentPage(1)
    setPerPage(nextPerPage)
    writeGalleryPerPage(nextPerPage)
    setPerPageOpen(false)
  }
  const rescanGalleryOcr = () => {
    const visibleAssetIds = new Set(galleryCards.map((card) => card.asset.id))
    setOcrEntries((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([assetId]) => !visibleAssetIds.has(assetId)))
      writeGalleryOcrCache(next)
      return next
    })
    setOcrProgressText('正在重新扫描图片文字...')
    setOcrScanVersion((version) => version + 1)
  }

  useEffect(() => {
    if (!galleryCards.length) return

    let cancelled = false
    const cachedEntries = readGalleryOcrCache()
    const targets = galleryCards
      .map((card) => card.asset)
      .filter((asset) => {
        const entry = cachedEntries[asset.id] ?? ocrEntries[asset.id]
        return !entry || (entry.status !== 'done' && entry.status !== 'failed')
      })

    if (!targets.length) {
      setOcrProgressText('')
      return
    }

    const setOcrEntry = (assetId: string, entry: GalleryOcrEntry) => {
      if (cancelled) return
      setOcrEntries((current) => {
        const next = { ...current, [assetId]: entry }
        writeGalleryOcrCache(next)
        return next
      })
    }

    const scan = async () => {
      let currentAssetLabel = ''
      let worker: Awaited<ReturnType<typeof createWorker>> | null = null

      try {
        worker = await createWorker(['chi_sim', 'chi_tra', 'eng'], 1, {
          logger: (message) => {
            if (!cancelled && message.status) {
              setOcrProgressText(`${currentAssetLabel} ${message.status} ${Math.round((message.progress || 0) * 100)}%`)
            }
          },
        })

        for (const [index, asset] of targets.entries()) {
          if (cancelled) break
          currentAssetLabel = `OCR ${index + 1}/${targets.length}`
          setOcrProgressText(`${currentAssetLabel}：${asset.caption}`)
          setOcrEntry(asset.id, { status: 'processing', text: '', updatedAt: new Date().toISOString() })

          try {
            const ocrInput = await createGalleryOcrInput(asset)
            const result = await worker.recognize(ocrInput)
            const text = safeCleanGalleryOcrText(result.data.text)
            setOcrEntry(asset.id, { status: 'done', text, updatedAt: new Date().toISOString() })
          } catch (error) {
            setOcrEntry(asset.id, {
              status: 'failed',
              text: '',
              error: error instanceof Error ? error.message : 'OCR识别失败',
              updatedAt: new Date().toISOString(),
            })
          }
        }

        if (!cancelled) setOcrProgressText('')
      } catch (error) {
        if (!cancelled) {
          setOcrProgressText(error instanceof Error ? `OCR 初始化失败：${error.message}` : 'OCR 初始化失败')
        }
      } finally {
        await worker?.terminate().catch(() => undefined)
      }
    }

    void scan()

    return () => {
      cancelled = true
    }
  }, [galleryAssetIdsKey, ocrScanVersion])

  return (
    <main className="gallery-page">
      <aside className={hasGalleryCriteria ? 'gallery-filters has-active-filters' : 'gallery-filters'}>
        <div className="filter-head">
          <h2>
            <Funnel size={22} />
            筛选条件
          </h2>
          <button type="button" className="filter-clear" onClick={clearGalleryFilters} disabled={!hasGalleryCriteria}>
            清空
          </button>
        </div>
        {filterSections.map((section) => (
          <GalleryFilterSection
            key={section.title}
            section={section}
            activeFilters={activeFilters}
            toggleFilter={toggleGalleryFilter}
            expanded={expandedGallerySections[section.title] ?? Boolean(section.expanded)}
            toggleExpanded={() => toggleGalleryFilterSection(section.title, Boolean(section.expanded))}
          />
        ))}
      </aside>

      <section className="gallery-results">
        <div className="library-page-head">
          <div className="library-title-block">
            <p className="eyebrow">IMAGE ARCHIVE</p>
            <h1>图片库</h1>
            <p>快速查看浏览图片内容</p>
          </div>
        </div>
        <div className="gallery-search-row">
          <Search size={22} />
          <input
            value={imageQuery}
            onChange={(event) => {
              setCurrentPage(1)
              setImageQuery(event.target.value)
            }}
            placeholder="搜索图片、标签、来源或 SVN 文件..."
          />
        </div>

        {hasGalleryCriteria && (
          <div className="gallery-chip-row" aria-label="图片筛选快捷项">
            {trimmedImageQuery && (
              <button type="button" className="gallery-chip" onClick={() => setImageQuery('')}>
                搜索：{trimmedImageQuery}
                <X size={13} />
              </button>
            )}
            {filtersTouched && activeFilters.slice(0, 6).map((filter) => (
              <button type="button" className="gallery-chip" key={filter} onClick={() => toggleGalleryFilter(filter)}>
                {filter}
                <X size={13} />
              </button>
            ))}
            <button type="button" className="gallery-filter-clear" onClick={clearGalleryFilters}>
              清空全部
            </button>
          </div>
        )}

        <div className="gallery-toolbar">
          <span>共 {imageCards.length} 张图</span>
          <div className="gallery-ocr-status" aria-live="polite">
            <FileText size={16} />
            <span>
              OCR 已识别 {ocrStats.done}/{ocrStats.total}
              {ocrStats.processing ? `，识别中 ${ocrStats.processing}` : ''}
              {ocrStats.failed ? `，失败 ${ocrStats.failed}` : ''}
            </span>
            {ocrProgressText && <small>{ocrProgressText}</small>}
            <button type="button" className="secondary-control gallery-ocr-rescan" onClick={rescanGalleryOcr}>
              重新 OCR
            </button>
          </div>
        </div>

        {visibleImageCards.length ? (
          <section className="asset-grid">
            {visibleImageCards.map((card, index) => {
              const ocrEntry = ocrEntries[card.asset.id]
              const hasOcrText = Boolean(ocrEntry?.status === 'done' && ocrEntry.text)

              return (
                <article className="asset-card" key={card.id} style={{ animationDelay: `${Math.min(index, 10) * 34}ms` }}>
                  <button type="button" className="gallery-card-image" onClick={() => setLightboxAsset(card.asset)}>
                    <AssetThumb asset={card.asset} />
                    <span className={card.reference === '史实依据' ? 'gallery-card-badge evidence' : 'gallery-card-badge'}>
                      {card.reference}
                    </span>
                    <span className="gallery-view-large">
                      <ImageIcon size={16} />
                      查看大图
                    </span>
                  </button>
                  <div className="gallery-card-body">
                    <h3>{card.title}</h3>
                    <div className="gallery-card-tags">
                      {card.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                      {hasOcrText && <span className="gallery-ocr-tag">OCR文字</span>}
                    </div>
                    <button type="button" className="gallery-card-detail" onClick={() => openDetail(getAssetLinkedItem(card.asset)?.id ?? card.asset.linkedItemId)}>
                      关联条目：{card.relation}
                    </button>
                  </div>
                </article>
              )
            })}
          </section>
        ) : (
          <GalleryEmptyState
            query={imageQuery}
            clear={() => {
              setCurrentPage(1)
              setImageQuery('')
              clearGalleryFilters()
            }}
            openGallery={() => {
              setCurrentPage(1)
              setImageQuery('')
              setActiveFilters([])
              setFiltersTouched(false)
            }}
            startNewItem={startNewItem}
            showCriteria={hasGalleryCriteria}
          />
        )}

        {visibleImageCards.length > 0 && <div className="gallery-pagination" aria-label="图片分页">
          <button
            type="button"
            className="gallery-page-nav"
            disabled={safeCurrentPage === 1}
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
          >
            <ChevronRight size={15} className="pager-prev-icon" />
          </button>
          {pageNumbers.map((page) => (
            <button
              key={page}
              type="button"
              className={page === safeCurrentPage ? 'pager-page active' : 'pager-page'}
              onClick={() => setCurrentPage(page)}
            >
              {page}
            </button>
          ))}
          {totalPages > 6 && <span>...</span>}
          {totalPages > 5 && (
            <button
              type="button"
              className={safeCurrentPage === totalPages ? 'pager-page active' : 'pager-page'}
              onClick={() => setCurrentPage(totalPages)}
            >
              {totalPages}
            </button>
          )}
          <button
            type="button"
            className="gallery-page-nav"
            disabled={safeCurrentPage === totalPages}
            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
          >
            <ChevronRight size={15} />
          </button>
          <div className="gallery-page-size">
            <button
              type="button"
              className="gallery-page-size-button"
              aria-haspopup="listbox"
              aria-expanded={perPageOpen}
              onClick={() => setPerPageOpen((open) => !open)}
            >
              每页 {perPage} 张
              <ChevronDown size={15} />
            </button>
            {perPageOpen && (
              <div className="gallery-page-size-menu" role="listbox" aria-label="每页图片数量">
                {GALLERY_PAGE_SIZE_OPTIONS.map((size) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={perPage === size}
                    className={perPage === size ? 'active' : ''}
                    key={size}
                    onClick={() => choosePerPage(size)}
                  >
                    每页 {size} 张
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>}
      </section>
    </main>
  )
}

const defaultTimelineFilters: TimelineQuery = { topicCategory: 'all' }

const TIMELINE_DISPLAY_PERIODS: Period[] = ['东汉', '东汉末', '魏', '蜀', '吴', '西晋初']
const timelineIntroTitle = '物象纪年'
const timelineIntroDescription = '循时代脉络，观东汉末至三国间服饰、甲胄、器物、图像与建筑之形制流变。'
const timelinePeriodLabels: Partial<Record<Period, string>> = {
  东汉: '25-220',
  东汉末: '184-220',
  魏: '220-265',
  蜀: '221-263',
  吴: '222-280',
  西晋初: '265-316',
}

const timelineTopicOptions: Array<{
  key: TimelineCategoryKey
  label: string
  title: string
  description: string
  filterLabel: string
  iconKind: HanCategoryIconKind
  showIdentityFilter: boolean
  keywords: string[]
}> = [
  {
    key: 'all',
    label: '全部类别',
    title: '物象纪年',
    description: '循时代脉络，观东汉末至三国间服饰、甲胄、器物、图像与建筑之形制流变。',
    filterLabel: '细分',
    iconKind: 'costume',
    showIdentityFilter: true,
    keywords: [],
  },
  {
    key: 'costume',
    label: '服饰',
    title: '物象纪年',
    description: '循时代脉络，观东汉末至三国间服饰、甲胄、器物、壁画与建筑之形制流变。',
    filterLabel: '服装细类',
    iconKind: 'costume',
    showIdentityFilter: true,
    keywords: ['袍服', '腰带', '鞋履', '发式', '常服'],
  },
  {
    key: 'armor',
    label: '甲胄',
    title: '甲胄时间线',
    description: '按时代查看甲胄、披挂、兵器与武官武将形象资料演变。',
    filterLabel: '甲胄细类',
    iconKind: 'armor',
    showIdentityFilter: true,
    keywords: ['甲胄', '披挂', '铠甲', '短甲', '兵器'],
  },
  {
    key: 'headwear',
    label: '冠帽',
    title: '冠帽时间线',
    description: '按时代查看东汉末至三国时期冠、帽、帻、盔等头部服饰资料演变。',
    filterLabel: '冠帽细类',
    iconKind: 'headwear',
    showIdentityFilter: true,
    keywords: ['冠帽', '冠饰', '冠', '帽', '帻', '盔', '头部', '头饰', '进贤冠', '武冠'],
  },
  {
    key: 'vessel',
    label: '器物',
    title: '器物时间线',
    description: '按时代查看青铜器、陶器、香炉、带钩等器物工艺资料演变。',
    filterLabel: '器物细类',
    iconKind: 'vessel',
    showIdentityFilter: false,
    keywords: ['器物', '器皿', '青铜器', '陶器', '陶俑', '香炉', '博山炉', '带钩', '漆器', '玉器'],
  },
  {
    key: 'mural',
    label: '图像',
    title: '壁画时间线',
    description: '按时代查看画像砖、墓室壁画、拓片与图像资料演变。',
    filterLabel: '图像细类',
    iconKind: 'mural',
    showIdentityFilter: false,
    keywords: ['壁画', '画像', '画像砖', '画像石', '墓室图像', '拓片', '陶俑图像'],
  },
  {
    key: 'architecture',
    label: '建筑',
    title: '建筑时间线',
    description: '按时代查看城池、宫殿、楼阁、阙与墓葬空间资料演变。',
    filterLabel: '建筑细类',
    iconKind: 'architecture',
    showIdentityFilter: false,
    keywords: ['建筑', '城池', '宫殿', '楼阁', '阙', '望楼', '墓葬空间', '建筑构件'],
  },
  {
    key: 'pattern',
    label: '纹样',
    title: '纹样时间线',
    description: '按时代查看纹样、织锦、云气纹、边饰、色彩与材质资料演变。',
    filterLabel: '纹样细类',
    iconKind: 'pattern',
    showIdentityFilter: false,
    keywords: ['纹样', '纹饰', '织锦', '云气纹', '边饰', '色彩', '材质'],
  },
]

const timelinePeriodRanges: Array<{
  label: string
  periodStart?: TimelineQuery['periodStart']
  periodEnd?: TimelineQuery['periodEnd']
}> = [
  { label: '东汉末至西晋', periodStart: '东汉', periodEnd: '西晋初' },
  { label: '东汉至西晋初', periodStart: '东汉', periodEnd: '西晋初' },
  { label: '三国时期', periodStart: '魏', periodEnd: '吴' },
  { label: '全部时代' },
]

const getTimelineRangeKey = (query: TimelineQuery) => `${query.periodStart ?? 'all'}-${query.periodEnd ?? 'all'}`

function findTimelineCardById(groups: ReturnType<typeof buildTimelineResponse>['groups'], id?: string) {
  if (!id) return undefined
  return groups.flatMap((group) => group.items).find((item) => item.id === id)
}

function buildTimelineDisplayGroups(timelineResponse: ReturnType<typeof buildTimelineResponse>) {
  const groupByPeriod = new Map(timelineResponse.groups.map((group) => [group.periodKey, group]))

  return TIMELINE_DISPLAY_PERIODS.flatMap((period) => {
    const matchedGroup = groupByPeriod.get(period)
    if (!matchedGroup?.items.length) return []

    return [{
      periodKey: period,
      label: period,
      order: PERIOD_ORDER.indexOf(period),
      items: matchedGroup.items,
      featuredItem: matchedGroup.featuredItem,
    }]
  })
}

function formatTimelineLabel(item: TimelineCardItem) {
  if (item.timelineLabel) return item.timelineLabel
  if (item.startYear && item.endYear) return `约 ${item.startYear}-${item.endYear}`
  if (item.startYear) return `约 ${item.startYear} 起`
  return item.period
}

function getTimelineTopicLabel(topicKey?: TimelineCategoryKey) {
  return timelineTopicOptions.find((topic) => topic.key === topicKey)?.label ?? '全部'
}

function getItemCover(itemId: string, itemPool: CollectionItem[] = collectionItems, assetPool: Asset[] = assets) {
  const item = itemPool.find((entry) => entry.id === itemId) ?? collectionItems.find((entry) => entry.id === itemId)
  return item ? (getItemAssets(item, assetPool)[0] ?? assets[0]) : assets[0]
}

type GalleryFilterOption = {
  value: string
  count: number
}

type GalleryFilterSectionConfig = {
  title: string
  options: GalleryFilterOption[]
  expanded?: boolean
}

function GalleryFilterSection({
  section,
  activeFilters,
  toggleFilter,
  expanded,
  toggleExpanded,
}: {
  section: GalleryFilterSectionConfig
  activeFilters: string[]
  toggleFilter: (value: string) => void
  expanded: boolean
  toggleExpanded: () => void
}) {
  return (
    <section className={expanded ? 'filter-group expanded' : 'filter-group'}>
      <button type="button" className="filter-group-title" onClick={toggleExpanded}>
        <h3>{section.title}</h3>
        <span>{expanded ? '-' : '+'}</span>
      </button>
      {expanded && (
        <div className="filter-options">
          {section.options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={activeFilters.includes(option.value)}
                onChange={() => toggleFilter(option.value)}
              />
              <span>{option.value}</span>
              <small>{option.count}</small>
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

function getPaginationPages(currentPage: number, totalPages: number) {
  if (totalPages <= 6) {
    return Array.from({ length: totalPages }, (_, index) => index + 1)
  }

  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])

  if (currentPage <= 3) {
    pages.add(2)
    pages.add(3)
    pages.add(4)
  }

  if (currentPage >= totalPages - 2) {
    pages.add(totalPages - 3)
    pages.add(totalPages - 2)
    pages.add(totalPages - 1)
  }

  return Array.from(pages)
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b)
}

type GalleryCard = {
  id: string
  asset: Asset
  title: string
  reference: string
  relation: string
  tags: string[]
  filters: string[]
}

function buildGalleryCardTitle(asset: Asset, item?: CollectionItem) {
  const assetTitle = asset.caption || asset.fileName?.replace(/\.[^.]+$/, '') || ''
  const itemTitle = item?.title ?? ''

  if (!itemTitle) return assetTitle || '未命名图片'
  if (!assetTitle || assetTitle === itemTitle || assetTitle.startsWith(itemTitle)) return itemTitle

  return `${itemTitle} · ${assetTitle}`
}

function buildGalleryCardFromAsset(asset: Asset): GalleryCard {
  const item = getAssetLinkedItem(asset)
  const tags = uniqueValues([
    asset.imageType,
    asset.sourceType,
    asset.referencePurpose,
    ...asset.tags,
    ...(item?.costumeCategories ?? []),
  ].filter((value): value is string => Boolean(value)))
  const filters = uniqueValues([
    asset.imageType,
    asset.sourceType,
    ...getStandardSourceTypes([asset.sourceType, ...(item?.sourceTypes ?? [])]),
    asset.referencePurpose,
    ...(item?.usageHints ?? []),
    ...getStandardUsageHints(item?.usageHints ?? []),
    ...getStandardReferenceUsages([asset.referencePurpose, ...(item?.referencePurposes ?? [])], item?.usageHints ?? []),
    item?.period,
    ...(item?.tags ?? []),
    ...asset.tags,
  ].filter((value): value is string => Boolean(value)))

  return {
    id: `gallery-${asset.id}`,
    asset,
    title: buildGalleryCardTitle(asset, item),
    reference: asset.referencePurpose || item?.referencePurposes[0] || '未分类',
    relation: item?.title || '未关联资料',
    tags: tags.slice(0, 4),
    filters,
  }
}

function countGalleryFilterOption(cards: GalleryCard[], option: string) {
  return cards.filter((card) => card.filters.includes(option)).length
}

function buildGalleryFilterSections(cards: GalleryCard[]): GalleryFilterSectionConfig[] {
  const makeSection = (title: string, values: string[], expanded = true, includeEmptyOptions = false, preserveOrder = false) => ({
    title,
    expanded,
    options: (() => {
      const options = uniqueValues(values.filter(Boolean))
        .map((value) => ({ value, count: countGalleryFilterOption(cards, value) }))
        .filter((option) => includeEmptyOptions || option.count > 0)
      return preserveOrder ? options : options.sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, 'zh-CN'))
    })(),
  })

  return [
    makeSection('图片类型', cards.map((card) => card.asset.imageType)),
    makeSection('来源类型', [...sourceTypePriority], true, true, true),
    makeSection('参考用途', [...standardReferenceUsageOptions], true, true, true),
    makeSection('时代', cards.map((card) => getAssetLinkedItem(card.asset)?.period ?? ''), false),
    makeSection('标签', cards.flatMap((card) => [...card.asset.tags, ...(getAssetLinkedItem(card.asset)?.tags ?? [])]), false),
  ].filter((section) => section.options.length)
}

function GalleryEmptyState({
  query,
  clear,
  openGallery,
  startNewItem,
  showCriteria,
}: {
  query: string
  clear: () => void
  openGallery: () => void
  startNewItem: () => void
  showCriteria: boolean
}) {
  return (
    <section className="gallery-empty-state">
      <span className="empty-results-illustration gallery-empty-art" aria-hidden="true" />
      <h2>没有找到相关资料</h2>
      <p>{showCriteria ? `搜索：${query || '当前筛选条件'}` : '当前图片库暂无可显示资料'}</p>
      <div className="gallery-empty-actions">
        <button type="button" className="secondary-control" onClick={clear}>
          <RotateCcw size={18} />
          清空筛选
        </button>
        <button type="button" className="secondary-control" onClick={openGallery}>
          <ImageIcon size={18} />
          查看图库
        </button>
        <button type="button" className="secondary-control" onClick={startNewItem}>
          <Plus size={18} />
          新建资料
        </button>
      </div>
    </section>
  )
}

function GalleryWorkflowDialog({
  kind,
  close,
  copyText,
  startNewItem,
  selectedAssetIds,
  onSvnSelected,
  onWebClipSaved,
  findExistingWebClipItem,
  onBookScanImported,
  notify,
}: {
  kind: Exclude<GalleryDialog, null>
  close: () => void
  copyText: (text: string) => void
  startNewItem: () => void
  selectedAssetIds: string[]
  onSvnSelected: (selectedAssets: Asset[]) => void
  onWebClipSaved: (clipImport: WebClipImport, saveMode?: WebClipSaveMode) => void
  findExistingWebClipItem: (clipImport: WebClipImport | null) => CollectionItem | null
  onBookScanImported: (bookScan: BookScanImport) => void
  notify: (message: string) => void
}) {
  if (kind === 'svn-picker') {
    return <SvnPickerDialog close={close} copyText={copyText} selectedAssetIds={selectedAssetIds} onConfirm={onSvnSelected} />
  }
  if (kind === 'add-source') return <AddSourceDialog close={close} copyText={copyText} notify={notify} />
  if (kind === 'tag-picker') return <TagPickerDialog close={close} />
  if (kind === 'book-scan') return <BookScanDialog close={close} copyText={copyText} onConfirm={onBookScanImported} />
  if (kind === 'web-clip') {
    return <WebClipDialog close={close} copyText={copyText} onSaved={onWebClipSaved} findExistingItem={findExistingWebClipItem} />
  }
  return <SyncStatusDialog close={close} startNewItem={startNewItem} notify={notify} />
}

function BookScanDialog({
  close,
  copyText,
  onConfirm,
}: {
  close: () => void
  copyText: (text: string) => void
  onConfirm: (bookScan: BookScanImport) => void
}) {
  const [files, setFiles] = useState<BookScanSelectedFile[]>([])
  const [recognizedText, setRecognizedText] = useState('')
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [progressText, setProgressText] = useState('等待上传扫描件')
  const fileNames = files.map((entry) => entry.originalName)
  const recognition = useMemo(() => buildBookScanRecognition(recognizedText, fileNames), [recognizedText, fileNames.join('|')])
  const canImport = files.length > 0 || recognizedText.trim().length > 0

  const updateFiles = async (fileList: FileList | null) => {
    const selectedFiles = sortBookScanFiles(Array.from(fileList ?? []).filter((file) => file.type.startsWith('image/')))
    if (!selectedFiles.length) return
    const nextFiles = await Promise.all(
      selectedFiles.map(async (file) => {
        try {
          const [preview, ocrFile] = await Promise.all([resizeBookScanImage(file, 1800), prepareBookScanOcrImage(file)])
          return { ocrFile, originalName: file.name, previewUrl: preview.dataUrl }
        } catch {
          return { ocrFile: file, originalName: file.name, previewUrl: await readFileAsDataUrl(file) }
        }
      }),
    )
    setFiles(nextFiles)
    setRecognizedText('')
    setProgressText(`已选择 ${selectedFiles.length} 张扫描件`)
  }

  const runRecognition = async () => {
    if (!files.length || isRecognizing) return
    setIsRecognizing(true)
    setProgressText('正在准备 PaddleOCR')
    try {
      const ocrFiles = files.map((entry) => entry.ocrFile)
      let text = ''
      try {
        text = await recognizeBookScanFilesWithPaddle(ocrFiles, setProgressText)
        setProgressText(text ? 'PaddleOCR 识别完成，可检查并修正文稿' : 'PaddleOCR 未识别到稳定文本，可直接粘贴或手动输入')
      } catch (error) {
        setProgressText(`PaddleOCR 不可用，切换浏览器 OCR：${error instanceof Error ? error.message : '服务异常'}`)
        text = await recognizeBookScanFiles(ocrFiles, setProgressText)
        setProgressText(text ? '浏览器 OCR 识别完成，可检查并修正文稿' : '未识别到稳定文本，可直接粘贴或手动输入')
      }
      setRecognizedText(text)
    } catch (error) {
      setProgressText(error instanceof Error ? `OCR 失败：${error.message}` : 'OCR 失败')
    } finally {
      setIsRecognizing(false)
    }
  }

  const cleanRecognizedText = () => {
    setRecognizedText((current) => {
      const cleanedText = safeCleanBookScanOcrText(current, 'manual')
      const beforeLines = current.split(/\r?\n/).filter((line) => line.trim()).length
      const afterLines = cleanedText.split(/\r?\n/).filter((line) => line.trim()).length
      const removedLines = Math.max(0, beforeLines - afterLines)
      const removedChars = Math.max(0, current.trim().length - cleanedText.trim().length)
      setProgressText(
        cleanedText === current
          ? 'OCR 文本已清理，无更多明显噪声'
          : `已清理 OCR 文本：移除 ${removedLines} 行 / ${removedChars} 字符`,
      )
      return cleanedText
    })
  }

  const confirmImport = () => {
    const normalizedText = safeCleanBookScanOcrText(recognizedText)
    const fileDrafts = files.map((entry) => ({
      name: entry.originalName,
      size: entry.ocrFile.size,
      previewUrl: entry.previewUrl,
    }))
    const nextRecognition = buildBookScanRecognition(normalizedText, fileDrafts.map((file) => file.name))
    const records = buildBookScanRecords(fileDrafts, nextRecognition)
    onConfirm({
      id: `book-scan-${Date.now()}`,
      ...records,
      text: normalizedText,
      recognition: nextRecognition,
    })
  }

  return (
    <div className="workflow-dialog-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog book-scan-dialog">
        <DialogHead title="图书扫描件识别" close={close} />
        <div className="book-scan-body">
          <section className="book-scan-upload">
            <label className={files.length ? 'book-scan-drop has-files' : 'book-scan-drop'}>
              <FileText size={30} />
              <span>选择书籍扫描图片</span>
              <small>支持 JPG、PNG、WebP，可一次选择多页；优先使用本机 PaddleOCR，失败时自动回退浏览器 OCR。</small>
              <input type="file" accept="image/*" multiple onChange={(event) => updateFiles(event.target.files)} />
            </label>
            <div className="book-scan-actions">
              <button type="button" className="secondary-control" onClick={runRecognition} disabled={!files.length || isRecognizing}>
                <RefreshCw size={16} />
                {isRecognizing ? '识别中' : '开始 OCR'}
              </button>
              <button type="button" className="secondary-control" onClick={() => copyText(recognizedText)} disabled={!recognizedText.trim()}>
                <Copy size={16} />
                复制文本
              </button>
              <button
                type="button"
                className="secondary-control"
                onClick={cleanRecognizedText}
                disabled={!recognizedText.trim() || isRecognizing}
              >
                清理 OCR 文本
              </button>
              <span className={isRecognizing ? 'processing' : ''}>{progressText}</span>
            </div>
            {files.length > 0 && (
              <div className="book-scan-preview-grid">
                {files.map((entry) => (
                  <article key={entry.previewUrl}>
                    <img src={entry.previewUrl} alt={entry.originalName} />
                    <span>{entry.originalName}</span>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="book-scan-text-panel">
            <label>
              OCR 文本
              <textarea
                value={recognizedText}
                onChange={(event) => setRecognizedText(event.target.value)}
                placeholder="可以粘贴已有 OCR 文本，或上传扫描图后点击开始 OCR。"
              />
            </label>
          </section>

          <section className="book-scan-result">
            <div className="web-clip-section-title">
              <div>
                <p className="eyebrow">图书来源 Source</p>
                <h3>{formatBookTitle(recognition.title)}</h3>
              </div>
            </div>
            <div className="book-scan-field-grid">
              <Info label="来源类型" value={recognition.title.includes('志') || recognition.title.includes('书') ? '史料典籍' : '现代书籍'} />
              <Info label="作者" value={recognition.author || '待补充'} />
              <Info label="出版社" value={recognition.publisher || '待补充'} />
              <Info label="页码" value={recognition.pageLabel || '待补充'} />
              <Info label="ISBN" value={recognition.isbn || '待补充'} />
              <Info label="年份" value={recognition.year || '待补充'} />
              <Info label="标签" value={recognition.tags.join(' / ')} />
            </div>
            <p>{recognition.summary}</p>
            <div className="book-scan-page-summary">
              <strong>扫描页 Page Asset</strong>
              <span>{files.length ? files.map((entry, index) => `P${index + 1} ${entry.originalName}`).join(' / ') : '尚未选择扫描页'}</span>
            </div>
          </section>
        </div>
        <footer className="workflow-dialog-foot">
          <button type="button" className="secondary-control" onClick={close}>
            取消
          </button>
          <button type="button" className="web-clip-copy-button" onClick={confirmImport} disabled={!canImport || isRecognizing}>
            带入编辑器
          </button>
        </footer>
      </section>
    </div>
  )
}

function WebClipDialog({
  close,
  copyText,
  onSaved,
  findExistingItem,
}: {
  close: () => void
  copyText: (text: string) => void
  onSaved: (clipImport: WebClipImport, saveMode?: WebClipSaveMode) => void
  findExistingItem: (clipImport: WebClipImport | null) => CollectionItem | null
}) {
  const [url, setUrl] = useState('')
  const [clipImport, setClipImport] = useState<WebClipImport | null>(null)
  const [status, setStatus] = useState<WebClipStatus>('pending')
  const [loginStatus, setLoginStatus] = useState('')
  const [clipboardStatus, setClipboardStatus] = useState('')
  const [serverExistingItem, setServerExistingItem] = useState<CollectionItem | null>(null)
  const clipTimerRef = useRef<number | undefined>(undefined)
  const requestIdRef = useRef(0)
  const platformPreview = identifyWebClipPlatform(url)
  const needsLoginBrowser = platformPreview?.platform === '小红书'
  const importableImages = clipImport?.extractedImages.filter((image) => image.downloadStatus !== 'failed') ?? []
  const selectedImages = importableImages.filter((image) => image.selected)
  const allImagesSelected = Boolean(importableImages.length) && selectedImages.length === importableImages.length
  const localExistingItem = findExistingItem(clipImport)
  const existingItem = localExistingItem ?? serverExistingItem
  const translationZh = clipImport?.translationZh
  const extractedText = clipImport
    ? [
        clipImport.pageTitle,
        clipImport.summary,
        clipImport.extractedText,
        `来源：${clipImport.normalizedUrl ?? clipImport.inputUrl}`,
      ]
        .filter(Boolean)
        .join('\n')
    : ''
  const translatedText = translationZh
    ? [translationZh.title, translationZh.summary, ...(translationZh.fields ?? []).map((field) => `${field.label}: ${field.value}`)]
        .filter(Boolean)
        .join('\n')
    : ''
  const toggleImage = (imageId: string) => {
    setClipImport((current) =>
      current
        ? {
            ...current,
            extractedImages: current.extractedImages.map((image) =>
              image.id === imageId && image.downloadStatus !== 'failed' ? { ...image, selected: !image.selected } : image,
            ),
          }
        : current,
    )
  }
  const setAllImagesSelected = (selected: boolean) => {
    setClipImport((current) =>
      current
        ? {
            ...current,
            extractedImages: current.extractedImages.map((image) => ({
              ...image,
              selected: image.downloadStatus === 'failed' ? false : selected,
            })),
          }
        : current,
    )
  }
  const updateClipSummary = (summary: string) => {
    setClipImport((current) =>
      current
        ? {
            ...current,
            summary,
            itemDraft: current.itemDraft ? { ...current.itemDraft, summary } : current.itemDraft,
          }
        : current,
    )
  }
  const runClip = (delay = 420) => {
    window.clearTimeout(clipTimerRef.current)
    const requestUrl = url.trim()

    if (!requestUrl) {
      setClipImport(null)
      setStatus('pending')
      return
    }

    setClipImport(null)
    setServerExistingItem(null)
    setStatus('processing')
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    clipTimerRef.current = window.setTimeout(async () => {
      const nextClip = await createWebClipImport(requestUrl)
      if (requestIdRef.current !== requestId) return
      setClipImport(nextClip)
      setStatus(nextClip.status)
    }, delay)
  }

  useEffect(() => {
    let cancelled = false
    if (!clipImport || clipImport.status === 'failed' || localExistingItem) {
      setServerExistingItem(null)
      return
    }

    const matchExistingItem = async () => {
      try {
        const snapshot = await fetchArchiveSnapshot()
        if (cancelled) return
        setServerExistingItem(findWebClipExistingItem(clipImport, snapshot.items))
      } catch {
        if (!cancelled) setServerExistingItem(null)
      }
    }

    void matchExistingItem()
    return () => {
      cancelled = true
    }
  }, [clipImport?.id, localExistingItem?.id])

  useEffect(() => {
    runClip(520)
    return () => window.clearTimeout(clipTimerRef.current)
  }, [url])

  useEffect(() => {
    let cancelled = false

    const loadClipboardUrl = async () => {
      if (!navigator.clipboard?.readText) {
        setClipboardStatus('当前浏览器不支持自动读取剪贴板，可手动粘贴链接')
        return
      }

      try {
        const clipboardText = await navigator.clipboard.readText()
        if (cancelled) return
        const clipboardUrl = extractFirstUrl(clipboardText)
        if (!clipboardUrl || !isHttpUrl(clipboardUrl)) {
          setClipboardStatus('剪贴板里没有可用网页链接')
          return
        }

        setUrl((currentUrl) => {
          const currentUrlText = currentUrl.trim()
          if (currentUrlText) {
            setClipboardStatus('已检测到剪贴板链接，当前输入已保留')
            return currentUrl
          }

          setClipboardStatus('已自动读取剪贴板里的最新链接')
          return clipboardUrl
        })
      } catch {
        if (!cancelled) setClipboardStatus('无法自动读取剪贴板，可手动粘贴链接')
      }
    }

    void loadClipboardUrl()
    return () => {
      cancelled = true
    }
  }, [])

  const saveClip = (saveMode: WebClipSaveMode = existingItem ? 'update' : 'create') => {
    if (!clipImport || clipImport.status === 'failed') return
    onSaved(clipImport, saveMode)
  }

  const updateClipSourceUrl = (sourceUrl: string) => {
    setClipImport((current) =>
      current
        ? {
            ...current,
            normalizedUrl: sourceUrl,
            sourceDraft: current.sourceDraft ? { ...current.sourceDraft, sourceUrl } : current.sourceDraft,
          }
        : current,
    )
  }

  const openLoginBrowser = async () => {
    setLoginStatus('正在打开采集登录浏览器...')
    try {
      const message = await startWebClipLoginSession(url.trim() || 'https://www.xiaohongshu.com/explore')
      setLoginStatus(message)
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : '登录浏览器启动失败')
    }
  }

  return (
    <div className="workflow-dialog-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog web-clip-dialog">
        <DialogHead title="从网页采集资料" close={close} />
        <div className="web-clip-body">
          <section className="web-clip-input-panel">
            <label>
              链接
              <span className="web-clip-url-row">
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴网页链接..." />
                <button type="button" onClick={() => runClip(120)} disabled={status === 'processing' || !url.trim()}>
                  {status === 'processing' ? '读取' : clipImport ? '重新读取' : '读取网页'}
                </button>
              </span>
            </label>
            <p>
              只展示从网页真实读取到的标题、摘要和图片。读取失败时会显示失败原因，不会用占位图或编造摘要代替。
            </p>
            {clipboardStatus && <p className="web-clip-clipboard-status">{clipboardStatus}</p>}
            {needsLoginBrowser && (
              <div className="web-clip-login-row">
                <button type="button" className="secondary-control" onClick={openLoginBrowser}>
                  <ExternalLink size={15} />
                  登录采集浏览器
                </button>
                <span>{loginStatus || '小红书需要在弹出的采集浏览器里登录；确认能看到笔记内容后可保持窗口打开，再重新读取。'}</span>
              </div>
            )}
            <div
              className={status === 'processing' ? 'web-clip-status-line processing' : 'web-clip-status-line'}
              aria-live="polite"
            >
              {status === 'processing' ? (
                <>
                  <RefreshCw size={15} /> 正在读取网页真实内容
                </>
              ) : clipImport?.status === 'failed' ? (
                <>
                  <AlertTriangle size={15} /> 读取失败
                </>
              ) : clipImport ? (
                <>
                  <Check size={15} /> 已读取 {clipImport.extractedFields?.length ?? 0} 个字段，发现图片{' '}
                  {clipImport.extractedImages.length} 张
                </>
              ) : (
                <>
                  <Globe2 size={15} /> 等待网页链接
                </>
              )}
            </div>
          </section>

          {clipImport?.status === 'failed' ? (
            <section className="web-clip-failed">
              <AlertTriangle size={28} />
              <h3>采集失败</h3>
              <p>{clipImport.errorMessage}</p>
            </section>
          ) : clipImport ? (
            <section className="web-clip-result" key={clipImport.id}>
              <div className="web-clip-summary-card">
                <p className="eyebrow">采集结果</p>
                <h3>{clipImport.pageTitle}</h3>
                <Info label="平台" value={clipImport.platform ?? '未知平台'} />
                <Info label="来源类型" value={getStandardSourceTypes([clipImport.suggestedSourceType, '网络资料'])[0] ?? '网络资料'} />
                <Info label="参考性质" value={clipImport.suggestedReferencePurpose?.join(' / ') ?? '研究线索'} />
                <Info label="使用限制" value={clipImport.usageRestriction ?? '需确认来源与授权'} />
                <Info label="状态" value={clipImport.status === 'partial_success' ? '部分采集成功' : '采集成功'} />
              </div>

              {translationZh && (
                <div className="web-clip-translation-card web-clip-wide">
                  <div className="web-clip-section-title">
                    <div>
                      <p className="eyebrow">中文译文</p>
                      <h3>{translationZh.title}</h3>
                    </div>
                    <button
                      type="button"
                      className="secondary-control"
                      onClick={() => copyText(translatedText)}
                      disabled={!translatedText}
                    >
                      <Copy size={15} />
                      复制译文
                    </button>
                  </div>
                  {translationZh.summary && <p className="web-clip-translation-summary">{translationZh.summary}</p>}
                  {translationZh.fields?.length ? (
                    <div className="web-clip-translation-grid">
                      {translationZh.fields.slice(0, 10).map((field) => (
                        <div key={`${field.label}-${field.value}`}>
                          <span>{field.label}</span>
                          <p>{field.value}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}

              <div className="web-clip-extract-panel">
                <div className="web-clip-section-title">
                  <strong>网页读取字段</strong>
                  <button
                    type="button"
                    className="secondary-control"
                    onClick={() => copyText(extractedText)}
                    disabled={!extractedText}
                  >
                    <Copy size={15} />
                    复制字段
                  </button>
                </div>
                <div className="web-clip-extract-grid">
                  {(clipImport.extractedFields ?? []).map((field) => (
                    <div key={field.label}>
                      <span>{field.label}</span>
                      <p>{field.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <label className="web-clip-wide">
                网页摘要
                <textarea
                  value={clipImport.summary ?? ''}
                  onChange={(event) => updateClipSummary(event.target.value)}
                  placeholder="网页没有返回可解析摘要"
                />
                <small>保存后将作为资料正文，可在这里先编辑。</small>
              </label>

              <div className="web-clip-images web-clip-wide">
                <div className="web-clip-image-toolbar">
                  <strong>图片</strong>
                  <span>已选择 {selectedImages.length} 张</span>
                  {importableImages.length > 0 && (
                    <button type="button" className="secondary-control" onClick={() => setAllImagesSelected(!allImagesSelected)}>
                      {allImagesSelected ? '取消全选' : '全选'}
                    </button>
                  )}
                </div>
                {clipImport.extractedImages.length ? (
                  <div className="web-clip-image-grid">
                    {clipImport.extractedImages.map((image) => (
                      <button
                        type="button"
                        className={image.selected ? 'selected' : ''}
                        key={image.id}
                        onClick={() => toggleImage(image.id)}
                        disabled={image.downloadStatus === 'failed'}
                      >
                        <span className="web-clip-image-state" aria-hidden="true">
                          {image.selected ? <Check size={13} /> : null}
                        </span>
                        <img src={image.thumbnailUrl ?? image.imageUrl} alt={image.altText ?? image.caption ?? ''} />
                        <span>{image.caption ?? image.altText ?? image.imageUrl}</span>
                        <strong className="web-clip-image-selection">{image.selected ? '已选择' : '未选择'}</strong>
                        <em>
                          {image.downloadStatus === 'downloaded'
                            ? '已下载'
                            : image.downloadStatus === 'failed'
                              ? `下载失败${image.errorMessage ? `：${image.errorMessage}` : ''}`
                              : '仅识别到链接'}
                        </em>
                      </button>
                    ))}
                  </div>
                ) : (
                  <section className="web-clip-empty-images">
                    <ImageIcon size={26} />
                    <p>没有从网页中读取到图片链接</p>
                  </section>
                )}
              </div>

              <div className="web-clip-draft-grid web-clip-wide">
                <label>
                  建议资料类型
                  <input defaultValue={clipImport.suggestedCollectionType} />
                </label>
                <label>
                  建议标签
                  <input defaultValue={clipImport.suggestedTags?.join(' / ')} />
                </label>
                <label>
                  来源链接
                  <input value={clipImport.normalizedUrl ?? ''} onChange={(event) => updateClipSourceUrl(event.target.value)} />
                </label>
                <label>
                  创建人
                  <input defaultValue={clipImport.createdBy} />
                </label>
              </div>
            </section>
          ) : (
            <section className={status === 'processing' ? 'web-clip-placeholder processing' : 'web-clip-placeholder'}>
              <Globe2 size={36} />
              <h3>{status === 'processing' ? '正在读取网页真实内容' : '粘贴链接读取网页内容'}</h3>
              <p>
                系统会尝试读取网页标题、描述和图片链接。读取不到时会明确失败，不会显示模拟结果。
              </p>
            </section>
          )}
        </div>
        <footer className="workflow-dialog-foot">
          {existingItem && (
            <div className="web-clip-existing-hint">
              <strong>已找到同来源资料</strong>
              <span>{existingItem.title}</span>
            </div>
          )}
          <button type="button" className="secondary-control" onClick={close}>
            取消
          </button>
          {existingItem && (
            <button
              type="button"
              className="secondary-control"
              onClick={() => saveClip('create')}
              disabled={!clipImport || clipImport.status === 'failed'}
            >
              另存为新资料
            </button>
          )}
          <button
            type="button"
            className="web-clip-copy-button"
            onClick={() => saveClip()}
            disabled={!clipImport || clipImport.status === 'failed'}
          >
            {existingItem ? '更新已有资料' : '保存为新资料'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function mapSvnApiFile(file: SvnApiFile): SvnPickerFile {
  const matchedAsset = file.assetId
    ? assets.find((asset) => asset.id === file.assetId)
    : assets.find((asset) => asset.svnPath === file.path)
  const sourceUrl = file.previewUrl ?? file.thumbnailUrl
  const fallbackId = `svn-${stableHash(file.path || file.id || file.name)}`
  const caption = file.name.replace(/\.[^.]+$/, '')
  const asset: Asset = matchedAsset ?? {
    id: file.assetId ?? file.id ?? fallbackId,
    caption,
    imageType: file.imageType ?? 'SVN 图片',
    sourceType: getStandardSourceTypes([file.sourceType, '网络资料'])[0] ?? '网络资料',
    referencePurpose: file.referencePurpose ?? '研究线索',
    tags: file.tags ?? ['SVN'],
    svnPath: file.path,
    tile: Number.parseInt(stableHash(file.path || file.name), 36) % 8,
    linkedItemId: 'svn-import',
    imageUrl: file.previewUrl ?? file.thumbnailUrl,
    thumbnailUrl: file.thumbnailUrl ?? file.previewUrl,
    sourceUrl,
  }

  return {
    id: asset.id,
    name: file.name,
    path: file.path,
    thumbnailUrl: file.thumbnailUrl ?? file.previewUrl,
    sizeLabel: file.sizeLabel ?? 'SVN 文件',
    asset,
  }
}

function isLikelyImagePath(value = '') {
  return /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i.test(normalizeSvnPath(value).split(/[?#]/)[0])
}

function createSvnPathAsset(value: string): Asset | undefined {
  const svnPath = normalizeSvnPath(value)
  if (!svnPath || !isRealSvnPath(svnPath) || !isLikelyImagePath(svnPath)) return undefined

  const fileName = svnPath.split('/').filter(Boolean).pop() ?? 'SVN 图片'
  const caption = fileName.replace(/\.[^.]+$/, '')
  const assetUrl = getSvnImageApiUrl(svnPath)

  return {
    id: `svn-path-${stableHash(svnPath.toLowerCase())}`,
    caption,
    imageType: 'SVN 图片',
    sourceType: '网络资料',
    referencePurpose: '研究线索',
    tags: ['SVN'],
    svnPath,
    tile: Number.parseInt(stableHash(svnPath), 36) % 8,
    linkedItemId: 'svn-import',
    imageUrl: assetUrl || undefined,
    thumbnailUrl: assetUrl || undefined,
    sourceUrl: assetUrl || undefined,
  }
}

function SvnPickerDialog({
  close,
  copyText,
  selectedAssetIds,
  onConfirm,
}: {
  close: () => void
  copyText: (text: string) => void
  selectedAssetIds: string[]
  onConfirm: (selectedAssets: Asset[]) => void
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>(selectedAssetIds)
  const [activeFolder, setActiveFolder] = useState(svnImageFolders[0])
  const [query, setQuery] = useState('')
  const [path, setPath] = useState('')
  const [didSubmitPath, setDidSubmitPath] = useState(false)
  const [pathInputOpen, setPathInputOpen] = useState(false)
  const [manualPathAssets, setManualPathAssets] = useState<Asset[]>([])
  const [files, setFiles] = useState<SvnPickerFile[]>([])
  const [folders, setFolders] = useState(svnImageFolders)
  const [totalFiles, setTotalFiles] = useState(0)
  const [indexedTotalFiles, setIndexedTotalFiles] = useState(0)
  const [isUsingSvnIndex, setIsUsingSvnIndex] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isUpdatingSvn, setIsUpdatingSvn] = useState(false)
  const [apiNotice, setApiNotice] = useState(
    svnApiBaseUrl ? '正在连接真实 SVN 图片服务' : '未配置 SVN 服务，无法选择 SVN 图片',
  )
  const gridRef = useRef<HTMLDivElement>(null)
  const selectionBaseIdsRef = useRef<string[]>([])
  const selectionStartedRef = useRef(false)
  const selectionBoxRef = useRef<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const suppressNextClickRef = useRef(false)
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const isConnected = Boolean(svnApiBaseUrl) && apiNotice === '已连接真实 SVN 图片服务'
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const visibleAssetIds = useMemo(() => files.map((file) => file.asset.id), [files])
  const allVisibleSelected = visibleAssetIds.length > 0 && visibleAssetIds.every((id) => selectedIdSet.has(id))
  const browserAssets = useMemo(() => files.map((file) => file.asset), [files])
  const normalizedPath = normalizeSvnPath(path)
  const matchedPathAsset = findAssetBySvnPath(path, [...browserAssets, ...manualPathAssets]) ?? createSvnPathAsset(path)
  const trimmedPath = normalizedPath
  const setAssetSelected = (assetId: string, shouldSelect: boolean) => {
    setSelectedIds((current) => {
      const alreadySelected = current.includes(assetId)
      if (shouldSelect && !alreadySelected) return [...current, assetId]
      if (!shouldSelect && alreadySelected) return current.filter((id) => id !== assetId)
      return current
    })
  }
  const toggleSelected = (assetId: string) => {
    setSelectedIds((current) =>
      current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId],
    )
  }
  const toggleVisibleSelection = () => {
    setSelectedIds((current) => {
      const visibleSet = new Set(visibleAssetIds)
      if (allVisibleSelected) return current.filter((id) => !visibleSet.has(id))
      const next = new Set(current)
      visibleAssetIds.forEach((id) => next.add(id))
      return [...next]
    })
  }
  const setActiveSelectionBox = (box: typeof selectionBox) => {
    selectionBoxRef.current = box
    setSelectionBox(box)
  }
  const getSelectionRect = (box: NonNullable<typeof selectionBox>) => {
    const left = Math.min(box.startX, box.currentX)
    const top = Math.min(box.startY, box.currentY)
    return {
      left,
      top,
      right: Math.max(box.startX, box.currentX),
      bottom: Math.max(box.startY, box.currentY),
      width: Math.abs(box.currentX - box.startX),
      height: Math.abs(box.currentY - box.startY),
    }
  }
  const applyMarqueeSelection = (box: NonNullable<typeof selectionBox>) => {
    if (!gridRef.current) return
    const selectionRect = getSelectionRect(box)
    const hitIds = Array.from(gridRef.current.querySelectorAll<HTMLElement>('.svn-file[data-asset-id]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left <= selectionRect.right && rect.right >= selectionRect.left && rect.top <= selectionRect.bottom && rect.bottom >= selectionRect.top
      })
      .map((element) => element.dataset.assetId)
      .filter(Boolean) as string[]
    const next = new Set(selectionBaseIdsRef.current)
    hitIds.forEach((assetId) => next.add(assetId))
    setSelectedIds([...next])
  }
  const addMatchedPathAsset = () => {
    setDidSubmitPath(true)
    if (!matchedPathAsset) return
    setManualPathAssets((current) =>
      current.some((asset) => asset.id === matchedPathAsset.id) ? current : [...current, matchedPathAsset],
    )
    setAssetSelected(matchedPathAsset.id, true)
    setPath(matchedPathAsset.svnPath)
  }
  const beginMarqueeSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !files.length || !isConnected) return
    selectionBaseIdsRef.current = selectedIds
    selectionStartedRef.current = false
    setActiveSelectionBox({ startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const updateMarqueeSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const currentBox = selectionBoxRef.current
    if (!currentBox) return
    const nextBox = { ...currentBox, currentX: event.clientX, currentY: event.clientY }
    const moved = Math.hypot(nextBox.currentX - nextBox.startX, nextBox.currentY - nextBox.startY)
    setActiveSelectionBox(nextBox)
    if (moved < 6 && !selectionStartedRef.current) return
    selectionStartedRef.current = true
    suppressNextClickRef.current = true
    applyMarqueeSelection(nextBox)
  }
  const finishPointerSelection = (event?: ReactPointerEvent<HTMLDivElement>) => {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const didMarqueeSelect = selectionStartedRef.current
    selectionBaseIdsRef.current = []
    selectionStartedRef.current = false
    setActiveSelectionBox(null)
    if (didMarqueeSelect) {
      window.setTimeout(() => {
        suppressNextClickRef.current = false
      }, 0)
    }
  }
  const selectableAssets = useMemo(() => {
    const entries = [...assets, ...files.map((file) => file.asset), ...manualPathAssets]
    return entries.reduce<Map<string, Asset>>((map, asset) => map.set(asset.id, asset), new Map())
  }, [files, manualPathAssets])
  const selectedAssets = selectedIds.map((id) => selectableAssets.get(id)).filter(Boolean) as Asset[]
  const loadSvnFiles = async () => {
    if (!svnApiBaseUrl) {
      setFiles([])
      setFolders(svnImageFolders)
      setTotalFiles(0)
      setIndexedTotalFiles(0)
      setIsUsingSvnIndex(false)
      setSelectedIds([])
      setApiNotice('未配置 SVN 服务，无法选择 SVN 图片')
      return
    }

    setIsLoading(true)
    try {
      const requestUrl = new URL(`${svnApiBaseUrl}/files`, window.location.origin)
      requestUrl.searchParams.set('path', activeFolder)
      if (query.trim()) requestUrl.searchParams.set('q', query.trim())

      const response = await fetch(requestUrl)
      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(errorPayload?.error ?? `SVN API ${response.status}`)
      }

      const payload = (await response.json()) as SvnApiResponse
      setFiles(payload.files.map(mapSvnApiFile))
      setFolders(payload.folders?.length ? payload.folders : svnImageFolders)
      setTotalFiles(payload.total ?? payload.files.length)
      setIndexedTotalFiles(payload.indexedTotal ?? 0)
      setIsUsingSvnIndex(Boolean(payload.indexed))
      setApiNotice(payload.indexed ? `已连接真实 SVN 图片服务，使用本地索引 ${payload.indexedTotal ?? payload.files.length} 个文件` : '已连接真实 SVN 图片服务')
    } catch (error) {
      console.error(error)
      setFiles([])
      setFolders(svnImageFolders)
      setTotalFiles(0)
      setIndexedTotalFiles(0)
      setIsUsingSvnIndex(false)
      setSelectedIds([])
      setApiNotice(`SVN 服务连接失败：${error instanceof Error ? error.message : '请检查后端代理'}`)
    } finally {
      setIsLoading(false)
    }
  }

  const updateSvnWorkingCopy = async () => {
    if (!svnApiBaseUrl || isUpdatingSvn) return

    setIsUpdatingSvn(true)
    setApiNotice('正在更新 SVN 图片库')
    try {
      const response = await fetch(`${svnApiBaseUrl}/update`, { method: 'POST' })
      const payload = (await response.json().catch(() => null)) as SvnUpdateResponse | null
      if (!response.ok) {
        throw new Error(payload?.error ?? `SVN update ${response.status}`)
      }

      const indexMessage = payload?.indexedFiles ? `，已索引 ${payload.indexedFiles} 个文件` : ''
      setApiNotice(payload?.revision ? `SVN 图片库已更新到 r${payload.revision}${indexMessage}` : `SVN 图片库已更新${indexMessage}`)
      await loadSvnFiles()
    } catch (error) {
      console.error(error)
      setApiNotice(`SVN 更新失败：${error instanceof Error ? error.message : '请检查 SVN 命令和认证'}`)
    } finally {
      setIsUpdatingSvn(false)
    }
  }

  useEffect(() => {
    loadSvnFiles()
  }, [activeFolder])

  useEffect(() => {
    const finishSelection = () => finishPointerSelection()
    window.addEventListener('pointerup', finishSelection)
    window.addEventListener('blur', finishSelection)
    return () => {
      window.removeEventListener('pointerup', finishSelection)
      window.removeEventListener('blur', finishSelection)
    }
  }, [])

  return (
    <div className="workflow-dialog-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog svn-dialog">
        <DialogHead title="从 SVN 选择图片" close={close} />
        <div className="svn-dialog-topbar">
          <p>选择 SVN 图片加入当前资料，原图仍保存在 SVN 中。</p>
          <div className="dialog-search svn-global-search">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') loadSvnFiles()
              }}
              placeholder="搜索文件名、标签、路径..."
            />
          </div>
        </div>
        <div className="svn-dialog-body">
          <aside className="svn-tree">
            <section className="svn-tree-section">
              <strong>目录</strong>
              {folders.map((folder) => (
                <button
                  type="button"
                  className={folder === activeFolder ? 'active' : ''}
                  key={folder}
                  onClick={() => setActiveFolder(folder)}
                >
                  <FolderOpen size={14} />
                  {folder}
                </button>
              ))}
            </section>
          </aside>
          <section className="svn-browser">
            <div className="svn-browser-head">
              <div>
                <span>当前路径</span>
                <strong>{activeFolder}</strong>
              </div>
              <em>共 {totalFiles} 个文件</em>
            </div>
            <div className="svn-browser-toolbar">
              <span>{isUsingSvnIndex ? `匹配 ${totalFiles} 个 / 索引 ${indexedTotalFiles} 个` : `共 ${totalFiles} 个文件`}</span>
              <label>
                图片类型
                <FancySelect
                  ariaLabel="图片类型"
                  options={[
                    { value: '全部', label: '全部' },
                    { value: '画像', label: '画像' },
                    { value: '复原', label: '复原' },
                  ]}
                />
              </label>
              <label>
                来源类型
                <FancySelect
                  ariaLabel="来源类型"
                  options={[{ value: '全部', label: '全部' }, ...sourceTypeOptions]}
                />
              </label>
              <button
                type="button"
                className="secondary-control svn-select-all-button"
                onClick={toggleVisibleSelection}
                disabled={!files.length || !isConnected}
              >
                {allVisibleSelected ? '取消本页全选' : '本页全选'}
              </button>
              <label>
                排序
                <FancySelect
                  ariaLabel="SVN 文件排序"
                  options={[
                    { value: '最近更新', label: '最近更新' },
                    { value: '文件', label: '文件' },
                  ]}
                />
              </label>
              <button type="button" className="secondary-control" onClick={loadSvnFiles} disabled={isLoading}>
                <RefreshCw size={16} />
                刷新
              </button>
              <button type="button" className="secondary-control svn-update-button" onClick={updateSvnWorkingCopy} disabled={!svnApiBaseUrl || isUpdatingSvn || isLoading}>
                <Download size={16} />
                {isUpdatingSvn ? '更新中' : '更新 SVN'}
              </button>
            </div>
            <div className={isConnected ? 'svn-api-status connected' : 'svn-api-status unavailable'}>
              {apiNotice}
              {svnApiBaseUrl ? <code>{svnApiBaseUrl}</code> : <code>VITE_SVN_API_BASE_URL 未配</code>}
            </div>
            {files.length ? (
              <div
                className={selectionBox ? 'svn-file-grid selecting' : 'svn-file-grid'}
                ref={gridRef}
                onPointerDown={beginMarqueeSelection}
                onPointerMove={updateMarqueeSelection}
                onPointerUp={finishPointerSelection}
                onPointerCancel={finishPointerSelection}
              >
                {files.map((file) => (
                  <button
                    type="button"
                    className={selectedIds.includes(file.asset.id) ? 'svn-file selected' : 'svn-file'}
                    key={file.id}
                    data-asset-id={file.asset.id}
                    onClick={() => {
                      if (suppressNextClickRef.current) {
                        suppressNextClickRef.current = false
                        return
                      }
                      toggleSelected(file.asset.id)
                    }}
                    title={file.path}
                  >
                    <b aria-hidden="true">{selectedIds.includes(file.asset.id) ? <Check size={15} /> : null}</b>
                    {file.thumbnailUrl || file.asset.imageUrl ? (
                      <AssetThumb asset={file.asset} />
                    ) : (
                      <span className="svn-file-placeholder">
                        <ImageIcon size={30} />
                      </span>
                    )}
                    {selectedIds.includes(file.asset.id) && <em>已选</em>}
                    <span>{file.name}</span>
                    <small>{file.path}</small>
                  </button>
                ))}
                {selectionBox && (() => {
                  const gridRect = gridRef.current?.getBoundingClientRect()
                  if (!gridRect) return null
                  const rect = getSelectionRect(selectionBox)
                  return (
                    <span
                      className="svn-selection-box"
                      style={{
                        left: `${rect.left - gridRect.left}px`,
                        top: `${rect.top - gridRect.top}px`,
                        width: `${rect.width}px`,
                        height: `${rect.height}px`,
                      }}
                    />
                  )
                })()}
              </div>
            ) : (
              <div className="svn-empty-state">
                <ImageIcon size={34} />
                <strong>{isLoading ? '正在加载 SVN 图片' : '没有可选择的 SVN 图片'}</strong>
                <p>
                  {svnApiBaseUrl
                    ? '真实 SVN 服务当前没有返回图片，或连接失败。'
                    : '请先配置 VITE_SVN_API_BASE_URL，并启动能读取 SVN 的后端代理服务。'}
                </p>
              </div>
            )}
            {files.length > 0 && (
              <div className="dialog-pagination">
                <ChevronRight size={15} className="pager-prev-icon" />
                <span className="active">1</span>
                <ChevronRight size={15} />
              </div>
            )}
          </section>
          <aside className="svn-selected">
            <div className="svn-selected-head">
              <strong>已选图片 {selectedAssets.length} 张</strong>
              <button type="button" onClick={() => setSelectedIds([])} disabled={!selectedAssets.length}>
                清空
              </button>
            </div>
            {selectedAssets.length ? (
              selectedAssets.map((asset) => (
                <article key={asset.id}>
                  <AssetThumb asset={asset} />
                  <span>
                    <strong>{asset.caption}.jpg</strong>
                    <small>{asset.svnPath}</small>
                  </span>
                  <button type="button" aria-label="移除" onClick={() => toggleSelected(asset.id)}>
                    <X size={14} />
                  </button>
                </article>
              ))
            ) : (
              <div className="svn-selected-empty">
                <ImageIcon size={24} />
                <strong>尚未选择图片</strong>
                <p>从中间列表勾选图片后，会显示在这里。</p>
              </div>
            )}
            <section className={pathInputOpen ? 'svn-inline-path open' : 'svn-inline-path'}>
              <button type="button" className="svn-inline-toggle" onClick={() => setPathInputOpen((open) => !open)}>
                <Link2 size={14} />
                通过 SVN 路径添加
                <ChevronDown size={14} />
              </button>
              {pathInputOpen && (
                <>
                  <div className="svn-path-input">
                    <input
                      value={path}
                      onChange={(event) => {
                        setPath(event.target.value)
                        setDidSubmitPath(false)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') addMatchedPathAsset()
                      }}
                      placeholder="/Costume/ThreeKingdoms/..."
                    />
                    <button type="button" aria-label="复制路径" onClick={() => copyText(trimmedPath)} disabled={!trimmedPath}>
                      <Copy size={15} />
                    </button>
                  </div>
                  <div className={matchedPathAsset ? 'svn-inline-path-match success' : didSubmitPath || trimmedPath ? 'svn-inline-path-match failed' : 'svn-inline-path-match'}>
                    {matchedPathAsset ? (
                      <>
                        <Check size={14} />
                        <span>{matchedPathAsset.caption}</span>
                      </>
                    ) : (
                      <>
                        <Link2 size={14} />
                        <span>{trimmedPath ? '未匹配到已入库图片' : '粘贴路径后添加到已选'}</span>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="secondary-control svn-inline-path-add"
                    onClick={addMatchedPathAsset}
                    disabled={!matchedPathAsset}
                  >
                    加入已选
                  </button>
                </>
              )}
            </section>
          </aside>
        </div>
        <DialogFoot
          close={close}
          primary={`确认选择 (${selectedAssets.length})`}
          disabled={!selectedAssets.length || !isConnected}
          onPrimary={() => onConfirm(selectedAssets)}
        />
      </section>
    </div>
  )
}

function normalizeSvnPath(value: string) {
  return value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
}

function findAssetBySvnPath(value: string, extraAssets: Asset[] = []) {
  const normalized = normalizeSvnPath(value).toLowerCase()
  if (!normalized) return undefined

  return [...assets, ...extraAssets].find((asset) =>
    [asset.svnPath, asset.sourceUrl, asset.imageUrl, asset.thumbnailUrl]
      .filter(Boolean)
      .some((candidate) => normalizeSvnPath(candidate ?? '').toLowerCase() === normalized),
  )
}

function AddSourceDialog({
  close,
  copyText,
  notify,
}: {
  close: () => void
  copyText: (text: string) => void
  notify: (message: string) => void
}) {
  const sourceRecordKey = 'three-kingdoms-art-archive:source-records'
  const referenceOptions = [
    { value: '史实依据', label: '史实依据' },
    { value: '复原参考', label: '复原参考' },
    { value: '设计转化参考', label: '设计转化参考' },
    { value: '研究线索', label: '研究线索' },
  ]
  const usageOptions = [
    ...standardUsageHintOptions.map((option) => ({ value: option, label: option })),
  ]
  const [sourceType, setSourceType] = useState('史料典籍')
  const [referencePurpose, setReferencePurpose] = useState('史实依据')
  const [usageHint, setUsageHint] = useState('造型参考')
  const [title, setTitle] = useState('后汉书 · 舆服志')
  const [url, setUrl] = useState('https://ctext.org/hou-han-shu/yu-fu-zhi')
  const [detail, setDetail] = useState('后汉书 · 舆服志 / 卷五十九 / 页 123')
  const [author, setAuthor] = useState('范晔 / 中华书局')
  const [note, setNote] = useState('记录东汉时期官服制度、冠服形制等内容。')
  const [saveStatus, setSaveStatus] = useState<{ tone: 'idle' | 'success' | 'error'; message: string }>({
    tone: 'idle',
    message: '填写来源后点击保存，会先记录到当前浏览器。',
  })
  const [isSaving, setIsSaving] = useState(false)
  const sourcePayload = {
    id: `source-${Date.now()}`,
    sourceType,
    referencePurpose,
    usageHint,
    title: title.trim(),
    url: url.trim(),
    detail: detail.trim(),
    author: author.trim(),
    note: note.trim(),
    savedAt: new Date().toISOString(),
  }
  const canSaveSource = Boolean(sourcePayload.title && sourcePayload.url)

  const saveSource = () => {
    if (!canSaveSource) {
      const message = '请先填写来源名称和链接'
      setSaveStatus({ tone: 'error', message })
      notify(message)
      return
    }

    try {
      setIsSaving(true)
      setSaveStatus({ tone: 'idle', message: '正在保存来源...' })
      const raw = window.localStorage.getItem(sourceRecordKey)
      const records = raw ? JSON.parse(raw) : []
      const nextRecords = Array.isArray(records) ? [sourcePayload, ...records] : [sourcePayload]
      window.localStorage.setItem(sourceRecordKey, JSON.stringify(nextRecords))
      const message = '来源已保存'
      setSaveStatus({ tone: 'success', message })
      notify(message)
      window.setTimeout(close, 500)
    } catch (error) {
      const message = `来源保存失败：${error instanceof Error ? error.message : '浏览器本地存储不可用'}`
      setSaveStatus({ tone: 'error', message })
      notify(message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="workflow-dialog-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog source-dialog">
        <DialogHead title="添加来源" close={close} />
        <div className="source-form-grid">
          <div className="source-select-row">
            <label>
              <span className="source-field-label">
                来源类型
                <em>*</em>
              </span>
              <FancySelect ariaLabel="来源类型" value={sourceType} options={sourceTypeOptions} onChange={setSourceType} />
            </label>
            <label>
              <span className="source-field-label">
                参考性质
                <em>*</em>
              </span>
              <FancySelect ariaLabel="参考性质" value={referencePurpose} options={referenceOptions} onChange={setReferencePurpose} />
            </label>
            <label>
              <span className="source-field-label">
                使用用途
                <em>*</em>
              </span>
              <FancySelect ariaLabel="使用用途" value={usageHint} options={usageOptions} onChange={setUsageHint} />
            </label>
          </div>

          <label className="source-field-row">
            <span className="source-field-label">
              来源名称 / 标题
              <em>*</em>
            </span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="source-field-row">
            <span className="source-field-label">
              链接
              <em>*</em>
            </span>
            <span className="source-link-input">
              <input value={url} onChange={(event) => setUrl(event.target.value)} />
              <button type="button" aria-label="复制链接" onClick={() => copyText(url)} disabled={!url.trim()}>
                <Link2 size={18} />
              </button>
            </span>
          </label>
          <label className="source-field-row">
            <span className="source-field-label">书名 / 篇章 / 页码</span>
            <input value={detail} onChange={(event) => setDetail(event.target.value)} />
          </label>
          <label className="source-field-row">
            <span className="source-field-label">作者 / 平台</span>
            <input value={author} onChange={(event) => setAuthor(event.target.value)} />
          </label>
          <label className="source-field-row source-note-row">
            <span className="source-field-label">备注</span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
        </div>
        <div className={`source-save-status ${saveStatus.tone}`} role="status" aria-live="polite">
          {saveStatus.message}
        </div>
        <footer className="workflow-dialog-foot">
          <button type="button" className="secondary-control" onClick={close}>
            取消
          </button>
          <button type="button" onClick={saveSource} disabled={isSaving}>
            <Save size={16} />
            {isSaving ? '保存中' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function TagPickerDialog({ close }: { close: () => void }) {
  const [selectedTags, setSelectedTags] = useState(['东汉', '文官', '袍服', '史实依据'])
  const toggleTag = (tag: string) => {
    setSelectedTags((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]))
  }
  const tagGroups = [
    ['常用标签', ['文官', '袍服', '冠帽', '东汉', '画像', '拓本']],
    ['系统标签', ['服饰', '器物', '建筑', '书籍', '壁画', '陶俑']],
    ['自定义标', ['礼制研究', '服饰细节', '色彩参']],
  ]

  return (
    <div className="workflow-dialog-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog tag-dialog">
        <DialogHead title="选择标签" close={close} />
        <div className="tag-dialog-grid">
          <section>
            <div className="dialog-search">
              <Search size={17} />
              <input placeholder="搜索标签..." />
            </div>
            {tagGroups.map(([title, tags]) => (
              <div className="tag-group" key={title as string}>
                <h3>{title as string}</h3>
                <div>
                  {(tags as string[]).map((tag) => (
                    <button
                      type="button"
                      className={selectedTags.includes(tag) ? 'selected' : ''}
                      key={tag}
                      onClick={() => toggleTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
          <aside>
            <h3>已选标签 ({selectedTags.length})</h3>
            <div className="selected-tag-list">
              {selectedTags.map((tag) => (
                <button type="button" key={tag} onClick={() => toggleTag(tag)}>
                  {tag}
                  <X size={13} />
                </button>
              ))}
            </div>
            <h3>新建标签</h3>
            <label>
              标签名称
              <input placeholder="输入新标签名..." />
            </label>
            <label>
              标签类型
              <FancySelect
                ariaLabel="标签类型"
                options={[
                  { value: '自定义标', label: '自定义标' },
                  { value: '系统标签', label: '系统标签' },
                ]}
              />
            </label>
            <button type="button">
              <Plus size={16} />
              添加
            </button>
          </aside>
        </div>
        <DialogFoot close={close} primary={`确定 (${selectedTags.length})`} />
      </section>
    </div>
  )
}

function SyncStatusDialog({
  close,
  startNewItem,
  notify,
}: {
  close: () => void
  startNewItem: () => void
  notify: (message: string) => void
}) {
  const statuses = [
    {
      icon: CloudOff,
      title: '同步失败',
      body: '无法连接 SVN 服务器，请检查网络或稍后重试',
      action: '重试',
      onAction: () => notify('已重新发起 SVN 连接检查'),
    },
    {
      icon: FolderOpen,
      title: '文件不存在',
      body: '该文件在 SVN 中不存在，可能已被移动或删除',
      action: '刷新列表',
      onAction: () => notify('已刷新当前 SVN 文件列表'),
    },
    {
      icon: BookOpen,
      title: '无预览图',
      body: '该文件暂无可用预览，可下载后查看',
      action: '新建资料',
      onAction: startNewItem,
    },
    { icon: RefreshCw, title: '正在同步', body: '图片正在从 SVN 同步中，请稍候', action: '' },
    {
      icon: AlertTriangle,
      title: '缩略图生成失败',
      body: '生成缩略图失败，请稍后重试',
      action: '重试生成',
      onAction: () => notify('已重新加入缩略图生成队列'),
    },
    {
      icon: Lock,
      title: '权限不足',
      body: '没有访问该目录的权限，请联系管理员',
      action: '复制说明',
      onAction: () => notify('已生成权限申请说明'),
    },
  ]

  return (
    <div className="workflow-dialog-overlay sync-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog sync-dialog">
        <DialogHead title="SVN 图片同步状态" close={close} />
        <div className="sync-card-grid">
          {statuses.map(({ icon: Icon, title, body, action, onAction }) => (
            <article className="sync-card" key={title}>
              <Icon size={48} />
              <h3>{title}</h3>
              <p>{body}</p>
              {action ? (
                <button type="button" className="secondary-control" onClick={onAction}>
                  {action}
                </button>
              ) : (
                <span className="sync-spinner" />
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function DialogHead({ title, close }: { title: string; close: () => void }) {
  return (
    <header className="workflow-dialog-head">
      <h2>{title}</h2>
      <button type="button" className="close-button" onClick={close} aria-label="关闭">
        <X size={19} />
      </button>
    </header>
  )
}

function DialogFoot({
  close,
  primary,
  icon,
  onPrimary,
  disabled = false,
}: {
  close: () => void
  primary: string
  icon?: ReactNode
  onPrimary?: () => void
  disabled?: boolean
}) {
  return (
    <footer className="workflow-dialog-foot">
      <button type="button" className="secondary-control" onClick={close}>
        取消
      </button>
      <button type="button" onClick={onPrimary ?? close} disabled={disabled}>
        {icon}
        {primary}
      </button>
    </footer>
  )
}

function DuplicateArchiveDialog({
  duplicate,
  close,
  openExisting,
  continueSave,
}: {
  duplicate: ArchiveDuplicateMatch
  close: () => void
  openExisting: (itemId: string) => void
  continueSave: () => void
}) {
  return (
    <div className="workflow-dialog-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog duplicate-dialog">
        <DialogHead title="疑似已存在相同资料" close={close} />
        <div className="confirm-dialog-body">
          <AlertTriangle size={26} />
          <div>
            <h3>已存在：{duplicate.title}</h3>
            <p>{duplicate.reason}</p>
            <Info label="创建时间" value={duplicate.createdAt?.slice(0, 10) || '未知'} />
            <Info label="创建人" value={duplicate.createdBy || '未知'} />
          </div>
        </div>
        <footer className="workflow-dialog-foot">
          <button type="button" className="secondary-control" onClick={() => openExisting(duplicate.id)}>
            查看已有资料
          </button>
          <button type="button" onClick={continueSave}>
            继续保存为新资料
          </button>
        </footer>
      </section>
    </div>
  )
}

const feedbackTypeOptions = ['信息错误', '图片问题', '分类不准', '来源问题', '补充建议']

function FeedbackDialog({
  item,
  pageUrl,
  createdBy,
  close,
  notify,
  onSubmitted,
}: {
  item: CollectionItem
  pageUrl: string
  createdBy: string
  close: () => void
  notify: (message: string) => void
  onSubmitted: () => Promise<void>
}) {
  const [feedbackType, setFeedbackType] = useState(feedbackTypeOptions[0])
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sourceUrl = item.sourceUrl || ''

  const submitFeedback = async () => {
    if (!message.trim() || submitting) return

    setSubmitting(true)
    try {
      await submitArchiveFeedback({
        itemId: item.id,
        itemTitle: item.title,
        feedbackType,
        message,
        pageUrl,
        sourceUrl,
        createdBy,
      })
      notify('反馈已提交')
      void onSubmitted()
      close()
    } catch (error) {
      notify(error instanceof Error ? error.message : '反馈提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="workflow-dialog-overlay feedback-dialog-overlay" role="dialog" aria-modal="true">
      <section className="workflow-dialog feedback-dialog">
        <DialogHead title="反馈资料问题" close={close} />
        <div className="feedback-dialog-body">
          <div className="feedback-target">
            <span>反馈对象</span>
            <strong>{item.title}</strong>
            <p>{pageUrl}</p>
          </div>
          <div className="feedback-type-grid" role="group" aria-label="反馈类型">
            {feedbackTypeOptions.map((option) => (
              <button
                type="button"
                key={option}
                className={feedbackType === option ? 'active' : ''}
                onClick={() => setFeedbackType(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <label className="feedback-message-field">
            <span>反馈说明</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="例如：这条资料分类应为壁画图像；第 2 张图片不是该墓葬；来源链接需要核实..."
            />
          </label>
        </div>
        <DialogFoot
          close={close}
          primary={submitting ? '提交中' : '提交反馈'}
          icon={<MessageSquare size={17} />}
          onPrimary={submitFeedback}
          disabled={!message.trim() || submitting}
        />
      </section>
    </div>
  )
}

function Timeline({
  items,
  openDetail,
  setLightboxAsset,
}: {
  items: CollectionItem[]
  openDetail: (id: string) => void
  setLightboxAsset: (asset: Asset) => void
}) {
  const [timelineFilters, setTimelineFilters] = useState<TimelineQuery>(defaultTimelineFilters)
  const activeTimelineTopic =
    timelineTopicOptions.find((topic) => topic.key === timelineFilters.topicCategory) ?? timelineTopicOptions[0]
  const timelineResponse = useMemo(() => buildTimelineResponse(timelineFilters, items), [items, timelineFilters])
  const displayTimelineGroups = useMemo(() => buildTimelineDisplayGroups(timelineResponse), [timelineResponse])
  const defaultSelectedItemId = timelineResponse.defaultSelectedItemId ?? displayTimelineGroups[0]?.featuredItem?.id
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(defaultSelectedItemId)
  const requestedSelectedItem = findTimelineCardById(displayTimelineGroups, selectedItemId)
  const selectedItem = requestedSelectedItem ?? findTimelineCardById(displayTimelineGroups, defaultSelectedItemId)
  const selectedRecord = selectedItem ? items.find((item) => item.id === selectedItem.id) ?? collectionItems.find((item) => item.id === selectedItem.id) : undefined
  const selectedCover = selectedItem ? getItemCover(selectedItem.id) : undefined
  const selectedPeriodMeta = selectedItem
    ? [selectedItem.period, formatTimelineLabel(selectedItem)].filter(Boolean).join(' · ')
    : ''
  const selectedRepresentativeNote =
    selectedRecord?.shortNote ??
    selectedItem?.summary ??
    '该类图像资料虽细节有限，但来源清晰，可用于判断人物服饰轮廓、形制特征与时代氛围，并需与其他资料交叉验证。'
  const rangeKey = getTimelineRangeKey(timelineFilters)
  const activeRangeLabel = timelinePeriodRanges.find((range) => getTimelineRangeKey(range) === rangeKey)?.label ?? '全部时代'
  const hasTimelineCards = displayTimelineGroups.some((group) => group.featuredItem)
  const representativeCount = displayTimelineGroups.filter((group) => group.featuredItem).length
  const resetTimelineFilters = () => setTimelineFilters({ topicCategory: activeTimelineTopic.key })
  const clearTimelineNarrowFilters = () =>
    setTimelineFilters((current) => ({
      topicCategory: current.topicCategory,
      topicKeyword: undefined,
      identityType: undefined,
      periodStart: undefined,
      periodEnd: undefined,
    }))
  const emptyTimelineSummary = [
    `类别：${getTimelineTopicLabel(timelineFilters.topicCategory)}`,
    activeTimelineTopic.keywords.length > 0 ? `${activeTimelineTopic.filterLabel}：${timelineFilters.topicKeyword ?? '全部'}` : '',
    activeTimelineTopic.showIdentityFilter ? `身份：${timelineFilters.identityType ?? '全部'}` : '',
    `时代：${activeRangeLabel}`,
  ].filter(Boolean)

  useEffect(() => {
    if (!defaultSelectedItemId) return
    if (!findTimelineCardById(displayTimelineGroups, selectedItemId)) {
      setSelectedItemId(defaultSelectedItemId)
    }
  }, [defaultSelectedItemId, displayTimelineGroups, selectedItemId])

  return (
    <main className="timeline-page">
      <section className="timeline-intro">
        <div>
          <span className="timeline-kicker">Chronology Index</span>
          <h1>{timelineIntroTitle}</h1>
          <p>{timelineIntroDescription}</p>
        </div>
      </section>

      <section className="timeline-toolbar" aria-label="时间线工具栏">
        <div className="timeline-topic-switcher" aria-label="时间线类别">
          {timelineTopicOptions.map((topic) => (
            <button
              type="button"
              key={topic.key}
              className={topic.key === activeTimelineTopic.key ? 'active' : ''}
              onClick={() =>
                setTimelineFilters((current) => ({
                  topicCategory: topic.key,
                  topicKeyword: undefined,
                  periodStart: current.periodStart,
                  periodEnd: current.periodEnd,
                  identityType: topic.showIdentityFilter ? current.identityType : undefined,
                }))
              }
            >
              <span>{topic.label}</span>
            </button>
          ))}
        </div>

        <div className="timeline-filter-bar" aria-label="时间线筛选">
          {activeTimelineTopic.keywords.length > 0 && (
            <label>
              <span>{activeTimelineTopic.filterLabel}</span>
              <FancySelect
                ariaLabel={activeTimelineTopic.filterLabel}
                value={timelineFilters.topicKeyword ?? ''}
                onChange={(nextValue) => setTimelineFilters((current) => ({ ...current, topicKeyword: nextValue || undefined }))}
                options={[
                  { value: '', label: '全部' },
                  ...activeTimelineTopic.keywords.map((keyword) => ({ value: keyword, label: keyword })),
                ]}
              />
            </label>
          )}
          {activeTimelineTopic.showIdentityFilter && (
          <label>
            <span>身份</span>
            <FancySelect
              ariaLabel="身份"
              value={timelineFilters.identityType ?? ''}
              onChange={(nextValue) => setTimelineFilters((current) => ({ ...current, identityType: nextValue || undefined }))}
              options={[
                { value: '', label: '全部' },
                ...filterGroups.identityTypes.map((identity) => ({ value: identity, label: identity })),
              ]}
            />
          </label>
          )}
          <label className="timeline-filter-range">
            <span>时代</span>
            <FancySelect
              ariaLabel="时代"
              value={rangeKey}
              onChange={(nextValue) => {
                const range = timelinePeriodRanges.find((item) => getTimelineRangeKey(item) === nextValue)
                setTimelineFilters((current) => ({
                  ...current,
                  periodStart: range?.periodStart,
                  periodEnd: range?.periodEnd,
                }))
              }}
              options={timelinePeriodRanges.map((range) => ({ value: getTimelineRangeKey(range), label: range.label }))}
            />
          </label>
          <button type="button" className="timeline-reset" onClick={resetTimelineFilters}>
            <RotateCcw size={16} />
            重置
          </button>
        </div>
      </section>

      {hasTimelineCards && (
        <section className="timeline-result-summary" aria-label="时间线展示说明">
          <span>
            主轴按时代展示 <strong>{representativeCount}</strong> 张代表卡。
          </span>
          <small>全部类别会汇总各类资料，并在东汉、东汉末、魏、蜀、吴、西晋初各选 1 张代表卡。</small>
        </section>
      )}

      {!hasTimelineCards && (
        <section className="timeline-filter-feedback timeline-filter-feedback-empty" aria-live="polite">
          <div>
            <strong>当前筛选没有匹配到代表资料</strong>
            <p>{emptyTimelineSummary.join(' · ')}</p>
          </div>
          <div>
            {(timelineFilters.topicKeyword || timelineFilters.identityType || timelineFilters.periodStart || timelineFilters.periodEnd) && (
              <button type="button" className="secondary-control" onClick={clearTimelineNarrowFilters}>
                清空当前筛选
              </button>
            )}
            <button type="button" className="secondary-control" onClick={resetTimelineFilters}>
              重置到当前类别
            </button>
          </div>
        </section>
      )}

      {hasTimelineCards ? (
        <>
          <section className="timeline-axis-shell" aria-label="时间线节点">
            <div className="timeline-axis">
              {displayTimelineGroups.map((group) => {
                const featuredItem = group.featuredItem
                const cover = featuredItem ? getItemCover(featuredItem.id) : assets[0]

                return (
                  <article
                    className={featuredItem?.id === selectedItem?.id ? 'timeline-node active' : 'timeline-node'}
                    key={group.periodKey}
                  >
                    <button
                      type="button"
                      className="period-node"
                      onClick={() => featuredItem && setSelectedItemId(featuredItem.id)}
                    >
                      <span>{group.label}</span>
                      {timelinePeriodLabels[group.periodKey] && <small>{timelinePeriodLabels[group.periodKey]}</small>}
                      <i />
                    </button>
                    {featuredItem && (
                      <button
                        type="button"
                        className="timeline-card"
                        title={`查看资料：${featuredItem.title}`}
                        onClick={() => openDetail(featuredItem.id)}
                      >
                        <AssetThumb asset={cover} />
                        <span className="timeline-card-body">
                          <strong>{featuredItem.title}</strong>
                          <em>{formatTimelineLabel(featuredItem)}</em>
                          <small>{featuredItem.summary}</small>
                          <TagRow tags={featuredItem.tags.slice(0, 2)} />
                        </span>
                      </button>
                    )}
                  </article>
                )
              })}
            </div>
          </section>

          {selectedItem && selectedCover && (
            <section className="timeline-detail-panel">
              <button type="button" className="timeline-detail-image" onClick={() => setLightboxAsset(selectedCover)}>
                <AssetThumb asset={selectedCover} />
                <span className="timeline-detail-image-hint">
                  <Search size={15} />
                  查看大图
                </span>
              </button>
              <div className="timeline-detail-copy">
                <span className="timeline-detail-kicker">当前代表资料</span>
                <div className="timeline-detail-title">
                  <h2>{selectedItem.title}</h2>
                </div>
                <span className="timeline-detail-time">{selectedPeriodMeta}</span>
                <p>{selectedRepresentativeNote}</p>
                <div className="timeline-detail-meta-grid">
                  <div className="timeline-detail-meta">
                    <span>参考用途</span>
                    <TagRow tags={selectedItem.referencePurposes.slice(0, 3)} />
                  </div>
                  <div className="timeline-detail-meta">
                    <span>来源</span>
                    <p>{selectedRecord?.sourceTypes.slice(0, 2).join(' · ') ?? '内部整理'}</p>
                  </div>
                </div>
                <div className="timeline-detail-actions">
                  <button type="button" className="timeline-open-button" onClick={() => openDetail(selectedItem.id)}>
                    查看资料
                    <ChevronRight size={18} />
                  </button>
                  <button type="button" className="secondary-control timeline-image-button" onClick={() => setLightboxAsset(selectedCover)}>
                    查看大图
                    <Search size={16} />
                  </button>
                </div>
              </div>
            </section>
          )}
        </>
      ) : (
        <section className="timeline-empty empty-results">
          <Clock3 size={26} />
          <h2>没有符合条件的时间线条目</h2>
          <p>当前组合下没有可作为时间线代表资料的条目。可以先放宽细分、身份或时代范围，再继续查看。</p>
          <div>
            {(timelineFilters.topicKeyword || timelineFilters.identityType || timelineFilters.periodStart || timelineFilters.periodEnd) && (
              <button type="button" className="secondary-control" onClick={clearTimelineNarrowFilters}>
                清空当前筛选
              </button>
            )}
            <button type="button" className="secondary-control" onClick={resetTimelineFilters}>
              重置到当前类别
            </button>
          </div>
        </section>
      )}
    </main>
  )
}

function Detail({
  item,
  bookSources,
  bookPages,
  setLightboxAsset,
  setView,
  canEdit,
  editItem,
  openDetail,
  copyText,
  openSvnPath,
  notify,
  createdBy,
  onFeedbackSubmitted,
}: {
  item: CollectionItem
  bookSources: BookSource[]
  bookPages: BookPage[]
  setLightboxAsset: (asset: Asset) => void
  setView: (view: View) => void
  canEdit: boolean
  editItem: () => void
  openDetail: (itemId: string) => void
  copyText: (text: string) => Promise<boolean>
  openSvnPath: (path: string) => void | Promise<unknown>
  notify: (message: string) => void
  createdBy: string
  onFeedbackSubmitted: () => Promise<void>
}) {
  const [shareLinkOpen, setShareLinkOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [activeAssetId, setActiveAssetId] = useState(item.imageIds[0] ?? '')

  useEffect(() => {
    setShareLinkOpen(false)
    setFeedbackOpen(false)
    setActiveAssetId(item.imageIds[0] ?? '')
  }, [item.id, item.imageIds.join('|')])

  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back()
      return
    }
    setView('library')
  }

  const itemAssets = getItemAssets(item)
  const activeAssetIndex = Math.max(0, itemAssets.findIndex((asset) => asset.id === activeAssetId))
  const primaryAsset = itemAssets[activeAssetIndex] ?? itemAssets[0]
  const goDetailAsset = (direction: -1 | 1) => {
    if (itemAssets.length < 2) return
    const nextIndex = (activeAssetIndex + direction + itemAssets.length) % itemAssets.length
    setActiveAssetId(itemAssets[nextIndex].id)
  }
  const primarySvnPath = primaryAsset && isRealSvnPath(primaryAsset.svnPath) ? primaryAsset.svnPath : ''
  const primaryPlaceholderSvnPath = primaryAsset && isPlaceholderSvnPath(primaryAsset.svnPath) ? primaryAsset.svnPath : ''
  const primarySourceUrl = primaryAsset ? getAssetSourceUrl(primaryAsset) : ''
  const primaryLocalCacheUrl = primaryAsset?.imageUrl?.startsWith('/web-clips/') ? resolveLocalAssetUrl(primaryAsset.imageUrl) : ''
  const isWebCollectedItem = item.tags.some((tag) => tag.includes('网页') || tag.toLowerCase().includes('web')) || item.sourceTypes.some((source) => source.includes('网页'))
  const archiveStatusLabel = primarySvnPath ? '已归档' : '待归档'
  const detailUrl = getArchiveDetailUrl(item)
  const archiveCode = getArchiveItemCode(item)
  const detailSupportNote = getDetailSupportNote(item)
  const bookSourceRefs = (item.sourceRefs ?? []).map((ref) => {
    const source = bookSources.find((entry) => entry.id === ref.sourceId)
    const pages = (ref.pageIds ?? [])
      .map((pageId) => bookPages.find((page) => page.id === pageId))
      .filter(Boolean) as BookPage[]
    return { ref, source, pages }
  })
  const shareItem = async () => {
    setShareLinkOpen(true)
    await copyText(detailUrl)
  }
  const sourceRows = [
    {
      icon: BookOpen,
      title: '文献与馆',
      body: item.sourceTypes.includes('现代书籍') ? '记录时代名词、服制描述与后世整理线索' : '用于校对名词、年代与制度背景',
      badge: '古籍正史',
    },
    {
      icon: Grid3X3,
      title: '图像与出土资料',
      body: '对照画像砖、陶俑与馆藏图像，确认人物轮廓和冠服关系',
      badge: item.referencePurposes.includes('史实依据') ? '史实依据' : '图像依据',
    },
    {
      icon: Layers3,
      title: '现代复原参',
      body: '结合复原图与结构线稿，辅助理解穿搭层次和材质转化',
      badge: '复原参',
    },
  ]
  const relatedMatches = collectionItems
    .filter(isArchiveItemVisible)
    .filter((entry) => entry.id !== item.id)
    .filter(
      (entry) =>
        entry.period === item.period ||
        entry.costumeCategories.some((category) => item.costumeCategories.includes(category)) ||
        entry.identityTypes.some((identity) => item.identityTypes.includes(identity)),
    )
  const relatedItems = [
    ...relatedMatches,
    ...collectionItems
      .filter(isArchiveItemVisible)
      .filter((entry) => entry.id !== item.id && !relatedMatches.some((match) => match.id === entry.id)),
  ]
    .slice(0, 3)

  return (
    <main className="detail-page">
      <section className="detail-head">
        <div className="detail-title-block">
          <button type="button" className="detail-back-button secondary-control" onClick={goBack}>
            <ChevronRight size={17} />
            返回
          </button>
          <div className="detail-breadcrumb">
            <button type="button" className="back-link" onClick={() => setView('library')}>
              资料库
            </button>
            <span>/</span>
            <span>{item.title}</span>
          </div>
          <h1>{item.title}</h1>
          <button type="button" className="archive-code-pill detail-code-pill" onClick={() => copyText(archiveCode)} aria-label={`复制资料编码 ${archiveCode}`}>
            <Copy size={14} />
            {archiveCode}
          </button>
          <p className="detail-summary">{item.summary}</p>
          <TagRow tags={[getItemType(item), item.period, ...item.identityTypes, ...getItemCategories(item)].slice(0, 8)} />
        </div>
        <div className="detail-actions">
          {canEdit && (
            <button type="button" className="edit-button secondary-control" onClick={editItem}>
              <FilePenLine size={17} />
              编辑
            </button>
          )}
          <div className="detail-share-wrap">
            <button type="button" className="detail-share-button secondary-control" onClick={shareItem}>
              <Share2 size={17} />
              分享
            </button>
            {shareLinkOpen && (
              <div className="detail-share-popover" role="status">
                <div className="detail-share-popover-head">
                  <span>分享链接</span>
                  <button type="button" className="icon-button" aria-label="关闭分享链接" onClick={() => setShareLinkOpen(false)}>
                    <X size={15} />
                  </button>
                </div>
                <input
                  value={detailUrl}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="资料分享链接"
                />
                <button type="button" className="detail-share-copy secondary-control" onClick={() => copyText(detailUrl)}>
                  <Copy size={15} />
                  复制链接
                </button>
              </div>
            )}
          </div>
          <button type="button" className="detail-feedback-button secondary-control" onClick={() => setFeedbackOpen(true)}>
            <MessageSquare size={17} />
            反馈
          </button>
        </div>
      </section>
      {feedbackOpen && typeof document !== 'undefined' && createPortal(
        <FeedbackDialog
          item={item}
          pageUrl={detailUrl}
          createdBy={createdBy}
          close={() => setFeedbackOpen(false)}
          notify={notify}
          onSubmitted={onFeedbackSubmitted}
        />,
        document.body,
      )}

      <section className={isWebCollectedItem ? 'detail-content-grid collected-detail-grid' : 'detail-content-grid'}>
        <div className="detail-main-column">
          <section className={isWebCollectedItem ? 'gallery-panel collected-gallery-panel' : 'gallery-panel'}>
            {isWebCollectedItem && (
              <div className="collected-gallery-head">
                <span>{itemAssets.length ? `${activeAssetIndex + 1} / ${itemAssets.length}` : '0 / 0'}</span>
                <em>{archiveStatusLabel}</em>
              </div>
            )}
            {primaryAsset && (
              <div className="main-image-frame">
                {itemAssets.length > 1 && (
                  <button type="button" className="detail-gallery-nav prev" onClick={() => goDetailAsset(-1)} aria-label="上一张图片">
                    <ChevronRight size={22} />
                  </button>
                )}
                <button type="button" className="main-image" onClick={() => setLightboxAsset(primaryAsset)}>
                  <AssetThumb asset={primaryAsset} />
                  <span>{primaryAsset.caption}</span>
                </button>
                {itemAssets.length > 1 && (
                  <button type="button" className="detail-gallery-nav next" onClick={() => goDetailAsset(1)} aria-label="下一张图片">
                    <ChevronRight size={22} />
                  </button>
                )}
              </div>
            )}
            <div className="thumb-strip">
              {itemAssets.map((asset) => (
                <button
                  type="button"
                  key={asset.id}
                  className={asset.id === primaryAsset?.id ? 'active' : ''}
                  onClick={() => setActiveAssetId(asset.id)}
                >
                  <AssetThumb asset={asset} />
                </button>
              ))}
            </div>
          </section>

          <section className="detail-notes">
            <h2>简短说明</h2>
            <p>{item.shortNote}</p>
            <p>{detailSupportNote}</p>
          </section>

          {item.extraNote && (
            <section className="detail-notes">
              <h2>补充内容</h2>
              <div className="detail-extra-note">
                {item.extraNote.split(/\n{2,}/).map((block, index) => (
                  <p key={`${block.slice(0, 24)}-${index}`}>{block}</p>
                ))}
              </div>
            </section>
          )}

        </div>

        <aside className="detail-side">
          <section className={isWebCollectedItem ? 'info-panel archive-info-panel' : 'info-panel'}>
            <h2>关键信息</h2>
            <div className="info-code-row">
              <span>资料编码</span>
              <button type="button" className="archive-code-copy" onClick={() => copyText(archiveCode)}>
                <Copy size={13} />
                {archiveCode}
              </button>
            </div>
            <Info label="时代" value={item.period} />
            <Info label="身份" value={item.identityTypes.join(' / ')} />
            <Info label="职官" value={item.officialTypes.join(' / ')} />
            <Info label="物品类型" value={getItemType(item)} />
            <Info label="物品类别" value={getItemCategories(item).join(' / ')} />
            <Info label="参考用途" value={formatStandardReferenceUsages(item)} />
            {primarySvnPath ? (
              <div className="svn-row">
                <span>SVN 路径</span>
                <code>{primarySvnPath}</code>
                <div className="svn-actions">
                  <button type="button" className="copy-button secondary-control" onClick={() => copyText(primarySvnPath)}>
                    复制 SVN 路径
                  </button>
                  <button type="button" className="copy-button secondary-control" onClick={() => openSvnPath(primarySvnPath)}>
                    打开 SVN 路径
                  </button>
                </div>
              </div>
            ) : (
              <div className="svn-row">
                <span>{primarySourceUrl || primaryLocalCacheUrl ? '网页图片来源' : 'SVN 路径'}</span>
                <code>{primarySourceUrl || primaryLocalCacheUrl || (primaryPlaceholderSvnPath ? '种子示例路径，远端未绑定 SVN 文件' : '未绑定 SVN 路径')}</code>
                {(primarySourceUrl || primaryLocalCacheUrl) && (
                  <button
                    type="button"
                    className="copy-button secondary-control"
                    onClick={() => copyText(primarySourceUrl || primaryLocalCacheUrl)}
                  >
                    复制原图链接
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="source-panel">
            <h2>来源信息</h2>
            <div className="source-list">
              {sourceRows.map(({ icon: Icon, title, body, badge }) => (
                <article className="source-row" key={title}>
                  <Icon size={28} />
                  <span>
                    <strong>{title}</strong>
                    <small>{body}</small>
                  </span>
                  <em>{badge}</em>
                </article>
              ))}
            </div>
          </section>

          {bookSourceRefs.length > 0 && (
            <section className="source-panel detail-book-source-panel">
              <h2>引用来源</h2>
              <div className="detail-book-source-list">
                {bookSourceRefs.map(({ ref, source, pages }) => (
                  <article className="detail-book-source-row" key={`${ref.sourceId}-${ref.pageNumberText ?? pages.map((page) => page.id).join('-')}`}>
                    {pages[0] && <img src={pages[0].imagePath} alt={`${source?.title ?? ref.sourceId} ${pages[0].pageNumber}`} />}
                    <div>
                      <strong>{source?.title ?? ref.sourceId}</strong>
                      <span>{ref.pageNumberText || pages.map((page) => `P${page.pageNumber}`).join(' / ') || '未指定页码'}</span>
                      {source && <small>{[source.author, source.publisher, source.publishYear].filter(Boolean).join(' / ')}</small>}
                      {ref.quoteText && <p>{ref.quoteText}</p>}
                      {ref.note && <p>{ref.note}</p>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </aside>
      </section>

      <section className="related-section">
        <h2>相关条目</h2>
        <div className="related-grid">
          {relatedItems.map((entry) => {
            const coverAsset = assets.find((asset) => asset.id === entry.imageIds[0])
            const compactTitle = getCompactArchiveTitle(entry.title)
            return (
              <button type="button" className="related-card" key={entry.id} onClick={() => openDetail(entry.id)}>
                {coverAsset && <AssetThumb asset={coverAsset} />}
                <span>
                  <strong title={entry.title}>{compactTitle}</strong>
                  <TagRow tags={[entry.period, ...entry.costumeCategories].slice(0, 3)} />
                </span>
                <ChevronRight size={19} />
              </button>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Editor({
  mode,
  sourceItem,
  assetPool,
  editorAssetIds,
  setEditorAssetIds,
  setView,
  openGalleryDialog,
  bookScanDraft,
  notify,
  onItemSaved,
  createdBy,
}: {
  mode: EditorMode
  sourceItem?: CollectionItem
  assetPool: Asset[]
  editorAssetIds: string[]
  setEditorAssetIds: (assetIds: string[]) => void
  setView: (view: View) => void
  openGalleryDialog: (dialog: GalleryDialog) => void
  bookScanDraft: BookScanImport | null
  notify: (message: string) => void
  onItemSaved: () => Promise<void>
  createdBy: string
}) {
  const templateItem = sourceItem ?? collectionItems[0]
  const isBlankNewItem = mode === 'new' && !sourceItem
  const editorTitle = mode === 'edit' ? '编辑资料' : mode === 'duplicate' ? '复制为新资料' : '新建资料'
  const titleValue = isBlankNewItem ? '' : mode === 'duplicate' ? `${templateItem.title}（副本）` : templateItem.title
  const summaryValue = isBlankNewItem ? '' : templateItem.summary
  const noteValue = isBlankNewItem ? '' : templateItem.shortNote
  const extraNoteValue = isBlankNewItem ? '' : (templateItem.extraNote ?? '')
  const editorAssets = editorAssetIds.map((id) => assetPool.find((asset) => asset.id === id)).filter(Boolean) as Asset[]
  const editorCoverAsset = editorAssets[0]
  const initialType = isBlankNewItem
    ? ''
    : getItemType(templateItem)
  const [selectedType, setSelectedType] = useState(initialType)
  const [summaryText, setSummaryText] = useState(summaryValue)
  const [sourceEntryText, setSourceEntryText] = useState(isBlankNewItem ? '' : getEditorSourceEntry(templateItem))
  const [draftSync, setDraftSync] = useState<{ status: 'idle' | 'syncing' | 'saved' | 'failed'; message: string }>({
    status: 'idle',
    message: '',
  })
  const [draftDirty, setDraftDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const mainCategoryFields = getMainCategoryFieldsForType(selectedType)
  const sourceCategoryFields: EditorCategoryField[] = ['来源类型', '参考性质', '使用用途']
  const primaryCategoryField = getPrimaryCategoryField(selectedType)
  const initialCategoryValues: Record<EditorCategoryField, string> = {
    时代: isBlankNewItem ? '' : templateItem.period,
    身份类型: isBlankNewItem ? '' : (templateItem.identityTypes[0] ?? ''),
    职官类型: isBlankNewItem ? '' : normalizeOfficialTypeOption(templateItem.officialTypes[0] ?? ''),
    服装类别: isBlankNewItem ? '' : (templateItem.costumeCategories[0] ?? ''),
    器物类别: isBlankNewItem ? '' : (templateItem.costumeCategories[0] ?? ''),
    图像类别: isBlankNewItem ? '' : (templateItem.costumeCategories[0] ?? ''),
    建筑类别: isBlankNewItem ? '' : (templateItem.costumeCategories[0] ?? ''),
    纹样类别: isBlankNewItem ? '' : (templateItem.costumeCategories[0] ?? ''),
    来源类型: isBlankNewItem ? '' : (templateItem.sourceTypes[0] ?? ''),
    参考性质: isBlankNewItem ? '' : (templateItem.referencePurposes[0] ?? ''),
    使用用途: isBlankNewItem ? '' : (getStandardUsageHints(templateItem.usageHints)[0] ?? templateItem.usageHints[0] ?? ''),
    标签: isBlankNewItem ? '' : (templateItem.tags[0] ?? ''),
  }
  const [categoryValues, setCategoryValues] = useState<Record<EditorCategoryField, string>>(initialCategoryValues)
  const [extraNoteExpanded, setExtraNoteExpanded] = useState(Boolean(extraNoteValue))
  const [extraNote, setExtraNote] = useState(extraNoteValue)
  const [extraNoteDirty, setExtraNoteDirty] = useState(false)
  const [sourceRefs, setSourceRefs] = useState<ArchiveItemSourceRef[]>(sourceItem?.sourceRefs ?? [])
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null)
  const [dragOverImageIndex, setDragOverImageIndex] = useState<number | null>(null)
  const localImageInputRef = useRef<HTMLInputElement>(null)
  const autoClassifiedSignatureRef = useRef('')
  const initialEditorAssetIdsRef = useRef(editorAssetIds.join('|'))

  const markDraftDirty = () => {
    setDraftDirty(true)
    setDraftSync((current) => (current.status === 'saved' ? { status: 'idle', message: '' } : current))
  }

  useEffect(() => {
    if (!bookScanDraft || !formRef.current) return
    const titleInput = formRef.current.querySelector<HTMLInputElement>('input[name="title"]')
    const summaryInput = formRef.current.querySelector<HTMLInputElement>('input[name="summary"]')
    const noteInput = formRef.current.querySelector<HTMLTextAreaElement>('textarea[name="note"]')
    const recognition = bookScanDraft.recognition

    if (titleInput && (!titleInput.value.trim() || titleInput.value === titleValue)) titleInput.value = recognition.title
    if (summaryInput && (!summaryInput.value.trim() || summaryInput.value === summaryValue)) setSummaryText(recognition.summary)
    if (noteInput && (!noteInput.value.trim() || noteInput.value === noteValue)) {
      noteInput.value = recognition.note
    }

    setExtraNote((current) =>
      [
        current,
        recognition.sourceTitle ? `来源条目：${recognition.sourceTitle}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    setExtraNoteExpanded(true)
    setCategoryValues((current) => ({
      ...current,
      [editorCategoryFields[8]]: bookScanDraft.source.sourceType,
      [editorCategoryFields[9]]: '文献记录',
      [editorCategoryFields[10]]: '造型参考',
      [editorCategoryFields[11]]: recognition.tags[0] ?? '书籍扫描',
      [editorCategoryFields[3]]: recognition.tags.find((tag) => !['书籍扫描', 'OCR'].includes(tag)) ?? current[editorCategoryFields[3]],
    }))
    setSourceRefs((current) => {
      const existing = current.filter((ref) => ref.sourceId !== bookScanDraft.source.id)
      return [...existing, bookScanDraft.sourceRef]
    })
    markDraftDirty()
    window.setTimeout(() => classifyEditorContent({ manual: false }), 0)
  }, [bookScanDraft?.id])

  useEffect(() => {
    if (editorAssetIds.join('|') !== initialEditorAssetIdsRef.current) markDraftDirty()
  }, [editorAssetIds.join('|')])

  const getCategorySelectOptions = (field: EditorCategoryField): FancySelectOption[] =>
    [
      { value: '', label: `请选择${field}` },
      ...uniqueValues([categoryValues[field], ...editorCategoryOptionMap[field]].filter(Boolean)).map((option) => ({
        value: option,
        label: option,
      })),
    ]

  const updateCategoryValue = (field: EditorCategoryField, value: string) => {
    markDraftDirty()
    setCategoryValues((current) => ({ ...current, [field]: value }))
  }

  const moveEditorImage = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= editorAssetIds.length || toIndex >= editorAssetIds.length) return
    const nextAssetIds = [...editorAssetIds]
    const [movedAssetId] = nextAssetIds.splice(fromIndex, 1)
    nextAssetIds.splice(toIndex, 0, movedAssetId)
    markDraftDirty()
    setEditorAssetIds(nextAssetIds)
    notify(toIndex === 0 ? '已设为封面图' : '已调整图片顺序')
  }

  const importLocalImages = async (fileList: FileList | null) => {
    const selectedFiles = Array.from(fileList ?? []).filter((file) => file.type.startsWith('image/'))
    if (!selectedFiles.length) return

    const uploadedAssets = await Promise.all(
      selectedFiles.map(async (file, index) => {
        const imageUrl = await readFileAsDataUrl(file)
        return {
          id: `local-upload-${Date.now()}-${index}-${stableHash(`${file.name}-${file.size}-${file.lastModified}`)}`,
          caption: file.name.replace(/\.[^.]+$/, ''),
          imageType: '本地上传图片',
          sourceType: '内部整理',
          referencePurpose: '资料线索',
          tags: ['本地上传'],
          svnPath: '',
          tile: 0,
          linkedItemId: sourceItem?.id ?? 'local-upload',
          imageUrl,
          thumbnailUrl: imageUrl,
          sourceUrl: '',
        } satisfies Asset
      }),
    )

    uploadedAssets.forEach((asset) => {
      const existingIndex = assets.findIndex((entry) => entry.id === asset.id)
      if (existingIndex >= 0) {
        assets[existingIndex] = asset
      } else {
        assets.unshift(asset)
      }
    })
    markDraftDirty()
    setEditorAssetIds([...editorAssetIds, ...uploadedAssets.map((asset) => asset.id)])
    notify(`已上传 ${uploadedAssets.length} 张本地图片`)
  }

  const getEditorIntroText = () => {
    const formData = new FormData(formRef.current ?? undefined)
    return [
      String(formData.get('title') ?? ''),
      summaryText,
      String(formData.get('note') ?? ''),
      sourceEntryText,
      extraNote,
    ].join(' ')
  }

  const summarizeEditorContent = () => {
    const formData = new FormData(formRef.current ?? undefined)
    const title = String(formData.get('title') ?? '').trim()
    const note = String(formData.get('note') ?? '').trim()
    const categoryText = [
      selectedType,
      ...Object.values(categoryValues),
      ...editorAssets.flatMap((asset) => [asset.caption, asset.imageType, asset.referencePurpose, ...asset.tags]),
    ].join(' ')
    const sourceText = [note, extraNote, categoryText, title]
      .join(' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/#[^\s#]+/g, ' ')
      .replace(/[《》「」『』"'`*_>\[\]()（）【】]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!sourceText) {
      notify('请先填写完整介绍或选择图片，再自动概括')
      return
    }

    const sentences = sourceText
      .split(/(?<=[。！？!?；;])\s*/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
    const preferredSentence = sentences.find((sentence) => sentence.length >= 18 && sentence.length <= 100) ?? sentences[0] ?? sourceText
    const nextSummary = preferredSentence.length > 100 ? `${preferredSentence.slice(0, 99)}…` : preferredSentence
    markDraftDirty()
    setSummaryText(nextSummary)
    notify('已自动概括为 100 字以内，可继续手动编辑')
  }

  const getEditorImageText = () => {
    return editorAssets
      .flatMap((asset) => {
        const item = getAssetLinkedItem(asset)
        const pathName = (asset.svnPath || asset.sourceUrl || asset.imageUrl || asset.thumbnailUrl || '')
          .split(/[?#]/)[0]
          .split(/[\\/]/)
          .pop() ?? ''
        return [
          asset.caption,
          asset.imageType,
          asset.sourceType,
          asset.referencePurpose,
          asset.svnPath,
          pathName,
          ...asset.tags,
          item?.title ?? '',
          item?.summary ?? '',
          ...(item?.costumeCategories ?? []),
          ...(item?.sourceTypes ?? []),
          ...(item?.referencePurposes ?? []),
          ...(item?.usageHints ?? []),
          ...getStandardReferenceUsages(item?.referencePurposes ?? [asset.referencePurpose], item?.usageHints ?? []),
          ...(item?.tags ?? []),
        ]
      })
      .filter(Boolean)
      .join(' ')
  }

  const classifyEditorContent = ({ manual = false } = {}) => {
    const text = [getEditorIntroText(), getEditorImageText()].join(' ')
    const normalizedText = text.replace(/\s+/g, ' ').trim()
    if (!normalizedText) {
      if (manual) notify('\u8bf7\u5148\u586b\u5199\u5185\u5bb9\u6216\u9009\u62e9\u56fe\u7247\uff0c\u518d\u91cd\u65b0\u8bc6\u522b\u5206\u7c7b')
      return
    }

    const signature = stableHash(normalizedText)
    if (!manual && autoClassifiedSignatureRef.current === signature) return

    const costumeCategoryField = editorCategoryFields[3]
    const tagCategoryField = editorCategoryFields[11]
    const nextType = inferEditorType(text, selectedType, manual) || selectedType
    const nextPrimaryCategoryField = getPrimaryCategoryField(nextType)
    const nextActiveCategoryFields = uniqueValues([
      ...getMainCategoryFieldsForType(nextType),
      ...sourceCategoryFields,
      tagCategoryField,
    ]) as EditorCategoryField[]
    const categoryInferenceFields = uniqueValues([
      ...nextActiveCategoryFields,
      '服装类别',
      '器物类别',
      '图像类别',
      '建筑类别',
      '纹样类别',
    ]) as EditorCategoryField[]
    let changedCount = nextType !== selectedType ? 1 : 0
    const nextCategoryValues = categoryInferenceFields.reduce<Record<EditorCategoryField, string>>((draft, field) => {
      const inferredValue = inferEditorCategoryValue(field, text, categoryValues[field], manual)
      if (inferredValue && inferredValue !== categoryValues[field]) changedCount += 1
      draft[field] = inferredValue
      return draft
    }, { ...categoryValues })

    if (nextPrimaryCategoryField !== costumeCategoryField && nextCategoryValues[nextPrimaryCategoryField]) {
      const nextCostumeCategory = nextCategoryValues[nextPrimaryCategoryField] || nextType
      if (nextCategoryValues[costumeCategoryField] !== nextCostumeCategory) changedCount += 1
      nextCategoryValues[costumeCategoryField] = nextCostumeCategory
    }

    if (nextType !== selectedType) setSelectedType(nextType)
    if (changedCount || manual) setCategoryValues(nextCategoryValues)
    if (manual && changedCount) markDraftDirty()
    autoClassifiedSignatureRef.current = signature

    if (manual) {
      notify(changedCount ? `\u5df2\u91cd\u65b0\u8bc6\u522b ${changedCount} \u4e2a\u5206\u7c7b` : '\u672a\u8bc6\u522b\u5230\u65b0\u7684\u5206\u7c7b\uff0c\u53ef\u624b\u52a8\u9009\u62e9')
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => classifyEditorContent(), 0)
    return () => window.clearTimeout(timer)
  }, [mode, sourceItem?.id, editorAssetIds.join('|')])

  const buildEditorPayload = () => {
    const formData = new FormData(formRef.current ?? undefined)
    const summary = String(formData.get('summary') ?? '').trim()
    const note = String(formData.get('note') ?? '').trim()
    const sourceEntry = sourceEntryText.trim()
    const categoryDraft = editorCategoryFields.reduce<Record<string, string>>((draft, label) => {
      draft[label] = categoryValues[label]
      return draft
    }, {})
    const primaryCategory = categoryValues[primaryCategoryField]
    categoryDraft['物品类型'] = selectedType || getItemType(templateItem)
    categoryDraft['物品类别'] = primaryCategory || selectedType || ''
    if (primaryCategoryField !== '服装类别') {
      categoryDraft['服装类别'] = primaryCategory || selectedType || ''
    }
    const savedAt = new Date()

    return {
      mode,
      sourceItemId: sourceItem?.id ?? null,
      type: selectedType,
      title: String(formData.get('title') ?? '').trim(),
      summary: (summary || note || templateItem.summary).trim(),
      note,
      extraNote: extraNote.trim(),
      categories: categoryDraft,
      assetIds: editorAssetIds,
      assets: editorAssetIds.map((assetId) => assetPool.find((asset) => asset.id === assetId)).filter(Boolean) as Asset[],
      sourceUrl: sourceEntry,
      sourceRefs,
      timelineEnabled: templateItem.timelineEnabled === true,
      timelineLabel: templateItem.timelineLabel ?? '',
      startYear: templateItem.startYear,
      endYear: templateItem.endYear,
      timelineWeight: templateItem.timelineWeight,
      bookSources: bookScanDraft ? [bookScanDraft.source] : [],
      bookPages: bookScanDraft ? bookScanDraft.pages : [],
      createdBy: sourceItem?.createdBy ?? createdBy,
      savedAt: savedAt.toISOString(),
      savedAtLabel: savedAt.toLocaleTimeString('zh-CN', { hour12: false }),
    }
  }

  const saveDraft = async () => {
    const draft = buildEditorPayload()

    try {
      setIsSaving(true)
      setDraftSync({ status: 'syncing', message: '草稿同步中' })
      await postArchivePayload('drafts', draft)
      setExtraNoteDirty(false)
      setDraftDirty(false)
      setDraftSync({ status: 'saved', message: `草稿已同步 ${draft.savedAtLabel}` })
      notify('草稿已同步')
    } catch (error) {
      const message = error instanceof Error ? error.message : '请检查资料库服务'
      setDraftSync({ status: 'failed', message: `草稿同步失败：${message}` })
      notify(`草稿同步失败：${message}`)
    } finally {
      setIsSaving(false)
    }
  }

  const saveItem = async () => {
    const item = buildEditorPayload()

    if (!item.title) {
      notify('请先填写资料标题')
      formRef.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus()
      return
    }

    try {
      setIsSaving(true)
      await postArchivePayload('items', item)
      await onItemSaved()
      setExtraNoteDirty(false)
      setDraftDirty(false)
      notify(mode === 'edit' ? '资料已同步' : '新资料已同步')
      window.setTimeout(() => setView('library'), 450)
    } catch (error) {
      notify(`同步失败：${error instanceof Error ? error.message : '请检查资料库服务'}`)
      setIsSaving(false)
    }
  }

  return (
    <main className="editor-page">
      <section className="editor-head">
        <div>
          <h1>{editorTitle}</h1>
          <p>资料库 / {editorTitle}</p>
        </div>
      </section>
      <div className="editor-shell">
        <form className="editor-form-card" ref={formRef}>
          <section className="editor-form-row editor-title-row">
            <h2>
              <span>1.</span>
              标题
            </h2>
            <div className="editor-row-field">
              <input name="title" defaultValue={titleValue} onChange={markDraftDirty} placeholder="请输入资料标题" />
            </div>
          </section>

          <section className="editor-form-row editor-image-row">
            <h2>
              <span>2.</span>
              图片
            </h2>
            <div className="editor-row-field">
              <div className="editor-image-actions">
                <div>
                  <button type="button" className="secondary-control" onClick={() => openGalleryDialog('svn-picker')}>
                    <ImageIcon size={17} />
                    从 SVN 选择
                  </button>
                  <button type="button" className="secondary-control" onClick={() => openGalleryDialog('web-clip')}>
                    <Globe2 size={17} />
                    从网页采集
                  </button>
                  <button type="button" className="secondary-control" onClick={() => openGalleryDialog('book-scan')}>
                    <FileText size={17} />
                    OCR / 识别
                  </button>
                  <button type="button" className="secondary-control" onClick={() => localImageInputRef.current?.click()}>
                    <Upload size={17} />
                    从本地上传
                  </button>
                </div>
                <input
                  ref={localImageInputRef}
                  className="editor-local-upload-input"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    void importLocalImages(event.target.files)
                    event.target.value = ''
                  }}
                />
              </div>
              <div className="image-picker">
                {editorAssets.map((asset, index) => (
                  <article
                    key={`${asset.id}-${index}`}
                    className={[
                      'editor-image-card',
                      draggedImageIndex === index ? 'dragging' : '',
                      dragOverImageIndex === index && draggedImageIndex !== index ? 'drag-over' : '',
                    ].filter(Boolean).join(' ')}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', String(index))
                      setDraggedImageIndex(index)
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setDragOverImageIndex(index)
                    }}
                    onDragLeave={() => setDragOverImageIndex((current) => current === index ? null : current)}
                    onDrop={(event) => {
                      event.preventDefault()
                      const fromIndex = Number(event.dataTransfer.getData('text/plain') || draggedImageIndex)
                      moveEditorImage(fromIndex, index)
                      setDraggedImageIndex(null)
                      setDragOverImageIndex(null)
                    }}
                    onDragEnd={() => {
                      setDraggedImageIndex(null)
                      setDragOverImageIndex(null)
                    }}
                  >
                    <button
                      type="button"
                      className="editor-image-remove"
                      aria-label={`移除图片：${asset.caption}`}
                      onClick={() => {
                        markDraftDirty()
                        setEditorAssetIds(editorAssetIds.filter((_, assetIndex) => assetIndex !== index))
                        notify(index === 0 ? '已移除封面图，下一张图片将作为封面' : '已移除图片')
                      }}
                    >
                      <X size={15} />
                    </button>
                    {index === 0 && <b>封面</b>}
                    <AssetThumb asset={asset} />
                  </article>
                ))}
                <button type="button" className="editor-add-image" onClick={() => openGalleryDialog('svn-picker')}>
                  <Plus size={24} />
                  <span>添加图片</span>
                </button>
              </div>
              {editorAssets.length > 1 && <small className="editor-image-hint">拖动图片可调整顺序，第一张自动作为封面图。</small>}
            </div>
          </section>

          <section className="editor-form-row editor-summary-row">
            <h2>
              <span>3.</span>
              简短说明
            </h2>
            <div className="editor-row-field">
              <div className="editor-summary-input">
                <input
                  name="summary"
                  value={summaryText}
                  maxLength={100}
                  onChange={(event) => {
                    markDraftDirty()
                    setSummaryText(event.target.value.slice(0, 100))
                  }}
                  placeholder="请用简短一句话概括该资料的核心内容"
                />
                <button type="button" className="secondary-control" onClick={summarizeEditorContent}>
                  <FileText size={15} />
                  自动概括
                </button>
              </div>
              <small className="editor-summary-count">{summaryText.length} / 100</small>
            </div>
          </section>

          <section className="editor-form-row editor-note-row">
            <h2>
              <span>4.</span>
              正文
            </h2>
            <div className="editor-row-field">
              <textarea
                name="note"
                defaultValue={noteValue}
                onChange={markDraftDirty}
                placeholder="填写正文，可粘贴原文、考据说明、结构分析和补充资料。"
              />
            </div>
          </section>

          <section className="editor-form-row editor-category-row">
            <div className="editor-section-heading">
              <h2>
                <span>5.</span>
                分类信息
              </h2>
              <button type="button" className="editor-auto-classify secondary-control" onClick={() => classifyEditorContent({ manual: true })}>
                <Search size={16} />
                <span>重新识别分类</span>
              </button>
            </div>
            <div className="editor-category-grid">
              <label>
                物品类型
                <FancySelect
                  ariaLabel="物品类型"
                  value={selectedType}
                  options={editorTypeOptions}
                  onChange={(value) => {
                    markDraftDirty()
                    setSelectedType(value)
                  }}
                  className="editor-category-select"
                />
                <input type="hidden" name="type" value={selectedType} />
              </label>
              {mainCategoryFields.map((label) => (
                <label key={label}>
                  {label}
                  <FancySelect
                    ariaLabel={label}
                    value={categoryValues[label]}
                    options={getCategorySelectOptions(label)}
                    onChange={(value) => updateCategoryValue(label, value)}
                    className="editor-category-select"
                  />
                  <input type="hidden" name={`field-${label}`} value={categoryValues[label]} />
                </label>
              ))}
            </div>
          </section>
        </form>

        <aside className="editor-save-panel">
          <section className="editor-side-card">
            <h2>
              来源信息
            </h2>
            <div className="editor-side-field-grid">
              {sourceCategoryFields.map((label) => (
                <label key={label}>
                  {label}
                  <FancySelect
                    ariaLabel={label}
                    value={categoryValues[label]}
                    options={getCategorySelectOptions(label)}
                    onChange={(value) => updateCategoryValue(label, value)}
                    className="editor-category-select"
                  />
                  <input type="hidden" name={`field-${label}`} value={categoryValues[label]} />
                </label>
              ))}
              <label>
                来源条目
                <input
                  name="sourceEntry"
                  value={sourceEntryText}
                  onChange={(event) => {
                    markDraftDirty()
                    setSourceEntryText(event.target.value)
                  }}
                  placeholder="请输入来源条目"
                />
              </label>
            </div>
          </section>

          <section className="editor-side-card editor-cover-card">
            <h2>
              封面图
            </h2>
            <div className="editor-cover-content">
              {editorCoverAsset ? <AssetThumb asset={editorCoverAsset} /> : <div className="editor-cover-empty">暂无封面</div>}
              <p>建议尺寸：1200 × 900px（3:2）</p>
              <button type="button" className="secondary-control" onClick={() => openGalleryDialog('svn-picker')}>
                更换封面
              </button>
            </div>
          </section>

          {sourceRefs.length > 0 && (
            <section className="editor-side-card editor-source-ref-card">
              <h2>
                <BookOpen size={18} />
                引用来源
              </h2>
              {sourceRefs.map((ref) => {
                const source = bookScanDraft?.source.id === ref.sourceId ? bookScanDraft.source : undefined
                return (
                  <article key={`${ref.sourceId}-${ref.pageNumberText}`}>
                    <strong>{source?.title ?? ref.sourceId}</strong>
                    <span>{ref.pageNumberText || '未指定页码'}</span>
                    {ref.note && <p>{ref.note}</p>}
                  </article>
                )
              })}
            </section>
          )}

          <section className={extraNoteExpanded ? 'editor-side-card editor-extra-card expanded' : 'editor-side-card editor-extra-card'}>
            <h2>
              补充内容 <small>选填</small>
            </h2>
            <p>支持 Markdown 格式，可添加更详细的说明、注释或资料出处等。</p>
            <button
              type="button"
              className="editor-expand-button secondary-control"
              aria-expanded={extraNoteExpanded}
              onClick={() => setExtraNoteExpanded((current) => !current)}
            >
              {extraNoteExpanded ? '收起高级编辑' : '展开高级编辑'}
              <ChevronDown size={16} />
            </button>
            {extraNoteExpanded && (
              <label className="editor-extra-note-field">
                <span>补充说明</span>
                <textarea
                  value={extraNote}
                  onChange={(event) => {
                    setExtraNote(event.target.value)
                    markDraftDirty()
                    setExtraNoteDirty(true)
                    if (draftSync.status === 'saved') {
                      setDraftSync({ status: 'idle', message: '' })
                    }
                  }}
                  placeholder={'可记录资料出处、考证说明、制作注意事项等。\n\n例如：\n- 参考画像砖人物衣褶线索\n- 待核对出土年代与馆藏编号'}
                />
                <small>{extraNote.length} 字</small>
              </label>
            )}
            {extraNoteExpanded && (
              <div className="editor-extra-actions">
                {(extraNoteDirty || draftDirty || draftSync.message) && (
                  <span className={extraNoteDirty || draftDirty ? 'dirty' : draftSync.status}>
                    {extraNoteDirty || draftDirty ? '草稿未同步' : draftSync.message}
                  </span>
                )}
                <div>
                  <button type="button" className="secondary-control" onClick={saveDraft} disabled={isSaving}>
                    <FilePenLine size={15} />
                    {isSaving ? '暂存中' : '暂存草稿'}
                  </button>
                  <button type="button" onClick={saveItem} disabled={isSaving}>
                    <Save size={15} />
                    {isSaving ? '保存中' : '保存入库'}
                  </button>
                </div>
              </div>
            )}
          </section>

        </aside>
      </div>
    </main>
  )
}

function Lightbox({
  asset,
  close,
  openDetail,
  copyText,
  openSvnPath,
}: {
  asset: Asset
  close: () => void
  openDetail: (id: string) => void
  copyText: (text: string) => void
  openSvnPath: (path: string) => void | Promise<unknown>
}) {
  const [activeAsset, setActiveAsset] = useState(asset)
  const [originalImage, setOriginalImage] = useState<{ url: string; fileName: string } | null>(null)
  const linkedItem = getAssetLinkedItem(activeAsset)
  const relatedAssets = linkedItem ? getItemAssets(linkedItem) : assets.filter((entry) => entry.linkedItemId === activeAsset.linkedItemId)
  const activeIndex = Math.max(0, relatedAssets.findIndex((entry) => entry.id === activeAsset.id))
  const realSvnPath = isRealSvnPath(activeAsset.svnPath) ? activeAsset.svnPath : ''
  const sourceImageUrl = getAssetSourceUrl(activeAsset)
  const originalImageUrl = getAssetOriginalImageUrl(activeAsset)
  const localCacheUrl = activeAsset.imageUrl?.startsWith('/web-clips/') ? resolveLocalAssetUrl(activeAsset.imageUrl) : ''
  const sourceHost = sourceImageUrl && isHttpUrl(sourceImageUrl) ? new URL(sourceImageUrl).host.replace(/^www\./, '') : ''
  const imageFileName = getAssetFileName(activeAsset)
  const imageFormat = imageFileName.split('.').pop()?.toUpperCase() ?? '图片'
  const lightboxTags = uniqueValues([...(linkedItem?.tags ?? []), ...activeAsset.tags]).slice(0, 8)
  const goSibling = (direction: -1 | 1) => {
    if (!relatedAssets.length) return
    const nextIndex = (activeIndex + direction + relatedAssets.length) % relatedAssets.length
    setActiveAsset(relatedAssets[nextIndex])
  }

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) close()
  }

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow
    const previousHtmlOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousHtmlOverflow
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''

    setOriginalImage(null)
    const directImageUrl = originalImageUrl

    if (directImageUrl) {
      setOriginalImage({ url: directImageUrl, fileName: getAssetFileName(activeAsset) })
      return () => {
        cancelled = true
      }
    }

    createAssetImageBlob(activeAsset)
      .then(({ blob, fileName }) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setOriginalImage({ url: objectUrl, fileName })
      })
      .catch((error) => {
        console.error(error)
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [activeAsset, originalImageUrl])

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      onClick={closeFromBackdrop}
      onWheel={(event) => event.preventDefault()}
    >
      <div
        className="lightbox-panel"
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <header className="lightbox-header">
          <div>
            <h2>{activeAsset.caption}</h2>
            <span>{activeAsset.imageType}</span>
          </div>
          <button type="button" className="close-button" onClick={close} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        <div className="lightbox-content">
        <section className="lightbox-stage">
          <button type="button" className="lightbox-nav prev" onClick={() => goSibling(-1)} aria-label="上一">
            <ChevronRight size={24} />
          </button>
          <AssetThumb asset={activeAsset} />
          <button type="button" className="lightbox-nav next" onClick={() => goSibling(1)} aria-label="下一">
            <ChevronRight size={24} />
          </button>
          <div className="lightbox-thumb-bar">
            <span className="lightbox-count">
              {activeIndex + 1} / {Math.max(relatedAssets.length, 1)}
            </span>
            <div className="lightbox-thumbs">
              {relatedAssets.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={entry.id === activeAsset.id ? 'active' : ''}
                  onClick={() => setActiveAsset(entry)}
                >
                  <AssetThumb asset={entry} />
                </button>
              ))}
            </div>
          </div>
        </section>
        <aside className="lightbox-info">
          <section>
            <h3>关联条目</h3>
            {linkedItem ? (
              <button
                type="button"
                className="lightbox-link-row"
                onClick={() => {
                  close()
                  openDetail(linkedItem.id)
                }}
              >
                <BookOpen size={16} />
                {linkedItem.title}
              </button>
            ) : (
              <p>未绑定资料条目</p>
            )}
          </section>
          <section>
            <h3>图片信息</h3>
            <Info label="图片类型" value={activeAsset.imageType} />
            <Info label="来源类型" value={activeAsset.sourceType} />
            <Info
              label="参考用途"
              value={linkedItem
                ? formatStandardReferenceUsages(linkedItem)
                : getStandardReferenceUsages([activeAsset.referencePurpose], []).join(' / ') || '研究线索'}
            />
          </section>
          <section>
            <h3>来源信息</h3>
            <Info label="来源网站" value={sourceHost || (realSvnPath ? 'SVN 图片库' : '未绑定')} />
            <Info label="来源链接" value={sourceImageUrl || realSvnPath || '未绑定'} />
          </section>
          <section>
            <h3>文件信息</h3>
            <Info label="文件名" value={imageFileName} />
            <Info label="格式" value={imageFormat} />
            <Info label="路径" value={realSvnPath || localCacheUrl || '未绑定'} />
          </section>
          {lightboxTags.length > 0 && (
            <section>
              <h3>标签</h3>
              <div className="lightbox-tag-list">
                {lightboxTags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </section>
          )}
          <section>
            <h3>图片说明</h3>
            <p>{linkedItem?.shortNote ?? '图片用于服饰形制、时代线索和角色设计参考'}</p>
          </section>
          {realSvnPath ? (
            <section>
              <div className="lightbox-section-head">
                <h3>SVN 路径</h3>
                <button type="button" className="lightbox-inline-action" onClick={() => copyText(realSvnPath)}>
                  <Copy size={14} />
                  复制路径
                </button>
              </div>
              <code>{realSvnPath}</code>
            </section>
          ) : (
            <section>
              <h3>网页图片来源</h3>
              {sourceImageUrl ? <code>{sourceImageUrl}</code> : <p>该图片尚未绑定 SVN 路径。</p>}
              {localCacheUrl && <Info label="本地缓存" value={localCacheUrl} />}
            </section>
          )}
        </aside>
        </div>
        <footer className="lightbox-actions">
          <div>
            <a
              className={originalImage ? 'secondary-control' : 'secondary-control disabled'}
              href={originalImage?.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!originalImage}
              onClick={(event) => {
                if (!originalImage) event.preventDefault()
              }}
            >
              <ExternalLink size={16} />
              {originalImage ? '查看原图' : '生成原图'}
            </a>
          </div>
          <div>
            <a
              className={originalImage ? 'secondary-control' : 'secondary-control disabled'}
              href={originalImage?.url}
              download={originalImage?.fileName}
              aria-disabled={!originalImage}
              onClick={(event) => {
                if (!originalImage) event.preventDefault()
              }}
            >
              <Download size={16} />
              下载原图
            </a>
            {realSvnPath ? (
              <button type="button" className="secondary-control" onClick={() => openSvnPath(realSvnPath)}>
                <FolderOpen size={16} />
                打开 SVN
              </button>
            ) : (
              <button
                type="button"
                className="secondary-control"
                onClick={() => copyText(sourceImageUrl)}
                disabled={!sourceImageUrl}
              >
                <Copy size={16} />
                复制原图链接
              </button>
            )}
            <button type="button" className="lightbox-close-action" onClick={close}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function ArmorShowcaseScene() {
  return (
    <div className="armor-scene" role="img" aria-label="东汉三国冠饰头带 3D 展示场景">
      <Canvas
        camera={{ position: [0, 0.38, 5.8], fov: 31 }}
        gl={{ alpha: true, antialias: true }}
        shadows
        dpr={[1, 1.7]}
      >
        <fog attach="fog" args={['#2d2a23', 5.8, 10.8]} />
        <ambientLight intensity={0.78} />
        <directionalLight position={[-3.8, 4.8, 4.2]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} />
        <spotLight position={[2.4, 3.4, 3.2]} angle={0.42} penumbra={0.78} intensity={1.55} color="#f0c987" castShadow />
        <pointLight position={[3.4, 1.6, 2.2]} intensity={0.62} color="#d4a061" />
        <Suspense fallback={<ModelLoadingPlaceholder />}>
          <HeadbandModel />
        </Suspense>
        <ContactShadows position={[0, -1.34, 0]} opacity={0.34} scale={4.8} blur={2.9} far={2.8} color="#17130f" />
        <OrbitControls
          autoRotate
          autoRotateSpeed={0.42}
          enablePan={false}
          enableZoom
          zoomSpeed={0.72}
          minDistance={3.2}
          maxDistance={7.8}
          minPolarAngle={Math.PI / 2.55}
          maxPolarAngle={Math.PI / 1.88}
          target={[0, -0.08, 0]}
        />
      </Canvas>
    </div>
  )
}

function HeadbandModel() {
  const gltf = useGLTF(appPath('/assets/models/headband-3d-model.glb'))
  const modelScene = useMemo(() => gltf.scene.clone(true), [gltf.scene])

  return (
    <group position={[0, -0.28, 0]} rotation={[0.04, -0.28, 0]} scale={1.42}>
      <Center>
        <primitive object={modelScene} />
      </Center>
    </group>
  )
}

function ModelLoadingPlaceholder() {
  const lightRef = useRef<Group>(null)
  const dustRef = useRef<Group>(null)
  const plateRef = useRef<Group>(null)

  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime()
    if (lightRef.current) {
      const pulse = 1 + Math.sin(elapsed * 1.15) * 0.035
      lightRef.current.scale.set(pulse, pulse, pulse)
      lightRef.current.position.y = -0.18 + Math.sin(elapsed * 0.9) * 0.018
    }
    if (dustRef.current) {
      dustRef.current.rotation.y = Math.sin(elapsed * 0.36) * 0.16
      dustRef.current.position.y = Math.sin(elapsed * 0.72) * 0.026
    }
    if (plateRef.current) {
      plateRef.current.rotation.y = Math.sin(elapsed * 0.42) * 0.08
      plateRef.current.position.y = -0.18 + Math.sin(elapsed * 0.82) * 0.018
    }
  })

  return (
    <group position={[0, -0.34, 0]}>
      <group ref={lightRef}>
        <mesh position={[0, -0.42, 0.04]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.52, 0.72, 96]} />
          <meshBasicMaterial color="#c2a87f" transparent opacity={0.24} depthWrite={false} />
        </mesh>
        <mesh position={[0, -0.4, 0.05]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.42, 96]} />
          <meshBasicMaterial color="#d8bd82" transparent opacity={0.11} depthWrite={false} />
        </mesh>
      </group>
      <group ref={plateRef}>
        <mesh position={[0, -0.12, 0.04]} rotation={[-0.1, 0, 0]} castShadow>
          <cylinderGeometry args={[0.42, 0.48, 0.045, 72]} />
          <meshStandardMaterial color="#9f8556" roughness={0.58} metalness={0.18} transparent opacity={0.88} />
        </mesh>
        <mesh position={[0, -0.085, 0.04]} rotation={[-0.1, 0, 0]}>
          <torusGeometry args={[0.32, 0.012, 12, 72]} />
          <meshStandardMaterial color="#c2a87f" roughness={0.42} metalness={0.34} transparent opacity={0.72} />
        </mesh>
        <mesh position={[0, -0.055, 0.04]} rotation={[-0.1, 0, 0]}>
          <boxGeometry args={[0.38, 0.028, 0.018]} />
          <meshStandardMaterial color="#d0b37b" roughness={0.46} metalness={0.28} transparent opacity={0.68} />
        </mesh>
      </group>
      <group ref={dustRef}>
        {[
          [-0.56, 0.22, 0.2],
          [-0.36, -0.05, 0.34],
          [0.42, 0.18, 0.28],
          [0.3, 0.44, 0.18],
          [0.58, -0.12, 0.2],
          [-0.1, 0.5, 0.26],
          [0.08, 0.08, 0.3],
        ].map(([x, y, z], index) => (
          <mesh key={index} position={[x, y, z]}>
            <sphereGeometry args={[index % 2 ? 0.01 : 0.014, 12, 12]} />
            <meshBasicMaterial color="#dbc08a" transparent opacity={index % 2 ? 0.3 : 0.22} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <mesh position={[0, -0.82, 0]} receiveShadow>
        <cylinderGeometry args={[1.08, 1.24, 0.18, 96]} />
        <meshStandardMaterial color="#66583f" roughness={0.76} metalness={0.08} />
      </mesh>
      <mesh position={[0, -0.68, 0.02]} receiveShadow>
        <cylinderGeometry args={[0.58, 0.66, 0.1, 72]} />
        <meshStandardMaterial color="#81704f" roughness={0.7} metalness={0.1} />
      </mesh>
    </group>
  )
}

useGLTF.preload(appPath('/assets/models/headband-3d-model.glb'))

function Toast({ message }: { message: string }) {
  return (
    <div className={message ? 'toast visible' : 'toast'} role="status" aria-live="polite">
      {message}
    </div>
  )
}

export default App
