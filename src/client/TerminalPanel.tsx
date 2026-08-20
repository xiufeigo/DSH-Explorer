/**
 * Bottom-of-conversation terminal: tabs + xterm. Each tab opens a PTY in
 * the current session cwd. Collapsing the panel keeps processes; closing
 * a tab terminates it.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { IconFolderClose16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { rpc } from './rpc'
import { getPrefs, resolveTermFont, resolveTermTheme, subscribePrefs, waitTermFont } from './prefs'
import { useExplorer, type ExplorerStore, type TermTab } from './store'

function applyTermLook(term: Terminal, fit: FitAddon): void {
  const prefs = getPrefs()
  term.options.fontFamily = resolveTermFont(prefs)
  term.options.fontSize = prefs.termFontSize
  term.options.fontWeight = 400
  term.options.fontWeightBold = 700
  term.options.letterSpacing = 0
  term.options.lineHeight = 1.2
  term.options.theme = resolveTermTheme(prefs)
  fit.fit()
  if (term.rows > 0) term.refresh(0, term.rows - 1)
}

async function readNdjson(
  sessionId: string,
  ptyId: string,
  onLine: (row: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/dsh-explorer/pty', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-explorer': '1' },
    body: JSON.stringify({ sessionId, id: ptyId }),
    signal,
  })
  if (!res.ok || res.body === null) {
    const text = await res.text().catch(() => '')
    throw new Error(text.length > 0 ? text : `终端流失败 (HTTP ${String(res.status)})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const next = await reader.read()
    if (next.done) break
    buf += decoder.decode(next.value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim().length === 0) continue
      try { onLine(JSON.parse(line) as Record<string, unknown>) } catch { /* skip */ }
    }
  }
}

function TermPane({ sessionId, tab, active, visible, height, onMeta }: {
  sessionId: string
  tab: TermTab
  active: boolean
  visible: boolean
  height: number
  onMeta: () => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const rec = useRef<{ term: Terminal; fit: FitAddon } | null>(null)

  useLayoutEffect(() => {
    const el = hostRef.current
    if (el === null) return
    const prefs = getPrefs()
    const term = new Terminal({
      cursorBlink: true,
      fontSize: prefs.termFontSize,
      fontFamily: resolveTermFont(prefs),
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      lineHeight: 1.2,
      theme: resolveTermTheme(prefs),
      scrollback: 4000,
      convertEol: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    rec.current = { term, fit }
    const abort = new AbortController()
    const stopPrefs = subscribePrefs(() => {
      void (async () => {
        await waitTermFont(getPrefs())
        if (abort.signal.aborted) return
        applyTermLook(term, fit)
      })()
    })

    const start = async (): Promise<void> => {
      try { await waitTermFont(getPrefs()) } catch { /* ignore */ }
      if (abort.signal.aborted) return
      applyTermLook(term, fit)
      const cols = Math.max(20, term.cols)
      const rows = Math.max(8, term.rows)
      const res = await rpc<{ id?: string; title?: string; error?: string }>(sessionId, 'pty.open', { cols, rows })
      if (abort.signal.aborted) {
        if (typeof res.id === 'string') void rpc(sessionId, 'pty.close', { id: res.id })
        return
      }
      if (res.error !== undefined || typeof res.id !== 'string') {
        tab.error = res.error ?? '无法打开终端'
        term.writeln(`\r\n\x1b[31m${tab.error}\x1b[0m`)
        onMeta()
        return
      }
      tab.ptyId = res.id
      if (typeof res.title === 'string' && res.title.length > 0) tab.title = res.title
      onMeta()
      term.onData(data => {
        if (tab.ptyId !== null) void rpc(sessionId, 'pty.write', { id: tab.ptyId, data })
      })
      try {
        await readNdjson(sessionId, res.id, row => {
          if (row.t === 'out' && typeof row.d === 'string') term.write(row.d)
          if (row.t === 'err' && typeof row.m === 'string') term.writeln(`\r\n\x1b[31m${row.m}\x1b[0m`)
          if (row.t === 'exit') term.writeln('\r\n\x1b[90m[进程已结束]\x1b[0m')
        }, abort.signal)
      } catch (error) {
        if (abort.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('abort')) return
        term.writeln(`\r\n\x1b[31m${message}\x1b[0m`)
      }
    }
    void start()

    return () => {
      abort.abort()
      stopPrefs()
      const ptyId = tab.ptyId
      if (ptyId !== null) void rpc(sessionId, 'pty.close', { id: ptyId })
      tab.ptyId = null
      term.dispose()
      rec.current = null
    }
  }, [sessionId, tab.localId])

  useLayoutEffect(() => {
    if (!active || !visible) return
    const current = rec.current
    if (current === null) return
    current.fit.fit()
    current.term.focus()
  }, [active, visible, height])

  return (
    <div
      className="dshx-term-view"
      hidden={!active}
      ref={hostRef}
      onMouseDown={() => { rec.current?.term.focus() }}
    />
  )
}

export function TerminalPanel({ sessionId, store }: { sessionId: string; store: ExplorerStore }): JSX.Element | null {
  useExplorer(store)
  const drag = useRef<{ startY: number; startH: number } | null>(null)
  const bag = store.termBag(sessionId)
  const visible = store.terminalOn

  useEffect(() => {
    if (!visible) return
    if (bag.tabs.length > 0) return
    store.addTermTab(sessionId)
  }, [visible, sessionId, bag.tabs.length, store])

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (drag.current === null) return
      store.setTerminalHeight(drag.current.startH + (drag.current.startY - event.clientY))
    }
    const onUp = (): void => { drag.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [store])

  if (!visible && bag.tabs.length === 0) return null

  const addTab = (): void => { store.addTermTab(sessionId) }

  const closeTab = (localId: string, event: { preventDefault(): void; stopPropagation(): void }): void => {
    event.preventDefault()
    event.stopPropagation()
    store.closeTermTab(sessionId, localId)
  }

  return (
    <div
      className={`dshx-term-panel${visible ? '' : ' off'}`}
      style={visible ? { height: store.terminalHeight } : undefined}
    >
      <div
        className="dshx-term-grip"
        onPointerDown={event => {
          event.preventDefault()
          drag.current = { startY: event.clientY, startH: store.terminalHeight }
        }}
      />
      <div className="dshx-term-tabs" role="tablist" aria-label="终端">
        {bag.tabs.map(tab => (
          <button
            key={tab.localId}
            type="button"
            role="tab"
            className={`dshx-term-tab${bag.active === tab.localId ? ' on' : ''}`}
            aria-selected={bag.active === tab.localId}
            title={tab.title}
            onClick={() => { store.setTermActive(sessionId, tab.localId) }}
          >
            <IconFolderClose16 className="dshx-term-tab-icon" />
            <span className="dshx-term-tab-label">{tab.title}</span>
            <span
              className="dshx-term-tab-x"
              role="button"
              tabIndex={0}
              title="关闭"
              onClick={event => { closeTab(tab.localId, event) }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  closeTab(tab.localId, event)
                }
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button type="button" className="dshx-term-plus" title="新建终端" onClick={addTab}>+</button>
      </div>
      <div className="dshx-term-body">
        {bag.tabs.map(tab => (
          <TermPane
            key={tab.localId}
            sessionId={sessionId}
            tab={tab}
            active={bag.active === tab.localId}
            visible={visible}
            height={store.terminalHeight}
            onMeta={() => { store.touch() }}
          />
        ))}
      </div>
    </div>
  )
}

