import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import displayTitleFontUrl from './assets/fonts/SanJiZiHaiSongGBK-2.woff2'
import titleFontUrl from './assets/fonts/AaGuDianKeBenSong-2.woff2'
import './index.css'
import App from './App.tsx'

const preloadFont = (href: string) => {
  if (typeof document === 'undefined') return
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'font'
  link.type = 'font/woff2'
  link.href = href
  link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
}

preloadFont(displayTitleFontUrl)
preloadFont(titleFontUrl)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
