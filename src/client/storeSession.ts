/**
 * DSH-Explorer 浏览器半边 —— session 作用域 store（接入规范 ③）。
 *
 * ⚠️ **本文件尚未接线**：拆店方案经确认不做，作为第三项「有意偏离」收尾
 * （见 README「接入规范符合性」）。当前仍是旧的 `store.ts` 在服役；本文件与
 * `storeRoot.ts` 只是备用脚手架，没有任何 register / 组件引用它们。
 * 完整工序见 docs/store-seat-migration.md。
 *
 * 官方 `ui-slots` 强制「一个 store 句柄只能挂一个 scope」，本插件占用的座位横跨
 * root（`sidebar.workspaces` / `sidebar.footer.action` / `settings.plugin.item`）与
 * session（`details` / `conversation.session.header.utilities`），因此共享状态必须
 * 拆成两个店。本文件是 session 侧：由 `details` 与 header utilities 的 register
 * 以 `store:` 座位声明，框架按会话各建一个实例（`handle × scope key`），
 * 所以这里的字段**天然按会话隔离**——不再需要 `sessionActive` / `termBags`
 * 这类「一张表按会话分桶」的结构，`active` 与终端标签直接就是本会话的。
 *
 * 组件经 `props.useStore` 读、`props.actions` 写；apply 世界拿不到框架为本会话
 * 建的实例（自行 create 会分裂成第二个实例），所以副作用（localStorage、RPC、DOM）
 * 一律留在 inject 回调或组件里，不进 action。
 */

import { defineStore, type EngineStoreHandle, type PropsStore } from '@deepseek-ai/dsh-client-store'

export type ExplorerTabKind = 'edit' | 'preview'
export type ExplorerPage = 'review' | 'context' | 'sources'
export type ReviewMode = 'git' | 'last' | 'branch'

export interface FileTab {
  id: string
  /** 打开该 tab 的会话。session 店本身已按会话隔离，此字段保留供跨会话定位与调试。 */
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

/** session 店状态：全部 JSON 兼容（跨注册共享的前提）。 */
export interface ExplorerSessionState {
  panelOpen: boolean
  /** 窄屏替换模式：右侧栏接管整个视口（而非第三列）。 */
  overlayOpen: boolean
  /** 置顶摘要：宽栏时钉在对话右侧，窄栏时折叠成按钮。 */
  summaryOn: boolean
  /** 摘要悬浮窗（窄栏下的展开态）。 */
  summaryFloat: boolean
  reviewMode: ReviewMode
  /** 仅当用户从摘要打开过时才常驻的附加页（来源等）。 */
  extraPages: ExplorerPage[]
  /** ExplorerPage | 文件 tab id（全局最近一次激活）。 */
  active: string
  defaultActive: ExplorerPage
  tabs: FileTab[]
  terminalOn: boolean
  terminalHeight: number
  termTabs: TermTab[]
  /** 本会话当前激活的终端标签 localId（空串表示无）。 */
  termActive: string
}

/** 声明式写集合：完整的可变面（组件只能通过这些 action 改状态）。
 *  必须用 type alias：`ActionsDecl<T>` 是 `Record<string, …>`，而 TS 只为对象
 *  字面量类型别名推断隐式索引签名，interface 不满足该约束（官方同写法）。 */
export type ExplorerSessionActions = {
  openTab(draft: ExplorerSessionState, tab: FileTab): void
  activate(draft: ExplorerSessionState, id: string): void
  closeTab(draft: ExplorerSessionState, id: string): void
  setDefault(draft: ExplorerSessionState, page: ExplorerPage): void
  patchTab(draft: ExplorerSessionState, id: string, patch: Partial<FileTab>): void
  openPage(draft: ExplorerSessionState, page: ExplorerPage, reviewMode?: ReviewMode): void
  closePage(draft: ExplorerSessionState, page: ExplorerPage): void
  setPanelOpen(draft: ExplorerSessionState, open: boolean): void
  setOverlayOpen(draft: ExplorerSessionState, open: boolean): void
  setReviewMode(draft: ExplorerSessionState, mode: ReviewMode): void
  setSummaryOn(draft: ExplorerSessionState, on: boolean): void
  setSummaryFloat(draft: ExplorerSessionState, open: boolean): void
  setTerminalOn(draft: ExplorerSessionState, on: boolean): void
  setTerminalHeight(draft: ExplorerSessionState, height: number): void
  addTermTab(draft: ExplorerSessionState, tab: TermTab): void
  closeTermTab(draft: ExplorerSessionState, localId: string): void
  setTermActive(draft: ExplorerSessionState, localId: string): void
  setTermDropped(draft: ExplorerSessionState, localId: string, dropped: number): void
}

export const TERM_HEIGHT_MIN = 140
export const TERM_HEIGHT_MAX = 560
const TERM_HEIGHT_KEY = 'dsh-explorer:term-height'

/** 终端高度持久化键（全局偏好）：店只存当前值，落盘由调用方显式触发。 */
export function readTermHeight(): number {
  try {
    const raw = localStorage.getItem(TERM_HEIGHT_KEY)
    const n = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(n)) return Math.min(TERM_HEIGHT_MAX, Math.max(TERM_HEIGHT_MIN, n))
  } catch {
    /* private mode */
  }
  return 240
}

