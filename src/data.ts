import { TIMELINE_EDITOR_PERIOD_OPTIONS, type Period } from './timelinePeriods'

export type { Period } from './timelinePeriods'

export type Asset = {
  id: string
  caption: string
  imageType: string
  sourceType: string
  referencePurpose: string
  tags: string[]
  svnPath: string
  tile: number
  linkedItemId: string
  imageUrl?: string
  thumbnailUrl?: string
  sourceUrl?: string
  originalUrl?: string
  sourcePageUrl?: string
  previewPath?: string
  thumbnailPath?: string
  fileName?: string
  width?: number
  height?: number
  fileSize?: number
  mimeType?: string
  copyrightNote?: string
  usageLimit?: string
  archiveStatus?: 'pending' | 'archived' | 'failed'
  archivedAt?: string
  downloadStatus?: 'not_downloaded' | 'downloaded' | 'failed'
}

export type CollectionItem = {
  id: string
  title: string
  summary: string
  shortNote: string
  extraNote?: string
  period: Period
  startYear?: number
  endYear?: number
  timelineLabel?: string
  timelineEnabled?: boolean
  timelineWeight?: number
  itemType?: string
  identityTypes: string[]
  officialTypes: string[]
  costumeCategories: string[]
  regions: string[]
  sourceTypes: string[]
  referencePurposes: string[]
  usageHints: string[]
  tags: string[]
  imageIds: string[]
  sourceRefs?: Array<{
    sourceId: string
    pageIds?: string[]
    pageNumberText?: string
    quoteText?: string
    note?: string
  }>
  updatedAt: string
  sourceUrl?: string
  createdAt?: string
  createdBy?: string
  status: 'draft' | 'active' | 'hidden' | 'deleted'
}

export const assets: Asset[] = [
  {
    id: 'img-armor-01',
    caption: '曹魏武官甲胄人台参考',
    imageType: '现代复原图',
    sourceType: '内部整理',
    referencePurpose: '设计转化参考',
    tags: ['甲胄', '武官', '皮革', '札甲'],
    svnPath: '/Costume/ThreeKingdoms/armor/wei-officer-preview.jpg',
    tile: 0,
    linkedItemId: 'wei-armor',
  },
  {
    id: 'img-robe-01',
    caption: '东汉末文官宽袍大袖',
    imageType: '现代复原图',
    sourceType: '服饰复原作者',
    referencePurpose: '复原参考',
    tags: ['袍服', '文官', '宽袖', '腰带'],
    svnPath: '/Costume/LateHan/robes/scholar-wide-sleeve.jpg',
    tile: 1,
    linkedItemId: 'han-scholar-robe',
  },
  {
    id: 'img-brick-01',
    caption: '画像砖人物衣褶与冠帻线索',
    imageType: '画像砖',
    sourceType: '出土文物图像',
    referencePurpose: '史实依据',
    tags: ['画像砖', '冠帻', '衣褶'],
    svnPath: '/Costume/Artifacts/brick-relief/late-han-figures.jpg',
    tile: 2,
    linkedItemId: 'han-brick-figures',
  },
  {
    id: 'img-pattern-01',
    caption: '袍服结构线稿与袖型参考',
    imageType: '书籍扫描',
    sourceType: '现代书籍',
    referencePurpose: '研究线索',
    tags: ['结构', '袖型', '袍服'],
    svnPath: '/Costume/Books/patterns/han-robe-outline.png',
    tile: 3,
    linkedItemId: 'han-scholar-robe',
  },
  {
    id: 'img-figurine-01',
    caption: '陶俑头部冠帽与身份形象',
    imageType: '陶俑',
    sourceType: '博物馆馆藏',
    referencePurpose: '史实依据',
    tags: ['陶俑', '冠帽', '士人'],
    svnPath: '/Costume/Artifacts/figurine/museum-bust-cap.jpg',
    tile: 4,
    linkedItemId: 'han-cap-system',
  },
  {
    id: 'img-detail-01',
    caption: '衣缘包边与材质层次细节',
    imageType: '手办细节图',
    sourceType: '手办作者',
    referencePurpose: '细节工艺参考',
    tags: ['包边', '材质', '衣缘'],
    svnPath: '/Costume/References/figure-detail/robe-edge-detail.jpg',
    tile: 5,
    linkedItemId: 'han-scholar-robe',
  },
  {
    id: 'img-cap-01',
    caption: '武官冠帽与盔形展示',
    imageType: '文物照片',
    sourceType: '内部整理',
    referencePurpose: '形制参考',
    tags: ['冠帽', '盔', '武官'],
    svnPath: '/Costume/ThreeKingdoms/headwear/officer-cap.jpg',
    tile: 6,
    linkedItemId: 'han-cap-system',
  },
  {
    id: 'img-belt-01',
    caption: '腰带、系结与袍服叠层关系',
    imageType: '现代复原图',
    sourceType: '现代汉服博主',
    referencePurpose: '复原参考',
    tags: ['腰带', '系结', '叠穿'],
    svnPath: '/Costume/References/hanfu/belt-layering.jpg',
    tile: 7,
    linkedItemId: 'han-scholar-robe',
  },
]

