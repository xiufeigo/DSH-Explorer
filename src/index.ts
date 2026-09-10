/**
 * DSH-Explorer — Host half.
 *
 * Registers one JSON RPC route on the shared `webServer`
 * (`POST /dsh-explorer/rpc`) that the browser half consumes for file-tree
 * listing, file read/write, git review views and the model context manifest,
 * plus a user PTY stream at `POST /dsh-explorer/pty`.
 * Also registers the `dsh-explorer` settings namespace so the plugin-config
 * tab can dispatch the browser card (keyed slot ∩ describe).
 * Every path operation is fenced to the requesting session's cwd. "上一回合变更"
 * is produced from git snapshots taken at the session's `turn/start` /
 * `turn/end` durable events.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, join as pathJoin, relative, resolve as pathResolve } from 'node:path'
import { openOnDesktop } from './openNative'
import { runPayloadForkOnce, type PayloadForkStatus } from './payloadFork'
import { createPtyHub, gateExplorerRequest, type PtyHub, type SubprocessLike } from './pty'
import { registerExplorerSettings } from './settingsNs'

// ── Loose service shapes (what the host composition really provides) ──────

interface ExplorerContext {
  get(name: string): unknown
  on(name: string, listener: (...args: any[]) => any): () => void
  effect(callback: () => (() => void) | void, label?: string): () => void
  inject?(deps: string[], callback: (owner: ExplorerContext) => void): unknown
}

interface FsTargetLike {
  displayPath: string
  targetKey: unknown
}

interface FsService {
  resolve(path: string, opts?: { cwd?: string }): Promise<FsTargetLike>
  contains(parent: FsTargetLike, child: FsTargetLike): boolean
  stat(target: FsTargetLike): Promise<{ version: unknown; type: string; size?: number } | undefined>
  /** 不跟随末段符号链接的探测（宿主 fs 提供 lstat 时才有；写路径防穿越用）。 */
  lstat?(path: string, opts?: { cwd?: string }): Promise<{ version?: unknown; type: string; size?: number } | undefined>
  listDir(target: FsTargetLike): Promise<Array<{
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    target: FsTargetLike
  }>>
  readText(target: FsTargetLike): Promise<string>
  writeText(target: FsTargetLike, content: string, expected?: unknown, signal?: unknown, sandboxPolicy?: unknown): Promise<unknown>
}

interface ShellService {
  resolve(request: {
    command: string
    workdir?: string
    timeoutMs?: number
    stdoutMaxBytes?: number
    sandboxPolicy?: unknown
  }): unknown
  run(spec: unknown): Promise<{
    exitCode: number | null
    stdout?: { text: string; truncated: boolean }
    stderr?: { text: string; truncated: boolean }
  }>
}

interface SessionLike {
  header?: {
    id?: string
    cwd?: string
    agentPreset?: string
    parentSession?: string
    origin?: string
    seedLength?: number
  }
  events?: readonly any[]
}

interface SessionInspectionLike {
  meta?: SessionLike['header']
  events?: readonly any[]
}

interface PersistenceLike {
  list?: () => Promise<Array<NonNullable<SessionLike['header']>>>
  inspect?: (id: string) => Promise<SessionInspectionLike>
}

interface SessionsService {
  get(id: string): SessionLike | undefined
  list?: () => SessionLike[]
}

interface SystemPromptService {
  assemble(context?: unknown): Promise<{
    sections?: Array<{ name?: string; text?: string }>
    contexts?: Array<{ name?: string; text?: string }>
    tools?: Array<{ name?: unknown }>
    variables?: Record<string, unknown>
  }>
}

interface SandboxPolicyService {
  resolve(request?: { session?: unknown; mode?: string }): unknown
}

interface WebServerService {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

interface Services {
  fs: FsService
  shell: ShellService
  sessions: SessionsService
  persistence?: PersistenceLike
  systemPrompt?: SystemPromptService
  sandboxPolicy?: SandboxPolicyService
  /** Per-call sandbox policy: the calling session plus the explicit full-access mode. */
  policyFor(session: SessionLike): unknown
  /** 用户终端。Host 没有 subprocess 时打开会报错，不拖垮其它 RPC。 */
  pty?: PtyHub
}

// ── 上一回合（last round）快照 ─────────────────────────────────────────────

interface Snapshot {
  at: number
  tracked: Record<string, string>
  untracked: Record<string, { size: number; version: string }>
  /** `git diff HEAD` 输出被 stdoutMaxBytes 截断（末尾 chunk 已丢弃，仍可能缺文件）。 */
  diffTruncated: boolean
}

interface LastRoundFile {
  path: string
  status: string
  patch: string | null
  truncated?: boolean
}

interface LastRound {
  at: number
  files: LastRoundFile[]
  /** 起点或终点快照的 diff 被截断：清单/patch 可能不完整，客户端应提示。 */
  truncated: boolean
}

const UNTRACKED_PREVIEW_CAP = 128 * 1024
const UNTRACKED_PREVIEW_LIMIT = 100
/** session.sources 每组页条目上限：达到后停收，防长会话把响应撑爆。 */
const SOURCE_PAGES_CAP = 100

function msg(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function makeBoundedMap<K, V>(cap: number): Map<K, V> {
  const map = new Map<K, V>()
  const originalSet = map.set.bind(map)
  map.set = (key: K, value: V) => {
    if (map.has(key)) {
      map.delete(key)
    } else if (map.size >= cap) {
      const oldestKey = map.keys().next().value
      if (oldestKey !== undefined) {
        map.delete(oldestKey)
      }
    }
    return originalSet(key, value)
  }
  return map
}

function shellSafe(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null
  if (/[\\'"`$;|&<>^%!\u0000-\u001f]/.test(value)) return null
  return value
}

/**
 * 路径参数校验：与 shellSafe 同一份元字符黑名单，但分隔符按平台处理——
 * win32 允许 `\` 与 `/`（Windows 绝对路径必含反斜杠），POSIX 拒绝 `\`。
 * mkdir 等文件系统路径参数走这里；git 分支名等标识符仍走 shellSafe。
 */
export function shellSafePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null
  if (/['"`$;|&<>^%!\u0000-\u001f]/.test(value)) return null
  if (process.platform !== 'win32' && value.includes('\\')) return null
  return value
}

function safeGitRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[0-9a-f]{4,64}$/i.test(trimmed)) return null
  return trimmed
}

async function runGit(
  shell: ShellService,
  policy: unknown,
  cwd: string,
  args: string,
  timeoutMs = 20000,
): Promise<{ ok: boolean; text: string; error?: string; truncated?: boolean }> {
  try {
    const spec = shell.resolve({
      command: `git -c core.quotePath=false ${args}`,
      workdir: cwd,
      timeoutMs,
      stdoutMaxBytes: 4 * 1024 * 1024,
      // Without an explicit policy the sandboxing shell falls back to the
      // deployment default (workspace-write + process cwd), which fences the
      // workdir out and makes every git call fail on a non-default session.
      sandboxPolicy: policy,
    })
    const result = await shell.run(spec)
    if (result.exitCode !== 0) {
      const detail = result.stderr?.text?.trim() || `git 命令失败 (exit ${String(result.exitCode)})`
      return { ok: false, text: '', error: detail, truncated: result.stdout?.truncated === true }
    }
    return { ok: true, text: result.stdout?.text ?? '', truncated: result.stdout?.truncated === true }
  } catch (error) {
    return { ok: false, text: '', error: msg(error) }
  }
}

/** Unquote a git porcelain path (`"a\"b"` → `a"b`, octal escapes `\NNN` → UTF-8 text). */
function unquotePath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) {
    return trimmed
  }
  const inner = trimmed.slice(1, -1)
  let out = ''
  let i = 0
  while (i < inner.length) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const nextChar = inner[i + 1]
      if (/[0-7]/.test(nextChar)) {
        const bytes: number[] = []
        while (i < inner.length && inner[i] === '\\') {
          const octalMatch = inner.slice(i + 1).match(/^[0-7]{1,3}/)
          if (!octalMatch) break
          const octalStr = octalMatch[0]
          bytes.push(parseInt(octalStr, 8))
          i += 1 + octalStr.length
        }
        if (bytes.length > 0) {
          out += new TextDecoder('utf8').decode(new Uint8Array(bytes))
        }
        continue
      }
      if (nextChar === 'n') {
        out += '\n'
        i += 2
      } else if (nextChar === 't') {
        out += '\t'
        i += 2
      } else if (nextChar === '\\') {
        out += '\\'
        i += 2
      } else if (nextChar === '"') {
        out += '"'
        i += 2
      } else {
        out += nextChar
        i += 2
      }
    } else {
      out += inner[i]
      i++
    }
  }
  return out
}

