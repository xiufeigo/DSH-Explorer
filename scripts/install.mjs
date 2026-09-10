#!/usr/bin/env node
/**
 * DSH-Explorer 自动安装器（幂等，可重复执行）。
 *
 * 流程：构建 + 自检 → 创建包解析 junction（profile 农场，有 checkout 再加 apps/cli）
 *      → 写入 profile patch 行 → 尽力而为的 HTTP 验证。Harness 不是硬性前置：
 *      Desktop 载荷下的 dsh-base 没有 apps/cli，常规安装仍应成功。
 *
 * 用法：
 *   node scripts/install.mjs                      # 常规安装（幂等）
 *   node scripts/install.mjs --rebuild            # 强制重新 pnpm install + build
 *   node scripts/install.mjs --profile <name>     # 目标 profile（默认 web）
 *   node scripts/install.mjs --harness <path>     # 手动指定 harness 路径
 *   node scripts/install.mjs --dry-run            # 只打印计划，不执行
 */

import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  linkPointsTo, locateHarness, log, makeExec, parseArgs,
  profilePaths, resolveDshHome, run, step,
} from './harness.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROW_ID = 'dsh-explorer'

// ── 参数解析（共享实现见 harness.mjs） ─────────────────────────────────────
const { flag, opt, requireValue } = parseArgs({
  argv: process.argv.slice(2),
  known: new Set([
    '--dry-run', '--rebuild', '--profile', '--harness',
  ]),
  usage: '--dry-run --rebuild --profile <name> --harness <path>',
})
const DRY = flag('--dry-run')
const harnessFlag = opt('--harness')
requireValue('--harness', harnessFlag)
const PROFILE = opt('--profile') ?? 'web'
requireValue('--profile', opt('--profile'))
// DSH_HOME 缺失时的防呆在共享 resolveDshHome 里（不再静默落相对路径）。
const DSH_HOME = resolveDshHome()
const { profileDir: PROFILE_DIR, patchPath: PATCH_PATH, junctionBases: JUNCTION_BASES } = profilePaths(DSH_HOME, PROFILE)

const exec = makeExec(DRY)

// ── 1. 定位 harness（apps/cli junction 才需要） ────────────────────────────
step('定位 deepseek-harness')
const harnessRoot = locateHarness({
  explicit: harnessFlag,
  projectRoot: PROJECT_ROOT,
  junctionBases: JUNCTION_BASES,
})
if (harnessFlag !== undefined && harnessRoot === undefined) {
  console.error(`✘ --harness 不是有效的 deepseek-harness checkout：${resolve(harnessFlag)}`)
  console.error('  需要包含 apps/cli 与 packages/client 的目录')
  process.exit(1)
}
if (harnessRoot !== undefined) {
  log(`  已定位：${harnessRoot}`)
} else {
  log('  △ 未找到 harness checkout（本机 dsh-base 常指向 Desktop 载荷，没有 apps/cli）')
  log('  △ 仍会写入 profile 农场 junction + patch 行；CLI junction 跳过')
}
const CLI_NODE_MODULES = harnessRoot === undefined
  ? null
  : join(harnessRoot, 'apps', 'cli', 'node_modules')

// ── 2. 构建 + 自检 ─────────────────────────────────────────────────────────
step('构建产物检查')
const LIB_INDEX = join(PROJECT_ROOT, 'lib', 'index.js')
const LIB_CLIENT = join(PROJECT_ROOT, 'lib', 'client.js')
const HAS_LIB = existsSync(LIB_INDEX) && existsSync(LIB_CLIENT)
const HAS_DEPS = existsSync(join(PROJECT_ROOT, 'node_modules', 'react'))

/** src 里最新文件的 mtime（递归）；目录不存在返回 0。 */
function newestMtimeMs(dir) {
  if (!existsSync(dir)) return 0
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      if (entry.isFile()) {
        const mtime = statSync(full).mtimeMs
        if (mtime > newest) newest = mtime
      }
    }
  }
  return newest
}
/** 陈旧产物检测：src 比任一 lib 产物新 → 不能拿旧 bundle 直接上线。
 *  package.json 也算构建输入（exports/files/dsh 元数据进 bundle 语义）。 */
