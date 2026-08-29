/**
 * 载荷自愈钩子（hook 工具）：插件启动时检测并修补 DSH 客户端载荷。
 *
 * 背景：桌面壳每次更新都会用 npm 载荷整体覆盖 `@deepseek-ai/*`，本仓库
 * 靠源码 fork（`pnpm plugin:install --forks`）维护的改动随之丢失。桌面壳
 * titlebar.js 的运行时改写也救不了：client-modules 系统启动时会用
 * `target.load = (registration) => …` 原地接管队列 loader，把注入的包装
 * 整个冲掉，动态加载的 ui-layout 永远走不到改写逻辑 —— 表现为右侧栏
 * 拖宽被上游的 `clampWidth(…, 300, 520)` 卡回 520px。
 *
 * 方案：把修复挂在**插件启动**上。dsh-explorer 的 host 半边在 dsh web /
 * 桌面壳进程里 apply 时，页面还没拉过任何客户端 bundle，此时直接把磁盘上
 * 的 `ui-layout/lib/client.js` 补好（幂等、留原始备份、失败绝不阻塞插件）。
 * 之后每次更新载荷，重启壳即自动重打。
 *
 * 结构上是通用的小型 fork 注册表：每条 ForkSpec 声明定位方式与文本重写，
 * 未来要补别的座位 / 常量（例如 ui-sidebar 的动作条座位）加一条即可。
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * 宽度上限契约：这里的 1200 与 src/client/detailsWidth.ts 的 DETAILS_MAX
 * 必须一致（客户端按它记忆拖拽宽度，host 自愈按它重写钳制点位），
 * 改动时两边同步。
 */
export function forkMarkerFor(max: number): string {
  return `/* dsh-explorer payload fork: details clamp 300..${max} (self-healing at plugin startup) */`
}

/** 已打过补丁的文件尾部标记；同时是幂等跳过的判据。1200 ↔ src/client/detailsWidth.ts DETAILS_MAX。 */
export const FORK_MARKER = forkMarkerFor(1200)

export interface PayloadForkIo {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, text: string): void
  rename(from: string, to: string): void
  /** 可选：清理临时文件。缺省时跳过清理，不影响主流程。 */
  remove?(path: string): void
}

export const defaultIo: PayloadForkIo = {
  exists: existsSync,
  read: path => readFileSync(path, 'utf8'),
  write: (path, text) => writeFileSync(path, text, 'utf8'),
  rename: (from, to) => renameSync(from, to),
  remove: path => rmSync(path, { force: true }),
}

export interface PayloadForkOptions {
  /** 右侧栏宽度上限；与 src/client/detailsWidth.ts 的 DETAILS_MAX 契约一致。 */
  max?: number
  /** 显式候选起点目录（测试或特殊部署）；缺省从进程运行位置推断。 */
  bases?: string[]
  io?: PayloadForkIo
  /** 定位成功后的回调（测试断言用）。 */
  onLocated?: (path: string) => void
}

export interface PayloadForkStatus {
  status: 'patched' | 'already' | 'missing' | 'skipped' | 'failed'
  /** 命中或尝试的 bundle 路径（missing 时缺省）。 */
  path?: string
  /** patched：替换的钳制点位数；其它状态给一句原因。 */
  sites?: number
  reason?: string
}

/**
 * 从一个起点目录向上找 `node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`。
 * 覆盖三类布局：桌面载荷（…/payload/app）、仓库开发载荷、本地 harness checkout。
 */