interface PorcelainEntry {
  x: string
  y: string
  path: string
  oldPath?: string
}

/**
 * `git status --porcelain=v1 -z` 解析：记录以 NUL 结尾，路径永不加引号/转义，
 * 含 " -> "、引号、空格的文件名都不会歧义（实测字节格式见下方注释）。
 * 普通记录 `XY <path>\0`；重命名/复制 `XY <new>\0<old>\0`（新路径在前，
 * 与 --name-status -z 的旧路径在前相反）。
 */
function parsePorcelainZ(text: string): PorcelainEntry[] {
  const fields = text.split('\0')
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]
    if (record.length < 4 || record[2] !== ' ') continue
    const x = record[0]
    const y = record[1]
    const path = record.slice(3)
    if (x === 'R' || x === 'C') {
      const oldPath = fields[i + 1]
      if (oldPath !== undefined && oldPath.length > 0) {
        entries.push({ x, y, oldPath, path })
        i++
        continue
      }
    }
    entries.push({ x, y, path })
  }
  return entries
}

function statusCode(x: string, y: string): string {
  if (x === '?' && y === '?') return '??'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U'
  if (x === 'A') return 'A'
  if (x === 'D') return 'D'
  if (x === 'R') return 'R'
  return 'M'
}

function splitDiffChunks(diff: string): Map<string, string> {
  const chunks = new Map<string, string>()
  const re = /^diff --git ("?a\/.*?"?)\s+("?b\/.*?"?)\s*$/gm
  const starts: Array<{ index: number; path: string }> = []
  let match: RegExpExecArray | null
  while ((match = re.exec(diff)) !== null) {
    const pathB = unquotePath(match[2]).replace(/^b\//, '')
    starts.push({ index: match.index, path: pathB })
  }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1].index : diff.length
    chunks.set(starts[k].path, diff.slice(starts[k].index, end))
  }
  return chunks
}

function detectStatus(patch: string): string {
  if (patch.includes('new file mode')) return 'A'
  if (patch.includes('deleted file mode')) return 'D'
  return 'M'
}

async function captureSnapshot(fs: FsService, shell: ShellService, policy: unknown, cwd: string): Promise<Snapshot | null> {
  const inside = await runGit(shell, policy, cwd, 'rev-parse --is-inside-work-tree', 10000)
  if (!inside.ok || inside.text.trim() !== 'true') return null

  const snapshot: Snapshot = { at: Date.now(), tracked: {}, untracked: {}, diffTruncated: false }

  const diff = await runGit(shell, policy, cwd, 'diff HEAD --')
  if (diff.truncated) {
    // 截断：最后一个 chunk 几乎必然拦腰截断，直接丢弃，防止半截 patch 冻进快照。
    console.warn('[dsh-explorer] git diff 输出被截断，上一回合快照可能不完整（已丢弃末尾不完整块）')
    snapshot.diffTruncated = true
  }
  if (diff.ok) {
    const chunks = splitDiffChunks(diff.text)
    if (diff.truncated && chunks.size > 0) {
      const lastKey = [...chunks.keys()].pop()
      if (lastKey !== undefined) chunks.delete(lastKey)
    }
    for (const [path, patch] of chunks) snapshot.tracked[path] = patch
  }

  // -z：NUL 分隔 + 原始路径，规避 " -> " 文件名误判重命名与单侧引号包裹问题。
  const status = await runGit(shell, policy, cwd, 'status --porcelain=v1 -z --untracked-files=all')
  if (status.ok) {
    let count = 0
    for (const entry of parsePorcelainZ(status.text)) {
      if (entry.x !== '?' || entry.y !== '?') continue
      if (count++ >= UNTRACKED_PREVIEW_LIMIT) break
      try {
        const target = await fs.resolve(entry.path, { cwd })
        const info = await fs.stat(target)
        if (info && info.type === 'file') {
          snapshot.untracked[entry.path] = { size: info.size ?? 0, version: String(info.version) }
        }
      } catch {
        // A vanished file simply misses the baseline.
      }
    }
  }
  return snapshot
}

async function diffSnapshots(sv: Services, cwd: string, start: Snapshot, end: Snapshot): Promise<LastRoundFile[]> {
  const files: LastRoundFile[] = []

  for (const [path, patch] of Object.entries(end.tracked)) {
    if (start.tracked[path] === patch) continue
    files.push({ path, status: detectStatus(patch), patch })
  }
  for (const [path] of Object.entries(start.tracked)) {
    if (!(path in end.tracked)) files.push({ path, status: 'reverted', patch: null })
  }
  for (const [path, meta] of Object.entries(end.untracked)) {
    const before = start.untracked[path]
    if (before === undefined) {
      files.push({ path, status: '??', patch: await previewUntracked(sv, cwd, path), truncated: false })
    } else if (before.size !== meta.size || before.version !== meta.version) {
      files.push({ path, status: '??~', patch: await previewUntracked(sv, cwd, path), truncated: false })
    }
  }
  for (const [path] of Object.entries(start.untracked)) {
    if (!(path in end.untracked)) {
      if (path in end.tracked) continue
      files.push({ path, status: 'untracked-removed', patch: null })
    }
  }
  return files
}

async function previewUntracked(sv: Services, cwd: string, path: string): Promise<string | null> {
  try {
    const fenced = await resolveInside(sv, cwd, path)
    if ('error' in fenced) return null
    const info = await sv.fs.stat(fenced)
    if (!info || info.type !== 'file' || (info.size ?? 0) > UNTRACKED_PREVIEW_CAP) return null
    return await sv.fs.readText(fenced)
  } catch {
    return null
  }
}

// ── 文件树 / 读写 ──────────────────────────────────────────────────────────

