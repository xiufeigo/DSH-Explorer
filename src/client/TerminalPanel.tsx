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

function TermPane({ sessionId, tab, active, visible, height, onMeta, onDropped }: {
  sessionId: string
  tab: TermTab
  active: boolean
  visible: boolean
  height: number
  onMeta: () => void
  /** 宿主 overflow 事件：累计丢弃帧数（累计进 store，仅增长）。 */
  onDropped: (dropped: number) => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const rec = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const refitRef = useRef<(() => void) | null>(null)

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
    // 键盘输入只注册一次：读写都走 tab.ptyId 当前值，重挂流/新开都复用
    // （若随 attach 注册，重挂失败转新开时会叠两份导致输入翻倍）。
    term.onData(data => {
      if (tab.ptyId !== null) void rpc(sessionId, 'pty.write', { id: tab.ptyId, data })
    })

    // ── 尺寸同步（B1）：容器几何变化 → 本地 fit + 上报宿主 pty.resize。
    // 宿主没有该方法（旧版）或连续失败时静默降级为纯本地 xterm resize。
    let resizeFailStreak = 0
    let lastPtyId: string | null = null
    let lastCols = term.cols
    let lastRows = term.rows
    const reportSize = (): void => {
      if (abort.signal.aborted) return
      const ptyId = tab.ptyId
      if (ptyId === null) return
      if (ptyId !== lastPtyId) {
        lastPtyId = ptyId
        resizeFailStreak = 0
      }
      if (term.cols === lastCols && term.rows === lastRows) return
      const cols = term.cols
      const rows = term.rows
      lastCols = cols
      lastRows = rows
      if (resizeFailStreak >= 3) return
      void rpc(sessionId, 'pty.resize', { id: ptyId, cols, rows }).then(res => {
        if (res.error === undefined) {
          resizeFailStreak = 0
          return
        }
        resizeFailStreak += 1
        // 发送失败的尺寸不算已同步：回滚基线（基线仍指向本次失败值时），
        // 尺寸未再变时下一次 reportSize 仍会重试；连续 3 次失败后停发降级。
        if (lastCols === cols && lastRows === rows && resizeFailStreak < 3) {
          lastCols = -1
          lastRows = -1
        }
      })
    }
    const refit = (): void => {
      if (abort.signal.aborted) return
      try { fit.fit() } catch { /* 容器不可见时量不出尺寸 */ }
      reportSize()
    }
    refitRef.current = refit
    let resizeRaf = 0
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          // 隐藏（display:none）的窗格宽为 0：跳过，重新可见时 ResizeObserver 会再触发。
          if (resizeRaf !== 0 || el.offsetWidth === 0) return
          resizeRaf = requestAnimationFrame(() => {
            resizeRaf = 0
            refit()
          })
        })
      : null
    ro?.observe(el)

    // ── 流静默中断重连（B3）：readNdjson 正常结束却没见到 exit 行 =
    // 连接被代理/宿主重启掐断。提示后指数退避重挂，不静默吞掉。
    let reconnectAttempts = 0
    let reconnectTimer: number | null = null
    const scheduleReconnect = (): void => {
      if (abort.signal.aborted || reconnectTimer !== null) return
      if (reconnectAttempts >= 5) {
        term.writeln('\r\n\x1b[31m[连接已断开] 自动重连未成功，可关闭该标签后重新打开\x1b[0m')
        return
      }
      const delay = Math.min(15000, 1000 * 2 ** reconnectAttempts)
      reconnectAttempts += 1
      term.writeln(`\r\n\x1b[33m[连接中断] ${String(Math.round(delay / 1000))} 秒后重连…\x1b[0m`)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        if (abort.signal.aborted) return
        const id = tab.ptyId
        if (id === null) return
        // 重挂成功后 fit 重同步一次（断流期间窗口可能已变，PTY 内核尺寸需追平）。
        void attach(id).then(ok => { if (ok) refit() })
      }, delay)
    }

    /** 挂流到既有进程：只接 NDJSON 输出，不重新 pty.open。返回是否挂成功。 */
    const attach = async (ptyId: string): Promise<boolean> => {
      let sawExit = false
      try {
        await readNdjson(sessionId, ptyId, row => {
          if (reconnectAttempts !== 0) reconnectAttempts = 0 // 收到任何行都证明连接活着
          if (row.t === 'out' && typeof row.d === 'string') term.write(row.d)
          if (row.t === 'err' && typeof row.m === 'string') term.writeln(`\r\n\x1b[31m${row.m}\x1b[0m`)
          if (row.t === 'overflow' && typeof row.dropped === 'number' && row.dropped > 0) {
            onDropped(row.dropped)
            term.writeln(`\r\n\x1b[33m[输出过快，已丢弃 ${String(row.dropped)} 帧]\x1b[0m`)
          }
          if (row.t === 'exit') {
            sawExit = true
            term.writeln('\r\n\x1b[90m[进程已结束]\x1b[0m')
            // 进程已退出：清掉 ptyId 并 touch，避免重挂载时去挂一条死流
            if (tab.ptyId !== null) {
              tab.ptyId = null
              onMeta()
            }
          }
        }, abort.signal)
        // 流结束但进程没退出 = 静默断连，安排重连（abort 时无需）。
        if (!sawExit && !abort.signal.aborted) scheduleReconnect()
        return true
      } catch (error) {
        if (abort.signal.aborted) return false
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('abort')) return false
        term.writeln(`\r\n\x1b[31m${message}\x1b[0m`)
        return false
      }
    }

    const start = async (): Promise<void> => {
      try { await waitTermFont(getPrefs()) } catch { /* ignore */ }
      if (abort.signal.aborted) return
      applyTermLook(term, fit)
      const cols = Math.max(20, term.cols)
      const rows = Math.max(8, term.rows)
      // 切会话/卸载不杀进程（termBags 按会话持久）：重挂载时 ptyId 还在就直接
      // 把流挂回既有进程，不重新 pty.open。
      const existing = tab.ptyId
      if (existing !== null) {
        if (await attach(existing)) {
          reportSize() // 重挂后把当前尺寸同步给 PTY（卸载期间窗口可能已变）
          return
        }
        if (abort.signal.aborted) return
        // 挂流失败（宿主重启后进程被回收等）：清掉死 id，落到下面新开
        tab.ptyId = null
        onMeta()
      }
      const res = await rpc<{ id?: string; title?: string; error?: string }>(sessionId, 'pty.open', { cols, rows })
      if (abort.signal.aborted) {
        // 已卸载也不杀刚开出的进程：记下 ptyId 保活，重挂载可挂回（宿主闲置回收兜底）
        if (typeof res.id === 'string' && tab.ptyId === null) {
          tab.ptyId = res.id
          onMeta()
        }
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
      void attach(res.id)
    }
    void start()

    return () => {
      abort.abort()
      stopPrefs()
      ro?.disconnect()
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf)
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      refitRef.current = null
      // 卸载/切会话不发 pty.close：仅断流、销毁 xterm。ptyId 保留在 store，
      // 重挂载时重新挂流；仅用户点 ✕ 关 tab（closeTab 路径）才杀进程。
      // 孤儿进程由宿主 10 分钟闲置回收兜底。
      term.dispose()
      rec.current = null
    }
  }, [sessionId, tab.localId])

  useLayoutEffect(() => {
    if (!active || !visible) return
    // 切换标签 / 展开面板 / 拖高度后重 fit，并把新尺寸上报宿主（B1）。
    refitRef.current?.()
    rec.current?.term.focus()
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
    // 正常松手与异常结束（pointercancel / 窗口失焦）同样收尾：落盘并提交高度
    const finish = (): void => {
      if (drag.current !== null) {
        drag.current = null
        store.commitTerminalHeight()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
    }
  }, [store])

  if (!visible && bag.tabs.length === 0) return null

  const addTab = (): void => { store.addTermTab(sessionId) }
  const activeTab = bag.tabs.find(tab => tab.localId === bag.active)

  const closeTab = (localId: string, event: { preventDefault(): void; stopPropagation(): void }): void => {
    event.preventDefault()
    event.stopPropagation()
    // 只有用户点 ✕ 关 tab 才杀进程；卸载/切会话保活（见 TermPane 清理注释）
    const target = store.termBag(sessionId).tabs.find(t => t.localId === localId)
    if (target !== undefined && target.ptyId !== null) {
      const ptyId = target.ptyId
      target.ptyId = null
      void rpc(sessionId, 'pty.close', { id: ptyId })
    }
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
          // 指针捕获：指针移出把手也不丢 move/up；捕获失败退回 window 监听兜底
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
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
        {activeTab !== undefined && activeTab.dropped > 0
          ? (
            <div className="dshx-term-overflow" role="status">
              输出过快，已丢弃 {String(activeTab.dropped)} 帧（慢客户端积压超限时宿主丢最旧输出）
            </div>
          )
          : null}
        {bag.tabs.map(tab => (
          <TermPane
            key={tab.localId}
            sessionId={sessionId}
            tab={tab}
            active={bag.active === tab.localId}
            visible={visible}
            height={store.terminalHeight}
            onMeta={() => { store.touch() }}
            onDropped={dropped => { store.setTermDropped(sessionId, tab.localId, dropped) }}
          />
        ))}
      </div>
    </div>
  )
}

