# OpenCode Notification Sound Research

Researched from source (commit `e00890c`, branch `dev`). All paths relative to repo root.
Local clone: `.research/opencode/` (sparse: packages/app, packages/desktop, packages/ui).
Individual fetched files: `.research/files/packages/...`

## Repo identity

- `sst/opencode` **redirects to** `anomalyco/opencode` (GitHub API returns `full_name: anomalyco/opencode` for both). Default branch is **`dev`**, not `main`.
- The "Desktop app" (`packages/desktop`) is an **Electron shell** only (main/preload/renderer bootstrap, updater, WSL sidecar). The entire settings/notification UI lives in the shared app package **`packages/app`**, written in **SolidJS (+ @solidjs/router), NOT React**. Shared UI kit & audio assets live in **`packages/ui`**.
- Relevant DeepWiki page exists (deepwiki.com/sst/opencode/6.7-desktop-applications) but raw source was used instead.

## 1. Sound playback implementation — `packages/app/src/utils/sound.ts`

```ts
let files: Record<string, () => Promise<string>> | undefined
let loads: Record<SoundID, () => Promise<string>> | undefined

function getFiles() {
  if (files) return files
  // Vite lazy-imports every .aac asset in the ui package as a URL
  files = import.meta.glob("../../../ui/src/assets/audio/*.aac", { import: "default" }) as Record<string, () => Promise<string>>
  return files
}

export const SOUND_OPTIONS = [
  { id: "alert-01", label: "sound.option.alert01" },   // alert-01 .. alert-10
  // ... bip-bop-01..10, staplebops-01..07, nope-01..12, yup-01..06 (45 total)
] as const

export type SoundOption = (typeof SOUND_OPTIONS)[number]
export type SoundID = SoundOption["id"]

function getLoads() {
  if (loads) return loads
  loads = Object.fromEntries(
    Object.entries(getFiles()).flatMap(([path, load]) => {
      const file = path.split("/").at(-1)
      if (!file) return []
      return [[file.replace(/\.aac$/, ""), load] as const]
    }),
  ) as Record<SoundID, () => Promise<string>>
  return loads
}

const cache = new Map<SoundID, Promise<string | undefined>>()

export function soundSrc(id: string | undefined) {
  const loads = getLoads()
  if (!id || !(id in loads)) return Promise.resolve(undefined)
  const key = id as SoundID
  const hit = cache.get(key)
  if (hit) return hit
  const next = loads[key]().catch(() => undefined)
  cache.set(key, next)
  return next
}

export function playSound(src: string | undefined) {
  if (typeof Audio === "undefined") return
  if (!src) return
  const audio = new Audio(src)
  audio.play().catch(() => undefined)
  return () => {
    audio.pause()
    audio.currentTime = 0
  }
}

export function playSoundById(id: string | undefined) {
  return soundSrc(id).then((src) => playSound(src))
}
```

