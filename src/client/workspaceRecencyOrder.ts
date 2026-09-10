/**
 * 工作区侧栏「按最后会话时间排序」+「置顶分区」。
 *
 * 原生侧栏的工作区列表跟随宿主的持久化注册顺序显示：新打开的文件夹置顶，
 * 其余靠手动拖拽。本模块在偏好开启时订阅 workspaces / sessions 两个快照
 * store，把列表维护成两段：
 *
 *   [ 置顶区 ] 后跟 [ 普通区 ]
 *
 * 两段各自独立按会话时间排序（口径与宿主 recentWorkspace 一致：每工作区取
 * 会话最大 updatedAt，无已知会话回退 createdAt）。顺序通过
 * `workspaces.insertBefore`（侧栏拖拽走的同一个 API）落到宿主持久注册顺序，
 * 重启后仍然生效。
 *
 * 置顶与拖拽（原生拖拽能力 + 显式 📌 按钮，两种入口语义一致）：
 *   · 把工作区拖到最顶 / 越过所有置顶项，或点行上的 📌 —— 置顶；
 *   · 在置顶区内拖动一次 —— 该区固化为自定义顺序（之后不再随时间变），
 *     从未拖过则一直跟随时间排序；
 *   · 把置顶项拖到普通区 —— 取消置顶，并钉在落点；
 *   · 普通区内拖动 —— 把该工作区钉在拖放的位置（锚定上方邻居），它不再跟
 *     时间流动，其他工作区照常流动；锚点消失则自动回到时间流。
 * 设置卡里可一键让置顶恢复按时间排序、清掉手动定位。
 *
 * 开启期间普通区的手动拖拽会被下一次自动排序覆盖；设置 → 插件 →
 * DSH-Explorer 里可以关掉总开关，关掉即恢复原生行为（置顶也随之失效）。
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

// ── 置顶状态 ────────────────────────────────────────────────────────────────

export interface WorkspacePinState {
  v: 1
  /** time：置顶区跟随会话时间；custom：已固化用户拖出的自定义顺序。 */
  mode: 'time' | 'custom'
  /** 置顶的工作区 id，数组顺序即自定义顺序（time 模式下仅表示集合成员）。 */
  order: string[]
  /**
   * 普通区手动定位（用户拖动的落点）：工作区 id -> 上方邻居 id；
   * null = 普通区顶部。被钉住的工作区不再跟时间流动，其他项照常流动。
   * 锚点消失（工作区被删/被置顶）时该项自动回到时间流。
   */
  docks?: Record<string, string | null>
}

/** localStorage 里落一份 + 内存镜像（测试环境没有 localStorage 也能跑）。 */
const PINS_STORAGE_KEY = 'dsh-explorer:pins'
let pinsCache: WorkspacePinState | null = null

function normalizePins(raw: unknown, validIds?: ReadonlySet<string>): WorkspacePinState {
  const source = raw as Partial<WorkspacePinState> | null
  const order = Array.isArray(source?.order)
    ? source.order.filter((id): id is string => typeof id === 'string' && id.length > 0 && (validIds === undefined || validIds.has(id)))
    : []
  const docksRaw = source?.docks
  const docks: Record<string, string | null> = {}
  if (docksRaw !== null && typeof docksRaw === 'object') {
    for (const [id, anchor] of Object.entries(docksRaw)) {
      if (typeof id !== 'string' || id.length === 0 || (validIds !== undefined && !validIds.has(id))) continue
      if (anchor === null) { docks[id] = null; continue }
      docks[id] = typeof anchor === 'string' && (validIds === undefined || validIds.has(anchor)) ? anchor : null
    }
  }
  return { v: 1, mode: source?.mode === 'custom' ? 'custom' : 'time', order, docks }
}

function loadPins(validIds?: ReadonlySet<string>): WorkspacePinState {
  if (pinsCache !== null) {
    const cached = validIds === undefined ? pinsCache : normalizePins(pinsCache, validIds)
    if (validIds !== undefined) pinsCache = cached
    return cached
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(window.localStorage.getItem(PINS_STORAGE_KEY) ?? 'null')
  } catch { /* 没有 storage 或坏数据，走默认 */ }
  pinsCache = normalizePins(parsed, validIds)
  return pinsCache
}