async function resolveInside(sv: Services, cwd: string, path: string): Promise<FsTargetLike | { error: string }> {
  if (typeof path !== 'string' || path.length === 0) return { error: '缺少路径' }
  const root = await sv.fs.resolve(cwd)
  // 相对路径必须按会话工作目录解析，否则落到宿主启动目录，围栏判定失真。
  const target = await sv.fs.resolve(path, { cwd })
  if (!sv.fs.contains(root, target)) return { error: '路径超出会话工作目录' }
  return target
}

async function fsList(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const path = typeof args.path === 'string' && args.path.length > 0 ? args.path : cwd
  const dir = await resolveInside(sv, cwd, path)
  if ('error' in dir) return { error: dir.error }
  const entries = await sv.fs.listDir(dir)
  const out: Array<{ name: string; type: string; size?: number; path: string }> = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    out.push({
      name: entry.name,
      type: entry.type,
      size: typeof entry.size === 'number' ? entry.size : undefined,
      path: entry.target.displayPath,
    })
  }
  out.sort((a, b) => {
    const ad = a.type === 'directory' ? 1 : 0
    const bd = b.type === 'directory' ? 1 : 0
    if (ad !== bd) return bd - ad
    return a.name.localeCompare(b.name)
  })
  return { path: dir.displayPath, entries: out }
}

async function fsRead(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await resolveInside(sv, cwd, String(args.path ?? ''))
  if ('error' in target) return { error: target.error }
  const info = await sv.fs.stat(target)
  if (!info || info.type !== 'file') return { error: '不是普通文件' }
  const size = info.size ?? 0
  if (size > 2 * 1024 * 1024) return { error: `文件过大（${formatSize(size)}），暂不支持预览与编辑`, size }
  try {
    const content = await sv.fs.readText(target)
    // CAS 契约：附带版本指纹，编辑器保存时作为 expected 传回，防止盲覆盖外部改动。
    return {
      content,
      truncated: false,
      path: target.displayPath,
      size,
      version: info.version === undefined ? null : String(info.version),
    }
  } catch (error) {
    return { error: `读取失败（可能是二进制文件）：${msg(error)}`, size }
  }
}

/** 轻量变更探测：只回版本指纹与大小，供预览页轮询自动刷新。 */
async function fsStatLite(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await resolveInside(sv, cwd, String(args.path ?? ''))
  if ('error' in target) return { error: target.error }
  try {
    const info = await sv.fs.stat(target)
    if (!info || info.type !== 'file') return { error: '不是普通文件' }
    return { version: info.version === undefined ? null : String(info.version), size: info.size ?? 0 }
  } catch (error) {
    return { error: msg(error) }
  }
}

/**
 * fs.write 的 CAS 请求契约（定稿）：
 * - 请求 `expected` = fs.read 响应里的 `version` 指纹字符串；省略 / null = 无条件覆盖。
 * - fs seam 只认 `{kind:'replaceIfVersion', version}`（dsh-fs-local 的 FsWriteIntent），
 *   这里完成包装；对象形态原样透传以兼容未来的直传客户端。
 */
function toWriteIntent(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'replaceIfVersion') return raw
  if (typeof raw === 'string' && raw.length > 0) return { kind: 'replaceIfVersion' as const, version: raw }
  return undefined
}

/** 从 writeText 结果（FsWriteOutcome）里取新版本指纹，缺失返回 null。 */
function versionOfOutcome(outcome: unknown): string | null {
  if (outcome !== null && typeof outcome === 'object') {
    const version = (outcome as { version?: unknown }).version
    if (version !== undefined) return String(version)
  }
  return null
}

/**
 * 写路径防符号链接穿越。contains 的 realpath 围栏挡得住「指向外部的在链」，
 * 挡不住断链：resolveLocalTarget 对断链做祖先回退保留词法路径，而底层
 * open('w') 会跟随链接在围栏外落盘。这里对词法路径上的每个符号链接组件
 * 做 resolve + stat + contains 三查：断链或解析到围栏外 → 拒绝写入；
 * 指向围栏内的正常链接（pnpm workspace 的 node_modules 等）放行。
 * 宿主 fs 未提供 lstat 时跳过检查（围栏仍含 realpath contains）。
 */
async function assertWritableThroughLinks(sv: Services, cwd: string, target: FsTargetLike): Promise<string | null> {
  if (typeof sv.fs.lstat !== 'function') return null
  const rel = relative(cwd, target.displayPath)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null
  const segments = rel.split(/[\\/]+/).filter(seg => seg.length > 0 && seg !== '.')
  if (segments.length === 0) return null
  const root = await sv.fs.resolve(cwd)
  let prefix = cwd
  for (const seg of segments) {
    prefix = pathJoin(prefix, seg)
    let info: { version?: unknown; type: string; size?: number } | undefined
    try {
      info = await sv.fs.lstat?.(prefix, { cwd })
    } catch {
      return null // lstat 自身失败（权限等）不拦截，交由底层写报错
    }
    if (info === undefined) return null // 组件不存在：更深的组件只会由本次写创建，词法围栏已够
    if (info.type !== 'symlink') continue
    let resolved: FsTargetLike
    try {
      resolved = await sv.fs.resolve(prefix)
    } catch {
      return '路径包含无法解析的符号链接，已拒绝写入'
    }
    const st = await sv.fs.stat(resolved).catch(() => undefined)
    if (st === undefined) return '路径包含断开的符号链接，已拒绝写入'
    if (!sv.fs.contains(root, resolved)) return '路径经符号链接指向工作目录外，已拒绝写入'
  }
  return null
}

async function fsWrite(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await resolveInside(sv, cwd, String(args.path ?? ''))
  if ('error' in target) return { error: target.error }
  const content = args.content
  if (typeof content !== 'string') return { error: '缺少内容' }
  // 与读取侧 2MB 上限对称：超大内容（误粘贴等）直接拒绝。
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) return { ok: false, error: '内容超过 2MB，不支持编辑保存' }
  const linkError = await assertWritableThroughLinks(sv, cwd, target)
  if (linkError !== null) return { ok: false, error: linkError }
  // The user clicked 保存 in the editor — that IS the approval, so the write
  // runs under the explicit full-access mode with the session boundary kept.
  const policy = sv.sandboxPolicy?.resolve({ session: args.session === undefined ? undefined : args.session, mode: 'danger-full-access' })
  try {
    // CAS 契约：expected 包装成 {kind:'replaceIfVersion', version}，版本不符由
    // writeText 拒绝（FS_STALE_VERSION），避免覆盖外部并发改动。
    const outcome = await sv.fs.writeText(target, content, toWriteIntent(args.expected), undefined, policy)
    // 回写成功附带新版本指纹：客户端应更新 baseVersion 作为下一轮 CAS 基准。
    let version = versionOfOutcome(outcome)
    if (version === null) {
      const after = await sv.fs.stat(target).catch(() => undefined)
      version = after !== undefined && after.version !== undefined ? String(after.version) : null
    }
    return { ok: true, version }
  } catch (error) {
    return { ok: false, error: msg(error) }
  }
}

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

