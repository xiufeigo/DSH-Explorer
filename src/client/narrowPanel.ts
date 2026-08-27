/**
 * 窄屏右侧栏替换模式。
 *
 * 问题：DSH 官方 ui-layout 的让步链（computeColumns）保证中心列 ≥ 640px，
 * 在窄视口（Android WebView / 手机竖屏）上 `openDetails()` 之后 details 列
 * 依然被算成 0 —— 右侧栏永远打不开，ExplorerPanel 的宽度探针也把
 * store.panelOpen 抖回 false。
 *
 * 方案：与官方 SIDEBAR_AUTO_COLLAPSE 相同的 1024px 断点以下，打开右侧栏时
 * 不再走「第三列」布局，而是把 details 列提为全宽（sidebar / center 归零），
 * 即右侧栏**替换主会话区域**。断点以上完全保持原行为，桌面零回归。
 *
 * 实现是纯 DOM/CSS：给 AppFrame 元素加 `data-dshx-overlay` 标记，样式表在
 * 窄屏下据此覆盖 inline 的 grid-template-columns。frame 通过官方
 * `[data-shell-overlay]` 的父元素定位（同 ui-layout 的 AppFrame）。
 */

import type { ExplorerStore } from './store'

/** 与官方 SIDEBAR_AUTO_COLLAPSE（1024）对齐：viewport < 1024 视作窄屏。 */
export const NARROW_QUERY = '(max-width: 1023px)'

/** AppFrame 元素：shell.overlay 层的父节点（三列 grid 根）。 */
export function findFrame(): HTMLElement | null {
  const overlay = document.querySelector('[data-shell-overlay]')
  const parent = overlay?.parentElement ?? null
  return parent instanceof HTMLElement ? parent : null
}

function markColumns(frame: HTMLElement): boolean {
  const root = document.querySelector('.dshx-root')
  if (!(root instanceof HTMLElement)) return false
  let details: HTMLElement | null = root
  while (details.parentElement !== null && details.parentElement !== frame) details = details.parentElement
  if (details.parentElement !== frame) return false
  details.setAttribute('data-dshx-details-col', '')
  for (const child of frame.children) {
    if (!(child instanceof HTMLElement) || child === details) continue
    if (child.querySelector('[data-phase]') !== null) {
      child.setAttribute('data-dshx-center-col', '')
      break
    }
  }
  return true
}

function clearColumnMarks(frame: HTMLElement | null = findFrame()): void {
  frame?.querySelectorAll('[data-dshx-details-col], [data-dshx-center-col]').forEach(node => {
    node.removeAttribute('data-dshx-details-col')
    node.removeAttribute('data-dshx-center-col')
  })
}

function isNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(NARROW_QUERY).matches
}

/**
 * 打开窄屏替换模式：给 frame 加标记并同步 store。宽屏 / 找不到 frame 时
 * 是 no-op（调用方会回退到普通 openDetails 路径）。
 */
export function openNarrowOverlay(store: ExplorerStore): boolean {
  const frame = findFrame()
  if (frame === null || !markColumns(frame)) return false
  frame.setAttribute('data-dshx-overlay', '')
  store.setOverlayOpen(true)
  return true
}

/** 关闭替换模式：移除标记。宽屏下也幂等。开合意图按会话记忆（可显式指定）。 */
export function closeNarrowOverlay(store: ExplorerStore, sessionId?: string): void {
  const frame = findFrame()
  frame?.removeAttribute('data-dshx-overlay')
  clearColumnMarks(frame)
  store.setOverlayOpen(false)
  // 窄屏下 panelOpen 只是在打开替换模式时被置 true 以联动摘要等，关闭时一并复位。
  store.setPanelOpen(false)
  store.setPanelIntent(false, sessionId)
}

/**
 * 在 apply 里安装：监听窄屏断点变化并迁移当前打开状态。
 *
 * 宽→窄时，官方布局会先把 details 实际宽度压成 0，ResizeObserver 可能在
 * matchMedia 回调之前把 store.panelOpen 改成 false。因此这里持续缓存宽屏下
 * 最近一次 panelOpen；若缩窄前已打开，则自动进入替换模式，避免白屏。
 * 窄→宽时移除替换标记，并重新调用官方 openDetails 恢复第三列。
 */
export function installNarrowOverlay(store: ExplorerStore, openDetails?: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mq = window.matchMedia(NARROW_QUERY)
  let lastNarrow = mq.matches
  let widePanelOpen = !lastNarrow && store.panelOpen
  const unsubscribe = store.subscribe(() => {
    // 只在宽屏采样；窄屏下探针会因官方 details=0 把 panelOpen 改成 false。
    if (!mq.matches) widePanelOpen = store.panelOpen
  })
  const onWidthChange = (): void => {
    const narrow = mq.matches
    if (narrow === lastNarrow) return
    lastNarrow = narrow
    if (narrow) {
      if (widePanelOpen && openNarrowOverlay(store)) store.setPanelOpen(true)
      return
    }
    const restoreDetails = store.overlayOpen
    const frame = findFrame()
    frame?.removeAttribute('data-dshx-overlay')
    clearColumnMarks(frame)
    store.setOverlayOpen(false)
    if (restoreDetails) {
      widePanelOpen = true
      store.setPanelOpen(true)
      openDetails?.()
    } else {
      widePanelOpen = false
      store.setPanelOpen(false)
    }
  }
  // matchMedia.addEventListener 需要较新浏览器；旧内核回退到 addListener。
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onWidthChange)
  else mq.addListener(onWidthChange)
  return () => {
    if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onWidthChange)
    else mq.removeListener(onWidthChange)
    unsubscribe()
    const frame = findFrame()
    frame?.removeAttribute('data-dshx-overlay')
    clearColumnMarks(frame)
    store.setOverlayOpen(false)
    store.setPanelOpen(false)
  }
}

/** 当前是否处于窄屏：给组件用于决定 toggle 走哪条路径。 */
export function narrowNow(): boolean {
  return isNarrow()
}

/**
 * 包装 layout.openDetails：窄屏下改为打开替换模式（并同步 store.panelOpen），
 * 宽屏照常走第三列。这样 Summary / 文件树 / 对话里点文件等所有「打开右侧栏」
 * 入口在窄屏下统一变成「替换主会话」，无需逐个改调用点。
 */
export function overlayAwareOpenDetails(openDetails: () => void, store: ExplorerStore): () => void {
  return () => {
    if (narrowNow()) {
      if (openNarrowOverlay(store)) {
        store.setPanelOpen(true)
        return
      }
      // 某些 Remote 壳会延迟挂载 details 内容：先触发官方打开，再下一帧标记真实列。
      openDetails()
      requestAnimationFrame(() => {
        if (openNarrowOverlay(store)) store.setPanelOpen(true)
      })
      return
    }
    openDetails()
  }
}
