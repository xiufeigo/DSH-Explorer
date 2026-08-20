/**
 * Session-header control that opens and closes the details column.
 * Always pinned on header.utilities; highlighted while the column is open.
 */

import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useExplorer, type ExplorerStore } from './store'

export interface PanelToggleProps {
  store: ExplorerStore
  openDetails(): void
  closeDetails(): void
}

export function PanelToggle({ store: storeHandle, openDetails, closeDetails }: PanelToggleProps): JSX.Element {
  const store = useExplorer(storeHandle)
  const open = store.panelOpen
  const toggle = (): void => {
    if (open) {
      closeDetails()
      store.setPanelOpen(false)
      return
    }
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
