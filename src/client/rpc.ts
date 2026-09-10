/**
 * DSH-Explorer browser half — Host RPC client（只剩终端 PTY 一条链）。
 */

export interface RpcEnvelope<T = unknown> {
  error?: string
  [key: string]: any
}

export interface RpcOptions {
  timeoutMs?: number
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
