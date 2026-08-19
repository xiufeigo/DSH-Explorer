/**
 * 对话里点文件路径（Read / Write / Edit 行、收尾正文 mention）会走
 * workspaces.openPath → 系统默认应用。插件把它拦下来，改在右侧栏打开。
 */

import { basename, openFileTab } from './rpc'
import type { LayoutFace } from './ExplorerPanel'
import type { ExplorerStore } from './store'

interface SessionSnap {
  current?: string
  byId?: Record<string, { cwd?: string }>
}

interface SessionsFace {
  list?: { getSnapshot(): SessionSnap }
}

interface WorkspacesFace {
  openPath(path: string): Promise<void>
}

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|7z|rar|woff2?|ttf|eot|mp[34]|wav|mov|avi|mkv|exe|dll|so|dylib|wasm|bin)$/i

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
}

function resolvePath(cwd: string | undefined, path: string): string {
  if (isAbsolute(path) || cwd === undefined || cwd.length === 0) return path
  return `${cwd.replace(/[/\\]+$/, '')}/${path.replace(/^[/\\]+/, '')}`
}

function shouldOpenInPanel(path: string): boolean {
  const trimmed = path.trim()
  if (trimmed.length === 0) return false
  if (/[/\\]$/.test(trimmed)) return false
  return !SKIP_EXT.test(trimmed)
}

export function installChatFileOpen(
  workspaces: WorkspacesFace,
  sessions: SessionsFace,
  layout: LayoutFace,
  store: ExplorerStore,
): () => void {
  const original = workspaces.openPath.bind(workspaces)
  workspaces.openPath = async (path: string) => {
    if (!shouldOpenInPanel(path)) return original(path)
    const snap = sessions.list?.getSnapshot()
    const sessionId = snap?.current
    if (typeof sessionId !== 'string' || sessionId.length === 0) return original(path)
    const cwd = snap?.byId?.[sessionId]?.cwd
    const resolved = resolvePath(cwd, path)
    layout.openDetails()
    await openFileTab(store, sessionId, resolved, basename(resolved), 'edit')
  }
  return () => {
    workspaces.openPath = original
  }
}
