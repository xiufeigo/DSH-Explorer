/**
 * DSH-Explorer card on Settings → Plugins.
 * Hand-drawn; does not import official PluginCard (that package is not
 * on the module table). Prefs still live in localStorage and apply live.
 */

import { useEffect, useReducer, useState } from 'react'
import {
  DEFAULT_PREFS,
  getPrefs,
  resetPrefs,
  setPrefs,
  subscribePrefs,
  type ExplorerPrefs,
  type TermFontId,
  type TermThemeId,
  type SoundId,
} from './prefs'
import { SOUND_OPTIONS, playNotificationSound } from './soundPlayer'
import { clearWorkspaceDocks, getWorkspacePinSummary, resetWorkspacePinOrder } from './workspaceRecencyOrder'

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

/** Check if the prefs have any notification-related changes from defaults. */
function isNotificationDirty(prefs: ExplorerPrefs): boolean {
  return prefs.notifyAgent !== DEFAULT_PREFS.notifyAgent
    || prefs.notifyPermission !== DEFAULT_PREFS.notifyPermission
    || prefs.notifyError !== DEFAULT_PREFS.notifyError
    || prefs.soundAgent !== DEFAULT_PREFS.soundAgent
    || prefs.soundPermission !== DEFAULT_PREFS.soundPermission
    || prefs.soundError !== DEFAULT_PREFS.soundError
}
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`dshx-set-toggle${checked ? ' on' : ''}`}
      onClick={() => { onChange(!checked) }}
    >
      <span className="dshx-set-toggle-thumb" />
    </button>
  )
}