/** 新建文件 / 文件夹（文件树右键）。建文件复用 writeText——底层原子写会自动补齐父目录。 */
async function fsCreate(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parentPath = String(args.path ?? '')
  const parent = await resolveInside(sv, cwd, parentPath === '' ? cwd : parentPath)
  if ('error' in parent) return { error: parent.error }
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (name.length === 0) return { error: '缺少名称' }
  if (
    name === '.'
    || name === '..'
    || /[\\/:*?"<>|&%\u0000-\u001f]/.test(name)
    || name.length > 200
    || name.endsWith('.')
    || name.endsWith(' ')
    || WINDOWS_RESERVED_NAMES.test(name)
  ) {
    return { error: '名称含非法字符或过长' }
  }
  const kind = args.kind === 'dir' ? 'dir' : 'file'
  const sep = parent.displayPath.includes('\\') || /^[A-Za-z]:/.test(parent.displayPath) ? '\\' : '/'
  const joined = `${parent.displayPath.replace(/[\\/]+$/, '')}${sep}${name}`
  const target = await resolveInside(sv, cwd, joined)
  if ('error' in target) return { error: target.error }
  try {
    const existing = await sv.fs.stat(target)
    if (existing) return { error: '同名文件或目录已存在' }
  } catch { /* 不存在即目标状态 */ }
  // 新建同样防符号链接穿越（断链跟随会在围栏外落盘，文件与目录两条路径都查）。
  const linkError = await assertWritableThroughLinks(sv, cwd, target)
  if (linkError !== null) return { ok: false, error: linkError }

  // 用户在插件 UI 里显式点了新建 —— 与编辑器保存同一授权语义
  const policy = sv.sandboxPolicy?.resolve({ session: args.session === undefined ? undefined : args.session, mode: 'danger-full-access' })
  try {
    if (kind === 'file') {
      await sv.fs.writeText(target, '', undefined, undefined, policy)
      return { ok: true }
    }
    // 目录：fs 服务没有 mkdir，走 shell（与 git 同一条执行链）。
    // Windows 绝对路径必含反斜杠，这里走按平台放行分隔符的 shellSafePath。
    const abs = nativeFsPath(target)
    const safeAbs = shellSafePath(abs)
    if (safeAbs === null) return { ok: false, error: '路径含不安全字符' }
    const command = process.platform === 'win32' ? `mkdir "${safeAbs}"` : `mkdir -p "${safeAbs}"`
    const spec = sv.shell.resolve({
      command,
      workdir: cwd,
      timeoutMs: 10000,
      stdoutMaxBytes: 64 * 1024,
      sandboxPolicy: policy,
    })
    const result = await sv.shell.run(spec)
    if (result.exitCode !== 0) {
      const detail = result.stderr?.text?.trim() || `mkdir 失败 (exit ${String(result.exitCode)})`
      return { ok: false, error: detail }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: msg(error) }
  }
}

function nativeFsPath(target: FsTargetLike): string {
  if (typeof target.targetKey === 'string' && target.targetKey.length > 0) return target.targetKey
  return target.displayPath
}

/** Open the containing folder in Explorer / Finder / the desktop file manager. */
async function fsReveal(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await resolveInside(sv, cwd, String(args.path ?? ''))
  if ('error' in target) return { error: target.error }
  const info = await sv.fs.stat(target)
  const abs = nativeFsPath(target)
  const folder = info?.type === 'directory' ? abs : dirname(abs)
  if (folder.length === 0) return { error: '无法确定所在目录' }
  try {
    await openOnDesktop(folder, 'folder')
    return { ok: true }
  } catch (error) {
    return { error: `无法打开资源管理器：${msg(error)}` }
  }
}

/** Open the file with the OS default application (not the in-panel editor). */
async function fsOpenExternal(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await resolveInside(sv, cwd, String(args.path ?? ''))
  if ('error' in target) return { error: target.error }
  const info = await sv.fs.stat(target)
  if (!info || info.type !== 'file') return { error: '不是普通文件' }
  try {
    await openOnDesktop(nativeFsPath(target), 'file')
    return { ok: true }
  } catch (error) {
    return { error: `无法用默认程序打开：${msg(error)}` }
  }
}

// ── Git 审查视图 ───────────────────────────────────────────────────────────

async function gitStatus(sv: Services, policy: unknown, cwd: string): Promise<Record<string, unknown>> {
  const inside = await runGit(sv.shell, policy, cwd, 'rev-parse --is-inside-work-tree', 10000)
  if (!inside.ok || inside.text.trim() !== 'true') {
    return { notRepo: true, branch: '', files: [], error: `无法确认 Git 状态：${inside.error ?? '不是 Git 仓库'}` }
  }
  const branch = await runGit(sv.shell, policy, cwd, 'rev-parse --abbrev-ref HEAD')
  // -z：NUL 分隔 + 原始路径（见 parsePorcelainZ 注释）。
  const status = await runGit(sv.shell, policy, cwd, 'status --porcelain=v1 -z --untracked-files=all')
  if (!status.ok) return { branch: branch.ok ? branch.text.trim() : '', files: [], error: status.error }
  const files = parsePorcelainZ(status.text)
    .map(entry => ({ path: entry.path, oldPath: entry.oldPath, status: statusCode(entry.x, entry.y) }))
  return { branch: branch.ok ? branch.text.trim() : '', files }
}

function listFile(file: { path: string; oldPath?: string; status: string }, hasPatch: boolean): Record<string, unknown> {
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    hasPatch,
  }
}

async function gitDiff(sv: Services, policy: unknown, cwd: string): Promise<Record<string, unknown>> {
  const status = await gitStatus(sv, policy, cwd)
  // gitStatus 的两条失败路径 files 都恒为 []，「files 是否存在」守卫永假 →
  // error 被吞、坏仓库显示成「工作区干净」。改为显式传播 error。
  if (status.error !== undefined) return status
  const files = status.files as Array<{ path: string; oldPath?: string; status: string }>
  // 列表不带 patch：全量 diff 塞进右侧栏会让拖列宽/滚动卡死。正文走 git.fileDiff。
  const out = files.map(file => listFile(file, file.status !== '??'))
  return { branch: status.branch, files: out }
}

/** 候选基准分支解析：origin/HEAD → origin/main → origin/master → main → master，验证可用即返回。 */
async function resolveBaseCandidate(sv: Services, policy: unknown, cwd: string): Promise<string> {
  const candidates: string[] = []
  const remoteHead = await runGit(sv.shell, policy, cwd, 'rev-parse --abbrev-ref refs/remotes/origin/HEAD', 10000)
  if (remoteHead.ok && remoteHead.text.trim().length > 0) candidates.push(remoteHead.text.trim())
  candidates.push('origin/main', 'origin/master', 'main', 'master')
  for (const candidate of candidates) {
    // `-` 开头的候选会被 git 按选项解析，直接拒绝（refname 本身也禁止前导 -）
    if (candidate.startsWith('-')) continue
    const safeCandidate = shellSafe(candidate)
    if (safeCandidate === null) continue
    // 注意：rev-parse --verify 不接受裸 `--` 分隔符（"Needed a single revision"），
    // 用等价的 --end-of-options 隔断后续参数的选项语义。
    const check = await runGit(sv.shell, policy, cwd, `rev-parse --verify --end-of-options "${safeCandidate}"`, 10000)
    if (check.ok) return safeCandidate
  }
  return ''
}

