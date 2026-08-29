/**
 * 文件树：以当前会话工作目录为根，惰性展开子目录。
 * 行样式/图标/字号/缩进全部对齐原生 WorkspaceBrowser 的规格：
 *   - 目录行 34px、文件行 32px，圆角 8，padding 0 8px；
 *   - 每级缩进 22px（16px 图标槽 + 6px 间距）；
 *   - 标题 14px/20px；hover/选中背景 var(--dsw-alias-interactive-bg-hover)；
 *   - 目录默认显示文件夹图标，hover 时切换为三角箭头（展开旋转 90°）；
 *   - 文件同一 16px 槽放该类型自己的剪影（Python 双蛇、TS/JS 色块等）。
 *
 * 刷新策略：自动（3s 轮询指纹）与手动（treeTick）都做「原地刷新」——
 * 重新拉根目录与已展开目录的列表，内容没变不 set，展开状态永远保留。
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  IconFolderClose16, IconFolderOpen16, IconTriangleRightFill14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { FileGlyph } from './fileGlyph'
import { isTransientSessionError, openFileTab, rpc, rpcWithSessionRetry } from './rpc'
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

/** 目录清单指纹：名字/类型/大小任一变化都会改变指纹。 */
function fingerprint(entries: TreeEntry[]): string {
  return entries.map(entry => `${entry.type}|${entry.name}|${entry.size ?? ''}`).join('\u0000')
}

// ── 展开状态记忆（按 cwd 存 localStorage） ─────────────────────────────────

const TREE_OPEN_KEY = 'dsh-explorer:tree-open'
/** 最多记住多少个 cwd 的展开状态：超出删最早写入的（键序即写入序）。 */
const TREE_OPEN_KEY_CAP = 40

