/**
 * DSH-Explorer 用户偏好：存在 localStorage，设置页和终端共用。
 * Host 另注册 kebab-case 命名空间 `dsh-explorer`，让「插件配置」的 keyed
 * 座位能在 describe ∩ 卡片 key 的交集里派发到这张卡。字段值不写那份文档。
 */

export type TermThemeId = 'auto' | 'light' | 'dark' | 'slate' | 'forest'
export type TermFontId = 'ui' | 'code' | 'mono' | 'custom'
export type SoundId = 'none' | 'staplebops-01' | 'staplebops-02' | 'nope-03' | 'chime-soft' | 'chime-bright' | 'alert-low' | 'alert-high'

export interface ExplorerPrefs {
  termTheme: TermThemeId
  termFontSize: number
  termFont: TermFontId
  termFontCustom: string
  /** 系统通知：智能体完成或需要注意时 */
  notifyAgent: boolean
  /** 系统通知：需要权限时 */
  notifyPermission: boolean
  /** 系统通知：发生错误时 */
  notifyError: boolean
  /** 音效：智能体完成或需要注意时 */
  soundAgent: SoundId
  /** 音效：需要权限时 */
  soundPermission: SoundId
  /** 音效：发生错误时 */
  soundError: SoundId
  /** 工作区侧栏按最后会话时间自动排序（关闭则保留手动拖拽顺序） */
  sortWorkspacesByRecency: boolean
}

export const PREFS_KEY = 'dsh-explorer:prefs'

export const DEFAULT_PREFS: ExplorerPrefs = {
  termTheme: 'auto',
  termFontSize: 13,
  termFont: 'code',
  termFontCustom: '',
  notifyAgent: true,
  notifyPermission: true,
  notifyError: false,
  soundAgent: 'staplebops-01',
  soundPermission: 'staplebops-02',
  soundError: 'nope-03',
  sortWorkspacesByRecency: true,
}

/** 写入 localStorage 的版本。v1 默认把终端交给比例正文，xterm 格子会发糊、字重不均。 */
const PREFS_VERSION = 2

const MONO_FALLBACK = [
  '"JetBrains Mono NL"',
  '"JetBrains Mono"',
  '"Cascadia Code"',
  '"Cascadia Mono"',
  'Consolas',
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'monospace',
]

/**
 * 桌面壳的 `--ds-font-family-code` 会把用户选的字体（如 JetBrains Mono NL）
 * 先包成 `DSH-GUI-CODE`：`@font-face { src: local(...) }`。CSS 编辑器能靠栈里
 * 后面的真名回退，xterm canvas 只吃第一款时 `local()` 经常对不上，拉丁文会
 * 落到宋体/Courier，大写占满格子、小写挤在下半截。
 */
const TERM_UNSAFE = /^(sans-serif|serif|system-ui|ui-sans-serif|ui-serif|-apple-system|BlinkMacSystemFont|Segoe UI|Segoe UI Variable|Microsoft YaHei|Microsoft YaHei UI|PingFang SC|PingFang TC|Hiragino Sans|Noto Sans|Source Han Sans|DSH-GUI-UI|DSH-GUI-CODE|DshChipCell)$/i

function parseFamilies(stack: string): string[] {
  const parts: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (const ch of stack) {
    if (quote !== null) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === ',') {
      const piece = buf.trim()
      if (piece.length > 0) parts.push(piece)
      buf = ''
      continue
    }
    buf += ch
  }
  const last = buf.trim()
  if (last.length > 0) parts.push(last)
  return parts
}

