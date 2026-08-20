/**
 * Codex-style environment summary: changes / branch / commit-push / child
 * agents / sources. No "local" row. Change counts open Review; child agents
 * and sources open the matching details page.
 */

import { useCallback, useEffect, useState } from 'react'
import { agentHue } from './conversationHost'
import { rpc, rpcWithSessionRetry } from './rpc'
import type { ExplorerStore, ReviewMode } from './store'

export interface GitSummary {
  notRepo?: boolean
  error?: string
  branch?: string
  branches?: string[]
  added?: number
  deleted?: number
  dirty?: number
  remoteUrl?: string
  base?: string
  compareUrl?: string | null
}

export interface SourcePage {
  url: string
  title: string
  snippet: string
}

export interface SourceGroup {
  name: string
  title: string
  searches: number
  fetches: number
  pages: SourcePage[]
}

export interface SubagentRow {
  id: string
  label: string
  activity: 'running' | 'inactive' | string
  mode?: string
}

interface CatalogEntry {
  kind?: string
  id?: string
  label?: string
  activity?: string
  mode?: string
}

interface SummaryCardProps {
  sessionId: string
  store: ExplorerStore
  openDetails(): void
  refreshSubagents(id: string): void
  setSubagentCatalogOpen(id: string, open: boolean): void
  useSessions?: (selector: (state: any) => unknown) => any
  onNavigate?: () => void
}

function openPage(
  store: ExplorerStore,
  openDetails: () => void,
  page: 'review' | 'subagents' | 'sources',
  opts?: { reviewMode?: ReviewMode; subagentId?: string | null },
): void {
  store.openPage(page, opts)
  openDetails()
}

