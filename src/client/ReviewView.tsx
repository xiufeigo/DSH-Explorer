/**
 * 审查视图：git 变更 / 上一回合变更 / 分支变更 三种视图。
 * 文件列表上下分栏（未跟踪 / 其他，可折叠）；有 git diff 时才在底部展开。
 * 列表只拉路径，正文按当前选中文件懒加载并虚拟滚动，避免拖列宽时整树折行卡死。
 */

import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { rpc, rpcWithSessionRetry } from './rpc'
import type { ExplorerStore, ReviewMode } from './store'
import { useVirtualSlice } from './useVirtualSlice'

interface ReviewFile {
  path: string
  oldPath?: string
  status: string
  hasPatch?: boolean
  patch?: string | null
}

interface ReviewData {
  branch?: string
  base?: string
  files?: ReviewFile[]
  commits?: Array<{ hash: string; subject: string }>
  at?: number | null
  notRepo?: boolean
  error?: string
  /** true=快照期 diff 输出被截断，清单/patch 可能缺文件（git.lastRound）。 */
  truncated?: boolean
}

const STATUS_LABEL: Record<string, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  U: '冲突',
  '??': '未跟踪',
  '??~': '未跟踪·已改',
  reverted: '已还原',
  'untracked-removed': '未跟踪·已删',
}

/** 复合状态码（如 MM/AM）：首字符为暂存区状态，次字符为工作区状态。 */
function statusTooltip(status: string): string {
  if (status.length === 2 && status[0] in STATUS_LABEL && status[1] in STATUS_LABEL) {
    return `暂存区：${STATUS_LABEL[status[0]]} · 工作区：${STATUS_LABEL[status[1]]}`
  }
  return STATUS_LABEL[status] ?? status
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'del'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ')) return 'meta'
  return 'meta'
}

const DIFF_LINE_CAP = 4000
const DIFF_LINE_H = 19
const FILE_ROW_H = 28
const EMPTY_FILES: ReviewFile[] = []

function isUntracked(file: ReviewFile): boolean {
  return file.status === '??' || file.status === '??~'
}

function fileHasPatch(file: ReviewFile): boolean {
  if (file.hasPatch === true) return true
  if (file.hasPatch === false) return false
  return file.patch !== null && file.patch !== undefined && file.patch !== ''
}

function listSignature(files: ReviewFile[]): string {
  return files.map(file => `${file.status}\t${file.path}`).join('\n')
}

interface ReviewCacheEntry {
  data: ReviewData
  selectedPath: string | null
  sig: string
}

const reviewListCache = new Map<string, ReviewCacheEntry>()
const REVIEW_LIST_CACHE_MAX = 30
const reviewPatchCache = new Map<string, string | null>()
const REVIEW_PATCH_CACHE_MAX = 32

function reviewListKey(sessionId: string, mode: ReviewMode): string {
  return `${sessionId}:${mode}`
}

/** LRU 读取：命中即移到尾部刷新使用顺序（Map 迭代序 = 插入序）。 */
function reviewListCacheGet(key: string): ReviewCacheEntry | undefined {
  const hit = reviewListCache.get(key)
  if (hit === undefined) return undefined
  reviewListCache.delete(key)
  reviewListCache.set(key, hit)
  return hit
}

/** LRU 写入：超限淘汰最早使用项（头部）。 */
function reviewListCacheSet(key: string, entry: ReviewCacheEntry): void {
  if (reviewListCache.has(key)) reviewListCache.delete(key)
  reviewListCache.set(key, entry)
  while (reviewListCache.size > REVIEW_LIST_CACHE_MAX) {
    const oldest = reviewListCache.keys().next().value
    if (oldest === undefined) break
    reviewListCache.delete(oldest)
  }
}

function rememberPatch(key: string, patch: string | null): void {
  if (reviewPatchCache.has(key)) reviewPatchCache.delete(key)
  reviewPatchCache.set(key, patch)
  if (reviewPatchCache.size <= REVIEW_PATCH_CACHE_MAX) return
  const first = reviewPatchCache.keys().next().value
  if (first !== undefined) reviewPatchCache.delete(first)
}

