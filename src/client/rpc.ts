/**
 * DSH-Explorer browser half — Host RPC client plus the shared
 * "open a file tab and fill it" flow.
 */

import type { ExplorerStore, ExplorerTabKind } from './store'

export interface RpcEnvelope<T = unknown> {
  error?: string
  [key: string]: any
}

export interface RpcOptions {
  timeoutMs?: number
}

/** 仅允许 http: 与 https: 协议的外链，其它一律降级为 '#'。 */
export function safeExternalUrl(url: string | undefined | null): string {
  if (url === undefined || url === null || typeof url !== 'string') return '#'
  const stripped = url.replace(/^[\u0000-\u0020]+/, '').trim()
  if (stripped.length === 0) return '#'
  try {
    const parsed = new URL(stripped, 'http://localhost')
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      // 若原字符串不带协议（相对路径），new URL 会填上 http://localhost，需防御只有原始带 http:/https: 开头
      if (/^https?:\/\//i.test(stripped)) {
        return stripped
      }
    }
  } catch {
    /* 格式异常 */
  }
  return '#'
}

export async function rpc<T = unknown>(
  sessionId: string | undefined | null,
  method: string,
  args: Record<string, unknown> = {},
  opts: RpcOptions = {},
): Promise<RpcEnvelope<T>> {
  if (sessionId === undefined || sessionId === null || sessionId.length === 0) {
    return { error: '当前没有打开的会话' }
  }
  try {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 15000)
    const res = await fetch('/dsh-explorer/rpc', {
      method: 'POST',
      // 自定义头是 Host 侧的跨站校验闸：没有它路由直接 403。
      headers: { 'content-type': 'application/json', 'x-dsh-explorer': '1' },
      body: JSON.stringify({ sessionId, method, args }),
      signal,
    })
    if (!res.ok) return { error: `RPC 请求失败 (HTTP ${res.status})` }
    return (await res.json()) as RpcEnvelope<T>
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { error: 'RPC 请求超时' }
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { error: 'RPC 请求超时' }
    }
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
  opts: RpcOptions = {},
): Promise<RpcEnvelope<T>> {
  const deadline = Date.now() + 12000
  let last: RpcEnvelope<T> = { error: '当前没有打开的会话' }
  let wait = 200
  while (signal?.aborted !== true) {
    last = await rpc<T>(sessionId, method, args, opts)
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
  /** Host fsStatLite 提供的磁盘版本号（可能缺失：旧宿主 / 不支持的文件）。 */
  version?: string
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
  const sid = sessionId ?? ''
  // 先查已有 tab：加载在途去重；错误/空内容允许重试读取
  // （旧实现一次失败后同路径点击永远只聚焦旧错误，须手动关 tab）。
  const existing = store.sessionTabs(sid).find(tab => tab.path === path && tab.kind === kind)
  if (existing !== undefined && existing.loading) return
  const retry = existing !== undefined && (existing.error !== null || existing.content === '')
  const tab = store.openTab({ sessionId: sid, path, name, kind })
  if (!retry && existing !== undefined) return // 已有内容：仅激活聚焦
  if (retry) store.patchTab(tab.id, { loading: true, error: null })
  // 大文件读取显式放宽超时（默认 15s 会误杀）
  const res = await rpc<FsReadResult>(sessionId, 'fs.read', { path }, { timeoutMs: 30_000 })
  if (res.error !== undefined) {
    store.patchTab(tab.id, { loading: false, error: res.error, content: '' })
    return
  }
  store.patchTab(tab.id, {
    loading: false,
    error: null,
    content: res.content ?? '',
    truncated: res.truncated === true,
    // 记录磁盘基准版本，供编辑器保存时做 CAS（旧宿主缺失时为 null → 不做 CAS）
    baseVersion: res.version ?? null,
    // 记录磁盘基准大小：文件跟随首探测的已知指纹（见 fileFollow 的 known）
    baseSize: typeof res.size === 'number' ? res.size : null,
  })
}

export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}
