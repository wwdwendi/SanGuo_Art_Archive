import { assets, collectionItems, type CollectionItem, type Period } from './data'
import {
  TIMELINE_DISPLAY_PERIODS,
  TIMELINE_PERIOD_ORDER,
  getTimelinePeriod,
  normalizePeriod,
  resolveTimelinePeriod,
} from './timelinePeriods'

export { TIMELINE_DISPLAY_PERIODS, TIMELINE_PERIOD_ORDER }
export const PERIOD_ORDER = TIMELINE_PERIOD_ORDER
const appBaseUrl = import.meta.env.BASE_URL.replace(/\/$/, '')
const appPath = (path: string) => `${appBaseUrl}${path}`

export type TimelineCategoryKey = 'all' | 'costume' | 'armor' | 'vessel' | 'mural' | 'architecture' | 'headwear' | 'pattern'

export type TimelineQuery = {
  topicCategory?: TimelineCategoryKey
  topicKeyword?: string
  costumeCategory?: string
  identityType?: string
  officialType?: string
  periodStart?: Period
  periodEnd?: Period
  sourceType?: string
  referencePurpose?: string
  tag?: string
}

export type TimelineCardItem = {
  id: string
  title: string
  summary: string
  coverImageUrl?: string
  period: Period
  startYear?: number
  endYear?: number
  timelineLabel?: string
  tags: string[]
  referencePurposes: string[]
}

export type TimelineGroup = {
  periodKey: Period
  label: string
  order: number
  items: TimelineCardItem[]
  featuredItem?: TimelineCardItem
}

export type TimelineResponse = {
  groups: TimelineGroup[]
  defaultSelectedItemId?: string
}

const periodOrderLookup = new Map<Period, number>(
  TIMELINE_PERIOD_ORDER.map((period, index) => [period, index] as const),
)

const timelineCategoryKeywords: Record<TimelineCategoryKey, string[]> = {
  all: [],
  costume: ['服装', '服饰', '袍服', '常服', '腰带', '鞋履', '发式', '衣褶', '汉服', 'robe', 'costume'],
  armor: ['甲胄', '铠甲', '短甲', '披挂', '兵器', '武官', '武将', '将军', 'armor'],
  vessel: ['器物', '器皿', '器物工艺', '青铜器', '陶器', '陶俑', '香炉', '博山炉', '带钩', '漆器', '玉器', 'vessel', 'bronze', 'jade'],
  mural: ['壁画', '画像', '画像砖', '画像石', '墓室图像', '拓片', '图像资料', 'mural', 'relief'],
  architecture: ['建筑', '建筑空间', '城池', '宫殿', '楼阁', '阙', '望楼', '墓葬空间', '建筑构件', 'architecture', 'tower', 'palace'],
  headwear: ['冠帽', '冠饰', '冠', '帽', '帻', '盔', '头部', '头饰', '进贤冠', '武冠', 'helmet', 'headwear'],
  pattern: ['纹样', '纹饰', '织锦', '云气纹', '边饰', '色彩', '材质', 'pattern', 'textile'],
}

export function getPeriodOrder(period: Period): number {
  return periodOrderLookup.get(resolveTimelinePeriod(period)) ?? Number.MAX_SAFE_INTEGER
}

export function periodInRange(period: Period, periodStart?: Period, periodEnd?: Period): boolean {
  const order = getPeriodOrder(resolveTimelinePeriod(period))
  const startOrder = periodStart ? getPeriodOrder(resolveTimelinePeriod(periodStart)) : 0
  const endOrder = periodEnd ? getPeriodOrder(resolveTimelinePeriod(periodEnd)) : TIMELINE_PERIOD_ORDER.length - 1

  return order >= startOrder && order <= endOrder
}

function getTimelineSearchText(item: CollectionItem): string {
  return [
    item.title,
    item.summary,
    item.shortNote,
    item.extraNote,
    ...item.costumeCategories,
    ...item.identityTypes,
    ...item.officialTypes,
    ...item.sourceTypes,
    ...item.referencePurposes,
    ...item.usageHints,
    ...item.tags,
  ].join(' ').toLowerCase()
}

function includesTimelineKeyword(searchText: string, keyword?: string): boolean {
  return !keyword || searchText.includes(keyword.toLowerCase())
}

function itemHasTimelineFacet(item: CollectionItem, value?: string): boolean {
  if (!value) return true
  const normalizedValue = value.toLowerCase()
  return [
    item.itemType,
    ...item.costumeCategories,
    ...item.tags,
  ].some((entry) => entry?.toLowerCase() === normalizedValue)
}

function matchesTimelineQuery(item: CollectionItem, query: TimelineQuery): boolean {
  const searchText = getTimelineSearchText(item)
  const categoryKeywords = query.topicCategory ? timelineCategoryKeywords[query.topicCategory] : []

  return (
    item.status === 'active' &&
    item.timelineEnabled !== false &&
    (!categoryKeywords.length || categoryKeywords.some((keyword) => includesTimelineKeyword(searchText, keyword))) &&
    itemHasTimelineFacet(item, query.topicKeyword) &&
    (!query.costumeCategory || item.costumeCategories.includes(query.costumeCategory)) &&
    (!query.identityType || item.identityTypes.includes(query.identityType)) &&
    (!query.officialType || item.officialTypes.includes(query.officialType)) &&
    periodInRange(item.period, query.periodStart, query.periodEnd) &&
    (!query.sourceType || item.sourceTypes.includes(query.sourceType)) &&
    (!query.referencePurpose || item.referencePurposes.includes(query.referencePurpose)) &&
    (!query.tag || item.tags.includes(query.tag))
  )
}

function toTimelineCardItem(item: CollectionItem): TimelineCardItem {
  const coverAsset = assets.find((asset) => asset.id === item.imageIds[0])

  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    coverImageUrl: coverAsset ? appPath(`/assets/archive-contact-sheet.png#${coverAsset.tile}`) : undefined,
    period: resolveTimelinePeriod(item.period),
    startYear: item.startYear,
    endYear: item.endYear,
    timelineLabel: item.timelineLabel,
    tags: item.tags,
    referencePurposes: item.referencePurposes,
  }
}

function compareFeaturedItems(a: CollectionItem, b: CollectionItem): number {
  return (b.timelineWeight ?? 0) - (a.timelineWeight ?? 0) || (a.startYear ?? 9999) - (b.startYear ?? 9999)
}

export function buildTimelineResponse(query: TimelineQuery = {}, items: CollectionItem[] = collectionItems): TimelineResponse {
  const grouped = new Map<Period, CollectionItem[]>()

  items.filter((item) => matchesTimelineQuery(item, query)).forEach((item) => {
    const period = resolveTimelinePeriod(item.period)
    const groupItems = grouped.get(period) ?? []
    groupItems.push(item)
    grouped.set(period, groupItems)
  })

  const groups = Array.from(grouped.entries())
    .sort(([periodA], [periodB]) => getPeriodOrder(periodA) - getPeriodOrder(periodB))
    .map(([periodKey, items]) => {
      const sortedItems = [...items].sort(compareFeaturedItems)
      const cardItems = sortedItems.map(toTimelineCardItem)

      return {
        periodKey,
        label: getTimelinePeriod(periodKey)?.displayLabel ?? normalizePeriod(periodKey),
        order: getPeriodOrder(periodKey),
        items: cardItems,
        featuredItem: cardItems[0],
      }
    })

  return {
    groups,
    defaultSelectedItemId: groups[0]?.featuredItem?.id,
  }
}

export async function fetchTimeline(query: TimelineQuery = {}): Promise<TimelineResponse> {
  return buildTimelineResponse(query)
}
