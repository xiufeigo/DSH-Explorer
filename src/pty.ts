/**
 * 用户终端：在会话 cwd 里开一条真实 PTY，输出用 NDJSON 流回浏览器。
 * 不走官方 terminals 注册表（那条缝是 Agent 工具专用）。
 *
 * POSIX 走 Host 的 subprocess.spawnTerminal。Windows 上这条缝会先
 * createProcessInspector()，而 inspector 只支持 linux/darwin，会直接抛
 * `terminal inspection is unsupported on platform win32`。所以 win32
 * （以及同错的其它平台）改走 Host 已加载的 node-pty，找不到再退到管道。
 */

import { spawn as spawnChild } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Module, { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

export interface SubprocessLike {
  resolveExecutable(command: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>
  spawnTerminal(spec: {
    argv: readonly string[]
    cwd: string
    env?: Record<string, string>
    rows: number
    cols: number
    graceMs: number
  }): Promise<TerminalHandle>
}

interface TerminalHandle {
  pid: number
  output: Readable
  done: Promise<{ exitCode: number | null }>
  write(data: string): Promise<void>
  terminate(): Promise<void>
}

interface NodePtyProcess {
  readonly pid: number
  write(data: string): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

interface NodePtyAddon {
  spawn(file: string, args: string[], options: Record<string, unknown>): NodePtyProcess
}

interface LivePty {
  id: string
  sessionId: string
  cwd: string
  handle: TerminalHandle
  listeners: Set<(line: Record<string, unknown>) => void>
  closed: boolean
}

function isNodePtyAddon(value: unknown): value is NodePtyAddon {
  return typeof value === 'object' && value !== null && typeof (value as NodePtyAddon).spawn === 'function'
}

function tryRequirePty(fromFile: string): NodePtyAddon | undefined {
  try {
    const loaded = createRequire(fromFile)('node-pty')
    return isNodePtyAddon(loaded) ? loaded : undefined
  } catch {
    return undefined
  }
}

function collectSearchFiles(): string[] {
  const files: string[] = []
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0) files.push(value)
  }
  try { push(fileURLToPath(import.meta.url)) } catch { /* bundled without import.meta */ }
  push(process.argv[1])
  push(join(process.cwd(), 'package.json'))
  push(join(dirname(process.cwd()), 'deepseek-harness', 'package.json'))
  return files
}

function walkForNodePty(startFile: string): NodePtyAddon | undefined {
  let dir = dirname(startFile)
  for (let i = 0; i < 14; i++) {
    const fromHere = tryRequirePty(join(dir, 'package.json'))
    if (fromHere !== undefined) return fromHere
    const localPkg = join(dir, 'packages', 'subprocess', 'subprocess-local', 'package.json')
    if (existsSync(localPkg)) {
      const fromLocal = tryRequirePty(localPkg)
      if (fromLocal !== undefined) return fromLocal
    }
    const nested = join(dir, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'package.json')
    if (existsSync(nested)) {
      const fromNested = tryRequirePty(nested)
      if (fromNested !== undefined) return fromNested
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function loadNodePtyFromCache(): NodePtyAddon | undefined {
  const cache = (Module as { _cache?: Record<string, { exports?: unknown }> })._cache ?? {}
  for (const filename of Object.keys(cache)) {
    const norm = filename.replace(/\\/g, '/')
    if (!/\/node-pty\/(?:lib\/)?index\.(c?js|mjs)$/.test(norm)) continue
    const exp = cache[filename]?.exports
    if (isNodePtyAddon(exp)) return exp
  }
  return undefined
}

function loadNodePty(): NodePtyAddon | undefined {
  const cached = loadNodePtyFromCache()
  if (cached !== undefined) return cached
  for (const file of collectSearchFiles()) {
    const direct = tryRequirePty(file)
    if (direct !== undefined) return direct
    const found = walkForNodePty(file)
    if (found !== undefined) return found
  }
  return undefined
}

function mergeEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return { ...env, ...extra }
}

function wrapNodePty(term: NodePtyProcess): TerminalHandle {
  const output = new PassThrough()
  const done = new Promise<{ exitCode: number | null }>(resolve => {
    term.onExit(({ exitCode, signal }) => {
      output.end()
      resolve({ exitCode: signal === undefined || signal === 0 ? exitCode : null })
    })
  })
  term.onData(data => {
    output.write(Buffer.from(data, 'utf8'))
  })
  return {
    pid: term.pid,
    output,
    done,
    async write(data) {
      term.write(data)
    },
    async terminate() {
      try { term.kill() } catch { /* already gone */ }
    },
  }
}

function spawnPiped(file: string, args: string[], cwd: string, env: Record<string, string>): TerminalHandle {
  const child = spawnChild(file, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = new PassThrough()
  child.stdout?.on('data', chunk => { output.write(chunk) })
  child.stderr?.on('data', chunk => { output.write(chunk) })
  child.on('close', () => { output.end() })
  const done = new Promise<{ exitCode: number | null }>(resolve => {
    child.on('exit', (code, signal) => {
      resolve({ exitCode: signal === null ? code : null })
    })
    child.on('error', () => { resolve({ exitCode: 1 }) })
  })
  const pid = child.pid ?? 0
  return {
    pid,
    output,
    done,
    async write(data) {
      child.stdin?.write(data)
    },
    async terminate() {
      if (process.platform === 'win32' && pid > 0) {
        spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        return
      }
      try { child.kill() } catch { /* already gone */ }
    },
  }
}

function spawnDirect(
  argv: readonly string[],
  cwd: string,
  extraEnv: Record<string, string>,
  cols: number,
  rows: number,
): TerminalHandle {
  const file = argv[0]
  if (file === undefined || file.length === 0) throw new Error('终端 argv 为空')
  const args = [...argv.slice(1)]
  const env = mergeEnv(extraEnv)
  const pty = loadNodePty()
  if (pty !== undefined) {
    return wrapNodePty(pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    }))
  }
  return spawnPiped(file, args, cwd, env)
}

async function spawnUserTerminal(
  subprocess: SubprocessLike,
  argv: readonly string[],
  cwd: string,
  cols: number,
  rows: number,
): Promise<TerminalHandle> {
  const extraEnv = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  const spec = { argv, cwd, env: extraEnv, cols, rows, graceMs: 1500 }
  if (process.platform !== 'win32') {
    try {
      return await subprocess.spawnTerminal(spec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('unsupported on platform')) throw error
    }
  }
  return spawnDirect(argv, cwd, extraEnv, cols, rows)
}

export interface PtyHub {
  open(input: { sessionId: string; cwd: string; cols: number; rows: number }): Promise<
    { id: string; pid: number; cwd: string; title: string } | { error: string }
  >
  write(sessionId: string, id: string, data: string): Promise<{ ok: true } | { error: string }>
  close(sessionId: string, id: string): Promise<{ ok: true } | { error: string }>
  attach(sessionId: string, id: string, res: ServerResponse): Promise<void>
  disposeAll(): Promise<void>
}

function clip(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function tabTitle(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  if (trimmed.length <= 28) return trimmed
  return `${trimmed.slice(0, 14)}…${trimmed.slice(-10)}`
}

async function shellArgv(subprocess: SubprocessLike): Promise<string[]> {
  if (process.platform === 'win32') {
    for (const name of ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell']) {
      try {
        const file = await subprocess.resolveExecutable(name)
        return [file, '-NoLogo']
      } catch {
        /* try next */
      }
    }
    try {
      return [await subprocess.resolveExecutable('cmd.exe')]
    } catch {
      return ['cmd.exe']
    }
  }
  const preferred = process.env.SHELL ?? '/bin/bash'
  try {
    const file = await subprocess.resolveExecutable(preferred)
    return preferred.endsWith('fish') || preferred.endsWith('csh') ? [file] : [file, '-l']
  } catch {
    return [preferred]
  }
}

function emit(pty: LivePty, line: Record<string, unknown>): void {
  for (const listener of pty.listeners) listener(line)
}

export function createPtyHub(getSubprocess: () => SubprocessLike | undefined): PtyHub {
  const live = new Map<string, LivePty>()

  const hub: PtyHub = {
    async open({ sessionId, cwd, cols, rows }) {
      const subprocess = getSubprocess()
      if (subprocess === undefined) return { error: '当前 Host 没有终端后端' }
      const argv = await shellArgv(subprocess)
      const id = `pty-${randomBytes(8).toString('hex')}`
      try {
        const handle = await spawnUserTerminal(subprocess, argv, cwd, clip(cols, 20, 300), clip(rows, 8, 120))
        const record: LivePty = {
          id,
          sessionId,
          cwd,
          handle,
          listeners: new Set(),
          closed: false,
        }
        const decoder = new StringDecoder('utf8')
        handle.output.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
          if (text.length > 0) emit(record, { t: 'out', d: text })
        })
        handle.output.on('end', () => {
          const tail = decoder.end()
          if (tail.length > 0) emit(record, { t: 'out', d: tail })
        })
        void handle.done.then(outcome => {
          record.closed = true
          emit(record, { t: 'exit', code: outcome.exitCode })
          live.delete(id)
        }).catch((error: unknown) => {
          record.closed = true
          emit(record, { t: 'err', m: error instanceof Error ? error.message : String(error) })
          live.delete(id)
        })
        live.set(id, record)
        return { id, pid: handle.pid, cwd, title: tabTitle(cwd) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },

    async write(sessionId, id, data) {
      const record = live.get(id)
      if (record === undefined || record.sessionId !== sessionId) return { error: '终端不存在' }
      if (record.closed) return { error: '终端已退出' }
      if (data.length === 0) return { ok: true }
      if (data.length > 32 * 1024) return { error: '写入过长' }
      try {
        await record.handle.write(data)
        return { ok: true }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },

    async close(sessionId, id) {
      const record = live.get(id)
      if (record === undefined) return { ok: true }
      if (record.sessionId !== sessionId) return { error: '终端不存在' }
      live.delete(id)
      record.closed = true
      try {
        await record.handle.terminate()
      } catch {
        /* already gone */
      }
      emit(record, { t: 'exit', code: null })
      record.listeners.clear()
      return { ok: true }
    },

    async attach(sessionId, id, res) {
      const record = live.get(id)
      if (record === undefined || record.sessionId !== sessionId) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '终端不存在' }))
        return
      }
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      })
      const writeLine = (line: Record<string, unknown>): void => {
        if (res.writableEnded) return
        res.write(`${JSON.stringify(line)}\n`)
      }
      record.listeners.add(writeLine)
      const ping = setInterval(() => { writeLine({ t: 'ping' }) }, 15000)
      const drop = (): void => {
        clearInterval(ping)
        record.listeners.delete(writeLine)
      }
      res.on('close', drop)
      res.on('error', drop)
      writeLine({ t: 'ready', pid: record.handle.pid, cwd: record.cwd })
    },

    async disposeAll() {
      const ids = [...live.keys()]
      await Promise.all(ids.map(async id => {
        const record = live.get(id)
        if (record === undefined) return
        live.delete(id)
        record.closed = true
        try { await record.handle.terminate() } catch { /* ignore */ }
        record.listeners.clear()
      }))
    },
  }

  return hub
}

export function gateExplorerRequest(req: IncomingMessage, res: ServerResponse, methods = 'POST, OPTIONS'): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  const sameHost = typeof origin === 'string' && origin.length > 0 && typeof host === 'string'
    && ((): boolean => {
      try { return new URL(origin).host === host } catch { return false }
    })()

  if (req.method === 'OPTIONS') {
    if (sameHost) {
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': methods,
        'access-control-allow-headers': 'content-type, x-dsh-explorer',
        'access-control-max-age': '600',
      })
      res.end()
    } else {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden origin')
    }
    return false
  }
  if (req.method !== 'POST' || req.headers['x-dsh-explorer'] !== '1') {
    res.writeHead(req.method === 'POST' ? 403 : 405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(req.method === 'POST' ? 'forbidden' : 'POST only')
    return false
  }
  return true
}