function savePins(next: WorkspacePinState, notify = true): void {
  pinsCache = next
  try {
    window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(next))
  } catch { /* 测试环境没有 localStorage，静默 */ }
  if (notify) {
    for (const listener of [...pinsListeners]) listener()
  }
}

/** 置顶状态变化的订阅者（安装器用它让「恢复时间排序」立即生效）。 */
const pinsListeners = new Set<() => void>()

/** 把置顶成员里已经不存在的工作区悄悄清掉（工作区被关闭/删除）。 */
function prunePins(validIds: ReadonlySet<string>): void {
  const before = loadPins()
  const pruned = normalizePins(before, validIds)
  if (pruned.order.length !== before.order.length || Object.keys(pruned.docks ?? {}).length !== Object.keys(before.docks ?? {}).length) {
    savePins(pruned, false)
  }
}

/** 当前置顶概况（设置卡展示用）。 */
export function getWorkspacePinSummary(): {
  count: number
  mode: 'time' | 'custom'
  order: string[]
  dockedCount: number
  docks: Record<string, string | null>
} {
  const pins = loadPins()
  return {
    count: pins.order.length,
    mode: pins.mode,
    order: [...pins.order],
    dockedCount: Object.keys(pins.docks ?? {}).length,
    docks: { ...(pins.docks ?? {}) },
  }
}

/** 让置顶区放弃自定义顺序、恢复跟随会话时间（保留置顶成员本身），并清掉所有手动定位。 */
export function resetWorkspacePinOrder(): void {
  savePins({ ...loadPins(), mode: 'time', docks: {} })
}

/** 清掉普通区里所有手动定位（被钉住的工作区回到时间流）。 */
export function clearWorkspaceDocks(): void {
  savePins({ ...loadPins(), docks: {} })
}

/** 置顶状态变化订阅（覆盖层用它刷新按钮状态）。 */
export function subscribePins(listener: () => void): () => void {
  pinsListeners.add(listener)
  return () => { pinsListeners.delete(listener) }
}

export function isWorkspacePinned(id: string): boolean {
  return loadPins().order.includes(id)
}

/** 置顶：插到置顶区最前，并固化为自定义顺序（显式操作按用户意图定位）；置顶优先于手动定位。 */
export function pinWorkspace(id: string): void {
  const pins = loadPins()
  if (pins.order.includes(id)) return
  const docks = { ...(pins.docks ?? {}) }
  delete docks[id]
  savePins({ v: 1, mode: 'custom', order: [id, ...pins.order], docks })
}

/** 取消置顶：保留其余置顶项的自定义顺序与模式；落回普通区跟时间排。 */
export function unpinWorkspace(id: string): void {
  const pins = loadPins()
  if (!pins.order.includes(id)) return
  savePins({ v: 1, mode: pins.mode, order: pins.order.filter(existing => existing !== id) })
}

/** 测试播种：直接替换内存里的置顶状态。下划线前缀 = 非公开 API。 */
export function __setPinsForTests(state: WorkspacePinState | null): void {
  pinsCache = state
}

/**
 * 插件重载复位：清掉模块单例的内存缓存与订阅集合（不动 localStorage /
 * 宿主注册顺序等宿主状态），防止旧实例残留干扰新实例。
 * 注意：只清缓存不改排序逻辑。下划线前缀 = 非公开 API。
 */
export function __resetForReload(): void {
  pinsCache = null
  pinsListeners.clear()
  orderSource = null
  dragHold = false
}

// ── 时间口径 ────────────────────────────────────────────────────────────────

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

