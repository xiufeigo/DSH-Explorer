/**
 * Conversation outline on the left of the chat column.
 * Ticks are equal length at rest and only grow under the pointer (or its hover card).
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

/** Resting tick ≈ half of the old shortest (8px) bar. Hover is the only grow. */
const TICK_IDLE = 4
const TICK_HOVER = 24

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

  const rail = (
    <nav className="dshx-msg-rail" aria-label="会话消息大纲">
      {items.map((item, index) => {
        const hot = hover?.key === item.key
        const width = hot ? TICK_HOVER : TICK_IDLE
        return (
          <button
            key={item.key}
            type="button"
            className={`dshx-msg-tick${hot ? ' hot' : ''}`}
            aria-current={active === item.key ? 'true' : undefined}
            aria-label={`第 ${index + 1} 条：${item.title}`}
            onMouseEnter={event => openHover(item.key, event.currentTarget)}
            onMouseLeave={scheduleLeave}
            onFocus={event => openHover(item.key, event.currentTarget)}
            onBlur={scheduleLeave}
            onClick={() => { scrollToChatKey(item.key) }}
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
