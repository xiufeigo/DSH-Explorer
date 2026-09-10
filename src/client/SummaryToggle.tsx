/**
 * Session-header pinned-summary toggle.
 * When the center column can fit the message list plus the card, the summary
 * docks to the right of the conversation and an outside click does not dismiss
 * it. When the column is too narrow (including after details opens), it
 * collapses to a button; the float closes on outside click or Escape.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { canPinSummary, conversationScroll, ensureHost } from './conversationHost'
import { IconSummary16 } from './headerIcons'
import { SummaryCard } from './SummaryCard'
import { useSessionHint, useExplorer, type ExplorerStore } from './store'

export interface SummaryToggleProps {
  sessionId: string
  useSessions?: (selector: (state: any) => unknown) => any
  store: ExplorerStore
  openDetails(): void
}

function eventInsideSummary(event: Event, btn: HTMLElement | null): boolean {
  const node = event.target
  if (!(node instanceof Node)) return false
  if (btn?.contains(node) === true) return true
  if (!(node instanceof Element)) return false
  return node.closest('.dshx-summary, .dshx-summary-float, .dshx-summary-pin') !== null
}

export function SummaryToggle({
  sessionId, useSessions, store: storeHandle, openDetails,
}: SummaryToggleProps): JSX.Element {
  const store = useExplorer(storeHandle)
  // 右栏关闭时 ExplorerPanel 不挂载；这里持续回报当前会话，
  // 保证面板开合的按会话记忆写对目标。
  useSessionHint(store, sessionId)
  const btnRef = useRef<HTMLButtonElement>(null)
  const floatRef = useRef<HTMLDivElement>(null)
  const wasWide = useRef(false)
  const [wide, setWide] = useState(false)
  const [pinHost, setPinHost] = useState<HTMLElement | null>(null)
  const [floatPos, setFloatPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    const bind = (): void => {
      const scroller = conversationScroll()
      setWide(canPinSummary(scroller, store.panelOpen))
      setPinHost(ensureHost('data-dshx-summary-host', 'dshx-summary-host'))
    }
    bind()
    const scroller = conversationScroll()
    if (scroller === null || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const observer = new ResizeObserver(() => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        bind()
      })
    })
    observer.observe(scroller)
    return () => {
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [sessionId, store.panelOpen])

  useEffect(() => {
    if (wasWide.current && !wide && store.summaryOn) store.setSummaryFloat(true)
    if (wide && store.summaryFloat) store.setSummaryFloat(false)
    wasWide.current = wide
  }, [wide, store, store.summaryOn, store.summaryFloat])

  const showPin = store.summaryOn && wide
  const showFloat = store.summaryOn && !wide && store.summaryFloat

  useLayoutEffect(() => {
    if (!showFloat) {
      setFloatPos(null)
      return
    }
    const btn = btnRef.current
    if (btn === null) return
    const rect = btn.getBoundingClientRect()
    setFloatPos({
      top: Math.round(rect.bottom + 8),
      right: Math.round(window.innerWidth - rect.right),
    })
  }, [showFloat])

  useEffect(() => {
    if (!showFloat) return
    const dismiss = (): void => store.setSummaryFloat(false)
    const onDown = (event: Event): void => {
      if (eventInsideSummary(event, btnRef.current)) return
      if (floatRef.current?.contains(event.target as Node) === true) return
      dismiss()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [showFloat, store])

  const toggle = (): void => {
    if (wide) {
      store.setSummaryOn(!store.summaryOn)
      return
    }
    if (!store.summaryOn) {
      store.setSummaryOn(true)
      store.setSummaryFloat(true)
      return
    }
    store.setSummaryFloat(!store.summaryFloat)
  }

  const card = (
    <SummaryCard
      sessionId={sessionId}
      store={store}
      openDetails={openDetails}
      useSessions={useSessions}
      onNavigate={() => { if (!wide) store.setSummaryFloat(false) }}
    />
  )

  const pressed = store.summaryOn && (wide || store.summaryFloat)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`dshx-panel-toggle${pressed ? ' on' : ''}`}
        title={wide ? (store.summaryOn ? '收起置顶摘要' : '置顶摘要') : '摘要'}
        aria-pressed={pressed}
        onClick={toggle}
      >
        <IconSummary16 />
      </button>
      {showPin && pinHost !== null ? createPortal(
        <div className="dshx-summary-pin">{card}</div>,
        pinHost,
      ) : null}
      {showFloat && floatPos !== null ? createPortal(
        <div
          ref={floatRef}
          className="dshx-summary-float"
          style={{ top: floatPos.top, right: floatPos.right }}
        >
          {card}
        </div>,
        document.body,
      ) : null}
    </>
  )
}
