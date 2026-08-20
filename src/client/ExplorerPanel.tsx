/**
 * Right-hand Explorer panel, embedded in the official details column.
 * Column width is owned by the host layout (with the width-memory wrap).
 * The open/close control lives in header utilities, not this tab bar.
 * A zero-height probe keeps store.panelOpen in sync with the real column.
 */

import { useLayoutEffect, useRef } from 'react'
import { ContextView } from './ContextView'
import { EditorTab, PreviewTab } from './EditorTab'
import { ReviewView } from './ReviewView'
import { SourcesView } from './SourcesView'
import { SubagentsView } from './SubagentsView'
import { useExplorer, type ExplorerPage, type ExplorerStore } from './store'
import type { CatalogActions } from './faces'

export interface LayoutFace {
  openDetails(): void
  closeDetails(): void
  toggleSidebar(): void
}

export interface SessionsFace {
  refreshSubagents?(id: string): Promise<void>
  setSubagentCatalogOpen?(id: string, open: boolean): void
}

export interface ExplorerPanelProps {
  sessionId: string
  useProjection?: (key: string) => any
  useSessions?: (selector: (state: any) => unknown) => any
  store: ExplorerStore
  refreshSubagents: CatalogActions['refreshSubagents']
  setSubagentCatalogOpen: CatalogActions['setSubagentCatalogOpen']
}

const PAGE_LABEL: Record<ExplorerPage, string> = {
  review: '审查',
  context: '上下文',
  subagents: '子智能体',
  sources: '来源',
}

export function ExplorerPanel({
  sessionId, useProjection, useSessions, store: storeHandle, refreshSubagents, setSubagentCatalogOpen,
}: ExplorerPanelProps): JSX.Element {
  const store = useExplorer(storeHandle)
  const active = store.active
  const activeTab = store.tabs.find(tab => tab.id === active)
  const probeRef = useRef<HTMLDivElement | null>(null)

  // Sync open state: details column width > 0 means open, whoever opened it.
  // Debounce is required: during the host grid transition the width changes
  // every frame, and an immediate setPanelOpen fights the click and stacks a
  // full review-diff rerender on the transition.
  useLayoutEffect(() => {
    const probe = probeRef.current
    if (probe === null || typeof ResizeObserver === 'undefined') return
    let timer = 0
    const sync = (): void => {
      timer = 0
      const open = probe.offsetWidth > 4
      if (open !== store.panelOpen) store.setPanelOpen(open)
    }
    const observer = new ResizeObserver(() => {
      if (timer !== 0) window.clearTimeout(timer)
      timer = window.setTimeout(sync, 80)
    })
    observer.observe(probe)
    return () => {
      observer.disconnect()
      if (timer !== 0) window.clearTimeout(timer)
    }
  }, [store])

  return (
    <div className="dshx-root">
      {/* Column-width probe: zero height, full width; ResizeObserver only. */}
      <div ref={probeRef} style={{ width: '100%', height: 0 }} aria-hidden />

      <div className="dshx-tabbar">
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
        {store.tabs.map(tab => (
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
                store.closeTab(tab.id)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation()
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
      {active === 'subagents' && (
        <SubagentsView
          sessionId={sessionId}
          store={store}
          useSessions={useSessions}
          refreshSubagents={refreshSubagents}
          setSubagentCatalogOpen={setSubagentCatalogOpen}
        />
      )}
      {active === 'sources' && <SourcesView sessionId={sessionId} />}
      {activeTab !== undefined && activeTab.kind === 'edit' && (
        <EditorTab tab={activeTab} sessionId={sessionId} store={store} />
      )}
      {activeTab !== undefined && activeTab.kind === 'preview' && (
        <PreviewTab tab={activeTab} sessionId={sessionId} store={store} />
      )}
    </div>
  )
}
