import { Suspense, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, Html, OrbitControls } from '@react-three/drei'
import {
  Bell,
  BookOpen,
  Boxes,
  Camera,
  ChevronRight,
  Clock3,
  Copy,
  FilePenLine,
  Grid3X3,
  ImageIcon,
  Layers3,
  List,
  Menu,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Shield,
  UserRound,
  X,
} from 'lucide-react'
import './App.css'
import { assets, collectionItems, filterGroups, type Asset, type CollectionItem } from './data'
import { PERIOD_ORDER, buildTimelineResponse, type TimelineCardItem, type TimelineQuery } from './timeline'

type View = 'home' | 'library' | 'images' | 'timeline' | 'detail' | 'edit'
type EditorMode = 'new' | 'edit' | 'duplicate'
const uniqueValues = (values: string[]) => Array.from(new Set(values))
const defaultView: View = 'home'
const defaultSelectedItemId = collectionItems[0].id
const pageStateKey = 'sanguo-costume-archive:page-state'
const views = new Set<View>(['home', 'library', 'images', 'timeline', 'detail', 'edit'])

type PageState = {
  view: View
  selectedItemId: string
}

function isView(value: unknown): value is View {
  return typeof value === 'string' && views.has(value as View)
}

function readPageState(): PageState {
  if (typeof window === 'undefined') {
    return { view: defaultView, selectedItemId: defaultSelectedItemId }
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

const facetOptions = {
  period: filterGroups.period,
  identityTypes: filterGroups.identityTypes,
  officialTypes: uniqueValues(collectionItems.flatMap((item) => item.officialTypes)),
  costumeCategories: filterGroups.costumeCategories,
  sourceTypes: uniqueValues(collectionItems.flatMap((item) => item.sourceTypes)),
  referencePurposes: filterGroups.referencePurposes,
  usageHints: uniqueValues(collectionItems.flatMap((item) => item.usageHints)),
  tags: uniqueValues(collectionItems.flatMap((item) => item.tags)),
} as const

type FilterKey = keyof typeof facetOptions
type FilterState = Record<FilterKey, string[]>

const facetSections: Array<{ key: FilterKey; title: string }> = [
  { key: 'period', title: '时代' },
  { key: 'identityTypes', title: '身份类型' },
  { key: 'officialTypes', title: '职官类型' },
  { key: 'costumeCategories', title: '服装类别' },
  { key: 'sourceTypes', title: '来源类型' },
  { key: 'referencePurposes', title: '参考性质' },
  { key: 'usageHints', title: '使用用途' },
  { key: 'tags', title: '标签' },
]

const navItems: { view: View; label: string }[] = [
  { view: 'home', label: '首页' },
  { view: 'library', label: '资料库' },
  { view: 'images', label: '图片库' },
  { view: 'timeline', label: '时间线' },
]

const tilePosition = (tile: number) => {
  const col = tile % 4
  const row = tile > 3 ? 1 : 0
  return `${col * 33.333}% ${row * 100}%`
}

function AssetThumb({ asset, className = '' }: { asset: Asset; className?: string }) {
  return (
    <div
      className={`asset-thumb ${className}`}
      style={{ backgroundPosition: tilePosition(asset.tile) }}
      role="img"
      aria-label={asset.caption}
    />
  )
}

function MuseumModel() {
  return (
    <group position={[0, -1.15, 0]} rotation={[0, -0.25, 0]}>
      <mesh position={[0, -0.08, 0]} receiveShadow>
        <cylinderGeometry args={[1.25, 1.35, 0.2, 64]} />
        <meshStandardMaterial color="#b6aa96" roughness={0.75} />
      </mesh>
      <mesh position={[0, 1.75, 0]} castShadow>
        <sphereGeometry args={[0.28, 32, 32]} />
        <meshStandardMaterial color="#d8c7b1" roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.28, 0]} castShadow>
        <cylinderGeometry args={[0.34, 0.48, 0.9, 32]} />
        <meshStandardMaterial color="#7b3d28" roughness={0.62} />
      </mesh>
      <mesh position={[0, 0.65, 0]} castShadow>
        <boxGeometry args={[0.98, 1.05, 0.28]} />
        <meshStandardMaterial color="#665a4c" metalness={0.06} roughness={0.54} />
      </mesh>
      <mesh position={[0, 0.67, 0.16]} castShadow>
        <boxGeometry args={[0.9, 0.96, 0.12]} />
        <meshStandardMaterial color="#9b927f" metalness={0.28} roughness={0.46} />
      </mesh>
      {[-0.37, 0, 0.37].map((x) => (
        <mesh key={x} position={[x, 0.8, 0.25]} castShadow>
          <boxGeometry args={[0.24, 0.72, 0.1]} />
          <meshStandardMaterial color="#d0c2a8" metalness={0.38} roughness={0.44} />
        </mesh>
      ))}
      {[-0.72, 0.72].map((x) => (
        <group key={x} position={[x, 0.73, 0]} rotation={[0, 0, x > 0 ? -0.18 : 0.18]}>
          <mesh castShadow>
            <boxGeometry args={[0.32, 0.86, 0.24]} />
            <meshStandardMaterial color="#726755" metalness={0.22} roughness={0.5} />
          </mesh>
          <mesh position={[x > 0 ? 0.05 : -0.05, -0.45, 0.02]} castShadow>
            <cylinderGeometry args={[0.12, 0.13, 0.68, 18]} />
            <meshStandardMaterial color="#713421" roughness={0.7} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.1, 0.03]} castShadow>
        <cylinderGeometry args={[0.58, 0.5, 0.18, 32]} />
        <meshStandardMaterial color="#4d3828" roughness={0.72} />
      </mesh>
      <mesh position={[-0.23, -0.56, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.15, 1.05, 20]} />
        <meshStandardMaterial color="#251d18" roughness={0.78} />
      </mesh>
      <mesh position={[0.23, -0.56, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.15, 1.05, 20]} />
        <meshStandardMaterial color="#251d18" roughness={0.78} />
      </mesh>
      <mesh position={[0, 1.4, 0.03]} castShadow>
        <torusGeometry args={[0.43, 0.025, 12, 48]} />
        <meshStandardMaterial color="#38251d" roughness={0.66} />
      </mesh>
    </group>
  )
}

function FeaturedScene() {
  return (
    <div className="model-shell">
      <Canvas camera={{ position: [0, 1.15, 4.2], fov: 38 }} shadows>
        <color attach="background" args={['#d9d1c3']} />
        <ambientLight intensity={0.62} />
        <directionalLight position={[3, 4, 3]} intensity={2.2} castShadow />
        <spotLight position={[-2.5, 3.5, 2]} intensity={1.35} angle={0.45} penumbra={0.55} />
        <Suspense
          fallback={
            <Html center>
              <span className="loading-chip">Loading</span>
            </Html>
          }
        >
          <MuseumModel />
          <Environment preset="city" />
        </Suspense>
        <OrbitControls enablePan={false} minDistance={3.3} maxDistance={5.6} autoRotate autoRotateSpeed={0.9} />
      </Canvas>
    </div>
  )
}

function App() {
  const initialPageState = useMemo(() => readPageState(), [])
  const [view, setView] = useState<View>(initialPageState.view)
  const [query, setQuery] = useState('')
  const [selectedItemId, setSelectedItemId] = useState(initialPageState.selectedItemId)
  const [lightboxAsset, setLightboxAsset] = useState<Asset | null>(null)
  const [toastMessage, setToastMessage] = useState('')
  const [listMode, setListMode] = useState<'list' | 'grid'>('list')
  const [editorState, setEditorState] = useState<{ mode: EditorMode; sourceItemId?: string }>({ mode: 'new' })
  const [filters, setFilters] = useState<FilterState>({
    period: [],
    identityTypes: [],
    officialTypes: [],
    costumeCategories: [],
    sourceTypes: [],
    referencePurposes: [],
    usageHints: [],
    tags: [],
  })

  useEffect(() => {
    try {
      window.sessionStorage.setItem(pageStateKey, JSON.stringify({ view, selectedItemId }))
    } catch {
      // Ignore storage failures so blocked session storage does not break navigation.
    }
  }, [selectedItemId, view])

  const selectedItem = collectionItems.find((item) => item.id === selectedItemId) ?? collectionItems[0]
  const editorSourceItem = editorState.sourceItemId
    ? collectionItems.find((item) => item.id === editorState.sourceItemId)
    : undefined

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return collectionItems.filter((item) => {
      const searchable = [
        item.title,
        item.summary,
        item.shortNote,
        item.period,
        ...item.identityTypes,
        ...item.officialTypes,
        ...item.costumeCategories,
        ...item.regions,
        ...item.sourceTypes,
        ...item.referencePurposes,
        ...item.tags,
      ]
        .join(' ')
        .toLowerCase()
      const matchesQuery = !q || q.split(/\s+/).every((term) => searchable.includes(term))
      const matchesFilters = (Object.keys(filters) as FilterKey[]).every((key) => {
        const active = filters[key]
        if (!active.length) return true
        return active.some((value) => getItemFacetValues(item, key).includes(value))
      })
      return matchesQuery && matchesFilters
    })
  }, [filters, query])

  const visibleAssets = useMemo(() => {
    const itemIds = new Set(results.map((item) => item.id))
    return assets.filter((asset) => itemIds.has(asset.linkedItemId) || !query.trim())
  }, [query, results])

  const openDetail = (id: string) => {
    setSelectedItemId(id)
    setView('detail')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const openEditor = (mode: EditorMode, sourceItem?: CollectionItem) => {
    setEditorState({ mode, sourceItemId: sourceItem?.id })
    setView('edit')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggleFilter = (key: FilterKey, value: string) => {
    setFilters((current) => {
      const active = current[key]
      return {
        ...current,
        [key]: active.includes(value) ? active.filter((item) => item !== value) : [...active, value],
      }
    })
  }

  const notify = (message: string) => {
    setToastMessage(message)
    window.setTimeout(() => setToastMessage(''), 1800)
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify('路径已复制')
    } catch {
      notify('复制失败，请手动复制')
    }
  }

  return (
    <div className="app">
      <Header view={view} setView={setView} />
      {view === 'home' && <Home setView={setView} setQuery={setQuery} openDetail={openDetail} />}
      {view === 'library' && (
        <Library
          query={query}
          setQuery={setQuery}
          results={results}
          filters={filters}
          toggleFilter={toggleFilter}
          listMode={listMode}
          setListMode={setListMode}
          openDetail={openDetail}
          startNewItem={() => openEditor('new')}
        />
      )}
      {view === 'images' && (
        <ImageLibrary visibleAssets={visibleAssets} setLightboxAsset={setLightboxAsset} openDetail={openDetail} />
      )}
      {view === 'timeline' && <Timeline openDetail={openDetail} />}
      {view === 'detail' && (
        <Detail
          item={selectedItem}
          setLightboxAsset={setLightboxAsset}
          setView={setView}
          editItem={() => openEditor('edit', selectedItem)}
          duplicateItem={() => openEditor('duplicate', selectedItem)}
          openDetail={openDetail}
          copyText={copyText}
        />
      )}
      {view === 'edit' && <Editor mode={editorState.mode} sourceItem={editorSourceItem} setView={setView} />}
      {lightboxAsset && (
        <Lightbox
          asset={lightboxAsset}
          close={() => setLightboxAsset(null)}
          openDetail={openDetail}
          copyText={copyText}
        />
      )}
      <Toast message={toastMessage} />
    </div>
  )
}

