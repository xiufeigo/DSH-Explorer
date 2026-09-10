/**
 * 文件 tab 内容：查看（行号 / 高亮 / git 着色）与编辑、预览（Markdown / HTML）。
 */

import { IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CodeView, gitStats } from './CodeView'
import { openWithSystem } from './chatFileOpen'
import { useExternalFollow } from './fileFollow'
import { renderMarkdown } from './Markdown'
import { MdErrorBoundary } from './MdErrorBoundary'
import { openFileTab, rpc } from './rpc'
import type { ExplorerStore, FileTab } from './store'

/** 击键防抖窗口：脏标立即入库，正文延迟这么久再写，减少全栏重渲染。 */
const CONTENT_DEBOUNCE_MS = 250

function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name)
}

function isHtml(name: string): boolean {
  return /\.(html?)$/i.test(name)
}

/** 是否支持右侧预览（md / html）：编辑器与文件树右键共用同一口径。 */
export function canPreview(name: string): boolean {
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
  // split 由引擎优化，替代逐字符循环（接近 2MB 上限的文件每击键省一次 O(n) 扫描）
  const lineCount = useMemo(
    () => (value.length === 0 ? 1 : value.split('\n').length),
    [value],
  )
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
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={syncGutter}
        placeholder={loading ? '加载中…' : ''}
      />
    </div>
  )
}