/** 手动刷新：作废该会话该模式的 patch 缓存，diff 面板与后续切换都强制走 RPC。 */
function invalidatePatches(sessionId: string, mode: ReviewMode): void {
  const prefix = `${sessionId}:${mode}:`
  for (const key of reviewPatchCache.keys()) {
    if (key.startsWith(prefix)) reviewPatchCache.delete(key)
  }
}

function useReviewMode(store: ExplorerStore): ReviewMode {
  const [, tick] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    let mode = store.reviewMode
    return store.subscribe(() => {
      if (store.reviewMode === mode) return
      mode = store.reviewMode
      tick()
    })
  }, [store])
  return store.reviewMode
}

type ReviewPanes = { untracked: boolean; diff: boolean; other: boolean }

const REVIEW_PANES_KEY = 'dsh-explorer:review-panes'
const REVIEW_PANES_DEFAULT: ReviewPanes = { untracked: false, diff: false, other: false }

function readReviewPanes(): ReviewPanes {
  try {
    if (typeof localStorage === 'undefined') return { ...REVIEW_PANES_DEFAULT }
    const raw = localStorage.getItem(REVIEW_PANES_KEY)
    if (raw === null || raw === '') return { ...REVIEW_PANES_DEFAULT }
    const parsed = JSON.parse(raw) as Partial<ReviewPanes>
    return {
      untracked: parsed.untracked === true,
      diff: parsed.diff === true,
      other: parsed.other === true,
    }
  } catch {
    return { ...REVIEW_PANES_DEFAULT }
  }
}