async function findBranchBase(
  sv: Services,
  policy: unknown,
  cwd: string,
): Promise<{ branch: string; base: string; merge: string } | { error: string; branch?: string }> {
  const inside = await runGit(sv.shell, policy, cwd, 'rev-parse --is-inside-work-tree', 10000)
  if (!inside.ok || inside.text.trim() !== 'true') {
    return { error: `无法确认 Git 状态：${inside.error ?? '不是 Git 仓库'}` }
  }
  const branch = await runGit(sv.shell, policy, cwd, 'rev-parse --abbrev-ref HEAD')
  const branchName = branch.ok ? branch.text.trim() : ''
  const base = await resolveBaseCandidate(sv, policy, cwd)
  if (base.length === 0) {
    return { error: '未找到基准分支（尝试过 origin/main、main 等）', branch: branchName }
  }
  const mergeBase = await runGit(sv.shell, policy, cwd, `merge-base HEAD "${base}"`)
  if (!mergeBase.ok) return { error: mergeBase.error ?? 'merge-base 失败', branch: branchName }
  return { branch: branchName, base, merge: mergeBase.text.trim() }
}

/**
 * `git diff --name-status -z -M` 解析。实测字节序：`<status>\0<path>\0`；
 * 重命名/复制 `<status>\0<old>\0<new>\0`（旧路径在前——与 status -z 相反），
 * 状态字段可带相似度分（如 R100），路径永不加引号。
 */
function parseNameStatusZ(text: string): Array<{ path: string; oldPath?: string; status: string }> {
  const fields = text.split('\0')
  const files: Array<{ path: string; oldPath?: string; status: string }> = []
  for (let i = 0; i < fields.length; i++) {
    const statusField = fields[i]
    if (statusField.length === 0) continue
    const code = statusField[0]
    const first = fields[i + 1]
    if (first === undefined || first.length === 0) break
    if (code === 'R' || code === 'C') {
      const second = fields[i + 2]
      if (second !== undefined && second.length > 0) {
        files.push({ status: 'R', oldPath: first, path: second })
        i += 2
      } else {
        // 孤儿重命名（git 正常不产出）：按重命名单路径降级，不误标成 M。
        files.push({ status: 'R', path: first })
        i += 1
      }
      continue
    }
    files.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', path: first })
    i += 1
  }
  return files
}

async function gitBranch(sv: Services, policy: unknown, cwd: string): Promise<Record<string, unknown>> {
  const found = await findBranchBase(sv, policy, cwd)
  if ('error' in found) {
    return { notRepo: found.branch === undefined, branch: found.branch ?? '', base: '', commits: [], files: [], error: found.error }
  }
  const safeMerge = safeGitRef(found.merge)
  if (safeMerge === null) {
    return { branch: found.branch, base: found.base, commits: [], files: [], error: '基准 commit hash 非法' }
  }
  // -z：NUL 分隔 + 原始路径（见 parseNameStatusZ 注释）。
  const nameStatus = await runGit(sv.shell, policy, cwd, `diff --name-status -z -M "${safeMerge}"...HEAD --`)
  const files = nameStatus.ok
    ? parseNameStatusZ(nameStatus.text).map(file => listFile(file, true))
    : []
  const log = await runGit(sv.shell, policy, cwd, `log --oneline --no-decorate -50 "${found.base}"..HEAD`)
  const commits = log.ok
    ? log.text.split('\n').filter(line => line.length > 0).map(line => {
        const m = line.match(/^([0-9a-f]+)\s+(.*)$/)
        return m ? { hash: m[1], subject: m[2] } : { hash: line, subject: '' }
      })
    : []
  return { branch: found.branch, base: found.base, commits, files }
}

/** Relpath for `git diff -- <path>`: fence traversal and shell metacharacters. */
function safeGitRelPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return null
  const parts = normalized.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) return null
  if (/[\0\r\n"'`$\\;|&<>]/.test(normalized)) return null
  return normalized
}

/** 编辑 tab 常传绝对路径；转成相对 cwd 的 git pathspec。 */
function toGitRel(cwd: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
  const input = raw.trim()
  let rel: string
  if (isAbsolute(input)) {
    const relPath = relative(cwd, input)
    if (relPath.length === 0 || isAbsolute(relPath)) return null
    const normalized = relPath.replace(/\\/g, '/')
    if (normalized === '..' || normalized.startsWith('../')) return null
    rel = normalized
  } else {
    rel = input.replace(/\\/g, '/')
  }
  return safeGitRelPath(rel)
}

async function gitFileDiff(
  sv: Services,
  policy: unknown,
  cwd: string,
  sessionId: string,
  args: Record<string, unknown>,
  lastRounds: Map<string, LastRound>,
): Promise<Record<string, unknown>> {
  const rel = toGitRel(cwd, args.path)
  if (rel === null) return { error: '非法路径', patch: null }
  const mode = args.mode === 'last' || args.mode === 'branch' ? args.mode : 'git'
  if (mode === 'last') {
    const round = lastRounds.get(sessionId)
    const file = round?.files.find((item: LastRoundFile) => item.path.replace(/\\/g, '/') === rel)
    return { path: rel, patch: file?.patch ?? null, truncated: round?.truncated === true }
  }
  const fenced = await resolveInside(sv, cwd, pathResolve(cwd, rel))
  if ('error' in fenced) return { error: fenced.error, patch: null }
  const quoted = `"${rel}"`
  if (mode === 'branch') {
    const found = await findBranchBase(sv, policy, cwd)
    if ('error' in found) return { error: found.error, patch: null }
    const safeMerge = safeGitRef(found.merge)
    if (safeMerge === null) return { error: '基准 commit hash 非法', patch: null }
    const diff = await runGit(sv.shell, policy, cwd, `diff "${safeMerge}"...HEAD -- ${quoted}`)
    if (!diff.ok) return { error: diff.error, patch: null }
    return { path: rel, patch: diff.text.length > 0 ? diff.text : null, truncated: diff.truncated === true }
  }
  const tracked = await runGit(sv.shell, policy, cwd, `ls-files --error-unmatch -- ${quoted}`)
  if (!tracked.ok) {
    const inside = await runGit(sv.shell, policy, cwd, 'rev-parse --is-inside-work-tree', 10000)
    const inRepo = inside.ok && inside.text.trim() === 'true'
    return { path: rel, patch: null, untracked: inRepo }
  }
  const diff = await runGit(sv.shell, policy, cwd, `diff HEAD -- ${quoted}`)
  if (!diff.ok) return { error: diff.error, patch: null }
  // truncated=true：单文件 diff 超 stdoutMaxBytes 被截断，patch 结尾可能残缺——客户端应提示。
  return { path: rel, patch: diff.text.length > 0 ? diff.text : null, untracked: false, truncated: diff.truncated === true }
}

function safeBranchName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (name.length === 0 || name.length > 200) return null
  if (name === 'HEAD' || name.includes('..') || name.startsWith('-')) return null
  if (!/^[A-Za-z0-9._/\-]+$/.test(name)) return null
  return name
}

/**
 * 提交说明校验：不静默删改用户文本。命令经 bash -c / pwsh -Command 的
 * 双引号字符串插值执行，" ` $ \ 四个字符无法无转义安全直传（闭合引号/
 * 触发展开/移动闭引号），命中即整体拒绝并指明字符让用户自己改；
 * % 与换行在该上下文是字面量，放行。
 */
