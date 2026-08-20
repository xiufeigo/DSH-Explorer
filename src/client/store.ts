/**
 * DSH-Explorer browser half — shared in-memory store.
 * One handle per plugin apply, shared across slot registrations.
 */

import { useSyncExternalStore } from 'react'

export type ExplorerTabKind = 'edit' | 'preview'
export type ExplorerPage = 'review' | 'context' | 'subagents' | 'sources'
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
}

export interface TermTab {
  localId: string
  ptyId: string | null
  title: string
  error: string | null
}

export interface TermBag {
  tabs: TermTab[]
  active: string
}

export interface ExplorerStore {
  /** Bumped on every mutation; `useExplorer` snapshots this, not the handle. */
  version: number
  panelOpen: boolean
  /** Left sidebar file mode: the file tree temporarily shadows the session list. */
  filesMode: boolean
  /** Pinned summary: stays docked on a wide column, collapses to a button when narrow. */
  summaryOn: boolean
  /** Floating summary window while the column is narrow. */
  summaryFloat: boolean
  reviewMode: ReviewMode
  subagentId: string | null
  extraPages: ExplorerPage[]
  /** ExplorerPage | a file tab id */
  active: string
  defaultActive: ExplorerPage
  tabs: FileTab[]
  /** Bumped to ask every file tree to reload its root listing. */
  treeTick: number
  terminalOn: boolean
  terminalHeight: number
  openTab(input: { sessionId: string; path: string; name: string; kind: ExplorerTabKind }): FileTab
  openPage(page: ExplorerPage, opts?: { reviewMode?: ReviewMode; subagentId?: string | null }): void
  closePage(page: ExplorerPage): void
  activate(id: string): void
  closeTab(id: string): void
  setDefault(tab: ExplorerPage): void
  setPanelOpen(open: boolean): void
  setFilesMode(active: boolean): void
  setReviewMode(mode: ReviewMode): void
  setSummaryOn(on: boolean): void
  setSummaryFloat(open: boolean): void
  setTerminalOn(on: boolean): void
  setTerminalHeight(h: number): void
  termBag(sessionId: string): TermBag
  addTermTab(sessionId: string): TermTab
  closeTermTab(sessionId: string, localId: string): void
  setTermActive(sessionId: string, localId: string): void
  /** Re-render after in-place TermTab patches (pty id / title / error). */
  touch(): void
  patchTab(id: string, patch: Partial<FileTab>): void
  refreshTree(): void
  subscribe(listener: () => void): () => void
}

let tabCounter = 0
const TERM_HEIGHT_KEY = 'dsh-explorer:term-height'

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

export function createExplorerStore(): ExplorerStore {
  const listeners = new Set<() => void>()
  const termBags = new Map<string, TermBag>()
  let termSeq = 0

  const notify = (): void => {
    store.version += 1
    for (const listener of listeners) listener()
  }

  const store: ExplorerStore = {
    version: 0,
    panelOpen: false,
    filesMode: false,
    summaryOn: false,
    summaryFloat: false,
    terminalOn: false,
    terminalHeight: readTermHeight(),
    reviewMode: 'git',
    subagentId: null,
    extraPages: [],
    active: 'review',
    defaultActive: 'review',
    tabs: [],
    treeTick: 0,

    openTab(input) {
      const existing = this.tabs.find(tab =>
        tab.sessionId === input.sessionId && tab.path === input.path && tab.kind === input.kind)
      if (existing !== undefined) {
        this.active = existing.id
        this.panelOpen = true
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
      }
      this.tabs = [...this.tabs, tab]
      this.active = tab.id
      this.panelOpen = true
      notify()
      return tab
    },

    openPage(page, opts) {
      if (page === 'subagents' || page === 'sources') {
        if (!this.extraPages.includes(page)) this.extraPages = [...this.extraPages, page]
      }
      if (opts?.reviewMode !== undefined) this.reviewMode = opts.reviewMode
      if (opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'subagentId')) {
        this.subagentId = opts.subagentId ?? null
      }
      this.active = page
      this.panelOpen = true
      notify()
    },

    closePage(page) {
      this.extraPages = this.extraPages.filter(item => item !== page)
      if (this.active === page) this.active = this.defaultActive
      if (page === 'subagents') this.subagentId = null
      notify()
    },

    activate(id) {
      this.active = id
      notify()
    },

    closeTab(id) {
      const index = this.tabs.findIndex(tab => tab.id === id)
      if (index < 0) return
      this.tabs = this.tabs.filter(tab => tab.id !== id)
      if (this.active === id) this.active = this.defaultActive
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
      try { localStorage.setItem(TERM_HEIGHT_KEY, String(next)) } catch { /* ignore */ }
      notify()
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

    touch() {
      notify()
    },

    patchTab(id, patch) {
      const tab = this.tabs.find(t => t.id === id)
      if (tab === undefined) return
      Object.assign(tab, patch)
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
