/**
 * Host settings 命名空间。
 *
 * 「插件配置」keyed 座位只渲染 describe ∩ 已注册卡片 key 的交集。
 * 没在 Host `settings.register` 的 ns 不会出现在 describe 里，卡片派发不到。
 * 协议放行已注册的 kebab-case ns；字段值仍由浏览器 localStorage 持有。
 */

export const EXPLORER_SETTINGS_NS = 'dsh-explorer'

export interface ExplorerSettingsSection {
  termTheme: 'auto' | 'light' | 'dark' | 'slate' | 'forest'
  termFontSize: number
  termFont: 'ui' | 'code' | 'mono' | 'custom'
  termFontCustom: string
}

const THEMES = new Set(['auto', 'light', 'dark', 'slate', 'forest'])
const FONTS = new Set(['ui', 'code', 'mono', 'custom'])

function clipSize(n: unknown): number {
  const value = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(value)) return 13
  return Math.min(22, Math.max(11, Math.round(value)))
}

function parseSection(input: unknown): ExplorerSettingsSection {
  const raw = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const theme = raw.termTheme
  const font = raw.termFont
  return {
    termTheme: typeof theme === 'string' && THEMES.has(theme)
      ? theme as ExplorerSettingsSection['termTheme']
      : 'auto',
    termFontSize: clipSize(raw.termFontSize),
    termFont: typeof font === 'string' && FONTS.has(font)
      ? font as ExplorerSettingsSection['termFont']
      : 'ui',
    termFontCustom: typeof raw.termFontCustom === 'string' ? raw.termFontCustom.slice(0, 120) : '',
  }
}

/**
 * schemastery 形：可调用（resolve）+ `toJSON`（describe 序列化）。
 * 不依赖 `@deepseek-ai/schemastery` 包，Host 侧照样能 register。
 */
export const explorerSettingsSchema = Object.assign(parseSection, {
  toJSON: () => ({
    type: 'object',
    properties: {
      termTheme: { type: 'string' },
      termFontSize: { type: 'number' },
      termFont: { type: 'string' },
      termFontCustom: { type: 'string' },
    },
  }),
})

interface SettingsLike {
  register(ns: string, schema: unknown, options?: { applies?: string }): unknown
}

interface SettingsOwner {
  get(name: string): unknown
  inject?(deps: string[], callback: (owner: { get(name: string): unknown }) => void): unknown
}

/** settings 服务就绪后注册 ns；没有该服务时整插件照常工作。 */
export function registerExplorerSettings(ctx: SettingsOwner): void {
  const attach = (owner: { get(name: string): unknown }): void => {
    const settings = owner.get('settings') as SettingsLike | undefined
    if (settings === undefined || typeof settings.register !== 'function') return
    try {
      settings.register(EXPLORER_SETTINGS_NS, explorerSettingsSchema, { applies: 'live' })
    } catch (error) {
      console.error('dsh-explorer: settings.register 失败', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], attach)
    return
  }
  attach(ctx)
}
