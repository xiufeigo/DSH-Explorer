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
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('webServer')) {
    throw new Error(`host plugin inject must include webServer (got ${JSON.stringify(plugin.inject)})`)
  }
  ok(`host half: require("dsh-explorer") exposes { inject: [${plugin.inject.join(', ')}], apply }`)

  const registered = []
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: () => () => {} }
      if (name === 'fs') return {}
      if (name === 'shell') return {}
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'settings') {
        return {
          register(ns, schema, options) {
            registered.push({ ns, schema, options })
            return { get: () => ({}), watch: () => () => {}, update: async () => {}, replace: async () => {} }
          },
        }
      }
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('settings')) callback(ctx)
      return () => {}
    },
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on() { return () => {} },
  }
  plugin.apply(ctx)
  const ns = registered.find(row => row.ns === 'dsh-explorer')
  if (ns === undefined) throw new Error('host apply did not settings.register("dsh-explorer")')
  if (typeof ns.schema !== 'function') throw new Error('explorer settings schema is not callable')
  if (typeof ns.schema.toJSON !== 'function') throw new Error('explorer settings schema missing toJSON')
  const parsed = ns.schema({})
  if (parsed.termTheme !== 'auto' || parsed.termFontSize !== 13) {
    throw new Error(`schema defaults unexpected: ${JSON.stringify(parsed)}`)
  }
  ok('host half: settings.register("dsh-explorer") with callable schema')
} catch (error) {
  fail('host half import', error)
}

// ── 2. Browser half ────────────────────────────────────────────────────────
try {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
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
  pluginModule.apply({
    get: () => undefined,
    effect: (cb) => {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    slots,
    sessions: {},
    workspaces: { openPath: async () => {} },
    layout: {},
  })
  slots.declare('settings.plugin.item', { kind: 'keyed', scope: 'root' })
  const card = slots.registers.find(row => row.options.name === 'settings.plugin.item' && row.options.key === 'dsh-explorer')
  if (card === undefined) throw new Error('missing settings.plugin.item key=dsh-explorer')
  if (card.options.id !== 'dsh-explorer') throw new Error('settings.plugin.item should also carry id=dsh-explorer')
  ok('settings slots: plugin.item card registers with key+id=dsh-explorer')
} catch (error) {
  fail('browser half evaluation', error)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}

// ── 3. RPC 跨站防护闸 ─────────────────────────────────────────────────────
// handleRpc 的前置分支不依赖任何服务，可以纯 mock 直测：
// 同源 OPTIONS 放行、跨源 OPTIONS 拒绝、无校验头的 POST 拒绝。
try {
  const { handleRpc } = require('dsh-explorer')
  if (typeof handleRpc !== 'function') throw new Error('handleRpc not exported')

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
    const res = { statusCode: 0, headers: {}, body: '' }
    res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers) }
    res.end = (text) => { res.body = String(text ?? '') }
    return res
  }
  const noServices = { sessions: { get: () => undefined } }

  {
    const res = makeRes()
    await handleRpc(makeReq('OPTIONS', { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, null), res, noServices, new Map())
    if (res.statusCode !== 204) throw new Error(`same-origin OPTIONS expected 204, got ${res.statusCode}`)
    ok('rpc gate: same-origin OPTIONS preflight → 204')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('OPTIONS', { origin: 'https://evil.example', host: '127.0.0.1:3080' }, null), res, noServices, new Map())
    if (res.statusCode !== 403) throw new Error(`cross-origin OPTIONS expected 403, got ${res.statusCode}`)
    ok('rpc gate: cross-origin OPTIONS → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json' }, '{"method":"fs.list"}'), res, noServices, new Map())
    if (res.statusCode !== 403) throw new Error(`header-less POST expected 403, got ${res.statusCode}`)
    ok('rpc gate: POST without x-dsh-explorer header → 403')
  }
  {
    const res = makeRes()
    await handleRpc(makeReq('POST', { 'content-type': 'application/json', 'x-dsh-explorer': '1' }, '{"sessionId":"nope","method":"fs.list"}'), res, noServices, new Map())
    if (res.statusCode !== 200) throw new Error(`gated POST expected 200, got ${res.statusCode}`)
    if (!res.body.includes('会话不存在')) throw new Error(`gated POST body unexpected: ${res.body}`)
    ok('rpc gate: POST with header reaches dispatch (session guard answers)')
  }
} catch (error) {
  fail('rpc gate checks', error)
  process.exit(1)
}

console.log('\nAll smoke checks passed.')
