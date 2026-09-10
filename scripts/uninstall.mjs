#!/usr/bin/env node
/**
 * DSH-Explorer 卸载器（幂等，可重复执行）。
 *
 * 流程：移除 profile patch 里的插件行（热重载生效）→ 删除两个包解析 junction
 *      → 若 harness 含本安装器写入的宽度 FORK 与顶部动作条座位 FORK 标记，
 *        默认回退并重建（--keep-fork 全部保留）。回退前留 .dshx-orig 备份。
 *
 * 用法：
 *   node scripts/uninstall.mjs            # 完整卸载
 *   node scripts/uninstall.mjs --keep-fork # 保留 harness fork 改动
 *   node scripts/uninstall.mjs --dry-run   # 只打印计划，不执行
 */

import {
  existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atomicWrite, backupOnce, linkPointsTo, locateHarness, log, makeExec, parseArgs,
  profilePaths, resolveDshHome, run, sameResolved, step, stripNtPrefix,
} from './harness.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROW_ID = 'dsh-explorer'

// ── 参数解析（共享实现见 harness.mjs） ─────────────────────────────────────
const { flag, opt, requireValue } = parseArgs({
  argv: process.argv.slice(2),
  known: new Set(['--keep-fork', '--dry-run', '--profile', '--harness']),
  usage: '--keep-fork --dry-run --profile <name> --harness <path>',
})
const DRY = flag('--dry-run')
const harnessFlag = opt('--harness')
requireValue('--harness', harnessFlag)
const PROFILE = opt('--profile') ?? 'web'
requireValue('--profile', opt('--profile'))
// DSH_HOME 缺失时的防呆在共享 resolveDshHome 里（与安装器同一规则）。
const DSH_HOME = resolveDshHome()
// 与安装器一致的解析基准：junction 农场（profiles/node_modules）优先，兼容 per-profile 目录。
const { profileDir: PROFILE_DIR, patchPath: PATCH_PATH, junctionBases: JUNCTION_BASES } = profilePaths(DSH_HOME, PROFILE)

const exec = makeExec(DRY)
// 卸载结束时汇总的残留提示（fork 回退未命中等）。
const residueWarnings = []

const harnessRoot = locateHarness({
  explicit: harnessFlag,
  projectRoot: PROJECT_ROOT,
  junctionBases: JUNCTION_BASES,
})
if (harnessFlag !== undefined && harnessRoot === undefined) {
  console.error(`✘ --harness 不是有效的 deepseek-harness checkout：${resolve(harnessFlag)}`)
  process.exit(1)
}

