/**
 * DSH-Explorer — Host half.
 *
 * Registers one JSON RPC route on the shared `webServer`
 * (`POST /dsh-explorer/rpc`) that the browser half consumes for file-tree
 * listing, file read/write, git review views, the ToDo list and the model
 * context manifest, plus a user PTY stream at `POST /dsh-explorer/pty`.
 * Also registers the `dsh-explorer` settings namespace so the plugin-config
 * tab can dispatch the browser card (keyed slot ∩ describe).
 * Every path operation is fenced to the requesting session's cwd. "上一回合变更"
 * is produced from git snapshots taken at the session's `turn/start` /
 * `turn/end` durable events.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, relative, resolve as pathResolve } from 'node:path'
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
}

const UNTRACKED_PREVIEW_CAP = 128 * 1024
const UNTRACKED_PREVIEW_LIMIT = 100

function msg(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function runGit(
  shell: ShellService,
  policy: unknown,
  cwd: string,
  args: string,
  timeoutMs = 20000,
): Promise<{ ok: boolean; text: string; error?: string }> {
  try {
    const spec = shell.resolve({
      command: `git ${args}`,
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
      return { ok: false, text: '', error: detail }
    }
    return { ok: true, text: result.stdout?.text ?? '' }
  } catch (error) {
    return { ok: false, text: '', error: msg(error) }
  }
}

/** Unquote a git porcelain path (`"a\"b"` → `a"b`). */
function unquotePath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1)
    return inner.replace(/\\([\\"nt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  return trimmed
}

interface PorcelainEntry {
  x: string
  y: string
  path: string
  oldPath?: string
}

function parsePorcelainLine(line: string): PorcelainEntry | null {
  if (line.length < 4 || line[2] !== ' ') return null
  const x = line[0]
  const y = line[1]
  const rest = line.slice(3)
  const arrow = rest.indexOf(' -> ')
  if (arrow > 0) {
    return { x, y, path: unquotePath(rest.slice(arrow + 4)), oldPath: unquotePath(rest.slice(0, arrow)) }
  }
  return { x, y, path: unquotePath(rest) }
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
  const re = /^diff --git a\/(.+?) b\/(.+?)\s*$/gm
  const starts: Array<{ index: number; path: string }> = []
  let match: RegExpExecArray | null
  while ((match = re.exec(diff)) !== null) {
    starts.push({ index: match.index, path: unquotePath(match[2]) })
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

  const snapshot: Snapshot = { at: Date.now(), tracked: {}, untracked: {} }

  const diff = await runGit(shell, policy, cwd, 'diff HEAD --')
  if (diff.ok) {
    for (const [path, patch] of splitDiffChunks(diff.text)) snapshot.tracked[path] = patch
  }

  const status = await runGit(shell, policy, cwd, 'status --porcelain=v1 --untracked-files=all')
  if (status.ok) {
    let count = 0
    for (const line of status.text.split('\n')) {
      const entry = parsePorcelainLine(line)
      if (!entry || entry.x !== '?' || entry.y !== '?') continue
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

async function diffSnapshots(fs: FsService, start: Snapshot, end: Snapshot): Promise<LastRoundFile[]> {
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
      files.push({ path, status: '??', patch: await previewUntracked(fs, path, end.at), truncated: false })
    } else if (before.size !== meta.size || before.version !== meta.version) {
      files.push({ path, status: '??~', patch: await previewUntracked(fs, path, end.at), truncated: false })
    }
  }
  for (const [path] of Object.entries(start.untracked)) {
    if (!(path in end.untracked)) files.push({ path, status: 'untracked-removed', patch: null })
  }
  return files
}

async function previewUntracked(fs: FsService, path: string, _at: number): Promise<string | null> {
  try {
    const target = await fs.resolve(path)
    const info = await fs.stat(target)
    if (!info || info.type !== 'file' || (info.size ?? 0) > UNTRACKED_PREVIEW_CAP) return null
    return await fs.readText(target)
  } catch {
    return null
  }
}

// ── 文件树 / 读写 ──────────────────────────────────────────────────────────

async function resolveInside(sv: Services, cwd: string, path: string): Promise<FsTargetLike | { error: string }> {
  if (typeof path !== 'string' || path.length === 0) return { error: '缺少路径' }
  const root = await sv.fs.resolve(cwd)
  const target = await sv.fs.resolve(path)
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
    return { content, truncated: false, path: target.displayPath, size }
  } catch (error) {
    return { error: `读取失败（可能是二进制文件）：${msg(error)}`, size }
  }
}

async function fsWrite(sv: Services, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = await resolveInside(sv, cwd, String(args.path ?? ''))
  if ('error' in target) return { error: target.error }
  const content = args.content
  if (typeof content !== 'string') return { error: '缺少内容' }
  // The user clicked 保存 in the editor — that IS the approval, so the write
  // runs under the explicit full-access mode with the session boundary kept.
  const policy = sv.sandboxPolicy?.resolve({ session: args.session === undefined ? undefined : args.session, mode: 'danger-full-access' })
  try {
    await sv.fs.writeText(target, content, undefined, undefined, policy)
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
  const status = await runGit(sv.shell, policy, cwd, 'status --porcelain=v1 --untracked-files=all')
  if (!status.ok) return { branch: branch.ok ? branch.text.trim() : '', files: [], error: status.error }
  const files = status.text.split('\n').filter(line => line.length > 0)
    .map(parsePorcelainLine).filter((entry): entry is PorcelainEntry => entry !== null)
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
  if ('notRepo' in status || (status.error !== undefined && status.files === undefined)) return status
  const files = status.files as Array<{ path: string; oldPath?: string; status: string }>
  // 列表不带 patch：全量 diff 塞进右侧栏会让拖列宽/滚动卡死。正文走 git.fileDiff。
  const out = files.map(file => listFile(file, file.status !== '??'))
  return { branch: status.branch, files: out }
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
  const candidates: string[] = []
  const remoteHead = await runGit(sv.shell, policy, cwd, 'rev-parse --abbrev-ref refs/remotes/origin/HEAD')
  if (remoteHead.ok && remoteHead.text.trim().length > 0) candidates.push(remoteHead.text.trim())
  candidates.push('origin/main', 'origin/master', 'main', 'master')
  let base = ''
  for (const candidate of candidates) {
    const check = await runGit(sv.shell, policy, cwd, `rev-parse --verify "${candidate}"`, 10000)
    if (check.ok) { base = candidate; break }
  }
  if (base.length === 0) {
    return { error: '未找到基准分支（尝试过 origin/main、main 等）', branch: branchName }
  }
  const mergeBase = await runGit(sv.shell, policy, cwd, `merge-base HEAD "${base}"`)
  if (!mergeBase.ok) return { error: mergeBase.error ?? 'merge-base 失败', branch: branchName }
  return { branch: branchName, base, merge: mergeBase.text.trim() }
}

function parseNameStatus(text: string): Array<{ path: string; oldPath?: string; status: string }> {
  const files: Array<{ path: string; oldPath?: string; status: string }> = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const parts = line.split('\t')
    const code = parts[0]?.[0]
    if (code === undefined || parts[1] === undefined) continue
    if ((code === 'R' || code === 'C') && parts[2] !== undefined) {
      files.push({ status: 'R', oldPath: unquotePath(parts[1]), path: unquotePath(parts[2]) })
    } else {
      files.push({
        status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M',
        path: unquotePath(parts[1]),
      })
    }
  }
  return files
}

async function gitBranch(sv: Services, policy: unknown, cwd: string): Promise<Record<string, unknown>> {
  const found = await findBranchBase(sv, policy, cwd)
  if ('error' in found) {
    return { notRepo: found.branch === undefined, branch: found.branch ?? '', base: '', commits: [], files: [], error: found.error }
  }
  const nameStatus = await runGit(sv.shell, policy, cwd, `diff --name-status -M "${found.merge}"...HEAD --`)
  const files = nameStatus.ok
    ? parseNameStatus(nameStatus.text).map(file => listFile(file, true))
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
    const file = lastRounds.get(sessionId)?.files.find((item: LastRoundFile) => item.path.replace(/\\/g, '/') === rel)
    return { path: rel, patch: file?.patch ?? null }
  }
  const fenced = await resolveInside(sv, cwd, pathResolve(cwd, rel))
  if ('error' in fenced) return { error: fenced.error, patch: null }
  const quoted = `"${rel}"`
  if (mode === 'branch') {
    const found = await findBranchBase(sv, policy, cwd)
    if ('error' in found) return { error: found.error, patch: null }
    const diff = await runGit(sv.shell, policy, cwd, `diff "${found.merge}"...HEAD -- ${quoted}`)
    if (!diff.ok) return { error: diff.error, patch: null }
    return { path: rel, patch: diff.text.length > 0 ? diff.text : null }
  }
  const tracked = await runGit(sv.shell, policy, cwd, `ls-files --error-unmatch -- ${quoted}`)
  if (!tracked.ok) {
    const inside = await runGit(sv.shell, policy, cwd, 'rev-parse --is-inside-work-tree', 10000)
    const inRepo = inside.ok && inside.text.trim() === 'true'
    return { path: rel, patch: null, untracked: inRepo }
  }
  const diff = await runGit(sv.shell, policy, cwd, `diff HEAD -- ${quoted}`)
  if (!diff.ok) return { error: diff.error, patch: null }
  return { path: rel, patch: diff.text.length > 0 ? diff.text : null, untracked: false }
}

function safeBranchName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (name.length === 0 || name.length > 200) return null
  if (name === 'HEAD' || name.includes('..') || name.startsWith('-')) return null
  if (!/^[A-Za-z0-9._/\-]+$/.test(name)) return null
  return name
}

function safeCommitMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const message = raw.replace(/[\r\n]+/g, ' ').trim().replace(/[$`\\"]/g, '')
  if (message.length === 0 || message.length > 2000) return null
  return message
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
  const status = await runGit(sv.shell, policy, cwd, 'status --porcelain=v1 --untracked-files=all')
  const dirty = status.ok ? status.text.split('\n').filter(line => line.length > 0).length : 0
  const remote = await runGit(sv.shell, policy, cwd, 'remote get-url origin', 10000)
  const remoteUrl = remote.ok ? remote.text.trim() : ''
  const candidates = ['origin/main', 'origin/master', 'main', 'master']
  const remoteHead = await runGit(sv.shell, policy, cwd, 'rev-parse --abbrev-ref refs/remotes/origin/HEAD', 10000)
  if (remoteHead.ok && remoteHead.text.trim().length > 0) candidates.unshift(remoteHead.text.trim())
  let base = ''
  for (const candidate of candidates) {
    const check = await runGit(sv.shell, policy, cwd, `rev-parse --verify "${candidate}"`, 10000)
    if (check.ok) { base = candidate; break }
  }
  const branchName = branch.ok ? branch.text.trim() : ''
  return {
    branch: branchName,
    branches,
    added,
    deleted,
    dirty,
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
  const result = await runGit(sv.shell, policy, cwd, `checkout "${name}"`)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, branch: name }
}

async function gitCommit(sv: Services, policy: unknown, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const message = safeCommitMessage(args.message)
  if (message === null) return { ok: false, error: '请填写提交说明' }
  const add = await runGit(sv.shell, policy, cwd, 'add -A')
  if (!add.ok) return { ok: false, error: add.error }
  const commit = await runGit(sv.shell, policy, cwd, `commit -m "${message}"`)
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

function sessionTranscript(session: SessionLike): Record<string, unknown> {
  const messages: Array<{ role: string; text: string; time: number; seq: number }> = []
  const events = session.events
  const seedLength = typeof session.header?.seedLength === 'number' ? session.header.seedLength : 0
  if (!Array.isArray(events)) return { messages, title: session.header?.id ?? '' }
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const type = event.type
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (seq < seedLength) continue
    const time = typeof event.time === 'number' ? event.time : 0
    if (type === 'user/message') {
      const source = event.data?.source
      const kind = source !== null && typeof source === 'object' ? (source as { kind?: string }).kind : undefined
      if (kind !== undefined && kind !== 'user') continue
      const text = flattenBlocks(event.data?.content).trim()
      if (text.length === 0) continue
      messages.push({ role: 'user', text, time, seq })
    } else if (type === 'assistant/message') {
      const text = flattenBlocks(event.data?.message?.content).trim()
      if (text.length === 0) continue
      messages.push({ role: 'assistant', text, time, seq })
    }
  }
  return { messages, id: session.header?.id ?? '' }
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

async function isUnderParent(sv: Services, ancestorId: string, target: SessionLike): Promise<boolean> {
  let cursor = target.header?.parentSession
  for (let i = 0; i < 8; i++) {
    if (typeof cursor !== 'string' || cursor.length === 0) return false
    if (cursor === ancestorId) return true
    const up = await loadSessionLog(sv, cursor)
    cursor = up?.header?.parentSession
  }
  return false
}

async function sessionSubagents(sv: Services, parentId: string): Promise<Record<string, unknown>> {
  const agents: Array<{ id: string; label: string; activity: string; mode: string }> = []
  const seen = new Set<string>()
  const add = (id: string, label: string, activity: string, mode: string): void => {
    if (id.length === 0 || seen.has(id)) return
    seen.add(id)
    agents.push({ id, label: label.length > 0 ? label : id.slice(0, 8), activity, mode })
  }
  if (typeof sv.sessions.list === 'function') {
    for (const session of sv.sessions.list()) {
      if (session.header?.parentSession === parentId) {
        add(String(session.header.id ?? ''), String(session.header.id ?? '').slice(0, 8), 'running', 'continuable')
      }
    }
  }
  if (sv.persistence?.list !== undefined) {
    try {
      const headers = await sv.persistence.list()
      for (const header of headers) {
        if (header?.parentSession !== parentId) continue
        const id = String(header.id ?? '')
        const live = sv.sessions.get(id)
        add(id, id.slice(0, 8), live !== undefined ? 'running' : 'inactive', 'one-shot')
      }
    } catch { /* listing is best-effort */ }
  }
  return { agents }
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

  const ensure = (name: string, title: string) => {
    const existing = groups.get(name)
    if (existing !== undefined) return existing
    const created = { name, title, searches: 0, fetches: 0, pages: [] as Array<{ url: string; title: string; snippet: string }> }
    groups.set(name, created)
    return created
  }

  const addPage = (group: ReturnType<typeof ensure>, url: string, title: string, snippet: string): void => {
    if (url.length === 0 && title.length === 0) return
    if (url.length > 0 && group.pages.some(page => page.url === url)) return
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
        const callId = String(event.data?.callId ?? '')
        const call = calls.get(callId)
        const name = call?.name ?? String(event.data?.name ?? 'tool')
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
        const content = flattenBlocks(event.data?.content)
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

function todoList(session: SessionLike): Record<string, unknown> {
  const todos: Array<{ content: string; status: string }> = []
  const events = session.events
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event && event.type === 'todo/write' && event.data && Array.isArray(event.data.todos)) {
        for (const todo of event.data.todos) {
          if (todo && typeof todo === 'object') {
            todos.push({ content: String((todo as { content?: unknown }).content ?? ''), status: String((todo as { status?: unknown }).status ?? 'pending') })
          }
        }
        break
      }
    }
  }
  return { todos }
}

async function contextMeta(sv: Services, _sessionId: string): Promise<Record<string, unknown>> {
  if (sv.systemPrompt === undefined) return { sections: [], contexts: [], tools: [], variables: [] }
  try {
    const assembly = await sv.systemPrompt.assemble({})
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
      if (overflow) return // drain the rest without buffering
      size += chunk.length
      if (size > cap) {
        overflow = true
        chunks.length = 0
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
      case 'fs.write':
        return sendJson(res, await fsWrite(sv, cwd, { ...args, session }))
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
        if (round === undefined) return sendJson(res, { files: [], at: null })
        return sendJson(res, {
          at: round.at,
          files: round.files.map(file => ({
            path: file.path,
            status: file.status,
            hasPatch: file.patch !== null && file.patch.length > 0,
          })),
        })
      }
      case 'todo.list':
        return sendJson(res, todoList(session))
      case 'context.meta':
        return sendJson(res, await contextMeta(sv, sessionId))
      case 'session.sources':
        return sendJson(res, sessionSources(session))
      case 'session.subagents':
        return sendJson(res, await sessionSubagents(sv, sessionId))
      case 'session.transcript': {
        const targetId = typeof args.targetId === 'string' && args.targetId.length > 0 ? args.targetId : sessionId
        const target = await loadSessionLog(sv, targetId)
        if (target === null) return sendJson(res, { error: '目标会话不存在或未加载', messages: [] })
        if (targetId !== sessionId && !(await isUnderParent(sv, sessionId, target))) {
          return sendJson(res, { error: '只能查看当前会话的子智能体', messages: [] })
        }
        return sendJson(res, sessionTranscript(target))
      }
      case 'pty.open': {
        if (sv.pty === undefined) return sendJson(res, { error: '终端服务未就绪' })
        const cols = typeof args.cols === 'number' ? args.cols : 120
        const rows = typeof args.rows === 'number' ? args.rows : 32
        return sendJson(res, await sv.pty.open({ sessionId, cwd, cols, rows }))
      }
      case 'pty.write': {
        if (sv.pty === undefined) return sendJson(res, { error: '终端服务未就绪' })
        const id = typeof args.id === 'string' ? args.id : ''
        const data = typeof args.data === 'string' ? args.data : ''
        return sendJson(res, await sv.pty.write(sessionId, id, data))
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
  if (webServer === undefined || fs === undefined || shell === undefined || sessions === undefined) return

  // 载荷自愈钩子（见 src/payloadFork.ts）：趁页面还没拉客户端 bundle，
  // 先把桌面载荷里被更新覆盖掉的右侧栏宽度钳制补回来。失败只记日志。
  reportPayloadFork(runPayloadForkOnce())

  registerExplorerSettings(ctx)

  const sandboxPolicy = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
  const pty = createPtyHub(() => ctx.get('subprocess') as SubprocessLike | undefined)
  const services: Services = {
    fs,
    shell,
    sessions,
    systemPrompt: ctx.get('systemPrompt') as SystemPromptService | undefined,
    sandboxPolicy,
    persistence: ctx.get('sessionPersistence') as PersistenceLike | undefined,
    policyFor: (session: SessionLike) => sandboxPolicy?.resolve({ session, mode: 'danger-full-access' }),
    pty,
  }

  const pendingStarts = new Map<string, Snapshot>()
  const lastRounds = new Map<string, LastRound>()

  // 上一回合变更：turn/start 记起点快照，turn/end 记终点并冻结差异。
  ctx.effect(() => ctx.on('session/event', (session: SessionLike, event: { type?: string }) => {
    const type = event?.type
    if (type !== 'turn/start' && type !== 'turn/end') return
    const sessionId = session.header?.id
    const cwd = session.header?.cwd
    if (typeof sessionId !== 'string' || typeof cwd !== 'string' || cwd.length === 0) return
    if (type === 'turn/start') {
      void captureSnapshot(fs, shell, services.policyFor(session), cwd).then(snapshot => {
        if (snapshot !== null) pendingStarts.set(sessionId, snapshot)
      })
    } else {
      const start = pendingStarts.get(sessionId)
      if (start === undefined) return
      pendingStarts.delete(sessionId)
      void captureSnapshot(fs, shell, services.policyFor(session), cwd).then(end => {
        if (end === null) return
        void diffSnapshots(fs, start, end).then(files => {
          lastRounds.set(sessionId, { at: end.at, files })
        })
      })
    }
  }), 'dsh-explorer: turn snapshots')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-explorer/rpc',
    handler: (req, res) => void handleRpc(req, res, services, lastRounds).catch(error => {
      if (!res.headersSent) sendJson(res, { error: msg(error) })
    }),
  }), 'dsh-explorer: rpc route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-explorer/pty',
    handler: (req, res) => void handlePtyStream(req, res, services).catch(error => {
      if (!res.headersSent) sendJson(res, { error: msg(error) })
    }),
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

export { handleRpc }

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
