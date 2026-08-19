/**
 * Shared helpers for install.mjs / uninstall.mjs: locate the harness checkout
 * and compare junction targets. Kept tiny so both scripts stay standalone
 * except for this file.
 */

import { existsSync, readlinkSync } from 'node:fs'
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

export function sameResolved(a, b) {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Junction / symlink 是否指向 target（相对链接按链接所在目录解析）。 */
export function linkPointsTo(linkPath, target) {
  const current = readlinkSync(linkPath)
  return sameResolved(resolve(dirname(linkPath), current), target)
}

export function shellLine(cmd, args) {
  const tokens = [cmd, ...args].map(token => {
    if (!/[ \t"@]/.test(token)) return token
    return `"${String(token).replace(/"/g, '\\"')}"`
  })
  return tokens.join(' ')
}
