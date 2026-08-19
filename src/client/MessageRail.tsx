/**
 * 中栏左侧会话大纲：贴对话列左缘，刻度左对齐（变长往右长），簇在可视区域垂直居中。
 * 悬停弹出 Codex 风格卡片（标题 / 摘要 / 已处理时长），点击跳转对应气泡。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ensureHost, flattenContent, formatProcessed, scrollToChatKey } from './conversationHost'

interface ChatNodeLike {
  key?: string
  kind?: string
  data?: {
    content?: unknown
    time?: number
    blocks?: unknown
    closing?: { blocks?: unknown; time?: number }
  }
}

interface ChatSnapshotLike {
  order?: readonly string[]
  nodes?: { get(key: string): ChatNodeLike | undefined }
}

export interface MessageRailProps {
  sessionId: string
  useSession: (selector: (snapshot: { chat: ChatSnapshotLike }) => unknown) => any
}

interface RailItem {
  key: string
  title: string
  body: string
  durationMs: number | null
  running: boolean
  tick: number
}

interface HoverState {
  key: string
  top: number
  left: number
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1)).trim()}…`
}

function nodeText(node: ChatNodeLike | undefined): string {
  if (node === undefined) return ''
  const data = node.data
  const fromContent = flattenContent(data?.content).trim()
  if (fromContent.length > 0) return fromContent
  const blocks = data?.blocks ?? data?.closing?.blocks
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const kind = (block as { kind?: string; type?: string }).kind ?? (block as { type?: string }).type
    if (kind !== 'text') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text.trim().length > 0) parts.push(text)
  }
  return parts.join('\n').trim()
}

function splitCopy(text: string): { title: string; body: string } {
  const lines = text.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).filter(line => line.length > 0)
  if (lines.length >= 2) {
    return { title: clip(lines[0], 48), body: lines.slice(1).join(' ').replace(/\s+/g, ' ').trim() }
  }
  const compact = (lines[0] ?? text).replace(/\s+/g, ' ').trim()
  if (compact.length <= 48) return { title: compact, body: '' }
  const sentence = compact.match(/^(.{12,48}?[。！？.!?])\s+(.*)$/)
  if (sentence !== null) return { title: sentence[1], body: sentence[2] }
  return { title: clip(compact, 48), body: compact.slice(48).trim() }
}

function tickWidth(text: string): number {
  const n = text.length
  if (n < 24) return 8
  if (n < 80) return 10
  if (n < 180) return 12
  return 14
}

/** Codex 式鱼眼：焦点拉最长，邻近 1～3 格跟着鼓一点。 */
function tickBoost(distance: number): number {
  if (distance === 0) return 20
  if (distance === 1) return 9
  if (distance === 2) return 5
  if (distance === 3) return 2
  return 0
}

function collectItems(chat: ChatSnapshotLike): RailItem[] {
  const order = chat.order ?? []
  const nodes = chat.nodes
  if (nodes === undefined) return []
  const users: Array<{ key: string; index: number; text: string; time: number }> = []
  for (let index = 0; index < order.length; index++) {
    const node = nodes.get(order[index])
    if (node === undefined) continue
    if (node.kind !== 'user' && node.kind !== 'steering') continue
    const text = nodeText(node)
    if (text.length === 0) continue
    users.push({
      key: node.key ?? order[index],
      index,
      text,
      time: typeof node.data?.time === 'number' ? node.data.time : 0,
    })
  }
  return users.map((user, slot) => {
    const nextIndex = users[slot + 1]?.index ?? order.length
    let tailTime: number | null = null
    let assistant = ''
    let sawAssistant = false
    for (let i = user.index + 1; i < nextIndex; i++) {
      const node = nodes.get(order[i])
      if (node === undefined) continue
      if (node.kind === 'turn-tail') {
        const time = typeof node.data?.time === 'number' ? node.data.time : 0
        if (time > 0) tailTime = time
        if (assistant.length === 0) assistant = nodeText(node)
      } else if (node.kind === 'assistant') {
        sawAssistant = true
        if (assistant.length === 0) assistant = nodeText(node)
        const time = typeof node.data?.time === 'number' ? node.data.time : 0
        if (tailTime === null && time > 0) tailTime = time
      }
    }
    const copy = splitCopy(user.text)
    const body = copy.body.length > 0 ? copy.body : assistant.replace(/\s+/g, ' ').trim()
    const durationMs = user.time > 0 && tailTime !== null && tailTime >= user.time
      ? tailTime - user.time
      : null
    return {
      key: user.key,
      title: copy.title,
      body,
      durationMs,
      running: sawAssistant === false && durationMs === null,
      tick: tickWidth(user.text),
    }
  })
}

