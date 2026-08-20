/**
 * 文件 tab 内容：查看（行号 / 高亮 / git 着色）与编辑、预览（Markdown / HTML）。
 */

import { IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CodeView, gitStats } from './CodeView'
import { openWithSystem } from './chatFileOpen'
import { renderMarkdown } from './Markdown'
import { openFileTab, rpc } from './rpc'
import type { ExplorerStore, FileTab } from './store'

function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name)
}

function isHtml(name: string): boolean {
  return /\.(html?|htm)$/i.test(name)
}

function canPreview(name: string): boolean {
  return isMarkdown(name) || isHtml(name)
}

/** Document + search: open the file with the OS default program. */
function IconOpenFile16({ size = 16, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M531.01097 1024H173.259072a112.625598 112.625598 0 0 1-112.337553-112.337553V112.337553A112.625598 112.625598 0 0 1 173.259072 0h442.437131l347.382278 267.017722V619.296765h-57.609001V295.534177L596.109142 57.609001H173.259072A54.728551 54.728551 0 0 0 118.53052 112.337553v799.324894a54.728551 54.728551 0 0 0 54.728552 54.728552h357.751898z"
        fill="currentColor"
      />
      <path
        d="M913.822785 337.300703H562.983966V35.141491h57.609002v244.550211h293.229817v57.609001zM163.177496 184.348805h256.072012v57.609001H163.177496zM163.177496 319.153868h303.311393v57.609001H163.177496zM163.177496 453.958931h364.664979v57.609001H163.177496zM637.011533 844.259916a160.729114 160.729114 0 1 1 160.729114-160.729114A160.729114 160.729114 0 0 1 637.011533 844.259916z m0-263.849227a103.120113 103.120113 0 1 0 103.120113 103.120113A103.120113 103.120113 0 0 0 637.011533 580.410689z"
        fill="currentColor"
      />
      <path
        d="M716.684782 810.011364l40.556737-40.902391 171.012321 169.514487-40.556737 40.902391z"
        fill="currentColor"
      />
    </svg>
  )
}

function FileDesktopActions({
  sessionId, path, onError,
}: {
  sessionId: string
  path: string
  onError(message: string | null): void
}): JSX.Element {
  const [busy, setBusy] = useState<'reveal' | 'open' | null>(null)

  const run = async (which: 'reveal' | 'open'): Promise<void> => {
    setBusy(which)
    onError(null)
    try {
      if (which === 'reveal') {
        const res = await rpc(sessionId, 'fs.reveal', { path })
        if (res.error !== undefined) {
          const message = res.error.startsWith('未知方法')
            ? '打开资源管理器需要重启 dsh web / 桌面壳（Host 还没有 fs.reveal）'
            : res.error
          console.error('dsh-explorer: fs.reveal failed', res.error)
          onError(message)
        }
        return
      }
      try {
        await openWithSystem(path)
      } catch (error) {
        const res = await rpc(sessionId, 'fs.openExternal', { path })
        if (res.error === undefined) return
        const detail = error instanceof Error ? error.message : String(error)
        const message = res.error.startsWith('未知方法')
          ? `打开失败：请重启 dsh web / 桌面壳后再试（${res.error}）`
          : res.error
        console.error('dsh-explorer: desktop open failed', { path, detail, rpc: res.error })
        onError(message)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button
        type="button"
        className="dshx-btn small icon"
        disabled={busy !== null}
        title="在文件资源管理器打开"
        aria-label="在文件资源管理器打开"
        onClick={() => { void run('reveal') }}
      >
        <IconFolderOpen16 />
      </button>
      <button
        type="button"
        className="dshx-btn small icon"
        disabled={busy !== null}
        title="使用默认程序打开"
        aria-label="使用默认程序打开"
        onClick={() => { void run('open') }}
      >
        <IconOpenFile16 />
      </button>
    </>
  )
}

function EditPane({
  value,
  loading,
  onChange,
  onKeyDown,
}: {
  value: string
  loading: boolean
  onChange(next: string): void
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void
}): JSX.Element {
  const gutterRef = useRef<HTMLPreElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const lineCount = useMemo(() => {
    if (value.length === 0) return 1
    let count = 1
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '\n') count++
    }
    return count
  }, [value])
  const numbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n'),
    [lineCount],
  )
  const digits = Math.max(2, String(lineCount).length)

  const syncGutter = (): void => {
    const gutter = gutterRef.current
    const area = areaRef.current
    if (gutter === null || area === null) return
    gutter.scrollTop = area.scrollTop
  }

  return (
    <div className="dshx-editor-edit">
      <pre
        ref={gutterRef}
        className="dshx-editor-gutter"
        aria-hidden
        style={{ width: `${digits + 2}ch` }}
      >
        {numbers}
      </pre>
      <textarea
        ref={areaRef}
        className="dshx-editor-textarea"
        value={value}
        spellCheck={false}
        wrap="off"
        readOnly={loading}
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={syncGutter}
        placeholder={loading ? '加载中…' : ''}
      />
    </div>
  )
}

