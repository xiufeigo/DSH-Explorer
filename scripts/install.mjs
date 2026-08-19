#!/usr/bin/env node
/**
 * DSH-Explorer 自动安装器（幂等，可重复执行）。
 *
 * 流程：构建 + 自检 → 创建包解析 junction（profile 农场，有 checkout 再加 apps/cli）
 *      → 写入 profile patch 行 → （可选 --fork-width / --fork-ui）改 harness
 *      → 尽力而为的 HTTP 验证。Harness 不是硬性前置：Desktop 载荷下的
 *      dsh-base 没有 apps/cli，常规安装仍应成功。
 *
 * 用法：
 *   node scripts/install.mjs                      # 常规安装（幂等）
 *   node scripts/install.mjs --fork-width         # fork：放宽右侧栏宽度上限（改一行常量）
 *   node scripts/install.mjs --fork-ui            # fork：宽度上限 + 工作区顶部动作条座位
 *   node scripts/install.mjs --forks              # 同上（--fork-ui 别名）
 *   node scripts/install.mjs --rebuild            # 强制重新 pnpm install + build
 *   node scripts/install.mjs --profile <name>     # 目标 profile（默认 web）
 *   node scripts/install.mjs --harness <path>     # 手动指定 harness 路径
 *   node scripts/install.mjs --dry-run            # 只打印计划，不执行
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkPointsTo, locateHarness, shellLine } from './harness.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROW_ID = 'dsh-explorer'

// ── 参数解析 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const DRY = flag('--dry-run')
const wantWidthFork = flag('--fork-width') || flag('--fork-ui') || flag('--forks')
const wantSidebarFork = flag('--fork-ui') || flag('--forks')
const PROFILE = opt('--profile') ?? 'web'
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
// 包解析基准：DSH 的 junction 农场在 profiles/node_modules（所有 profile 共享），
// 个别部署可能用 per-profile 目录 —— 两个都探测/覆盖。
const FARM_DIR = join(DSH_HOME, 'profiles', 'node_modules')
const PROFILE_NODE_MODULES = join(PROFILE_DIR, 'node_modules')
const JUNCTION_BASES = [FARM_DIR, PROFILE_NODE_MODULES]

const log = (...parts) => console.log(...parts)
const step = (title) => console.log(`\n▶ ${title}`)

function run(cmd, args, cwd) {
  // 命令与参数均为脚本内固定 token（无用户输入），拼接后经 shell 执行；
  // 传字符串而非 (cmd, args[]) 可避免 Node 22 的 DEP0190 弃用警告。
  // @scope 包名加引号，避免 ComSpec 落到 PowerShell 时被当成 splat。
  return spawnSync(shellLine(cmd, args), { cwd, stdio: 'inherit', shell: true }).status
}

/** 执行或预演一句 shell 描述。 */
function exec(description, fn, dry = DRY) {
  if (dry) {
    log(`  [dry-run] ${description}`)
    return 0
  }
  return fn()
}

