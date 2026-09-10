/**
 * Right-hand Explorer panel, embedded in the official details column.
 * Column width is owned by the host layout (with the width-memory wrap).
 * The open/close control lives in header utilities, not this tab bar.
 * A zero-height probe keeps store.panelOpen in sync with the real column.
 */

import { useLayoutEffect, useEffect, useRef } from 'react'
import { ContextView } from './ContextView'
import { EditorTab, PreviewTab } from './EditorTab'
import { ReviewView } from './ReviewView'
import { SourcesView } from './SourcesView'
import { readPanelIntent, useExplorer, type ExplorerPage, type ExplorerStore } from './store'
import { closeNarrowOverlay, narrowNow } from './narrowPanel'
import { getAttachedPanelActions, maybePersistObservedWidth, readDetailsWidth } from './detailsWidth'

export interface LayoutFace {
  openDetails(): void
  closeDetails(): void
  toggleSidebar(): void
}

export interface ExplorerPanelProps {
  sessionId: string
  useProjection?: (key: string) => any
  useSessions?: (selector: (state: any) => unknown) => any
  store: ExplorerStore
  /** 宿主的开列动作：会话切换后按用户意图自动恢复右栏。 */
  openDetails?: () => void
}

const PAGE_LABEL: Record<ExplorerPage, string> = {
  review: '审查',
  context: '上下文',
  sources: '来源',
}

/** 关闭脏 tab 前的确认：window.confirm 在沙箱/受限环境可能直接抛错，
 *  异常时视为确认，保证脏 tab 永远关得掉。 */
function confirmCloseDirtyTab(name: string): boolean {
  try {
    return window.confirm(`「${name}」有未保存修改，确定关闭吗？`)
  } catch {
    return true
  }
}

const PAGE_IDS: ReadonlySet<string> = new Set(Object.keys(PAGE_LABEL))