export function EditorTab({ tab, sessionId, store }: { tab: FileTab; sessionId: string; store: ExplorerStore }): JSX.Element {
  const [value, setValue] = useState(tab.content)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [desktopError, setDesktopError] = useState<string | null>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [untracked, setUntracked] = useState(false)
  const loadedOnce = useRef(false)

  useEffect(() => {
    if (!tab.loading && !loadedOnce.current && tab.content !== value) {
      setValue(tab.content)
      loadedOnce.current = true
    }
  }, [tab.loading, tab.content, value])

  useEffect(() => {
    loadedOnce.current = false
    setMode('view')
    setPatch(null)
    setUntracked(false)
    setValue(tab.content)
    setSaveError(null)
    setDesktopError(null)
  }, [tab.id])

  useEffect(() => {
    if (tab.loading) return
    let cancelled = false
    void rpc<{ patch?: string | null; untracked?: boolean }>(sessionId, 'git.fileDiff', {
      path: tab.path,
      mode: 'git',
    }).then(res => {
      if (cancelled) return
      setUntracked(res.untracked === true)
      setPatch(typeof res.patch === 'string' && res.patch.length > 0 ? res.patch : null)
    })
    return () => { cancelled = true }
  }, [sessionId, tab.path, tab.loading, tab.content])

  const save = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    const res = await rpc<{ ok?: boolean }>(sessionId, 'fs.write', { path: tab.path, content: value })
    setSaving(false)
    if (res.error !== undefined) {
      setSaveError(res.error)
      return
    }
    store.patchTab(tab.id, { dirty: false, content: value })
  }, [sessionId, tab.id, tab.path, value, store])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }, [save])

  const preview = (): void => {
    if (!canPreview(tab.name)) return
    void openFileTab(store, sessionId, tab.path, tab.name, 'preview')
  }

  const stats = useMemo(
    () => tab.dirty ? { added: 0, deleted: 0, dirty: false } : gitStats(value, patch, untracked),
    [tab.dirty, value, patch, untracked],
  )
  const viewPatch = tab.dirty ? null : patch
  const viewUntracked = tab.dirty ? false : untracked

  return (
    <div className="dshx-editor">
      <div className="dshx-editor-toolbar">
        <span className="path">{tab.path}</span>
        {tab.dirty && <span className="dshx-badge M">未保存</span>}
        {!tab.dirty && untracked && <span className="dshx-badge ??">未跟踪</span>}
        {!tab.dirty && stats.dirty && (
          <span className="dshx-code-stat" title="相对 HEAD 的增删">
            {stats.added > 0 && <span className="add">+{stats.added}</span>}
            {stats.deleted > 0 && <span className="del">−{stats.deleted}</span>}
          </span>
        )}
        <div className="dshx-editor-actions">
          <FileDesktopActions sessionId={sessionId} path={tab.path} onError={setDesktopError} />
          <button
            className={`dshx-btn small${mode === 'view' ? ' on' : ''}`}
            onClick={() => setMode('view')}
          >
            查看
          </button>
          <button
            className={`dshx-btn small${mode === 'edit' ? ' on' : ''}`}
            onClick={() => setMode('edit')}
          >
            编辑
          </button>
          {canPreview(tab.name) && (
            <button className="dshx-btn small" onClick={preview} title="在右侧打开预览">预览</button>
          )}
          {(mode === 'edit' || tab.dirty) && (
            <button className="dshx-btn small primary" disabled={saving || tab.loading} onClick={() => void save()}>
              {saving ? '保存中…' : '保存 (Ctrl+S)'}
            </button>
          )}
        </div>
      </div>
      {saveError !== null && <div className="dshx-error" style={{ padding: 6, flex: 'none' }}>{saveError}</div>}
      {desktopError !== null && <div className="dshx-error" style={{ padding: 6, flex: 'none' }}>{desktopError}</div>}
      {tab.error !== null && <div className="dshx-error" style={{ padding: 6, flex: 'none' }}>{tab.error}</div>}
      {tab.truncated && (
        <div className="dshx-muted" style={{ padding: '4px 10px', flex: 'none' }}>文件过大，仅显示已读入的部分</div>
      )}
      {tab.loading ? (
        <div className="dshx-empty"><span className="dshx-spin">◌</span> 加载中…</div>
      ) : mode === 'edit' ? (
        <EditPane
          value={value}
          loading={tab.loading}
          onChange={next => {
            setValue(next)
            store.patchTab(tab.id, { dirty: true })
          }}
          onKeyDown={onKeyDown}
        />
      ) : (
        <CodeView path={tab.path} content={value} patch={viewPatch} untracked={viewUntracked} />
      )}
    </div>
  )
}

