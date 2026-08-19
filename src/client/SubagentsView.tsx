/**
 * 右侧栏：当前会话的子智能体列表；点进一条显示该子会话的对话内容。
 * 不调用 openSubagent，避免把中间主对话切走。
 */

import { useCallback, useEffect, useState } from 'react'
import { agentHue, formatClock, relativeTime } from './conversationHost'
import { rpc } from './rpc'
import { useExplorer, type ExplorerStore } from './store'

interface CatalogEntry {
  kind?: string
  id?: string
  label?: string
  activity?: string
  mode?: string
}

interface AgentRow {
  id: string
  label: string
  activity: string
  mode?: string
}

interface TranscriptMessage {
  role: string
  text: string
  time: number
  seq: number
}

interface SessionsFace {
  refreshSubagents?(id: string): Promise<void>
  setSubagentCatalogOpen?(id: string, open: boolean): void
}

const PREVIEW = 4

export function SubagentsView({
  sessionId, store, useSessions, sessions,
}: {
  sessionId: string
  store: ExplorerStore
  useSessions?: (selector: (state: any) => unknown) => any
  sessions?: SessionsFace
}): JSX.Element {
  const explorer = useExplorer(store)
  const selected = explorer.subagentId
  const [hostAgents, setHostAgents] = useState<AgentRow[]>([])
  const [runningOpen, setRunningOpen] = useState(true)
  const [doneOpen, setDoneOpen] = useState(true)
  const [runningMore, setRunningMore] = useState(false)
  const [doneMore, setDoneMore] = useState(false)
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const catalog = useSessions !== undefined
    ? useSessions((state: { subagentsByParent?: Record<string, { entries?: CatalogEntry[] }> }) => state.subagentsByParent?.[sessionId]) as { entries?: CatalogEntry[] } | undefined
    : undefined
  const summaries = useSessions !== undefined
    ? useSessions((state: { byId?: Record<string, { title?: string; running?: boolean; updatedAt?: number }> }) => state.byId) as Record<string, { title?: string; running?: boolean; updatedAt?: number }> | undefined
    : undefined

  useEffect(() => {
    void sessions?.refreshSubagents?.(sessionId)
    sessions?.setSubagentCatalogOpen?.(sessionId, true)
    void rpc<{ agents?: AgentRow[] }>(sessionId, 'session.subagents').then(res => {
      setHostAgents(res.agents ?? [])
    })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(timer)
      sessions?.setSubagentCatalogOpen?.(sessionId, false)
    }
  }, [sessionId, sessions])

  const catalogAgents: AgentRow[] = (catalog?.entries ?? [])
    .filter(entry => entry.kind === 'child' && typeof entry.id === 'string')
    .map(entry => ({
      id: entry.id as string,
      label: (entry.label ?? summaries?.[entry.id as string]?.title ?? entry.id) as string,
      activity: entry.activity ?? (summaries?.[entry.id as string]?.running === true ? 'running' : 'inactive'),
      mode: entry.mode,
    }))
  const agents = catalogAgents.length > 0 ? catalogAgents : hostAgents.map(agent => ({
    ...agent,
    label: summaries?.[agent.id]?.title ?? agent.label,
  }))
  const running = agents.filter(agent => agent.activity === 'running')
  const done = agents.filter(agent => agent.activity !== 'running')

  const loadTranscript = useCallback((id: string) => {
    setError(null)
    setMessages([])
    void rpc<{ messages?: TranscriptMessage[]; error?: string }>(sessionId, 'session.transcript', { targetId: id }).then(res => {
      if (res.error !== undefined && res.error !== '') setError(res.error)
      setMessages(res.messages ?? [])
    })
  }, [sessionId])

  useEffect(() => {
    if (selected === null) return
    loadTranscript(selected)
  }, [selected, loadTranscript])

  const selectedAgent = agents.find(agent => agent.id === selected)

  if (selected !== null) {
    return (
      <div className="dshx-subpage">
        <div className="dshx-subpage-head">
          <button type="button" className="dshx-icon-btn" title="返回列表" onClick={() => store.openPage('subagents', { subagentId: null })}>
            ←
          </button>
          <span className="dshx-summary-dot" style={{ background: agentHue(selected) }} />
          <span className="dshx-panel-title">{selectedAgent?.label ?? selected}</span>
        </div>
        {error !== null && error !== '' ? <div className="dshx-error">{error}</div> : null}
        {messages.length === 0 && (error === null || error === '') ? (
          <div className="dshx-empty">该子智能体还没有会话内容</div>
        ) : (
          <div className="dshx-scroll dshx-transcript">
            {messages.map(message => (
              <div key={`${message.role}-${message.seq}`} className={`dshx-bubble ${message.role}`}>
                <div className="dshx-bubble-meta">
                  {message.role === 'user' ? '用户' : '智能体'}
                  {message.time > 0 ? ` · ${relativeTime(message.time, now)}` : ''}
                </div>
                <div className="dshx-bubble-text">{message.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const slice = (list: AgentRow[], more: boolean): AgentRow[] =>
    more || list.length <= PREVIEW ? list : list.slice(0, PREVIEW)

  const renderList = (list: AgentRow[], more: boolean, setMore: (value: boolean) => void): JSX.Element => (
    <>
      {list.length === 0
        ? <div className="dshx-file-pane-empty">没有条目</div>
        : slice(list, more).map(agent => {
          const summary = summaries?.[agent.id]
          const stamp = agent.activity === 'running'
            ? (typeof summary?.updatedAt === 'number' ? formatClock(now - summary.updatedAt) : '处理中')
            : (typeof summary?.updatedAt === 'number' ? relativeTime(summary.updatedAt, now) : '完成')
          return (
            <button
              key={agent.id}
              type="button"
              className="dshx-agent-row"
              onClick={() => store.openPage('subagents', { subagentId: agent.id })}
            >
              <span className="dshx-summary-dot lg" style={{ background: agentHue(agent.id) }} />
              <span className="dshx-agent-copy">
                <span className="dshx-agent-title">{agent.label}</span>
                <span className="dshx-agent-status">{agent.activity === 'running' ? '处理中' : '已完成'}</span>
              </span>
              <span className="dshx-agent-time">{stamp}</span>
            </button>
          )
        })}
      {list.length > PREVIEW && !more && (
        <button type="button" className="dshx-summary-all" onClick={() => setMore(true)}>
          再显示 {list.length - PREVIEW} 个
        </button>
      )}
    </>
  )

  return (
    <div className="dshx-subpage">
      {agents.length === 0 ? (
        <div className="dshx-empty">当前会话还没有子智能体</div>
      ) : (
        <div className="dshx-scroll">
          <div className={`dshx-file-pane${runningOpen ? ' open' : ''}${running.length === 0 ? ' empty' : ''}`}>
            <button type="button" className="dshx-file-pane-head" onClick={() => setRunningOpen(open => !open)}>
              <span className={`dshx-file-pane-chevron${runningOpen ? ' open' : ''}`} />
              <span className="dshx-file-pane-title">已开启</span>
              <span className="dshx-file-pane-count">{running.length}</span>
            </button>
            {runningOpen && renderList(running, runningMore, setRunningMore)}
          </div>
          <div className={`dshx-file-pane${doneOpen ? ' open' : ''}${done.length === 0 ? ' empty' : ''}`}>
            <button type="button" className="dshx-file-pane-head" onClick={() => setDoneOpen(open => !open)}>
              <span className={`dshx-file-pane-chevron${doneOpen ? ' open' : ''}`} />
              <span className="dshx-file-pane-title">完成</span>
              <span className="dshx-file-pane-count">{done.length}</span>
            </button>
            {doneOpen && renderList(done, doneMore, setDoneMore)}
          </div>
        </div>
      )}
    </div>
  )
}
