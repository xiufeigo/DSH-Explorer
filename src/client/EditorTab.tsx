/**
 * 文件 tab 内容：查看（行号 / 高亮 / git 着色）与编辑、预览（Markdown / HTML）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CodeView, gitStats } from './CodeView'
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
      {saveError !== null && <div className="dshx-error" style={{ padding: 6, flex: 'none' }}>{saveError}</div>}
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
        <button className="dshx-btn small" onClick={edit}>编辑</button>
        <button className="dshx-btn small" onClick={reload}>重新加载</button>
      </div>
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
