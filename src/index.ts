/**
 * DSH-Explorer — Host half.
 *
 * 只剩终端一条链：
 *  - `POST /dsh-explorer/rpc`：`pty.open / pty.write / pty.resize / pty.close`
 *    （在会话 cwd 里起用户 PTY）；
 *  - `POST /dsh-explorer/pty`：该 PTY 的输出流。
 * 两条路由同一道闸：自定义头 `x-dsh-explorer` + 同源回环 Origin（防 DNS
 * rebinding）。
 *
 * 左侧栏的时间排序 / 置顶 / 拖拽是纯浏览器半边（直接读 `sessions` 与
 * `workspaces` 两个客户端服务），宿主侧没有任何配套。
 * 文件树、编辑器 / 预览、审查 / 上下文 / 来源面板、git 视图、插件设置卡与
 * 右侧栏宽度载荷 fork 已整体删除（2026-09 精简）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createPtyHub, gateExplorerRequest, type PtyHub, type SubprocessLike } from './pty'

// ── Loose service shapes (what the host composition really provides) ──────

interface ExplorerContext {
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): () => void
}

interface SessionLike {
  header?: { id?: string; cwd?: string }
}

interface PersistenceLike {
  inspect?: (id: string) => Promise<{ meta?: SessionLike['header'] }>
}

interface SessionsService {
  get(id: string): SessionLike | undefined
  list?: () => SessionLike[]
}

interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface Services {
  sessions: SessionsService
  /** 用户终端。Host 没有 subprocess 时打开会报错，不拖垮其它 RPC。 */
  pty: PtyHub
  /** 会话不在 live map 时的回落读取。 */
  get persistence(): PersistenceLike | undefined
}

function msg(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** live map 未 attach 时回落持久化快照；都没有才算「会话不存在」。 */
async function loadSession(sv: Services, id: string): Promise<SessionLike | null> {
  const live = sv.sessions.get(id)
  if (live !== undefined) return live
  const persistence = sv.persistence
  if (persistence?.inspect === undefined) return null
  try {
    return { header: (await persistence.inspect(id)).meta }
  } catch {
    return null
  }
}

// ── HTTP RPC ──────────────────────────────────────────────────────────────

function readJsonBody(req: IncomingMessage, cap: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      size += chunk.length
      if (size > cap) {
        overflow = true
        chunks.length = 0
        req.destroy()
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 解析会话 + cwd；失败时已经把响应写完，返回 null。 */
async function resolveSession(
  res: ServerResponse,
  sv: Services,
  sessionId: unknown,
): Promise<{ id: string; cwd: string } | null> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    sendJson(res, { error: '缺少 sessionId' })
    return null
  }
  const session = await loadSession(sv, sessionId)
  if (session === null) {
    sendJson(res, { error: '会话不存在或已卸载' })
    return null
  }
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    sendJson(res, { error: '该会话没有工作目录' })
    return null
  }
  return { id: sessionId, cwd }
}

async function handleRpc(req: IncomingMessage, res: ServerResponse, sv: Services): Promise<void> {
  // 跨站防护：本路由只接受同源页面发出的带 `x-dsh-explorer` 自定义头的请求。
  if (!gateExplorerRequest(req, res)) return
  let body: any
  try {
    body = await readJsonBody(req, 64 * 1024)
  } catch (error) {
    sendJson(res, { error: `无效请求：${msg(error)}` })
    return
  }
  const target = await resolveSession(res, sv, body?.sessionId)
  if (target === null) return
  const method = body?.method
  const args = body?.args !== null && typeof body?.args === 'object' ? body.args : {}

  try {
    switch (method) {
      case 'pty.open': {
        const cols = typeof args.cols === 'number' && Number.isFinite(args.cols) ? args.cols : 120
        const rows = typeof args.rows === 'number' && Number.isFinite(args.rows) ? args.rows : 32
        return sendJson(res, await sv.pty.open({ sessionId: target.id, cwd: target.cwd, cols, rows }))
      }
      case 'pty.write': {
        const id = typeof args.id === 'string' ? args.id : ''
        const data = typeof args.data === 'string' ? args.data : ''
        return sendJson(res, await sv.pty.write(target.id, id, data))
      }
      case 'pty.resize': {
        const id = typeof args.id === 'string' ? args.id : ''
        // 尺寸非法直接拒绝（不默认）：resize 总是客户端 fit 的产物，畸形请求是 bug，默认值只会掩盖。
        if (
          typeof args.cols !== 'number' || !Number.isFinite(args.cols)
          || typeof args.rows !== 'number' || !Number.isFinite(args.rows)
        ) {
          return sendJson(res, { error: '非法尺寸' })
        }
        return sendJson(res, await sv.pty.resize(target.id, id, args.cols, args.rows))
      }
      case 'pty.close': {
        const id = typeof args.id === 'string' ? args.id : ''
        return sendJson(res, await sv.pty.close(target.id, id))
      }
      default:
        return sendJson(res, { error: `未知方法 ${String(method)}` })
    }
  } catch (error) {
    sendJson(res, { error: msg(error) })
  }
}