function displayedIds(snap: WorkspacesSnapshotLike | undefined): string[] {
  return (snap?.items ?? [])
    .map(item => item.workspaceId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** 按最近活动降序取 id；并列时保持传入相对顺序（稳定不抖）。 */
function rankByActivity(ids: string[], entries: Map<string, { item: WorkspaceItemLike; index: number }>, byId: Record<string, SessionSummaryLike> | undefined): string[] {
  return ids
    .map(id => ({ id, meta: entries.get(id)! }))
    .sort((left, right) => latestActivity(right.meta.item, byId) - latestActivity(left.meta.item, byId) || left.meta.index - right.meta.index)
    .map(entry => entry.id)
}

/**
 * 分区期望顺序：[置顶区…] 后跟 [普通区…]。
 * 置顶区：mode=custom 时用保存的自定义顺序；mode=time 时按会话时间排。
 * 普通区：基础是会话时间流，其上叠加手动定位（dock）——被拖动钉住的项
 * 固定在锚点（上方邻居）之后，不跟时间流动；锚点不可达（被删/成环）的
 * 定位作废，该项回到时间流原位。
 * 返回期望顺序 + 作废的定位清单（调用方负责清理存储）。
 */
function buildLayout(
  snap: WorkspacesSnapshotLike | undefined,
  byId: Record<string, SessionSummaryLike> | undefined,
  pins: WorkspacePinState,
): { order: string[]; abandonedDocks: string[] } {
  const entries = new Map<string, { item: WorkspaceItemLike; index: number }>()
  ;(snap?.items ?? []).forEach((item, index) => {
    const id = item.workspaceId
    if (typeof id === 'string' && id.length > 0 && !entries.has(id)) entries.set(id, { item, index })
  })
  const pinnedSet = new Set(pins.order.filter(id => entries.has(id)))
  const pinnedSorted = pins.mode === 'custom'
    ? pins.order.filter(id => pinnedSet.has(id))
    : rankByActivity([...pinnedSet], entries, byId)
  const base = rankByActivity([...entries.keys()].filter(id => !pinnedSet.has(id)), entries, byId)
  const basePos = new Map(base.map((id, index) => [id, index]))

  // 归集定位：置顶项/不存在的锚一律视为「普通区顶部」。
  const docks = pins.docks ?? {}
  const headDocks: string[] = []
  const byAnchor = new Map<string, string[]>()
  const docked = new Set<string>()
  for (const [id, anchor] of Object.entries(docks)) {
    if (!entries.has(id) || pinnedSet.has(id)) continue
    docked.add(id)
    const effective = anchor !== null && basePos.has(anchor) ? anchor : null
    if (effective === null) headDocks.push(id)
    else {
      const list = byAnchor.get(effective)
      if (list === undefined) byAnchor.set(effective, [id])
      else list.push(id)
    }
  }
  const byBase = (left: string, right: string): number => (basePos.get(left) ?? 0) - (basePos.get(right) ?? 0)
  headDocks.sort(byBase)
  for (const list of byAnchor.values()) list.sort(byBase)

  const order: string[] = []
  const emitted = new Set<string>()
  const emit = (id: string): void => {
    if (emitted.has(id)) return
    emitted.add(id)
    order.push(id)
    const followers = byAnchor.get(id)
    if (followers !== undefined) for (const follower of followers) emit(follower)
  }
  for (const id of headDocks) emit(id)
  // 普通区按时间流走一遍；被钉住的项不能自己出场，只能由锚点（可能链式）带出
  // ——注意锚点在时间序里完全可能排在被钉项之后（被钉正是因为不想让它按时间浮走）。
  for (const id of base) {
    if (docked.has(id)) continue
    emit(id)
  }
  // 走完还没落位的定位 = 成环等病理情况：作废，按时间流位置补齐。
  const abandonedDocks: string[] = []
  for (const id of base) {
    if (docked.has(id) && !emitted.has(id)) {
      abandonedDocks.push(id)
      emit(id)
    }
  }
  return { order: [...pinnedSorted, ...order], abandonedDocks }
}

// ── 用户拖拽意图识别 ────────────────────────────────────────────────────────

/**
 * 找出从 prev 到 now 被“挪动”的那一个元素：把它从两边各拿掉后剩下的序列
 * 完全一致。列表增删（新开文件夹/关闭）或多重移动时返回 undefined。
 */
function findRelocated(prev: string[], now: string[]): string | undefined {
  if (prev.length !== now.length) return undefined
  for (let i = 0; i < prev.length; i++) {
    const candidate = prev[i]
    const prevRest = prev.filter((_, index) => index !== i)
    const nowRest = now.filter(id => id !== candidate)
    if (prevRest.length === nowRest.length && prevRest.every((id, j) => id === nowRest[j])) return candidate
  }
  return undefined
}

/**
 * 解读一次原生拖拽（非本模块自己落的序），更新置顶/定位状态：
 *   · 未置顶者出现在任一置顶项之上（或绝对第一）→ 置顶，位置照搬；
 *   · 已置顶者的上方出现了普通项（被拖到普通区）→ 取消置顶，并钉在落点；
 *   · 普通区内的拖动 → 钉在落点（锚 = 落点上方邻居），不再跟时间流动；
 *   · 置顶区内的位次变化视为自定义排序，固化之。
 * 我们的落序器始终保持「置顶段严格在前」的不变量，所以跨线只有拖拽一种来源。
 */
function captureDragIntent(prev: string[], now: string[]): void {
  const moved = findRelocated(prev, now)
  if (moved === undefined) return
  const pins = loadPins()
  const pinnedSet = new Set(pins.order)
  const wasPinned = pinnedSet.has(moved)
  const movedAt = now.indexOf(moved)
  /** 落点的定位锚：上方的邻居；邻居是置顶项（或没有）时 = 普通区顶部。 */
  const dockAtDrop = (): Record<string, string | null> => {
    const docks = { ...(pins.docks ?? {}) }
    const above = movedAt > 0 ? now[movedAt - 1] : null
    docks[moved] = above !== null && !pinnedSet.has(above) ? above : null
    return docks
  }

  if (!wasPinned) {
    const pinnedBelowOrFirst = now.some((id, index) => index > movedAt && pinnedSet.has(id)) || movedAt === 0
    if (pinnedBelowOrFirst) {
      // 拖进置顶区：以它在 now 里的实际位次写进置顶顺序，固化自定义模式；
      // 置顶优先于手动定位，清掉它可能的旧定位。
      const merged = now.filter(id => id === moved || pinnedSet.has(id))
      const docks = { ...(pins.docks ?? {}) }
      delete docks[moved]
      savePins({ v: 1, mode: 'custom', order: merged, docks })
      return
    }
    // 普通区内拖动：钉在落点。
    savePins({ ...pins, docks: dockAtDrop() })
    return
  }

  const unpinnedAboveMoved = now.some((id, index) => index < movedAt && !pinnedSet.has(id))
  if (unpinnedAboveMoved) {
    // 拖出置顶区：取消置顶，并钉在拖放的落点。
    savePins({ v: 1, mode: pins.mode, order: pins.order.filter(id => id !== moved), docks: dockAtDrop() })
    return
  }
  // 置顶区内拖动：固化为自定义顺序。
  savePins({ ...pins, mode: 'custom', order: now.filter(id => pinnedSet.has(id)) })
}

// ── 安装 ────────────────────────────────────────────────────────────────────

/** 拖拽持有：自定义指针拖拽进行中暂停自动落序（覆盖层在起止时调用）。 */
let dragHold = false

export function beginWorkspaceDragHold(): void {
  dragHold = true
}

export function endWorkspaceDragHold(): void {
  dragHold = false
}

/** 安装器注册的整表顺序读取口，供 commitWorkspaceOrderIntent 取当前布局。 */
let orderSource: (() => string[]) | null = null

/**
 * 提交一次拖放的落点意图：next 是拖放后应有的完整顺序（与当前同一组 id）。
 * 内部走 captureDragIntent 的同一套分类（置顶/钉住/取消置顶/置顶区自定义），
 * 落库后由订阅触发落序器把实际顺序对齐。
 */
export function commitWorkspaceOrderIntent(next: string[]): void {
  const source = orderSource
  if (source === null) return
  const flat = source()
  if (flat.length !== next.length || !flat.every(id => next.includes(id))) return // 列表增删中，忽略
  if (sameOrder(flat, next)) return
  captureDragIntent(flat, next)
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
  let applyingAt = 0
  let rerunQueued = false
  let dragging = false
  let disposed = false

  let draggingAt = 0

  /**
   * 我们最后一次确认过的整表顺序。用途：区分「外部改序」（用户拖拽 /
   * 原生操作）和「我们自己的落序回声」。空串代表还没建立基线。
   */
  let lastLayout: string[] = []

  /**
   * 是否可以落序。除了常规开关/拖拽，还要求至少一个工作区的活动时间真的来自
   * 会话 updatedAt —— 否则（基线只到了一半时）排序会退化成 createdAt 序并
   * 落一次错误的持久顺序。phase 检查只作加速，不作为唯一门槛：宿主版本
   * 差异下数据在而 phase 不符时照样工作。
   */
  function ready(): boolean {
    if (dragging || dragHold) return false // 拖拽进行中不抢顺序，落定后由 dragend 补一轮
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

  /** 单次移动的超时上限：RPC 挂死也不能让落序器永久卡死。 */
  const MOVE_TIMEOUT_MS = 8_000
  /** enforce 整体的看门狗：超过时限视为卡死，强制解锁。 */
  const ENFORCE_WATCHDOG_MS = 30_000

  async function enforce(): Promise<void> {
    if (applying) { rerunQueued = true; return }
    applying = true
    applyingAt = Date.now()
    try {
      const ids = displayedIds(wsList.getSnapshot())
      // 每次都先把置顶成员里已消失的 id 清掉，防止引用已关闭的工作区。
      prunePins(new Set(ids))
      const byId = sessionList.getSnapshot().byId
      const current = loadPins()
      const { order: wanted, abandonedDocks } = buildLayout(wsList.getSnapshot(), byId, current)
      if (abandonedDocks.length > 0) {
        // 锚点已消失的手动定位直接作废（静默清理，不触发订阅循环）。
        const docks = { ...(current.docks ?? {}) }
        for (const id of abandonedDocks) delete docks[id]
        savePins({ ...current, docks }, false)
      }
      let working = ids
      if (working.length < 2 || sameOrder(working, wanted)) return
      let moved = 0
      for (let slot = 0; slot < wanted.length; slot++) {
        const id = wanted[slot]
        if (slot >= working.length || !working.includes(id)) break // 列表并发变化，下轮再对齐
        if (working[slot] === id) continue
        await moveWithTimeout(id, working[slot])
        working = working.filter(existing => existing !== id)
        working.splice(slot, 0, id)
        moved++
      }
      if (moved > 0) console.info(`[dsh-explorer] 工作区排序已更新（移动 ${String(moved)} 个）`)
    } catch (error) {
      console.warn('[dsh-explorer] 工作区排序失败', error)
    } finally {
      applying = false
      applyingAt = 0
      lastLayout = displayedIds(wsList.getSnapshot())
      if (rerunQueued && !disposed) {
        rerunQueued = false
        schedule()
      }
    }
  }

  /** RPC 加超时保护：超时就放弃本轮（下轮 tick 从快照重新对齐），绝不挂死。 */
  async function moveWithTimeout(id: string, anchor: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        moveWorkspace(id, anchor),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`insertBefore timeout after ${String(MOVE_TIMEOUT_MS)}ms`)), MOVE_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  function schedule(): void {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      if (applying) {
        // 看门狗：enforce 卡死（如 RPC 永不返回）超过上限就强制解锁。
        if (!(applyingAt > 0 && Date.now() - applyingAt > ENFORCE_WATCHDOG_MS)) {
          // enforce 进行中到达的变化不能丢：标记补跑，由其 finally 兜底重排
          // （rerunQueued 原来的唯一写入点在 enforce 并发分支，实际不可达）。
          rerunQueued = true
          return
        }
        applying = false
        applyingAt = 0
      }
      if (dragging && draggingAt > 0 && Date.now() - draggingAt > DRAG_STUCK_MS) dragging = false
      if (!ready()) return
      const current = displayedIds(wsList.getSnapshot())
      if (current.length < 2) return
      if (lastLayout.length === 0) {
        // 首次观察：只建基线，不解读意图（历史顺序未必出自当前布局）。
        lastLayout = current
      } else if (!sameOrder(lastLayout, current)) {
        captureDragIntent(lastLayout, current)
        lastLayout = current
      }
      void enforce()
    }, DEBOUNCE_MS)
  }

  /** 拖拽闩锁自恢复：dragend 丢失（元素被移除等）时 5s 后自动解除。 */
  const DRAG_STUCK_MS = 5_000

  // 置顶状态变化（如设置卡点「恢复时间排序」）也触发一轮重排。
  const onPinsChanged = (): void => { schedule() }
  pinsListeners.add(onPinsChanged)

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

  // 只认领自己注册的 orderSource：双安装器并存（HMR/未 dispose 的旧实例）时，
  // 先退场的实例不得把后来者的读取口清空（否则 commitWorkspaceOrderIntent 静默失效）。
  const myOrderSource = (): string[] => displayedIds(wsList.getSnapshot())
  orderSource = myOrderSource
  schedule()

  return () => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    pinsListeners.delete(onPinsChanged)
    if (orderSource === myOrderSource) orderSource = null
    unsubWorkspaces()
    unsubSessions()
    unsubPrefs()
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragend', onDragEnd, true)
  }
}