function familyName(token: string): string {
  return token.replace(/^["']|["']$/g, '').trim()
}

function quoteFamily(name: string): string {
  const trimmed = name.trim()
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed
  if (/^[a-zA-Z0-9-]+$/.test(trimmed)) return trimmed
  return `"${trimmed.replace(/"/g, '')}"`
}

function stripTermUnsafe(tokens: string[]): string[] {
  return tokens.filter(token => !TERM_UNSAFE.test(familyName(token)))
}

function joinFamilies(tokens: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokens) {
    if (token.length === 0) continue
    const key = familyName(token).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(token)
  }
  return out
}

function cssVarStack(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function candidateFamilies(prefs: ExplorerPrefs): string[] {
  const codeStack = stripTermUnsafe(parseFamilies(cssVarStack('--ds-font-family-code')))
  const uiStack = stripTermUnsafe(parseFamilies(cssVarStack('--dsw-font-family')))
  if (prefs.termFont === 'custom' && prefs.termFontCustom.trim().length > 0) {
    return joinFamilies([quoteFamily(prefs.termFontCustom.trim()), ...codeStack, ...MONO_FALLBACK])
  }
  if (prefs.termFont === 'ui') {
    return joinFamilies([...uiStack, ...MONO_FALLBACK])
  }
  if (prefs.termFont === 'mono') {
    return joinFamilies(MONO_FALLBACK)
  }
  return joinFamilies([...codeStack, ...MONO_FALLBACK])
}

/**
 * 已加载且能量出来是比例字体的，从栈里拿掉。
 * 量不出来的（系统字体 `fonts.check` 常为 false）必须留着，否则 JetBrains Mono NL 会被误删。
 */
function isClearlyProportional(family: string, size: number): boolean {
  if (typeof document === 'undefined') return false
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (ctx === null) return false
  const spec = `${String(size)}px ${family}`
  ctx.font = spec
  const sample = 'Hamburgefonstiv Wm@0'
  const width = ctx.measureText(sample).width
  const em = ctx.measureText('M').width
  ctx.font = `${String(size)}px serif`
  if (!(em > 1) || Math.abs(width - ctx.measureText(sample).width) < 0.5) return false
  ctx.font = spec
  for (const ch of ['i', 'm', 'W', '0', 'a', '@']) {
    if (Math.abs(ctx.measureText(ch).width - em) > 0.75) return true
  }
  return false
}

function buildTermFontStack(prefs: ExplorerPrefs): string {
  const tokens = candidateFamilies(prefs).filter(family => !isClearlyProportional(family, prefs.termFontSize))
  return tokens.length > 0 ? tokens.join(', ') : 'Consolas, monospace'
}

let fontPickKey = ''
let fontPick = ''

function pickKey(prefs: ExplorerPrefs): string {
  return [
    prefs.termFont,
    prefs.termFontCustom,
    String(prefs.termFontSize),
    cssVarStack('--ds-font-family-code'),
    cssVarStack('--dsw-font-family'),
  ].join('\0')
}

const THEMES: readonly TermThemeId[] = ['auto', 'light', 'dark', 'slate', 'forest']
const FONTS: readonly TermFontId[] = ['ui', 'code', 'mono', 'custom']
const SOUNDS: readonly SoundId[] = ['none', 'staplebops-01', 'staplebops-02', 'nope-03', 'chime-soft', 'chime-bright', 'alert-low', 'alert-high']
const SOUND_SET = new Set<string>(SOUNDS)

function clipSize(n: number): number {
  return Math.min(22, Math.max(11, Math.round(n)))
}

function parsePrefs(raw: string | null): ExplorerPrefs {
  if (raw === null || raw.length === 0) return { ...DEFAULT_PREFS }
  try {
    const data = JSON.parse(raw) as Partial<ExplorerPrefs> & { v?: number }
    const theme = THEMES.includes(data.termTheme as TermThemeId) ? data.termTheme as TermThemeId : DEFAULT_PREFS.termTheme
    let font = FONTS.includes(data.termFont as TermFontId) ? data.termFont as TermFontId : DEFAULT_PREFS.termFont
    if ((data.v ?? 1) < 2 && font === 'ui' && (data.termFontCustom ?? '').length === 0) {
      font = 'code'
    }
    const size = typeof data.termFontSize === 'number' ? clipSize(data.termFontSize) : DEFAULT_PREFS.termFontSize
    const custom = typeof data.termFontCustom === 'string' ? data.termFontCustom.slice(0, 120) : ''
    return {
      termTheme: theme,
      termFontSize: size,
      termFont: font,
      termFontCustom: custom,
      notifyAgent: typeof data.notifyAgent === 'boolean' ? data.notifyAgent : DEFAULT_PREFS.notifyAgent,
      notifyPermission: typeof data.notifyPermission === 'boolean' ? data.notifyPermission : DEFAULT_PREFS.notifyPermission,
      notifyError: typeof data.notifyError === 'boolean' ? data.notifyError : DEFAULT_PREFS.notifyError,
      soundAgent: typeof data.soundAgent === 'string' && SOUND_SET.has(data.soundAgent) ? data.soundAgent as SoundId : DEFAULT_PREFS.soundAgent,
      soundPermission: typeof data.soundPermission === 'string' && SOUND_SET.has(data.soundPermission) ? data.soundPermission as SoundId : DEFAULT_PREFS.soundPermission,
      soundError: typeof data.soundError === 'string' && SOUND_SET.has(data.soundError) ? data.soundError as SoundId : DEFAULT_PREFS.soundError,
      sortWorkspacesByRecency: typeof data.sortWorkspacesByRecency === 'boolean' ? data.sortWorkspacesByRecency : DEFAULT_PREFS.sortWorkspacesByRecency,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function readPrefs(): ExplorerPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY))
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

const listeners = new Set<() => void>()
let current = readPrefs()

function persist(): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, ...current })) } catch { /* private mode */ }
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function getPrefs(): ExplorerPrefs {
  return current
}

export function setPrefs(patch: Partial<ExplorerPrefs>): ExplorerPrefs {
  const next: ExplorerPrefs = { ...current, ...patch }
  if (typeof patch.termFontSize === 'number') next.termFontSize = clipSize(patch.termFontSize)
  if (typeof patch.termFontCustom === 'string') next.termFontCustom = patch.termFontCustom.slice(0, 120)
  current = next
  persist()
  notify()
  return current
}