// ── 1. 移除 profile patch 行 ───────────────────────────────────────────────
step(`移除插件行：${PATCH_PATH}`)
if (!existsSync(PATCH_PATH)) {
  log('  △ patch 文件不存在，跳过（可能已卸载）')
} else {
  const text = readFileSync(PATCH_PATH, 'utf8')
  const EOL = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  // 放宽到引号与行尾注释变体，避免手写 `id: "dsh-explorer"` 删不掉。
  const ROW_RE = /^\s*-\s*id:\s*["']?dsh-explorer["']?\s*(#.*)?$/
  const rowIndex = lines.findIndex(line => ROW_RE.test(line))
  if (rowIndex < 0) {
    log('  ✓ 插件行不存在（已卸载）')
  } else {
    const rowIndent = (lines[rowIndex].match(/^\s*/)?.[0] ?? '').length

    // 向下：包含续行（缩进更深）与紧邻空行。
    let end = rowIndex + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') { end++; continue }
      const indent = (line.match(/^\s*/)?.[0] ?? '').length
      if (indent > rowIndent) { end++; continue }
      break
    }
    // 向上：吞掉紧邻该行的注释块。
    let start = rowIndex
    while (start > 0 && lines[start - 1].trim().startsWith('#')) start--
    // 修剪行尾多余空行。
    while (end > rowIndex + 1 && lines[end - 1].trim() === '') end--

    const applyRemove = () => {
      const current = readFileSync(PATCH_PATH, 'utf8')
      if (current !== text) throw new Error('patch 文件在读取后被改动，放弃写入（请重试）')
      lines.splice(start, end - start)
      // 若所在 insert 块已无子行，连 insert 行一并移除。向上有界探测，
      // 跳过空行与注释（避免中间隔注释时留下 `insert: null`）。
      const insertIndex = (() => {
        for (let i = start - 1; i >= Math.max(0, start - 6); i--) {
          const trimmed = lines[i].trim()
          if (trimmed === '' || trimmed.startsWith('#')) continue
          // 放宽行内注释与空格变体：`- insert:  # 说明` 也算 insert 行。
          if (/^\s*-\s*insert:\s*(#.*)?$/.test(lines[i])) return i
          break
        }
        return -1
      })()
      if (insertIndex >= 0) {
        let hasChild = false
        for (let i = insertIndex + 1; i < lines.length; i++) {
          const line = lines[i]
          if (line.trim() === '' || line.trim().startsWith('#')) continue
          if (/^-\s+/.test(line)) break // 下一个顶层条目
          if (/^\s+-\s+id:/.test(line)) { hasChild = true; break }
        }
        if (!hasChild) {
          // 只删空的 insert 条目，不动文件头注释（否则会把 DSH 自带说明一并吃掉）。
          lines.splice(insertIndex, 1)
        }
      }
      const cleaned = lines.join(EOL).replace(/(\r?\n){3,}/g, `${EOL}${EOL}`).trimEnd()
      writeFileSync(PATCH_PATH, cleaned.length > 0 ? `${cleaned}${EOL}` : `[]${EOL}`)
    }
    exec('移除 dsh-explorer 行（含注释与空 insert 块）', applyRemove)
    if (!DRY) log('  ✓ 已移除（watchUserPatches 热重载，Host 路由随即下线）')
  }
}

// ── 2. 删除包解析 junction ─────────────────────────────────────────────────
step('删除包解析 junction')
/**
 * removeJunction 的兜底判定：链接目标无法经 linkPointsTo 解析到本项目时
 *（死链、NT 前缀变体等），读 readlink 原始文本——剥净 `\\?\` / `\??\`
 * 前缀后按链接所在目录 resolve：resolve 相等或以项目 basename 结尾即视为
 * 指向本项目（目标已不存在的死链同样适用）。
 */
function rawLinkPointsToProject(link) {
  let raw
  try { raw = readlinkSync(link) } catch { return false }
  const cleaned = stripNtPrefix(raw).trim()
  if (cleaned.length === 0) return false
  const resolved = resolve(dirname(link), cleaned)
  if (sameResolved(resolved, PROJECT_ROOT)) return true
  const base = basename(PROJECT_ROOT).toLowerCase()
  const lower = resolved.toLowerCase()
  return lower.endsWith(`${sep}${base}`) || lower.endsWith(`/${base}`)
}

function removeJunction(link) {
  try {
    const stat = lstatSync(link)
    if (!stat.isSymbolicLink()) {
      log(`  △ ${link} 不是链接，跳过（避免误删普通目录）`)
      return
    }
    let currentOk = false
    try { currentOk = linkPointsTo(link, PROJECT_ROOT) } catch { /* 坏链 / 读取失败 */ }
    let viaRawText = false
    if (!currentOk) {
      // 二次判定：原始链接文本指向本项目（含目标已不存在的死链）则允许删。
      viaRawText = rawLinkPointsToProject(link)
      if (!viaRawText) {
        log(`  △ ${link} 不是指向本项目的链接，跳过`)
        residueWarnings.push(`${link} 链接残留（未确认指向本项目，未删除）`)
        return
      }
    }
    if (DRY) {
      log(`  [dry-run] 删除 junction：${link}`)
      return
    }
    unlinkSync(link)
    log(viaRawText
      ? `  ✓ 已删除（原始链接文本指向本项目）：${link}`
      : `  ✓ 已删除：${link}`)
  } catch (error) {
    if (error.code === 'ENOENT') {
      log(`  ✓ 不存在（跳过）：${link}`)
      return
    }
    console.error(`  ✘ 删除失败：${link}: ${error.message}`)
  }
}
for (const base of JUNCTION_BASES) {
  removeJunction(join(base, ROW_ID))
}
if (harnessRoot !== undefined) {
  removeJunction(join(harnessRoot, 'apps', 'cli', 'node_modules', ROW_ID))
} else {
  log('  △ 无法定位 harness，apps/cli 下的 junction 请手动确认')
}

// ── 3. 宽度 fork 回退（默认，--keep-fork 跳过） ───────────────────────────
if (!flag('--keep-fork')) {
  step('检查宽度 fork（DETAILS_MAX + 宽度记忆）')
  if (harnessRoot === undefined) {
    log('  △ 无法定位 harness，跳过 fork 回退（手动：把 DETAILS_MAX 改回 520 并重建）')
  } else {
    const columnsPath = join(harnessRoot, 'packages', 'client', 'ui-layout', 'src', 'client', 'columns.ts')
    let needRebuild = false
    if (!existsSync(columnsPath)) {
      log('  △ 找不到 columns.ts，跳过')
    } else {
      let source = readFileSync(columnsPath, 'utf8')
      if (!source.includes('FORK') && !source.includes('DETAILS_MAX = 1200')) {
        log('  ✓ 无 FORK 标记（未改过，或由他人改动），跳过')
      } else if (DRY) {
        log('  [dry-run] 回退 DETAILS_MAX 1200 → 520 并重建 ui-layout bundle')
      } else {
        const next = source.replace(
          /\/\*\* Details drag clamp ceiling\.[\s\S]*?\*\/\s*\nexport const DETAILS_MAX = 1200/,
          '/** Details drag clamp ceiling. */\nexport const DETAILS_MAX = 520',
        )
        if (next === source) {
          log('  ✘ columns.ts 回退未命中（源码可能已变），未改文件')
          residueWarnings.push(`${columnsPath} 仍含宽度 FORK 标记（DETAILS_MAX = 1200）`)
        } else {
          try {
            atomicWrite(columnsPath, next)
            log('  ✓ 已回退 DETAILS_MAX = 520')
            needRebuild = true
          } catch (error) {
            log(`  ✘ columns.ts 回退写入失败（原文件未动或可自 .dshx-orig 恢复）：${error.message}`)
            residueWarnings.push(`${columnsPath} 回退写入失败，宽度 FORK 可能残留`)
          }
        }
      }
    }
    // 宽度记忆（stores.ts）回退：按函数体匹配，不绑死安装器当时的注释原文。
    const storesPath = join(harnessRoot, 'packages', 'client', 'ui-layout', 'src', 'client', 'stores.ts')
    if (!existsSync(storesPath)) {
      log('  △ 找不到 stores.ts，跳过')
    } else {
      let source = readFileSync(storesPath, 'utf8')
      if (!source.includes('DETAILS_WIDTH_KEY')) {
        log('  ✓ stores.ts 无宽度记忆 fork，跳过')
      } else if (DRY) {
        log('  [dry-run] 回退 stores.ts 宽度记忆')
      } else {
        const before = source
        source = source.replace(
          /(?:      \/\/ FORK（DSH-Explorer）：[^\n]*\n(?:      \/\/[^\n]*\n)*)?      setDetails: \(d, px: number\) => \{\n        d\.details = clampWidth\(px, DETAILS_MIN, DETAILS_MAX\)\n        persistDetails\(d\.details\)\n      \},/,
          '      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },',
        )
        source = source.replace(
          '      openDetails: (d) => { if (d.details === 0) d.details = readSavedDetails() },',
          '      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },',
        )
        if (source.includes('persistDetails(d.details)')) {
          log('  ✘ setDetails 回退未命中，保留 helper，避免留下空调用')
          residueWarnings.push(`${storesPath} 仍含宽度记忆 FORK（persistDetails 调用未还原）`)
        } else {
          source = source.replace(/\n\n\/\/ ── FORK（DSH-Explorer）：右侧栏宽度记忆[\s\S]*$/, '\n')
          if (source === before) {
            log('  ✘ stores.ts 回退未命中（源码可能已变），未改文件')
            residueWarnings.push(`${storesPath} 仍含宽度记忆 FORK 标记（DETAILS_WIDTH_KEY）`)
          } else {
            try {
              atomicWrite(storesPath, source)
              log('  ✓ 已回退 stores.ts 宽度记忆')
              needRebuild = true
            } catch (error) {
              log(`  ✘ stores.ts 回退写入失败（原文件未动或可自 .dshx-orig 恢复）：${error.message}`)
              residueWarnings.push(`${storesPath} 回退写入失败，宽度记忆 FORK 可能残留`)
            }
          }
        }
      }
    }
    if (needRebuild && !DRY) {
      const code = run('pnpm', ['--filter', '@deepseek-ai/dsh-client-ui-layout', 'run', 'bundle'], harnessRoot)
      if (code === 0) log('  ✓ 已重建 ui-layout 客户端 bundle（刷新页面生效）')
      else log('  ✘ 重建失败，请手动执行 pnpm --filter @deepseek-ai/dsh-client-ui-layout run bundle')
    }
  }
} else {
  log('\n（--keep-fork：保留宽度 fork 改动）')
}

// ── 4. 顶部动作条座位 fork 回退（--fork-ui 写入的 ui-sidebar 改动） ────────
if (!flag('--keep-fork')) {
  step('检查顶部动作条座位 fork（sidebar.workspaces.actions）')
  if (harnessRoot === undefined) {
    log('  △ 无法定位 harness，跳过（手动确认 ui-sidebar 是否残留 FORK 改动）')
  } else {
    const SIDEBAR_DIR = join(harnessRoot, 'packages', 'client', 'ui-sidebar', 'src', 'client')
    const SEAT_KEY = 'sidebar.workspaces.actions'
    let needSidebarRebuild = false

    /** 单文件回退：按标记判断存在性，回退未命中宁可不动文件并记残留。 */
    function revertFile(label, filePath, marker, revertFn) {
      if (!existsSync(filePath)) {
        log(`  △ 找不到 ${label}，跳过`)
        return
      }
      const source = readFileSync(filePath, 'utf8')
      if (!source.includes(marker)) {
        log(`  ✓ ${label} 无该 fork，跳过`)
        return
      }
      if (DRY) {
        log(`  [dry-run] 回退 ${label} 的 fork`)
        needSidebarRebuild = true
        return
      }
      const next = revertFn(source)
      if (next === source || next.includes(marker)) {
        log(`  ✘ ${label} 回退未命中（源码可能已变），未改文件`)
        residueWarnings.push(`${filePath} 仍含 ${marker} 标记`)
        return
      }
      try { backupOnce(filePath) } catch { /* 备份失败不阻断回退 */ }
      try {
        atomicWrite(filePath, next)
      } catch (error) {
        log(`  ✘ ${label} 写入失败（原文件未动或可自 .dshx-orig 恢复）：${error.message}`)
        residueWarnings.push(`${filePath} 回退写入失败`)
        return
      }
      log(`  ✓ 已回退 ${label}`)
      needSidebarRebuild = true
    }

    revertFile('contract/slots.ts', join(SIDEBAR_DIR, 'contract', 'slots.ts'), SEAT_KEY, (source) => {
      let out = source.replace(
        /\n[ \t]*\/\*\* FORK（本机部署改动，DSH-Explorer 依赖）：工作区上方动作条座位，见 README。 \*\/\n[ \t]*'sidebar\.workspaces\.actions': \{ kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps \}/,
        '',
      )
      // 单行 union 形态（旧上游）。
      out = out.replace(
        "'sidebar.workspaces' | 'sidebar.workspaces.actions' | 'sidebar.settings'",
        "'sidebar.workspaces' | 'sidebar.settings'",
      )
      // 多行 union 形态（上游加入 brand 席位后；与安装器双形态针配套）：
      // 删掉整个成员行。
      out = out.replace(/^[ \t]*\| 'sidebar\.workspaces\.actions'[ \t]*\r?\n/m, '')
      return out
    })
    revertFile('index.ts', join(SIDEBAR_DIR, 'index.ts'), SEAT_KEY, (source) => source.replace(
      /\n[ \t]*\/\/ FORK（DSH-Explorer）：工作区上方动作条座位。\n[ \t]*'sidebar\.workspaces\.actions': \{ kind: 'list', scope: 'root' \},/,
      '',
    ))
    revertFile('SidebarRoot.tsx', join(SIDEBAR_DIR, 'SidebarRoot.tsx'), 'workspaceActions', (source) => source.replace(
      /[ \t]*\{\/\* FORK（DSH-Explorer）：工作区上方的紧凑动作条[\s\S]*?\{renderSlot\('sidebar\.workspaces\.actions', \{ wide \}\)\}[\s\S]*?\)\}\n\n/,
      '',
    ))
    revertFile('SidebarRoot.module.css', join(SIDEBAR_DIR, 'SidebarRoot.module.css'), '.workspaceActions', (source) => source.replace(
      /\n\n\/\* FORK（DSH-Explorer）：工作区上方动作条座位[\s\S]*?\.workspaceActions:empty \{[^}]*\}/,
      '',
    ))

    if (needSidebarRebuild && !DRY) {
      const code = run('pnpm', ['--filter', '@deepseek-ai/dsh-client-ui-sidebar', 'run', 'bundle'], harnessRoot)
      if (code === 0) log('  ✓ 已重建 ui-sidebar 客户端 bundle（刷新页面生效）')
      else log('  ✘ 重建失败，请手动执行 pnpm --filter @deepseek-ai/dsh-client-ui-sidebar run bundle')
    }
  }
} else {
  log('\n（--keep-fork：保留宽度与座位 fork 改动）')
}

