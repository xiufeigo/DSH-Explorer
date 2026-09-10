/**
 * 上下文视图：上下文使用率 + 会话概览 + 模型上下文清单。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { isTransientSessionError, rpcWithSessionRetry } from './rpc'

interface ManifestSection {
  name: string
  chars: number
}

interface ContextData {
  cwd?: string
  preset?: string
  id?: string
  sections?: ManifestSection[]
  contexts?: ManifestSection[]
  tools?: string[]
  variables?: string[]
  error?: string
}

interface GoalLike {
  objective?: string
  phase?: string
  roundsStarted?: number
  maxGoalRounds?: number
  blockedReason?: { message?: string } | null
}

const GOAL_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成',
}

/** 紧凑 token 计数：517 / 12.2K / 517K / 1.2M（与官方 StatsLine 同规则）。 */
function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/** 官方 contextOccupancy 的本地复刻：分子取 projectedTokens，回落 pressureTokens。 */
function contextOccupancy(pressure: {
  projectedTokens?: number
  pressureTokens?: number
  contextWindow?: number
} | undefined): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined || pressure.contextWindow <= 0) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}

export function ContextView({ sessionId, useProjection }: { sessionId: string; useProjection?: (key: string) => any }): JSX.Element {
  const [data, setData] = useState<ContextData>({})
  const [error, setError] = useState<string | null>(null)
  // meta 请求取号：session.meta / context.meta 共用一序号，resolve 后序号
  // 不一致即丢弃（切会话/新一轮刷新时旧响应不得回写）。
  const metaSeq = useRef(0)
  const goalProjection = useProjection !== undefined ? useProjection('goal') : undefined
  const planProjection = useProjection !== undefined ? useProjection('plan') : undefined
  const pressure = useProjection !== undefined ? useProjection('contextPressure') : undefined
  const breakdown = useProjection !== undefined ? useProjection('contextBreakdown') : undefined

  const goal: GoalLike | null = goalProjection?.goal ?? null
  const planActive: boolean | undefined = planProjection?.active
  const occupancy = contextOccupancy(pressure as { projectedTokens?: number; pressureTokens?: number; contextWindow?: number } | undefined)

  /** 明确错误（非瞬时）置 error 态；瞬时错误（会话尚未挂载）等重试即可。 */
  const surfaceError = (message: string | undefined): void => {
    if (message === undefined || isTransientSessionError(message)) return
    setError(message)
  }

  const loadMeta = useCallback(() => {
    const my = ++metaSeq.current
    void rpcWithSessionRetry<{ cwd: string; preset?: string; id: string }>(sessionId, 'session.meta').then(meta => {
      if (my !== metaSeq.current) return
      if (meta.error !== undefined) {
        surfaceError(meta.error)
        return
      }
      setError(null)
      setData(current => ({ ...current, cwd: meta.cwd, preset: meta.preset, id: meta.id }))
    })
    // assemble() 会拼装全量提示词文本，比较贵：与 session.meta 共用同一取号，
    // 只在挂载 / 回前台 / 轮询 / 手动重试时调用。
    void rpcWithSessionRetry<{ sections: ManifestSection[]; contexts: ManifestSection[]; tools: string[]; variables: string[] }>(sessionId, 'context.meta').then(manifest => {
      if (my !== metaSeq.current) return
      if (manifest.error !== undefined) {
        surfaceError(manifest.error)
        return
      }
      setData(current => ({
        ...current,
        sections: manifest.sections ?? [],
        contexts: manifest.contexts ?? [],
        tools: manifest.tools ?? [],
        variables: manifest.variables ?? [],
      }))
    })
  }, [sessionId])

  useEffect(() => {
    // 会话切换：先清空旧会话数据，避免新会话首响应到达前串台显示。
    setData({})
    loadMeta()
    // 轮询保持原 6s 节奏，只刷新剩下的会话元数据与上下文清单。
    const timer = setInterval(loadMeta, 6000)
    // 回前台刷新加 0-300ms 随机 jitter，避免多个组件同刻齐射 RPC
    let visTimer = 0
    const onVis = (): void => {
      if (document.hidden) return
      if (visTimer !== 0) window.clearTimeout(visTimer)
      visTimer = window.setTimeout(() => { visTimer = 0; loadMeta() }, Math.round(Math.random() * 300))
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(timer)
      if (visTimer !== 0) window.clearTimeout(visTimer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [loadMeta])

  const sections = data.sections ?? []
  const contexts = data.contexts ?? []
  const tools = data.tools ?? []

  return (
    <div className="dshx-scroll">
      <div className="dshx-ctx">
        {error !== null && (
          <div className="dshx-error" style={{ padding: '4px 8px', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button
              type="button"
              className="dshx-btn small"
              onClick={() => { setError(null); loadMeta() }}
            >
              重试
            </button>
          </div>
        )}
        {/* ── 上下文使用率 ─────────────────────────────────────────────────── */}
        <div className="dshx-section">
          <div className="dshx-section-title">
            <span>上下文使用率</span>
          </div>
          <div className="dshx-section-body">
            {occupancy === null
              ? <div className="dshx-muted">暂无数据（等待模型请求上报 token 用量）</div>
              : (
                  <>
                    <div className="dshx-meter-track">
                      <div
                        className={`dshx-meter-fill ${occupancy.percent >= 90 ? 'hot' : ''}`}
                        style={{ width: `${occupancy.percent}%` }}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 }}>
                      <strong style={{ fontSize: 13 }}>{occupancy.percent}%</strong>
                      <span className="dshx-muted">~{formatTokens(occupancy.usedTokens)} / {formatTokens(occupancy.contextWindow)}</span>
                    </div>
                    {breakdown !== undefined && (
                      <div className="dshx-muted" style={{ marginTop: 6, fontSize: 11 }}>
                        系统 ~{formatTokens(breakdown.systemTokens ?? 0)} · 工具 ~{formatTokens(breakdown.toolsTokens ?? 0)} · 消息 ~{formatTokens(breakdown.messageTokens ?? 0)}
                      </div>
                    )}
                  </>
                )}
          </div>
        </div>

        {/* ── 会话概览 ─────────────────────────────────────────────────────── */}
        <div className="dshx-section">
          <div className="dshx-section-title">会话概览</div>
          <div className="dshx-section-body">
            {goal !== null && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`dshx-goal-phase ${goal.phase ?? ''}`}>{GOAL_LABEL[goal.phase ?? ''] ?? goal.phase ?? ''}</span>
                  <strong style={{ fontSize: 12.5 }}>当前 Goal</strong>
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{goal.objective ?? ''}</div>
                <div className="dshx-muted" style={{ marginTop: 4 }}>
                  轮次 {goal.roundsStarted ?? 0}/{goal.maxGoalRounds ?? '—'}
                  {goal.phase === 'blocked' && goal.blockedReason?.message !== undefined ? ` · 阻塞原因：${goal.blockedReason.message}` : ''}
                </div>
              </div>
            )}
            <dl className="dshx-kv">
              {planActive !== undefined && (
                <>
                  <dt>计划模式</dt>
                  <dd>{planActive ? '开启' : '关闭'}</dd>
                </>
              )}
              <dt>工作目录</dt>
              <dd>{data.cwd ?? '—'}</dd>
              <dt>Agent 预设</dt>
              <dd>{data.preset ?? '—'}</dd>
              <dt>Session</dt>
              <dd>{data.id ?? '—'}</dd>
            </dl>
          </div>
        </div>

        {/* ── 模型上下文清单 ───────────────────────────────────────────────── */}
        <div className="dshx-section">
          <div className="dshx-section-title">
            <span>模型上下文清单</span>
            <span className="dshx-muted">sections {sections.length} · contexts {contexts.length} · tools {tools.length}</span>
          </div>
          <div className="dshx-section-body">
            <div className="dshx-muted" style={{ marginBottom: 6 }}>System prompt 节</div>
            {sections.length === 0
              ? <div className="dshx-muted">（未获取到；宿主可能未挂载 systemPrompt）</div>
              : sections.map(section => (
                  <div className="dshx-manifest-row" key={section.name} title={section.name}>
                    <span className="dshx-manifest-name">{section.name}</span>
                    <span className="dshx-muted">{section.chars > 1024 ? `${(section.chars / 1024).toFixed(1)}k` : section.chars} 字符</span>
                  </div>
                ))}
            {contexts.length > 0 && (
              <>
                <div className="dshx-muted" style={{ margin: '8px 0 6px' }}>动态上下文</div>
                {contexts.map(context => (
                  <div className="dshx-manifest-row" key={context.name} title={context.name}>
                    <span className="dshx-manifest-name">{context.name}</span>
                    <span className="dshx-muted">{context.chars} 字符</span>
                  </div>
                ))}
              </>
            )}
            {tools.length > 0 && (
              <>
                <div className="dshx-muted" style={{ margin: '8px 0 6px' }}>工具</div>
                <div>{tools.map(tool => <span className="dshx-chip" key={tool}>{tool}</span>)}</div>
              </>
            )}
            {(data.variables ?? []).length > 0 && (
              <>
                <div className="dshx-muted" style={{ margin: '8px 0 6px' }}>提示词变量</div>
                <div>{(data.variables ?? []).map(name => <span className="dshx-chip" key={name}>{name}</span>)}</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