export function resetPrefs(): ExplorerPrefs {
  current = { ...DEFAULT_PREFS }
  persist()
  notify()
  return current
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export interface XtermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

function autoTheme(): XtermTheme {
  const bg = cssVar('--dsw-alias-bg-base', '#ffffff')
  const fg = cssVar('--dsw-alias-label-primary', '#1b1b1f')
  const dim = cssVar('--dsw-alias-label-secondary', '#62626b')
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: 'rgba(63, 109, 245, 0.28)',
    black: dim,
    red: '#d5433e',
    green: '#2e9e5b',
    yellow: '#b9790f',
    blue: '#3f6df5',
    magenta: '#a855f7',
    cyan: '#0f9aa8',
    white: fg,
    brightBlack: dim,
    brightRed: '#ef6b66',
    brightGreen: '#4cba75',
    brightYellow: '#d4a017',
    brightBlue: '#6b8df7',
    brightMagenta: '#c084fc',
    brightCyan: '#2eb8c6',
    brightWhite: fg,
  }
}

const PALETTES: Record<Exclude<TermThemeId, 'auto'>, XtermTheme> = {
  light: {
    background: '#fafafa',
    foreground: '#1b1b1f',
    cursor: '#1b1b1f',
    cursorAccent: '#fafafa',
    selectionBackground: 'rgba(63, 109, 245, 0.28)',
    black: '#4a4a52',
    red: '#d5433e',
    green: '#2e9e5b',
    yellow: '#b9790f',
    blue: '#3f6df5',
    magenta: '#a855f7',
    cyan: '#0f9aa8',
    white: '#1b1b1f',
    brightBlack: '#6d6d76',
    brightRed: '#ef6b66',
    brightGreen: '#4cba75',
    brightYellow: '#d4a017',
    brightBlue: '#6b8df7',
    brightMagenta: '#c084fc',
    brightCyan: '#2eb8c6',
    brightWhite: '#111114',
  },
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(63, 109, 245, 0.35)',
    black: '#808080',
    red: '#f44747',
    green: '#6a9955',
    yellow: '#dcdcaa',
    blue: '#569cd6',
    magenta: '#c586c0',
    cyan: '#4ec9b0',
    white: '#d4d4d4',
    brightBlack: '#808080',
    brightRed: '#f44747',
    brightGreen: '#6a9955',
    brightYellow: '#dcdcaa',
    brightBlue: '#569cd6',
    brightMagenta: '#c586c0',
    brightCyan: '#4ec9b0',
    brightWhite: '#ffffff',
  },
  slate: {
    background: '#0f172a',
    foreground: '#e2e8f0',
    cursor: '#38bdf8',
    cursorAccent: '#0f172a',
    selectionBackground: 'rgba(56, 189, 248, 0.28)',
    black: '#64748b',
    red: '#fb7185',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e2e8f0',
    brightBlack: '#94a3b8',
    brightRed: '#fb7185',
    brightGreen: '#4ade80',
    brightYellow: '#fbbf24',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#f8fafc',
  },
  forest: {
    background: '#1a2318',
    foreground: '#e7eedf',
    cursor: '#a3d977',
    cursorAccent: '#1a2318',
    selectionBackground: 'rgba(163, 217, 119, 0.28)',
    black: '#6b7a62',
    red: '#e07a5f',
    green: '#81b29a',
    yellow: '#f2cc8f',
    blue: '#7aa2e3',
    magenta: '#c9a7eb',
    cyan: '#8ecae6',
    white: '#e7eedf',
    brightBlack: '#8a9a80',
    brightRed: '#e07a5f',
    brightGreen: '#81b29a',
    brightYellow: '#f2cc8f',
    brightBlue: '#7aa2e3',
    brightMagenta: '#c9a7eb',
    brightCyan: '#8ecae6',
    brightWhite: '#f6f8f2',
  },
}

export function resolveTermTheme(prefs: ExplorerPrefs = current): XtermTheme {
  if (prefs.termTheme === 'auto') return autoTheme()
  return PALETTES[prefs.termTheme]
}

export function resolveTermFont(prefs: ExplorerPrefs = current): string {
  const key = pickKey(prefs)
  if (fontPickKey === key && fontPick.length > 0) return fontPick
  fontPick = buildTermFontStack(prefs)
  fontPickKey = key
  return fontPick
}

/** 等候选字体进文档后再重算栈，让 xterm 换掉构造时的回退字体。 */
export async function waitTermFont(prefs: ExplorerPrefs = current): Promise<void> {
  try { await document.fonts.ready } catch { /* ignore */ }
  const size = prefs.termFontSize
  for (const family of candidateFamilies(prefs)) {
    try { await document.fonts.load(`${String(size)}px ${family}`) } catch { /* ignore */ }
  }
  fontPickKey = ''
  resolveTermFont(prefs)
}