export function ExplorerPanel({
  sessionId, useProjection, useSessions, store: storeHandle, openDetails,
}: ExplorerPanelProps): JSX.Element {
  const store = useExplorer(storeHandle)

  // 右栏状态按会话隔离：本会话自己的 tab 列表和激活项；其他会话打开的
  // 文件互不可见，切回来各自恢复。
  const sessionTabs = store.sessionTabs(sessionId)
  let active = store.activeFor(sessionId)
  if (!PAGE_IDS.has(active) && !sessionTabs.some(tab => tab.id === active)) {
    active = store.defaultActive // 记录指向了别的会话的 tab / 已删除
  }
  const activeTab = sessionTabs.find(tab => tab.id === active)
  const probeRef = useRef<HTMLDivElement | null>(null)

  // 本会话挂载即回报，store 里所有「当前会话」语义（意图写入等）以它为准。
  useEffect(() => {
    store.noteSession(sessionId)
  }, [sessionId, store])

  // 会话切换：宿主 AppFrame 在切会话时无条件 closeDetails()（布局偏好被清
  // 零）。只有「这个会话」之前被用户显式打开过才恢复：rAF 后（宿主的关闭
  // 已落定）显式 openDetails 并把记忆宽度直接写入 store——不做探针测量、
  // 不开长定时器，最多 3 次轻量重试兜底宿主异步时序。
  const restoredFor = useRef<string | null>(null)
  useEffect(() => {
    if (openDetails === undefined) return
    if (restoredFor.current === sessionId) return
    restoredFor.current = sessionId
    if (!readPanelIntent(sessionId)) return
    let attempt = 0
    let cancelled = false
    const timers: number[] = []
    // 宿主可能在会话选择器异步提交后才补一刀 closeDetails，两档轻量重试兜住
    const DELAYS = [400, 1000]
    const restore = (): void => {
      if (cancelled) return
      if (store.overlayOpen || narrowNow()) return
      const probe = probeRef.current
      // 已经足够宽就不动它（避免在过渡中追加写入引起抖动）
      if (probe !== null && probe.offsetWidth >= 40) {
        if (attempt < DELAYS.length) timers.push(window.setTimeout(restore, DELAYS[attempt]))
        attempt += 1
        return
      }
      const actions = getAttachedPanelActions()
      const saved = readDetailsWidth()
      if (
        actions !== null && typeof actions.openDetails === 'function' &&
        typeof actions.setDetails === 'function' && saved !== undefined
      ) {
        actions.openDetails()
        actions.setDetails(saved) // 直接写偏好，最终渲染宽度一定是记忆值
      } else {
        openDetails() // 兜底：actions 还没挂上时的普通打开
      }
      if (attempt < DELAYS.length) timers.push(window.setTimeout(restore, DELAYS[attempt]))
      attempt += 1
    }
    // 双 rAF：确保本轮提交（含宿主的 closeDetails）完全落定之后再写。
    let raf2 = 0
    const raf1 = window.requestAnimationFrame(() => { raf2 = window.requestAnimationFrame(restore) })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(raf1)
      if (raf2 !== 0) window.cancelAnimationFrame(raf2)
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [sessionId, openDetails, store])

  // Sync open state: details column width > 0 means open, whoever opened it.
  // Debounce is required: during the host grid transition the width changes
  // every frame, and an immediate setPanelOpen fights the click and stacks a
  // full review-diff rerender on the transition.
  // Narrow overlay mode: the column is styled full-width by CSS while the
  // overlay marker is set, so the probe measure stays valid there too; but
  // while narrow WITHOUT the marker the official chain pins width to 0 and the
  // probe must not flip panelOpen around the user's explicit toggle.
  useLayoutEffect(() => {
    const probe = probeRef.current
    if (probe === null || typeof ResizeObserver === 'undefined') return
    let timer = 0
    let persistTimer = 0
    const sync = (): void => {
      timer = 0
      // 官方在窄屏下无条件把 details 列压成 0；这不是用户关闭面板，不能
      // 用它覆盖缩窄前的 panelOpen 状态，否则断点迁移无法判断是否应替换会话。
      if (store.overlayOpen || narrowNow()) return
      const width = probe.offsetWidth
      const open = width > 4
      if (open !== store.panelOpen) store.setPanelOpen(open)
      // 观测式宽度记忆：稳定 350ms 后落盘（拖拽路径不经任何包装 actions，
      // 实测是唯一可靠来源；过渡中的中间值靠 settle 窗口过滤）。
      if (open && width >= 40) {
        if (persistTimer !== 0) window.clearTimeout(persistTimer)
        persistTimer = window.setTimeout(() => {
          persistTimer = 0
          // overlay 替换模式下 details 列被 CSS 拉满全宽，实测值不是列宽——
          // 不落盘（否则窄视口的整屏宽度会被当成记忆宽度存下来）。
          if (store.overlayOpen || narrowNow()) return
          maybePersistObservedWidth(probe.offsetWidth)
        }, 350)
      }
    }
    const observer = new ResizeObserver(() => {
      if (timer !== 0) window.clearTimeout(timer)
      timer = window.setTimeout(sync, 80)
    })
    observer.observe(probe)
    return () => {
      observer.disconnect()
      if (timer !== 0) window.clearTimeout(timer)
      if (persistTimer !== 0) window.clearTimeout(persistTimer)
    }
  }, [store])

  return (
    <div className="dshx-root">
      {/* Column-width probe: zero height, full width; ResizeObserver only. */}
      <div ref={probeRef} style={{ width: '100%', height: 0 }} aria-hidden />

      <div className="dshx-tabbar">
        {store.overlayOpen && (
          <button
            type="button"
            className="dshx-overlay-close"
            onClick={() => { closeNarrowOverlay(store, sessionId) }}
            title="返回会话"
            aria-label="返回会话"
          >
            <span aria-hidden>◀</span>
            返回
          </button>
        )}
        <button
          className={`dshx-tab ${active === 'review' ? 'active' : ''}`}
          onClick={() => store.activate('review')}
        >
          <span className="dshx-tab-label">审查</span>
        </button>
        <button
          className={`dshx-tab ${active === 'context' ? 'active' : ''}`}
          onClick={() => store.activate('context')}
        >
          <span className="dshx-tab-label">上下文</span>
        </button>
        {store.extraPages.map(page => (
          <button
            key={page}
            className={`dshx-tab ${active === page ? 'active' : ''}`}
            onClick={() => store.activate(page)}
          >
            <span className="dshx-tab-label">{PAGE_LABEL[page]}</span>
            <span
              className="dshx-tab-close"
              role="button"
              tabIndex={0}
              aria-label={`关闭 ${PAGE_LABEL[page]}`}
              onClick={event => {
                event.stopPropagation()
                store.closePage(page)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation()
                  store.closePage(page)
                }
              }}
            >
              ✕
            </span>
          </button>
        ))}
        {sessionTabs.map(tab => (
          <button
            key={tab.id}
            className={`dshx-tab ${active === tab.id ? 'active' : ''}`}
            onClick={() => store.activate(tab.id)}
            title={tab.path}
          >
            <span className="dshx-tab-preview">{tab.kind === 'preview' ? '预览' : '编辑'}</span>
            <span className="dshx-tab-label">{tab.dirty ? '● ' : ''}{tab.name}</span>
            <span
              className="dshx-tab-close"
              role="button"
              tabIndex={0}
              aria-label={`关闭 ${tab.name}`}
              onClick={event => {
                event.stopPropagation()
                if (tab.dirty && !confirmCloseDirtyTab(tab.name)) {
                  return
                }
                store.closeTab(tab.id)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation()
                  if (tab.dirty && !confirmCloseDirtyTab(tab.name)) {
                    return
                  }
                  store.closeTab(tab.id)
                }
              }}
            >
              ✕
            </span>
          </button>
        ))}
      </div>

      <div className="dshx-page" hidden={active !== 'review'} aria-hidden={active !== 'review'}>
        <ReviewView sessionId={sessionId} store={storeHandle} visible={active === 'review'} />
      </div>
      {active === 'context' && <ContextView sessionId={sessionId} useProjection={useProjection} />}
      {active === 'sources' && <SourcesView sessionId={sessionId} />}
      {/* key 按 tab 隔离实例：切 tab 整体重挂载，替代 EditorTab 内手写的
          [tab.id] 重置状态机（脏草稿经卸载兜底 flush 落库，切走期间的磁盘
          变化经 fileFollow 的 known 指纹比对在重挂载首探测补触发）。 */}
      {activeTab !== undefined && activeTab.kind === 'edit' && (
        <EditorTab key={activeTab.id} tab={activeTab} sessionId={sessionId} store={store} />
      )}
      {activeTab !== undefined && activeTab.kind === 'preview' && (
        <PreviewTab key={activeTab.id} tab={activeTab} sessionId={sessionId} store={store} />
      )}
    </div>
  )
}
