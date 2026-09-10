/**
 * Shared helpers for install.mjs / uninstall.mjs: locate the harness checkout,
 * compare junction targets, and the command-line / logging / subprocess
 * scaffold both scripts previously duplicated nearly verbatim.
 */

import { spawnSync } from 'node:child_process'
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
 * 没有 apps/cli），不能把「找到 dsh-base」当成「找到了可用的 checkout」。
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

// ── 安装器 / 卸载器共享脚手架 ─────────────────────────────────────────────
// 参数解析、DSH_HOME 探测、profile 路径、日志与子进程执行原先在两个脚本里
// 近逐字重复；收敛到这里，脚本各自只保留流程差异。

export const log = (...parts) => console.log(...parts)
export const step = (title) => console.log(`\n▶ ${title}`)

/**
 * 命令行解析：未知 `--xxx` 直接报错退出；`--name value` 与 `--name=value`
 * 两种形态等价；`requireValue` 对「声明了却缺值」报错。
 */
export function parseArgs({ argv, known, usage }) {
  for (const token of argv) {
    const head = token.split('=')[0]
    if (token.startsWith('--') && !known.has(head)) {
      console.error(`✘ 未知参数：${token}`)
      console.error(`  可用：${usage}`)
      process.exit(1)
    }
  }
  const flag = (name) => argv.includes(name)
  const opt = (name) => {
    // 同时支持 `--name value` 与 `--name=value`；漏值（下一个 token 是 -- 开头）视为未提供。
    const eqForm = argv.find(token => token.startsWith(`${name}=`))
    if (eqForm !== undefined) {
      const value = eqForm.slice(name.length + 1)
      return value.length > 0 ? value : undefined
    }
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
  }
  const requireValue = (name, value) => {
    const present = argv.some(token => token === name || token.startsWith(`${name}=`))
    if (present && value === undefined) {
      console.error(`✘ ${name} 缺少取值（用法：${name} <value>）`)
      process.exit(1)
    }
  }
  return { flag, opt, requireValue }
}

/**
 * DSH_HOME 解析：环境变量优先；未设置时默认位置必须已有 profiles/ 结构，
 * 否则明确报错——绝不静默落相对路径（会把 junction/patch 写进 <cwd>\.dsh，
 * 造成「装成功但不生效」）。
 */
export function resolveDshHome() {
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0) {
    return process.env.DSH_HOME
  }
  const fallback = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  if (!existsSync(join(fallback, 'profiles'))) {
    console.error(`✘ 未设置 DSH_HOME，且默认位置 ${fallback} 不含 profiles/ 目录`)
    console.error('  请设置环境变量 DSH_HOME 指向 DSH 主目录（含 profiles/<profile>）后再试')
    process.exit(1)
  }
  return fallback
}

/**
 * profile 相关路径：patch 文件与包解析 junction 基准。DSH 的 junction 农场
 * 在 profiles/node_modules（所有 profile 共享），个别部署可能用 per-profile
 * 目录——两个都探测/覆盖。
 */
export function profilePaths(dshHome, profile) {
  const profileDir = join(dshHome, 'profiles', profile)
  return {
    profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    junctionBases: [
      join(dshHome, 'profiles', 'node_modules'),
      join(profileDir, 'node_modules'),
    ],
  }
}

/** 执行外部命令：命令与参数均为脚本内固定 token（拼接规则见 shellLine）。 */
export function run(cmd, args, cwd) {
  // 传字符串而非 (cmd, args[]) 可避免 Node 22 的 DEP0190 弃用警告。
  return spawnSync(shellLine(cmd, args), { cwd, stdio: 'inherit', shell: true }).status
}

/** 描述式执行器：dry-run 只打印并返回 0；异常即报告并退出。 */
export function makeExec(isDry) {
  return (description, fn) => {
    if (isDry) {
      log(`  [dry-run] ${description}`)
      return 0
    }
    try {
      return fn()
    } catch (error) {
      console.error(`  ✘ ${description} 失败：${error.message}`)
      process.exit(1)
    }
  }
}
