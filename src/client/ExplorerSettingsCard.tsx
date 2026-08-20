/**
 * 设置 → 插件配置 里的 DSH-Explorer 卡片。
 * 自绘卡片，不依赖官方 PluginCard（那是另一个包，不在模块表里）。
 */

import { useEffect, useReducer, useState } from 'react'
import {
  DEFAULT_PREFS,
  getPrefs,
  resetPrefs,
  setPrefs,
  subscribePrefs,
  type TermFontId,
  type TermThemeId,
} from './prefs'

const THEME_OPTS: { id: TermThemeId; label: string }[] = [
  { id: 'auto', label: '跟随界面' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'slate', label: '石板' },
  { id: 'forest', label: '森林' },
]

const FONT_OPTS: { id: TermFontId; label: string }[] = [
  { id: 'code', label: '跟随代码字体' },
  { id: 'mono', label: '系统等宽' },
  { id: 'ui', label: '跟随界面（正文）' },
  { id: 'custom', label: '自定义' },
]

export function ExplorerSettingsCard(): JSX.Element {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [open, setOpen] = useState(false)
  useEffect(() => subscribePrefs(bump), [])
  const prefs = getPrefs()
  const dirty = prefs.termTheme !== DEFAULT_PREFS.termTheme
    || prefs.termFontSize !== DEFAULT_PREFS.termFontSize
    || prefs.termFont !== DEFAULT_PREFS.termFont
    || prefs.termFontCustom !== DEFAULT_PREFS.termFontCustom

  return (
    <li className={`dshx-set-card${open ? ' open' : ''}`}>
      <button
        type="button"
        className="dshx-set-head"
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        <span className="dshx-set-copy">
          <span className="dshx-set-name">DSH-Explorer</span>
          <span className="dshx-set-desc">底部终端的配色、字号和字体。右侧栏宽度会记住上次拖拽结果。</span>
        </span>
        <span className="dshx-set-chevron" aria-hidden />
      </button>
      {open
        ? (
          <div className="dshx-set-body">
            <label className="dshx-set-field">
              <span className="dshx-set-label">终端配色</span>
              <select
                className="dshx-set-input"
                value={prefs.termTheme}
                onChange={event => { setPrefs({ termTheme: event.target.value as TermThemeId }) }}
              >
                {THEME_OPTS.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
              <span className="dshx-set-hint">「跟随界面」用当前主题的底色和字色。</span>
            </label>
            <label className="dshx-set-field">
              <span className="dshx-set-label">字体大小（{prefs.termFontSize}px）</span>
              <input
                className="dshx-set-range"
                type="range"
                min={11}
                max={22}
                step={1}
                value={prefs.termFontSize}
                onChange={event => { setPrefs({ termFontSize: Number(event.target.value) }) }}
              />
            </label>
            <label className="dshx-set-field">
              <span className="dshx-set-label">字体</span>
              <select
                className="dshx-set-input"
                value={prefs.termFont}
                onChange={event => { setPrefs({ termFont: event.target.value as TermFontId }) }}
              >
                {FONT_OPTS.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
              <span className="dshx-set-hint">跟编辑器同一套系统字体名（例如 JetBrains Mono NL）。「跟随界面」是比例正文，格子会不齐。</span>
            </label>
            {prefs.termFont === 'custom'
              ? (
                <label className="dshx-set-field">
                  <span className="dshx-set-label">自定义字体名</span>
                  <input
                    className="dshx-set-input"
                    type="text"
                    placeholder="例如 JetBrains Mono NL"
                    value={prefs.termFontCustom}
                    onChange={event => { setPrefs({ termFontCustom: event.target.value }) }}
                  />
                </label>
              )
              : null}
            <div className="dshx-set-foot">
              <button
                type="button"
                className="dshx-set-reset"
                disabled={!dirty}
                onClick={() => { resetPrefs() }}
              >
                恢复默认
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
