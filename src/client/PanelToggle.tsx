/**
 * 会话头部右上角：右侧栏开关（原生"收起侧栏"同款 iconButton 风格）。
 * 始终钉在 header.utilities，开合不换位置；打开时高亮，再点即收起。
 */

import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useExplorer, type ExplorerStore } from './store'

interface LayoutFace {
  openDetails(): void
  closeDetails(): void
}

export interface PanelToggleProps {
  explorer: { store: ExplorerStore; layout: LayoutFace }
}

export function PanelToggle({ explorer }: PanelToggleProps): JSX.Element {
  const store = useExplorer(explorer.store)
  const open = store.panelOpen
  const toggle = (): void => {
    if (open) {
      explorer.layout.closeDetails()
      store.setPanelOpen(false)
      return
    }
    store.setPanelOpen(true)
    explorer.layout.openDetails()
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
