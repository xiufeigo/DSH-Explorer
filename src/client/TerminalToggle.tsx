/**
 * Session-header control for the bottom terminal (Codex dock semantics).
 * The toggle stays on header.utilities; the panel portals under the conversation.
 */

import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ensureTermHost } from './conversationHost'
import { TerminalPanel } from './TerminalPanel'
import { useExplorer, type ExplorerStore } from './store'

export interface TerminalToggleProps {
  sessionId: string
  store: ExplorerStore
}

export function TerminalToggle({ sessionId, store: storeHandle }: TerminalToggleProps): JSX.Element {
  const store = useExplorer(storeHandle)
  const [host, setHost] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const bind = (): void => { setHost(ensureTermHost()) }
    bind()
    const timer = window.setInterval(() => {
      if (document.querySelector('[data-dshx-term-host]') === null) bind()
    }, 800)
    return () => window.clearInterval(timer)
  }, [sessionId])

  const panel = host !== null
    ? createPortal(
      <TerminalPanel sessionId={sessionId} store={store} />,
      host,
    )
    : null

  return (
    <>
      <button
        type="button"
        className={`dshx-panel-toggle${store.terminalOn ? ' on' : ''}`}
        onClick={() => { store.setTerminalOn(!store.terminalOn) }}
        title={store.terminalOn ? '收起终端' : '打开终端'}
        aria-pressed={store.terminalOn}
      >
        <IconPanelLeftOutline16 className="dshx-term-toggle-icon" />
      </button>
      {panel}
    </>
  )
}