// ── 1. 定位 harness（fork / apps/cli junction 才需要） ─────────────────────
step('定位 deepseek-harness')
const harnessFlag = opt('--harness')
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
} else if (wantWidthFork || wantSidebarFork) {
  console.error('✘ 无法定位 deepseek-harness，而 --fork-width / --fork-ui 需要改它的源码')
  console.error('  请用 --harness <path> 指定 checkout 根目录（含 apps/cli 与 packages/client）')
  process.exit(1)
} else {
  log('  △ 未找到 harness checkout（本机 dsh-base 常指向 Desktop 载荷，没有 apps/cli）')
  log('  △ 仍会写入 profile 农场 junction + patch 行；CLI junction 与 fork 跳过')
  log('  △ 若要给本机 dsh web 打宽度/座位 fork，加 --harness <path> 或把仓库放在 deepseek-harness 隔壁')
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
if (!HAS_DEPS || flag('--rebuild')) {
  const code = exec('pnpm install', () => run('pnpm', ['install'], PROJECT_ROOT))
  if (code !== 0) process.exit(1)
} else {
  log('  node_modules 已存在')
}
if (!HAS_LIB || flag('--rebuild')) {
  const build = exec('pnpm run build', () => run('pnpm', ['run', 'build'], PROJECT_ROOT))
  if (build !== 0) process.exit(1)
} else {
  log('  lib/index.js + lib/client.js 已存在（--rebuild 可强制重建）')
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
const lines = patchText.split(/\r?\n/)

const rowIndex = lines.findIndex(line => /^\s*-\s*id:\s*dsh-explorer\s*$/.test(line))
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
    if (/^\s*disabled:\s*true\s*$/.test(lines[i])) disabledIndex = i
  }
  if (disabledIndex >= 0) {
    const apply = () => {
      lines.splice(disabledIndex, 1)
      writeFileSync(PATCH_PATH, lines.join('\n'))
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
    const body = patchText.trimEnd()
    // 卸载后可能留下合法空文档 `[]`；再拼一个 `- insert:` 会变成非法 YAML。
    const usable = body.length > 0 && body.trim() !== '[]'
    writeFileSync(PATCH_PATH, `${usable ? `${body}\n\n` : ''}${block.join('\n')}\n`)
  }
  exec('追加 dsh-explorer insert 块', apply)
  if (!DRY) log('  ✓ 已写入（watchUserPatches 会热重载组合）')
}

// ── 5. 可选：harness fork（宽度上限 + 工作区顶部动作条座位） ───────────────
const COLUMNS_PATH = harnessRoot === undefined
  ? ''
  : join(harnessRoot, 'packages', 'client', 'ui-layout', 'src', 'client', 'columns.ts')
const FORK_MARKER = 'FORK'
const SIDEBAR_DIR = harnessRoot === undefined
  ? ''
  : join(harnessRoot, 'packages', 'client', 'ui-sidebar', 'src', 'client')
const SEAT_KEY = 'sidebar.workspaces.actions'

/** 幂等文本补丁。返回 { status: 'already'|'applied' } 或 { error }。dry-run 不写盘。 */
function patchSource(filePath, marker, patchFn) {
  if (!existsSync(filePath)) return { error: `找不到 ${filePath}` }
  const original = readFileSync(filePath, 'utf8')
  if (original.includes(marker)) return { status: 'already' }
  const next = patchFn(original)
  if (next === original) return { error: `补丁未命中（上游源码可能已变）：${filePath}` }
  if (!next.includes(marker)) return { error: `补丁未写入标记 ${marker}：${filePath}` }
  if (DRY) {
    log(`  [dry-run] 写入 fork：${filePath}`)
    return { status: 'applied' }
  }
  writeFileSync(filePath, next)
  return { status: 'applied' }
}

function logPatchErrors(results) {
  for (const result of results) {
    if (result.error !== undefined) console.error(`  ✘ ${result.error}`)
  }
}

function allPatchesOk(results) {
  return results.every(result => result.error === undefined)
}

function anyPatchApplied(results) {
  return results.some(result => result.status === 'applied')
}

if (wantWidthFork) {
  step('fork：右侧栏宽度上限 + 宽度记忆（ui-layout）')
  const err = patchSource(COLUMNS_PATH, FORK_MARKER, (source) => {
    if (!/export const DETAILS_MAX = 520/.test(source)) {
      console.error('  ✘ 未找到 `export const DETAILS_MAX = 520`，源码可能已变化，请手动处理')
      return source
    }
    return source.replace(
      /\/\*\* Details drag clamp ceiling\. \*\/\s*\n\s*export const DETAILS_MAX = 520/,
      '/** Details drag clamp ceiling.\n *  FORK（本机部署改动，DSH-Explorer 依赖）：上游为 520，插件层无法绕过\n *  store 内钳制；升级 DSH 会覆盖，重新执行 `pnpm plugin:install --forks`\n *  即可恢复。实际渲染仍受列宽让步链约束（中心列保持 >= 640）。 */\nexport const DETAILS_MAX = 1200',
    )
  })
  // 宽度记忆：setDetails 落盘 + openDetails 恢复（marker: DETAILS_WIDTH_KEY）。
  const storesPath = join(harnessRoot, 'packages', 'client', 'ui-layout', 'src', 'client', 'stores.ts')
  const err2 = patchSource(storesPath, 'DETAILS_WIDTH_KEY', (source) => {
    const setNeedle = '      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },'
    const openNeedle = '      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },'
    if (!source.includes(setNeedle) || !source.includes(openNeedle)) return source
    let out = source.replace(
      setNeedle,
      '      // FORK（DSH-Explorer）：右侧栏宽度记忆 —— 拖拽落点写 localStorage。\n'
      + '      setDetails: (d, px: number) => {\n'
      + '        d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX)\n'
      + '        persistDetails(d.details)\n'
      + '      },',
    )
    out = out.replace(
      openNeedle,
      '      openDetails: (d) => { if (d.details === 0) d.details = readSavedDetails() },',
    )
    if (out === source) return source
    out += '\n\n// ── FORK（DSH-Explorer）：右侧栏宽度记忆 ────────────────────────────────────\n'
      + '// 升级 DSH 会覆盖；恢复见 DSH-Explorer/README.md。\n'
      + "const DETAILS_WIDTH_KEY = 'dsh-explorer:details-width'\n\n"
      + '/** 读取上次保存的 details 列宽（钳制进契约范围；无记录时回落默认值）。 */\n'
      + 'function readSavedDetails(): number {\n'
      + "  try {\n    if (typeof localStorage === 'undefined') return DETAILS_DEFAULT\n"
      + '    const raw = localStorage.getItem(DETAILS_WIDTH_KEY)\n'
      + '    if (raw === null) return DETAILS_DEFAULT\n'
      + '    const parsed = Number(raw)\n'
      + '    return Number.isFinite(parsed) && parsed > 0 ? clampWidth(parsed, DETAILS_MIN, DETAILS_MAX) : DETAILS_DEFAULT\n'
      + '  } catch {\n    return DETAILS_DEFAULT\n  }\n'
      + '}\n\n'
      + '/** 落盘一次拖拽结果（失败静默）。 */\n'
      + 'function persistDetails(px: number): void {\n'
      + "  try {\n    if (typeof localStorage !== 'undefined') localStorage.setItem(DETAILS_WIDTH_KEY, String(px))\n"
      + '  } catch {\n    // ignore\n  }\n'
      + '}\n'
    return out
  })
  logPatchErrors([err, err2])
  if (allPatchesOk([err, err2])) {
    log('  ✓ 宽度 fork 已就位')
    if (!anyPatchApplied([err, err2]) && !flag('--rebuild')) {
      log('  （源码已含 fork，跳过重建；若上次重建失败请加 --rebuild）')
    } else {
      const code = exec('重建 ui-layout 客户端 bundle', () => run('pnpm', ['--filter', '@deepseek-ai/dsh-client-ui-layout', 'run', 'bundle'], harnessRoot))
      if (code !== 0) process.exit(1)
    }
  } else {
    process.exit(1)
  }
} else if (harnessRoot !== undefined && existsSync(COLUMNS_PATH) && readFileSync(COLUMNS_PATH, 'utf8').includes(FORK_MARKER)) {
  log('  提示：宽度 fork 已就位（如需重新应用见 README）')
} else if (harnessRoot !== undefined) {
  log('  提示：如需"随意调整"右侧栏宽度，可加 --fork-width（改 harness 一行并重建）')
}

if (wantSidebarFork) {
  step('fork：工作区顶部动作条座位（sidebar.workspaces.actions）')
  const slotsPath = join(SIDEBAR_DIR, 'contract', 'slots.ts')
  const err1 = patchSource(slotsPath, SEAT_KEY, (source) => {
    const footer = "'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }"
    const props = "& PropsRenderSlots<'sidebar.workspaces' | 'sidebar.settings' | 'sidebar.footer.action'>"
    if (!source.includes(footer) || !source.includes(props)) return source
    let out = source.replace(
      footer,
      `${footer}\n`
      + "    /** FORK（本机部署改动，DSH-Explorer 依赖）：工作区上方动作条座位，见 README。 */\n"
      + "    'sidebar.workspaces.actions': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }",
    )
    out = out.replace(
      props,
      "& PropsRenderSlots<'sidebar.workspaces' | 'sidebar.workspaces.actions' | 'sidebar.settings' | 'sidebar.footer.action'>",
    )
    if (out.includes(props)) return source
    return out
  })
  const indexPath = join(SIDEBAR_DIR, 'index.ts')
  const err2 = patchSource(indexPath, SEAT_KEY, (source) => source.replace(
    "        'sidebar.workspaces': { kind: 'single', scope: 'root' },",
    "        'sidebar.workspaces': { kind: 'single', scope: 'root' },\n"
    + "        // FORK（DSH-Explorer）：工作区上方动作条座位。\n"
    + "        'sidebar.workspaces.actions': { kind: 'list', scope: 'root' },",
  ))
  const rootPath = join(SIDEBAR_DIR, 'SidebarRoot.tsx')
  const err3 = patchSource(rootPath, 'workspaceActions', (source) => source.replace(
    "      {/* The browsing region fills the column between the controls and the",
    "      {/* FORK（DSH-Explorer）：工作区上方的紧凑动作条（宽栏时渲染，\n"
    + "          空座位自动隐藏）。 */}\n"
    + "      {wide && (\n"
    + "        <div className={css.workspaceActions}>\n"
    + "          {renderSlot('sidebar.workspaces.actions', { wide })}\n"
    + "        </div>\n"
    + "      )}\n\n"
    + "      {/* The browsing region fills the column between the controls and the",
  ))
  const cssPath = join(SIDEBAR_DIR, 'SidebarRoot.module.css')
  const err4 = patchSource(cssPath, '.workspaceActions', (source) => source.replace(
    '.collapsed .regionArea {\n  margin-left: 0;\n  margin-right: 0;\n  padding-left: 0;\n}',
    '.collapsed .regionArea {\n  margin-left: 0;\n  margin-right: 0;\n  padding-left: 0;\n}\n\n'
    + '/* FORK（DSH-Explorer）：工作区上方动作条座位。空座位时整条隐藏。 */\n'
    + '.workspaceActions {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  padding: 0 4px 4px 4px;\n}\n'
    + '.workspaceActions:empty {\n  display: none;\n}',
  ))
  const sidebarResults = [err1, err2, err3, err4]
  logPatchErrors(sidebarResults)
  if (allPatchesOk(sidebarResults)) {
    log('  ✓ 顶部动作条座位 fork 已就位')
    if (!anyPatchApplied(sidebarResults) && !flag('--rebuild')) {
      log('  （源码已含 fork，跳过重建；若上次重建失败请加 --rebuild）')
    } else {
      const code = exec('重建 ui-sidebar 客户端 bundle', () => run('pnpm', ['--filter', '@deepseek-ai/dsh-client-ui-sidebar', 'run', 'bundle'], harnessRoot))
      if (code !== 0) process.exit(1)
    }
  } else {
    process.exit(1)
  }
} else if (harnessRoot !== undefined && existsSync(join(SIDEBAR_DIR, 'SidebarRoot.tsx')) && readFileSync(join(SIDEBAR_DIR, 'SidebarRoot.tsx'), 'utf8').includes('workspaceActions')) {
  log('  提示：顶部动作条座位 fork 已就位')
} else if (harnessRoot !== undefined) {
  log('  提示：如需"文件"按钮紧贴工作区（顶部动作条座位），加 --fork-ui（改 ui-sidebar 并重建）')
}

// ── 6. HTTP 验证（尽力而为） ───────────────────────────────────────────────
step('线上验证（尽力而为，不阻塞安装）')
const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const fetchOpts = { signal: AbortSignal.timeout(3500) }
try {
  const rpc = await fetch(`${base}/dsh-explorer/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-explorer': '1' },
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

// ── 完成 ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════')
console.log(DRY ? '  dry-run 结束（未做任何修改）' : '  安装完成')
console.log('  接下来：重启 dsh web → 刷新页面')
console.log('  确认：左侧栏 [工作区 | 文件] + 会话大纲 + 头部摘要/面板按钮')
console.log('  卸载：pnpm plugin:uninstall')
console.log('════════════════════════════════════════')
