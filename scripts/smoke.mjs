/**
 * Smoke check for the built artifacts — evaluates BOTH halves the way the
 * two runtime loaders actually consume them, instead of just reading bytes:
 *
 *  1. Host half: require() the package entry the way the cordis plugin
 *     loader does, and assert `apply`/`default` are callable.
 *  2. Browser half: emulate the shell's `window.__ModuleLoader__.load`
 *     handoff, run the bundle factory with a real React behind the injected
 *     require, and assert the plugin module exports `apply` + `inject`.
 *
 * A bundle missing the CJS `exports` shim dies right here — this is the
 * check that catches the `exports is not defined` page-down failure.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)

let failures = 0
const fail = (label, error) => {
  failures++
  console.error(`✘ ${label}:`, error?.message ?? error)
}
const ok = label => console.log(`✔ ${label}`)

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error(`package.json dsh.bundle.patch unexpected: ${JSON.stringify(pkg.dsh?.bundle)}`)
  }
  ok('package.json declares dsh.bundle.patch = ./cordis.patch.yml')
} catch (error) {
  fail('dsh.bundle manifest', error)
}

// ── 1. Host half ──────────────────────────────────────────────────────────
try {
  const entry = require('dsh-explorer')
  if (typeof entry.apply !== 'function' && typeof entry.default !== 'function') {
    throw new Error('host entry exposes no apply function')
  }
  // 冷启动顺序保障：默认导出必须是带 inject 的插件对象（否则行会先于
  // webserver 就绪执行、静默丢路由 —— 曾导致线上 405）。
  const plugin = entry.default
  if (typeof plugin !== 'object' || plugin === null || typeof plugin.apply !== 'function') {
    throw new Error('host default export must be a plugin object with apply')
  }
  if (plugin.name !== 'dsh-explorer') {
    throw new Error(`host plugin name must be dsh-explorer (got ${JSON.stringify(plugin.name)})`)
  }
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('webServer')) {
    throw new Error(`host plugin inject must include webServer (got ${JSON.stringify(plugin.inject)})`)
  }
  ok(`host half: require("dsh-explorer") exposes { inject: [${plugin.inject.join(', ')}], apply }`)

  const routes = []
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      return undefined
    },
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
  }
  plugin.apply(ctx)
  // 路由挂载断言：register 被吞掉时，路径写错也会全绿 —— 必须核对实际入参。
  const rpcRoute = routes.find(route => route.path === '/dsh-explorer/rpc')
  if (rpcRoute === undefined || rpcRoute.kind !== 'exact' || typeof rpcRoute.handler !== 'function') {
    throw new Error(`host apply did not register exact /dsh-explorer/rpc route (got ${JSON.stringify(routes.map(r => r.path))})`)
  }
  const ptyRoute = routes.find(route => route.path === '/dsh-explorer/pty')
  if (ptyRoute === undefined || ptyRoute.kind !== 'exact' || typeof ptyRoute.handler !== 'function') {
    throw new Error('host apply did not register exact /dsh-explorer/pty route')
  }
  ok('host half: registers exact /dsh-explorer/rpc + /dsh-explorer/pty routes')
} catch (error) {
  fail('host half import', error)
}

// ── 2. Browser half ────────────────────────────────────────────────────────
try {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  if (!code.includes('.dshx-term-panel')) {
    throw new Error('client bundle did not inline explorer CSS (.dshx-term-panel missing)')
  }
  if (!code.includes('dataset.plugin')) {
    throw new Error('client bundle did not stamp style[data-plugin] for unload')
  }
  if (/require\([^)]*\.css/.test(code)) {
    throw new Error('client bundle still requires a CSS file; the module table cannot serve it')
  }
  ok('browser half: explorer CSS inlined into the factory')
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { captured = entry },
    },
  }
  // Evaluate exactly like the shell does: the artifact is a script, not a module.
  new Function(code)()
  if (captured === null || typeof captured.factory !== 'function') {
    throw new Error('bundle did not call window.__ModuleLoader__.load with a factory')
  }
  const injectedRequire = (specifier) => {
    if (specifier === 'react') return require('react')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === 'react-dom') return require('react-dom')
    // 原生图标库是平台模块（真实运行时由模块表提供）；冒烟环境里给个
    // 桩：工厂只在顶层绑定图标组件，不会真的渲染。
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return new Proxy({}, { get: () => () => null })
    }
    throw new Error(`unexpected external require: ${specifier}`)
  }
  const pluginModule = captured.factory(injectedRequire)
  if (typeof pluginModule?.apply !== 'function') throw new Error('client module exposes no apply')
  if (!Array.isArray(pluginModule.inject)) throw new Error('client module exposes no inject array')
  ok(`browser half: factory evaluates and exports apply + inject (${pluginModule.inject.join(', ')})`)

  function makeSlots() {
    const specs = new Map()
    const waiters = new Map()
    const registers = []
    return {
      registers,
      inject(name, cb) {
        const list = waiters.get(name) ?? []
        list.push(cb)
        waiters.set(name, list)
        if (specs.has(name)) cb()
      },
      register(options, component) {
        const spec = specs.get(options.name)
        if (!spec) throw new Error(`slot "${options.name}" is not declared`)
        if (spec.kind === 'keyed' && options.key === undefined) {
          throw new Error(`keyed slot "${options.name}" requires options.key`)
        }
        if (spec.kind === 'list' && options.id === undefined) {
          throw new Error(`list slot "${options.name}" requires options.id`)
        }
        registers.push({ options, component })
        return () => {}
      },
      declare(name, spec) {
        specs.set(name, spec)
        for (const cb of waiters.get(name) ?? []) cb()
      },
    }
  }
  const slots = makeSlots()
  // effect 不执行：排序 / 置顶安装器要真实 DOM（它们由 §5 用假服务直测），
  // 这里只验证 apply 里的槽位注册这条接线。
  pluginModule.apply({
    get: () => undefined,
    effect: () => () => {},
    slots,
    sessions: {},
    workspaces: {},
  })
  slots.declare('conversation.session.header.utilities', { kind: 'list' })
  const term = slots.registers.find(row => row.options.name === 'conversation.session.header.utilities')
  if (term === undefined) throw new Error('missing conversation.session.header.utilities registration')
  if (term.options.id !== 'dsh-explorer-term') {
    throw new Error(`terminal toggle must carry id=dsh-explorer-term (got ${JSON.stringify(term.options.id)})`)
  }
  ok('session-header slot: 终端开关注册到 conversation.session.header.utilities')
} catch (error) {
  fail('browser half evaluation', error)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}

// ── 3. RPC 跨站防护闸 ─────────────────────────────────────────────────────
// handleRpc 的前置分支不依赖任何服务，可以纯 mock 直测：
// 同源回环 OPTIONS 放行、跨源拒绝、无校验头拒绝、缺 Origin 拒绝、
// 同源但非回环（DNS rebinding）拒绝。
try {
  const { handleRpc, handlePtyStream } = require('dsh-explorer')
  if (typeof handleRpc !== 'function') throw new Error('handleRpc not exported')
  // P1-11：handlePtyStream 必须保持导出，冒烟直测闸分支。
  if (typeof handlePtyStream !== 'function') throw new Error('handlePtyStream not exported')

  const makeReq = (method, headers, body) => {
    const req = new EventEmitter()
    req.method = method
    req.headers = headers
    if (body !== null) {
      req.on('data', () => {})
      queueMicrotask(() => {
        req.emit('data', Buffer.from(body))
        req.emit('end')
      })
    }
    return req
  }
  const makeRes = () => {
    const res = { statusCode: 0, headers: {}, body: '', onError: [] }
    res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers) }
    res.end = (text) => { res.body = String(text ?? '') }
    res.on = (event, cb) => { res.onError.push([event, cb]); return res }
    return res
  }
  const noServices = { sessions: { get: () => undefined } }
  const LOOP = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }

  {
    const res = makeRes()
    await handleRpc(makeReq('OPTIONS', { ...LOOP }, null), res, noServices, new Map())
    if (res.statusCode !== 204) throw new Error(`same-origin OPTIONS expected 204, got ${res.statusCode}`)
    ok('rpc gate: same-origin loopback OPTIONS preflight → 204')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('OPTIONS', { origin: 'https://evil.example', host: '127.0.0.1:3080' }, null), res, noServices, new Map())
    if (res.statusCode !== 403) throw new Error(`cross-origin OPTIONS expected 403, got ${res.statusCode}`)
    ok('rpc gate: cross-origin OPTIONS → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('OPTIONS', { origin: 'http://evil.com:3080', host: 'evil.com:3080' }, null), res, noServices, new Map())
    if (res.statusCode !== 403) throw new Error(`rebinding OPTIONS (sameHost, non-loopback) expected 403, got ${res.statusCode}`)
    ok('rpc gate: DNS-rebinding OPTIONS (same host, non-loopback) → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json' }, '{"method":"fs.list"}'), res, noServices, new Map())
    if (res.statusCode !== 403) throw new Error(`header-less POST expected 403, got ${res.statusCode}`)
    ok('rpc gate: POST without x-dsh-explorer header → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1', ...LOOP }, '{"sessionId":"nope","method":"fs.list"}'), res, noServices, new Map())
    if (res.statusCode !== 200) throw new Error(`gated POST expected 200, got ${res.statusCode}`)
    if (!res.body.includes('会话不存在')) throw new Error(`gated POST body unexpected: ${res.body}`)
    ok('rpc gate: POST with header + loopback origin reaches dispatch (session guard answers)')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1', host: '127.0.0.1:3080' }, '{"method":"fs.list"}'), res, noServices, new Map())
    if (res.statusCode !== 403) throw new Error(`POST without Origin expected 403, got ${res.statusCode}`)
    ok('rpc gate: POST with header but missing Origin → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1', origin: 'http://evil.com:3080', host: 'evil.com:3080' }, '{"method":"fs.list"}'), res, noServices, new Map())
    if (res.statusCode !== 403) throw new Error(`rebinding POST expected 403, got ${res.statusCode}`)
    ok('rpc gate: DNS-rebinding POST (same host, non-loopback) → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1', origin: 'http://localhost:3080', host: 'localhost:3080' }, '{"sessionId":"nope","method":"fs.list"}'), res, noServices, new Map())
    if (res.statusCode !== 200) throw new Error(`localhost POST expected 200, got ${res.statusCode}`)
    ok('rpc gate: localhost loopback variant also passes')
  }
  {
    // handlePtyStream 与 RPC 同一道闸：无自定义头 → 403。
    const res = makeRes()
    await handlePtyStream(makeReq('POST', { 'content-type': 'application/json' }, '{"sessionId":"x","id":"t"}'), res, noServices)
    if (res.statusCode !== 403) throw new Error(`header-less pty stream expected 403, got ${res.statusCode}`)
    ok('pty stream gate: POST without x-dsh-explorer header → 403')
  }
  {
    // 带头 + 回环同源 + 会话缺失 → 进 dispatch，由会话守卫应答 200。
    // sv.pty 必须已定义（否则先撞「终端服务未就绪」），给空壳即可走不到 attach。
    const res = makeRes()
    const sv = { sessions: { get: () => undefined }, pty: {} }
    await handlePtyStream(
      makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1', ...LOOP }, '{"sessionId":"nope","id":"t1"}'),
      res, sv,
    )
    if (res.statusCode !== 200) throw new Error(`missing-session pty stream expected 200, got ${res.statusCode}`)
    if (!res.body.includes('会话不存在')) throw new Error(`pty stream body unexpected: ${res.body}`)
    ok('pty stream: header + loopback origin reaches dispatch (session guard answers)')
  }
  {
    // t14：pty.resize 分发 + 参数形状 + 非法尺寸拒绝（真实 PTY 不起，桩验证转发）。
    const session = { header: { id: 's-rz', cwd: process.cwd() } }
    const calls = []
    const sv = {
      sessions: { get: id => (id === 's-rz' ? session : undefined) },
      policyFor: () => undefined,
      pty: {
        async resize(sessionId, id, cols, rows) { calls.push([sessionId, id, cols, rows]); return { ok: true } },
      },
    }
    const res = makeRes()
    await handleRpc(
      makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1', ...LOOP },
        '{"sessionId":"s-rz","method":"pty.resize","args":{"id":"pty-1","cols":100,"rows":30}}'),
      res, sv, new Map(),
    )
    if (res.statusCode !== 200) throw new Error(`pty.resize expected 200, got ${res.statusCode}`)
    if (calls.length !== 1 || calls[0][0] !== 's-rz' || calls[0][1] !== 'pty-1' || calls[0][2] !== 100 || calls[0][3] !== 30) {
      throw new Error(`pty.resize forwarding wrong: ${JSON.stringify(calls)}`)
    }
    const resBad = makeRes()
    await handleRpc(
      makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1', ...LOOP },
        '{"sessionId":"s-rz","method":"pty.resize","args":{"id":"pty-1","cols":"wide"}}'),
      resBad, sv, new Map(),
    )
    if (!resBad.body.includes('非法尺寸')) throw new Error(`pty.resize malformed dims unexpected: ${resBad.body}`)
    ok('rpc dispatch: pty.resize forwards {id,cols,rows} and rejects malformed dims')
  }
} catch (error) {
  // 不在此处 process.exit：后续分节相互独立，汇总到文末统一退出，
  // 一次运行能看到全部失败（§1/§2 的 lib 破坏总闸仍会先行短路）。
  fail('rpc gate checks', error)
}


// ── 5. 工作区按会话时间排序（workspaceRecencyOrder） ──────────────────────
// 假 store + 假 insertBefore（按宿主 DOM-insertBefore 语义搬数组），
// 验证：基线就绪后按会话 updatedAt 降序排到位、幂等不再动、无会话回退 createdAt。
try {
  const code5 = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let captured5 = null
  globalThis.window = { __ModuleLoader__: { load(entry) { captured5 = entry } } }
  // bundle 顶层有 CSS 注入器（querySelector→createElement→head.appendChild），桩要够用。
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild() {} },
  }
  new Function(code5)()
  const browserRequire = (specifier) => {
    if (specifier === 'react') return require('react')
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (specifier === 'react-dom') return require('react-dom')
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => () => null })
    throw new Error(`unexpected external require: ${specifier}`)
  }
  const { installWorkspaceRecencyOrder, __setPinsForTests, getWorkspacePinSummary, resetWorkspacePinOrder, commitWorkspaceOrderIntent, beginWorkspaceDragHold, endWorkspaceDragHold } = captured5.factory(browserRequire)
  if (typeof installWorkspaceRecencyOrder !== 'function') throw new Error('installWorkspaceRecencyOrder not exported')

  const makeStore = (initial) => {
    let state = initial
    const listeners = new Set()
    return {
      getSnapshot: () => state,
      set(next) { state = next; for (const listener of [...listeners]) listener() },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
  }
  const NOW = Date.now()
  const DAY = 86400_000
  const sessions = makeStore({
    phase: 'pending',
    byId: {
      's-old': { updatedAt: NOW - 5 * DAY },
      's-mid': { updatedAt: NOW - DAY },
      's-new': { updatedAt: NOW - 60_000 },
    },
  })
  const items = [
    { workspaceId: 'w-old', sessionIds: ['s-old'], createdAt: new Date(NOW - 9 * DAY).toISOString() },
    { workspaceId: 'w-mid', sessionIds: ['s-mid'], createdAt: new Date(NOW - 2 * DAY).toISOString() },
    { workspaceId: 'w-new', sessionIds: [], createdAt: new Date(NOW - 3600_000).toISOString() },
    { workspaceId: 'w-active', sessionIds: ['s-new'], createdAt: new Date(NOW - 30 * DAY).toISOString() },
  ]
  const workspaces = makeStore({ phase: 'pending', items })
  const moves = []
  let current = items
  const insertBefore = async (id, before) => {
    const ids = current.map(row => row.workspaceId)
    const next = ids.filter(existing => existing !== id)
    const at = before === undefined ? next.length : next.indexOf(before)
    if (at < 0) throw new Error(`unknown anchor ${JSON.stringify(before)}`)
    next.splice(at, 0, id)
    current = next.map(key => items.find(row => row.workspaceId === key))
    workspaces.set({ phase: 'ready', items: current })
    moves.push([id, before])
  }
  const dispose = installWorkspaceRecencyOrder({ sessions: { list: sessions }, workspaces: { list: workspaces, insertBefore } })

  // 基线就绪 → 去抖 400ms 后应把顺序排成 recency 降序。
  sessions.set({ ...sessions.getSnapshot(), phase: 'ready' })
  workspaces.set({ phase: 'ready', items })
  await new Promise(resolve => setTimeout(resolve, 1000))
  const orderAfter = current.map(row => row.workspaceId).join(',')
  if (orderAfter !== 'w-active,w-new,w-mid,w-old') {
    throw new Error(`recency order unexpected: ${orderAfter} (moves: ${JSON.stringify(moves)})`)
  }
  if (moves.length === 0) throw new Error('no insertBefore calls were issued')
  ok(`recency order: baselines ready → sorted by last-session time (${moves.length} move(s))`)

  // 幂等：再等一轮不应有任何新动作。
  const movesBeforeIdle = moves.length
  await new Promise(resolve => setTimeout(resolve, 800))
  if (moves.length !== movesBeforeIdle) throw new Error(`order oscillated: ${JSON.stringify(moves)}`)
  ok('recency order: stable when nothing changed (idempotent)')

  dispose()

  // ── 守卫 facade 复刻：runner 给动态插件的服务都包一层方法转发 Proxy ──
  // 这里复刻 dsh-cordis-client-runner guardedService 的关键语义（方法转发、
  // 非函数属性原样透传），证明排序模块在真实 ctx.facade 下同样工作。
  const guardedService = (service) => new Proxy(service, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      return (...args) => Reflect.apply(value, target, args)
    },
  })
  moves.length = 0
  current = items // 原始（创建序）排列，等待重排
  const workspaces2 = makeStore({ phase: 'ready', items })
  const sessions2 = makeStore({ phase: 'ready', byId: sessions.getSnapshot().byId })
  const insertBefore2 = async (id, before) => {
    const ids = current.map(row => row.workspaceId)
    const next = ids.filter(existing => existing !== id)
    const at = next.indexOf(before)
    if (at < 0) throw new Error(`unknown anchor ${JSON.stringify(before)}`)
    next.splice(at, 0, id)
    current = next.map(key => items.find(row => row.workspaceId === key))
    workspaces2.set({ phase: 'ready', items: current })
    moves.push([id, before])
  }
  const dispose2 = installWorkspaceRecencyOrder({
    sessions: guardedService({ list: sessions2 }),
    workspaces: guardedService({ list: workspaces2, insertBefore: insertBefore2 }),
  })
  await new Promise(resolve => setTimeout(resolve, 1000))
  const orderGuarded = current.map(row => row.workspaceId).join(',')
  if (orderGuarded !== 'w-active,w-new,w-mid,w-old') {
    throw new Error(`guarded facade order unexpected: ${orderGuarded} (moves: ${JSON.stringify(moves)})`)
  }
  ok(`recency order: works through runner-style guarded service facade (${moves.length} move(s))`)
  dispose2()

  // ── 回归：宿主服务是类实例，insertBefore 是原型方法。模块提取方法后若不
  // 绑回接收者，严格模式 this=undefined → `reading 'manager'`（线上踩过）。
  class FakeManager {
    constructor(onMove) { this.onMove = onMove }
    async insertBefore(id, before) { return this.onMove(id, before) }
  }
  class FakeWorkspacesService {
    constructor(store, onMove) { this.list = store; this.manager = new FakeManager(onMove) }
    async insertBefore(id, before) {
      const result = await this.manager.insertBefore(id, before)
      if (!result.ok) throw new Error(`workspace reorder failed: ${result.error?.message ?? 'unknown'}`)
    }
  }
  moves.length = 0
  let current3 = items
  const workspaces3 = makeStore({ phase: 'ready', items })
  const sessions3 = makeStore({ phase: 'ready', byId: sessions.getSnapshot().byId })
  const service3 = new FakeWorkspacesService(workspaces3, (id, before) => {
    const ids = current3.map(row => row.workspaceId)
    const next = ids.filter(existing => existing !== id)
    const at = next.indexOf(before)
    if (at < 0) return { ok: false, error: { message: 'unknown anchor' } }
    next.splice(at, 0, id)
    current3 = next.map(key => items.find(row => row.workspaceId === key))
    workspaces3.set({ phase: 'ready', items: current3 })
    moves.push([id, before])
    return { ok: true }
  })
  const dispose3 = installWorkspaceRecencyOrder({ sessions: { list: sessions3 }, workspaces: service3 })
  await new Promise(resolve => setTimeout(resolve, 1000))
  const orderProto = current3.map(row => row.workspaceId).join(',')
  if (orderProto !== 'w-active,w-new,w-mid,w-old' || moves.length === 0) {
    throw new Error(`prototype-method service order unexpected: ${orderProto} (moves: ${JSON.stringify(moves)})`)
  }
  ok(`recency order: prototype service method stays bound (this-safe call, ${moves.length} move(s))`)
  dispose3()

  // ── 置顶分区：置顶段在前、普通段在后，各自跟时间；拖拽语义 ├──
  // 置顶区内拖动一次 → 固化自定义顺序；拖出 → 取消置顶。
  __setPinsForTests(null)
  moves.length = 0
  let current4 = items
  const workspaces4 = makeStore({ phase: 'ready', items })
  const sessions4 = makeStore({ phase: 'ready', byId: { ...sessions.getSnapshot().byId } })
  const insertBefore4 = async (id, before) => {
    const ids = current4.map(row => row.workspaceId)
    const next = ids.filter(existing => existing !== id)
    const at = before === undefined ? next.length : next.indexOf(before)
    if (at < 0) throw new Error(`unknown anchor ${JSON.stringify(before)}`)
    next.splice(at, 0, id)
    current4 = next.map(key => items.find(row => row.workspaceId === key))
    workspaces4.set({ phase: 'ready', items: current4 })
    moves.push([id, before])
  }
  // 预置：w-new、w-mid 已被置顶（time 模式）。
  __setPinsForTests({ v: 1, mode: 'time', order: ['w-new', 'w-mid'] })
  const dispose4 = installWorkspaceRecencyOrder({ sessions: { list: sessions4 }, workspaces: { list: workspaces4, insertBefore: insertBefore4 } })
  await new Promise(resolve => setTimeout(resolve, 1000))
  // time 模式下置顶区按各自时间排：w-new(1h 前) > w-mid(1d 前)；普通区 w-active > w-old。
  const orderPinnedBase = current4.map(row => row.workspaceId).join(',')
  if (orderPinnedBase !== 'w-new,w-mid,w-active,w-old') {
    throw new Error(`pinned (time mode) base order unexpected: ${orderPinnedBase} (moves: ${JSON.stringify(moves)})`)
  }
  if (getWorkspacePinSummary().mode !== 'time' || getWorkspacePinSummary().count !== 2) {
    throw new Error(`pin summary unexpected after base enforce: ${JSON.stringify(getWorkspacePinSummary())}`)
  }
  ok('pin sections: pinned block first in time mode, rest follows recency')

  // 用户把 w-active 拖到最顶（越过全部置顶项）→ 自动置顶并固化自定义顺序；
  // 落位与拖动结果一致，无需额外移动。
  current4 = ['w-active', 'w-new', 'w-mid', 'w-old'].map(key => items.find(row => row.workspaceId === key))
  workspaces4.set({ phase: 'ready', items: current4 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const summaryAfterDragUp = getWorkspacePinSummary()
  if (summaryAfterDragUp.mode !== 'custom' || summaryAfterDragUp.order.join(',') !== 'w-active,w-new,w-mid') {
    throw new Error(`drag-up pin intent wrong: ${JSON.stringify(summaryAfterDragUp)}`)
  }
  const orderAfterPin = current4.map(row => row.workspaceId).join(',')
  if (orderAfterPin !== 'w-active,w-new,w-mid,w-old') {
    throw new Error(`post-pin flat order moved unexpectedly: ${orderAfterPin} (moves: ${JSON.stringify(moves)})`)
  }
  ok('pin intent: dragging an unpinned workspace above the pinned block pins it in place')

  // 普通区时间抖动不应重排已固化的置顶顺序。
  sessions4.set({ ...sessions4.getSnapshot(), byId: { ...sessions4.getSnapshot().byId, 's-mid': { updatedAt: Date.now() } } })
  await new Promise(resolve => setTimeout(resolve, 900))
  const orderAfterChurn = current4.map(row => row.workspaceId).join(',')
  if (orderAfterChurn !== 'w-active,w-new,w-mid,w-old') {
    throw new Error(`custom pin order churned on session activity: ${orderAfterChurn}`)
  }
  ok('pin custom order survives session-activity churn')

  // 设置卡「恢复时间排序」→ w-mid（此刻最新）应回到置顶区最前。
  resetWorkspacePinOrder()
  await new Promise(resolve => setTimeout(resolve, 900))
  const orderAfterReset = current4.map(row => row.workspaceId).join(',')
  if (getWorkspacePinSummary().mode !== 'time') throw new Error('reset did not switch mode to time')
  if (orderAfterReset !== 'w-mid,w-active,w-new,w-old') {
    throw new Error(`reset-to-time order unexpected: ${orderAfterReset}`)
  }
  ok('pin reset: returns the pinned block to time ordering')

  // 把已置顶的 w-active 拖到普通项之下 → 取消置顶，并钉在落点（不回时间流）。
  current4 = ['w-mid', 'w-new', 'w-old', 'w-active'].map(key => items.find(row => row.workspaceId === key))
  workspaces4.set({ phase: 'ready', items: current4 })
  await new Promise(resolve => setTimeout(resolve, 900))
  const summaryAfterDragOut = getWorkspacePinSummary()
  if (summaryAfterDragOut.count !== 2 || !summaryAfterDragOut.order.includes('w-new') || !summaryAfterDragOut.order.includes('w-mid')) {
    throw new Error(`drag-out unpin wrong: ${JSON.stringify(summaryAfterDragOut)}`)
  }
  // 落点钉住：w-active 停在 w-old 之后，不会被时间（60s 前最新）提回上面。
  await new Promise(resolve => setTimeout(resolve, 900))
  const orderAfterUnpin = current4.map(row => row.workspaceId).join(',')
  if (orderAfterUnpin !== 'w-mid,w-new,w-old,w-active') {
    throw new Error(`post-unpin flat order unexpected: ${orderAfterUnpin} (moves: ${JSON.stringify(moves)})`)
  }
  if (getWorkspacePinSummary().dockedCount !== 1) {
    throw new Error(`drag-out dock not recorded: ${JSON.stringify(getWorkspacePinSummary())}`)
  }
  ok('pin intent: dragging a pinned workspace below the rest unpins it and docks it at the drop point')
  dispose4()
  __setPinsForTests(null)

  // ── 普通区拖动 = 钉在落点；其他项继续跟时间流动 ──
  moves.length = 0
  let current5 = items
  const workspaces5 = makeStore({ phase: 'ready', items })
  const sessions5 = makeStore({ phase: 'ready', byId: { ...sessions.getSnapshot().byId } })
  const insertBefore5 = async (id, before) => {
    const ids = current5.map(row => row.workspaceId)
    const next = ids.filter(existing => existing !== id)
    const at = before === undefined ? next.length : next.indexOf(before)
    if (at < 0) throw new Error(`unknown anchor ${JSON.stringify(before)}`)
    next.splice(at, 0, id)
    current5 = next.map(key => items.find(row => row.workspaceId === key))
    workspaces5.set({ phase: 'ready', items: current5 })
    moves.push([id, before])
  }
  __setPinsForTests({ v: 1, mode: 'time', order: ['w-new', 'w-mid'] })
  const dispose5 = installWorkspaceRecencyOrder({ sessions: { list: sessions5 }, workspaces: { list: workspaces5, insertBefore: insertBefore5 } })
  await new Promise(resolve => setTimeout(resolve, 1000))
  const dockBase = current5.map(row => row.workspaceId).join(',')
  if (dockBase !== 'w-new,w-mid,w-active,w-old') {
    throw new Error(`dock base order unexpected: ${dockBase} (moves: ${JSON.stringify(moves)})`)
  }

  // 用户把 w-active 拖到 w-old 之后（普通区内）→ 钉住，位置不回弹。
  current5 = ['w-new', 'w-mid', 'w-old', 'w-active'].map(key => items.find(row => row.workspaceId === key))
  workspaces5.set({ phase: 'ready', items: current5 })
  await new Promise(resolve => setTimeout(resolve, 900))
  if (current5.map(row => row.workspaceId).join(',') !== 'w-new,w-mid,w-old,w-active') {
    throw new Error(`dock drag did not stick: ${current5.map(row => row.workspaceId).join(',')}`)
  }
  if (getWorkspacePinSummary().dockedCount !== 1) {
    throw new Error(`dock not recorded: ${JSON.stringify(getWorkspacePinSummary())}`)
  }
  ok('dock: dragging within the normal section pins the workspace at the drop point')

  // 被钉住的 w-active 自己变成最新活动，也不会浮回去。
  sessions5.set({ ...sessions5.getSnapshot(), byId: { ...sessions5.getSnapshot().byId, 's-new': { updatedAt: Date.now() + 60_000 } } })
  await new Promise(resolve => setTimeout(resolve, 900))
  if (current5.map(row => row.workspaceId).join(',') !== 'w-new,w-mid,w-old,w-active') {
    throw new Error(`docked workspace floated on its own activity: ${current5.map(row => row.workspaceId).join(',')}`)
  }
  ok('dock: a docked workspace stays put even when its sessions go active')

  // 其他项的时间流动会绕过被钉住的项。
  sessions5.set({ ...sessions5.getSnapshot(), byId: { ...sessions5.getSnapshot().byId, 's-mid': { updatedAt: Date.now() + 120_000 } } })
  await new Promise(resolve => setTimeout(resolve, 900))
  if (current5.map(row => row.workspaceId).join(',') !== 'w-mid,w-new,w-old,w-active') {
    throw new Error(`pinned time churn unexpected: ${current5.map(row => row.workspaceId).join(',')}`)
  }
  ok('dock: the rest of the list keeps time-flowing around the docked item')

  // 「恢复时间排序」清掉手动定位 → 全列表回到纯时间序。
  resetWorkspacePinOrder()
  await new Promise(resolve => setTimeout(resolve, 900))
  if (getWorkspacePinSummary().dockedCount !== 0) {
    throw new Error(`reset did not clear docks: ${JSON.stringify(getWorkspacePinSummary())}`)
  }
  const afterDockReset = current5.map(row => row.workspaceId).join(',')
  // reset 保留置顶成员（w-new、w-mid 仍在置顶区，按时间 m > n），清掉定位后
  // 普通区按时间：w-active(+60s) > w-old(5d 前)。
  if (afterDockReset !== 'w-mid,w-new,w-active,w-old') {
    throw new Error(`post dock-reset order unexpected: ${afterDockReset}`)
  }
  ok('dock reset: clearing manual placement returns everything to time order')

  // 覆盖层指针拖拽的提交入口：拖 w-active 到最顶 → 置顶（与原生拖拽同一分类器）。
  beginWorkspaceDragHold()
  commitWorkspaceOrderIntent(['w-active', 'w-mid', 'w-new', 'w-old'])
  endWorkspaceDragHold()
  await new Promise(resolve => setTimeout(resolve, 900))
  const summaryAfterCommit = getWorkspacePinSummary()
  if (summaryAfterCommit.mode !== 'custom' || summaryAfterCommit.order[0] !== 'w-active') {
    throw new Error(`commit path pin wrong: ${JSON.stringify(summaryAfterCommit)}`)
  }
  const orderAfterCommit = current5.map(row => row.workspaceId).join(',')
  if (orderAfterCommit !== 'w-active,w-mid,w-new,w-old') {
    throw new Error(`commit path order unexpected: ${orderAfterCommit}`)
  }
  ok('commit entry: pointer-drop intents go through the same classifier')
  dispose5()
  __setPinsForTests(null)
  delete globalThis.document
} catch (error) {
  fail('workspace recency order', error)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nAll smoke checks passed.')