CSP gotcha (PR #11082 fixing #11081): Vite inlines assets <4KB as base64 `data:` URLs; the server CSP had to add `media-src "self" data:` (`packages/opencode/src/server/server.ts`) so small sounds preview correctly.

## 2. Sound files — `packages/ui/src/assets/audio/` (90 files)

| Family | Files | Formats |
|---|---|---|
| alert | alert-01 … alert-10 | .mp3 |
| bip-bop | bip-bop-01 … bip-bop-10 | .mp3 |
| staplebops | staplebops-01 … staplebops-07 | .aac + .mp3 |
| nope | nope-01 … nope-12 | .aac + .mp3 |
| yup | yup-01 … yup-06 | .mp3 |

Totals: 45 × .aac (~203 KB) + 45 × .mp3 (~276 KB). Playback globs only the **.aac** set (all 45 IDs exist as .aac; mp3 duplicates ship alongside).

Display labels from `packages/app/src/i18n/en.ts` (~lines 982–1027):
`"sound.option.staplebops01": "Staplebops 01"` … `"sound.option.nope03": "Nope 03"`, `"sound.option.yup06": "Yup 06"`, plus `"sound.option.none": "None"`.

## 3. Settings schema — `packages/app/src/context/settings.tsx`

```ts
export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string          // SoundID
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

// inside Settings: permissions.autoApprove:boolean, notifications, sounds ...

export const defaultSettings: Settings = {
  // ...
  notifications: { agent: true, permissions: true, errors: false },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
}
```

- Persisted client-side under storage key **`"settings.v3"`** via `persisted("settings.v3", createStore(defaultSettings))` (Solid store + localStorage persistence util `@/utils/persist`).
- Exposed through `useSettings()` context as accessors + setters, each wrapped with `withFallback(() => store.sounds?.agent, default)` for forward-compatible migration:
  `settings.sounds.agentEnabled()` / `setAgentEnabled(v)`, `settings.sounds.agent()` / `setAgent(id)`, same pattern for `permissions(Enabled)` and `errors(Enabled)`; `settings.notifications.agent()/permissions()/errors()` with matching setters.

## 4. Settings UI

### Current ("settings-v2") — `packages/app/src/components/settings-v2/general.tsx`

Notifications section = three toggle switches:

```tsx
const NotificationsSection = () => (
  <div class="settings-v2-section">
    <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>
    <SettingsListV2>
      <SettingsRowV2 title={language.t("settings.general.notifications.agent.title")}
                     description={language.t("settings.general.notifications.agent.description")}>
        <div data-action="settings-notifications-agent">
          <Switch checked={settings.notifications.agent()}
                  onChange={(checked) => settings.notifications.setAgent(checked)} />
        </div>
      </SettingsRowV2>
      {/* permissions + errors rows identical */}
    </SettingsListV2>
  </div>
)
```

Sounds section = one row per channel with an inline dropdown (`SelectV2`):

```tsx
const soundSettings = {
  agent:       { action: "settings-sounds-agent",       title: "settings.general.sounds.agent.title",       description: "settings.general.sounds.agent.description" },
  permissions: { action: "settings-sounds-permissions", ... },
  errors:      { action: "settings-sounds-errors",      ... },
} as const

const SoundsSection = (props) => (
  <div class="settings-v2-section">
    <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>
    <SettingsListV2>
      <SoundSetting kind="agent"       channel={props.controller.agent} />
      <SoundSetting kind="permissions" channel={props.controller.permissions} />
      <SoundSetting kind="errors"      channel={props.controller.errors} />
    </SettingsListV2>
  </div>
)

const SoundSetting = (props) => (
  <SettingsRowV2 title={...} description={...}>
    <SelectV2 appearance="inline" data-action={config().action}
      options={soundOptions} current={props.channel.current()}
      value={(option) => option.id} label={(option) => language.t(option.label)}
      onHighlight={props.channel.highlight} onSelect={props.channel.select}
      placement="bottom-end" gutter={6} />
  </SettingsRowV2>
)
```

Controller — `packages/app/src/components/settings-v2/general-controllers.ts`:

```ts
const noneSound = { id: "none", label: "sound.option.none" } as const
export const soundOptions = [noneSound, ...SOUND_OPTIONS]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)
  const channel = (enabled, current, setEnabled, set) => ({
    current: createMemo(() => enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound),
    highlight: (option) => {                       // hover previews the sound
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)
    },
    select: (option) => {                          // choosing "None" disables the channel
      if (!option) return
      if (option.id === "none") { setEnabled(false); preview.stop(); return }
      setEnabled(true); set(option.id); preview.play(option.id)
    },
  })
  return {
    agent: channel(settings.sounds.agentEnabled, settings.sounds.agent,
                   (v) => settings.sounds.setAgentEnabled(v), (id) => settings.sounds.setAgent(id)),
    permissions: channel(/* same shape */),
    errors: channel(/* same shape */),
  }
}
```

Preview debounce/race-guard — `general-controller-behavior.ts::createSoundPreviewController`: 100 ms setTimeout before playing; monotonically increasing `run` counter; earlier playbacks get their returned cleanup invoked immediately; `onCleanup(stop)`.

### Legacy — `packages/app/src/components/settings-general.tsx`

Same semantics with older primitives: `Switch` toggles for notifications (data-actions `settings-notifications-*`) and `Select` per sound row fed by `soundSelectProps(enabled, current, setEnabled, set)` (lines 225–253) with `playDemoSound`/`stopDemoSound`; `variant: "secondary"`, `triggerVariant: "settings"`.

## 5. Event wiring (who plays what)

- **Agent done** — `packages/app/src/context/notification.tsx::handleSessionIdle` (on `session.idle`, top-level sessions only):
  ```ts
  if (settings.sounds.agentEnabled()) void playSoundById(settings.sounds.agent())
  append({ type: "turn-complete", ... })
  if (settings.notifications.agent())
    void platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, () => input.navigate(href))
  ```
- **Error** — same file, `handleSessionError` (on `session.error`): plays `sounds.errors()` if `sounds.errorsEnabled()`, notifies if `notifications.errors()`. In-app notification stored in a persisted index (500 max, 30-day TTL), keyed by session/project.
- **Permission asked** — `packages/app/src/pages/layout.tsx` (lines ~444–451), on server event `permission.asked`:
  ```ts
  if (e.details.type === "permission.asked") {
    if (settings.sounds.permissionsEnabled()) void playSoundById(settings.sounds.permissions())
    if (settings.notifications.permissions()) void platform.notify(title, description, () => navigate(href))
  }
  ```
  Guards: skipped when `permission.autoResponds(...)`, per-session cooldown map (`alertedAtBySession`/`cooldownMs`), plus a persistent in-app toast. `question.asked` fires only the OS notification (`notifications.agent()`).
- **Desktop OS notification** — `packages/desktop/src/renderer/index.tsx` (platform implementation):
  ```ts
  notify: async (title, description, onClick) => {
    const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
    if (focused) return                      // never notify when window focused
    const notification = new Notification(title, { body: description ?? "", icon: "https://opencode.ai/favicon-96x96-v3.png" })
    notification.onclick = () => { void window.api.showWindow(); void window.api.setWindowFocus(); onClick?.(); notification.close() }
  }
  ```
  i.e., HTML Notification API in the renderer via preload `window.api`; Electron main process is not involved in sound or notify.

## 6. Third-party plugins (server/TUI-side alternative, unrelated to desktop UI)

- **ecology9191/opencode-notifier** (README titled "opencode-telegram-notifications"): OpenCode plugin; sounds via `paplay/aplay/mpv/ffplay` (Linux), Windows only supports `.wav` full paths; node-notifier system alerts; optional Telegram outbound; events: permission needed, session finished, error, question tool, plus silent-by-default `subagent_complete` and `user_cancelled`. Install: `opencode plugin opencode-telegram-notifications` or `"plugin": [...]` in opencode.json/tui.json.
- **@chousyn/opencode-alert@0.2.5** (npm; repo ThinkDonk/opencode-alert): "Cross-platform notification plugin for OpenCode — desktop alerts, sound alerts, and webhook notifications with project-level configuration".

## Key takeaways for anyone reimplementing

1. UI framework is SolidJS, not React; components are thin — state lives in one persisted settings store (`settings.v3`).
2. A single flat list of sound IDs drives both schema values and dropdown options; "None" doubles as the off switch (`*Enabled=false`).
3. Hover-to-preview + play-on-select is debounced (100 ms) with strict cleanup of prior Audio elements.
4. Sounds trigger from three server events: `session.idle`, `session.error`, `permission.asked` (plus notification-only on `question.asked`).
5. Watch the CSP: sub-4KB audio becomes `data:` URLs under Vite and needs `media-src 'self' data:'`.
