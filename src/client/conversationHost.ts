/**
 * Conversation-column helpers: 找对话列的滚动区与终端座位。
 * 终端挂在滚动区外面（`conversationRoot` 下），开合时压缩对话而不是盖住输入框。
 */

interface HostRegistry {
  createdElements: HTMLElement[]
}

const hostRegistry: HostRegistry = {
  createdElements: [],
}

export function disposeConversationHost(): void {
  for (const el of hostRegistry.createdElements) {
    try { el.remove() } catch { /* ignore */ }
  }
  hostRegistry.createdElements = []
}

export function conversationScroll(): HTMLElement | null {
  const el = document.querySelector('[data-conversation-scroll]')
  return el instanceof HTMLElement ? el : null
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