function readSavedOpen(cwd: string): string[] {
  try {
    const raw = localStorage.getItem(TREE_OPEN_KEY)
    if (raw === null) return []
    const map = JSON.parse(raw) as Record<string, unknown>
    const list = map[cwd]
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function saveOpen(cwd: string, paths: string[]): void {
  try {
    const raw = localStorage.getItem(TREE_OPEN_KEY)
    const parsed: Record<string, unknown> = raw !== null ? JSON.parse(raw) : {}
    // 重建 map：当前 cwd 挪到最后再写，对象键序即写入先后记录；
    // 超上限时从最前面（最早写入）开始删。
    const map: Record<string, unknown> = {}
    for (const key of Object.keys(parsed)) {
      if (key === cwd || !Array.isArray(parsed[key])) continue
      map[key] = parsed[key]
    }
    map[cwd] = paths.slice(0, 150)
    const keys = Object.keys(map)
    if (keys.length > TREE_OPEN_KEY_CAP) {
      for (const key of keys.slice(0, keys.length - TREE_OPEN_KEY_CAP)) delete map[key]
    }
    localStorage.setItem(TREE_OPEN_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

interface FileTreeProps {
  cwd: string | undefined
  sessionId: string | undefined
  store: ExplorerStore
  onOpenPanel(): void
}

type Creating = { parent: string; kind: 'file' | 'dir' } | null
interface MenuState {
  x: number
  y: number
  entry: TreeEntry | null
  parent: string
}

const NAME_BAD = /[\\/:*?"<>|]/

// ── 性能护栏 ────────────────────────────────────────────────────────────────
// 记忆恢复曾把 node_modules 这类几千项目录在切会话的关键帧里整树同步挂载，
// 配合宿主网格过渡的逐帧重排造成秒级卡死。三个约束：
//   1) 每层目录默认只渲染前 TREE_CHILD_CAP 行，超出折叠为「显示全部」；
//   2) 恢复最多展开 RESTORE_DIR_CAP 个目录、并发 ≤LIST_CONCURRENCY；
//   3) 恢复等 SWITCH_SETTLE_MS 错峰，不和切换过渡抢主线程。
const TREE_CHILD_CAP = 120
const TREE_MAX_RENDER_CAP = 2000
const RESTORE_DIR_CAP = 24
const LIST_CONCURRENCY = 8
/** 轮询比对子目录的并发上限：比恢复路径更保守（分批串行，防请求风暴）。 */
const POLL_LIST_CONCURRENCY = 4
const SWITCH_SETTLE_MS = 350
/** 自动轮询节奏：基础 3s；会话级错误指数退避 3→6→12→…→30s，成功后复位。 */
const POLL_BASE_MS = 3000
const POLL_MAX_MS = 30000

/**
 * 会话级错误判定：会话缺失/卸载、网络失败、超时等「整条链路暂时不可用」类错误。
 * 轮询遇到这类错误应退避降频，而不是 3s 一次反复敲打；单个目录自身的
 * 路径错误（如目录被删）不在此列。
 */
function isSessionLevelError(error: string): boolean {
  if (isTransientSessionError(error)) return true
  return /failed to fetch|load failed|network|aborted|timeout|timed out|超时|http \d{3}/i.test(error)
}

function delay(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
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
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [creating, setCreating] = useState<Creating>(null)
  /** 用户点「显示全部」后放开渲染上限的目录（key 为目录路径，根目录用 ''）。 */
  const [showAllDirs, setShowAllDirs] = useState<Set<string>>(() => new Set())

  const childrenRef = useRef(children)
  childrenRef.current = children
  const lastRootFp = useRef('')
  const dirFps = useRef<Map<string, string>>(new Map())

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
    const entries = res.entries ?? []
    lastRootFp.current = fingerprint(entries)
    setRoot(entries)
  }, [cwd, sessionId])

  /** cwd / 会话变化：换 cwd 才全量重置并从记忆恢复展开；同 cwd 换会话原地刷新。 */
  const lastCwdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const cwdChanged = lastCwdRef.current !== cwd
    lastCwdRef.current = cwd
    const ac = new AbortController()
    if (cwdChanged) {
      pollDelay.current = POLL_BASE_MS // 新目录树：轮询退避复位
      setRoot(null)
      setChildren(new Map())
      setLoading(new Map())
      setCreating(null)
      setMenu(null)
      setShowAllDirs(new Set())
      lastRootFp.current = ''
      dirFps.current = new Map()
      // 必须同步捕获：持久化 effect 会随后把当前空展开写入存储，晚读会拿到空
      const saved = cwd !== undefined && cwd.length > 0
        ? readSavedOpen(cwd).filter(path => path !== cwd).slice(0, RESTORE_DIR_CAP)
        : []
      void (async () => {
        await loadRoot(ac.signal)
        if (ac.signal.aborted || saved.length === 0) return
        if (sessionId === undefined || sessionId.length === 0) return
        // 错峰：等宿主切会话的网格过渡帧走完再恢复，恢复动作不挤占切换的关键帧；
        // 分批拉取避免几十个目录并发打满。
        await delay(ac.signal, SWITCH_SETTLE_MS)
        for (let start = 0; start < saved.length; start += LIST_CONCURRENCY) {
          if (ac.signal.aborted) return
          const batch = saved.slice(start, start + LIST_CONCURRENCY)
          const results = await Promise.all(batch.map(async path => ({
            path,
            res: await rpc<ListResult>(sessionId, 'fs.list', { path }),
          })))
          if (ac.signal.aborted) return
          setChildren(current => {
            const next = new Map(current)
            let changed = false
            for (const { path, res } of results) {
              if (res.error !== undefined) continue
              const entries = res.entries ?? []
              dirFps.current.set(path, fingerprint(entries))
              next.set(path, entries)
              changed = true
            }
            return changed ? next : current
          })
        }
      })()
    } else {
      // 同 cwd 换会话：不重置，原地刷新即可
      void refreshRef.current()
    }
    return () => ac.abort()
  }, [loadRoot])

  /** 展开状态持久化：children 变化即落盘。 */
  useEffect(() => {
    if (cwd === undefined || cwd.length === 0) return
    saveOpen(cwd, Array.from(children.keys()))
  }, [children, cwd])

  /**
   * 原地刷新：重拉根目录与所有已展开目录，指纹没变不 set，展开状态不动。
   * 返回 true = 本次刷新健康（轮询可复位基础间隔）；false = 遇到会话级错误
   * （会话缺失/卸载、网络失败等），轮询应指数退避。
   */
  const busyRef = useRef(false)
  const refreshRef = useRef<() => Promise<boolean>>(async () => true)
  refreshRef.current = async () => {
    if (busyRef.current) return true
    if (cwd === undefined || cwd.length === 0) return true
    if (sessionId === undefined || sessionId.length === 0) return true
    busyRef.current = true
    try {
      const rootRes = await rpcWithSessionRetry<ListResult>(sessionId, 'fs.list', { path: cwd })
      if (rootRes.error !== undefined) {
        // 静默保留旧内容；会话级错误上报给轮询退避
        return !isSessionLevelError(rootRes.error)
      }
      const nextRoot = rootRes.entries ?? []
      const rootFp = fingerprint(nextRoot)
      if (rootFp !== lastRootFp.current) {
        lastRootFp.current = rootFp
        setRoot(nextRoot)
      }
      const openPaths = Array.from(childrenRef.current.keys())
      if (openPaths.length === 0) return true
      // 分批串行、每批 ≤4 并发：已展开目录可能很多，防轮询请求风暴
      const updates: Array<{ path: string; res: ListResult }> = []
      for (let start = 0; start < openPaths.length; start += POLL_LIST_CONCURRENCY) {
        const batch = openPaths.slice(start, start + POLL_LIST_CONCURRENCY)
        const results = await Promise.all(batch.map(async path => ({
          path,
          res: await rpc<ListResult>(sessionId, 'fs.list', { path }),
        })))
        // 任一会话级错误（会话不存在/卸载、网络失败等）立即中止本轮并上报退避
        if (results.some(({ res }) => res.error !== undefined && isSessionLevelError(res.error))) return false
        updates.push(...results)
      }
      setChildren(current => {
        const next = new Map(current)
        let changed = false
        for (const { path, res } of updates) {
          if (res.error !== undefined) continue
          const entries = res.entries ?? []
          const fp = fingerprint(entries)
          if (fp === dirFps.current.get(path)) continue
          dirFps.current.set(path, fp)
          next.set(path, entries)
          changed = true
        }
        return changed ? next : current
      })
      return true
    } finally {
      busyRef.current = false
    }
  }

  // 手动刷新（treeTick）：跳过首次，避免与 loadRoot 重复
  const firstTick = useRef(true)
  useEffect(() => {
    if (firstTick.current) { firstTick.current = false; return }
    void refreshRef.current()
  }, [store.treeTick])

  /** 当前轮询间隔：错误指数退避 3→6→12→…→30s，成功一次复位 3s。 */
  const pollDelay = useRef(POLL_BASE_MS)

  // 自动跟随：轮询指纹，页面隐藏时跳过；失败按 pollDelay 指数退避
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      timer = setTimeout(() => {
        if (stopped) return
        if (document.hidden) { schedule(); return }
        void refreshRef.current().catch(() => false).then(ok => {
          if (stopped) return
          pollDelay.current = ok ? POLL_BASE_MS : Math.min(pollDelay.current * 2, POLL_MAX_MS)
          schedule()
        })
      }, pollDelay.current)
    }
    schedule()
    return () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [])

  const reloadDir = useCallback(async (parent: string): Promise<TreeEntry[] | null> => {
    if (sessionId === undefined || sessionId.length === 0) return null
    const res = parent === cwd
      ? await rpcWithSessionRetry<ListResult>(sessionId, 'fs.list', { path: parent })
      : await rpc<ListResult>(sessionId, 'fs.list', { path: parent })
    if (res.error !== undefined) return null
    const entries = res.entries ?? []
    if (parent === cwd) {
      lastRootFp.current = fingerprint(entries)
      setRoot(entries)
    } else {
      dirFps.current.set(parent, fingerprint(entries))
      setChildren(current => new Map(current).set(parent, entries))
    }
    return entries
  }, [cwd, sessionId])

  /** 确保目录处于展开状态（未加载则先拉子项）。 */
  const ensureOpen = useCallback(async (parent: string): Promise<void> => {
    if (parent === cwd) return
    if (childrenRef.current.has(parent)) return
    await reloadDir(parent)
  }, [cwd, reloadDir])

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
    const entries = res.entries ?? []
    dirFps.current.set(path, fingerprint(entries))
    setChildren(current => new Map(current).set(path, entries))
  }, [children, loading, sessionId])

  const openEntry = useCallback((entry: TreeEntry, kind: 'edit' | 'preview') => {
    void openFileTab(store, sessionId, entry.path, entry.name, kind).then(() => {
      onOpenPanel()
    })
  }, [store, sessionId, onOpenPanel])

  const onRowContextMenu = useCallback((event: MouseEvent, entry: TreeEntry, parent: string) => {
    event.preventDefault()
    event.stopPropagation()
    // 文件夹行：新建目标在该文件夹内部；文件行：在其所在目录
    const createIn = entry.type === 'directory' ? entry.path : parent
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 180))
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 200))
    setMenu({ x, y, entry, parent: createIn })
  }, [])

  const onBackgroundContextMenu = useCallback((event: MouseEvent) => {
    if (cwd === undefined || cwd.length === 0) return
    event.preventDefault()
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 180))
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 200))
    setMenu({ x, y, entry: null, parent: cwd })
  }, [cwd])

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

  const beginCreate = useCallback((kind: 'file' | 'dir', parent: string) => {
    setMenu(null)
    setCreating({ parent, kind })
    void ensureOpen(parent)
  }, [ensureOpen])

  const confirmCreate = useCallback(async (name: string) => {
    if (creating === null || sessionId === undefined || sessionId.length === 0) return
    const parent = creating.parent
    const kind = creating.kind
    setCreating(null)
    const res = await rpc<{ ok?: boolean }>(sessionId, 'fs.create', { path: parent, name, kind })
    if (res.error !== undefined || res.ok !== true) return
    const entries = await reloadDir(parent)
    if (kind === 'file' && entries !== null) {
      // 用列表里的规范路径打开（避免猜分隔符）
      const created = entries.find(entry => entry.name === name)
      if (created !== undefined) {
        void openFileTab(store, sessionId, created.path, created.name, 'edit').then(() => onOpenPanel())
      }
    }
  }, [creating, sessionId, reloadDir, store, onOpenPanel])

  const renderNewRow = (parent: string, depth: number, key: string): JSX.Element | null => {
    if (creating === null || creating.parent !== parent) return null
    return (
      <NewNameRow key={key} kind={creating.kind} depth={depth}
        onConfirm={name => { void confirmCreate(name) }}
        onCancel={() => setCreating(null)}
      />
    )
  }

  const toggleShowAll = useCallback((dirKey: string) => {
    setShowAllDirs(current => {
      const next = new Set(current)
      if (next.has(dirKey)) next.delete(dirKey)
      else next.add(dirKey)
      return next
    })
  }, [])

  // 每层默认只渲染前 TREE_CHILD_CAP 行；超过折叠为「显示全部」行。
  // 「显示全部」最多渲染 TREE_MAX_RENDER_CAP 行，超出截断并提示。
  const renderEntries = (allEntries: TreeEntry[], depth: number, parent: string): JSX.Element[] => {
    const capLifted = showAllDirs.has(parent)
    const effectiveLimit = capLifted ? TREE_MAX_RENDER_CAP : TREE_CHILD_CAP
    const entries = allEntries.slice(0, effectiveLimit)
    const rows = entries.map(entry => {
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
            onContextMenu={event => onRowContextMenu(event, entry, parent)}
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
              : (
                  <>
                    {renderEntries(children.get(entry.path) ?? [], depth + 1, entry.path)}
                    {renderNewRow(entry.path, depth + 1, `${entry.path}::new`)}
                  </>
                )
          )}
        </div>
      )
    })
    if (!capLifted && allEntries.length > TREE_CHILD_CAP) {
      rows.push(
        <div
          key={`${parent}::__more__`}
          className="dshx-tree-row more"
          style={{ paddingLeft: 8 + depth * 22 }}
          onClick={() => toggleShowAll(parent)}
          title="显示该目录的全部条目"
        >
          <span className="dshx-tree-name">…还有 {allEntries.length - TREE_CHILD_CAP} 项（点击全部显示）</span>
        </div>,
      )
    } else if (capLifted && allEntries.length > TREE_MAX_RENDER_CAP) {
      rows.push(
        <div
          key={`${parent}::__capped__`}
          className="dshx-tree-row more"
          style={{ paddingLeft: 8 + depth * 22, opacity: 0.6 }}
          title={`已达最大渲染条数（${TREE_MAX_RENDER_CAP} 项），其余项已截断`}
        >
          <span className="dshx-tree-name">…已展示前 {TREE_MAX_RENDER_CAP} 项，其余 {allEntries.length - TREE_MAX_RENDER_CAP} 项已截断</span>
        </div>,
      )
    }
    return rows
  }

  const previewable = (entry: TreeEntry): boolean => /\.(md|markdown|html?|htm)$/i.test(entry.name)

  return (
    <div className="dshx-tree" onContextMenu={onBackgroundContextMenu}>
      {cwd === undefined || cwd.length === 0 ? (
        <div className="dshx-empty">当前会话没有工作目录</div>
      ) : rootError !== null ? (
        <div className="dshx-error">{rootError}</div>
      ) : root === null ? (
        <div className="dshx-empty"><span className="dshx-spin">◌</span> 加载中…</div>
      ) : root.length === 0 ? (
        <div className="dshx-empty">空目录</div>
      ) : (
        renderEntries(root, 0, cwd!)
      )}
      {cwd !== undefined && cwd.length > 0 && renderNewRow(cwd, 0, '__root__new')}

      {menu !== null && (
        <div
          className="dshx-menu"
          style={{ left: menu.x, top: menu.y }}
          // 桌面壳毛玻璃 hook（titlebar.js）会把侧栏子树里所有背景强制透明
          // （background-color:transparent!important），这个属性是它自带的
          // 不透明白名单，标记后菜单保持实底可读。
          data-dsh-opaque-surface=""
          role="menu"
          onClick={event => event.stopPropagation()}
        >
          {menu.entry === null || menu.entry.type === 'directory' ? (
            <>
              <div className="dshx-menu-item" onClick={() => beginCreate('file', menu.parent)}>新建文件</div>
              <div className="dshx-menu-item" onClick={() => beginCreate('dir', menu.parent)}>新建文件夹</div>
              {menu.entry !== null && (
                <div className="dshx-menu-item" onClick={() => { void navigator.clipboard?.writeText(menu.entry!.path); setMenu(null) }}>复制路径</div>
              )}
            </>
          ) : (
            <>
              <div className="dshx-menu-item" onClick={() => { openEntry(menu.entry!, 'edit'); setMenu(null) }}>打开编辑</div>
              <div
                className={`dshx-menu-item ${previewable(menu.entry) ? '' : 'disabled'}`}
                onClick={() => {
                  if (!previewable(menu.entry!)) return
                  openEntry(menu.entry!, 'preview')
                  setMenu(null)
                }}
              >
                预览（md / html）
              </div>
              <div className="dshx-menu-item" onClick={() => beginCreate('file', menu.parent)}>新建文件</div>
              <div className="dshx-menu-item" onClick={() => beginCreate('dir', menu.parent)}>新建文件夹</div>
              <div className="dshx-menu-item" onClick={() => { void navigator.clipboard?.writeText(menu.entry!.path); setMenu(null) }}>复制路径</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 新建条目的行内输入行（VS Code 式）：Enter 确认、Esc 取消、失焦取消。 */
function NewNameRow({ kind, depth, onConfirm, onCancel }: {
  kind: 'file' | 'dir'
  depth: number
  onConfirm(name: string): void
  onCancel(): void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [bad, setBad] = useState(false)
  const confirm = (): void => {
    const name = value.trim()
    if (name.length === 0) { onCancel(); return }
    if (name === '.' || name === '..' || NAME_BAD.test(name)) { setBad(true); return }
    onConfirm(name)
  }
  return (
    <div className="dshx-tree-newrow" style={{ paddingLeft: 8 + depth * 22 }}>
      <input
        autoFocus
        className={`dshx-tree-newinput ${bad ? 'bad' : ''}`}
        value={value}
        placeholder={kind === 'dir' ? '文件夹名称' : '文件名称'}
        spellCheck={false}
        onChange={event => { setValue(event.target.value); setBad(false) }}
        onKeyDown={event => {
          if (event.key === 'Enter') confirm()
          else if (event.key === 'Escape') onCancel()
        }}
        onBlur={onCancel}
      />
      {bad && <span className="dshx-tree-newhint">名称含非法字符</span>}
    </div>
  )
}