export function EditorTab({ tab, sessionId, store }: { tab: FileTab; sessionId: string; store: ExplorerStore }): JSX.Element {
  // ExplorerPanel 以 key={tab.id} 挂载本组件：切 tab 整体重挂载，per-tab 状态
  // 天然隔离（原先手写的 [tab.id] 重置状态机已删，脏草稿经卸载兜底 flush 落库）。
  const [value, setValue] = useState(tab.content)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [desktopError, setDesktopError] = useState<string | null>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [untracked, setUntracked] = useState(false)
  const [staleDisk, setStaleDisk] = useState<string | null>(null)
  /** 外部修改提示条对应内容的磁盘版本/大小（载入最新版本时写回基准）。 */
  const staleVersionRef = useRef<string | null>(null)
  const staleSizeRef = useRef<number | null>(null)
  /** 击键防抖：脏标立即入库，正文延迟写入（见 onChange / flushContent）。 */
  const flushTimer = useRef<{ id: string; content: string; timer: number } | null>(null)

  /** 立即把防抖中的正文写入 store（保存 / 卸载前调用，草稿不丢）。 */
  const flushContent = useCallback(() => {
    const pending = flushTimer.current
    if (pending === null) return
    flushTimer.current = null
    window.clearTimeout(pending.timer)
    store.patchTab(pending.id, { content: pending.content })
  }, [store])

  // 卸载兜底：组件移除（切 tab / 切页面）前把未落库的正文写回
  useEffect(() => () => { flushContent() }, [flushContent])

  // store 侧内容更新（初次加载完成 / 外部跟随 / 载入最新）同步进输入框；
  // dirty 期间以输入框为准，绝不回写。
  useEffect(() => {
    if (!tab.loading && !tab.dirty && tab.content !== value) setValue(tab.content)
  }, [tab.loading, tab.dirty, tab.content, value])

  // 外部修改跟随：查看态/干净编辑态自动套用；有未保存修改只提示不强改。
  const dirtyRef = useRef(tab.dirty)
  dirtyRef.current = tab.dirty
  const followExternalChange = useCallback(() => {
    // 大文件读取显式放宽超时（默认 15s 会误杀）
    void rpc<{ content?: string; version?: string; size?: number }>(sessionId, 'fs.read', { path: tab.path }, { timeoutMs: 30_000 }).then(res => {
      if (res.error !== undefined || typeof res.content !== 'string') return
      const version = typeof res.version === 'string' ? res.version : null
      const size = typeof res.size === 'number' ? res.size : null
      if (dirtyRef.current) {
        staleVersionRef.current = version // 「载入最新版本」时用它重建基准
        staleSizeRef.current = size
        setStaleDisk(res.content) // 提示条按钮主动载入，绝不覆盖用户正在写的内容
        return
      }
      setValue(res.content)
      store.patchTab(tab.id, { content: res.content, error: null, baseVersion: version, baseSize: size })
    })
  }, [sessionId, tab.path, tab.id, store])
  const rebase = useExternalFollow({
    sessionId,
    path: tab.path,
    // 脏编辑不暂停轮询：指纹探测（fs.stat）继续，外部改动才能弹「文件已在磁盘上被修改」提示条
    paused: tab.loading || saving,
    visible: store.panelOpen || store.overlayOpen, // 列收起时宿主仍挂载本组件，必须停轮询
    // 已知指纹（打开/上次同步时记录）：重挂载后首探测与其比对，切走期间的外部变化不吞
    known: { version: tab.baseVersion, size: tab.baseSize },
    onChanged: followExternalChange,
  })

  useEffect(() => {
    if (tab.loading) return
    // 脏编辑期间不拉 diff：视图此时不展示（viewPatch 为 null），
    // 保存 / 载入最新后 content 变化会自然重拉。
    if (tab.dirty) return
    let cancelled = false
    // 大文件/大仓库 diff 放宽超时
    void rpc<{ patch?: string | null; untracked?: boolean }>(sessionId, 'git.fileDiff', {
      path: tab.path,
      mode: 'git',
    }, { timeoutMs: 60_000 }).then(res => {
      if (cancelled) return
      setUntracked(res.untracked === true)
      setPatch(typeof res.patch === 'string' && res.patch.length > 0 ? res.patch : null)
    })
    return () => { cancelled = true }
  }, [sessionId, tab.path, tab.loading, tab.dirty, tab.content])

  const save = useCallback(async () => {
    // 外部已修改提示条仍在：先确认，避免盲覆盖冲掉 agent 刚写的内容
    let overwrite = false
    if (staleDisk !== null) {
      let confirmed = true
      try {
        confirmed = window.confirm('磁盘文件已被外部修改，保存将覆盖外部改动。确定保存？')
      } catch {
        /* 受限环境 confirm 不可用：视为确认，不把保存通道堵死 */
      }
      if (!confirmed) return
      overwrite = true
    }
    flushContent() // 防抖中的正文先落库，保存失败切走时草稿也不丢
    setSaving(true)
    setSaveError(null)
    const args: Record<string, unknown> = { path: tab.path, content: value }
    // CAS：无已知外部改动时带基准版本，版本不符由新 Host 拒绝（旧 Host 忽略
    // expected 照常写）。用户已在提示条上确认覆盖 → 不带 expected 直接写，
    // 兑现对话框「保存将覆盖外部改动」的承诺。
    if (!overwrite && tab.baseVersion !== null && tab.baseVersion !== undefined) args.expected = tab.baseVersion
    const res = await rpc<{ ok?: boolean; version?: string }>(sessionId, 'fs.write', args)
    setSaving(false)
    if (res.ok !== true || res.error !== undefined) {
      const raw = typeof res.error === 'string' && res.error.length > 0 ? res.error : '保存失败'
      // 版本冲突（新 Host 的 CAS 拒绝，error 带 seam 文案）：映射成中文，并
      // 立即重读磁盘内容让「载入最新版本 / 忽略」提示条当场出现（不等下个轮询 tick）
      if (/file changed since it was read/i.test(raw)) {
        setSaveError('文件已在磁盘上被修改，本次保存未执行')
        followExternalChange()
        return
      }
      setSaveError(raw)
      return
    }
    staleVersionRef.current = null
    store.patchTab(tab.id, {
      dirty: false,
      content: value,
      // 保存成功：响应带回新版本则作为新基准；没带回则置空（旧宿主不做 CAS）。
      // baseSize 保留旧值作比对锚点：与磁盘不符时下次重挂载会补一次重读自愈。
      baseVersion: typeof res.version === 'string' ? res.version : null,
    })
    // 写盘成功：基准重建，避免把「自己的保存」误判成外部修改；
    // 挂起的磁盘提示也一并撤销。
    rebase()
    setStaleDisk(null)
  }, [sessionId, tab.id, tab.path, tab.baseVersion, value, store, rebase, staleDisk, flushContent, followExternalChange])

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
      {staleDisk !== null && (
        <div className="dshx-stale-bar">
          <span>文件已在磁盘上被修改</span>
          <button
            type="button"
            className="dshx-btn small"
            onClick={() => {
              setStaleDisk(null)
              staleVersionRef.current = null
              staleSizeRef.current = null
            }}
          >
            忽略
          </button>
          <button
            type="button"
            className="dshx-btn small primary"
            onClick={() => {
              // 载入最新 = 丢弃未保存修改，先确认（受限环境 confirm 不可用时按项目惯例视为确认）
              let confirmed = true
              try {
                confirmed = window.confirm('载入最新版本将丢弃当前未保存的修改。确定继续？')
              } catch {
                /* 受限环境 confirm 不可用：视为确认，不把通道堵死 */
              }
              if (!confirmed) return
              setValue(staleDisk)
              // 内容换成磁盘最新的同时重建版本基准；内容已与磁盘一致，脏标一并复位
              store.patchTab(tab.id, {
                content: staleDisk,
                error: null,
                baseVersion: staleVersionRef.current,
                baseSize: staleSizeRef.current,
                dirty: false,
              })
              setStaleDisk(null)
              staleVersionRef.current = null
              staleSizeRef.current = null
              rebase()
            }}
          >
            载入最新版本
          </button>
        </div>
      )}
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
            // 脏标立即入库（保存按钮 / 未保存徽标 / 外部跟随守卫都靠它）；
            // 正文防抖 ~250ms 再写 store，避免每键全栏重渲染 + 整串拷贝
            if (!tab.dirty) store.patchTab(tab.id, { dirty: true })
            const pending = flushTimer.current
            if (pending !== null) window.clearTimeout(pending.timer)
            const timer = window.setTimeout(() => {
              flushTimer.current = null
              store.patchTab(tab.id, { content: next })
            }, CONTENT_DEBOUNCE_MS)
            flushTimer.current = { id: tab.id, content: next, timer }
          }}
          onKeyDown={onKeyDown}
        />
      ) : (
        <CodeView path={tab.path} content={value} patch={viewPatch} untracked={viewUntracked} />
      )}
    </div>
  )
}

