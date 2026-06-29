export type TimelinePeriodType = 'main' | 'grouping' | 'extension'

export type TimelineAxisGroup =
  | 'pre_three_kingdoms'
  | 'three_kingdoms_branch'
  | 'post_three_kingdoms'
  | 'hidden_grouping'
  | 'future_extension'

export type TimelinePeriod = {
  key: string
  value: string
  label: string
  displayLabel: string
  startYear: number
  endYear: number
  timelineLabel: string
  visibleInMainTimeline: boolean
  selectableInEditor: boolean
  order: number
  type: TimelinePeriodType
  axisGroup: TimelineAxisGroup
  description: string
}

export const TIMELINE_PERIODS = [
  {
    key: 'dong_han',
    value: '东汉',
    label: '东汉',
    displayLabel: '东汉',
    startYear: 25,
    endYear: 184,
    timelineLabel: '25—184',
    visibleInMainTimeline: true,
    selectableInEditor: true,
    order: 10,
    type: 'main',
    axisGroup: 'pre_three_kingdoms',
    description: '用于归类东汉制度与形制基础资料。这里的“东汉”指东汉中前期资料，东汉末资料请归入“东汉末”。',
  },
  {
    key: 'dong_han_late',
    value: '东汉末',
    label: '东汉末',
    displayLabel: '东汉末',
    startYear: 184,
    endYear: 220,
    timelineLabel: '184—220',
    visibleInMainTimeline: true,
    selectableInEditor: true,
    order: 20,
    type: 'main',
    axisGroup: 'pre_three_kingdoms',
    description: '用于归类黄巾起义至曹丕代汉之间的汉末阶段资料，是三国题材美术资料的重要过渡期。',
  },
  {
    key: 'cao_wei',
    value: '魏',
    label: '魏 / 曹魏',
    displayLabel: '曹魏',
    startYear: 220,
    endYear: 266,
    timelineLabel: '220—266',
    visibleInMainTimeline: true,
    selectableInEditor: true,
    order: 30,
    type: 'main',
    axisGroup: 'three_kingdoms_branch',
    description: '用于归类曹魏政权相关资料，包括官服、甲胄、器物、礼制延续与变化等。',
  },
  {
    key: 'shu_han',
    value: '蜀',
    label: '蜀 / 蜀汉',
    displayLabel: '蜀汉',
    startYear: 221,
    endYear: 263,
    timelineLabel: '221—263',
    visibleInMainTimeline: true,
    selectableInEditor: true,
    order: 40,
    type: 'main',
    axisGroup: 'three_kingdoms_branch',
    description: '用于归类蜀汉政权相关资料，包括人物冠服、军制、美术设定参考等内容。',
  },
  {
    key: 'sun_wu',
    value: '吴',
    label: '吴 / 孙吴',
    displayLabel: '孙吴',
    startYear: 222,
    endYear: 280,
    timelineLabel: '222—280',
    visibleInMainTimeline: true,
    selectableInEditor: true,
    order: 50,
    type: 'main',
    axisGroup: 'three_kingdoms_branch',
    description: '用于归类孙吴政权相关资料。222 年可作为孙权受封吴王后的归类起点，229 年称帝可在条目说明中补充。',
  },
  {
    key: 'three_kingdoms_general',
    value: '三国',
    label: '三国通用',
    displayLabel: '三国通用',
    startYear: 220,
    endYear: 280,
    timelineLabel: '220—280',
    visibleInMainTimeline: false,
    selectableInEditor: true,
    order: 60,
    type: 'grouping',
    axisGroup: 'hidden_grouping',
    description: '用于归类无法明确归属魏、蜀、吴，或同时涉及三国整体的资料。默认不进入主轴展示。',
  },
  {
    key: 'han_jin_transition',
    value: '汉晋过渡',
    label: '汉晋过渡',
    displayLabel: '汉晋过渡',
    startYear: 220,
    endYear: 280,
    timelineLabel: '220—280',
    visibleInMainTimeline: false,
    selectableInEditor: true,
    order: 70,
    type: 'grouping',
    axisGroup: 'hidden_grouping',
    description: '用于归类从汉制到晋制之间的过渡性资料，适合专题考据或资料归档，默认不进入主轴展示。',
  },
  {
    key: 'western_jin_early',
    value: '西晋初',
    label: '西晋初',
    displayLabel: '西晋初',
    startYear: 266,
    endYear: 300,
    timelineLabel: '266—300',
    visibleInMainTimeline: true,
    selectableInEditor: true,
    order: 80,
    type: 'main',
    axisGroup: 'post_three_kingdoms',
    description: '用于归类三国之后形制延续和变化的资料，作为三国资料库的后续参考边界。',
  },
  {
    key: 'qin_han_foundation',
    value: '秦汉基础',
    label: '秦汉基础',
    displayLabel: '秦汉基础',
    startYear: -221,
    endYear: 25,
    timelineLabel: '秦汉',
    visibleInMainTimeline: false,
    selectableInEditor: false,
    order: -20,
    type: 'extension',
    axisGroup: 'future_extension',
    description: '后续扩展节点，用于归类秦至西汉、王莽新朝前后的制度与形制基础资料。V1 暂不开放。',
  },
  {
    key: 'han_generic',
    value: '汉',
    label: '汉',
    displayLabel: '汉',
    startYear: -202,
    endYear: 220,
    timelineLabel: '前202—220',
    visibleInMainTimeline: false,
    selectableInEditor: true,
    order: -15,
    type: 'extension',
    axisGroup: 'future_extension',
    description: '用于归类来源只标注为“汉”且无法进一步判断西汉、东汉或东汉末的资料。',
  },
  {
    key: 'western_han',
    value: '西汉',
    label: '西汉',
    displayLabel: '西汉',
    startYear: -202,
    endYear: 8,
    timelineLabel: '前202—8',
    visibleInMainTimeline: false,
    selectableInEditor: true,
    order: -10,
    type: 'extension',
    axisGroup: 'future_extension',
    description: '用于归类西汉相关资料，可作为东汉与三国形制来源的前置参考。',
  },
  {
    key: 'two_jin',
    value: '两晋',
    label: '两晋',
    displayLabel: '两晋',
    startYear: 266,
    endYear: 420,
    timelineLabel: '266—420',
    visibleInMainTimeline: false,
    selectableInEditor: false,
    order: 90,
    type: 'extension',
    axisGroup: 'future_extension',
    description: '后续扩展节点，用于归类西晋、东晋整体资料。V1 暂不开放。',
  },
  {
    key: 'northern_southern_dynasties',
    value: '南北朝',
    label: '南北朝',
    displayLabel: '南北朝',
    startYear: 420,
    endYear: 589,
    timelineLabel: '420—589',
    visibleInMainTimeline: false,
    selectableInEditor: false,
    order: 100,
    type: 'extension',
    axisGroup: 'future_extension',
    description: '后续扩展节点，用于归类南北朝相关资料。V1 暂不开放。',
  },
] as const satisfies readonly TimelinePeriod[]