function writeReviewPanes(next: ReviewPanes): void {
  try {
    localStorage.setItem(REVIEW_PANES_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式 / 配额满时忽略
  }
}

function useReviewPanes(): [ReviewPanes, (key: keyof ReviewPanes) => void] {
  const [panes, setPanes] = useState<ReviewPanes>(readReviewPanes)
  const toggle = useCallback((key: keyof ReviewPanes) => {
    setPanes(current => {
      const next = { ...current, [key]: !current[key] }
      writeReviewPanes(next)
      return next
    })
  }, [])
  return [panes, toggle]
}

const DiffView = memo(function DiffView({ path, patch, truncated }: { path: string; patch: string; truncated?: boolean }): JSX.Element {
  const allLines = useMemo(() => patch.split('\n'), [patch])
  const truncatedByCap = allLines.length > DIFF_LINE_CAP
  const total = truncatedByCap ? DIFF_LINE_CAP : allLines.length
  const { wrapRef, from, to, onScroll } = useVirtualSlice(total, DIFF_LINE_H, `${path}:${total}`)

  return (
    <>
      <div className="dshx-diff-header">{path}</div>
      {truncated && (
        <div className="dshx-muted" style={{ padding: '4px 10px' }}>⚠ diff 输出被截断，内容可能不完整</div>
      )}
      {truncatedByCap && (
        <div className="dshx-muted" style={{ padding: '4px 10px' }}>
          内容过长，仅显示前 {DIFF_LINE_CAP} 行（共 {allLines.length} 行）
        </div>
      )}
      <div className="dshx-diffwrap" ref={wrapRef} onScroll={onScroll}>
        <div className="dshx-diff-virt" style={{ height: total * DIFF_LINE_H }}>
          <pre className="dshx-diff" style={{ transform: `translateY(${from * DIFF_LINE_H}px)` }}>
            {allLines.slice(from, to).map((line, index) => (
              <div key={from + index} className={`dshx-diff-line ${lineClass(line)}`}>{line.length > 0 ? line : ' '}</div>
            ))}
          </pre>
        </div>
      </div>
    </>
  )
})

const FileRow = memo(function FileRow({ path, status, active, onSelect }: {
  path: string
  status: string
  active: boolean
  onSelect(path: string): void
}): JSX.Element {
  return (
    <div
      className={`dshx-file-item${active ? ' active' : ''}`}
      onClick={() => onSelect(path)}
      title={path}
    >
      <span className={`dshx-badge ${status}`} title={statusTooltip(status)}>{STATUS_LABEL[status] ?? status}</span>
      <span className="dshx-file-name">{path}</span>
    </div>
  )
})

const FileListBody = memo(function FileListBody({ files, selectedPath, onSelect }: {
  files: ReviewFile[]
  selectedPath: string | null
  onSelect(path: string): void
}): JSX.Element {
  const resetKey = `${files.length}:${files[0]?.path ?? ''}:${files[files.length - 1]?.path ?? ''}`
  const { wrapRef, from, to, onScroll } = useVirtualSlice(files.length, FILE_ROW_H, resetKey)
  return (
    <div className="dshx-file-pane-body" ref={wrapRef} onScroll={onScroll}>
      <div className="dshx-file-virt" style={{ height: files.length * FILE_ROW_H }}>
        <div style={{ transform: `translateY(${from * FILE_ROW_H}px)` }}>
          {files.slice(from, to).map(file => (
            <FileRow
              key={file.path}
              path={file.path}
              status={file.status}
              active={file.path === selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  )
})

const FilePane = memo(function FilePane({ title, files, open, empty, selectedPath, onToggle, onSelect }: {
  title: string
  files: ReviewFile[]
  open: boolean
  empty: string
  selectedPath: string | null
  onToggle(): void
  onSelect(path: string): void
}): JSX.Element {
  return (
    <div className={`dshx-file-pane${open ? ' open' : ''}${files.length === 0 ? ' empty' : ''}`}>
      <button type="button" className="dshx-file-pane-head" aria-expanded={open} onClick={onToggle}>
        <span className={`dshx-file-pane-chevron${open ? ' open' : ''}`} aria-hidden="true" />
        <span className="dshx-file-pane-title">{title}</span>
        <span className="dshx-file-pane-count">{files.length}</span>
      </button>
      {open && (
        files.length === 0
          ? <div className="dshx-file-pane-empty">{empty}</div>
          : <FileListBody files={files} selectedPath={selectedPath} onSelect={onSelect} />
      )}
    </div>
  )
})

export const ReviewView = memo(function ReviewView({ sessionId, store, visible = true }: {
  sessionId: string
  store: ExplorerStore
  visible?: boolean
}): JSX.Element {
  const mode = useReviewMode(store)
  const setMode = (next: ReviewMode): void => { store.setReviewMode(next) }
  const cacheKey = reviewListKey(sessionId, mode)
  const [data, setData] = useState<ReviewData | null>(() => reviewListCacheGet(cacheKey)?.data ?? null)
  const [selectedPath, setSelectedPath] = useState<string | null>(() => reviewListCacheGet(cacheKey)?.selectedPath ?? null)
  const [patch, setPatch] = useState<string | null>(null)
  const [patchLoading, setPatchLoading] = useState(false)
  /** 单文件 diff 输出被 stdout 上限截断（git.fileDiff truncated）：面板内提示。 */
  const [patchTruncated, setPatchTruncated] = useState(false)
  const [panes, togglePane] = useReviewPanes()
  const listSig = useRef(reviewListCacheGet(cacheKey)?.sig ?? '')
  const reqSeq = useRef(0)
  /** git.fileDiff 按文件取号：慢 patch 晚归时不得覆盖更新的请求结果。 */
  const diffSeq = useRef<Map<string, number>>(new Map())
  const sourceRef = useRef(cacheKey)
  if (sourceRef.current !== cacheKey) {
    sourceRef.current = cacheKey
    const hit = reviewListCacheGet(cacheKey)
    if (hit !== undefined) {
      listSig.current = hit.sig
      setData(hit.data)
      setSelectedPath(hit.selectedPath)
    } else {
      listSig.current = ''
      setData(null)
    }
  }

  const load = useCallback((force = false) => {
    if (typeof document !== 'undefined' && document.hidden) return
    const method = mode === 'git' ? 'git.diff' : mode === 'last' ? 'git.lastRound' : 'git.branch'
    const my = ++reqSeq.current
    // 大仓库 diff 可能超过默认 15s，git 类统一放宽到 60s
    void rpcWithSessionRetry<ReviewData>(sessionId, method, {}, undefined, { timeoutMs: 60_000 }).then(result => {
      if (my !== reqSeq.current) return
      const files: ReviewFile[] = result.files ?? []
      // at/truncated 入签名：上一回合冻结了相同清单时也要刷新「冻结于」与截断提示。
      const signature = `${result.error ?? ''}\n${result.branch ?? ''}\n${result.at ?? ''}\n${result.truncated === true}\n${listSignature(files)}`
      const key = reviewListKey(sessionId, mode)
      if (!force && signature === listSig.current) return
      listSig.current = signature
      setData(result)
      setSelectedPath(current => {
        const next = current !== null && files.some(file => file.path === current)
          ? current
          : files.find(file => !isUntracked(file))?.path ?? null
        reviewListCacheSet(key, { data: result, selectedPath: next, sig: signature })
        return next
      })
    })
  }, [sessionId, mode])

  useEffect(() => {
    if (!visible) return
    load()
    const timer = setInterval(() => load(), 8000)
    // 回前台刷新加 0-300ms 随机 jitter，避免多个组件同刻齐射 RPC
    let visTimer = 0
    const onVis = (): void => {
      if (document.hidden) return
      if (visTimer !== 0) window.clearTimeout(visTimer)
      visTimer = window.setTimeout(() => { visTimer = 0; load() }, Math.round(Math.random() * 300))
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timer)
      if (visTimer !== 0) window.clearTimeout(visTimer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load, visible])

  const files = data?.files ?? EMPTY_FILES
  const untracked = useMemo(() => files.filter(isUntracked), [files])
  const others = useMemo(() => files.filter(file => !isUntracked(file)), [files])
  const selected = selectedPath === null ? null : files.find(file => file.path === selectedPath) ?? null

  /** 当前 patch 面板的键：会话/模式/文件任一切走后，晚归响应据此丢弃。 */
  const activePatchKeyRef = useRef<string | null>(null)
  activePatchKeyRef.current = selected === null ? null : `${sessionId}:${mode}:${selected.path}`

  /** 拉单个文件的 diff；缓存优先（bypassCache 时强制 RPC）。按文件取号防晚归覆盖。 */
  const requestPatch = useCallback((path: string, bypassCache: boolean): void => {
    const patchKey = `${sessionId}:${mode}:${path}`
    if (!bypassCache) {
      const cachedPatch = reviewPatchCache.get(patchKey)
      if (cachedPatch !== undefined) {
        setPatch(cachedPatch)
        setPatchLoading(false)
        setPatchTruncated(false)
        return
      }
      setPatchLoading(true)
    }
    const seqs = diffSeq.current
    const seq = (seqs.get(path) ?? 0) + 1
    seqs.set(path, seq)
    void rpc<{ patch?: string | null; error?: string; truncated?: boolean }>(sessionId, 'git.fileDiff', {
      path,
      mode,
    }, { timeoutMs: 60_000 }).then(result => {
      if (patchKey !== activePatchKeyRef.current) return // 已切到别的文件/模式
      if (seqs.get(path) !== seq) return // 已有更新的请求：丢弃过期响应
      const next = typeof result.patch === 'string' && result.patch.length > 0 ? result.patch : null
      rememberPatch(patchKey, next)
      setPatchLoading(false)
      setPatchTruncated(result.truncated === true)
      setPatch(next)
    })
  }, [sessionId, mode])

  // 选中/切换文件时装载 patch：先吃缓存（快速切换秒出），没有再拉。
  useEffect(() => {
    if (selected === null || !fileHasPatch(selected)) {
      setPatch(null)
      setPatchLoading(false)
      setPatchTruncated(false)
      return
    }
    const path = selected.path
    const inline = selected.patch
    if (typeof inline === 'string' && inline.length > 0) {
      setPatch(inline)
      setPatchLoading(false)
      setPatchTruncated(false)
      return
    }
    requestPatch(path, false)
  }, [sessionId, mode, selectedPath, selected?.hasPatch, selected?.patch, requestPatch])

  // 选中文件不变时也要跟随工作区：与列表同节奏轮询单文件 diff（绕过缓存）。
  // 列表签名只含状态与路径，Agent 编辑已选中文件时列表不变，patch 只能自己刷新。
  // 依赖用原始值：列表刷新会换 selected 对象身份，用对象做依赖会不断重置定时器。
  const selectedPatchable = selected !== null && fileHasPatch(selected)
  const selectedInline = selected?.patch
  useEffect(() => {
    if (!visible || selectedPath === null || !selectedPatchable) return
    if (typeof selectedInline === 'string' && selectedInline.length > 0) return
    const timer = setInterval(() => { requestPatch(selectedPath, true) }, 8000)
    return () => { clearInterval(timer) }
  }, [visible, selectedPath, selectedPatchable, selectedInline, requestPatch])

  const refresh = useCallback((): void => {
    // 手动刷新同时作废 patch 缓存：diff 面板立刻重拉，不再吃旧缓存。
    invalidatePatches(sessionId, mode)
    listSig.current = ''
    load(true)
    if (selected !== null && fileHasPatch(selected) && !(typeof selected.patch === 'string' && selected.patch.length > 0)) {
      requestPatch(selected.path, true)
    }
  }, [sessionId, mode, load, selected, requestPatch])

  return (
    <div className="dshx-review">
      <div className="dshx-review-toolbar">
        <div className="dshx-seg">
          <button className={mode === 'git' ? 'active' : ''} onClick={() => setMode('git')}>Git 变更</button>
          <button className={mode === 'last' ? 'active' : ''} onClick={() => setMode('last')}>上一回合变更</button>
          <button className={mode === 'branch' ? 'active' : ''} onClick={() => setMode('branch')}>分支变更</button>
        </div>
        {mode !== 'last' && data?.branch !== undefined && data.branch !== '' && (
          <span className="dshx-muted">分支 {data.branch}{data.base !== undefined && data.base !== '' ? ` ← ${data.base}` : ''}</span>
        )}
        {mode === 'last' && typeof data?.at === 'number' && (
          <span className="dshx-muted">冻结于 {new Date(data.at).toLocaleTimeString()}</span>
        )}
        <button className="dshx-btn small" onClick={refresh}>刷新</button>
      </div>

      {mode === 'last' && data?.truncated === true && (
        <div className="dshx-muted" style={{ padding: '4px 10px', flex: 'none', borderBottom: '1px solid var(--dshx-border)' }}>
          ⚠ 快照期间 diff 输出被截断，变更清单与 diff 内容可能不完整
        </div>
      )}

      {mode === 'branch' && data?.commits !== undefined && data.commits.length > 0 && (
        <div style={{ borderBottom: '1px solid var(--dshx-border)', maxHeight: 120, overflow: 'auto', flex: 'none' }}>
          {data.commits.map(commit => (
            <div className="dshx-commit-item" key={commit.hash}>
              <span className="dshx-commit-hash">{commit.hash.slice(0, 8)}</span>
              <span className="dshx-file-name">{commit.subject}</span>
            </div>
          ))}
          {data.commits.length >= 50 && (
            <div className="dshx-muted" style={{ padding: '4px 10px', fontSize: 11 }}>仅展示最近 50 条提交</div>
          )}
        </div>
      )}

      {data === null ? (
        <div className="dshx-empty">加载变更…</div>
      ) : data.error !== undefined && data.error !== '' ? (
        <div className="dshx-error">{data.error}</div>
      ) : files.length === 0 ? (
        <div className="dshx-empty">
          {mode === 'last' ? '还没有上一回合的变更记录（等待一个回合结束后自动捕获）' : '工作区干净，没有变更'}
        </div>
      ) : (
        <div className="dshx-review-body">
          <FilePane
            title="新增/修改的未跟踪文件"
            files={untracked}
            open={panes.untracked}
            empty="没有未跟踪文件"
            selectedPath={selectedPath}
            onToggle={() => togglePane('untracked')}
            onSelect={setSelectedPath}
          />
          {selected !== null && fileHasPatch(selected) && (
            <div className={`dshx-diff-pane${panes.diff ? ' open' : ''}`}>
              <button
                type="button"
                className="dshx-file-pane-head"
                aria-expanded={panes.diff}
                onClick={() => togglePane('diff')}
              >
                <span className={`dshx-file-pane-chevron${panes.diff ? ' open' : ''}`} aria-hidden="true" />
                <span className="dshx-file-pane-title">Diff</span>
                <span className="dshx-file-pane-count">{selected.path}</span>
              </button>
              {panes.diff && (
                patchLoading && patch === null
                  ? <div className="dshx-empty">加载 diff…</div>
                  : patch === null || patch === ''
                    ? <div className="dshx-empty">该文件没有 diff 内容</div>
                    : <DiffView path={selected.path} patch={patch} truncated={patchTruncated} />
              )}
            </div>
          )}
          <FilePane
            title="其他文件"
            files={others}
            open={panes.other}
            empty="没有其他变更"
            selectedPath={selectedPath}
            onToggle={() => togglePane('other')}
            onSelect={setSelectedPath}
          />
        </div>
      )}
    </div>
  )
})
