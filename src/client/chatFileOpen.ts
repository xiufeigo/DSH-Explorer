/**
 * Chat file-path clicks go through workspaces.openPath → OS default app.
 * We intercept text files into the details panel, but keep the original
 * opener for "open with default app" (and for binary extensions). Folders
 * must not go through this path on Windows — Invoke-Item uses the folder's
 * default app (often the IDE), not explorer.exe.
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

/** Parent directory of a POSIX or Windows path (browser-safe, no node:path). */
export function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const sepIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (sepIndex < 0) return trimmed
  const parent = trimmed.slice(0, sepIndex)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent.length > 0 ? parent : trimmed
}

let hostOpenPath: ((path: string) => Promise<void>) | null = null

/** Capture the platform opener before we wrap `workspaces.openPath`. */
export function rememberHostOpenPath(workspaces: WorkspacesFace): void {
  if (hostOpenPath === null) hostOpenPath = workspaces.openPath.bind(workspaces)
}

/** Open a path with the OS default handler (Explorer for a folder). */
export async function openWithSystem(path: string): Promise<void> {
  if (hostOpenPath === null) {
    throw new Error('系统打开不可用（插件未完成初始化）')
  }
  await hostOpenPath(path)
}

export function installChatFileOpen(
  workspaces: WorkspacesFace,
  sessions: SessionsFace,
  layout: LayoutFace,
  store: ExplorerStore,
): () => void {
  rememberHostOpenPath(workspaces)
  const original = hostOpenPath ?? workspaces.openPath.bind(workspaces)
  hostOpenPath = original
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
