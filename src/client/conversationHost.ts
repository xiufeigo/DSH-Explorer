/**
 * Conversation-column helpers: find the native scrollport and overlay hosts.
 */

export const SUMMARY_CARD_WIDTH = 300

interface HostRegistry {
  createdElements: HTMLElement[]
  /** observer 与它观测的滚动区配对：滚动区脱离文档时可精确 disconnect。 */
  observers: Array<{ observer: ResizeObserver; scroller: HTMLElement }>
  modifiedScrollers: HTMLElement[]
}

const hostRegistry: HostRegistry = {
  createdElements: [],
  observers: [],
  modifiedScrollers: [],
}

export function disposeConversationHost(): void {
  for (const { observer } of hostRegistry.observers) {
    try { observer.disconnect() } catch { /* ignore */ }
  }
  hostRegistry.observers = []

  for (const el of hostRegistry.createdElements) {
    try { el.remove() } catch { /* ignore */ }
  }
  hostRegistry.createdElements = []

  for (const scroller of hostRegistry.modifiedScrollers) {
    try {
      scroller.style.removeProperty('--dshx-scrollport-h')
      delete scroller.dataset.dshxRo
    } catch { /* ignore */ }
  }
  hostRegistry.modifiedScrollers = []
}

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
  // 先清扫已脱离文档的滚动区/宿主元素：disconnect 对应 observer、释放引用，
  // 避免宿主按会话重挂滚动区时注册表无限累积。
  hostRegistry.observers = hostRegistry.observers.filter(({ observer, scroller }) => {
    if (document.contains(scroller)) return true
    try { observer.disconnect() } catch { /* ignore */ }
    return false
  })
  hostRegistry.createdElements = hostRegistry.createdElements.filter(el => document.contains(el))
  const scroller = conversationScroll()
  if (scroller === null) return null
  const existing = scroller.querySelector(`[${attr}]`)
  if (existing instanceof HTMLElement) return existing
  const host = document.createElement('div')
  host.setAttribute(attr, '')
  host.className = className
  scroller.insertBefore(host, scroller.firstChild)
  hostRegistry.createdElements.push(host)
  if (!hostRegistry.modifiedScrollers.includes(scroller)) {
    hostRegistry.modifiedScrollers.push(scroller)
  }
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
    hostRegistry.observers.push({ observer, scroller })
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
  hostRegistry.createdElements.push(host)
  return host
}

export function agentHue(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${hash % 360} 62% 52%)`
}
