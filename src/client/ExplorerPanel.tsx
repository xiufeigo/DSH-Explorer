/**
 * 右侧 Explorer 面板：嵌入式渲染（官方 details 列内）。
 * 列宽由官方布局驱动（带宽度记忆 fork，可拖 300–1200px）。
 * 开合按钮在会话头部 utilities，不在本面板 tab 栏。
 * 面板内嵌 0 高探针用 ResizeObserver 同步真实开合状态到 store，
 * 无论面板是被头部按钮、文件树点击还是官方流程（点击工具调用）打开的，
 * store.panelOpen 始终准确。
 */

import { useLayoutEffect, useRef } from 'react'
import { ContextView } from './ContextView'
import { EditorTab, PreviewTab } from './EditorTab'
import { ReviewView } from './ReviewView'
import { SourcesView } from './SourcesView'
import { SubagentsView } from './SubagentsView'
import { useExplorer, type ExplorerPage, type ExplorerStore } from './store'

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
  explorer: { store: ExplorerStore; layout: LayoutFace; sessions?: SessionsFace }
}

const PAGE_LABEL: Record<ExplorerPage, string> = {
  review: '审查',
  context: '上下文',
  subagents: '子智能体',
  sources: '来源',
}

export function ExplorerPanel({ sessionId, useProjection, useSessions, explorer }: ExplorerPanelProps): JSX.Element {
  const store = useExplorer(explorer.store)
  const active = store.active
  const activeTab = store.tabs.find(tab => tab.id === active)
  const probeRef = useRef<HTMLDivElement | null>(null)

  // 开合状态同步：details 列宽度 >0 即视为打开（无论谁打开的）。
  // 必须 debounce：宿主 grid 过渡期间宽度每帧变化，若立刻 setPanelOpen
  // 会和点击态打架，并把审查 diff 整树重绘叠在过渡上，右侧栏必卡。
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
      {/* 列宽探针：0 高、满宽，仅在列开合时触发 ResizeObserver。 */}
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
        <ReviewView sessionId={sessionId} store={explorer.store} visible={active === 'review'} />
      </div>
      {active === 'context' && <ContextView sessionId={sessionId} useProjection={useProjection} />}
      {active === 'subagents' && (
        <SubagentsView
          sessionId={sessionId}
          store={store}
          useSessions={useSessions}
          sessions={explorer.sessions}
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
