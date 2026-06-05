import { assets, collectionItems, type CollectionItem, type Period } from './data'

export const PERIOD_ORDER = ['东汉', '东汉末', '魏', '蜀', '吴', '三国', '西晋初', '汉晋过渡'] as const

export type TimelineQuery = {
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

const periodOrderLookup = new Map<Period, number>(PERIOD_ORDER.map((period, index) => [period, index]))

export function getPeriodOrder(period: Period): number {
  return periodOrderLookup.get(period) ?? Number.MAX_SAFE_INTEGER
}

export function periodInRange(period: Period, periodStart?: Period, periodEnd?: Period): boolean {
  const order = getPeriodOrder(period)
  const startOrder = periodStart ? getPeriodOrder(periodStart) : 0
  const endOrder = periodEnd ? getPeriodOrder(periodEnd) : PERIOD_ORDER.length - 1

  return order >= startOrder && order <= endOrder
}

function matchesTimelineQuery(item: CollectionItem, query: TimelineQuery): boolean {
  return (
    item.status === 'active' &&
    item.timelineEnabled !== false &&
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
    coverImageUrl: coverAsset ? `/assets/archive-contact-sheet.png#${coverAsset.tile}` : undefined,
    period: item.period,
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

export function buildTimelineResponse(query: TimelineQuery = {}): TimelineResponse {
  const grouped = new Map<Period, CollectionItem[]>()

  collectionItems.filter((item) => matchesTimelineQuery(item, query)).forEach((item) => {
    const groupItems = grouped.get(item.period) ?? []
    groupItems.push(item)
    grouped.set(item.period, groupItems)
  })

  const groups = Array.from(grouped.entries())
    .sort(([periodA], [periodB]) => getPeriodOrder(periodA) - getPeriodOrder(periodB))
    .map(([periodKey, items]) => {
      const sortedItems = [...items].sort(compareFeaturedItems)
      const cardItems = sortedItems.map(toTimelineCardItem)

      return {
        periodKey,
        label: periodKey,
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
