/**
 * DSH-Explorer — browser half.
 *
 * 三个表面注册 + 一个动态条目，共用一个 store：
 *  - `details`（priority -10，遮蔽官方工具详情面板）：tab 式
 *    审查 / 上下文 / 文件编辑 / 预览面板（嵌入式，官方列宽）。
 *  - `sidebar.workspaces.actions` / `sidebar.footer.action`：
 *    「工作区 | 文件」切换（顶部座位会把 tab 传送进浏览区头栏同一行）。
 *  - 文件模式：点击「文件」时**动态注册**一个 priority -10 的
 *    `sidebar.workspaces` 条目临时遮蔽原生会话浏览器；点「工作区」时 dispose，
 *    原生会话栏 100% 原样恢复（不做任何自绘替代）。
 *  - `conversation.session.header.utilities`：置顶摘要、终端、右侧栏开关、会话大纲。
 *  - `settings.plugin.item`：设置 → 插件配置里的 DSH-Explorer 卡片。
 *
 * 所有 Host 数据经包私有 HTTP RPC 路由（/dsh-explorer/rpc）。
 */

import { ExplorerPanel, type LayoutFace } from './ExplorerPanel'
import { ExplorerSettingsCard } from './ExplorerSettingsCard'
import { FilesToggle } from './FilesToggle'
import { MessageRail } from './MessageRail'
import { PanelToggle } from './PanelToggle'
import { SidebarFiles } from './SidebarFiles'
import { SummaryToggle } from './SummaryToggle'
import { TerminalToggle } from './TerminalToggle'
import { installDetailsWidthMemory } from './detailsWidth'
import { createExplorerStore, type ExplorerStore } from './store'
import { injectStyles } from './styles'
import { installChatFileOpen } from './chatFileOpen'

interface SlotsLike {
  inject(name: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: (props: any) => unknown): unknown
}

interface ExplorerClientContext {
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): () => void
  slots: SlotsLike
  sessions: unknown
  workspaces: unknown
  layout: LayoutFace
}

/** Required services: slot registry, session/workspace navigation, panel layout. */
export const inject = ['slots', 'sessions', 'workspaces', 'layout']

export function apply(ctx: ExplorerClientContext): void {
  // 赶在首屏 attachPanels 之前包一层，打开右侧栏时写回上次宽度。
  installDetailsWidthMemory(ctx.layout)
  if (typeof document !== 'undefined') {
    ctx.effect(() => injectStyles(), 'dsh-explorer: styles')
  }

  const store: ExplorerStore = createExplorerStore()
  ctx.effect(
    () => installChatFileOpen(ctx.workspaces as never, ctx.sessions as never, ctx.layout, store),
    'dsh-explorer: chat file open',
  )
  let fileTreeEntry: (() => void) | null = null

  // 文件模式：动态注册 sidebar.workspaces 占用者（priority -10 遮蔽原生
  // 会话浏览器）；退出时 dispose 该条目，原生浏览器原样恢复。
  function activateFiles(): void {
    if (fileTreeEntry === null) {
      try {
        fileTreeEntry = ctx.slots.register(
          {
            name: 'sidebar.workspaces',
            priority: -10,
            inject: () => ({
              explorer: { store, layout: ctx.layout },
            }),
          },
          SidebarFiles as never,
        ) as () => void
      } catch (error) {
        console.error('dsh-explorer: 文件模式注册失败', error)
        return
      }
    }
    store.setFilesMode(true)
  }
  function deactivateFiles(): void {
    if (fileTreeEntry !== null) {
      fileTreeEntry()
      fileTreeEntry = null
    }
    store.setFilesMode(false)
  }

  // 右侧 details 列：替换官方工具详情面板（priority 更低者渲染）。
  ctx.slots.inject('details', () => ctx.slots.register(
    { name: 'details', priority: -10, inject: () => ({ explorer: { store, layout: ctx.layout, sessions: ctx.sessions } }) },
    ExplorerPanel as never,
  ))

  // 侧栏 tab：优先顶部座位（sidebar.workspaces.actions，需 ui-sidebar
  // 的 FORK 座位），组件会把「工作区 | 文件」传送进浏览区头栏；
  // 未 fork 的部署回退到底部 footer.action。两个座位同时注册，
  // 底部按钮在顶部座位激活时自动隐藏。
  let topSeatActive = false
  const toggleFace = () => ({
    explorer: {
      store,
      toggle: () => {
        if (store.filesMode) deactivateFiles()
        else activateFiles()
      },
    },
  })
  ctx.slots.inject('sidebar.workspaces.actions', () => {
    topSeatActive = true
    return ctx.slots.register(
      { name: 'sidebar.workspaces.actions', id: 'dsh-explorer-files', order: 10, inject: toggleFace },
      FilesToggle as never,
    )
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'dsh-explorer-files',
      order: 10,
      inject: () => ({ explorer: { ...toggleFace().explorer, hidden: () => topSeatActive } }),
    },
    FilesToggle as never,
  ))

  // 会话头部 utilities：每条独立 inject，一条失败不会拖垮整排。
  // 大纲组件只 portal 到对话列，头部不渲染占位节点（避免 :has 误伤）。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'dsh-explorer-summary',
      order: 10,
      inject: () => ({ explorer: { store, layout: ctx.layout, sessions: ctx.sessions } }),
    },
    SummaryToggle as never,
  ))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'dsh-explorer-term',
      // 排在右侧栏开关（20）左边：摘要 10 → 终端 15 → 右侧栏 20
      order: 15,
      inject: () => ({ explorer: { store } }),
    },
    TerminalToggle as never,
  ))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'dsh-explorer-panel',
      order: 20,
      inject: () => ({ explorer: { store, layout: ctx.layout } }),
    },
    PanelToggle as never,
  ))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'dsh-explorer-msg-rail', order: 30 },
    MessageRail as never,
  ))

  // 设置 → 插件配置：和官方卡片同一列表。注册失败不能拖死整插件。
  try {
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        return ctx.slots.register(
          {
            name: 'settings.plugin.item',
            id: 'dsh-explorer',
            key: 'dsh-explorer',
            order: 30,
          },
          ExplorerSettingsCard as never,
        )
      } catch (error) {
        console.error('dsh-explorer: 设置卡片注册失败', error)
        return () => {}
      }
    })
  } catch (error) {
    console.error('dsh-explorer: 设置卡片 inject 失败', error)
  }
}
