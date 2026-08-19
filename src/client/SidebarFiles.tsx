/**
 * 左侧栏文件模式面板：由 apply 里的 activateFiles() 动态注册到
 * sidebar.workspaces（priority -10，临时遮蔽原生会话浏览器）；
 * 点头栏「工作区」tab 时 dispose 本条目，原生浏览器原样恢复。
 *
 * 头栏左侧是 FilesToggle 传送进来的「工作区 | 文件」；右侧只留刷新。
 */

import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { FileTree } from './FileTree'
import { useExplorer, type ExplorerStore } from './store'

interface SessionLike {
  cwd?: string
}

interface ListStateLike {
  byId?: Record<string, SessionLike>
  current?: string
}

interface WorkspaceLike {
  workspaceId?: string
  path?: string
  sessionIds?: string[]
}

interface WorkspaceListLike {
  items?: WorkspaceLike[]
  recentWorkspaceId?: string
}

export interface SidebarFilesProps {
  wide: boolean
  expandSidebar?: () => void
  useSessions: (selector: (state: ListStateLike) => unknown) => any
  useWorkspaces: (selector: (state: WorkspaceListLike) => unknown) => any
  explorer: {
    store: ExplorerStore
    layout: { openDetails(): void }
  }
}

export function SidebarFiles({ wide, useSessions, useWorkspaces, explorer }: SidebarFilesProps): JSX.Element | null {
  useExplorer(explorer.store)
  // 钩子必须在提前 return 之前调用（框架选择器钩子内部是 useSyncExternalStore）。
  const list = (useSessions((state: ListStateLike) => state) as ListStateLike | undefined) ?? {}
  const workspaces = (useWorkspaces((state: WorkspaceListLike) => state) as WorkspaceListLike | undefined) ?? {}

  if (!wide) return null

  const currentId = list.current
  const current = currentId !== undefined ? list.byId?.[currentId] : undefined
  const items = workspaces.items ?? []

  let cwd: string | undefined = current?.cwd
  if (cwd === undefined || cwd.length === 0) {
    cwd = items.find(workspace => currentId !== undefined && (workspace.sessionIds ?? []).includes(currentId))?.path
  }
  if (cwd === undefined || cwd.length === 0) {
    cwd = items.find(workspace => workspace.workspaceId === workspaces.recentWorkspaceId)?.path ?? items[0]?.path
  }

  return (
    <div className="dshx-sidebar">
      <div className="dshx-sidebar-header">
        <div className="dshx-sidebar-tabs-slot" data-dshx-tabs-slot="" />
        <button className="dshx-icon-btn" title="刷新文件树" onClick={() => explorer.store.refreshTree()}>
          <IconRefreshOutline16 />
        </button>
      </div>
      <div className="dshx-sidebar-body">
        <FileTree
          cwd={cwd}
          sessionId={currentId}
          store={explorer.store}
          onOpenPanel={() => {
            explorer.store.setPanelOpen(true)
            explorer.layout.openDetails()
          }}
        />
      </div>
    </div>
  )
}