function safeCommitMessage(raw: unknown): { ok: true; message: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: '请填写提交说明' }
  const message = raw.trim()
  if (message.length === 0) return { ok: false, error: '请填写提交说明' }
  if (message.length > 2000) return { ok: false, error: '提交说明过长（超过 2000 字符）' }
  if (/["`$\\]/.test(message)) {
    return { ok: false, error: '提交说明包含无法安全传递的字符（" ` $ \\），请修改后重试' }
  }
  return { ok: true, message }
}

async function gitSummary(sv: Services, policy: unknown, cwd: string): Promise<Record<string, unknown>> {
  const inside = await runGit(sv.shell, policy, cwd, 'rev-parse --is-inside-work-tree', 10000)
  if (!inside.ok || inside.text.trim() !== 'true') {
    return { notRepo: true, error: `无法确认 Git 状态：${inside.error ?? '不是 Git 仓库'}` }
  }
  const branch = await runGit(sv.shell, policy, cwd, 'rev-parse --abbrev-ref HEAD')
  const list = await runGit(sv.shell, policy, cwd, 'branch --list --format=%(refname:short)')
  const branches = list.ok
    ? list.text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    : []
  const numstat = await runGit(sv.shell, policy, cwd, 'diff --numstat HEAD')
  let added = 0
  let deleted = 0
  if (numstat.ok) {
    for (const line of numstat.text.split('\n')) {
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+/)
      if (match === null) continue
      if (match[1] !== '-') added += Number(match[1])
      if (match[2] !== '-') deleted += Number(match[2])
    }
  }
  // 「dirty」字段已删：客户端从不读（SummaryCard 仅声明类型），
  // 而这行全量 status --untracked-files=all 在大仓库上每 8s 一次纯属浪费。
  // +N 口径补未跟踪（README 承诺「变更 +N/-N」含未跟踪；numstat 只算已跟踪）：
  // 未跟踪文件全部视为新增行。上限复用 lastRound 的预览口径（≤100 个、单文件
  // ≤128KB 的文本文件精确计行，二进制/超大/超量静默跳过——统计是近似但方向正确）。
  // 路径按 git 输出口径（仓库根相对）配 { cwd } 解析，与 captureSnapshot 同约定：
  // cwd 即仓库根（常见形态）时精确，子目录 cwd 时个别路径解析不中即跳过。
  const others = await runGit(sv.shell, policy, cwd, 'ls-files --others --exclude-standard -z')
  if (others.ok) {
    let count = 0
    for (const path of others.text.split('\0')) {
      if (path.length === 0) continue
      if (count++ >= UNTRACKED_PREVIEW_LIMIT) break
      try {
        const fenced = await resolveInside(sv, cwd, path)
        if ('error' in fenced) continue
        const info = await sv.fs.stat(fenced)
        if (!info || info.type !== 'file' || (info.size ?? 0) > UNTRACKED_PREVIEW_CAP) continue
        const content = await sv.fs.readText(fenced)
        added += content.length === 0 ? 0 : content.split('\n').length
      } catch {
        // 二进制（readText 抛错）/ 刚消失的文件：跳过不计
      }
    }
  }
  const remote = await runGit(sv.shell, policy, cwd, 'remote get-url origin', 10000)
  const remoteUrl = remote.ok ? remote.text.trim() : ''
  // 基准分支候选与 findBranchBase 同一条解析链（origin/HEAD → origin/main → …）。
  const base = await resolveBaseCandidate(sv, policy, cwd)
  const branchName = branch.ok ? branch.text.trim() : ''
  return {
    branch: branchName,
    branches,
    added,
    deleted,
    remoteUrl,
    base,
    compareUrl: githubCompareUrl(remoteUrl, branchName, base),
  }
}

function githubCompareUrl(remoteUrl: string, branch: string, base: string): string | null {
  if (remoteUrl.length === 0 || branch.length === 0) return null
  const cleaned = remoteUrl.replace(/\.git$/i, '')
  const match = cleaned.match(/github\.com[/:]([^/]+\/[^/]+)$/i)
  if (match === null) return null
  const slug = match[1]
  const baseRef = (base.replace(/^origin\//, '') || 'main')
  return `https://github.com/${slug}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(branch)}`
}

async function gitCheckout(sv: Services, policy: unknown, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = safeBranchName(args.branch)
  if (name === null) return { ok: false, error: '无效的分支名' }
  // 不带尾随空 pathspec 的 `--`（个别 git 版本对空 pathspec 报错）；
  // 分支名已过 safeBranchName 白名单校验，单参数时 git 优先按 ref 解析。
  const result = await runGit(sv.shell, policy, cwd, `checkout "${name}"`)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, branch: name }
}

async function gitCommit(sv: Services, policy: unknown, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const checked = safeCommitMessage(args.message)
  if (!checked.ok) return { ok: false, error: checked.error }
  const add = await runGit(sv.shell, policy, cwd, 'add -A')
  if (!add.ok) return { ok: false, error: add.error }
  const commit = await runGit(sv.shell, policy, cwd, `commit -m "${checked.message}"`)
  if (!commit.ok) return { ok: false, error: commit.error }
  return { ok: true, text: commit.text.trim() }
}

async function gitPush(sv: Services, policy: unknown, cwd: string): Promise<Record<string, unknown>> {
  const result = await runGit(sv.shell, policy, cwd, 'push --porcelain')
  if (!result.ok) {
    const upstream = await runGit(sv.shell, policy, cwd, 'push -u origin HEAD --porcelain')
    if (!upstream.ok) return { ok: false, error: upstream.error ?? result.error }
    return { ok: true, text: upstream.text.trim() }
  }
  return { ok: true, text: result.text.trim() }
}

function flattenBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}

async function loadSessionLog(sv: Services, id: string): Promise<SessionLike | null> {
  const live = sv.sessions.get(id)
  if (live !== undefined) return live
  if (sv.persistence?.inspect === undefined) return null
  try {
    const inspected = await sv.persistence.inspect(id)
    return { header: inspected.meta, events: inspected.events }
  } catch {
    return null
  }
}