/**
 * Markdown 预览子树：解析挪进子组件，MdErrorBoundary 才兜得住渲染期抛错——
 * 边界只能捕获子组件的错误，若 useMemo 留在 PreviewTab 本体里执行，
 * 包在内部的边界对它无效。
 */
function MarkdownPreview({ content }: { content: string }): JSX.Element {
  // 解析按内容 memo：store 每次通知都会重渲染本组件，
  // 裸调 renderMarkdown 会把整篇文档同步重解析（大文档数百毫秒级 × 连续多次通知）。
  const html = useMemo(() => renderMarkdown(content), [content])
  return <div className="dshx-preview dshx-scroll" dangerouslySetInnerHTML={{ __html: html }} />
}

export function PreviewTab({ tab, sessionId, store }: { tab: FileTab; sessionId: string; store: ExplorerStore }): JSX.Element {
  const [content, setContent] = useState(tab.content)
  const [desktopError, setDesktopError] = useState<string | null>(null)

  useEffect(() => {
    if (!tab.loading) setContent(tab.content)
  }, [tab.loading, tab.content])

  // 外部更新跟随：fileFollow 每 2s 探指纹（fs.stat，失败回退 fs.list 父目录，
  // 与宿主是否重启无关），变化就静默重读。预览只读，不会和编辑冲突。
  const pullLatest = useCallback(async () => {
    // 大文件读取显式放宽超时（默认 15s 会误杀）
    const read = await rpc<{ content?: string; version?: string; size?: number }>(sessionId, 'fs.read', { path: tab.path }, { timeoutMs: 30_000 })
    if (read.error !== undefined || typeof read.content !== 'string') return
    store.patchTab(tab.id, {
      content: read.content,
      error: null,
      // 基准同步前移：重挂载后首探测的 known 比对以此为准
      baseVersion: typeof read.version === 'string' ? read.version : null,
      baseSize: typeof read.size === 'number' ? read.size : null,
    })
    setContent(read.content)
  }, [sessionId, tab.id, tab.path, store])
  useExternalFollow({
    sessionId, path: tab.path, paused: tab.loading,
    visible: store.panelOpen || store.overlayOpen, // 列收起时停轮询
    known: { version: tab.baseVersion, size: tab.baseSize }, // 重挂载首探测比对，切走期间的变化不吞
    onChanged: () => { void pullLatest() },
  })

  const reload = useCallback(() => {
    void rpc<{ content?: string; version?: string; size?: number }>(sessionId, 'fs.read', { path: tab.path }, { timeoutMs: 30_000 }).then(res => {
      if (res.error !== undefined) {
        store.patchTab(tab.id, { error: res.error })
        return
      }
      if (typeof res.content !== 'string') return
      store.patchTab(tab.id, {
        content: res.content,
        error: null,
        baseVersion: typeof res.version === 'string' ? res.version : null,
        baseSize: typeof res.size === 'number' ? res.size : null,
      })
      setContent(res.content)
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
            // 错误边界按内容 key：崩过一次的预览在文件更新（跟随重读 / 手动重载）
            // 时重新挂载、用新内容重试，而不是一直卡在错误态。
            <MdErrorBoundary key={content} title="Markdown 预览渲染失败">
              <MarkdownPreview content={content} />
            </MdErrorBoundary>
          )
        : isHtml(tab.name)
          ? <iframe className="dshx-preview-frame" title={tab.name} sandbox="" srcDoc={content} />
          : <div className="dshx-empty">该文件类型不支持预览（支持 .md / .html）</div>}
    </div>
  )
}
