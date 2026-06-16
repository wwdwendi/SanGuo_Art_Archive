import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const targetUrl = process.argv[2]

if (!targetUrl) {
  console.error('Usage: npm run clip -- <url>')
  process.exit(1)
}

function clipSlug(inputUrl) {
  const url = new URL(inputUrl)
  const raw = `${url.hostname}${url.pathname}`
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'web-clip'
}

function imageExtension(contentType, imageUrl) {
  if (contentType?.includes('png')) return '.png'
  if (contentType?.includes('webp')) return '.webp'
  if (contentType?.includes('gif')) return '.gif'
  const fromUrl = extname(new URL(imageUrl).pathname).toLowerCase()
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(fromUrl) ? fromUrl : '.jpg'
}

function isBlockedPage(title, visibleText) {
  const text = `${title}\n${visibleText}`.toLowerCase()
  return (
    text.includes('just a moment') ||
    text.includes('performing security verification') ||
    text.includes('enable javascript and cookies to continue')
  )
}

function isLoginPage(pageUrl, title, visibleText) {
  const url = new URL(pageUrl)
  const text = `${title}\n${visibleText}`.toLowerCase()
  return (
    /xiaohongshu\.com$/i.test(url.hostname) && url.pathname === '/login'
  ) || (
    url.pathname === '/login' &&
    (text.includes('sign in') || text.includes('登录'))
  )
}

