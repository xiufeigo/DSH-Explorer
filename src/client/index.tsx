/**
 * DSH-Explorer — browser half.
 *
 * Three surfaces plus one dynamic occupant, sharing one store created in apply:
 *  - `details` (priority -10, shadows official tool details): review / context /
 *    file edit / preview tabs (embedded, official column width).
 *  - `sidebar.workspaces.actions` / `sidebar.footer.action`: Workspace | Files
 *    toggle (the top seat portals into the browse header).
 *  - File mode: clicking Files dynamically registers a priority -10
 *    `sidebar.workspaces` occupant; Workspace disposes it and the native list
 *    returns unchanged.
 *  - `conversation.session.header.utilities`: pinned summary, terminal, details
 *    toggle.
 *  - `settings.plugin.item`: DSH-Explorer card on Settings → Plugins.
 *
 * Host data rides the package-private HTTP RPC route (/dsh-explorer/rpc).
 */

import { ExplorerPanel } from './ExplorerPanel'
import { ExplorerSettingsCard } from './ExplorerSettingsCard'
import { layoutActions } from './faces'
import { FilesToggle } from './FilesToggle'
import { PanelToggle } from './PanelToggle'
import { SidebarFiles } from './SidebarFiles'
import { SummaryToggle } from './SummaryToggle'
import { TerminalToggle } from './TerminalToggle'
import { installDetailsWidthMemory } from './detailsWidth'
import { disposeConversationHost } from './conversationHost'
import { disposeSoundPlayer } from './soundPlayer'
import { createExplorerStore, type ExplorerStore } from './store'
import { injectStyles } from './styles'
import { rememberHostOpenPath, rememberRemoteOpenPath, resetHostOpenPath } from './chatFileOpen'
import { installNarrowOverlay, overlayAwareOpenDetails } from './narrowPanel'
import {
  installWorkspaceRecencyOrder,
  __resetForReload as resetWorkspaceRecencyOrderForReload,
} from './workspaceRecencyOrder'
import { installWorkspacePinOverlay } from './workspacePinOverlay'

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
  layout: { openDetails(): void; closeDetails(): void; toggleSidebar(): void }
}

/** Required services: slot registry, session/workspace navigation, panel layout. */
export const inject = ['slots', 'sessions', 'workspaces', 'layout']
export const name = 'dsh-explorer'
export { parentDir } from './chatFileOpen'
// 测试出口：冒烟脚本用假服务直测排序模块（含置顶状态播种/读取）。
export {
  installWorkspaceRecencyOrder,
  __setPinsForTests,
  __resetForReload,
  getWorkspacePinSummary,
  resetWorkspacePinOrder,
  commitWorkspaceOrderIntent,
  beginWorkspaceDragHold,
  endWorkspaceDragHold,
} from './workspaceRecencyOrder'
export { resetHostOpenPath, openWithSystem } from './chatFileOpen'
export { installWorkspacePinOverlay } from './workspacePinOverlay'

export function apply(ctx: ExplorerClientContext): void {
  // Wrap attachPanels before the first paint so reopening details restores width.
  ctx.effect(() => installDetailsWidthMemory(ctx.layout), 'dsh-explorer: details width memory')
  ctx.effect(() => () => {
    disposeConversationHost()
    disposeSoundPlayer()
    // 模块单例复位：插件重载后旧实例的缓存/注册不能残留给新实例
    resetHostOpenPath()
    resetWorkspaceRecencyOrderForReload()
  }, 'dsh-explorer: host and sound cleanup')
  if (typeof document !== 'undefined') {
    ctx.effect(() => injectStyles(), 'dsh-explorer: styles')
  }

  const store: ExplorerStore = createExplorerStore()
  const layout = layoutActions(ctx.layout)
  // 窄屏下所有「打开右侧栏」入口统一替换主会话区域。
  layout.openDetails = overlayAwareOpenDetails(layout.openDetails, store)
  rememberHostOpenPath(ctx.workspaces as never)
  // 0.1.2 起本地 openPath 面删除，改捕远端 `remote.session.openWorkspacePath`。
  rememberRemoteOpenPath(ctx.get('remote'))
  ctx.effect(
    () => installNarrowOverlay(store, () => ctx.layout.openDetails()),
    'dsh-explorer: narrow overlay',
  )
  ctx.effect(
    () => installWorkspaceRecencyOrder({
      sessions: ctx.sessions as never,
      workspaces: ctx.workspaces as never,
    }),
    'dsh-explorer: workspace recency order',
  )
  ctx.effect(
    () => installWorkspacePinOverlay({ workspaces: ctx.workspaces as never }),
    'dsh-explorer: workspace pin overlay',
  )
  let fileTreeEntry: (() => void) | null = null

  function activateFiles(): void {
    if (fileTreeEntry === null) {
      try {
        fileTreeEntry = ctx.slots.register(
          {
            name: 'sidebar.workspaces',
            priority: -10,
            inject: () => ({ store, openDetails: layout.openDetails }),
          },
          SidebarFiles as never,
        ) as () => void
      } catch (error) {
        console.error('dsh-explorer: file-mode registration failed', error)
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

  ctx.slots.inject('details', () => ctx.slots.register(
    {
      name: 'details',
      priority: -10,
      inject: () => ({ store, openDetails: layout.openDetails }),
    },
    ExplorerPanel as never,
  ))

  let topSeatActive = false
  const toggleFiles = (): void => {
    if (store.filesMode) deactivateFiles()
    else activateFiles()
  }
  ctx.slots.inject('sidebar.workspaces.actions', () => {
    topSeatActive = true
    const dispose = ctx.slots.register(
      { name: 'sidebar.workspaces.actions', id: 'dsh-explorer-files', order: 10, inject: () => ({ store, toggleFiles }) },
      FilesToggle as never,
    ) as () => void
    return () => {
      topSeatActive = false
      if (typeof dispose === 'function') dispose()
    }
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'dsh-explorer-files',
      order: 10,
      inject: () => ({ store, toggleFiles, filesToggleHidden: () => topSeatActive }),
    },
    FilesToggle as never,
  ))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'dsh-explorer-summary',
      order: 10,
      inject: () => ({ store, ...layout }),
    },
    SummaryToggle as never,
  ))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'dsh-explorer-term',
      order: 15,
      inject: () => ({ store }),
    },
    TerminalToggle as never,
  ))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'dsh-explorer-panel',
      order: 20,
      inject: () => ({ store, ...layout }),
    },
    PanelToggle as never,
  ))

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
        console.error('dsh-explorer: settings card register failed', error)
        return () => {}
      }
    })
  } catch (error) {
    console.error('dsh-explorer: settings card inject failed', error)
  }

  ctx.effect(() => () => {
    if (fileTreeEntry !== null) {
      fileTreeEntry()
      fileTreeEntry = null
    }
    store.setFilesMode(false)
  }, 'dsh-explorer: file-mode safety net')
}
