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
  notifyAgent: boolean
  notifyPermission: boolean
  notifyError: boolean
  soundAgent: 'none' | 'staplebops-01' | 'staplebops-02' | 'nope-03' | 'chime-soft' | 'chime-bright' | 'alert-low' | 'alert-high'
  soundPermission: 'none' | 'staplebops-01' | 'staplebops-02' | 'nope-03' | 'chime-soft' | 'chime-bright' | 'alert-low' | 'alert-high'
  soundError: 'none' | 'staplebops-01' | 'staplebops-02' | 'nope-03' | 'chime-soft' | 'chime-bright' | 'alert-low' | 'alert-high'
  sortWorkspacesByRecency: boolean
}

const THEMES = ['auto', 'light', 'dark', 'slate', 'forest'] as const
const FONTS = ['ui', 'code', 'mono', 'custom'] as const
const SOUNDS = ['none', 'staplebops-01', 'staplebops-02', 'nope-03', 'chime-soft', 'chime-bright', 'alert-low', 'alert-high'] as const
const THEME_SET = new Set<string>(THEMES)
const FONT_SET = new Set<string>(FONTS)
const SOUND_SET = new Set<string>(SOUNDS)

const DEFAULT_SECTION: ExplorerSettingsSection = {
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
    notifyAgent: typeof raw.notifyAgent === 'boolean' ? raw.notifyAgent : DEFAULT_SECTION.notifyAgent,
    notifyPermission: typeof raw.notifyPermission === 'boolean' ? raw.notifyPermission : DEFAULT_SECTION.notifyPermission,
    notifyError: typeof raw.notifyError === 'boolean' ? raw.notifyError : DEFAULT_SECTION.notifyError,
    soundAgent: typeof raw.soundAgent === 'string' && SOUND_SET.has(raw.soundAgent) ? raw.soundAgent as ExplorerSettingsSection['soundAgent'] : DEFAULT_SECTION.soundAgent,
    soundPermission: typeof raw.soundPermission === 'string' && SOUND_SET.has(raw.soundPermission) ? raw.soundPermission as ExplorerSettingsSection['soundPermission'] : DEFAULT_SECTION.soundPermission,
    soundError: typeof raw.soundError === 'string' && SOUND_SET.has(raw.soundError) ? raw.soundError as ExplorerSettingsSection['soundError'] : DEFAULT_SECTION.soundError,
    sortWorkspacesByRecency: typeof raw.sortWorkspacesByRecency === 'boolean' ? raw.sortWorkspacesByRecency : DEFAULT_SECTION.sortWorkspacesByRecency,
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
    additionalProperties: false,
    properties: {
      termTheme: { type: 'string', enum: [...THEMES], default: DEFAULT_SECTION.termTheme },
      termFontSize: { type: 'number', default: DEFAULT_SECTION.termFontSize },
      termFont: { type: 'string', enum: [...FONTS], default: DEFAULT_SECTION.termFont },
      termFontCustom: { type: 'string', default: DEFAULT_SECTION.termFontCustom },
      notifyAgent: { type: 'boolean', default: DEFAULT_SECTION.notifyAgent },
      notifyPermission: { type: 'boolean', default: DEFAULT_SECTION.notifyPermission },
      notifyError: { type: 'boolean', default: DEFAULT_SECTION.notifyError },
      soundAgent: { type: 'string', enum: [...SOUNDS], default: DEFAULT_SECTION.soundAgent },
      soundPermission: { type: 'string', enum: [...SOUNDS], default: DEFAULT_SECTION.soundPermission },
      soundError: { type: 'string', enum: [...SOUNDS], default: DEFAULT_SECTION.soundError },
      sortWorkspacesByRecency: { type: 'boolean', default: DEFAULT_SECTION.sortWorkspacesByRecency },
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