function libIsStale() {
  if (!HAS_LIB) return false
  const configPath = join(PROJECT_ROOT, 'tsdown.config.ts')
  const configMtime = existsSync(configPath) ? statSync(configPath).mtimeMs : 0
  const pkgPath = join(PROJECT_ROOT, 'package.json')
  const pkgMtime = existsSync(pkgPath) ? statSync(pkgPath).mtimeMs : 0
  const srcMtime = Math.max(newestMtimeMs(join(PROJECT_ROOT, 'src')), configMtime, pkgMtime)
  const libMtime = Math.min(statSync(LIB_INDEX).mtimeMs, statSync(LIB_CLIENT).mtimeMs)
  return srcMtime > libMtime
}
const STALE = HAS_LIB && libIsStale()

if (!HAS_DEPS || flag('--rebuild')) {
  const code = exec('pnpm install', () => run('pnpm', ['install'], PROJECT_ROOT))
  if (code !== 0) process.exit(1)
} else {
  log('  node_modules 已存在')
}
if (!HAS_LIB || flag('--rebuild') || STALE) {
  if (STALE) log('  lib/ 落后于 src/（或 tsdown.config.ts / package.json），重新构建')
  const build = exec('pnpm run build', () => run('pnpm', ['run', 'build'], PROJECT_ROOT))
  if (build !== 0) process.exit(1)
} else {
  log('  lib/index.js + lib/client.js 已存在且与 src 同步（--rebuild 可强制重建）')
}

step('冒烟自检（真实执行两个 bundle）')
if (exec('pnpm run verify', () => run('pnpm', ['run', 'verify'], PROJECT_ROOT)) !== 0) {
  console.error('✘ 自检未通过，终止安装')
  process.exit(1)
}

// ── 3. 包解析 junction ─────────────────────────────────────────────────────
step('创建包解析 junction')
function linkInfo(path) {
  try {
    const stat = lstatSync(path)
    return { exists: true, isLink: stat.isSymbolicLink() }
  } catch {
    return { exists: false, isLink: false }
  }
}

function ensureJunction(link, target) {
  const info = linkInfo(link)
  if (info.exists) {
    let pointsHere = false
    try { pointsHere = linkPointsTo(link, target) } catch { /* 普通目录或坏链 */ }
    if (pointsHere) {
      log(`  ✓ 已存在且指向正确：${link}`)
      return true
    }
    console.error(`  ✘ ${link} 已存在但指向别处（或不是链接）`)
    console.error('    请手动处理后再装（本安装器不会删除非本项目的路径）')
    return false
  }
  if (DRY) {
    log(`  [dry-run] 创建 junction：${link} -> ${target}`)
    return true
  }
  try {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'junction')
    log(`  ✓ 已创建：${link}`)
    return true
  } catch (error) {
    console.error(`  ✘ 创建失败：${error.message}`)
    console.error('    （Windows 需要目录 junction；请确认有权限）')
    return false
  }
}

let ok = true
for (const base of JUNCTION_BASES) {
  ok = ensureJunction(join(base, ROW_ID), PROJECT_ROOT) && ok
}
if (CLI_NODE_MODULES !== null) {
  ok = ensureJunction(join(CLI_NODE_MODULES, ROW_ID), PROJECT_ROOT) && ok
}
if (!ok) process.exit(1)

