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
 *    toggle, conversation outline.
 *  - `settings.plugin.item`: DSH-Explorer card on Settings → Plugins.
 *
 * Host data rides the package-private HTTP RPC route (/dsh-explorer/rpc).
 */

import { ExplorerPanel } from './ExplorerPanel'
import { ExplorerSettingsCard } from './ExplorerSettingsCard'
import { catalogActions, layoutActions } from './faces'
import { FilesToggle } from './FilesToggle'
import { MessageRail } from './MessageRail'
import { PanelToggle } from './PanelToggle'
import { SidebarFiles } from './SidebarFiles'
import { SummaryToggle } from './SummaryToggle'
import { TerminalToggle } from './TerminalToggle'
import { installDetailsWidthMemory } from './detailsWidth'
import { createExplorerStore, type ExplorerStore } from './store'
import { injectStyles } from './styles'
import { installChatFileOpen, rememberHostOpenPath } from './chatFileOpen'

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

export function apply(ctx: ExplorerClientContext): void {
  // Wrap attachPanels before the first paint so reopening details restores width.
  installDetailsWidthMemory(ctx.layout)
  if (typeof document !== 'undefined') {
    ctx.effect(() => injectStyles(), 'dsh-explorer: styles')
  }

  const store: ExplorerStore = createExplorerStore()
  const layout = layoutActions(ctx.layout)
  const catalog = catalogActions(ctx.sessions)
  rememberHostOpenPath(ctx.workspaces as never)
  ctx.effect(
    () => installChatFileOpen(ctx.workspaces as never, ctx.sessions as never, ctx.layout, store),
    'dsh-explorer: chat file open',
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
      inject: () => ({ store, ...catalog }),
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
    return ctx.slots.register(
      { name: 'sidebar.workspaces.actions', id: 'dsh-explorer-files', order: 10, inject: () => ({ store, toggleFiles }) },
      FilesToggle as never,
    )
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
      inject: () => ({ store, ...layout, ...catalog }),
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
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'dsh-explorer-msg-rail', order: 30 },
    MessageRail as never,
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
}
