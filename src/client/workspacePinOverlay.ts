/**
 * 侧栏工作区行的自定义指针拖拽 + 置顶标记。
 *
 * 原生工作区行虽带 HTML5 draggable，但在这套页面环境里拖拽手势经常无法
 * 触发（webview/浏览器差异）。这里给每个工作区行接管指针拖拽：按住移动
 * 5px 即进入拖拽（ghost 跟随 + 插入位置指示线），松手把落点提交给排序模块
 * 的同一套意图分类（置顶/钉住落点/取消置顶/置顶区自定义）。不依赖原生
 * dataTransfer，任何环境都能拖。
 *
 * 置顶行画一条左侧色条作可见标记。总开关（按最后会话时间排序）关闭时
 * 整体回到原生行为。行识别：`div[role="treeitem"][aria-expanded]`，操作
 * 按钮 aria-label 里的引号名字对照快照拿 id；React 重渲染由
 * MutationObserver 兜底重同步。
 */

import { getPrefs, subscribePrefs } from './prefs'
import {
  beginWorkspaceDragHold,
  commitWorkspaceOrderIntent,
  endWorkspaceDragHold,
  isWorkspacePinned,
  subscribePins,
} from './workspaceRecencyOrder'

interface WorkspaceItemLike {
  workspaceId?: string
  title?: string
}

interface WorkspacesSnapshotLike {
  items?: WorkspaceItemLike[]
}

interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface WorkspacePinOverlayFaces {
  workspaces?: { list?: SnapshotStoreLike<WorkspacesSnapshotLike> }
}

const PINNED_ROW_CLASS = 'dshx-ws-row-pinned'
const ROW_ID_ATTR = 'data-dshx-ws'
const STYLE_ID = 'dshx-ws-pin-style'
const DRAG_THRESHOLD_PX = 5

const PIN_CSS = `
.${PINNED_ROW_CLASS} {
  box-shadow: inset 2px 0 0 var(--dsw-alias-accent-primary, #4f8cff);
}
body.dshx-ws-dragging, body.dshx-ws-dragging * {
  cursor: grabbing !important;
  user-select: none !important;
}
.dshx-ws-ghost {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  opacity: 0.92;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}
.dshx-ws-drop-line {
  position: fixed;
  height: 2px;
  background: var(--dsw-alias-accent-primary, #4f8cff);
  border-radius: 1px;
  z-index: 10000;
  pointer-events: none;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35);
}
`

/** 从一行里的按钮 aria-label 提取工作区名（中英文模板都带引号包名字）。 */
function rowTitle(row: Element): string | undefined {
  const labels = row.querySelectorAll('button[aria-label]')
  for (const button of labels) {
    const label = button.getAttribute('aria-label') ?? ''
    const match = /[“"»«]([^”"«»]+)[”"«»]/u.exec(label)
    if (match !== null && match[1].length > 0) return match[1]
  }
  return undefined
}

interface DragRowInfo {
  id: string
  top: number
  bottom: number
  left: number
  width: number
}

interface DragSession {
  movedId: string
  ghost: HTMLDivElement
  line: HTMLDivElement
  rows: DragRowInfo[]
  grabOffsetX: number
  grabOffsetY: number
  target: { id: string; before: boolean } | null
}

