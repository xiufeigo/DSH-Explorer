/**
 * 右侧栏宽度记忆：官方 ctx.layout 不公开 setDetails，关闭后再开会回到 360。
 * 在 attachPanels 把 actions 交给 store 之前包一层：拖拽落盘，打开时写回。
 */

export const DETAILS_WIDTH_KEY = 'dsh-explorer:details-width'

const DETAILS_MIN = 300
const DETAILS_MAX = 1200

function clamp(px: number): number {
  return Math.min(DETAILS_MAX, Math.max(DETAILS_MIN, Math.round(px)))
}

export function readDetailsWidth(): number | undefined {
  try {
    const raw = localStorage.getItem(DETAILS_WIDTH_KEY)
    if (raw === null) return undefined
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < DETAILS_MIN) return undefined
    return clamp(parsed)
  } catch {
    return undefined
  }
}

export function persistDetailsWidth(px: number): void {
  if (px < DETAILS_MIN) return
  try { localStorage.setItem(DETAILS_WIDTH_KEY, String(clamp(px))) } catch { /* ignore */ }
}

/**
 * 观测式持久化：把 ResizeObserver 实测的稳定列宽写盘。
 * 官方拖拽走的是框架直绑 actions（不经 attachPanels 的包装），唯一可靠的
 * 记忆途径就是实测；阈值内防抖去抖后由调用方决定何时调用。
 */
export function maybePersistObservedWidth(px: number): void {
  if (px < DETAILS_MIN || px > DETAILS_MAX) return
  const rounded = Math.round(px)
  const current = readDetailsWidth()
  if (current !== undefined && Math.abs(current - rounded) <= 1) return
  try { localStorage.setItem(DETAILS_WIDTH_KEY, String(clamp(rounded))) } catch { /* ignore */ }
}

interface PanelActions {
  setDetails: (px: number) => void
  openDetails: () => void
  closeDetails: () => void
  [key: string]: unknown
}

function wrapActions(actions: PanelActions): PanelActions {
  if (typeof actions.setDetails !== 'function' || typeof actions.openDetails !== 'function') return actions
  const origSet = actions.setDetails.bind(actions)
  const origOpen = actions.openDetails.bind(actions)
  return new Proxy(actions, {
    get(target, prop, receiver) {
      if (prop === 'setDetails') {
        return (px: number): void => {
          origSet(px)
          persistDetailsWidth(px)
        }
      }
      if (prop === 'openDetails') {
        return (): void => {
          origOpen()
          const saved = readDetailsWidth()
          if (saved !== undefined) origSet(saved)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/** 最近一次交给宿主的包装 actions——插件代码需要编程式设列宽时用它。 */
let attachedPanelActions: PanelActions | null = null

export function getAttachedPanelActions(): PanelActions | null {
  return attachedPanelActions
}

/** 必须在首屏 render / attachPanels 之前调用。 */
export function installDetailsWidthMemory(layout: object): void {
  const proto = Object.getPrototypeOf(layout) as {
    attachPanels?: (actions: PanelActions) => void
    __dshxDetailsMemory?: boolean
  }
  if (proto.__dshxDetailsMemory === true) return
  const origAttach = proto.attachPanels
  if (typeof origAttach !== 'function') return
  proto.attachPanels = function wrappedAttach(this: unknown, actions: PanelActions) {
    attachedPanelActions = actions
    return origAttach.call(this, wrapActions(actions))
  }
  proto.__dshxDetailsMemory = true
}