function climbForBundle(start: string, io: PayloadForkIo): string | undefined {
  let dir = start
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js')
    if (io.exists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** 汇总 bundle 候选：环境覆盖 → require.resolve(argv 入口) → cwd / execPath / argv 向上爬。 */
export function locateLayoutBundle(io: PayloadForkIo = defaultIo, extraBases: readonly string[] = []): string | undefined {
  const bases: string[] = []

  // 本插件的显式覆盖（分号分隔多个根）。
  const envRoot = process.env.DSH_EXPLORER_PAYLOAD_ROOT
  if (envRoot !== undefined && envRoot.length > 0) bases.push(...envRoot.split(';').filter(row => row.length > 0))

  // 桌面壳自己的覆盖变量（main.rs payload_root()），指向载荷根而非 app 目录。
  const shellRoot = process.env.DSH_PAYLOAD_DIR
  if (shellRoot !== undefined && shellRoot.length > 0) {
    bases.push(join(shellRoot, 'app'), join(shellRoot, 'payload', 'app'), shellRoot)
  }

  bases.push(...extraBases)

  // 显式覆盖（env / extraBases）优先于 Node 解析：多载荷共存时，
  // require.resolve 可能抢先命中另一份 bundle，覆盖必须说了算。
  for (const base of bases) {
    const found = climbForBundle(base, io)
    if (found !== undefined) return found
  }

  // 最稳的一条：从 CLI 入口（bin.js）按 Node 解析规则找，与服务器模块表同源。
  try {
    const entry = process.argv[1]
    if (entry !== undefined && entry.length > 0) {
      const resolved = createRequire(entry).resolve('@deepseek-ai/dsh-client-ui-layout/package.json')
      const bundle = join(dirname(resolved), 'lib', 'client.js')
      if (io.exists(bundle)) return bundle
    }
  } catch {
    // 解析不到（未安装 / 纯源码 checkout）时落到目录爬取。
  }

  const starts = [
    process.cwd(),
    process.argv[1] !== undefined ? dirname(process.argv[1]) : '',
    dirname(process.execPath),
    join(dirname(process.execPath), '..', 'app'),
  ].filter(row => row.length > 0)

  for (const start of starts) {
    const found = climbForBundle(start, io)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 纯函数：把 bundle 文本里的 520 钳制改成 max。返回 null 表示没有可命中点位
 * （源码 fork 已存在 / 上游结构变化），调用方据此跳过而不是盲写。
 * 默认 1200 ↔ src/client/detailsWidth.ts 的 DETAILS_MAX。
 */
export function rewriteClampSites(source: string, max = 1200, fromMax = 520): { text: string; sites: number } | null {
  // 入口防守：非有限数字会拼出畸形正则与输出文本，直接按无点位处理。
  if (!Number.isFinite(max) || !Number.isFinite(fromMax)) return null
  // 每次调用用全新正则，避免 /g 的 lastIndex 跨调用串状态。
  const pattern = new RegExp(`\\bclampWidth\\((px|details),\\s*300,\\s*${fromMax}\\)`, 'g')
  let sites = 0
  const text = source.replace(pattern, match => {
    sites++
    return match.replace(new RegExp(`${fromMax}\\s*\\)$`), `${max})`)
  })
  if (sites === 0) return null
  const oldMarkerRegex = /\/\* dsh-explorer payload fork: details clamp 300\.\.\d+ \(self-healing at plugin startup\) \*\/\n?/g
  const cleaned = text.replace(oldMarkerRegex, '').trimEnd()
  return { text: `${cleaned}\n${forkMarkerFor(max)}\n`, sites }
}

/**
 * 启动钩子入口：定位 → 幂等修补。任何一步失败都只记录，不抛出 ——
 * 插件加载永远优先于可选的宽度修复。
 */
export function applyPayloadFork(options: PayloadForkOptions = {}): PayloadForkStatus {
  const io = options.io ?? defaultIo
  // 缺省 1200 ↔ src/client/detailsWidth.ts 的 DETAILS_MAX。
  const max = options.max ?? 1200
  let path: string | undefined
  try {
    path = locateLayoutBundle(io, options.bases)
    if (path === undefined) {
      return { status: 'missing', reason: '未找到 @deepseek-ai/dsh-client-ui-layout/lib/client.js（纯 web 部署或尚未安装载荷）' }
    }
    options.onLocated?.(path)

    const source = io.read(path)
    const existingMarkerMatch = source.match(/\/\* dsh-explorer payload fork: details clamp 300\.\.(\d+) \(self-healing at plugin startup\) \*\//)
    let fromMax = 520
    if (existingMarkerMatch !== null) {
      const existingMax = Number(existingMarkerMatch[1])
      if (existingMax === max) {
        return { status: 'already', path }
      }
      fromMax = existingMax
    }

    const rewritten = rewriteClampSites(source, max, fromMax)
    if (rewritten === null) {
      if (existingMarkerMatch !== null) {
        return { status: 'skipped', path, reason: `已存在补丁标记（max=${existingMarkerMatch[1]}）但未找到 300–${fromMax} 钳制点位` }
      }
      return { status: 'skipped', path, reason: 'bundle 中没有 300–520 钳制点位（可能已是源码 fork 或上游结构变化）' }
    }

    // 原始备份只写一次：卸载 / 排查时可手工还原。
    const backup = `${path}.dshx-orig`
    if (!io.exists(backup)) io.write(backup, source)

    // 同盘临时文件 + 原子换名，避免半截文件被服务器读出去。
    const tmp = `${path}.dshx-tmp`
    io.write(tmp, rewritten.text)
    try {
      io.rename(tmp, path)
    } catch {
      // 换名失败：放弃本次写入（绝不直写——目标文件可能正被服务器读取，
      // 直写有截断风险）。保留原文件，下次启动自愈会重试；尽力清掉临时文件。
      try { io.remove?.(tmp) } catch { /* 尽力清理 */ }
      return { status: 'failed', path, reason: '重命名失败，保持原文件待下次自愈' }
    }
    return { status: 'patched', path, sites: rewritten.sites }
  } catch (error) {
    return { status: 'failed', path, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 进程级一次性闸：cordis 可能因插件热载重复 apply，补丁本身幂等，
 * 但日志不该刷屏。
 */
let ranOnce = false

/** apply() 里调用的包装：只在首次执行真正的检查，其余静默跳过。 */
export function runPayloadForkOnce(options: PayloadForkOptions = {}): PayloadForkStatus | undefined {
  if (ranOnce) return undefined
  ranOnce = true
  return applyPayloadFork(options)
}
