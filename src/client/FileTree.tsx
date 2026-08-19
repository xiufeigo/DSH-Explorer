/**
 * 文件树：以当前会话工作目录为根，惰性展开子目录。
 * 行样式/图标/字号/缩进全部对齐原生 WorkspaceBrowser 的规格：
 *   - 目录行 34px、文件行 32px，圆角 8，padding 0 8px；
 *   - 每级缩进 22px（16px 图标槽 + 6px 间距）；
 *   - 标题 14px/20px；hover/选中背景 var(--dsw-alias-interactive-bg-hover)；
 *   - 目录默认显示文件夹图标，hover 时切换为三角箭头（展开旋转 90°）；
 *   - 文件同一 16px 槽放该类型自己的剪影（Python 双蛇、TS/JS 色块等）。
 */

import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import {
  IconFolderClose16, IconFolderOpen16, IconTriangleRightFill14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { FileGlyph } from './fileGlyph'
import { openFileTab, rpc, rpcWithSessionRetry } from './rpc'
import { useExplorer, type ExplorerStore } from './store'

interface TreeEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
  path: string
}

interface ListResult {
  path?: string
  entries?: TreeEntry[]
  error?: string
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}K`
  return `${(size / (1024 * 1024)).toFixed(1)}M`
}

interface FileTreeProps {
  cwd: string | undefined
  sessionId: string | undefined
  store: ExplorerStore
  onOpenPanel(): void
}

export function FileTree({ cwd, sessionId, store, onOpenPanel }: FileTreeProps): JSX.Element {
  useExplorer(store) // re-render on treeTick (refresh) and tab changes
  // Map 而不是普通对象：路径名可以是 __proto__ / constructor 等合法但
  // 会踩原型链的字符串，普通对象作 key 会串原型。
  const [children, setChildren] = useState<Map<string, TreeEntry[]>>(() => new Map())
  const [loading, setLoading] = useState<Map<string, boolean>>(() => new Map())
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map())
  const [root, setRoot] = useState<TreeEntry[] | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TreeEntry } | null>(null)

  const loadRoot = useCallback(async (signal?: AbortSignal) => {
    if (cwd === undefined || cwd.length === 0) return
    if (sessionId === undefined || sessionId.length === 0) return
    setRootError(null)
    const res = await rpcWithSessionRetry<ListResult>(sessionId, 'fs.list', { path: cwd }, signal)
    if (signal?.aborted === true) return
    if (res.error !== undefined) {
      setRootError(res.error)
      setRoot(null)
      return
    }
    setRoot(res.entries ?? [])
  }, [cwd, sessionId])

  useEffect(() => {
    setRoot(null)
    setChildren(new Map())
    const ac = new AbortController()
    void loadRoot(ac.signal)
    return () => ac.abort()
  }, [loadRoot, store.treeTick])

  const toggle = useCallback(async (entry: TreeEntry) => {
    const path = entry.path
    if (children.has(path)) {
      setChildren(current => {
        const next = new Map(current)
        next.delete(path)
        return next
      })
      return
    }
    if (loading.get(path) === true) return
    setLoading(current => new Map(current).set(path, true))
    const res = await rpc<ListResult>(sessionId, 'fs.list', { path })
    setLoading(current => {
      const next = new Map(current)
      next.delete(path)
      return next
    })
    if (res.error !== undefined) {
      setErrors(current => new Map(current).set(path, res.error ?? '未知错误'))
      return
    }
    setErrors(current => {
      const next = new Map(current)
      next.delete(path)
      return next
    })
    setChildren(current => new Map(current).set(path, res.entries ?? []))
  }, [children, loading, sessionId])

  const openEntry = useCallback((entry: TreeEntry, kind: 'edit' | 'preview') => {
    void openFileTab(store, sessionId, entry.path, entry.name, kind).then(() => {
      onOpenPanel()
    })
  }, [store, sessionId, onOpenPanel])

  const onContextMenu = useCallback((event: MouseEvent, entry: TreeEntry) => {
    if (entry.type !== 'file') return
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, entry })
  }, [])

  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const renderEntries = (entries: TreeEntry[], depth: number): JSX.Element[] =>
    entries.map(entry => {
      const isDir = entry.type === 'directory'
      const isOpen = children.has(entry.path)
      return (
        <div key={entry.path}>
          <div
            className={`dshx-tree-row ${isDir ? 'dir' : 'file'} ${isOpen ? 'open' : ''}`}
            style={{ paddingLeft: 8 + depth * 22 }}
            onClick={() => {
              if (isDir) void toggle(entry)
              else openEntry(entry, 'edit')
            }}
            onContextMenu={event => onContextMenu(event, entry)}
            title={entry.path}
          >
            {isDir ? (
              <span className="dshx-tree-slot">
                <span className="dshx-tree-chevron"><IconTriangleRightFill14 /></span>
                <span className="dshx-tree-folder">
                  {isOpen ? <IconFolderOpen16 /> : <IconFolderClose16 />}
                </span>
              </span>
            ) : (
              <FileGlyph name={entry.name} />
            )}
            <span className="dshx-tree-name">{entry.name}</span>
            {!isDir && entry.size !== undefined && (
              <span className="dshx-tree-size">{formatSize(entry.size)}</span>
            )}
          </div>
          {isDir && isOpen && (
            errors.has(entry.path)
              ? <div className="dshx-error" style={{ padding: '2px 8px 2px 26px', fontSize: 13 }}>{errors.get(entry.path)}</div>
              : renderEntries(children.get(entry.path) ?? [], depth + 1)
          )}
        </div>
      )
    })

  const previewable = (entry: TreeEntry): boolean => /\.(md|markdown|html?|htm)$/i.test(entry.name)

  return (
    <div className="dshx-tree">
      {cwd === undefined || cwd.length === 0 ? (
        <div className="dshx-empty">当前会话没有工作目录</div>
      ) : rootError !== null ? (
        <div className="dshx-error">{rootError}</div>
      ) : root === null ? (
        <div className="dshx-empty"><span className="dshx-spin">◌</span> 加载中…</div>
      ) : root.length === 0 ? (
        <div className="dshx-empty">空目录</div>
      ) : (
        renderEntries(root, 0)
      )}

      {menu !== null && (
        <div className="dshx-menu" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}>
          <div className="dshx-menu-item" onClick={() => { openEntry(menu.entry, 'edit'); setMenu(null) }}>打开编辑</div>
          <div
            className={`dshx-menu-item ${previewable(menu.entry) ? '' : 'disabled'}`}
            onClick={() => {
              if (!previewable(menu.entry)) return
              openEntry(menu.entry, 'preview')
              setMenu(null)
            }}
          >
            预览（md / html）
          </div>
          <div className="dshx-menu-item" onClick={() => { void navigator.clipboard?.writeText(menu.entry.path); setMenu(null) }}>复制路径</div>
        </div>
      )}
    </div>
  )
}