// ── 残留终检：fork 标记仍在即显式告警，不再假装「卸载完成」 ───────────────
// 覆盖全部六类 fork 标记（宽度 ×2 + 座位 ×2 终检、座位另两文件由
// revertFile 自身记录），无论上面走了哪条分支（dry-run / --keep-fork /
// 回退未命中），结尾汇总都给出完整残留清单。
if (harnessRoot !== undefined) {
  const probes = [
    [join(harnessRoot, 'packages', 'client', 'ui-layout', 'src', 'client', 'columns.ts'), 'DETAILS_MAX = 1200'],
    [join(harnessRoot, 'packages', 'client', 'ui-layout', 'src', 'client', 'stores.ts'), 'DETAILS_WIDTH_KEY'],
    [join(harnessRoot, 'packages', 'client', 'ui-sidebar', 'src', 'client', 'contract', 'slots.ts'), 'sidebar.workspaces.actions'],
    [join(harnessRoot, 'packages', 'client', 'ui-sidebar', 'src', 'client', 'index.ts'), 'sidebar.workspaces.actions'],
    [join(harnessRoot, 'packages', 'client', 'ui-sidebar', 'src', 'client', 'SidebarRoot.tsx'), 'workspaceActions'],
    [join(harnessRoot, 'packages', 'client', 'ui-sidebar', 'src', 'client', 'SidebarRoot.module.css'), '.workspaceActions'],
  ]
  for (const [file, marker] of probes) {
    try {
      if (readFileSync(file, 'utf8').includes(marker) && !residueWarnings.some(w => w.includes(file))) {
        residueWarnings.push(`${file} 仍含 ${marker} 标记`)
      }
    } catch { /* 文件不存在即无残留 */ }
  }
}

console.log('\n════════════════════════════════════════')
console.log(DRY ? '  dry-run 结束（未做任何修改）' : '  卸载完成')
if (residueWarnings.length > 0) {
  console.log('  ⚠ 检测到 fork 残留（回退未命中或 --keep-fork）：')
  for (const warning of residueWarnings) console.log(`    - ${warning}`)
}
console.log('  建议重启 dsh web 一次，彻底清掉 Host 模块缓存')
console.log('════════════════════════════════════════')
