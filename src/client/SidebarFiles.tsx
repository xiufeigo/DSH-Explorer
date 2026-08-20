/**
 * Left-sidebar file mode: apply's activateFiles() dynamically registers this
 * on sidebar.workspaces (priority -10, temporarily shadows the native session
 * browser). Clicking the header "Workspace" tab disposes the entry and the
 * native browser returns unchanged.
 *
 * FilesToggle portals Workspace | Files into the left of the header; the
 * right side keeps only Refresh.
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
  store: ExplorerStore
  openDetails(): void
}

export function SidebarFiles({ wide, useSessions, useWorkspaces, store, openDetails }: SidebarFilesProps): JSX.Element | null {
  useExplorer(store)
  // Hooks before any early return (the selector hooks wrap useSyncExternalStore).
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
        <button className="dshx-icon-btn" title="刷新文件树" onClick={() => store.refreshTree()}>
          <IconRefreshOutline16 />
        </button>
      </div>
      <div className="dshx-sidebar-body">
        <FileTree
          cwd={cwd}
          sessionId={currentId}
          store={store}
          onOpenPanel={() => {
            store.setPanelOpen(true)
            openDetails()
          }}
        />
      </div>
    </div>
  )
}
