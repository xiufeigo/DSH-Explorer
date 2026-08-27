/**
 * Session-header control that opens and closes the details column.
 * Always pinned on header.utilities; highlighted while the column is open.
 */

import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useExplorer, type ExplorerStore } from './store'
import { closeNarrowOverlay, narrowNow } from './narrowPanel'

export interface PanelToggleProps {
  store: ExplorerStore
  openDetails(): void
  closeDetails(): void
}

export function PanelToggle({ store: storeHandle, openDetails, closeDetails }: PanelToggleProps): JSX.Element {
  const store = useExplorer(storeHandle)
  const open = store.panelOpen || store.overlayOpen
  const toggle = (): void => {
    // 窄屏：右侧栏替换主会话区域。
    if (narrowNow()) {
      if (store.overlayOpen) {
        closeNarrowOverlay(store)
        store.setPanelIntent(false)
      } else {
        store.setPanelIntent(true)
        openDetails()
      }
      return
    }
    if (open) {
      closeDetails()
      store.setPanelIntent(false)
      store.setPanelOpen(false)
      return
    }
    store.setPanelIntent(true)
    store.setPanelOpen(true)
    openDetails()
  }
  return (
    <button
      type="button"
      className={`dshx-panel-toggle${open ? ' on' : ''}`}
      onClick={toggle}
      title={open ? '收起右侧栏' : '打开审查 / 上下文面板'}
      aria-pressed={open}
    >
      <IconPanelLeftOutline16 className="dshx-panel-toggle-icon" />
    </button>
  )
}