function SoundSelect({ value, onChange }: { value: SoundId; onChange: (v: SoundId) => void }): JSX.Element {
  return (
    <div className="dshx-set-sound-row">
      <select
        className="dshx-set-input dshx-set-sound-select"
        value={value}
        onChange={event => { onChange(event.target.value as SoundId) }}
      >
        {SOUND_OPTIONS.map(opt => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
      </select>
      <button
        type="button"
        className="dshx-set-sound-preview"
        title="预览音效"
        onClick={() => { playNotificationSound(value) }}
      >
        ▶
      </button>
    </div>
  )
}

export function ExplorerSettingsCard(): JSX.Element {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [open, setOpen] = useState(false)
  useEffect(() => subscribePrefs(bump), [])
  const prefs = getPrefs()
  const termDirty = prefs.termTheme !== DEFAULT_PREFS.termTheme
    || prefs.termFontSize !== DEFAULT_PREFS.termFontSize
    || prefs.termFont !== DEFAULT_PREFS.termFont
    || prefs.termFontCustom !== DEFAULT_PREFS.termFontCustom
  const notifDirty = isNotificationDirty(prefs)
  const workspaceDirty = prefs.sortWorkspacesByRecency !== DEFAULT_PREFS.sortWorkspacesByRecency
  const dirty = termDirty || notifDirty || workspaceDirty

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
          <span className="dshx-set-desc">终端、通知与音效；工作区可按最后会话时间排序并支持置顶。右侧栏宽度会记住上次拖拽结果。</span>
        </span>
        <span className="dshx-set-chevron" aria-hidden />
      </button>
      {open
        ? (
          <div className="dshx-set-body">
            {/* ── 终端设置 ── */}
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

            {/* ── 系统通知 ── */}
            <div className="dshx-set-section-title">系统通知</div>
            <div className="dshx-set-field dshx-set-notif-row">
              <div className="dshx-set-notif-info">
                <span className="dshx-set-label">智能体</span>
                <span className="dshx-set-hint">当智能体完成或需要注意时显示系统通知</span>
              </div>
              <Toggle
                checked={prefs.notifyAgent}
                onChange={v => { setPrefs({ notifyAgent: v }) }}
              />
            </div>
            <div className="dshx-set-field dshx-set-notif-row">
              <div className="dshx-set-notif-info">
                <span className="dshx-set-label">权限</span>
                <span className="dshx-set-hint">当需要权限时显示系统通知</span>
              </div>
              <Toggle
                checked={prefs.notifyPermission}
                onChange={v => { setPrefs({ notifyPermission: v }) }}
              />
            </div>
            <div className="dshx-set-field dshx-set-notif-row">
              <div className="dshx-set-notif-info">
                <span className="dshx-set-label">错误</span>
                <span className="dshx-set-hint">发生错误时显示系统通知</span>
              </div>
              <Toggle
                checked={prefs.notifyError}
                onChange={v => { setPrefs({ notifyError: v }) }}
              />
            </div>

            {/* ── 音效 ── */}
            <div className="dshx-set-section-title">音效</div>
            <div className="dshx-set-field dshx-set-notif-row">
              <div className="dshx-set-notif-info">
                <span className="dshx-set-label">智能体</span>
                <span className="dshx-set-hint">当智能体完成或需要注意时播放声音</span>
              </div>
              <SoundSelect
                value={prefs.soundAgent}
                onChange={v => { setPrefs({ soundAgent: v }) }}
              />
            </div>
            <div className="dshx-set-field dshx-set-notif-row">
              <div className="dshx-set-notif-info">
                <span className="dshx-set-label">权限</span>
                <span className="dshx-set-hint">当需要权限时播放声音</span>
              </div>
              <SoundSelect
                value={prefs.soundPermission}
                onChange={v => { setPrefs({ soundPermission: v }) }}
              />
            </div>
            <div className="dshx-set-field dshx-set-notif-row">
              <div className="dshx-set-notif-info">
                <span className="dshx-set-label">错误</span>
                <span className="dshx-set-hint">发生错误时播放声音</span>
              </div>
              <SoundSelect
                value={prefs.soundError}
                onChange={v => { setPrefs({ soundError: v }) }}
              />
            </div>

            {/* ── 工作区 ── */}
            <div className="dshx-set-section-title">工作区</div>
            <div className="dshx-set-field dshx-set-notif-row">
              <div className="dshx-set-notif-info">
                <span className="dshx-set-label">按最后会话时间排序</span>
                <span className="dshx-set-hint">左侧栏工作区随会话活动自动把最近的排到最前（重启后顺序保留）。手动拖拽不会被覆盖：普通区里拖动 = 把它钉在落点，其他项继续跟时间流动。</span>
              </div>
              <Toggle
                checked={prefs.sortWorkspacesByRecency}
                onChange={v => { setPrefs({ sortWorkspacesByRecency: v }) }}
              />
            </div>
            {(() => {
              const pins = getWorkspacePinSummary()
              if (pins.count === 0 && pins.dockedCount === 0) {
                return (
                  <div className="dshx-set-field">
                    <span className="dshx-set-hint">置顶：在左侧栏按住工作区行拖动即可调整位置——拖到最顶即置顶（置顶行有左侧色条），拖到普通区某处则钉在那个位置不再跟时间流动；把置顶项拖回普通区即取消置顶。</span>
                  </div>
                )
              }
              return (
                <div className="dshx-set-field dshx-set-notif-row">
                  <div className="dshx-set-notif-info">
                    <span className="dshx-set-label">
                      {[
                        pins.count > 0 ? `已置顶 ${String(pins.count)} 个` : '',
                        pins.dockedCount > 0 ? `手动定位 ${String(pins.dockedCount)} 个` : '',
                      ].filter(Boolean).join('，')}
                    </span>
                    <span className="dshx-set-hint">
                      {[
                        pins.count > 0 ? (pins.mode === 'custom' ? '置顶顺序已按你的操作固定' : '置顶正跟随会话时间') : '',
                        pins.dockedCount > 0 ? '被拖动定位的工作区不再跟时间流动' : '',
                      ].filter(Boolean).join('；')}
                    </span>
                  </div>
                  <div className="dshx-set-sound-row">
                    {pins.dockedCount > 0
                      ? (
                        <button
                          type="button"
                          className="dshx-set-reset"
                          onClick={() => { clearWorkspaceDocks(); bump() }}
                        >
                          清除定位
                        </button>
                      )
                      : null}
                    {pins.count > 0 && pins.mode === 'custom'
                      ? (
                        <button
                          type="button"
                          className="dshx-set-reset"
                          onClick={() => { resetWorkspacePinOrder(); bump() }}
                        >
                          恢复时间排序
                        </button>
                      )
                      : null}
                  </div>
                </div>
              )
            })()}

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