function sessionSources(session: SessionLike): Record<string, unknown> {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const groups = new Map<string, {
    name: string
    title: string
    searches: number
    fetches: number
    pages: Array<{ url: string; title: string; snippet: string }>
  }>()

  // 每组 URL 去重走 Set（原先 pages.some 线性扫描是 O(N²)）。
  const groupUrls = new Map<string, Set<string>>()

  const ensure = (name: string, title: string) => {
    const existing = groups.get(name)
    if (existing !== undefined) return existing
    const created = { name, title, searches: 0, fetches: 0, pages: [] as Array<{ url: string; title: string; snippet: string }> }
    groups.set(name, created)
    groupUrls.set(name, new Set<string>())
    return created
  }

  const addPage = (group: ReturnType<typeof ensure>, url: string, title: string, snippet: string): void => {
    if (group.pages.length >= SOURCE_PAGES_CAP) return
    if (url.length === 0 && title.length === 0) return
    if (url.length > 0) {
      const seen = groupUrls.get(group.name)
      if (seen !== undefined && seen.has(url)) return
      seen?.add(url)
    }
    group.pages.push({ url, title: title.length > 0 ? title : url, snippet })
  }

  const events = session.events
  if (Array.isArray(events)) {
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'tool/call') {
        const callId = String(event.data?.callId ?? '')
        const name = String(event.data?.name ?? '')
        let parsed: Record<string, unknown> = {}
        const raw = event.data?.arguments
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            const value = JSON.parse(raw) as unknown
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
          } catch { /* keep empty */ }
        }
        if (callId.length > 0) calls.set(callId, { name, args: parsed })
      } else if (event.type === 'tool/result') {
        // 载荷契约（tool-cordis SessionEventMap / dsh-agent-loop appendToolResult）：
        // callId/content 嵌在 data.message（ToolResultMessage）里；
        // 顶层形态作为旧日志兼容回退。
        const payload = (event.data?.message ?? event.data ?? {}) as Record<string, unknown> | null | undefined
        const callId = String(payload?.callId ?? '')
        const call = calls.get(callId)
        const name = call?.name ?? String(payload?.name ?? event.data?.name ?? 'tool')
        const isSearch = name.includes('search')
        const isFetch = name.includes('fetch') || name.includes('browse')
        const hasUrl = typeof call?.args.url === 'string'
        const hasQuery = typeof call?.args.query === 'string'
        if (!isSearch && !isFetch && name !== 'web_search' && name !== 'web_fetch' && !hasUrl && !hasQuery) continue
        const title = name === 'web_search' || isSearch ? '网页搜索' : name === 'web_fetch' || isFetch ? '打开的网页' : name
        const group = ensure(name, title)
        if (isSearch || name === 'web_search') group.searches += 1
        if (isFetch || name === 'web_fetch') group.fetches += 1
        const query = typeof call?.args.query === 'string' ? call.args.query : ''
        const argUrl = typeof call?.args.url === 'string' ? call.args.url : ''
        const content = flattenBlocks(payload?.content)
        const urlMatches = content.match(/https?:\/\/[^\s)\]>'"]+/g) ?? []
        if (argUrl.length > 0) addPage(group, argUrl, argUrl, content.slice(0, 240))
        for (const url of urlMatches) addPage(group, url, url, query)
        if (argUrl.length === 0 && urlMatches.length === 0 && query.length > 0) {
          addPage(group, '', query, content.slice(0, 240))
        }
      }
    }
  }
  return { groups: [...groups.values()] }
}

// ── 会话数据 ───────────────────────────────────────────────────────────────

async function contextMeta(sv: Services, session: SessionLike): Promise<Record<string, unknown>> {
  const prompt = sv.systemPrompt
  if (prompt === undefined) return { sections: [], contexts: [], tools: [], variables: [] }
  try {
    let assembly
    try {
      // 显式带上会话，宿主可据此给出会话相关的清单段落。
      assembly = await prompt.assemble({ session })
    } catch {
      // 部分宿主不接受非空上下文参数，回退空上下文再试一次。
      assembly = await prompt.assemble({})
    }
    const sections = (assembly.sections ?? []).map(section => ({
      name: section.name ?? '',
      chars: typeof section.text === 'string' ? section.text.length : 0,
      preview: typeof section.text === 'string' ? section.text.slice(0, 500) : '',
    }))
    const contexts = (assembly.contexts ?? []).map(context => ({
      name: context.name ?? '',
      chars: typeof context.text === 'string' ? context.text.length : 0,
      preview: typeof context.text === 'string' ? context.text.slice(0, 500) : '',
    }))
    const tools = (assembly.tools ?? []).map(tool => (typeof tool.name === 'string' ? tool.name : String(tool.name ?? ''))).filter(name => name.length > 0)
    const variables = Object.keys(assembly.variables ?? {})
    return { sections, contexts, tools, variables }
  } catch (error) {
    return { sections: [], contexts: [], tools: [], variables: [], error: msg(error) }
  }
}

// ── HTTP RPC 路由 ──────────────────────────────────────────────────────────

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

async function handleRpc(req: IncomingMessage, res: ServerResponse, sv: Services, lastRounds: Map<string, LastRound>): Promise<void> {
  // 跨站防护：本路由只接受同源页面发出的带 `x-dsh-explorer` 自定义头的请求。
  if (!gateExplorerRequest(req, res)) return
  let body: any
  try {
    body = await readJsonBody(req, 32 * 1024 * 1024)
  } catch (error) {
    sendJson(res, { error: `无效请求：${msg(error)}` })
    return
  }
  const sessionId = body?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    sendJson(res, { error: '缺少 sessionId' })
    return
  }
  // 刚打开侧栏时客户端已经有 sessionId，但 Host 的 live map 可能还没
  // attach：先 get，没有再从 persistence inspect。真没有才报卸载。
  const session = await loadSessionLog(sv, sessionId)
  if (session === null) {
    sendJson(res, { error: '会话不存在或已卸载' })
    return
  }
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    sendJson(res, { error: '该会话没有工作目录' })
    return
  }
  const method = body?.method
  const args = body?.args !== null && typeof body?.args === 'object' ? body.args : {}
  const policy = sv.policyFor(session)

  try {
    switch (method) {
      case 'session.meta':
        return sendJson(res, { cwd, preset: session.header?.agentPreset, id: sessionId })
      case 'fs.list':
        return sendJson(res, await fsList(sv, cwd, args))
      case 'fs.read':
        return sendJson(res, await fsRead(sv, cwd, args))
      case 'fs.stat':
        return sendJson(res, await fsStatLite(sv, cwd, args))
      case 'fs.write':
        return sendJson(res, await fsWrite(sv, cwd, { ...args, session }))
      case 'fs.create':
        return sendJson(res, await fsCreate(sv, cwd, { ...args, session }))
      case 'fs.reveal':
        return sendJson(res, await fsReveal(sv, cwd, args))
      case 'fs.openExternal':
        return sendJson(res, await fsOpenExternal(sv, cwd, args))
      case 'git.status':
        return sendJson(res, await gitStatus(sv, policy, cwd))
      case 'git.diff':
        return sendJson(res, await gitDiff(sv, policy, cwd))
      case 'git.fileDiff':
        return sendJson(res, await gitFileDiff(sv, policy, cwd, sessionId, args, lastRounds))
      case 'git.branch':
        return sendJson(res, await gitBranch(sv, policy, cwd))
      case 'git.summary':
        return sendJson(res, await gitSummary(sv, policy, cwd))
      case 'git.checkout':
        return sendJson(res, await gitCheckout(sv, policy, cwd, args))
      case 'git.commit':
        return sendJson(res, await gitCommit(sv, policy, cwd, args))
      case 'git.push':
        return sendJson(res, await gitPush(sv, policy, cwd))
      case 'git.lastRound': {
        const round = lastRounds.get(sessionId)
        if (round === undefined) return sendJson(res, { files: [], at: null, truncated: false })
        return sendJson(res, {
          at: round.at,
          // truncated=true：快照期 diff 输出被截断，清单/patch 可能缺文件——客户端应给可见提示。
          truncated: round.truncated,
          files: round.files.map(file => ({
            path: file.path,
            status: file.status,
            hasPatch: file.patch !== null && file.patch.length > 0,
          })),
        })
      }
      case 'context.meta':
        return sendJson(res, await contextMeta(sv, session))
      case 'session.sources':
        return sendJson(res, sessionSources(session))
      case 'pty.open': {
        if (sv.pty === undefined) return sendJson(res, { error: '终端服务未就绪' })
        const cols = typeof args.cols === 'number' && Number.isFinite(args.cols) ? args.cols : 120
        const rows = typeof args.rows === 'number' && Number.isFinite(args.rows) ? args.rows : 32
        return sendJson(res, await sv.pty.open({ sessionId, cwd, cols, rows }))
      }
      case 'pty.write': {
        if (sv.pty === undefined) return sendJson(res, { error: '终端服务未就绪' })
        const id = typeof args.id === 'string' ? args.id : ''
        const data = typeof args.data === 'string' ? args.data : ''
        return sendJson(res, await sv.pty.write(sessionId, id, data))
      }
      case 'pty.resize': {
        if (sv.pty === undefined) return sendJson(res, { error: '终端服务未就绪' })
        const id = typeof args.id === 'string' ? args.id : ''
        // 尺寸非法直接拒绝（不默认）：resize 总是客户端 fit 的产物，畸形请求是 bug，默认值只会掩盖。
        if (
          typeof args.cols !== 'number' || !Number.isFinite(args.cols)
          || typeof args.rows !== 'number' || !Number.isFinite(args.rows)
        ) {
          return sendJson(res, { error: '非法尺寸' })
        }
        return sendJson(res, await sv.pty.resize(sessionId, id, args.cols, args.rows))
      }
      case 'pty.close': {
        if (sv.pty === undefined) return sendJson(res, { error: '终端服务未就绪' })
        const id = typeof args.id === 'string' ? args.id : ''
        return sendJson(res, await sv.pty.close(sessionId, id))
      }
      default:
        return sendJson(res, { error: `未知方法 ${String(method)}` })
    }
  } catch (error) {
    sendJson(res, { error: msg(error) })
  }
}

