/**
 * Host settings namespace.
 *
 * The plugin-config keyed seat only renders describe ∩ registered card keys.
 * A namespace that never calls Host `settings.register` never appears in
 * describe, so the card is never dispatched. The protocol admits a registered
 * kebab-case ns; field values still live in browser localStorage.
 *
 * The schema is a callable Standard Schema (schemastery-shaped: `schema(input)`
 * + `toJSON`) so `ctx.settings.register` can resolve and serialize it. We do
 * not depend on `@deepseek-ai/schemastery` — that package is harness-vendored.
 */

export const EXPLORER_SETTINGS_NS = 'dsh-explorer'

export interface ExplorerSettingsSection {
  termTheme: 'auto' | 'light' | 'dark' | 'slate' | 'forest'
  termFontSize: number
  termFont: 'ui' | 'code' | 'mono' | 'custom'
  termFontCustom: string
}

const THEMES = ['auto', 'light', 'dark', 'slate', 'forest'] as const
const FONTS = ['ui', 'code', 'mono', 'custom'] as const
const THEME_SET = new Set<string>(THEMES)
const FONT_SET = new Set<string>(FONTS)

const DEFAULT_SECTION: ExplorerSettingsSection = {
  termTheme: 'auto',
  termFontSize: 13,
  termFont: 'code',
  termFontCustom: '',
}

function clipSize(n: unknown): number {
  const value = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(value)) return DEFAULT_SECTION.termFontSize
  return Math.min(22, Math.max(11, Math.round(value)))
}

function parseSection(input: unknown): ExplorerSettingsSection {
  const raw = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const theme = raw.termTheme
  const font = raw.termFont
  return {
    termTheme: typeof theme === 'string' && THEME_SET.has(theme)
      ? theme as ExplorerSettingsSection['termTheme']
      : DEFAULT_SECTION.termTheme,
    termFontSize: clipSize(raw.termFontSize),
    termFont: typeof font === 'string' && FONT_SET.has(font)
      ? font as ExplorerSettingsSection['termFont']
      : DEFAULT_SECTION.termFont,
    termFontCustom: typeof raw.termFontCustom === 'string' ? raw.termFontCustom.slice(0, 120) : '',
  }
}

interface StandardResult { value: ExplorerSettingsSection }
interface StandardSchema {
  readonly version: 1
  readonly vendor: 'dsh-explorer'
  validate(value: unknown): StandardResult
}

/**
 * Callable schema + `toJSON` + Standard Schema (`~standard`), matching what
 * Host `settings.register` / `describe` invoke. Values are not persisted here.
 */
export const explorerSettingsSchema = Object.assign(parseSection, {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-explorer' as const,
    validate(value: unknown): StandardResult {
      return { value: parseSection(value) }
    },
  } satisfies StandardSchema,
  toJSON: () => ({
    type: 'object',
    properties: {
      termTheme: { type: 'string', enum: [...THEMES], default: DEFAULT_SECTION.termTheme },
      termFontSize: { type: 'number', default: DEFAULT_SECTION.termFontSize },
      termFont: { type: 'string', enum: [...FONTS], default: DEFAULT_SECTION.termFont },
      termFontCustom: { type: 'string', default: DEFAULT_SECTION.termFontCustom },
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

/** Register the ns once `settings` is up; the rest of the plugin still runs without it. */
export function registerExplorerSettings(ctx: SettingsOwner): void {
  const attach = (owner: { get(name: string): unknown }): void => {
    const settings = owner.get('settings') as SettingsLike | undefined
    if (settings === undefined || typeof settings.register !== 'function') return
    try {
      settings.register(EXPLORER_SETTINGS_NS, explorerSettingsSchema, { applies: 'live' })
    } catch (error) {
      console.error('dsh-explorer: settings.register failed', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], attach)
    return
  }
  attach(ctx)
}