export function installWorkspacePinOverlay(faces: WorkspacePinOverlayFaces): () => void {
  const store = faces.workspaces?.list
  if (store === undefined || typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  // 嵌套函数声明里的类型收窄不可靠，用确定类型的别名消掉可选性。
  const wsList: SnapshotStoreLike<WorkspacesSnapshotLike> = store

  const dragBound = new WeakSet<Element>()
  let observer: MutationObserver | null = null
  let styleEl: HTMLStyleElement | null = null
  let syncTimer: ReturnType<typeof setTimeout> | null = null
  let session: DragSession | null = null
  let candidate: { row: HTMLElement; id: string; startX: number; startY: number } | null = null
  let disposed = false

  function ensureStyle(): void {
    if (styleEl !== null) return
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null) {
      styleEl = existing as HTMLStyleElement
      return
    }
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    styleEl.textContent = PIN_CSS
    document.head.appendChild(styleEl)
  }

  function container(): Element | null {
    return document.querySelector('[data-slot="sidebar.workspaces"]')
      ?? document.querySelector('[data-slot="sidebar"]')
  }

  function workspaceRows(): HTMLElement[] {
    const root = container()
    if (root === null) return []
    return [...root.querySelectorAll<HTMLElement>('div[role="treeitem"][aria-expanded]')]
  }

  /** 清掉所有行标记、遗留置顶按钮与残留拖拽元素。 */
  function removeAll(root: Element | null): void {
    const scope = root ?? document
    for (const row of scope.querySelectorAll(`[${ROW_ID_ATTR}]`)) {
      row.classList.remove(PINNED_ROW_CLASS)
      row.removeAttribute(ROW_ID_ATTR)
    }
    for (const node of scope.querySelectorAll('.dshx-ws-pin-btn, .dshx-ws-ghost, .dshx-ws-drop-line')) node.remove()
  }

  // ── 指针拖拽 ────────────────────────────────────────────────────────────

  function endSession(commit: boolean): void {
    const current = session
    candidate = null
    session = null
    if (current === null) return
    current.ghost.remove()
    current.line.remove()
    document.body.classList.remove('dshx-ws-dragging')
    if (commit && current.target !== null) {
      const ids = current.rows.map(row => row.id)
      const at = ids.indexOf(current.target.id)
      if (at >= 0) {
        const final = ids.filter(id => id !== current.movedId)
        final.splice(current.target.before ? at : at + 1, 0, current.movedId)
        endWorkspaceDragHold()
        commitWorkspaceOrderIntent(final)
        // 拖完的 mouseup 之后还会派发一次 click 到行上（展开/收起），吞掉。
        const swallow = (event: Event): void => {
          event.preventDefault()
          event.stopPropagation()
        }
        document.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => { document.removeEventListener('click', swallow, true) }, 0)
        return
      }
    }
    endWorkspaceDragHold()
  }

  function placeIndicator(current: DragSession, pointerY: number): void {
    let hit: { row: DragRowInfo; before: boolean } | null = null
    for (const row of current.rows) {
      if (pointerY >= row.top && pointerY <= row.bottom) {
        hit = { row, before: pointerY < (row.top + row.bottom) / 2 }
        break
      }
    }
    if (hit === null) {
      current.target = null
      current.line.style.display = 'none'
      return
    }
    current.target = { id: hit.row.id, before: hit.before }
    current.line.style.display = 'block'
    current.line.style.left = `${hit.row.left}px`
    current.line.style.width = `${hit.row.width}px`
    current.line.style.top = `${(hit.before ? hit.row.top : hit.row.bottom) - 1}px`
  }

  function onRowMouseDown(event: MouseEvent): void {
    if (disposed || session !== null || candidate !== null) return
    if (event.button !== 0) return
    const row = event.currentTarget as HTMLElement
    if (row === null) return
    const target = event.target as Element | null
    if (target !== null && target.closest('button, a, input, select, textarea') !== null) return
    if (getPrefs().sortWorkspacesByRecency !== true) return
    const id = row.getAttribute(ROW_ID_ATTR)
    if (id === null || id.length === 0) return
    candidate = { row, id, startX: event.clientX, startY: event.clientY }
    // 候选期间拦掉原生 HTML5 拖拽（我们用指针拖拽替代）。挂在 window 捕获段，
    // 抢在排序模块的 document 拖拽闩锁之前——被取消的拖拽不能让闩锁置位
    // （preventDefault 掉的 dragstart 不会跟 dragend，闩锁会卡死）。
    const blocker = (dragEvent: DragEvent): void => {
      dragEvent.preventDefault()
      dragEvent.stopPropagation()
    }
    window.addEventListener('dragstart', blocker, true)
    const onMove = (moveEvent: MouseEvent): void => {
      if (session !== null) {
        moveEvent.preventDefault()
        session.ghost.style.left = `${moveEvent.clientX - session.grabOffsetX}px`
        session.ghost.style.top = `${moveEvent.clientY - session.grabOffsetY}px`
        placeIndicator(session, moveEvent.clientY)
        return
      }
      if (candidate === null) return
      if (Math.abs(moveEvent.clientX - candidate.startX) < DRAG_THRESHOLD_PX
        && Math.abs(moveEvent.clientY - candidate.startY) < DRAG_THRESHOLD_PX) return
      activateDrag(candidate, moveEvent)
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('dragstart', blocker, true)
      document.removeEventListener('keydown', onKey, true)
      endSession(session !== null)
    }
    const onKey = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape') return
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('dragstart', blocker, true)
      document.removeEventListener('keydown', onKey, true)
      endSession(false)
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('keydown', onKey, true)
  }

  function activateDrag(start: { row: HTMLElement; id: string; startX: number; startY: number }, event: MouseEvent): void {
    const rows: DragRowInfo[] = []
    for (const row of workspaceRows()) {
      const id = row.getAttribute(ROW_ID_ATTR)
      if (id === null || id === start.id) continue
      const rect = row.getBoundingClientRect()
      if (rect.height <= 0) continue
      rows.push({ id, top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width })
    }
    if (rows.length === 0) {
      candidate = null
      return
    }
    const rowRect = start.row.getBoundingClientRect()
    const ghost = document.createElement('div')
    ghost.className = 'dshx-ws-ghost'
    const clone = start.row.cloneNode(true) as HTMLElement
    const grabOffsetX = Math.max(12, event.clientX - rowRect.left)
    const grabOffsetY = 12
    ghost.appendChild(clone)
    ghost.style.left = `${event.clientX - grabOffsetX}px`
    ghost.style.top = `${event.clientY - grabOffsetY}px`
    ghost.style.width = `${rowRect.width}px`
    const line = document.createElement('div')
    line.className = 'dshx-ws-drop-line'
    line.style.display = 'none'
    document.body.appendChild(ghost)
    document.body.appendChild(line)
    document.body.classList.add('dshx-ws-dragging')
    beginWorkspaceDragHold()
    session = {
      movedId: start.id,
      ghost,
      line,
      rows,
      grabOffsetX,
      grabOffsetY,
      target: null,
    }
    placeIndicator(session, event.clientY)
    candidate = null
  }

  // ── 同步 ────────────────────────────────────────────────────────────────

  function sync(): void {
    if (disposed) return
    const root = container()
    if (root === null) return
    if (getPrefs().sortWorkspacesByRecency !== true) {
      removeAll(root)
      return
    }
    ensureStyle()
    // 旧版本注入的 📌 按钮已废弃，见到就拆（防热更新残留实例反复注入）。
    for (const node of root.querySelectorAll('.dshx-ws-pin-btn')) node.remove()
    // 标题 → 工作区 id 对照表（快照为准）。
    const idByTitle = new Map<string, string>()
    for (const item of wsList.getSnapshot().items ?? []) {
      const id = item.workspaceId
      if (typeof id === 'string' && id.length > 0 && typeof item.title === 'string' && item.title.length > 0) {
        if (!idByTitle.has(item.title)) idByTitle.set(item.title, id)
      }
    }
    for (const row of workspaceRows()) {
      const title = rowTitle(row)
      const id = title === undefined ? undefined : idByTitle.get(title)
      if (id === undefined) continue // 未分组等伪分组行：跳过
      row.setAttribute(ROW_ID_ATTR, id)
      if (!dragBound.has(row)) {
        row.addEventListener('mousedown', onRowMouseDown)
        dragBound.add(row)
      }
      row.classList.toggle(PINNED_ROW_CLASS, isWorkspacePinned(id))
    }
  }

  function scheduleSync(): void {
    if (syncTimer !== null) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = null
      sync()
    }, 80)
  }

  try {
    observer = new MutationObserver(scheduleSync)
    observer.observe(document.body, { childList: true, subtree: true })
  } catch { /* 没有 MutationObserver 就只在事件点同步 */ }

  const unsubWorkspaces = wsList.subscribe(scheduleSync)
  const unsubPins = subscribePins(scheduleSync)
  const unsubPrefs = subscribePrefs(scheduleSync)
  scheduleSync()

  return () => {
    disposed = true
    if (syncTimer !== null) clearTimeout(syncTimer)
    observer?.disconnect()
    observer = null
    if (session !== null) endSession(false)
    unsubWorkspaces()
    unsubPins()
    unsubPrefs()
    removeAll(container())
    styleEl?.remove()
    styleEl = null
  }
}