export type Period = (typeof TIMELINE_PERIODS)[number]['value']

export const TIMELINE_PERIOD_ORDER = TIMELINE_PERIODS
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((period) => period.value)

export const TIMELINE_DISPLAY_PERIODS = TIMELINE_PERIODS
  .filter((period) => period.visibleInMainTimeline)
  .sort((a, b) => a.order - b.order)
  .map((period) => period.value)

export const TIMELINE_EDITOR_PERIOD_OPTIONS = TIMELINE_PERIODS
  .filter((period) => period.selectableInEditor)
  .sort((a, b) => a.order - b.order)
  .map((period) => ({
    label: period.label,
    value: period.value,
    description: period.description,
  }))

export const PERIOD_ALIASES: Record<string, Period> = {
  汉末: '东汉末',
  东汉晚期: '东汉末',
  东汉后期: '东汉末',
  后汉末: '东汉末',
  曹魏: '魏',
  魏国: '魏',
  曹魏时期: '魏',
  蜀汉: '蜀',
  蜀国: '蜀',
  季汉: '蜀',
  孙吴: '吴',
  吴国: '吴',
  东吴: '吴',
  三国时期: '三国',
  三国通用: '三国',
  魏晋: '汉晋过渡',
  汉魏晋: '汉晋过渡',
  魏晋过渡: '汉晋过渡',
  西晋早期: '西晋初',
  晋初: '西晋初',
}

const periodSet = new Set<string>(TIMELINE_PERIOD_ORDER)
const periodLookup = new Map(TIMELINE_PERIODS.map((period) => [period.value, period]))

export function normalizePeriod(period?: string) {
  const trimmedPeriod = period?.trim()
  if (!trimmedPeriod) return ''
  return PERIOD_ALIASES[trimmedPeriod] ?? trimmedPeriod
}

export function isTimelinePeriod(period?: string): period is Period {
  return Boolean(period && periodSet.has(period))
}

export function resolveTimelinePeriod(period?: string, fallback: Period = '东汉') {
  const normalizedPeriod = normalizePeriod(period)
  return isTimelinePeriod(normalizedPeriod) ? normalizedPeriod : fallback
}

export function getTimelinePeriod(period?: string) {
  const normalizedPeriod = normalizePeriod(period)
  if (!isTimelinePeriod(normalizedPeriod)) return undefined
  return periodLookup.get(normalizedPeriod)
}
