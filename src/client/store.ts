/**
 * DSH-Explorer browser half — shared in-memory store.
 * One handle per plugin apply, shared across slot registrations.
 */

import { useEffect, useSyncExternalStore } from 'react'

export type ExplorerTabKind = 'edit' | 'preview'
export type ExplorerPage = 'review' | 'context' | 'sources'
export type ReviewMode = 'git' | 'last' | 'branch'

export interface FileTab {
  id: string
  /** Opening session — a tab is per-session so switching sessions never
   *  reuses stale content under the same path. */
  sessionId: string
  path: string
  name: string
  kind: ExplorerTabKind
  content: string
  truncated: boolean
  dirty: boolean
  loading: boolean
  error: string | null
  /** 打开/载入时记录的磁盘基准版本（Host fs.read 的 version，可能缺失）。
   *  保存时作为 `expected` 传给 fs.write 做 CAS，防止盲覆盖外部改动。 */
  baseVersion?: string | null
  /** 打开/载入时记录的磁盘大小（fs.read 的 size）：与 baseVersion 一起构成
   *  文件跟随首探测的已知指纹（version 缺失的旧宿主靠 size 比对，见 fileFollow）。 */
  baseSize?: number | null
}

export interface TermTab {
  localId: string
  ptyId: string | null
  title: string
  error: string | null
  /** 宿主 overflow 事件累计丢弃的输出帧数（>0 时终端面板顶部显示轻提示）。 */
  dropped: number
}

export interface TermBag {
  tabs: TermTab[]
  active: string
}

export interface ExplorerStore {
  /** Bumped on every mutation; `useExplorer` snapshots this, not the handle. */
  version: number
  panelOpen: boolean
  /** Narrow-screen replace mode: the details panel takes over the whole
   *  viewport (replacing the center conversation) instead of docking as a
   *  third column. Distinct from `panelOpen`, which stays coupled to the
   *  measured details-column width and can never be true on a narrow viewport
   *  where the official concession chain forces the details column to 0. */
  overlayOpen: boolean
  /** Left sidebar file mode: the file tree temporarily shadows the session list. */
  filesMode: boolean
  /** Pinned summary: stays docked on a wide column, collapses to a button when narrow. */
  summaryOn: boolean
  /** Floating summary window while the column is narrow. */
  summaryFloat: boolean
  reviewMode: ReviewMode
  extraPages: ExplorerPage[]
  /** ExplorerPage | a file tab id（全局最近一次激活；渲染请用 activeFor） */
  active: string
  defaultActive: ExplorerPage
  tabs: FileTab[]
  /** Bumped to ask every file tree to reload its root listing. */
  treeTick: number
  terminalOn: boolean
  terminalHeight: number
  /** 当前右栏渲染所属的会话（ExplorerPanel 挂载/更新时回报）。 */
  currentSessionId: string | null
  /** 每个会话各自记住的激活页 / 文件 tab；没记过回退 defaultActive。 */
  noteSession(sessionId: string): void
  activeFor(sessionId: string): string
  /** 该会话自己的文件 tab（按打开会话过滤，互不可见）。 */
  sessionTabs(sessionId: string): FileTab[]
  openTab(input: { sessionId: string; path: string; name: string; kind: ExplorerTabKind }): FileTab
  openPage(page: ExplorerPage, opts?: { reviewMode?: ReviewMode }): void
  closePage(page: ExplorerPage): void
  activate(id: string): void
  closeTab(id: string): void
  setDefault(tab: ExplorerPage): void
  setPanelOpen(open: boolean): void
  /** 右栏开合按会话记忆：显式动作才写，探针同步不写。 */
  setPanelIntent(open: boolean, sessionId?: string): void
  setOverlayOpen(open: boolean): void
  setFilesMode(active: boolean): void
  setReviewMode(mode: ReviewMode): void
  setSummaryOn(on: boolean): void
  setSummaryFloat(open: boolean): void
  setTerminalOn(on: boolean): void
  setTerminalHeight(h: number): void
  commitTerminalHeight(): void
  termBag(sessionId: string): TermBag
  addTermTab(sessionId: string): TermTab
  closeTermTab(sessionId: string, localId: string): void
  setTermActive(sessionId: string, localId: string): void
  /** 宿主 overflow 事件上报：累计丢弃帧数（仅增长，回 0 清除提示）。 */
  setTermDropped(sessionId: string, localId: string, dropped: number): void
  /** Re-render after in-place TermTab patches (pty id / title / error). */
  touch(): void
  patchTab(id: string, patch: Partial<FileTab>): void
  refreshTree(): void
  subscribe(listener: () => void): () => void
}