export function MessageRail({ sessionId, useSession }: MessageRailProps): JSX.Element | null {
  const chat = (useSession((snapshot: { chat: ChatSnapshotLike }) => snapshot.chat) as ChatSnapshotLike | undefined) ?? {}
  const items = useMemo(() => collectItems(chat), [chat.order, chat.nodes])
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const leaveTimer = useRef<number>(0)

  useLayoutEffect(() => {
    const bind = (): void => { setHost(ensureHost('data-dshx-msg-rail-host', 'dshx-msg-rail-host')) }
    bind()
    const timer = window.setInterval(() => {
      if (document.querySelector('[data-dshx-msg-rail-host]') === null) bind()
    }, 800)
    return () => window.clearInterval(timer)
  }, [sessionId])

  useEffect(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (!(scroller instanceof HTMLElement) || items.length === 0) return
    const keys = new Set(items.map(item => item.key))
    const visible = new Map<string, number>()
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.chatAnchorKey
        if (key === undefined || !keys.has(key)) continue
        if (entry.isIntersecting) visible.set(key, entry.intersectionRatio)
        else visible.delete(key)
      }
      let best: string | null = null
      let bestRatio = 0
      for (const [key, ratio] of visible) {
        if (ratio >= bestRatio) {
          best = key
          bestRatio = ratio
        }
      }
      if (best !== null) setActive(best)
    }, { root: scroller, threshold: [0.12, 0.4, 0.75] })
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
      if (keys.has(row.dataset.chatAnchorKey ?? '')) io.observe(row)
    }
    return () => io.disconnect()
  }, [items, sessionId])

  useEffect(() => {
    if (hover === null) return
    const scroller = document.querySelector('[data-conversation-scroll]')
    const hide = (): void => setHover(null)
    scroller?.addEventListener('scroll', hide, { passive: true })
    window.addEventListener('resize', hide)
    return () => {
      scroller?.removeEventListener('scroll', hide)
      window.removeEventListener('resize', hide)
    }
  }, [hover])

  const clearLeave = (): void => {
    if (leaveTimer.current !== 0) {
      window.clearTimeout(leaveTimer.current)
      leaveTimer.current = 0
    }
  }

  const openHover = (key: string, target: HTMLElement): void => {
    clearLeave()
    const rect = target.getBoundingClientRect()
    const width = 292
    const left = Math.min(rect.right + 10, window.innerWidth - width - 12)
    const top = Math.max(8, Math.min(rect.top - 10, window.innerHeight - 180))
    setHover({ key, top, left: Math.max(8, left) })
  }

  const scheduleLeave = (): void => {
    clearLeave()
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = 0
      setHover(null)
    }, 140)
  }

  const hovered = hover === null ? undefined : items.find(item => item.key === hover.key)
  const focusKey = hover?.key ?? active
  const focusIndex = focusKey === null ? -1 : items.findIndex(item => item.key === focusKey)

  const rail = (
    <nav className="dshx-msg-rail" aria-label="会话消息大纲">
      {items.map((item, index) => {
        const on = focusKey === item.key
        const width = item.tick + (focusIndex < 0 ? 0 : tickBoost(Math.abs(index - focusIndex)))
        return (
          <button
            key={item.key}
            type="button"
            className={`dshx-msg-tick${on ? ' on' : ''}`}
            aria-label={`第 ${index + 1} 条：${item.title}`}
            onMouseEnter={event => openHover(item.key, event.currentTarget)}
            onMouseLeave={scheduleLeave}
            onFocus={event => openHover(item.key, event.currentTarget)}
            onBlur={scheduleLeave}
            onClick={() => {
              setHover(null)
              scrollToChatKey(item.key)
            }}
          >
            <span className="dshx-msg-tick-bar" style={{ width }} />
          </button>
        )
      })}
    </nav>
  )

  const card = hovered !== undefined && hover !== null
    ? createPortal(
      <div
        className="dshx-msg-card"
        style={{ top: hover.top, left: hover.left }}
        onMouseEnter={clearLeave}
        onMouseLeave={scheduleLeave}
        onClick={() => {
          setHover(null)
          scrollToChatKey(hovered.key)
        }}
      >
        <div className="dshx-msg-card-title">{hovered.title}</div>
        {hovered.body.length > 0 && <div className="dshx-msg-card-body">{hovered.body}</div>}
        <div className="dshx-msg-card-foot">
          <span>
            {hovered.durationMs !== null
              ? `已处理 ${formatProcessed(hovered.durationMs)}`
              : hovered.running ? '处理中' : '跳转到消息'}
          </span>
          <span className="dshx-msg-card-go" aria-hidden>›</span>
        </div>
      </div>,
      document.body,
    )
    : null

  if (host === null) return null
  return (
    <>
      {createPortal(rail, host)}
      {card}
    </>
  )
}
