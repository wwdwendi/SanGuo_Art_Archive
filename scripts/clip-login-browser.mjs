import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const loginUrl = process.env.CLIP_LOGIN_URL || 'https://www.xiaohongshu.com/explore'
const browserProfileRoot = fileURLToPath(new URL('../.archive-data/clip-browser-profile/', import.meta.url))

await mkdir(browserProfileRoot, { recursive: true })

const browserProcess = spawn(
  chromium.executablePath(),
  [
    `--user-data-dir=${browserProfileRoot}`,
    '--profile-directory=Default',
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