// ── 插件入口 ───────────────────────────────────────────────────────────────

/** 载荷自愈钩子的结果只进日志：patched / already 是好事，其余给原因。 */
function reportPayloadFork(status: PayloadForkStatus | undefined): void {
  if (status === undefined) return
  const tag = '[dsh-explorer:payload-fork]'
  if (status.status === 'patched') {
    console.log(`${tag} 已补 ${status.sites} 处右侧栏宽度钳制 → ${status.path}（原始备份 .dshx-orig，刷新页面生效）`)
  } else if (status.status === 'already') {
    console.log(`${tag} 载荷补丁已在位：${status.path}`)
  } else if (status.status === 'missing') {
    console.log(`${tag} 跳过：${status.reason}`)
  } else {
    console.warn(`${tag} ${status.status}：${status.path ?? ''} ${status.reason ?? ''}`)
  }
}

export function apply(ctx: ExplorerContext): void {
  const webServer = ctx.get('webServer') as WebServerService | undefined
  const fs = ctx.get('fs') as FsService | undefined
  const shell = ctx.get('shell') as ShellService | undefined
  const sessions = ctx.get('sessions') as SessionsService | undefined
  // 这些服务已通过插件对象上的 inject 声明为硬依赖（冷启动时行会等到
  // webserver 等就绪后才 apply）；此处检查仅为类型收窄。
  if (webServer === undefined || fs === undefined || shell === undefined || sessions === undefined) {
    console.warn('dsh-explorer: required host service missing at apply, plugin inactive')
    return
  }

  // 载荷自愈钩子（见 src/payloadFork.ts）：趁页面还没拉客户端 bundle，
  // 先把桌面载荷里被更新覆盖掉的右侧栏宽度钳制补回来。失败只记日志。
  reportPayloadFork(runPayloadForkOnce())

  registerExplorerSettings(ctx)

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
    fs,
    shell,
    sessions,
    get systemPrompt() { return ctx.get('systemPrompt') as SystemPromptService | undefined },
    get sandboxPolicy() { return ctx.get('sandboxPolicy') as SandboxPolicyService | undefined },
    get persistence() { return ctx.get('sessionPersistence') as PersistenceLike | undefined },
    policyFor: (session: SessionLike) => services.sandboxPolicy?.resolve({ session, mode: 'danger-full-access' }),
    pty,
  }

  const pendingStarts = makeBoundedMap<string, Promise<Snapshot | null>>(8)
  const lastRounds = makeBoundedMap<string, LastRound>(32)

  // 上一回合变更：turn/start 记起点快照，turn/end 记终点并冻结差异。
  ctx.effect(() => ctx.on('session/event', (session: SessionLike, event: { type?: string }) => {
    const type = event?.type
    if (type !== 'turn/start' && type !== 'turn/end') return
    const sessionId = session.header?.id
    const cwd = session.header?.cwd
    if (typeof sessionId !== 'string' || typeof cwd !== 'string' || cwd.length === 0) return
    if (type === 'turn/start') {
      pendingStarts.set(sessionId, captureSnapshot(fs, shell, services.policyFor(session), cwd))
    } else {
      void (async () => {
        const startPromise = pendingStarts.get(sessionId)
        if (startPromise === undefined) return
        pendingStarts.delete(sessionId)
        const start = await startPromise
        if (start === null) return
        const end = await captureSnapshot(fs, shell, services.policyFor(session), cwd)
        if (end === null) return
        const files = await diffSnapshots(services, cwd, start, end)
        // 慢链竞态守卫：慢仓库上回合 N-1 的 end 链可能晚于回合 N 的链完成——
        // 终点快照时间戳不新于现存回合时丢弃，旧数据不得覆盖新回合。
        const existing = lastRounds.get(sessionId)
        if (existing !== undefined && existing.at > end.at) return
        lastRounds.set(sessionId, { at: end.at, files, truncated: start.diffTruncated || end.diffTruncated })
      })()
    }
  }), 'dsh-explorer: turn snapshots')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-explorer/rpc',
    handler: (req, res) => {
      res.on('error', () => {})
      return void handleRpc(req, res, services, lastRounds).catch(error => {
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

async function handlePtyStream(req: IncomingMessage, res: ServerResponse, sv: Services): Promise<void> {
  if (!gateExplorerRequest(req, res)) return
  if (sv.pty === undefined) {
    sendJson(res, { error: '终端服务未就绪' })
    return
  }
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
  const session = await loadSessionLog(sv, sessionId)
  if (session === null) {
    sendJson(res, { error: '会话不存在或已卸载' })
    return
  }
  await sv.pty.attach(sessionId, id, res)
}

export { handlePtyStream, handleRpc, unquotePath }

// 载荷自愈钩子的公开面：smoke / 排查脚本直接从包根取用。
export { applyPayloadFork, FORK_MARKER, locateLayoutBundle, rewriteClampSites } from './payloadFork'

/**
 * Plugin object with hard inject: the webserver row waits for webStartup.
 * A bare apply on cold start can run before webServer exists and silently
 * drop the route. Declaring the four required services makes the row wait.
 */
export default {
  name: 'dsh-explorer',
  inject: ['webServer', 'fs', 'shell', 'sessions'],
  apply,
}

export { EXPLORER_SETTINGS_NS } from './settingsNs'
