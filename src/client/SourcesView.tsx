/**
 * 右侧栏：当前会话引用到 / 搜索到的来源与页面。
 */

import { useEffect, useRef, useState } from 'react'
import { rpc, safeExternalUrl } from './rpc'
import type { SourceGroup } from './SummaryCard'

export function SourcesView({ sessionId }: { sessionId: string }): JSX.Element {
  const [groups, setGroups] = useState<SourceGroup[]>([])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const reqSeq = useRef(0)

  useEffect(() => {
    const load = (): void => {
      const my = ++reqSeq.current
      void rpc<{ groups?: SourceGroup[]; error?: string }>(sessionId, 'session.sources').then(res => {
        if (my !== reqSeq.current) return
        if (res.error !== undefined && res.error !== '') setError(res.error)
        setGroups(res.groups ?? [])
      })
    }
    load()
    const timer = setInterval(load, 8000)
    return () => clearInterval(timer)
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
            {(expanded || group.pages.length <= 2) && group.pages.map(page => (
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
                  <div key={page.title} className="dshx-source-page">
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
