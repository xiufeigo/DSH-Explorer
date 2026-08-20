/**
 * Workspace | Files toggle.
 *
 * Prefers the workspace browse header (same row as search / filter).
 * The Web fork seat adds a placeholder row that CSS hides; Desktop / unforked
 * builds only have footer.action, which uses the same portal so the tabs do
 * not land above the settings button.
 *
 * The official collapsed rail is a 56px icon column. Tabs show only while
 * the sidebar is wide; folding it removes the portal and injected host.
 */

import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useExplorer, type ExplorerStore } from './store'

export interface FilesToggleProps {
  /** Sidebar shell fold: false = 56px icon rail. */
  wide?: boolean
  store: ExplorerStore
  toggleFiles(): void
  /** True while the top seat is active (footer fallback hides itself). */
  filesToggleHidden?: () => boolean
}

function ModeTabs({ filesMode, onToggle }: { filesMode: boolean; onToggle(): void }): JSX.Element {
  return (
    <div className="dshx-sidebar-tabs" role="tablist" aria-label="侧栏模式">
      <button
        type="button"
        role="tab"
        className={`dshx-sidebar-tab${filesMode ? '' : ' on'}`}
        aria-selected={!filesMode}
        title="工作区"
        onClick={() => { if (filesMode) onToggle() }}
      >
        工作区
      </button>
      <span className="dshx-sidebar-tab-sep" aria-hidden="true">|</span>
      <button
        type="button"
        role="tab"
        className={`dshx-sidebar-tab${filesMode ? ' on' : ''}`}
        aria-selected={filesMode}
        title="文件"
        onClick={() => { if (!filesMode) onToggle() }}
      >
        文件
      </button>
    </div>
  )
}

/** File panel ships its own mount; otherwise take the native browse header. */
function resolveTabsHost(): HTMLElement | null {
  const slot = document.querySelector('[data-dshx-tabs-slot]')
  if (slot instanceof HTMLElement) return slot
  const region = document.querySelector('[data-slot="sidebar.workspaces"]')
  if (!(region instanceof HTMLElement)) return null
  const header = region.querySelector('[class*="sectionHeader"]')
    ?? region.firstElementChild?.firstElementChild
    ?? region.firstElementChild
  if (!(header instanceof HTMLElement)) return null
  const existing = header.querySelector('[data-dshx-tabs-host]')
  if (existing instanceof HTMLElement) return existing
  const host = document.createElement('div')
  host.setAttribute('data-dshx-tabs-host', '')
  host.className = 'dshx-sidebar-tabs-host'
  header.insertBefore(host, header.firstChild)
  return host
}

/** Drop only the host we injected into the native header, not the file-panel slot. */
function removeInjectedTabsHost(): void {
  document.querySelectorAll('[data-dshx-tabs-host]').forEach((node) => {
    node.remove()
  })
}

export function FilesToggle({ store: storeHandle, toggleFiles, filesToggleHidden, wide = true }: FilesToggleProps): JSX.Element | null {
  const store = useExplorer(storeHandle)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const isFooterFallback = filesToggleHidden !== undefined
  const hiddenByTopSeat = filesToggleHidden?.() === true
  const showTabs = wide && !hiddenByTopSeat

  useLayoutEffect(() => {
    // The footer instance must not tear down the header host while the top seat is live.
    if (hiddenByTopSeat) return
    if (!wide) {
      setHost(null)
      removeInjectedTabsHost()
      return
    }
    const bind = (): void => { setHost(resolveTabsHost()) }
    bind()
    const root = document.querySelector('[data-slot="sidebar.workspaces"]')
      ?? document.querySelector('[data-slot="sidebar"]')
      ?? document.body
    const observer = new MutationObserver(bind)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [wide, hiddenByTopSeat, store.filesMode])

  // 顶部座位随宽栏一起卸掉时，把头栏里插入的 host 带走。
  useLayoutEffect(() => {
    if (isFooterFallback) return
    return () => { removeInjectedTabsHost() }
  }, [isFooterFallback])

  if (!showTabs) {
    return isFooterFallback ? null : <span className="dshx-sidebar-tabs-anchor" hidden />
  }

  const tabs = <ModeTabs filesMode={store.filesMode} onToggle={toggleFiles} />

  if (host !== null) {
    return (
      <>
        <span className="dshx-sidebar-tabs-anchor" hidden />
        {createPortal(tabs, host)}
      </>
    )
  }

  if (isFooterFallback) return tabs
  return <span className="dshx-sidebar-tabs-anchor" hidden />
}