/** 落盘终端高度（apply 世界 / inject 回调调用，不进 action）。 */
export function persistTermHeight(height: number): void {
  try { localStorage.setItem(TERM_HEIGHT_KEY, String(height)) } catch { /* ignore */ }
}

/** 读：本会话此刻应显示的 tab 集合（店已按会话隔离，直接就是全部 tab）。 */
export function sessionTabsOf(state: ExplorerSessionState): readonly FileTab[] {
  return state.tabs
}

/** 读：本会话当前激活的页 / tab id。 */
export function activeFor(state: ExplorerSessionState): string {
  return state.active
}

/** 读：本会话终端标签与激活项（原 `termBag(sessionId)` 的等价物）。 */
export function termBagOf(state: ExplorerSessionState): { tabs: readonly TermTab[]; active: string } {
  return { tabs: state.termTabs, active: state.termActive }
}

/**
 * 声明 session 店。
 * @returns store 句柄（apply 里构造一次，供多个 session 作用域 register 共享）。
 */
export function createExplorerSessionStore(): EngineStoreHandle<ExplorerSessionState, ExplorerSessionActions> {
  return defineStore({
    // session 作用域下框架会在每次开新会话时调 create(key)，init 每次取新值。
    init: (): ExplorerSessionState => ({
      panelOpen: false,
      overlayOpen: false,
      summaryOn: false,
      summaryFloat: false,
      reviewMode: 'git',
      extraPages: [],
      active: 'review',
      defaultActive: 'review',
      tabs: [],
      terminalOn: false,
      terminalHeight: readTermHeight(),
      termTabs: [],
      termActive: '',
    }),
    // 不声明 persist：店状态含文件正文与终端标签，整体快照落盘既大又无意义；
    // 真正需要跨重启的记忆（终端高度、右栏开合意图）由模块级纯函数单独落盘。
    actions: {
      openTab: (d, tab) => {
        const index = d.tabs.findIndex(item => item.id === tab.id)
        if (index >= 0) d.tabs[index] = { ...tab }
        else d.tabs.push({ ...tab })
        d.active = tab.id
        d.panelOpen = true
      },
      activate: (d, id) => { d.active = id },
      closeTab: (d, id) => {
        d.tabs = d.tabs.filter(tab => tab.id !== id)
        if (d.active === id) d.active = d.defaultActive
      },
      setDefault: (d, page) => {
        d.defaultActive = page
        if (!d.tabs.some(tab => tab.id === d.active)) d.active = page
      },
      patchTab: (d, id, patch) => {
        const index = d.tabs.findIndex(tab => tab.id === id)
        // 不可变更新：原地改 draft 内对象同样安全（immer 产出新对象），但保持
        // 与旧实现一致的「找不到就忽略」语义。
        if (index >= 0) d.tabs[index] = { ...d.tabs[index], ...patch }
      },
      openPage: (d, page, reviewMode) => {
        if ((page === 'sources') && !d.extraPages.includes(page)) d.extraPages.push(page)
        if (reviewMode !== undefined) d.reviewMode = reviewMode
        d.active = page
        d.panelOpen = true
      },
      closePage: (d, page) => {
        d.extraPages = d.extraPages.filter(item => item !== page)
        if (d.active === page) d.active = d.defaultActive
      },
      setPanelOpen: (d, open) => { d.panelOpen = open },
      setOverlayOpen: (d, open) => { d.overlayOpen = open },
      setReviewMode: (d, mode) => { d.reviewMode = mode },
      setSummaryOn: (d, on) => {
        d.summaryOn = on
        if (!on) d.summaryFloat = false
      },
      setSummaryFloat: (d, open) => { d.summaryFloat = open },
      setTerminalOn: (d, on) => { d.terminalOn = on },
      setTerminalHeight: (d, height) => {
        d.terminalHeight = Math.min(TERM_HEIGHT_MAX, Math.max(TERM_HEIGHT_MIN, Math.round(height)))
      },
      addTermTab: (d, tab) => {
        d.termTabs.push({ ...tab })
        d.termActive = tab.localId
      },
      closeTermTab: (d, localId) => {
        d.termTabs = d.termTabs.filter(tab => tab.localId !== localId)
        if (d.termActive === localId) d.termActive = d.termTabs[d.termTabs.length - 1]?.localId ?? ''
        if (d.termTabs.length === 0) d.terminalOn = false
      },
      setTermActive: (d, localId) => { d.termActive = localId },
      setTermDropped: (d, localId, dropped) => {
        const tab = d.termTabs.find(item => item.localId === localId)
        if (tab !== undefined) tab.dropped = Math.max(0, dropped)
      },
    },
  })
}

/** session 店的句柄类型。 */
export type ExplorerSessionStoreHandle = EngineStoreHandle<ExplorerSessionState, ExplorerSessionActions>

/** 组件侧 store props 份：`useStore` 读 + `actions` 写。 */
export type ExplorerSessionStoreProps = PropsStore<ExplorerSessionStoreHandle>
