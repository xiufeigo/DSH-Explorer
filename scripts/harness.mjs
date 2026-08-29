/**
 * Shared helpers for install.mjs / uninstall.mjs: locate the harness checkout
 * and compare junction targets. Kept tiny so both scripts stay standalone
 * except for this file.
 */

import { copyFileSync, existsSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export function looksLikeHarness(root) {
  if (typeof root !== 'string' || root.length === 0) return false
  return existsSync(join(root, 'apps', 'cli')) && existsSync(join(root, 'packages', 'client'))
}

function addCandidate(seen, tries, raw) {
  if (typeof raw !== 'string' || raw.length === 0) return
  const normalized = resolve(raw)
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  if (seen.has(key)) return
  seen.add(key)
  tries.push(normalized)
}

/**
 * Find a deepseek-harness checkout.
 * Order: --harness → DSH_HARNESS → 仓库隔壁 deepseek-harness → 从 dsh-base
 * junction 往上爬。本机 profile 农场经常指向 Desktop 的 npm 载荷（路径里
 * 没有 apps/cli），不能把「找到 dsh-base」当成「找到了可 fork 的 checkout」。
 */
export function locateHarness({ explicit, projectRoot, junctionBases }) {
  const seen = new Set()
  const tries = []
  // --harness 是硬指定：路径无效时返回 undefined，由调用方报错，不偷偷改用隔壁目录。
  if (typeof explicit === 'string' && explicit.length > 0) {
    const resolved = resolve(explicit)
    return looksLikeHarness(resolved) ? resolved : undefined
  }
  addCandidate(seen, tries, process.env.DSH_HARNESS)
  addCandidate(seen, tries, resolve(projectRoot, '..', 'deepseek-harness'))
  for (const base of junctionBases) {
    const probe = join(base, '@deepseek-ai', 'dsh-base')
    try {
      const target = readlinkSync(probe)
      const resolved = resolve(dirname(probe), target)
      const withSep = resolved.replace(/[/\\]/g, sep)
      const marker = `${sep}apps${sep}cli`
      const index = withSep.indexOf(marker)
      if (index > 0) addCandidate(seen, tries, withSep.slice(0, index))
      let dir = resolved
      for (let i = 0; i < 12; i++) {
        addCandidate(seen, tries, dir)
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      // 这个农场里没有 dsh-base 链接，试下一个。
    }
  }
  return tries.find(looksLikeHarness)
}

/**
 * 剥掉 `\\?\` / `\??\` NT 设备命名空间前缀再比较：Windows junction 的
 * 链接目标常以 `\??\C:\…` 存储，扩展长度路径则带 `\\?\`。这类串直接
 * 进 resolve 会被当成「当前盘根相对」拼出错误路径，造成同路径误判。
 */
export function stripNtPrefix(value) {
  return String(value).replace(/^\\{1,2}\?{1,2}\\/, '')
}

export function sameResolved(a, b) {
  const left = resolve(stripNtPrefix(a))
  const right = resolve(stripNtPrefix(b))
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Junction / symlink 是否指向 target（相对链接按链接所在目录解析；NT 前缀先剥净）。 */
export function linkPointsTo(linkPath, target) {
  const current = stripNtPrefix(readlinkSync(linkPath))
  return sameResolved(resolve(dirname(linkPath), current), target)
}

export function shellLine(cmd, args) {
  const tokens = [cmd, ...args].map(token => {
    const text = String(token)
    // cmd.exe 的元字符无法靠引号完全中和（`&` 在引号外断行、`%` 变量展开）。
    // 本脚本的 token 全是固定值；一旦出现元字符说明被外部路径污染，拒绝执行。
    if (/[&|<>^%!]/.test(text)) {
      throw new Error(`命令行参数含 shell 元字符，拒绝拼接：${text}`)
    }
    if (!/[ \t"@]/.test(text)) return text
    return `"${text.replace(/"/g, '\\"')}"`
  })
  return tokens.join(' ')
}

/** 原始备份只写一次（卸载/排查时可手工还原）。返回备份路径。 */
export function backupOnce(filePath, suffix = '.dshx-orig') {
  const backup = `${filePath}${suffix}`
  if (!existsSync(backup)) copyFileSync(filePath, backup)
  return backup
}

/**
 * 同盘临时文件 + 原子换名，避免半截文件被读到；换名失败退回直写并清理
 * 临时文件。与 src/payloadFork.ts 的写入策略同源。
 */
export function atomicWrite(filePath, text) {
  const tmp = `${filePath}.dshx-tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, filePath)
  } catch {
    writeFileSync(filePath, text, 'utf8')
    try { rmSync(tmp, { force: true }) } catch { /* 尽力清理 */ }
  }
}
