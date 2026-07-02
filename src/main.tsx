import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import readingFontUrl from './assets/fonts/YeZiGongChangTianQingSong-2.woff2'
import displayTitleFontUrl from './assets/fonts/SanJiZiHaiSongGBK-2.woff2'
import titleFontUrl from './assets/fonts/AaGuDianKeBenSong-2.woff2'
import './index.css'
import App from './App.tsx'

const archiveFonts = [
  { family: 'YeZiGongChangTianQingSong', href: readingFontUrl },
  { family: 'SanJiZiHaiSongGBK', href: displayTitleFontUrl },
  { family: 'AaGuDianKeBenSong', href: titleFontUrl },
]

const preloadFont = (href: string) => {
  if (typeof document === 'undefined') return
  if (document.querySelector(`link[rel="preload"][href="${href}"]`)) return
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'font'
  link.type = 'font/woff2'
  link.href = href
  link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
}

const warmArchiveFonts = () => {
  if (typeof document === 'undefined') return
  archiveFonts.forEach(({ href }) => preloadFont(href))
  if (!('fonts' in document)) return
  archiveFonts.forEach(({ family }) => {
    void document.fonts.load(`400 1em "${family}"`)
  })
}

warmArchiveFonts()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
