import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const loginUrl = process.env.CLIP_LOGIN_URL || 'https://www.xiaohongshu.com/explore'
const debugPort = Number(process.env.CLIP_LOGIN_DEBUG_PORT || 48765)
const debugEndpoint = `http://127.0.0.1:${debugPort}`
const browserProfileRoot = fileURLToPath(new URL('../.archive-data/clip-browser-profile/', import.meta.url))

await mkdir(browserProfileRoot, { recursive: true })

async function openInExistingLoginBrowser() {
  try {
    const response = await fetch(`${debugEndpoint}/json/version`, { signal: AbortSignal.timeout(800) })
    if (!response.ok) return false
    const browser = await chromium.connectOverCDP(debugEndpoint)
    const context = browser.contexts()[0]
    if (!context) return false
    const page = await context.newPage()
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await page.bringToFront().catch(() => {})
    console.log('Clip login browser reused.')
    return true
  } catch {
    return false
  }
}

if (await openInExistingLoginBrowser()) {
  process.exit(0)
}

const browserProcess = spawn(
  chromium.executablePath(),
  [
    `--user-data-dir=${browserProfileRoot}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--new-window',
    loginUrl,
  ],
  {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  },
)

browserProcess.unref()
console.log('Clip login browser started.')
