/**
 * DSH-Explorer 浏览器半边 —— root 作用域 store（接入规范 ③）。
 *
 * ⚠️ **本文件尚未接线**：拆店方案经确认不做，作为第三项「有意偏离」收尾
 * （见 README「接入规范符合性」）。当前仍是旧的 `store.ts` 在服役；本文件与
 * `storeSession.ts` 只是备用脚手架，没有任何 register / 组件引用它们。
 * 完整工序见 docs/store-seat-migration.md。
 *
 * 与 `storeSession.ts` 成对：官方 `ui-slots` 强制「一个 store 句柄只能挂一个
 * scope」，本插件占用的 root 座位是 `sidebar.workspaces`（文件树）、
 * `sidebar.footer.action`（工作区 | 文件 切换）与 `settings.plugin.item`
 * （设置卡），这几处共享的是**跨会话**的少量 UI 状态，所以单独成店。
 *
 * root 实例全局唯一（keyless），但 apply 世界依旧**不可以**自己
 * `handle.create()`——那会与框架在 register 时建的实例分裂；apply 世界要写 root
 * 状态，只能在 root 入口的 inject 回调里用框架给的 bound actions（与官方
 * `LayoutController.attachPanels` 从 root 入口 inject 钩子接管 actions 同一手法）。
 */

import { defineStore, type EngineStoreHandle, type PropsStore } from '@deepseek-ai/dsh-client-store'

/** root 店状态：全部 JSON 兼容。 */
export interface ExplorerRootState {
  /** 左侧栏文件模式：文件树暂时顶掉会话列表。 */
  filesMode: boolean
  /** 自增计数：要求所有文件树重新读一次根目录。 */
  treeTick: number
  /**
   * 右栏最近渲染所属的会话。root 侧的「开合意图」落库需要一个会话目标，
   * 而 root 组件（文件树 / 切换按钮）自身不绑定会话，故由 session 侧回报。
   */
  currentSessionId: string | null
}

/** 声明式写集合。
 *  必须用 type alias：`ActionsDecl<T>` 是 `Record<string, …>`，TS 只为对象字面量
 *  类型别名推断隐式索引签名，interface 不满足该约束（官方同写法）。 */
export type ExplorerRootActions = {
  setFilesMode(draft: ExplorerRootState, active: boolean): void
  refreshTree(draft: ExplorerRootState): void
  noteSession(draft: ExplorerRootState, sessionId: string): void
}

/**
 * 声明 root 店。
 * @returns store 句柄（apply 里构造一次，供三个 root 座位共享）。
 */
export function createExplorerRootStore(): EngineStoreHandle<ExplorerRootState, ExplorerRootActions> {
  return defineStore({
    init: (): ExplorerRootState => ({ filesMode: false, treeTick: 0, currentSessionId: null }),
    actions: {
      setFilesMode: (d, active) => { d.filesMode = active },
      refreshTree: (d) => { d.treeTick += 1 },
      noteSession: (d, sessionId) => { d.currentSessionId = sessionId },
    },
  })
}

/** root 店的句柄类型。 */
export type ExplorerRootStoreHandle = EngineStoreHandle<ExplorerRootState, ExplorerRootActions>

/** 组件侧 store props 份：`useStore` 读 + `actions` 写。 */
export type ExplorerRootStoreProps = PropsStore<ExplorerRootStoreHandle>