let tabCounter = 0
const TERM_HEIGHT_KEY = 'dsh-explorer:term-height'
/** 「用户把右栏打开过的会话」集合：只有这些会话切换回来才自动开栏。 */
const PANEL_SESSIONS_KEY = 'dsh-explorer:panel-sessions'

function readTermHeight(): number {
  try {
    const raw = localStorage.getItem(TERM_HEIGHT_KEY)
    const n = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(n)) return Math.min(560, Math.max(140, n))
  } catch {
    /* private mode */
  }
  return 240
}

function readPanelSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PANEL_SESSIONS_KEY)
    if (raw === null) return new Set()
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return new Set()
    return new Set(list.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

function savePanelSessions(sessions: Set<string>): void {
  try {
    // 只保留最近的 50 个，避免无限增长
    const trimmed = Array.from(sessions).slice(-50)
    localStorage.setItem(PANEL_SESSIONS_KEY, JSON.stringify(trimmed))
  } catch { /* ignore */ }
}

/**
 * 该会话是否被用户显式打开过右栏（持久化）。没有 sessionId 视为否——
 * 老的全局「开了就所有会话都开」的行为正是要修掉的 bug。
 */
export function readPanelIntent(sessionId?: string | null): boolean {
  if (sessionId === undefined || sessionId === null || sessionId.length === 0) return false
  try {
    return readPanelSessions().has(sessionId)
  } catch {
    return false
  }
}

export function createExplorerStore(): ExplorerStore {
  const listeners = new Set<() => void>()
  const termBags = new Map<string, TermBag>()
  const sessionActive = new Map<string, string>()
  let termSeq = 0

  const notify = (): void => {
    store.version += 1
    for (const listener of listeners) listener()
  }

  /** 右栏开合意图落库（内部）：重复打开时删除重加刷新位置（LRU），
   *  保证保存时 slice(-50) 截掉的真是最久未活跃的会话。 */
  function markPanelIntent(open: boolean, sessionId?: string): void {
    const target = sessionId ?? store.currentSessionId
    if (target === undefined || target === null || target.length === 0) return
    let changed = false
    if (open) {
      // 重建 Set 以便保持插入顺序（保存时取最近 50 个）
      const next = readPanelSessions()
      if (!next.has(target)) changed = true
      else next.delete(target)
      next.add(target)
      savePanelSessions(next)
    } else {
      const next = readPanelSessions()
      if (next.delete(target)) { savePanelSessions(next); changed = true }
    }
    if (changed) notify()
  }

  const store: ExplorerStore = {
    version: 0,
    panelOpen: false,
    overlayOpen: false,
    filesMode: false,
    summaryOn: false,
    summaryFloat: false,
    terminalOn: false,
    terminalHeight: readTermHeight(),
    reviewMode: 'git',
    extraPages: [],
    active: 'review',
    defaultActive: 'review',
    tabs: [],
    treeTick: 0,
    currentSessionId: null,

    noteSession(sessionId) {
      // 静默写：currentSessionId 只影响后续意图写入的目标，没有 UI 读它；
      // 不触发 notify——切会话路径上不要再多出全树重渲染。
      this.currentSessionId = sessionId
    },

    activeFor(sessionId) {
      const own = sessionActive.get(sessionId)
      return own !== undefined ? own : this.defaultActive
    },

    /** 该会话此刻该显示的 tab/页面（文件 tab 只属于打开它的会话）。 */
    sessionTabs(sessionId) {
      return this.tabs.filter(tab => tab.sessionId === sessionId)
    },

    openTab(input) {
      const existing = this.tabs.find(tab =>
        tab.sessionId === input.sessionId && tab.path === input.path && tab.kind === input.kind)
      if (existing !== undefined) {
        this.active = existing.id
        sessionActive.set(input.sessionId, existing.id)
        this.panelOpen = true
        markPanelIntent(true, input.sessionId)
        notify()
        return existing
      }
      const tab: FileTab = {
        id: `dshx-tab-${++tabCounter}`,
        sessionId: input.sessionId,
        path: input.path,
        name: input.name,
        kind: input.kind,
        content: '',
        truncated: false,
        dirty: false,
        loading: true,
        error: null,
        baseVersion: null,
        baseSize: null,
      }
      this.tabs = [...this.tabs, tab]
      this.active = tab.id
      sessionActive.set(input.sessionId, tab.id)
      this.panelOpen = true
      markPanelIntent(true, input.sessionId)
      notify()
      return tab
    },

    openPage(page, opts) {
      if (page === 'sources') {
        if (!this.extraPages.includes(page)) this.extraPages = [...this.extraPages, page]
      }
      if (opts?.reviewMode !== undefined) this.reviewMode = opts.reviewMode
      this.active = page
      this.panelOpen = true
      if (this.currentSessionId !== null) sessionActive.set(this.currentSessionId, page)
      markPanelIntent(true)
      notify()
    },

    closePage(page) {
      this.extraPages = this.extraPages.filter(item => item !== page)
      if (this.active === page) this.active = this.defaultActive
      for (const [session, value] of sessionActive) {
        if (value === page) sessionActive.delete(session)
      }
      notify()
    },

    activate(id) {
      this.active = id
      if (this.currentSessionId !== null) sessionActive.set(this.currentSessionId, id)
      notify()
    },

    closeTab(id) {
      const index = this.tabs.findIndex(tab => tab.id === id)
      if (index < 0) return
      this.tabs = this.tabs.filter(tab => tab.id !== id)
      if (this.active === id) this.active = this.defaultActive
      for (const [session, value] of sessionActive) {
        if (value === id) sessionActive.delete(session)
      }
      notify()
    },

    setDefault(tab) {
      this.defaultActive = tab
      if (!this.tabs.some(t => t.id === this.active)) this.active = tab
      notify()
    },

    setPanelOpen(open) {
      this.panelOpen = open
      notify()
    },

    setPanelIntent(open, sessionId) {
      markPanelIntent(open, sessionId)
    },

    setOverlayOpen(open) {
      this.overlayOpen = open
      notify()
    },

    setFilesMode(active) {
      this.filesMode = active
      notify()
    },

    setReviewMode(mode) {
      this.reviewMode = mode
      notify()
    },

    setSummaryOn(on) {
      this.summaryOn = on
      if (!on) this.summaryFloat = false
      notify()
    },

    setSummaryFloat(open) {
      this.summaryFloat = open
      notify()
    },

    setTerminalOn(on) {
      this.terminalOn = on
      notify()
    },

    setTerminalHeight(h) {
      const next = Math.min(560, Math.max(140, Math.round(h)))
      this.terminalHeight = next
      notify()
    },

    commitTerminalHeight() {
      try { localStorage.setItem(TERM_HEIGHT_KEY, String(this.terminalHeight)) } catch { /* ignore */ }
    },

    termBag(sessionId) {
      let bag = termBags.get(sessionId)
      if (bag === undefined) {
        bag = { tabs: [], active: '' }
        termBags.set(sessionId, bag)
      }
      return bag
    },

    addTermTab(sessionId) {
      const bag = this.termBag(sessionId)
      const tab: TermTab = {
        localId: `term-${++termSeq}`,
        ptyId: null,
        title: '终端',
        error: null,
        dropped: 0,
      }
      bag.tabs = [...bag.tabs, tab]
      bag.active = tab.localId
      notify()
      return tab
    },

    closeTermTab(sessionId, localId) {
      const bag = this.termBag(sessionId)
      bag.tabs = bag.tabs.filter(tab => tab.localId !== localId)
      if (bag.active === localId) bag.active = bag.tabs[bag.tabs.length - 1]?.localId ?? ''
      if (bag.tabs.length === 0) this.terminalOn = false
      notify()
    },

    setTermActive(sessionId, localId) {
      this.termBag(sessionId).active = localId
      notify()
    },

    setTermDropped(sessionId, localId, dropped) {
      const tab = this.termBag(sessionId).tabs.find(t => t.localId === localId)
      if (tab === undefined || tab.dropped === dropped) return
      tab.dropped = Math.max(0, dropped)
      notify()
    },

    touch() {
      notify()
    },

    patchTab(id, patch) {
      const tab = this.tabs.find(t => t.id === id)
      if (tab === undefined) return
      // 不可变更新：原地改对象会让 memo / 依赖比较全部失效
      this.tabs = this.tabs.map(t => (t.id === id ? { ...t, ...patch } : t))
      notify()
    },

    refreshTree() {
      this.treeTick++
      notify()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  return store
}

/** Subscribe a component to every store change (small UI — full re-render is fine). */
export function useExplorer(store: ExplorerStore): ExplorerStore {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  return store
}

/**
 * 会话回报的轻量替代（供右栏关闭时仍挂载的会话级组件调用）：
 * 保持 store.currentSessionId 始终等于当前会话，让「面板开合按会话记忆」
 * 的写入目标在 details 未挂载时也不会指错会话。
 */
export function useSessionHint(store: ExplorerStore, sessionId: string | null | undefined): void {
  useEffect(() => {
    if (sessionId !== undefined && sessionId !== null && sessionId.length > 0) {
      store.noteSession(sessionId)
    }
  }, [store, sessionId])
}
