#!/usr/bin/env node
/**
 * DSH-Explorer 卸载器（幂等，可重复执行）。
 *
 * 流程：移除 profile patch 里的插件行（热重载生效）→ 删除两个包解析 junction
 *      → 若 harness 含本安装器写入的宽度 FORK 标记，默认回退并重建（--keep-fork 跳过）。
 *
 * 用法：
 *   node scripts/uninstall.mjs            # 完整卸载
 *   node scripts/uninstall.mjs --keep-fork # 保留宽度 fork 改动
 *   node scripts/uninstall.mjs --dry-run   # 只打印计划，不执行
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkPointsTo, locateHarness, shellLine } from './harness.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROW_ID = 'dsh-explorer'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const DRY = flag('--dry-run')
const PROFILE = opt('--profile') ?? 'web'
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
// 与安装器一致的解析基准：junction 农场（profiles/node_modules）优先，兼容 per-profile 目录。
const JUNCTION_BASES = [
  join(DSH_HOME, 'profiles', 'node_modules'),
  join(PROFILE_DIR, 'node_modules'),
]

const log = (...parts) => console.log(...parts)
const step = (title) => console.log(`\n▶ ${title}`)

const harnessFlag = opt('--harness')
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
  const lines = text.split(/\r?\n/)
  const rowIndex = lines.findIndex(line => /^\s*-\s*id:\s*dsh-explorer\s*$/.test(line))
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
      lines.splice(start, end - start)
      // 若所在 insert 块已无子行，连 insert 行一并移除。
      const insertIndex = (() => {
        for (let i = start - 1; i >= 0; i--) {
          if (/^\s*- insert:\s*$/.test(lines[i])) return i
          if (lines[i].trim() !== '') break
        }
        return -1
      })()
      if (insertIndex >= 0) {
        let hasChild = false
        for (let i = insertIndex + 1; i < lines.length; i++) {
          const line = lines[i]
          if (line.trim() === '') continue
          if (/^-\s+/.test(line)) break // 下一个顶层条目
          if (/^\s+-\s+id:/.test(line)) { hasChild = true; break }
        }
        if (!hasChild) {
          // 只删空的 insert 条目，不动文件头注释（否则会把 DSH 自带说明一并吃掉）。
          lines.splice(insertIndex, 1)
        }
      }
      const cleaned = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
      writeFileSync(PATCH_PATH, `${cleaned.length > 0 ? `${cleaned}\n` : '[]\n'}`)
    }
    exec('移除 dsh-explorer 行（含注释与空 insert 块）', applyRemove)
    if (!DRY) log('  ✓ 已移除（watchUserPatches 热重载，Host 路由随即下线）')
  }
}

// ── 2. 删除包解析 junction ─────────────────────────────────────────────────
step('删除包解析 junction')
function removeJunction(link) {
  try {
    const stat = lstatSync(link)
    if (!stat.isSymbolicLink()) {
      log(`  △ ${link} 不是链接，跳过（避免误删普通目录）`)
      return
    }
    const currentOk = (() => {
      try { return linkPointsTo(link, PROJECT_ROOT) } catch { return false }
    })()
    if (!currentOk) {
      log(`  △ ${link} 不是指向本项目的链接，跳过`)
      return
    }
    if (DRY) {
      log(`  [dry-run] 删除 junction：${link}`)
      return
    }
    unlinkSync(link)
    log(`  ✓ 已删除：${link}`)
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
        } else {
          writeFileSync(columnsPath, next)
          log('  ✓ 已回退 DETAILS_MAX = 520')
          needRebuild = true
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
        } else {
          source = source.replace(/\n\n\/\/ ── FORK（DSH-Explorer）：右侧栏宽度记忆[\s\S]*$/, '\n')
          if (source === before) {
            log('  ✘ stores.ts 回退未命中（源码可能已变），未改文件')
          } else {
            writeFileSync(storesPath, source)
            log('  ✓ 已回退 stores.ts 宽度记忆')
            needRebuild = true
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

console.log('\n════════════════════════════════════════')
console.log(DRY ? '  dry-run 结束（未做任何修改）' : '  卸载完成')
console.log('  建议重启 dsh web 一次，彻底清掉 Host 模块缓存')
console.log('════════════════════════════════════════')

function exec(description, fn) {
  if (DRY) {
    log(`  [dry-run] ${description}`)
    return
  }
  fn()
}

function run(cmd, args, cwd) {
  return spawnSync(shellLine(cmd, args), { cwd, stdio: 'inherit', shell: true }).status
}