export const collectionItems: CollectionItem[] = [
  {
    id: 'han-scholar-robe',
    title: '东汉末文官袍服（宽袍大袖）',
    summary: '士人及州郡僚属常见的宽袍轮廓，多用于官员日常服饰与宴饮形象参考。',
    shortNote:
      '重点关注宽袖、衣缘包边、腰带位置和内外层次。现代复原图适合理解穿着关系，画像砖与线稿可作为结构和时代线索交叉参考。',
    period: '东汉末',
    startYear: 180,
    endYear: 220,
    timelineLabel: '约 180-220',
    timelineEnabled: true,
    timelineWeight: 86,
    identityTypes: ['文官', '士人'],
    officialTypes: ['文官', '州郡官'],
    costumeCategories: ['袍服', '腰带', '冠帽'],
    regions: ['中原', '荆州'],
    sourceTypes: ['现代书籍', '服饰复原作者', '内部整理'],
    referencePurposes: ['复原参考', '研究线索'],
    usageHints: ['轮廓参考', '穿搭理解', '材质参考'],
    tags: ['宽袍', '大袖', '冠帻', '日常服'],
    imageIds: ['img-robe-01', 'img-pattern-01', 'img-detail-01', 'img-belt-01'],
    updatedAt: '2026-06-04',
    status: 'active',
  },
  {
    id: 'wei-armor',
    title: '曹魏武官甲胄与披挂',
    summary: '面向武官与将军角色的甲胄轮廓、肩部披挂、腰部束带及靴履关系。',
    shortNote:
      '适合用于 3D 人台、角色设定和手办细节拆解。甲片叠压与肩部结构可作为设计转化参考，不直接替代史实依据。',
    period: '魏',
    startYear: 220,
    endYear: 265,
    timelineLabel: '约 220-265',
    timelineEnabled: true,
    timelineWeight: 80,
    identityTypes: ['武官', '武将'],
    officialTypes: ['武官', '将军'],
    costumeCategories: ['甲胄', '披挂', '鞋履'],
    regions: ['中原', '关中'],
    sourceTypes: ['内部整理', '模型作者', '手办作者'],
    referencePurposes: ['设计转化参考', '细节工艺参考'],
    usageHints: ['结构参考', '局部细节参考', '材质参考'],
    tags: ['札甲', '肩甲', '军服', '披挂'],
    imageIds: ['img-armor-01', 'img-cap-01'],
    updatedAt: '2026-06-03',
    status: 'active',
  },
  {
    id: 'han-brick-figures',
    title: '东汉画像砖人物服饰',
    summary: '画像砖中的人物衣褶、冠帻、站姿与社会身份线索，适合做史实依据入口。',
    shortNote:
      '该类资料图像信息有限，但来源性质清晰。建议优先用于时代氛围、服饰大轮廓和冠帻形制判断，再与其他资料交叉。',
    period: '东汉',
    startYear: 120,
    endYear: 190,
    timelineLabel: '约 120-190',
    timelineEnabled: true,
    timelineWeight: 72,
    identityTypes: ['士人', '侍从 / 仪仗'],
    officialTypes: ['无明确官职'],
    costumeCategories: ['袍服', '冠帽', '纹样'],
    regions: ['山东', '中原'],
    sourceTypes: ['出土文物图像', '博物馆馆藏'],
    referencePurposes: ['史实依据', '研究线索'],
    usageHints: ['形制参考', '图像表现', '名词参考'],
    tags: ['画像砖', '衣褶', '冠帻', '仪仗'],
    imageIds: ['img-brick-01'],
    updatedAt: '2026-05-31',
    status: 'active',
  },
  {
    id: 'han-cap-system',
    title: '汉末冠帽与身份形象索引',
    summary: '整理冠帻、武官盔形、士人头部形象和陶俑头像资料，便于角色头部设定检索。',
    shortNote:
      '冠帽资料需要同时看文献名词、出土图像和现代复原。条目当前用于索引和快速分流，后续可拆成更细专题。',
    period: '汉晋过渡',
    startYear: 180,
    endYear: 280,
    timelineLabel: '约 180-280',
    timelineEnabled: true,
    timelineWeight: 88,
    identityTypes: ['文官', '武官', '士人'],
    officialTypes: ['文官', '武官', '无明确官职'],
    costumeCategories: ['冠帽', '发式'],
    regions: ['中原', '江东'],
    sourceTypes: ['博物馆馆藏', '内部整理'],
    referencePurposes: ['史实依据', '形制参考'],
    usageHints: ['名词参考', '局部细节参考'],
    tags: ['冠帻', '盔', '陶俑', '头部'],
    imageIds: ['img-figurine-01', 'img-cap-01'],
    updatedAt: '2026-05-29',
    status: 'active',
  },
  {
    id: 'jinxian-cap',
    title: '进贤冠',
    summary: '汉代官员冠制之一，形制简洁，前高后低，冠体以漆纱或葛制，饰以金线或皮条纹。',
    shortNote:
      '进贤冠适合作为文官身份识别的核心参照，需结合制度文献、画像资料和复原形制交叉判断。',
    period: '东汉',
    startYear: 120,
    endYear: 220,
    timelineLabel: '约 120-220',
    timelineEnabled: true,
    timelineWeight: 95,
    identityTypes: ['文官', '士人'],
    officialTypes: ['文官'],
    costumeCategories: ['冠帽'],
    regions: ['中原'],
    sourceTypes: ['现代书籍', '内部整理'],
    referencePurposes: ['史实依据', '文献记录'],
    usageHints: ['形制参考', '身份参考'],
    tags: ['冠帽', '文官', '进贤冠'],
    imageIds: ['img-cap-01', 'img-figurine-01'],
    updatedAt: '2026-06-05',
    status: 'active',
  },
  {
    id: 'wei-civil-robe',
    title: '曹魏文官常服',
    summary: '曹魏时期常见文官常服，衣襟右衽，通袖宽袍，适合观察汉末至魏晋服饰轮廓延续。',
    shortNote:
      '该条目用于时间线代表卡，优先帮助比较东汉末宽袍与魏晋常服在廓形、束带和冠服组合上的变化。',
    period: '魏',
    startYear: 220,
    endYear: 265,
    timelineLabel: '约 220-265',
    timelineEnabled: true,
    timelineWeight: 92,
    identityTypes: ['文官', '士人'],
    officialTypes: ['文官'],
    costumeCategories: ['袍服', '冠帽'],
    regions: ['中原'],
    sourceTypes: ['现代书籍', '内部整理'],
    referencePurposes: ['文献记录', '复原参考'],
    usageHints: ['轮廓参考', '穿搭理解'],
    tags: ['文官', '常服', '袍服'],
    imageIds: ['img-robe-01', 'img-pattern-01'],
    updatedAt: '2026-06-05',
    status: 'active',
  },
  {
    id: 'shu-civil-cap',
    title: '蜀汉文官冠服',
    summary: '以汉制延续为基础整理蜀汉文官冠服线索，用于区分地域政权与身份场景。',
    shortNote:
      '资料以索引和设计参考为主，适合在时间线上承接汉末文官形象并提示蜀汉地域语境。',
    period: '蜀',
    startYear: 221,
    endYear: 263,
    timelineLabel: '约 221-263',
    timelineEnabled: true,
    timelineWeight: 78,
    identityTypes: ['文官', '士人'],
    officialTypes: ['文官'],
    costumeCategories: ['冠帽', '袍服'],
    regions: ['益州', '蜀地'],
    sourceTypes: ['内部整理', '现代书籍'],
    referencePurposes: ['研究线索', '复原参考'],
    usageHints: ['身份参考', '地域参考'],
    tags: ['蜀汉', '文官', '冠服'],
    imageIds: ['img-figurine-01', 'img-robe-01'],
    updatedAt: '2026-06-05',
    status: 'active',
  },
  {
    id: 'wu-short-armor',
    title: '吴国短甲',
    summary: '孙吴军吏与武将形象中的轻便短甲，用于水战、行军和近身行动场景参考。',
    shortNote:
      '短甲条目偏向设计转化，需与出土图像和地域资料交叉，不作为单一史实结论。',
    period: '吴',
    startYear: 222,
    endYear: 280,
    timelineLabel: '约 222-280',
    timelineEnabled: true,
    timelineWeight: 82,
    identityTypes: ['武官', '武将'],
    officialTypes: ['武官', '将军'],
    costumeCategories: ['甲胄', '披挂'],
    regions: ['江东'],
    sourceTypes: ['内部整理', '模型作者'],
    referencePurposes: ['设计转化参考', '细节工艺参考'],
    usageHints: ['结构参考', '场景参考'],
    tags: ['吴国', '短甲', '甲胄'],
    imageIds: ['img-armor-01'],
    updatedAt: '2026-06-05',
    status: 'active',
  },
  {
    id: 'three-kingdoms-general-armor',
    title: '三国武将铠甲',
    summary: '三国时期武将常用甲胄形制，兼具防护与身份展示，适合建立武将基础轮廓。',
    shortNote:
      '作为跨政权武将甲胄代表条目，主要服务时间线比较与角色设定，不替代更细的魏、蜀、吴分区资料。',
    period: '三国',
    startYear: 220,
    endYear: 280,
    timelineLabel: '约 220-280',
    timelineEnabled: true,
    timelineWeight: 90,
    identityTypes: ['武官', '武将'],
    officialTypes: ['武官', '将军'],
    costumeCategories: ['甲胄', '披挂'],
    regions: ['中原', '江东', '蜀地'],
    sourceTypes: ['内部整理', '模型作者'],
    referencePurposes: ['设计转化参考', '复原参考'],
    usageHints: ['结构参考', '角色设定'],
    tags: ['三国', '武将', '铠甲'],
    imageIds: ['img-armor-01', 'img-cap-01'],
    updatedAt: '2026-06-05',
    status: 'active',
  },
  {
    id: 'western-jin-portrait-clothing',
    title: '画像砖人物服饰',
    summary: '画像砖中人物所见冠帽与服饰形象，反映汉晋之间服制与社会身份风貌。',
    shortNote:
      '图像资料可用于确认人物比例、服饰大轮廓和冠帽关系，适合作为时间线末端的图像证据入口。',
    period: '西晋初',
    startYear: 265,
    endYear: 316,
    timelineLabel: '约 265-316',
    timelineEnabled: true,
    timelineWeight: 84,
    identityTypes: ['文官', '士人'],
    officialTypes: ['文官', '无明确官职'],
    costumeCategories: ['冠帽', '袍服', '纹样'],
    regions: ['中原'],
    sourceTypes: ['出土文物图像', '博物馆馆藏'],
    referencePurposes: ['图像资料', '史实依据'],
    usageHints: ['图像表现', '形制参考'],
    tags: ['画像砖', '冠帽', '服饰'],
    imageIds: ['img-brick-01'],
    updatedAt: '2026-06-05',
    status: 'active',
  },
]

export const filterGroups = {
  period: TIMELINE_EDITOR_PERIOD_OPTIONS.map((period) => period.value),
  identityTypes: ['文官', '武官', '武将', '士人', '侍从 / 仪仗'],
  costumeCategories: ['袍服', '甲胄', '冠帽', '披挂', '腰带', '纹样'],
  referencePurposes: ['史实依据', '研究线索', '复原参考', '细节工艺参考', '设计转化参考', '文献记录', '图像资料'],
}
