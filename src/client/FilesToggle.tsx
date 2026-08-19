/**
 * 「工作区 | 文件」切换。
 *
 * 优先画进工作区浏览头栏左侧（与搜索/筛选同一行）。
 * Web 的 fork 座位会多出一行，用锚点 CSS 藏掉；桌面/未 fork 只有
 * footer.action，也走同一个 portal，避免 tab 掉在设置按钮上面。
 *
 * 官方收起轨是 56px 图标列（搜索 / 新建工作区）。tab 只在宽栏出现；
 * 缩起来后卸掉 portal 和插入的 host，把头栏还给原生。
 */

import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useExplorer, type ExplorerStore } from './store'

export interface FilesToggleProps {
  /** 侧栏外壳 fold 状态：false = 56px 图标轨。 */
  wide?: boolean
  explorer: {
    store: ExplorerStore
    toggle(): void
    /** 顶部座位已激活时返回 true（底部回退按钮据此隐藏自己）。 */
    hidden?: () => boolean
  }
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

/** 文件面板自带挂载点；否则取原生浏览区头栏，并插入 host。 */
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

/** 只卸插件插进原生头栏的 host，不动文件面板里 React 管的 slot。 */
function removeInjectedTabsHost(): void {
  document.querySelectorAll('[data-dshx-tabs-host]').forEach((node) => {
    node.remove()
  })
}

export function FilesToggle({ explorer, wide = true }: FilesToggleProps): JSX.Element | null {
  const store = useExplorer(explorer.store)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const isFooterFallback = explorer.hidden !== undefined
  const hiddenByTopSeat = explorer.hidden?.() === true
  const showTabs = wide && !hiddenByTopSeat

  useLayoutEffect(() => {
    // 顶部座位活着时底部实例必须放手，不能把头顶栏的 host 拆掉。
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

  const tabs = <ModeTabs filesMode={store.filesMode} onToggle={explorer.toggle} />

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
