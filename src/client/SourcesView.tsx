/**
 * 右侧栏：当前会话引用到 / 搜索到的来源与页面。
 */

import { useEffect, useRef, useState } from 'react'
import { rpcWithSessionRetry, safeExternalUrl } from './rpc'
import type { SourceGroup } from './SummaryCard'

export function SourcesView({ sessionId }: { sessionId: string }): JSX.Element {
  const [groups, setGroups] = useState<SourceGroup[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const reqSeq = useRef(0)

  useEffect(() => {
    // 会话切换：清空旧数据，避免新会话首响应到达前显示上一会话的来源。
    setGroups([])
    setError(null)
    const load = (): void => {
      if (typeof document !== 'undefined' && document.hidden) return
      const my = ++reqSeq.current
      // 瞬时错误（会话尚未挂载）由 rpcWithSessionRetry 内部重试，不闪红字。
      void rpcWithSessionRetry<{ groups?: SourceGroup[]; error?: string }>(sessionId, 'session.sources').then(res => {
        if (my !== reqSeq.current) return
        if (res.error !== undefined && res.error !== '') {
          setError(res.error)
          return
        }
        setError(null)
        setGroups(res.groups ?? [])
      })
    }
    load()
    const timer = setInterval(load, 8000)
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
  }, [sessionId])

  if (error !== null && error !== '') return <div className="dshx-error">{error}</div>
  if (groups.length === 0) return <div className="dshx-empty">当前会话还没有引用或搜索到的来源</div>

  return (
    <div className="dshx-scroll dshx-sources">
      {groups.map(group => {
        const expanded = open[group.name] === true
        const bits: string[] = []
        if (group.searches > 0) bits.push(`已搜索 ${group.searches} 次`)
        if (group.fetches > 0) bits.push(`已打开 ${group.fetches} 次`)
        if (bits.length === 0) bits.push('在对话中提供')
        return (
          <div key={group.name} className="dshx-source-card">
            <button
              type="button"
              className="dshx-source-head"
              onClick={() => setOpen(current => ({ ...current, [group.name]: !expanded }))}
            >
              <span className="dshx-source-icon" aria-hidden>↗</span>
              <span className="dshx-agent-copy">
                <span className="dshx-agent-title">{group.title}</span>
                <span className="dshx-agent-status">{bits.join(' · ')}</span>
              </span>
              {group.pages.length > 0 && (
                <span className={`dshx-file-pane-chevron${expanded ? ' open' : ''}`} />
              )}
            </button>
            {(expanded || group.pages.length <= 2) && group.pages.map((page, index) => (
              page.url.length > 0
                ? (
                  <a
                    key={page.url}
                    className="dshx-source-page"
                    href={safeExternalUrl(page.url)}
                    target="_blank"
                    rel="noreferrer"
                    title={page.url}
                  >
                    <span className="dshx-source-page-title">{page.title}</span>
                    {page.snippet.length > 0 && <span className="dshx-source-page-snip">{page.snippet}</span>}
                  </a>
                )
                : (
                  <div key={`${page.title}#${index}`} className="dshx-source-page">
                    <span className="dshx-source-page-title">{page.title}</span>
                    {page.snippet.length > 0 && <span className="dshx-source-page-snip">{page.snippet}</span>}
                  </div>
                )
            ))}
          </div>
        )
      })}
    </div>
  )
}