function Header({ view, setView }: { view: View; setView: (view: View) => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const activeView = view === 'detail' || view === 'edit' ? 'library' : view
  const go = (nextView: View) => {
    setView(nextView)
    setMenuOpen(false)
  }

  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={() => go('home')}>
        <img className="brand-logo" src="/costume-library-logo.png" alt="" aria-hidden="true" />
        <span>
          <strong>三国服装资料资源库</strong>
          <small>THREE KINGDOMS COSTUME LIBRARY</small>
        </span>
      </button>
      <nav>
        {navItems.map((item) => (
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
        <div className="top-search" role="search">
          <Search size={18} />
          <input aria-label="全局搜索" placeholder="搜索服装、器物、画像砖等..." />
        </div>
        <button className="icon-button notify-button" type="button" aria-label="通知">
          <Bell size={19} />
          <span />
        </button>
        <button className="profile-button" type="button" aria-label="成员入口">
          <UserRound size={18} />
        </button>
        <button
          className="icon-button compact-menu"
          type="button"
          aria-label="菜单"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Menu size={18} />
        </button>
      </div>
      {menuOpen && (
        <div className="mobile-nav">
          {navItems.map((item) => (
          <button
            key={item.view}
            className={activeView === item.view ? 'active' : ''}
            type="button"
            onClick={() => go(item.view)}
          >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </header>
  )
}

function Home({
  setView,
  setQuery,
  openDetail,
}: {
  setView: (view: View) => void
  setQuery: (query: string) => void
  openDetail: (id: string) => void
}) {
  const quickLinks = [
    ['文官', BookOpen],
    ['武官', Shield],
    ['甲胄', Boxes],
    ['冠帽', UserRound],
    ['袍服', Layers3],
    ['画像砖', Camera],
  ] as const

  return (
    <main>
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">Three Kingdoms Costume Reference Library</p>
          <h1>三国服装资料资源库</h1>
          <p className="hero-subtitle">
            以数字馆藏方式整理东汉末至三国时期服装、冠帽、甲胄与人物形象资料。
          </p>
          <form
            className="hero-search"
            onSubmit={(event) => {
              event.preventDefault()
              setView('library')
            }}
          >
            <Search size={19} />
            <input
              defaultValue="东汉末 文官 袍服"
              aria-label="搜索资料"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索服装、身份、职官、时代、图片或 SVN 文件名"
            />
            <button type="submit">检索</button>
          </form>
          <div className="hero-actions">
            <button type="button" onClick={() => setView('library')}>
              进入资料库
              <ChevronRight size={17} />
            </button>
            <button type="button" className="secondary" onClick={() => setView('timeline')}>
              查看时间线
            </button>
          </div>
          <div className="quick-entry" aria-label="快速入口">
            {quickLinks.map(([label, Icon]) => (
              <button
                type="button"
                key={label}
                onClick={() => {
                  setQuery(label)
                  setView(label === '画像砖' ? 'images' : 'library')
                }}
              >
                <Icon size={20} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="hero-model">
          <FeaturedScene />
          <div className="model-caption">
            <span>曹魏武官甲胄</span>
            <p>札甲、披挂、腰带与靴履关系</p>
            <button type="button" onClick={() => openDetail('wei-armor')}>
              查看对应资料
            </button>
          </div>
        </div>
      </section>
      <section className="home-band">
        <Stat label="条目" value="128" />
        <Stat label="图片资产" value="842" />
        <Stat label="来源类型" value="18" />
        <Stat label="SVN 目录" value="36" />
      </section>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function Library({
  query,
  setQuery,
  results,
  filters,
  toggleFilter,
  listMode,
  setListMode,
  openDetail,
  startNewItem,
}: {
  query: string
  setQuery: (query: string) => void
  results: CollectionItem[]
  filters: FilterState
  toggleFilter: (key: FilterKey, value: string) => void
  listMode: 'list' | 'grid'
  setListMode: (mode: 'list' | 'grid') => void
  openDetail: (id: string) => void
  startNewItem: () => void
}) {
  const [expandedSections, setExpandedSections] = useState<Partial<Record<FilterKey, boolean>>>({})
  const activeFilters = (Object.keys(filters) as FilterKey[]).flatMap((key) =>
    filters[key].map((value) => ({ key, value })),
  )
  const suggestedFilters = [
    { key: 'period' as FilterKey, value: facetOptions.period[1] ?? facetOptions.period[0] },
    { key: 'identityTypes' as FilterKey, value: facetOptions.identityTypes[0] },
    { key: 'costumeCategories' as FilterKey, value: facetOptions.costumeCategories[0] },
  ].filter((item) => item.value)
  const visiblePills = activeFilters.length ? activeFilters : suggestedFilters
  const hasActiveCriteria = Boolean(query.trim() || activeFilters.length)
  const displayResults = hasActiveCriteria ? results : collectionItems
  const visualResults = hasActiveCriteria ? displayResults : collectionItems.slice(0, 5)
  const isEmptySearch = hasActiveCriteria && displayResults.length === 0
  const clearFilters = () => {
    setQuery('')
    activeFilters.forEach(({ key, value }) => toggleFilter(key, value))
  }

  return (
    <main className="library-page">
      <aside className="library-filters">
        <div className="filter-head">
          <h2>筛选条件</h2>
          <button type="button" className="filter-clear" onClick={clearFilters}>清空</button>
        </div>
        {facetSections.map((section) => (
          <FilterSection
            key={section.key}
            section={section}
            filters={filters}
            expanded={Boolean(expandedSections[section.key])}
            toggleFilter={toggleFilter}
            toggleExpanded={() =>
              setExpandedSections((current) => ({
                ...current,
                [section.key]: !current[section.key],
              }))
            }
          />
        ))}
      </aside>
      <section className="library-results-pane">
        <div className="library-page-head">
          <div>
            <p className="eyebrow">Archive Index</p>
            <h1>资料库</h1>
          </div>
          <button type="button" className="new-item-button" onClick={startNewItem}>
            <Plus size={17} />
            新建资料
          </button>
        </div>
        <SearchRow query={query} setQuery={setQuery} placeholder="搜索服装、身份、职官、时代、图片或 SVN 文件路径..." />
        <div className="active-filter-row" aria-label="筛选快捷项">
          {visiblePills.map((pill) => (
            <button
              type="button"
              className={activeFilters.length ? 'filter-chip active' : 'filter-chip'}
              key={`${pill.key}-${pill.value}`}
              onClick={() => toggleFilter(pill.key, pill.value)}
            >
              {pill.value}
              <X size={13} />
            </button>
          ))}
          <button type="button" className="filter-clear-inline" onClick={clearFilters}>清空全部</button>
        </div>
        <div className="library-toolbar">
          <span>共 {hasActiveCriteria ? displayResults.length : 126} 条结果</span>
          <div className="toolbar-actions">
            <label>
              排序：
              <select aria-label="相关度排序">
                <option>相关度</option>
                <option>最近更新</option>
                <option>年代</option>
              </select>
            </label>
            <select aria-label="最近更新筛选">
              <option>最近更新</option>
              <option>一周内</option>
              <option>一月内</option>
            </select>
            <select aria-label="年代排序">
              <option>年代</option>
              <option>由早到晚</option>
              <option>由晚到早</option>
            </select>
            <button
              className={listMode === 'list' ? 'icon-button view-toggle active' : 'icon-button view-toggle'}
              type="button"
              onClick={() => setListMode('list')}
              aria-label="列表视图"
            >
              <List size={17} />
            </button>
            <button
              className={listMode === 'grid' ? 'icon-button view-toggle active' : 'icon-button view-toggle'}
              type="button"
              onClick={() => setListMode('grid')}
              aria-label="网格视图"
            >
              <Grid3X3 size={17} />
            </button>
          </div>
        </div>
        {isEmptySearch ? (
          <EmptyLibraryResults startNewItem={startNewItem} clearFilters={clearFilters} />
        ) : (
          <>
            <div className={listMode === 'list' ? 'result-list' : 'result-grid'}>
              {visualResults.map((item, index) => (
                <ResultItem
                  key={`${item.id}-${index}`}
                  item={item}
                  mode={listMode}
                  openDetail={openDetail}
                  index={index}
                />
              ))}
            </div>
            <div className="library-pagination" aria-label="分页">
              <button type="button" className="secondary-control" disabled>
                <ChevronRight size={16} className="pager-prev-icon" />
              </button>
              <button type="button" className="pager-page active">
                1
              </button>
              <button type="button" className="pager-page">
                2
              </button>
              <button type="button" className="pager-page">
                3
              </button>
              <span>...</span>
              <select aria-label="每页数量">
                <option>20 条/页</option>
                <option>40 条/页</option>
              </select>
            </div>
          </>
        )}
      </section>
    </main>
  )
}

function EmptyLibraryResults({
  startNewItem,
  clearFilters,
}: {
  startNewItem: () => void
  clearFilters: () => void
}) {
  return (
    <section className="empty-results" aria-label="空搜索结果">
      <Search size={24} />
      <h2>没有找到匹配资料</h2>
      <p>可以调整关键词或筛选条件，也可以直接新建一条资料。</p>
      <div>
        <button type="button" onClick={startNewItem}>
          <Plus size={17} />
          新建资料
        </button>
        <button type="button" className="secondary-control" onClick={clearFilters}>
          清空条件
        </button>
      </div>
    </section>
  )
}

function getItemFacetValues(item: CollectionItem, key: FilterKey): string[] {
  if (key === 'period') return [item.period]
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
  const visibleOptions = expanded ? options : options.slice(0, 4)
  const sectionIndex = facetSections.findIndex((item) => item.key === section.key) + 1

  return (
    <div className={expanded ? 'filter-group expanded' : 'filter-group'}>
      <button type="button" className="filter-group-title" onClick={toggleExpanded}>
        <h3>{sectionIndex}. {section.title}</h3>
        <span>{expanded ? '-' : '+'}</span>
      </button>
      {expanded && (
        <div className="filter-options">
          {visibleOptions.map((value) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={filters[section.key].includes(value)}
                onChange={() => toggleFilter(section.key, value)}
              />
              <span>{value}</span>
              <small>{collectionItems.filter((item) => getItemFacetValues(item, section.key).includes(value)).length}</small>
            </label>
          ))}
          {options.length > 4 && (
            <button type="button" className="filter-more" onClick={toggleExpanded}>
              收起筛选
            </button>
          )}
        </div>
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

function ResultItem({
  item,
  mode,
  openDetail,
  index,
}: {
  item: CollectionItem
  mode: 'list' | 'grid'
  openDetail: (id: string) => void
  index: number
}) {
  const cover = assets.find((asset) => asset.id === item.imageIds[0]) ?? assets[0]
  const pathParts = [
    item.period,
    item.identityTypes[0],
    item.officialTypes[0],
    item.costumeCategories[0],
  ].filter(Boolean)
  const imageCounts = [12, 18, 28, 16, 9]
  const sourceBadge = item.referencePurposes.includes('史实依据') ? '史实依据' : item.referencePurposes[0]

  return (
    <article
      className={mode === 'list' ? 'result-item' : 'result-card'}
      style={{ animationDelay: `${Math.min(index, 8) * 42}ms` }}
    >
      <button type="button" className="result-cover" onClick={() => openDetail(item.id)}>
        <AssetThumb asset={cover} />
      </button>
      <div className="result-body">
        <button type="button" className="title-button" onClick={() => openDetail(item.id)}>
          {item.title.replace('（宽袍大袖）', '')}
        </button>
        <p>{item.summary}</p>
        <div className="result-path">
          {pathParts.map((part, pathIndex) => (
            <span key={`${part}-${pathIndex}`}>{part}</span>
          ))}
        </div>
        <TagRow tags={item.tags.slice(0, 5)} />
      </div>
      <aside className="result-meta">
        <strong>{imageCounts[index % imageCounts.length]} 张图片</strong>
        <span className={sourceBadge === '史实依据' ? 'evidence-badge' : 'reference-badge'}>{sourceBadge}</span>
      </aside>
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
}: {
  visibleAssets: Asset[]
  setLightboxAsset: (asset: Asset) => void
  openDetail: (id: string) => void
}) {
  const [imageQuery, setImageQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<string[]>(['甲胄', '画像砖', '史实依据'])
  const [filtersTouched, setFiltersTouched] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const allowedAssetIds = new Set(visibleAssets.map((asset) => asset.id))
  const imageCards = galleryCards
    .filter((card) => allowedAssetIds.size === 0 || allowedAssetIds.has(card.asset.id))
    .filter((card) => {
      const q = imageQuery.trim().toLowerCase()
      const searchable = [card.title, card.relation, card.asset.caption, ...card.tags, ...card.filters].join(' ').toLowerCase()
      const matchesQuery = !q || q.split(/\s+/).every((term) => searchable.includes(term))
      const matchesFilters =
        !filtersTouched || !activeFilters.length || activeFilters.some((filter) => card.filters.includes(filter))
      return matchesQuery && matchesFilters
    })
  const visibleImageCards = imageCards.length ? imageCards : galleryCards.slice(0, 12)
  const toggleGalleryFilter = (value: string) => {
    setFiltersTouched(true)
    setActiveFilters((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    )
  }
  const clearGalleryFilters = () => {
    setFiltersTouched(true)
    setActiveFilters([])
  }

  return (
    <main className="gallery-page">
      <aside className="gallery-filters">
        <div className="gallery-filter-head">
          <h2>筛选条件</h2>
          <button type="button" className="gallery-filter-clear" onClick={clearGalleryFilters}>
            清空
          </button>
        </div>
        {galleryFilterSections.map((section) => (
          <GalleryFilterSection
            key={section.title}
            section={section}
            activeFilters={activeFilters}
            toggleFilter={toggleGalleryFilter}
          />
        ))}
        <button type="button" className="gallery-collapse-filter">
          <ChevronRight size={15} />
          收起筛选
        </button>
      </aside>

      <section className="gallery-results">
        <div className="gallery-search-row">
          <Search size={22} />
          <input
            value={imageQuery}
            onChange={(event) => setImageQuery(event.target.value)}
            placeholder="搜索图片说明、标签、来源或 SVN 文件名..."
          />
        </div>

        <div className="gallery-chip-row" aria-label="图片筛选快捷项">
          {activeFilters.slice(0, 6).map((filter) => (
            <button type="button" className="gallery-chip" key={filter} onClick={() => toggleGalleryFilter(filter)}>
              {filter}
              <X size={13} />
            </button>
          ))}
          <button type="button" className="gallery-filter-clear" onClick={clearGalleryFilters}>
            清空全部
          </button>
        </div>

        <div className="gallery-toolbar">
          <span>共 248 张图片</span>
          <div className="gallery-sort-actions">
            <label>
              排序：
              <select aria-label="图片排序">
                <option>最近更新</option>
                <option>相关度</option>
                <option>来源年代</option>
              </select>
            </label>
            <button
              type="button"
              className={viewMode === 'grid' ? 'icon-button gallery-view-toggle active' : 'icon-button gallery-view-toggle'}
              aria-label="网格视图"
              onClick={() => setViewMode('grid')}
            >
              <Grid3X3 size={18} />
            </button>
            <button
              type="button"
              className={viewMode === 'list' ? 'icon-button gallery-view-toggle active' : 'icon-button gallery-view-toggle'}
              aria-label="列表视图"
              onClick={() => setViewMode('list')}
            >
              <List size={18} />
            </button>
          </div>
        </div>

        <section className={viewMode === 'grid' ? 'asset-grid' : 'asset-grid gallery-list-mode'}>
          {visibleImageCards.map((card, index) => (
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
                </div>
                <button type="button" className="gallery-card-detail" onClick={() => openDetail(card.asset.linkedItemId)}>
                  关联条目：{card.relation}
                </button>
              </div>
            </article>
          ))}
        </section>

        <div className="gallery-pagination" aria-label="图片分页">
          <button type="button" className="gallery-page-nav" disabled>
            <ChevronRight size={15} className="pager-prev-icon" />
          </button>
          {[1, 2, 3, 4, 5].map((page) => (
            <button key={page} type="button" className={page === 1 ? 'pager-page active' : 'pager-page'}>
              {page}
            </button>
          ))}
          <span>...</span>
          <button type="button" className="pager-page">
            21
          </button>
          <button type="button" className="gallery-page-nav">
            <ChevronRight size={15} />
          </button>
          <select aria-label="每页图片数量">
            <option>每页 24 张</option>
            <option>每页 48 张</option>
          </select>
        </div>
      </section>
    </main>
  )
}

const defaultTimelineFilters: TimelineQuery = {
  costumeCategory: '冠帽',
  identityType: '文官',
  periodStart: '东汉末',
  periodEnd: '西晋初',
}

const timelinePeriodRanges: Array<{
  label: string
  periodStart?: TimelineQuery['periodStart']
  periodEnd?: TimelineQuery['periodEnd']
}> = [
  { label: '东汉末至西晋初', periodStart: '东汉末', periodEnd: '西晋初' },
  { label: '东汉至西晋初', periodStart: '东汉', periodEnd: '西晋初' },
  { label: '三国时期', periodStart: '魏', periodEnd: '吴' },
  { label: '全部时代' },
]

const getTimelineRangeKey = (query: TimelineQuery) => `${query.periodStart ?? 'all'}-${query.periodEnd ?? 'all'}`

function findTimelineCardById(groups: ReturnType<typeof buildTimelineResponse>['groups'], id?: string) {
  if (!id) return undefined
  return groups.flatMap((group) => group.items).find((item) => item.id === id)
}

function formatTimelineLabel(item: TimelineCardItem) {
  if (item.timelineLabel) return item.timelineLabel
  if (item.startYear && item.endYear) return `约 ${item.startYear}-${item.endYear}`
  if (item.startYear) return `约 ${item.startYear} 起`
  return item.period
}

function getItemCover(itemId: string) {
  const item = collectionItems.find((entry) => entry.id === itemId)
  return assets.find((asset) => asset.id === item?.imageIds[0]) ?? assets[0]
}

type GalleryFilterSectionConfig = {
  title: string
  options: string[]
  expanded?: boolean
}

const galleryFilterSections: GalleryFilterSectionConfig[] = [
  {
    title: '图片类型',
    expanded: true,
    options: ['实物照片', '画像砖拓片', '壁画 / 墓室图像', '文献插图', '手绘复原图'],
  },
  {
    title: '来源类型',
    expanded: true,
    options: ['考古发掘', '文献记录', '博物馆藏', '学术出版', '数字化图像'],
  },
  {
    title: '参考性质',
    expanded: true,
    options: ['史实依据', '复原参考', '细节工艺参考', '设计转化参考'],
  },
  {
    title: '使用用途',
    expanded: true,
    options: ['服装结构参考', '纹饰图案参考', '色彩材质参考', '场景搭配参考'],
  },
  {
    title: '时代',
    options: ['东汉末', '曹魏', '蜀汉', '孙吴'],
  },
  {
    title: '标签',
    options: ['甲胄', '冠饰', '袍服', '带钩', '纹样'],
  },
]

function GalleryFilterSection({
  section,
  activeFilters,
  toggleFilter,
}: {
  section: GalleryFilterSectionConfig
  activeFilters: string[]
  toggleFilter: (value: string) => void
}) {
  const [expanded, setExpanded] = useState(Boolean(section.expanded))

  return (
    <section className="gallery-filter-section">
      <button type="button" className="gallery-filter-toggle" onClick={() => setExpanded((open) => !open)}>
        <ChevronRight size={13} className={expanded ? 'expanded' : ''} />
        <span>{section.title}</span>
      </button>
      {expanded && (
        <div className="gallery-filter-options">
          {section.options.slice(0, section.title === '图片类型' ? 5 : 4).map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={activeFilters.includes(option)}
                onChange={() => toggleFilter(option)}
              />
              <span>{option}</span>
            </label>
          ))}
          {section.options.length > 4 && (
            <button type="button" className="gallery-filter-more">
              + 展开更多
            </button>
          )}
        </div>
      )}
    </section>
  )
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

const assetById = (id: string) => assets.find((asset) => asset.id === id) ?? assets[0]

const galleryCards: GalleryCard[] = [
  {
    id: 'gallery-armor-front',
    asset: assetById('img-armor-01'),
    title: '曹魏武官甲胄（局部）',
    reference: '史实依据',
    relation: '曹魏武官甲胄参考',
    tags: ['甲胄', '实物照片'],
    filters: ['甲胄', '实物照片', '史实依据', '细节工艺参考', '曹魏'],
  },
  {
    id: 'gallery-brick-general',
    asset: assetById('img-brick-01'),
    title: '武将出行画像砖（拓片）',
    reference: '史实依据',
    relation: '曹魏武将出行图像考略',
    tags: ['画像砖', '考古发掘'],
    filters: ['画像砖', '画像砖拓片', '考古发掘', '史实依据', '东汉末'],
  },
  {
    id: 'gallery-wall-servant',
    asset: assetById('img-robe-01'),
    title: '戴冠壁画·侍从图（局部）',
    reference: '复原参考',
    relation: '三国墓室壁画服饰研究',
    tags: ['壁画', '考古发掘'],
    filters: ['壁画 / 墓室图像', '考古发掘', '复原参考', '冠饰'],
  },
  {
    id: 'gallery-cap-figurine',
    asset: assetById('img-figurine-01'),
    title: '陶俑冠饰',
    reference: '史实依据',
    relation: '三国陶俑服饰研究',
    tags: ['冠饰', '实物照片'],
    filters: ['冠饰', '实物照片', '博物馆藏', '史实依据'],
  },
  {
    id: 'gallery-hook',
    asset: assetById('img-detail-01'),
    title: '带钩饰件',
    reference: '细节工艺参考',
    relation: '三国带钩与腰带研究',
    tags: ['配饰', '实物照片'],
    filters: ['实物照片', '博物馆藏', '细节工艺参考', '带钩'],
  },
  {
    id: 'gallery-robe-structure',
    asset: assetById('img-pattern-01'),
    title: '深衣结构复原示意图',
    reference: '设计转化参考',
    relation: '深衣形制复原考察',
    tags: ['服装结构', '手绘复原图'],
    filters: ['手绘复原图', '学术出版', '设计转化参考', '服装结构参考', '袍服'],
  },
  {
    id: 'gallery-cloud-pattern',
    asset: assetById('img-belt-01'),
    title: '织锦纹样（几何云气纹）',
    reference: '细节工艺参考',
    relation: '三国织锦纹样图典',
    tags: ['纹样', '文献插图'],
    filters: ['文献插图', '文献记录', '纹饰图案参考', '细节工艺参考', '纹样'],
  },
  {
    id: 'gallery-book-copy',
    asset: assetById('img-pattern-01'),
    title: '《三国志》舆服志（清抄本）',
    reference: '设计转化参考',
    relation: '舆服志图像资料汇编',
    tags: ['文献记录', '文献插图'],
    filters: ['文献插图', '文献记录', '学术出版', '设计转化参考'],
  },
  {
    id: 'gallery-cavalry-brick',
    asset: assetById('img-brick-01'),
    title: '骑兵出行画像砖（拓片）',
    reference: '史实依据',
    relation: '汉末三国骑兵形象研究',
    tags: ['画像砖', '考古发掘'],
    filters: ['画像砖', '画像砖拓片', '考古发掘', '史实依据', '场景搭配参考'],
  },
  {
    id: 'gallery-jinxian-cap',
    asset: assetById('img-cap-01'),
    title: '进贤冠（复原参考）',
    reference: '复原参考',
    relation: '三国官帽形制研究',
    tags: ['冠饰', '复原参考'],
    filters: ['冠饰', '实物照片', '复原参考', '博物馆藏', '曹魏'],
  },
  {
    id: 'gallery-armor-detail',
    asset: assetById('img-armor-01'),
    title: '甲胄铆钉与系带（细节）',
    reference: '细节工艺参考',
    relation: '三国甲胄构造研究',
    tags: ['甲胄', '细节照片'],
    filters: ['甲胄', '实物照片', '细节工艺参考', '服装结构参考'],
  },
  {
    id: 'gallery-color-plan',
    asset: assetById('img-robe-01'),
    title: '深衣配色方案参考',
    reference: '设计转化参考',
    relation: '三国服饰配色研究',
    tags: ['色彩搭配', '设计转化'],
    filters: ['手绘复原图', '设计转化参考', '色彩材质参考', '袍服'],
  },
]

function Timeline({ openDetail }: { openDetail: (id: string) => void }) {
  const [timelineFilters, setTimelineFilters] = useState<TimelineQuery>(defaultTimelineFilters)
  const timelineResponse = useMemo(() => buildTimelineResponse(timelineFilters), [timelineFilters])
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(timelineResponse.defaultSelectedItemId)
  const requestedSelectedItem = findTimelineCardById(timelineResponse.groups, selectedItemId)
  const selectedItem = requestedSelectedItem ?? findTimelineCardById(timelineResponse.groups, timelineResponse.defaultSelectedItemId)
  const selectedRecord = selectedItem ? collectionItems.find((item) => item.id === selectedItem.id) : undefined
  const selectedCover = selectedItem ? getItemCover(selectedItem.id) : undefined
  const rangeKey = getTimelineRangeKey(timelineFilters)

  return (
    <main className="timeline-page">
      <section className="timeline-intro">
        <div>
          <h1>服饰时间线</h1>
          <p>按时代查看东汉末至三国时期服装、冠帽、甲胄等资料演变。</p>
        </div>
      </section>

      <section className="timeline-filter-bar" aria-label="时间线筛选">
        <label>
          <span>服装类别：</span>
          <select
            value={timelineFilters.costumeCategory ?? ''}
            onChange={(event) =>
              setTimelineFilters((current) => ({ ...current, costumeCategory: event.target.value || undefined }))
            }
          >
            <option value="">全部</option>
            {filterGroups.costumeCategories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>身份：</span>
          <select
            value={timelineFilters.identityType ?? ''}
            onChange={(event) =>
              setTimelineFilters((current) => ({ ...current, identityType: event.target.value || undefined }))
            }
          >
            <option value="">全部</option>
            {filterGroups.identityTypes.map((identity) => (
              <option key={identity} value={identity}>
                {identity}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>时代：</span>
          <select
            value={rangeKey}
            onChange={(event) => {
              const range = timelinePeriodRanges.find((item) => getTimelineRangeKey(item) === event.target.value)
              setTimelineFilters((current) => ({
                ...current,
                periodStart: range?.periodStart,
                periodEnd: range?.periodEnd,
              }))
            }}
          >
            {timelinePeriodRanges.map((range) => (
              <option key={range.label} value={getTimelineRangeKey(range)}>
                {range.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="timeline-reset" onClick={() => setTimelineFilters(defaultTimelineFilters)}>
          <RotateCcw size={16} />
          重置筛选
        </button>
      </section>

      {timelineResponse.groups.length ? (
        <>
          <section className="timeline-axis" aria-label="时间线节点">
            {timelineResponse.groups.map((group) => {
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
                    <i />
                  </button>
                  {featuredItem && (
                    <button
                      type="button"
                      className="timeline-card"
                      onClick={() => setSelectedItemId(featuredItem.id)}
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
          </section>

          {selectedItem && selectedCover && (
            <section className="timeline-detail-panel">
              <div className="timeline-detail-image">
                <AssetThumb asset={selectedCover} />
                <span>
                  <Search size={15} />
                  点击图片可查看大图
                </span>
              </div>
              <div className="timeline-detail-copy">
                <div className="timeline-detail-title">
                  <h2>{selectedItem.title}</h2>
                  <span>{formatTimelineLabel(selectedItem)}</span>
                </div>
                <p>{selectedRecord?.shortNote ?? selectedItem.summary}</p>
                <div className="timeline-detail-meta">
                  <span>资料性质</span>
                  <TagRow tags={selectedItem.referencePurposes.slice(0, 4)} />
                </div>
                <div className="timeline-detail-meta">
                  <span>主要来源</span>
                  <p>{selectedRecord?.sourceTypes.join(' / ') ?? '内部整理'}</p>
                </div>
                <button type="button" className="timeline-open-button" onClick={() => openDetail(selectedItem.id)}>
                  查看条目
                  <ChevronRight size={18} />
                </button>
              </div>
              <div className="timeline-period-order" aria-label="固定时代顺序">
                {PERIOD_ORDER.map((period) => (
                  <span key={period}>{period}</span>
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <section className="timeline-empty empty-results">
          <Clock3 size={26} />
          <h2>没有符合条件的时间线条目</h2>
          <p>当前筛选条件下没有启用时间线的资料，可以放宽类别、身份或时代范围。</p>
          <button type="button" className="secondary-control" onClick={() => setTimelineFilters({})}>
            查看全部时代
          </button>
        </section>
      )}
    </main>
  )
}

function Detail({
  item,
  setLightboxAsset,
  setView,
  editItem,
  duplicateItem,
  openDetail,
  copyText,
}: {
  item: CollectionItem
  setLightboxAsset: (asset: Asset) => void
  setView: (view: View) => void
  editItem: () => void
  duplicateItem: () => void
  openDetail: (itemId: string) => void
  copyText: (text: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const itemAssets = item.imageIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean) as Asset[]
  const primaryAsset = itemAssets[0]
  const svnPath = primaryAsset?.svnPath ?? '/Costume/000123/'
  const sourceRows = [
    {
      icon: BookOpen,
      title: '文献与馆志',
      body: item.sourceTypes.includes('现代书籍') ? '记录时代名词、服制描述与后世整理线索。' : '用于校对名词、年代与制度背景。',
      badge: '古籍正史',
    },
    {
      icon: Grid3X3,
      title: '图像与出土资料',
      body: '对照画像砖、陶俑与馆藏图像，确认人物轮廓和冠服关系。',
      badge: item.referencePurposes.includes('史实依据') ? '史实依据' : '图像依据',
    },
    {
      icon: Layers3,
      title: '现代复原参考',
      body: '结合复原图与结构线稿，辅助理解穿搭层次和材质转化。',
      badge: '复原参考',
    },
  ]
  const relatedMatches = collectionItems
    .filter((entry) => entry.id !== item.id)
    .filter(
      (entry) =>
        entry.period === item.period ||
        entry.costumeCategories.some((category) => item.costumeCategories.includes(category)) ||
        entry.identityTypes.some((identity) => item.identityTypes.includes(identity)),
    )
  const relatedItems = [
    ...relatedMatches,
    ...collectionItems.filter((entry) => entry.id !== item.id && !relatedMatches.some((match) => match.id === entry.id)),
  ]
    .slice(0, 3)

  return (
    <main className="detail-page">
      <section className="detail-head">
        <div>
          <div className="detail-breadcrumb">
            <button type="button" className="back-link" onClick={() => setView('library')}>
              资料库
            </button>
            <span>/</span>
            <span>{item.title}</span>
          </div>
          <h1>{item.title}</h1>
          <p>{item.summary}</p>
          <TagRow tags={[item.period, ...item.identityTypes, ...item.costumeCategories].slice(0, 8)} />
        </div>
        <div className="detail-actions">
          <button type="button" className="edit-button secondary-control" onClick={editItem}>
            <FilePenLine size={17} />
            编辑
          </button>
          <div className="more-menu-wrap">
            <button
              type="button"
              className="icon-button detail-more"
              aria-label="更多菜单"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={20} />
            </button>
            {menuOpen && (
              <div className="more-menu" role="menu">
                <button
                  type="button"
                  className="more-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    duplicateItem()
                  }}
                >
                  <Copy size={15} />
                  复制为新资料
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="detail-content-grid">
        <div className="detail-main-column">
          <section className="gallery-panel">
            {primaryAsset && (
              <button type="button" className="main-image" onClick={() => setLightboxAsset(primaryAsset)}>
                <AssetThumb asset={primaryAsset} />
                <span>{primaryAsset.caption}</span>
              </button>
            )}
            <div className="thumb-strip">
              {itemAssets.map((asset) => (
                <button
                  type="button"
                  key={asset.id}
                  className={asset.id === primaryAsset?.id ? 'active' : ''}
                  onClick={() => setLightboxAsset(asset)}
                >
                  <AssetThumb asset={asset} />
                </button>
              ))}
            </div>
          </section>

          <section className="detail-notes">
            <h2>简短说明</h2>
            <p>{item.shortNote}</p>
            <p>本条目综合文献记录、图像资料与考古出土形象，提供服装轮廓、细节与穿搭理解参考。</p>
          </section>

        </div>

        <aside className="detail-side">
          <section className="info-panel">
            <h2>关键信息</h2>
            <Info label="时代" value={item.period} />
            <Info label="身份" value={item.identityTypes.join(' / ')} />
            <Info label="职官" value={item.officialTypes.join(' / ')} />
            <Info label="类别" value={item.costumeCategories.join(' / ')} />
            <Info label="来源性质" value={item.referencePurposes.join(' / ')} />
            <Info label="使用用途" value={item.usageHints.join(' / ')} />
            <div className="svn-row">
              <span>SVN 路径</span>
              <code>{svnPath}</code>
              <button type="button" className="copy-button secondary-control" onClick={() => copyText(svnPath)}>
                复制 SVN 路径
              </button>
            </div>
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
        </aside>
      </section>

      <section className="related-section">
        <h2>相关条目</h2>
        <div className="related-grid">
          {relatedItems.map((entry) => {
            const coverAsset = assets.find((asset) => asset.id === entry.imageIds[0])
            return (
              <button type="button" className="related-card" key={entry.id} onClick={() => openDetail(entry.id)}>
                {coverAsset && <AssetThumb asset={coverAsset} />}
                <span>
                  <strong>{entry.title}</strong>
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
  setView,
}: {
  mode: EditorMode
  sourceItem?: CollectionItem
  setView: (view: View) => void
}) {
  const templateItem = sourceItem ?? collectionItems[0]
  const isBlankNewItem = mode === 'new' && !sourceItem
  const editorTitle = mode === 'edit' ? '编辑资料' : mode === 'duplicate' ? '复制为新资料' : '新建资料'
  const titleValue = isBlankNewItem ? '' : mode === 'duplicate' ? `${templateItem.title}（副本）` : templateItem.title
  const summaryValue = isBlankNewItem ? '' : templateItem.summary
  const noteValue = isBlankNewItem ? '' : templateItem.shortNote
  const editorAssets = sourceItem
    ? templateItem.imageIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean) as Asset[]
    : assets.slice(0, 4)
  const fieldValues: Record<string, string> = {
    时代: isBlankNewItem ? '' : templateItem.period,
    身份类型: isBlankNewItem ? '' : templateItem.identityTypes.join('，'),
    职官类型: isBlankNewItem ? '' : templateItem.officialTypes.join('，'),
    服装类别: isBlankNewItem ? '' : templateItem.costumeCategories.join('，'),
    来源类型: isBlankNewItem ? '' : templateItem.sourceTypes.join('，'),
    参考性质: isBlankNewItem ? '' : templateItem.referencePurposes.join('，'),
    使用用途: isBlankNewItem ? '' : templateItem.usageHints.join('，'),
    标签: isBlankNewItem ? '' : templateItem.tags.join('，'),
  }

  return (
    <main className="editor-page">
      <section className="editor-head">
        <h1>{editorTitle}</h1>
        <div>
          <button type="button" className="secondary-control">
            保存草稿
          </button>
          <button type="button" onClick={() => setView('library')}>
            保存
          </button>
        </div>
      </section>
      <section className="editor-grid">
        <label>
          标题
          <input defaultValue={titleValue} />
        </label>
        <label>
          一句话简介
          <input defaultValue={summaryValue} />
        </label>
        <label className="wide">
          简短说明
          <textarea defaultValue={noteValue} />
        </label>
        <div className="image-picker wide">
          {editorAssets.map((asset) => (
            <AssetThumb key={asset.id} asset={asset} />
          ))}
          <button type="button">从 SVN 图片库选择</button>
          <button type="button" className="secondary-control">
            输入 SVN 路径
          </button>
        </div>
        {['时代', '身份类型', '职官类型', '服装类别', '来源类型', '参考性质', '使用用途', '标签'].map((label) => (
          <label key={label}>
            {label}
            <input defaultValue={fieldValues[label]} placeholder={`选择或输入${label}`} />
          </label>
        ))}
      </section>
    </main>
  )
}

function Lightbox({
  asset,
  close,
  openDetail,
  copyText,
}: {
  asset: Asset
  close: () => void
  openDetail: (id: string) => void
  copyText: (text: string) => void
}) {
  return (
    <div className="lightbox" role="dialog" aria-modal="true">
      <div className="lightbox-panel">
        <button type="button" className="close-button" onClick={close} aria-label="关闭">
          <X size={20} />
        </button>
        <AssetThumb asset={asset} />
        <aside>
          <p className="eyebrow">{asset.imageType}</p>
          <h2>{asset.caption}</h2>
          <TagRow tags={[asset.sourceType, asset.referencePurpose, ...asset.tags.slice(0, 3)]} />
          <Info label="SVN 路径" value={asset.svnPath} />
          <button type="button" className="copy-button" onClick={() => copyText(asset.svnPath)}>
            <Copy size={16} />
            复制路径
          </button>
          <button
            type="button"
            onClick={() => {
              close()
              openDetail(asset.linkedItemId)
            }}
          >
            打开关联条目
          </button>
        </aside>
      </div>
    </div>
  )
}

function Toast({ message }: { message: string }) {
  return (
    <div className={message ? 'toast visible' : 'toast'} role="status" aria-live="polite">
      {message}
    </div>
  )
}

export default App
