/**
 * Codex-style environment summary: changes / branch / commit-push / sources.
 * No "local" row. Change counts open Review; sources open the details page.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { rpc, rpcWithSessionRetry, safeExternalUrl } from './rpc'
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

interface SummaryCardProps {
  sessionId: string
  store: ExplorerStore
  openDetails(): void
  useSessions?: (selector: (state: any) => unknown) => any
  onNavigate?: () => void
}

function openPage(
  store: ExplorerStore,
  openDetails: () => void,
  page: 'review' | 'sources',
  opts?: { reviewMode?: ReviewMode },
): void {
  store.openPage(page, opts)
  openDetails()
}

export function SummaryCard({
  sessionId, store, openDetails, useSessions, onNavigate,
}: SummaryCardProps): JSX.Element {
  const [git, setGit] = useState<GitSummary>({})
  const [sources, setSources] = useState<SourceGroup[]>([])
  const [branchOpen, setBranchOpen] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const reqSeq = useRef(0)
  // 最新 sessionId 的镜像：异步动作 resolve 后用它判断会话是否已切走
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  const load = useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    const my = ++reqSeq.current
    // 大仓库 git.summary 可能超过默认 15s，显式放宽
    void rpcWithSessionRetry<GitSummary>(sessionId, 'git.summary', {}, undefined, { timeoutMs: 60_000 }).then(res => {
      if (my === reqSeq.current) setGit(res)
    })
    void rpcWithSessionRetry<{ groups?: SourceGroup[] }>(sessionId, 'session.sources').then(res => {
      if (my === reqSeq.current) setSources(res.groups ?? [])
    })
  }, [sessionId])

  useEffect(() => {
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
  }, [load, sessionId])

  const previewSources = sources.slice(0, 3)
  const added = git.added ?? 0
  const deleted = git.deleted ?? 0

  const go = (page: 'review' | 'sources', opts?: { reviewMode?: ReviewMode }): void => {
    openPage(store, openDetails, page, opts)
    onNavigate?.()
  }

  // 异步动作发起时捕获 sessionId；resolve 后与最新会话比对，切走了就丢弃
  // 对旧会话卡片的 UI 写入（busy 复位除外，否则新会话卡片卡在忙碌态）。
  const checkout = async (branch: string): Promise<void> => {
    const actSession = sessionId
    setBusy('checkout')
    setNote(null)
    const res = await rpc<{ ok?: boolean; error?: string }>(sessionId, 'git.checkout', { branch })
    setBusy(null)
    if (sessionIdRef.current !== actSession) return
    setBranchOpen(false)
    if (res.ok === true) {
      setNote(`已切换到 ${branch}`)
      load()
    } else {
      setNote(res.error ?? '切换分支失败')
    }
  }

  const commit = async (): Promise<void> => {
    const actSession = sessionId
    setBusy('commit')
    setNote(null)
    const res = await rpc<{ ok?: boolean; error?: string; text?: string }>(sessionId, 'git.commit', { message: commitMsg })
    setBusy(null)
    if (sessionIdRef.current !== actSession) return
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
    const actSession = sessionId
    setBusy('push')
    setNote(null)
    const res = await rpc<{ ok?: boolean; error?: string; text?: string }>(sessionId, 'git.push')
    setBusy(null)
    if (sessionIdRef.current !== actSession) return
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
                      disabled={busy !== null}
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
              if (typeof url === 'string' && url.length > 0) {
                const safe = safeExternalUrl(url)
                if (safe !== '#') window.open(safe, '_blank', 'noopener')
              }
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