function isImportableDownloadedImage(platform, image) {
  if (!platform.includes('xiaohongshu')) return true
  const sourceUrl = image.sourceUrl || ''
  if (/^data:/i.test(sourceUrl)) return false
  if (/sns-avatar/i.test(sourceUrl)) return false
  if (/\/comment\//i.test(sourceUrl)) return false
  if (/fe-platform|picasso-static/i.test(sourceUrl)) return false
  return /https?:\/\/sns-webpic[^/]*\.xhscdn\.com\//i.test(sourceUrl)
}

const englishWebClipLabelMap = {
  'Object Type': '器物类型',
  'Museum number': '馆藏编号',
  Description: '说明',
  'Cultures/periods': '文化/时期',
  'Production date': '制作年代',
  Findspot: '发现地',
  Materials: '材质',
  Dimensions: '尺寸',
  Location: '馆内状态',
  Subjects: '主题',
  'Acquisition name': '取得来源',
  'Funder name': '资助来源',
  'Acquisition date': '取得日期',
  Department: '部门',
  'Registration number': '登记编号',
  Conservation: '保护修复',
}

const webClipPhraseTranslations = [
  [/boshanlu; censer \| British Museum/gi, '博山炉；香炉 | 大英博物馆'],
  [
    /Censer\. Bronze censer in shape called boshanlu \(or boshan xiang lu\), and cover\. With forested mountains and holes for chain attachment \. On a foot\./gi,
    '香炉。青铜香炉，形制称为博山炉（或博山香炉），带盖。饰有层叠山林，并有用于系链的孔。带足。',
  ],
  [/Found\/Acquired: ChinaAsia: China/gi, '发现/取得：中国（亚洲）'],
  [/Height: ([\d.]+) centimetres \(at cover\)/gi, '高度：$1 厘米（含盖）'],
  [/Purchased from: John Sparks, Ltd/gi, '购自：John Sparks, Ltd'],
  [/Funded by: Brooke Sewell Bequest/gi, '由 Brooke Sewell 遗赠基金资助'],
  [/Treatment: 27 Nov 1992/gi, '处理：1992年11月27日'],
  [/Han dynasty/gi, '汉代'],
  [/1stC BC \(circa\)/gi, '约公元前1世纪'],
  [/Not on display/gi, '未展出'],
  [/landscape/gi, '山水景观'],
  [/bronze/gi, '青铜'],
  [/Asia/gi, '亚洲'],
  [/British Museum/gi, '大英博物馆'],
  [/boshan xiang lu/gi, '博山香炉'],
  [/boshanlu/gi, '博山炉'],
  [/censer/gi, '香炉'],
]

function looksLikeForeignWebClip(clip) {
  const text = [
    clip.pageTitle,
    clip.summary,
    clip.pageDescription,
    ...(clip.extractedFields || [])
      .filter((field) => !['来源站点', '来源链接'].includes(field.label))
      .flatMap((field) => [field.label, field.value]),
  ]
    .filter(Boolean)
    .join(' ')
  const latinCount = (text.match(/[A-Za-z]/g) || []).length
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length
  return latinCount >= 24 && cjkCount < latinCount * 0.08
}

function translateWebClipTextToZh(value = '') {
  let translated = value.trim()
  webClipPhraseTranslations.forEach(([pattern, replacement]) => {
    translated = translated.replace(pattern, replacement)
  })
  return translated
    .replace(/\s+\./g, '。')
    .replace(/\. /g, '。')
    .replace(/\.$/g, '。')
    .replace(/; /g, '；')
}

function translateWebClipFieldToZh(field) {
  return {
    label: englishWebClipLabelMap[field.label] || translateWebClipTextToZh(field.label),
    value: translateWebClipTextToZh(field.value),
  }
}

function buildWebClipTranslationZh(clip) {
  if (!looksLikeForeignWebClip(clip)) return undefined
  const fields = (clip.extractedFields || [])
    .filter((field) => !['来源站点', '来源链接'].includes(field.label))
    .map(translateWebClipFieldToZh)
  const title = translateWebClipTextToZh(clip.pageTitle || '')
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

const slug = clipSlug(targetUrl)
const outputRoot = new URL(`../public/web-clips/${slug}/`, import.meta.url)
const imageRoot = new URL('images/', outputRoot)
const browserProfileRoot = new URL('../.archive-data/clip-browser-profile/', import.meta.url)
const targetHost = new URL(targetUrl).hostname.replace(/^www\./, '')
const usesLoginProfile = /xiaohongshu|xhslink/i.test(targetHost) || process.env.CLIP_USE_LOGIN_PROFILE === 'true'
const loginBrowserDebugPort = Number(process.env.CLIP_LOGIN_DEBUG_PORT || 48765)
const loginBrowserDebugEndpoint = `http://127.0.0.1:${loginBrowserDebugPort}`

await mkdir(imageRoot, { recursive: true })

async function readReusableClip() {
  try {
    const clip = JSON.parse(await readFile(new URL('clip.json', outputRoot), 'utf8'))
    if (clip?.status !== 'failed' && Array.isArray(clip.extractedImages) && clip.extractedImages.length) {
      return clip
    }
  } catch {
    // No reusable cache exists yet.
  }
  return null
}

async function writeFailureClip(clip) {
  const reusableClip = await readReusableClip()
  if (reusableClip) {
    console.error(`${clip.errorMessage} 已保留上一次成功采集缓存。`)
    console.log(
      JSON.stringify(
        { output: fileURLToPath(new URL('clip.json', outputRoot)), images: reusableClip.extractedImages.length, cached: true },
        null,
        2,
      ),
    )
    return
  }
  await writeFile(new URL('clip.json', outputRoot), `${JSON.stringify(clip, null, 2)}\n`, 'utf8')
}

const interactiveLogin = process.env.CLIP_INTERACTIVE_LOGIN === 'true'
const browserOptions = {
  headless: interactiveLogin || usesLoginProfile ? false : process.env.CLIP_HEADLESS !== 'false',
}
let browser
let context
let connectedToLoginBrowser = false
try {
  if (usesLoginProfile) {
    try {
      browser = await chromium.connectOverCDP(loginBrowserDebugEndpoint)
      context = browser.contexts()[0]
      if (!context) throw new Error('登录采集浏览器没有可用页面上下文')
      connectedToLoginBrowser = true
    } catch {
      context = await chromium.launchPersistentContext(fileURLToPath(browserProfileRoot), {
        ...browserOptions,
        args: [
          `--remote-debugging-port=${loginBrowserDebugPort}`,
          '--remote-debugging-address=127.0.0.1',
        ],
        viewport: { width: 1440, height: 1200 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      })
    }
  } else if (interactiveLogin) {
    context = await chromium.launchPersistentContext(fileURLToPath(browserProfileRoot), {
      ...browserOptions,
      viewport: { width: 1440, height: 1200 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    })
  } else {
    context = await chromium.launch(browserOptions).then((launchedBrowser) => {
      browser = launchedBrowser
      return launchedBrowser.newContext({
        viewport: { width: 1440, height: 1200 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      })
    })
  }
} catch (error) {
  if (usesLoginProfile) {
    const clip = {
      id: `clip-${Date.now()}`,
      inputUrl: targetUrl,
      normalizedUrl: targetUrl,
      platform: new URL(targetUrl).hostname.replace(/^www\./, ''),
      pageTitle: '',
      pageDescription: '',
      extractedText: '',
      extractedFields: [],
      summary: '',
      extractedImages: [],
      status: 'failed',
      errorMessage: '小红书采集需要使用已登录浏览器。请先关闭旧的“登录采集浏览器”窗口，重新打开一次登录采集浏览器后即可常驻使用。',
      createdBy: 'clip-page.mjs',
      createdAt: new Date().toISOString(),
    }
    await writeFailureClip(clip)
    console.error(clip.errorMessage)
    process.exit(3)
  }
  throw error
}
const page = await context.newPage()
await page.setViewportSize({ width: 1440, height: 1200 })
await page.bringToFront().catch(() => {})

for (const openPage of context.pages()) {
  if (openPage !== page && openPage.url() === 'about:blank') {
    await openPage.close().catch(() => {})
  }
}

try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.bringToFront().catch(() => {})
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(2500)

  for (const label of [/accept/i, /agree/i, /allow/i, /同意/, /接受/]) {
    const button = page.getByRole('button', { name: label }).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {})
      await page.waitForTimeout(600)
      break
    }
  }

  const extracted = await page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim()
    const meta = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || ''
    const absolute = (value) => {
      if (!value) return ''
      try {
        return new URL(value, document.baseURI).toString()
      } catch {
        return ''
      }
    }
    const bestSrcFromSet = (srcset) => {
      if (!srcset) return ''
      const parts = srcset
        .split(',')
        .map((part) => {
          const [url, width] = part.trim().split(/\s+/)
          const score = Number.parseInt(width, 10) || 0
          return { url, score }
        })
        .filter((part) => part.url)
      parts.sort((a, b) => b.score - a.score)
      return parts[0]?.url || ''
    }

    const title =
      clean(meta('meta[property="og:title"]')) ||
      clean(meta('meta[name="twitter:title"]')) ||
      clean(document.querySelector('h1')?.textContent) ||
      clean(document.title)
    const summary =
      clean(meta('meta[property="og:description"]')) ||
      clean(meta('meta[name="description"]')) ||
      clean(meta('meta[name="twitter:description"]'))

    const isVisible = (node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
    const isNoiseNode = (node) => {
      const noisyPattern = /cookie|consent|privacy|gdpr|onetrust|cookiebot|turnstile|challenge|cloudflare|cf-/i
      let current = node
      while (current && current !== document.body) {
        const marker = `${current.id || ''} ${typeof current.className === 'string' ? current.className : ''}`
        if (noisyPattern.test(marker)) return true
        current = current.parentElement
      }
      return false
    }
    const isNoiseField = (label, value) => {
      const text = `${label} ${value}`
      if (/^name$/i.test(label) && /provider purpose maximum storage duration type/i.test(value)) return true
      return (
        /cookie|cookiebot|sessionid|turnstile|cloudflare|botmanager|google analytics|storage duration|html local storage|http cookie|pixel tracker|used to check if|used to distinguish|registers statistical|preserves (the )?(visitor|user)|stores the user's cookie consent/i.test(
          text,
        ) || value.length > 900
      )
    }

    const fields = []
    const pushField = (label, value) => {
      const cleanLabel = clean(label)
      const cleanValue = clean(value)
      if (cleanLabel && cleanValue && cleanValue !== cleanLabel && !isNoiseField(cleanLabel, cleanValue)) {
        fields.push({ label: cleanLabel, value: cleanValue })
      }
    }

    document.querySelectorAll('dt').forEach((dt) => {
      if (!isVisible(dt) || isNoiseNode(dt)) return
      let next = dt.nextElementSibling
      while (next && next.tagName.toLowerCase() !== 'dd') next = next.nextElementSibling
      if (next && isVisible(next) && !isNoiseNode(next)) pushField(dt.textContent, next.textContent)
    })

    document.querySelectorAll('tr').forEach((row) => {
      if (!isVisible(row) || isNoiseNode(row)) return
      const cells = [...row.children]
      if (cells.length >= 2) pushField(cells[0].textContent, cells.slice(1).map((cell) => cell.textContent).join(' '))
    })

    document.querySelectorAll('[class*="field"], [class*="detail"], [class*="metadata"]').forEach((node) => {
      if (!isVisible(node) || isNoiseNode(node)) return
      const text = clean(node.textContent)
      const match = text.match(/^([^:：]{2,40})[:：]\s*(.+)$/)
      if (match) pushField(match[1], match[2])
    })

    const seen = new Set()
    const images = []
    const addImage = (url, caption, alt) => {
      const absoluteUrl = absolute(url)
      if (!absoluteUrl || seen.has(absoluteUrl) || !/^https?:\/\//.test(absoluteUrl)) return
      if (/favicon|logo|sprite|icon/i.test(absoluteUrl)) return
      seen.add(absoluteUrl)
      images.push({ url: absoluteUrl, caption: clean(caption), alt: clean(alt) })
    }

    addImage(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'), '网页主图', meta('meta[property="og:image:alt"]'))
    document.querySelectorAll('img').forEach((image) => {
      const url =
        image.currentSrc ||
        image.src ||
        image.getAttribute('data-src') ||
        image.getAttribute('data-original') ||
        bestSrcFromSet(image.getAttribute('srcset') || image.getAttribute('data-srcset'))
      const rect = image.getBoundingClientRect()
      if (rect.width < 40 || rect.height < 40) return
      if (/logo|favicon|icon|sprite/i.test(`${image.src} ${image.alt} ${image.className}`)) return
      const figureCaption = image.closest('figure')?.querySelector('figcaption')?.textContent
      addImage(url, image.getAttribute('title') || figureCaption || '', image.alt || '')
    })

    return {
      title,
      summary,
      fields,
      images: images.slice(0, 24),
      visibleText: clean(document.body.innerText).slice(0, 5000),
    }
  })

  const loginPageBeforeWait = isLoginPage(page.url(), extracted.title || '', extracted.visibleText || '')

  if (interactiveLogin && loginPageBeforeWait) {
    console.error('页面需要登录。请在打开的浏览器中完成登录；登录后脚本会重新打开目标链接采集。')
    await page
      .waitForFunction(
        () => {
          const text = document.body?.innerText || ''
          return !/\/login(?:\?|$)/i.test(location.pathname) || !/扫码|手机号登录|获取验证码|登录后推荐/.test(text)
        },
        { timeout: 180000 },
      )
      .catch(() => {})
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(2500)

    const pageUrlAfterLoginWait = page.url()
    const extractedAfterLogin = await page.evaluate(() => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim()
        const meta = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || ''
        const absolute = (value) => {
          if (!value) return ''
          try {
            return new URL(value, document.baseURI).toString()
          } catch {
            return ''
          }
        }
        const bestSrcFromSet = (srcset) => {
          if (!srcset) return ''
          const parts = srcset
            .split(',')
            .map((part) => {
              const [url, width] = part.trim().split(/\s+/)
              const score = Number.parseInt(width, 10) || 0
              return { url, score }
            })
            .filter((part) => part.url)
          parts.sort((a, b) => b.score - a.score)
          return parts[0]?.url || ''
        }
        const title =
          clean(meta('meta[property="og:title"]')) ||
          clean(meta('meta[name="twitter:title"]')) ||
          clean(document.querySelector('h1')?.textContent) ||
          clean(document.title)
        const summary =
          clean(meta('meta[property="og:description"]')) ||
          clean(meta('meta[name="description"]')) ||
          clean(meta('meta[name="twitter:description"]'))
        const seen = new Set()
        const images = []
        const addImage = (url, caption, alt) => {
          const absoluteUrl = absolute(url)
          if (!absoluteUrl || seen.has(absoluteUrl) || !/^https?:\/\//.test(absoluteUrl)) return
          if (/favicon|logo|sprite|icon/i.test(absoluteUrl)) return
          seen.add(absoluteUrl)
          images.push({ url: absoluteUrl, caption: clean(caption), alt: clean(alt) })
        }

        addImage(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'), '网页主图', meta('meta[property="og:image:alt"]'))
        document.querySelectorAll('img').forEach((image) => {
          const url =
            image.currentSrc ||
            image.src ||
            image.getAttribute('data-src') ||
            image.getAttribute('data-original') ||
            bestSrcFromSet(image.getAttribute('srcset') || image.getAttribute('data-srcset'))
          const rect = image.getBoundingClientRect()
          if (rect.width < 40 || rect.height < 40) return
          if (/logo|favicon|icon|sprite/i.test(`${image.src} ${image.alt} ${image.className}`)) return
          const figureCaption = image.closest('figure')?.querySelector('figcaption')?.textContent
          addImage(url, image.getAttribute('title') || figureCaption || '', image.alt || '')
        })

        return {
          title,
          summary,
          fields: [],
          images: images.slice(0, 24),
          visibleText: clean(document.body.innerText).slice(0, 5000),
        }
      })

    Object.assign(extracted, extractedAfterLogin)
    if (isLoginPage(pageUrlAfterLoginWait, extracted.title || '', extracted.visibleText || '') && extracted.images.length) {
      extracted.title = extracted.title || new URL(targetUrl).hostname
    }
  }

  if (isBlockedPage(extracted.title || '', extracted.visibleText || '')) {
    const clip = {
      id: `clip-${Date.now()}`,
      inputUrl: targetUrl,
      normalizedUrl: page.url(),
      platform: new URL(targetUrl).hostname.replace(/^www\./, ''),
      pageTitle: '',
      pageDescription: '',
      extractedText: '',
      extractedFields: [],
      summary: '',
      extractedImages: [],
      status: 'failed',
      errorMessage: '网页返回了安全验证页，脚本没有采集到真实正文内容；未生成占位图或编造摘要。',
      createdBy: 'clip-page.mjs',
      createdAt: new Date().toISOString(),
    }
    await writeFailureClip(clip)
    console.error(clip.errorMessage)
    process.exitCode = 2
  } else if (isLoginPage(page.url(), extracted.title || '', extracted.visibleText || '') && !extracted.images.length) {
    const loginErrorMessage = usesLoginProfile
      ? '页面仍然跳到了小红书登录页；采集浏览器 profile 里没有可用登录态。请点击“登录采集浏览器”，在弹出的采集浏览器窗口里登录，确认能看到笔记内容后保持窗口打开并重新读取。'
      : '页面需要登录后才能查看真实内容；匿名采集只拿到了登录页，没有下载图片。'
    const clip = {
      id: `clip-${Date.now()}`,
      inputUrl: targetUrl,
      normalizedUrl: page.url(),
      platform: new URL(targetUrl).hostname.replace(/^www\./, ''),
      pageTitle: extracted.title || '',
      pageDescription: extracted.summary || '',
      extractedText: extracted.visibleText || '',
      extractedFields: [],
      summary: extracted.summary || '',
      extractedImages: [],
      status: 'failed',
      errorMessage: loginErrorMessage,
      createdBy: 'clip-page.mjs',
      createdAt: new Date().toISOString(),
    }
    await writeFailureClip(clip)
    console.error(clip.errorMessage)
    process.exitCode = 3
  } else {
    const downloadedImages = []
    for (const [index, image] of extracted.images.entries()) {
      try {
        const response = await page.request.get(image.url, { timeout: 30000 })
        const contentType = response.headers()['content-type'] || ''
        if (!response.ok()) throw new Error(`HTTP ${response.status()}`)
        if (!contentType.startsWith('image/')) throw new Error(`不是图片响应：${contentType || 'unknown'}`)
        if (contentType.includes('svg')) throw new Error('跳过 SVG 标志或图标')
        const extension = imageExtension(contentType, image.url)
        const fileName = `image-${String(index + 1).padStart(2, '0')}${extension}`
        await writeFile(new URL(`images/${fileName}`, outputRoot), await response.body())
        downloadedImages.push({
          id: `clip-img-${index + 1}`,
          imageUrl: `/web-clips/${slug}/images/${fileName}`,
          thumbnailUrl: `/web-clips/${slug}/images/${fileName}`,
          sourceUrl: image.url,
          caption: image.caption || image.alt || `网页图片 ${index + 1}`,
          altText: image.alt,
          selected: index === 0,
          downloadStatus: 'downloaded',
        })
      } catch (error) {
        downloadedImages.push({
          id: `clip-img-${index + 1}`,
          imageUrl: image.url,
          thumbnailUrl: image.url,
          sourceUrl: image.url,
          caption: image.caption || image.alt || `网页图片 ${index + 1}`,
          altText: image.alt,
          selected: index === 0,
          downloadStatus: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const platform = new URL(targetUrl).hostname.replace(/^www\./, '')
    const importableImages = downloadedImages.filter((image) => isImportableDownloadedImage(platform, image))
    const successfulImages = importableImages.filter((image) => image.downloadStatus === 'downloaded')
    const extractedImages = importableImages.map((image, index) => ({
      ...image,
      selected: platform.includes('xiaohongshu') ? true : index === 0,
    }))
    const clip = {
      id: `clip-${Date.now()}`,
      inputUrl: targetUrl,
      normalizedUrl: page.url(),
      platform,
      pageTitle: extracted.title || page.url(),
      pageDescription: extracted.summary,
      extractedText: [extracted.title, extracted.summary, ...extracted.fields.map((field) => `${field.label}: ${field.value}`)]
        .filter(Boolean)
        .join('\n'),
      extractedFields: [
        ...(extracted.title ? [{ label: '页面标题', value: extracted.title }] : []),
        { label: '来源站点', value: platform },
        { label: '来源链接', value: page.url() },
        ...(extracted.summary ? [{ label: '页面摘要', value: extracted.summary }] : []),
        ...extracted.fields.slice(0, 40),
      ],
      summary: extracted.summary,
      extractedImages,
      suggestedCollectionType: platform.includes('britishmuseum') ? '馆藏资料' : '网页资料',
      suggestedSourceType: platform.includes('britishmuseum') ? '博物馆网页' : '网页资料',
      suggestedReferencePurpose: platform.includes('britishmuseum') ? ['史实依据', '形制参考'] : ['研究线索'],
      suggestedUsageHints: platform.includes('britishmuseum') ? ['器物参考', '图像参考', '材质参考'] : ['资料线索'],
      suggestedTags: platform.includes('britishmuseum') ? ['British Museum', '馆藏', '史实依据'] : ['网页资料'],
      usageRestriction: '需查看原网页版权说明',
      itemDraft: {
        title: extracted.title || page.url(),
        summary: extracted.summary,
        collectionType: platform.includes('britishmuseum') ? '馆藏资料' : '网页资料',
        tags: platform.includes('britishmuseum') ? ['British Museum', '馆藏', '史实依据'] : ['网页资料'],
      },
      sourceDraft: {
        title: extracted.title || page.url(),
        sourceType: platform.includes('britishmuseum') ? '博物馆网页' : '网页资料',
        referencePurposes: platform.includes('britishmuseum') ? ['史实依据', '形制参考'] : ['研究线索'],
        usageHints: platform.includes('britishmuseum') ? ['器物参考', '图像参考', '材质参考'] : ['资料线索'],
        usageRestriction: '需查看原网页版权说明',
        sourceUrl: page.url(),
      },
      status: extracted.title || extracted.summary || successfulImages.length ? 'success' : 'failed',
      errorMessage: extracted.title || extracted.summary || successfulImages.length ? undefined : '脚本没有采集到文字或图片。',
      createdBy: 'clip-page.mjs',
      createdAt: new Date().toISOString(),
    }
    const translationZh = buildWebClipTranslationZh(clip)
    if (translationZh) {
      clip.translationZh = translationZh
      clip.itemDraft = {
        ...clip.itemDraft,
        title: translationZh.title || clip.itemDraft.title,
        summary: translationZh.summary || clip.itemDraft.summary,
      }
    }

    await writeFile(new URL('clip.json', outputRoot), `${JSON.stringify(clip, null, 2)}\n`, 'utf8')
    console.log(
      JSON.stringify(
        { output: fileURLToPath(new URL('clip.json', outputRoot)), images: successfulImages.length },
        null,
        2,
      ),
    )
  }
} finally {
  if (connectedToLoginBrowser) {
    await page.close().catch(() => {})
  } else {
    await context.close()
    await browser?.close()
  }
}

process.exit(process.exitCode ?? 0)
