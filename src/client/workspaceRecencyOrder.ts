/**
 * 工作区侧栏「按最后会话时间排序」。
 *
 * 原生侧栏的工作区列表跟随宿主的持久化注册顺序显示：新打开的文件夹置顶，
 * 其余靠手动拖拽。这个模块在偏好开启时订阅 workspaces / sessions 两个快照
 * store，用宿主 recentWorkspace 同款口径计算期望顺序 —— 每个工作区取其
 * 会话的最大 updatedAt，无已知会话回退 createdAt —— 与当前顺序不一致时
 * 通过 `workspaces.insertBefore`（侧栏拖拽走的同一个 API）把最近活动的
 * 工作区顶到最前。排序结果落在宿主的持久注册顺序里，重启后仍然生效。
 *
 * 开启期间手动拖拽会被下一次自动排序覆盖；设置 → 插件 → DSH-Explorer
 * 里可以关掉，关掉即恢复原生行为。
 */

import { getPrefs, subscribePrefs } from './prefs'

/** 触发去抖：会话流式输出时 updatedAt 抖动频繁，攒一小批再算。 */
const DEBOUNCE_MS = 400

interface SessionSummaryLike {
  updatedAt?: number
}

interface SessionsSnapshotLike {
  byId?: Record<string, SessionSummaryLike & { cwd?: string }>
  current?: string
  phase?: string
}

interface WorkspaceItemLike {
  workspaceId?: string
  sessionIds?: string[]
  /** ISO-8601 字符串；工作区没有任何已知会话时作为活动时间回退。 */
  createdAt?: string
}

interface WorkspacesSnapshotLike {
  items?: WorkspaceItemLike[]
  phase?: string
}

/** 官方 runtime createSnapshotStore 的最小面（getSnapshot + subscribe）。 */
interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface RecencyOrderFaces {
  sessions?: { list?: SnapshotStoreLike<SessionsSnapshotLike> }
  workspaces?: {
    list?: SnapshotStoreLike<WorkspacesSnapshotLike>
    insertBefore(workspaceId: string, beforeWorkspaceId?: string): Promise<void>
  }
}

/** 是否至少有一个工作区的活动时间来自真实会话 updatedAt（而非 createdAt 回退）。 */
function hasKnownSessionActivity(items: WorkspaceItemLike[], byId: Record<string, SessionSummaryLike> | undefined): boolean {
  for (const item of items) {
    for (const sessionId of item.sessionIds ?? []) {
      if (typeof byId?.[sessionId]?.updatedAt === 'number') return true
    }
  }
  return false
}

/**
 * 单个工作区的“最后会话时间”：会话 updatedAt 的最大值；一个已知会话都没有
 * 时回落到 createdAt（与宿主 recentWorkspace 的口径一致），解析不出按 0。
 */
function latestActivity(item: WorkspaceItemLike, byId: Record<string, SessionSummaryLike> | undefined): number {
  let latest = Number.NEGATIVE_INFINITY
  for (const sessionId of item.sessionIds ?? []) {
    const updated = byId?.[sessionId]?.updatedAt
    if (typeof updated === 'number') latest = Math.max(latest, updated)
  }
  if (latest === Number.NEGATIVE_INFINITY) {
    const parsed = Date.parse(item.createdAt ?? '')
    latest = Number.isFinite(parsed) ? parsed : 0
  }
  return latest
}

/** 期望顺序：最近活动的工作区在前；并列时保持当前显示顺序（稳定不抖）。 */
function desiredOrder(snap: WorkspacesSnapshotLike | undefined, byId: Record<string, SessionSummaryLike> | undefined): string[] {
  const ranked: { id: string; index: number; latest: number }[] = []
  ;(snap?.items ?? []).forEach((item, index) => {
    const id = item.workspaceId
    if (typeof id === 'string' && id.length > 0) ranked.push({ id, index, latest: latestActivity(item, byId) })
  })
  ranked.sort((left, right) => right.latest - left.latest || left.index - right.index)
  return ranked.map(entry => entry.id)
}