export function PreviewTab({ tab, sessionId, store }: { tab: FileTab; sessionId: string; store: ExplorerStore }): JSX.Element {
  const [content, setContent] = useState(tab.content)
  const [desktopError, setDesktopError] = useState<string | null>(null)

  useEffect(() => {
    if (!tab.loading) setContent(tab.content)
  }, [tab.loading, tab.content])

  const reload = useCallback(() => {
    void rpc<{ content?: string }>(sessionId, 'fs.read', { path: tab.path }).then(res => {
      if (res.error === undefined && res.content !== undefined) {
        store.patchTab(tab.id, { content: res.content, error: null })
        setContent(res.content)
      } else if (res.error !== undefined) {
        store.patchTab(tab.id, { error: res.error })
      }
    })
  }, [sessionId, tab.id, tab.path, store])

  const edit = (): void => {
    void openFileTab(store, sessionId, tab.path, tab.name, 'edit')
  }

  if (tab.loading) {
    return <div className="dshx-empty"><span className="dshx-spin">◌</span> 加载中…</div>
  }
  if (tab.error !== null) return <div className="dshx-error">{tab.error}</div>

  return (
    <div className="dshx-editor">
      <div className="dshx-editor-toolbar">
        <span className="path">{tab.path}</span>
        <div className="dshx-editor-actions">
          <FileDesktopActions sessionId={sessionId} path={tab.path} onError={setDesktopError} />
          <button className="dshx-btn small" onClick={edit}>编辑</button>
          <button className="dshx-btn small" onClick={reload}>重新加载</button>
        </div>
      </div>
      {desktopError !== null && <div className="dshx-error" style={{ padding: 6, flex: 'none' }}>{desktopError}</div>}
      {isMarkdown(tab.name)
        ? (
            <div
              className="dshx-preview dshx-scroll"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          )
        : isHtml(tab.name)
          ? <iframe className="dshx-preview-frame" title={tab.name} sandbox="" srcDoc={content} />
          : <div className="dshx-empty">该文件类型不支持预览（支持 .md / .html）</div>}
    </div>
  )
}