export function SummaryCard({
  sessionId, store, openDetails, refreshSubagents, setSubagentCatalogOpen, useSessions, onNavigate,
}: SummaryCardProps): JSX.Element {
  const [git, setGit] = useState<GitSummary>({})
  const [sources, setSources] = useState<SourceGroup[]>([])
  const [hostAgents, setHostAgents] = useState<SubagentRow[]>([])
  const [branchOpen, setBranchOpen] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const catalog = useSessions !== undefined
    ? useSessions((state: { subagentsByParent?: Record<string, { entries?: CatalogEntry[] }> }) => state.subagentsByParent?.[sessionId]) as { entries?: CatalogEntry[] } | undefined
    : undefined

  const load = useCallback(() => {
    void rpcWithSessionRetry<GitSummary>(sessionId, 'git.summary').then(setGit)
    void rpcWithSessionRetry<{ groups?: SourceGroup[] }>(sessionId, 'session.sources').then(res => {
      setSources(res.groups ?? [])
    })
    void rpcWithSessionRetry<{ agents?: SubagentRow[] }>(sessionId, 'session.subagents').then(res => {
      setHostAgents(res.agents ?? [])
    })
    void refreshSubagents(sessionId)
    setSubagentCatalogOpen(sessionId, true)
  }, [sessionId, refreshSubagents, setSubagentCatalogOpen])

  useEffect(() => {
    load()
    const timer = setInterval(load, 8000)
    return () => {
      clearInterval(timer)
      setSubagentCatalogOpen(sessionId, false)
    }
  }, [load, sessionId, setSubagentCatalogOpen])

  const catalogAgents: SubagentRow[] = (catalog?.entries ?? [])
    .filter(entry => entry.kind === 'child' && typeof entry.id === 'string')
    .map(entry => ({
      id: entry.id as string,
      label: (entry.label ?? entry.id) as string,
      activity: entry.activity ?? 'inactive',
      mode: entry.mode,
    }))
  const agents = catalogAgents.length > 0 ? catalogAgents : hostAgents
  const running = agents.filter(agent => agent.activity === 'running')
  const done = agents.filter(agent => agent.activity !== 'running')
  const previewSources = sources.slice(0, 3)
  const added = git.added ?? 0
  const deleted = git.deleted ?? 0

  const go = (page: 'review' | 'subagents' | 'sources', opts?: { reviewMode?: ReviewMode }): void => {
    openPage(store, openDetails, page, opts)
    onNavigate?.()
  }

  const checkout = async (branch: string): Promise<void> => {
    setBusy('checkout')
    setNote(null)
    const res = await rpc<{ ok?: boolean; error?: string }>(sessionId, 'git.checkout', { branch })
    setBusy(null)
    setBranchOpen(false)
    if (res.ok === true) {
      setNote(`已切换到 ${branch}`)
      load()
    } else {
      setNote(res.error ?? '切换分支失败')
    }
  }

  const commit = async (): Promise<void> => {
    setBusy('commit')
    setNote(null)
    const res = await rpc<{ ok?: boolean; error?: string; text?: string }>(sessionId, 'git.commit', { message: commitMsg })
    setBusy(null)
    if (res.ok === true) {
      setCommitOpen(false)
      setCommitMsg('')
      setNote(res.text && res.text.length > 0 ? res.text : '已提交')
      load()
    } else {
      setNote(res.error ?? '提交失败')
    }
  }

  const push = async (): Promise<void> => {
    setBusy('push')
    setNote(null)
    const res = await rpc<{ ok?: boolean; error?: string; text?: string }>(sessionId, 'git.push')
    setBusy(null)
    if (res.ok === true) {
      setNote(res.text && res.text.length > 0 ? res.text : '已推送')
      load()
    } else {
      setNote(res.error ?? '推送失败')
    }
  }

  return (
    <div className="dshx-summary">
      <div className="dshx-summary-kicker">环境信息</div>

      {git.notRepo === true || (git.error !== undefined && git.error !== '') ? (
        <div className="dshx-summary-note">{git.error ?? '不是 Git 仓库'}</div>
      ) : (
        <>
          <button
            type="button"
            className="dshx-summary-row"
            onClick={() => go('review', { reviewMode: 'git' })}
          >
            <span className="dshx-summary-ico" aria-hidden>Δ</span>
            <span className="dshx-summary-label">变更</span>
            <span className="dshx-summary-stat">
              <span className="add">+{(added).toLocaleString()}</span>
              {' '}
              <span className="del">-{(deleted).toLocaleString()}</span>
            </span>
          </button>

          <div className="dshx-summary-branch">
            <button
              type="button"
              className="dshx-summary-row"
              aria-expanded={branchOpen}
              onClick={() => setBranchOpen(open => !open)}
            >
              <span className="dshx-summary-ico" aria-hidden>⎇</span>
              <span className="dshx-summary-label">{git.branch || '分支'}</span>
              <span className="dshx-summary-caret" aria-hidden />
            </button>
            {branchOpen && (
              <div className="dshx-summary-menu">
                {(git.branches ?? []).length === 0
                  ? <div className="dshx-summary-empty">没有本地分支</div>
                  : (git.branches ?? []).map(name => (
                    <button
                      key={name}
                      type="button"
                      className={`dshx-summary-menu-item${name === git.branch ? ' on' : ''}`}
                      disabled={busy === 'checkout'}
                      onClick={() => { void checkout(name) }}
                    >
                      {name}
                    </button>
                  ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="dshx-summary-row"
            disabled={busy === 'commit'}
            onClick={() => setCommitOpen(open => !open)}
          >
            <span className="dshx-summary-ico" aria-hidden>●</span>
            <span className="dshx-summary-label">提交或推送</span>
          </button>
          {commitOpen && (
            <div className="dshx-summary-commit">
              <textarea
                className="dshx-summary-input"
                rows={3}
                placeholder="提交说明"
                value={commitMsg}
                onChange={event => setCommitMsg(event.target.value)}
              />
              <div className="dshx-summary-commit-actions">
                <button
                  type="button"
                  className="dshx-btn small primary"
                  disabled={busy !== null || commitMsg.trim().length === 0}
                  onClick={() => { void commit() }}
                >
                  提交
                </button>
                <button
                  type="button"
                  className="dshx-btn small"
                  disabled={busy !== null}
                  onClick={() => { void push() }}
                >
                  推送
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            className="dshx-summary-row"
            onClick={() => {
              go('review', { reviewMode: 'branch' })
              const url = git.compareUrl
              if (typeof url === 'string' && url.length > 0) window.open(url, '_blank', 'noopener')
            }}
          >
            <span className="dshx-summary-ico" aria-hidden>⇄</span>
            <span className="dshx-summary-label">比较分支</span>
            {typeof git.compareUrl === 'string' && git.compareUrl.length > 0 && (
              <span className="dshx-summary-ext" aria-hidden>↗</span>
            )}
          </button>
        </>
      )}

      {note !== null && note !== '' && <div className="dshx-summary-note">{note}</div>}

      <div className="dshx-summary-section">
        <div className="dshx-summary-section-title">子智能体</div>
        <button
          type="button"
          className="dshx-summary-agents"
          onClick={() => go('subagents')}
        >
          <span className="dshx-summary-dots">
            {agents.slice(0, 5).map(agent => (
              <span key={agent.id} className="dshx-summary-dot" style={{ background: agentHue(agent.id) }} />
            ))}
            {agents.length === 0 && <span className="dshx-muted">暂无</span>}
          </span>
          <span className="dshx-summary-agent-stat">
            {running.length > 0 && <span>{running.length} 个运行中</span>}
            {done.length > 0 && <span>{done.length} 完成</span>}
          </span>
        </button>
      </div>

      <div className="dshx-summary-section">
        <div className="dshx-summary-section-title">来源</div>
        {previewSources.length === 0
          ? <div className="dshx-summary-empty">还没有引用或搜索</div>
          : previewSources.map(group => (
            <div key={group.name} className="dshx-summary-source">
              <span className="dshx-summary-source-title">{group.title}</span>
              <span className="dshx-summary-source-sub">
                {group.searches > 0 ? `搜索 ${group.searches} 次` : group.fetches > 0 ? `打开 ${group.fetches} 次` : '在对话中提供'}
              </span>
            </div>
          ))}
        <button type="button" className="dshx-summary-all" onClick={() => go('sources')}>
          查看全部
        </button>
      </div>
    </div>
  )
}
