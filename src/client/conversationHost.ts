/**
 * Conversation-column helpers: find the native scrollport, overlay hosts,
 * user-message text, and in-flow jump-to-message.
 */

export const SUMMARY_CARD_WIDTH = 300

export function conversationScroll(): HTMLElement | null {
  const el = document.querySelector('[data-conversation-scroll]')
  return el instanceof HTMLElement ? el : null
}

/** 中栏要能放下消息列 + 摘要卡片才钉住；右侧栏打开时一律走悬浮窗。 */
export function canPinSummary(scroller: HTMLElement | null = conversationScroll(), panelOpen = false): boolean {
  if (scroller === null || panelOpen) return false
  const raw = getComputedStyle(scroller).getPropertyValue('--dsh-chat-content-width')
  const content = Number.parseFloat(raw)
  const column = Number.isFinite(content) && content > 0 ? content : 748
  return scroller.clientWidth >= column + SUMMARY_CARD_WIDTH + 32
}

export function ensureHost(attr: string, className: string): HTMLElement | null {
  const scroller = conversationScroll()
  if (scroller === null) return null
  const existing = scroller.querySelector(`[${attr}]`)
  if (existing instanceof HTMLElement) return existing
  const host = document.createElement('div')
  host.setAttribute(attr, '')
  host.className = className
  scroller.insertBefore(host, scroller.firstChild)
  scroller.classList.add('dshx-has-chrome')
  const applyHeight = (): void => {
    scroller.style.setProperty('--dshx-scrollport-h', `${scroller.clientHeight}px`)
  }
  applyHeight()
  if (typeof ResizeObserver !== 'undefined' && scroller.dataset.dshxRo !== '1') {
    scroller.dataset.dshxRo = '1'
    let raf = 0
    const observer = new ResizeObserver(() => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        applyHeight()
      })
    })
    observer.observe(scroller)
  }
  return host
}

export function conversationRoot(): HTMLElement | null {
  const scroller = conversationScroll()
  const root = scroller?.parentElement
  return root instanceof HTMLElement ? root : null
}

/** 对话列底部终端座位：挂在滚动区外面，开合时压缩对话而不是盖住输入框。 */
export function ensureTermHost(): HTMLElement | null {
  const root = conversationRoot()
  if (root === null) return null
  const existing = root.querySelector('[data-dshx-term-host]')
  if (existing instanceof HTMLElement) return existing
  const host = document.createElement('div')
  host.setAttribute('data-dshx-term-host', '')
  host.className = 'dshx-term-host'
  root.appendChild(host)
  return host
}

export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}

export function scrollToChatKey(key: string): void {
  const scroller = conversationScroll()
  if (scroller === null) return
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey !== key) continue
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.classList.add('dshx-msg-flash')
    window.setTimeout(() => row.classList.remove('dshx-msg-flash'), 1200)
    return
  }
}

export function formatProcessed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total % 86400 / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function relativeTime(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} 周前`
  return new Date(at).toLocaleDateString()
}

export function agentHue(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${hash % 360} 62% 52%)`
}
