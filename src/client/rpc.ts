/**
 * DSH-Explorer browser half — Host RPC client plus the shared
 * "open a file tab and fill it" flow.
 */

import type { ExplorerStore, ExplorerTabKind } from './store'

export interface RpcEnvelope<T = unknown> {
  error?: string
  [key: string]: any
}

export async function rpc<T = unknown>(
  sessionId: string | undefined | null,
  method: string,
  args: Record<string, unknown> = {},
): Promise<RpcEnvelope<T>> {
  if (sessionId === undefined || sessionId === null || sessionId.length === 0) {
    return { error: '当前没有打开的会话' }
  }
  try {
    const res = await fetch('/dsh-explorer/rpc', {
      method: 'POST',
      // 自定义头是 Host 侧的跨站校验闸：没有它路由直接 403。
      headers: { 'content-type': 'application/json', 'x-dsh-explorer': '1' },
      body: JSON.stringify({ sessionId, method, args }),
    })
    if (!res.ok) return { error: `RPC 请求失败 (HTTP ${res.status})` }
    return (await res.json()) as RpcEnvelope<T>
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Host live map 还没 attach 时的瞬时错误，应重试而不是立刻画红字。 */
export function isTransientSessionError(error: string | undefined): boolean {
  return error === '会话不存在或已卸载'
    || error === '当前没有打开的会话'
    || error === '缺少 sessionId'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** 会话尚未挂上时重试一段时间，避免侧栏第一次打开闪「会话不存在或已卸载」。 */
export async function rpcWithSessionRetry<T = unknown>(
  sessionId: string | undefined | null,
  method: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<RpcEnvelope<T>> {
  const deadline = Date.now() + 12000
  let last: RpcEnvelope<T> = { error: '当前没有打开的会话' }
  let wait = 200
  while (signal?.aborted !== true) {
    last = await rpc<T>(sessionId, method, args)
    if (last.error === undefined || !isTransientSessionError(last.error)) return last
    if (Date.now() >= deadline) return last
    await sleep(wait, signal)
    wait = Math.min(Math.round(wait * 1.7), 1500)
  }
  return last
}

export interface FsReadResult {
  content?: string
  truncated?: boolean
  size?: number
  error?: string
}

/** Open (or focus) a tab and load its content from the Host. */
export async function openFileTab(
  store: ExplorerStore,
  sessionId: string | undefined | null,
  path: string,
  name: string,
  kind: ExplorerTabKind,
): Promise<void> {
  const tab = store.openTab({ sessionId: sessionId ?? '', path, name, kind })
  if (!tab.loading) return // Already open with content.
  const res = await rpc<FsReadResult>(sessionId, 'fs.read', { path })
  if (res.error !== undefined) {
    store.patchTab(tab.id, { loading: false, error: res.error, content: '' })
    return
  }
  store.patchTab(tab.id, {
    loading: false,
    error: null,
    content: res.content ?? '',
    truncated: res.truncated === true,
  })
}

export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}
