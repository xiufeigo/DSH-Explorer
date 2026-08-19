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
const reviewPatchCache = new Map<string, string | null>()
const REVIEW_PATCH_CACHE_MAX = 32

function reviewListKey(sessionId: string, mode: ReviewMode): string {
  return `${sessionId}:${mode}`
}

function rememberPatch(key: string, patch: string | null): void {
  if (reviewPatchCache.has(key)) reviewPatchCache.delete(key)
  reviewPatchCache.set(key, patch)
  if (reviewPatchCache.size <= REVIEW_PATCH_CACHE_MAX) return
  const first = reviewPatchCache.keys().next().value
  if (first !== undefined) reviewPatchCache.delete(first)
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

const DiffView = memo(function DiffView({ path, patch }: { path: string; patch: string }): JSX.Element {
  const allLines = useMemo(() => patch.split('\n'), [patch])
  const truncated = allLines.length > DIFF_LINE_CAP
  const total = truncated ? DIFF_LINE_CAP : allLines.length
  const { wrapRef, from, to, onScroll } = useVirtualSlice(total, DIFF_LINE_H, `${path}:${total}`)

  return (
    <>
      <div className="dshx-diff-header">{path}</div>
      {truncated && (
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
      <span className={`dshx-badge ${status}`}>{STATUS_LABEL[status] ?? status}</span>
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
  const [data, setData] = useState<ReviewData | null>(() => reviewListCache.get(cacheKey)?.data ?? null)
  const [selectedPath, setSelectedPath] = useState<string | null>(() => reviewListCache.get(cacheKey)?.selectedPath ?? null)
  const [patch, setPatch] = useState<string | null>(null)
  const [patchLoading, setPatchLoading] = useState(false)
  const [panes, togglePane] = useReviewPanes()
  const listSig = useRef(reviewListCache.get(cacheKey)?.sig ?? '')
  const sourceRef = useRef(cacheKey)
  if (sourceRef.current !== cacheKey) {
    sourceRef.current = cacheKey
    const hit = reviewListCache.get(cacheKey)
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
    void rpcWithSessionRetry<ReviewData>(sessionId, method).then(result => {
      const files: ReviewFile[] = result.files ?? []
      const signature = `${result.error ?? ''}\n${result.branch ?? ''}\n${listSignature(files)}`
      const key = reviewListKey(sessionId, mode)
      if (!force && signature === listSig.current) return
      listSig.current = signature
      setData(result)
      setSelectedPath(current => {
        const next = current !== null && files.some(file => file.path === current)
          ? current
          : files.find(file => !isUntracked(file))?.path ?? null
        reviewListCache.set(key, { data: result, selectedPath: next, sig: signature })
        return next
      })
    })
  }, [sessionId, mode])

  useEffect(() => {
    if (!visible) return
    load()
    const timer = setInterval(() => load(), 8000)
    const onVis = (): void => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load, visible])

  const files = data?.files ?? EMPTY_FILES
  const untracked = useMemo(() => files.filter(isUntracked), [files])
  const others = useMemo(() => files.filter(file => !isUntracked(file)), [files])
  const selected = selectedPath === null ? null : files.find(file => file.path === selectedPath) ?? null

  useEffect(() => {
    if (selected === null || !fileHasPatch(selected)) {
      setPatch(null)
      setPatchLoading(false)
      return
    }
    const path = selected.path
    const inline = selected.patch
    if (typeof inline === 'string' && inline.length > 0) {
      setPatch(inline)
      setPatchLoading(false)
      return
    }
    const patchKey = `${sessionId}:${mode}:${path}`
    const cachedPatch = reviewPatchCache.get(patchKey)
    if (cachedPatch !== undefined) {
      setPatch(cachedPatch)
      setPatchLoading(false)
    } else {
      setPatchLoading(true)
    }
    let cancelled = false
    void rpc<{ patch?: string | null; error?: string }>(sessionId, 'git.fileDiff', {
      path,
      mode,
    }).then(result => {
      if (cancelled) return
      const next = typeof result.patch === 'string' && result.patch.length > 0 ? result.patch : null
      rememberPatch(patchKey, next)
      setPatchLoading(false)
      setPatch(next)
    })
    return () => { cancelled = true }
  }, [sessionId, mode, selectedPath, selected?.hasPatch, selected?.patch])

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
        <button className="dshx-btn small" onClick={() => { listSig.current = ''; load(true) }}>刷新</button>
      </div>

      {mode === 'branch' && data?.commits !== undefined && data.commits.length > 0 && (
        <div style={{ borderBottom: '1px solid var(--dshx-border)', maxHeight: 120, overflow: 'auto', flex: 'none' }}>
          {data.commits.map(commit => (
            <div className="dshx-commit-item" key={commit.hash}>
              <span className="dshx-commit-hash">{commit.hash.slice(0, 8)}</span>
              <span className="dshx-file-name">{commit.subject}</span>
            </div>
          ))}
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
                    : <DiffView path={selected.path} patch={patch} />
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
