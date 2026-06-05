import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const target = process.env.APP_URL ?? 'http://127.0.0.1:5175/'
const outputDir = new URL('../qa/', import.meta.url)

await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const results = []

async function inspectViewport(name, viewport) {
  const page = await browser.newPage({ viewport })
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  await page.goto(target, { waitUntil: 'load' })
  await page.waitForTimeout(900)

  const homeMetrics = await page.evaluate(() => {
    const hero = document.querySelector('.hero-model')?.getBoundingClientRect()
    const canvas = document.querySelector('canvas')?.getBoundingClientRect()
    return {
      h1: document.querySelector('h1')?.textContent,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      hero: hero ? { width: Math.round(hero.width), height: Math.round(hero.height) } : null,
      canvas: canvas ? { width: Math.round(canvas.width), height: Math.round(canvas.height) } : null,
    }
  })

  await page.screenshot({ path: fileURLToPath(new URL(`${name}-home.png`, outputDir)), fullPage: true })

  await page.getByRole('button', { name: '进入资料库', exact: true }).click()
  await page.waitForTimeout(200)
  const libraryText = await page.locator('.library-results-pane').innerText()

  await page.getByRole('button', { name: /东汉末文官袍服/ }).first().click()
  await page.waitForTimeout(200)
  const detailTitle = await page.locator('.detail-head h1').innerText()

  if (viewport.width < 720) {
    await page.getByRole('button', { name: '菜单', exact: true }).click()
    await page.locator('.mobile-nav button').filter({ hasText: '图片库' }).click()
  } else {
    await page.locator('nav button').filter({ hasText: '图片库' }).click()
  }
  await page.waitForTimeout(200)
  const assetCount = await page.locator('.asset-card').count()

  await page.screenshot({ path: fileURLToPath(new URL(`${name}-images.png`, outputDir)), fullPage: true })

  results.push({
    name,
    viewport,
    homeMetrics,
    libraryHasResult: libraryText.includes('东汉末文官袍服'),
    detailTitle,
    assetCount,
    consoleErrors,
  })

  await page.close()
}

await inspectViewport('desktop', { width: 1440, height: 900 })
await inspectViewport('mobile', { width: 390, height: 844 })

await browser.close()
console.log(JSON.stringify(results, null, 2))
