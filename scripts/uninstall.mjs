#!/usr/bin/env node
/**
 * DSH-Explorer 卸载器（幂等，可重复执行）。
 *
 * 流程：移除 profile patch 里的插件行（热重载生效）→ 删除包解析 junction。
 *
 * 用法：
 *   node scripts/uninstall.mjs            # 完整卸载
 *   node scripts/uninstall.mjs --dry-run   # 只打印计划，不执行
 */

import {
  existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  linkPointsTo, locateHarness, log, makeExec, parseArgs,
  profilePaths, resolveDshHome, sameResolved, step, stripNtPrefix,
} from './harness.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROW_ID = 'dsh-explorer'

// ── 参数解析（共享实现见 harness.mjs） ─────────────────────────────────────
const { flag, opt, requireValue } = parseArgs({
  argv: process.argv.slice(2),
  known: new Set(['--dry-run', '--profile', '--harness']),
  usage: '--dry-run --profile <name> --harness <path>',
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
// 卸载结束时汇总的残留提示（junction 未确认指向本项目等）。
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

console.log('\n════════════════════════════════════════')
console.log(DRY ? '  dry-run 结束（未做任何修改）' : '  卸载完成')
if (residueWarnings.length > 0) {
  console.log('  ⚠ 检测到残留：')
  for (const warning of residueWarnings) console.log(`    - ${warning}`)
}
console.log('  建议重启 dsh web 一次，彻底清掉 Host 模块缓存')
console.log('════════════════════════════════════════')