// ── 4. profile patch 行 ────────────────────────────────────────────────────
step(`写入插件行：${PATCH_PATH}`)
if (!existsSync(PATCH_PATH)) {
  console.error(`✘ 找不到 ${PATCH_PATH}（profile "${PROFILE}" 不存在？用 --profile 指定）`)
  process.exit(1)
}
const patchText = readFileSync(PATCH_PATH, 'utf8')
const EOL = patchText.includes('\r\n') ? '\r\n' : '\n'
const lines = patchText.split(/\r?\n/)
// 放宽到引号与行尾注释变体（手写 `id: "dsh-explorer"` 也算已在），避免重复块。
const ROW_RE = /^\s*-\s*id:\s*["']?dsh-explorer["']?\s*(#.*)?$/

const rowIndex = lines.findIndex(line => ROW_RE.test(line))
if (rowIndex >= 0) {
  // 已存在：扫完整子块（缩进更深的续行），若被禁用则重新启用。
  const rowIndent = (lines[rowIndex].match(/^\s*/)?.[0] ?? '').length
  let end = rowIndex + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') { end++; continue }
    const indent = (line.match(/^\s*/)?.[0] ?? '').length
    if (indent > rowIndent) { end++; continue }
    break
  }
  let disabledIndex = -1
  for (let i = rowIndex; i < end; i++) {
    // 放宽行内注释：`disabled: true  # 暂时停用` 也要能识别并重新启用。
    if (/^\s*disabled:\s*true\s*(#.*)?$/.test(lines[i])) disabledIndex = i
  }
  if (disabledIndex >= 0) {
    const apply = () => {
      const current = readFileSync(PATCH_PATH, 'utf8')
      if (current !== patchText) throw new Error('patch 文件在读取后被改动，放弃写入（请重试）')
      lines.splice(disabledIndex, 1)
      writeFileSync(PATCH_PATH, lines.join(EOL))
    }
    exec(`移除 dsh-explorer 行的 disabled: true`, apply)
    if (!DRY) log('  ✓ 已重新启用插件行')
  } else {
    log('  ✓ 插件行已存在且已启用')
  }
} else {
  const block = [
    '- insert:',
    '    # DSH-Explorer 插件行（由 scripts/install.mjs 写入，卸载时自动移除）',
    '    - id: dsh-explorer',
    '      name: dsh-explorer',
  ]
  const apply = () => {
    const current = readFileSync(PATCH_PATH, 'utf8')
    if (current !== patchText) throw new Error('patch 文件在读取后被改动，放弃写入（请重试）')
    const body = patchText.trimEnd()
    // 卸载后可能留下合法空文档 `[]`；再拼一个 `- insert:` 会变成非法 YAML。
    const usable = body.length > 0 && body.trim() !== '[]'
    writeFileSync(PATCH_PATH, `${usable ? `${body}${EOL}${EOL}` : ''}${block.join(EOL)}${EOL}`)
  }
  exec('追加 dsh-explorer insert 块', apply)
  if (!DRY) log('  ✓ 已写入（watchUserPatches 会热重载组合）')
}

// ── 5. HTTP 验证（尽力而为；dry-run 不发真实请求） ─────────────────────────
step('线上验证（尽力而为，不阻塞安装）')
if (DRY) {
  log('  [dry-run] 跳过线上验证')
} else {
  const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
  // 新闸要求同源回环 Origin；探测请求按真实客户端语义带上。
  const origin = new URL(base).origin
  const fetchOpts = { signal: AbortSignal.timeout(3500) }
  try {
    const rpc = await fetch(`${base}/dsh-explorer/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-explorer': '1', origin },
      body: JSON.stringify({ sessionId: 'install-check', method: 'session.meta', args: {} }),
      ...fetchOpts,
    })
    if (rpc.status === 200) {
      log(`  ✓ Host RPC 路由已挂载（${base}/dsh-explorer/rpc）`)
    } else {
      log(`  △ Host RPC 路由返回 ${rpc.status}：若为首次安装，请重启 dsh web`)
    }
  } catch {
    log(`  △ 无法访问 ${base}：请重启 dsh web 后按 README 验证`)
  }
  try {
    const bundle = await fetch(`${base}/plugins/dsh-explorer/client.js`, fetchOpts)
    const head = (await bundle.text()).slice(0, 40)
    if (bundle.status === 200 && head.includes('__ModuleLoader__')) {
      log('  ✓ 浏览器 bundle 已在服务（/plugins/dsh-explorer/client.js）')
    } else {
      log('  △ 浏览器 bundle 未就绪：重启 dsh web 后刷新页面')
    }
  } catch {
    log('  △ 无法访问 bundle 路由（见上）')
  }
}

// ── 完成 ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════')
console.log(DRY ? '  dry-run 结束（未做任何修改）' : '  安装完成')
console.log('  接下来：重启 dsh web → 刷新页面')
console.log('  确认：会话头终端按钮 + 左侧栏工作区排序/置顶')
console.log('  卸载：pnpm plugin:uninstall')
console.log('════════════════════════════════════════')