function displayedIds(snap: WorkspacesSnapshotLike | undefined): string[] {
  return (snap?.items ?? [])
    .map(item => item.workspaceId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/**
 * 安装自动排序（返回幂等卸载器）。
 * @param faces 客户端上下文里的 sessions / workspaces 服务。
 */
export function installWorkspaceRecencyOrder(faces: RecencyOrderFaces): () => void {
  const workspacesFace = faces.workspaces
  const wsListOpt = workspacesFace?.list
  const moveOpt = workspacesFace?.insertBefore
  const sessionListOpt = faces.sessions?.list
  if (
    wsListOpt === undefined
    || sessionListOpt === undefined
    || typeof moveOpt !== 'function'
    || typeof window === 'undefined'
    || typeof document === 'undefined'
  ) return () => {}
  // 确定类型的别名：嵌套函数声明里的收窄不可靠，靠这层把可选性消干净。
  const wsList: SnapshotStoreLike<WorkspacesSnapshotLike> = wsListOpt
  const sessionList: SnapshotStoreLike<SessionsSnapshotLike> = sessionListOpt
  // 关键：insertBefore 必须绑回接收者再存。宿主服务方法是原型方法，把方法
  // 提取成裸函数之后再调用，严格模式下 this 是 undefined —— 线上炸过
  // `Cannot read properties of undefined (reading 'manager')`。
  const moveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void> = moveOpt.bind(workspacesFace)

  let timer: ReturnType<typeof setTimeout> | null = null
  let applying = false
  let rerunQueued = false
  let dragging = false
  let disposed = false

  let draggingAt = 0

  /**
   * 是否可以落序。除了常规开关/拖拽，还要求至少一个工作区的活动时间真的来自
   * 会话 updatedAt —— 否则（基线只到了一半时）排序会退化成 createdAt 序并
   * 落一次错误的持久顺序。phase 检查只作加速，不作为唯一门槛：宿主版本
   * 差异下数据在而 phase 不符时照样工作。
   */
  function ready(): boolean {
    if (dragging) return false // 拖拽进行中不抢顺序，落定后由 dragend 补一轮
    if (getPrefs().sortWorkspacesByRecency !== true) return false
    const wsSnap = wsList.getSnapshot()
    const items = wsSnap.items ?? []
    if (items.length < 2) return false
    if (wsSnap.phase !== 'ready' || sessionList.getSnapshot().phase !== 'ready') {
      // 数据已齐也放行（防 phase 语义随版本漂移）：有已知会话时间才算数。
      if (!hasKnownSessionActivity(items, sessionList.getSnapshot().byId)) return false
    }
    return true
  }

  /**
   * 把持久注册顺序变换成期望顺序。逐项到位：从前往后扫，第一位不一致的槽位
   * 把对应 id 用 insertBefore(id, 当前占位者) 拉上来 —— 宿主语义是
   * DOM-insertBefore（无 anchor 时追加到末尾），每步同步本地模拟数组。
   */
  async function enforce(): Promise<void> {
    if (applying) { rerunQueued = true; return }
    applying = true
    try {
      const wsSnap = wsList.getSnapshot()
      const wanted = desiredOrder(wsSnap, sessionList.getSnapshot().byId)
      let working = displayedIds(wsSnap)
      if (working.length < 2 || sameOrder(working, wanted)) return
      let moved = 0
      for (let slot = 0; slot < wanted.length; slot++) {
        const id = wanted[slot]
        if (slot >= working.length || !working.includes(id)) break // 列表并发变化，下轮再对齐
        if (working[slot] === id) continue
        await moveWorkspace(id, working[slot])
        working = working.filter(existing => existing !== id)
        working.splice(slot, 0, id)
        moved++
      }
      if (moved > 0) console.info(`[dsh-explorer] 工作区按会话时间排序：已移动 ${String(moved)} 个工作区`)
    } catch (error) {
      console.warn('[dsh-explorer] 工作区按会话时间排序失败', error)
    } finally {
      applying = false
      if (rerunQueued && !disposed) {
        rerunQueued = false
        schedule()
      }
    }
  }

  /** 拖拽闩锁自恢复：dragend 丢失（元素被移除等）时 5s 后自动解除。 */
  const DRAG_STUCK_MS = 5_000

  function schedule(): void {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      if (dragging && draggingAt > 0 && Date.now() - draggingAt > DRAG_STUCK_MS) dragging = false
      if (ready()) void enforce()
    }, DEBOUNCE_MS)
  }

  // 基线 / 帧 / 会话更新都会推送这两个快照；统一走去抖。
  const unsubWorkspaces = wsList.subscribe(schedule)
  const unsubSessions = sessionList.subscribe(schedule)

  // 拖拽窗口内暂停自动落序，避免和原生 insertWorkspaceBefore 打架。
  const onDragStart = (): void => {
    dragging = true
    draggingAt = Date.now()
  }
  const onDragEnd = (): void => {
    dragging = false
    draggingAt = 0
    schedule()
  }
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragend', onDragEnd, true)

  const unsubPrefs = subscribePrefs(() => schedule())

  schedule()

  return () => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    unsubWorkspaces()
    unsubSessions()
    unsubPrefs()
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragend', onDragEnd, true)
  }
}
