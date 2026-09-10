/**
 * DSH-Explorer browser half — 终端面板的共享内存 store。
 * One handle per plugin apply; 终端标签页按 sessionId 分桶。
 */

import { useSyncExternalStore } from 'react'

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
  terminalOn: boolean
  terminalHeight: number
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
  subscribe(listener: () => void): () => void
}

let termSeq = 0
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

  const notify = (): void => {
    store.version += 1
    for (const listener of listeners) listener()
  }

  const store: ExplorerStore = {
    version: 0,
    terminalOn: false,
    terminalHeight: readTermHeight(),

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