async function handlePtyStream(req: IncomingMessage, res: ServerResponse, sv: Services): Promise<void> {
  if (!gateExplorerRequest(req, res)) return
  let body: any
  try {
    body = await readJsonBody(req, 64 * 1024)
  } catch (error) {
    sendJson(res, { error: `无效请求：${msg(error)}` })
    return
  }
  const sessionId = body?.sessionId
  const id = body?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof id !== 'string' || id.length === 0) {
    sendJson(res, { error: '缺少 sessionId 或终端 id' })
    return
  }
  const session = await loadSession(sv, sessionId)
  if (session === null) {
    sendJson(res, { error: '会话不存在或已卸载' })
    return
  }
  await sv.pty.attach(sessionId, id, res)
}

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx: ExplorerContext): void {
  const webServer = ctx.get('webServer') as WebServerService | undefined
  const sessions = ctx.get('sessions') as SessionsService | undefined
  // 这两个服务已通过插件对象上的 inject 声明为硬依赖（冷启动时行会等到
  // webserver 就绪后才 apply）；此处检查仅为类型收窄。
  if (webServer === undefined || sessions === undefined) {
    console.warn('dsh-explorer: required host service missing at apply, plugin inactive')
    return
  }

  // 死会话回收探针：给 PTY hub 提供当前 live 会话 id 集合做差量检测
  // （宿主没有 session 卸载事件可订阅）；sessions 缺 list 或读取异常时
  // 返回 undefined，回收停用、只留 idle 兜底。
  const pty = createPtyHub(
    () => ctx.get('subprocess') as SubprocessLike | undefined,
    () => {
      if (typeof sessions.list !== 'function') return undefined
      try {
        const ids = new Set<string>()
        for (const session of sessions.list()) {
          const id = session.header?.id
          if (typeof id === 'string' && id.length > 0) ids.add(id)
        }
        return ids
      } catch {
        return undefined
      }
    },
  )
  const services: Services = {
    sessions,
    pty,
    get persistence() { return ctx.get('sessionPersistence') as PersistenceLike | undefined },
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-explorer/rpc',
    handler: (req, res) => {
      res.on('error', () => {})
      return void handleRpc(req, res, services).catch(error => {
        if (!res.headersSent) sendJson(res, { error: msg(error) })
      })
    },
  }), 'dsh-explorer: rpc route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-explorer/pty',
    handler: (req, res) => {
      res.on('error', () => {})
      return void handlePtyStream(req, res, services).catch(error => {
        if (!res.headersSent) sendJson(res, { error: msg(error) })
      })
    },
  }), 'dsh-explorer: pty stream')

  ctx.effect(() => () => { void pty.disposeAll() }, 'dsh-explorer: pty teardown')
}

/**
 * Plugin object with hard inject: the webserver row waits for webStartup.
 * A bare apply on cold start can run before webServer exists and silently
 * drop the route. Declaring both required services makes the row wait.
 */
export default {
  name: 'dsh-explorer',
  inject: ['webServer', 'sessions'],
  apply,
}

export { handlePtyStream, handleRpc }
