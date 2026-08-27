# OpenCode Desktop Notification Sound — Implementation Research

Researched 2026-08-22 from `anomalyco/opencode` branch **`dev`** (commit `e00890c`).
Corroborated by two independent fetch agents reading raw.githubusercontent.com, github.com file pages,
the GitHub audio directory listing, issue #11081, PR #11082, and DeepWiki.

> **Key correction to the premise:** the notification-sound feature is **not** in
> `packages/desktop/src`. That package is only an Electron shell (`main/`, `preload/`, `renderer/` —
> windows, IPC, store, updater; no audio code). The whole feature lives in the shared SolidJS web UI
> package **`packages/app`** with audio assets in **`packages/ui`**, which the Electron desktop app embeds.
> (`main` branch returns 404 for this tree; `dev` is the usable branch. DeepWiki's "Tauri" desktop page is stale.)

---

## 1. Architecture overview

```
session.idle / session.error / permission.asked  (server events)
        │
        ▼
packages/app/src/context/notification.tsx   (agent + error sounds)
packages/app/src/pages/layout.tsx           (permission sound, 5 s cooldown)
        │  settings.sounds.{agent,permissions,errors}Enabled()
        ▼
playSoundById(id)                           packages/app/src/utils/sound.ts
        │  Vite import.meta.glob("../../../ui/src/assets/audio/*.aac")
        ▼  lazy dynamic import → URL or inline data: URL (<4 KB files)
new Audio(src).play()                       plain HTMLAudioElement — no Tauri/Electron/native API
```

Native OS notifications are separate: `platform.notify(...)` → Web `new Notification(...)`
implemented in `packages/desktop/src/renderer/index.tsx` (~L235-248).

## 2. Sound registry + playback — `packages/app/src/utils/sound.ts`

Complete file:

```ts
let files: Record<string, () => Promise<string>> | undefined
let loads: Record<SoundID, () => Promise<string>> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob("../../../ui/src/assets/audio/*.aac", { import: "default" }) as Record<
    string,
    () => Promise<string>
  >
  return files
}

export const SOUND_OPTIONS = [
  { id: "alert-01", label: "sound.option.alert01" },
  { id: "alert-02", label: "sound.option.alert02" },
  { id: "alert-03", label: "sound.option.alert03" },
  { id: "alert-04", label: "sound.option.alert04" },
  { id: "alert-05", label: "sound.option.alert05" },
  { id: "alert-06", label: "sound.option.alert06" },
  { id: "alert-07", label: "sound.option.alert07" },
  { id: "alert-08", label: "sound.option.alert08" },
  { id: "alert-09", label: "sound.option.alert09" },
  { id: "alert-10", label: "sound.option.alert10" },
  { id: "bip-bop-01", label: "sound.option.bipbop01" },
  { id: "bip-bop-02", label: "sound.option.bipbop02" },
  { id: "bip-bop-03", label: "sound.option.bipbop03" },
  { id: "bip-bop-04", label: "sound.option.bipbop04" },
  { id: "bip-bop-05", label: "sound.option.bipbop05" },
  { id: "bip-bop-06", label: "sound.option.bipbop06" },
  { id: "bip-bop-07", label: "sound.option.bipbop07" },
  { id: "bip-bop-08", label: "sound.option.bipbop08" },
  { id: "bip-bop-09", label: "sound.option.bipbop09" },
  { id: "bip-bop-10", label: "sound.option.bipbop10" },
  { id: "staplebops-01", label: "sound.option.staplebops01" },
  { id: "staplebops-02", label: "sound.option.staplebops02" },
  { id: "staplebops-03", label: "sound.option.staplebops03" },
  { id: "staplebops-04", label: "sound.option.staplebops04" },
  { id: "staplebops-05", label: "sound.option.staplebops05" },
  { id: "staplebops-06", label: "sound.option.staplebops06" },
  { id: "staplebops-07", label: "sound.option.staplebops07" },
  { id: "nope-01", label: "sound.option.nope01" },
  { id: "nope-02", label: "sound.option.nope02" },
  { id: "nope-03", label: "sound.option.nope03" },
  { id: "nope-04", label: "sound.option.nope04" },
  { id: "nope-05", label: "sound.option.nope05" },
  { id: "nope-06", label: "sound.option.nope06" },
  { id: "nope-07", label: "sound.option.nope07" },
  { id: "nope-08", label: "sound.option.nope08" },
  { id: "nope-09", label: "sound.option.nope09" },
  { id: "nope-10", label: "sound.option.nope10" },
  { id: "nope-11", label: "sound.option.nope11" },
  { id: "nope-12", label: "sound.option.nope12" },
  { id: "yup-01", label: "sound.option.yup01" },
  { id: "yup-02", label: "sound.option.yup02" },
  { id: "yup-03", label: "sound.option.yup03" },
  { id: "yup-04", label: "sound.option.yup04" },
  { id: "yup-05", label: "sound.option.yup05" },
  { id: "yup-06", label: "sound.option.yup06" },
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

Mechanism notes:
- Vite `import.meta.glob` lazily dynamic-imports each `.aac`; the import resolves to a bundled asset
  URL — or an inline base64 `data:` URL for files under Vite's ~4 KB inline threshold.
- Playback is a plain `HTMLAudioElement`. No Tauri API, no Electron IPC, no native player.

## 3. Settings schema — `packages/app/src/context/settings.tsx`

No Zod. Plain TypeScript interfaces persisted via a SolidJS store under key **`settings.v3`**
(`persisted("settings.v3", createStore<Settings>(defaultSettings))`; on desktop this maps to
Electron IPC-backed storage):

```ts
export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string          // SoundID or "none"
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface Settings {
  general: { /* autoSave, releaseNotes, followup: "queue"|"steer", showFileTree, ... */ }
  appearance: { fontSize: number; mono: string; sans: string; terminal: string }
  keybinds: Record<string, string>
  permissions: { autoApprove: boolean }
  notifications: NotificationSettings
  sounds: SoundSettings
}
```

Defaults (source of "Staplebops 01/02" and "Nope 03"):

```ts
notifications: {
  agent: true,
  permissions: true,
  errors: false,
},
sounds: {
  agentEnabled: true,
  agent: "staplebops-01",
  permissionsEnabled: true,
  permissions: "staplebops-02",
  errorsEnabled: true,
  errors: "nope-03",
},
```

Accessors exposed by the context (pattern repeated per key):

```ts
notifications: {
  agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
  setAgent(value: boolean) { setStore("notifications", "agent", value) },
  // ... permissions / errors identical
},
sounds: {
  agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
  setAgentEnabled(value: boolean) { setStore("sounds", "agentEnabled", value) },
  agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
  setAgent(value: string) { setStore("sounds", "agent", value) },
  // ... permissions / errors identical
},
```

(Getters/setters at approximately `settings.tsx#L478-L519`.)

## 4. Settings UI (current "v2") — `packages/app/src/components/settings-v2/`

There is **no** `settings-notification.tsx`; notifications + sounds are sections of the **General**
tab, mounted by `dialog-settings-v2.tsx`.

### `general-controllers.ts` — dropdown controller with preview

```ts
const noneSound = { id: "none", label: "sound.option.none" } as const
export const soundOptions = [noneSound, ...SOUND_OPTIONS]
export type SoundSelectOption = (typeof soundOptions)[number]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)
  const channel = (
    enabled: Accessor<boolean>,
    current: Accessor<string>,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    current: createMemo(() =>
      enabled() ? (soundOptions.find((option) => option.id === current()) ?? noneSound) : noneSound,
    ),
    highlight: (option: SoundSelectOption | undefined) => {
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)   // hover-preview
    },
    select: (option: SoundSelectOption | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)                                          // "None" disables channel
        preview.stop()
        return
      }
      setEnabled(true)
      set(option.id)
      preview.play(option.id)                                      // select plays + persists
    },
  })

  return {
    agent: channel(
      settings.sounds.agentEnabled,
      settings.sounds.agent,
      (value) => settings.sounds.setAgentEnabled(value),
      (id) => settings.sounds.setAgent(id),
    ),
    permissions: channel(
      settings.sounds.permissionsEnabled,
      settings.sounds.permissions,
      (value) => settings.sounds.setPermissionsEnabled(value),
      (id) => settings.sounds.setPermissions(id),
    ),
    errors: channel(
      settings.sounds.errorsEnabled,
      settings.sounds.errors,
      (value) => settings.sounds.setErrorsEnabled(value),
      (id) => settings.sounds.setErrors(id),
    ),
  }
}
```

### `general-controller-behavior.ts` — 100 ms hover-preview debounce

```ts
export function createSoundPreviewController(player: (id: string | undefined) => Promise<(() => void) | undefined>) {
  let cleanup: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let run = 0

  const stop = () => {
    run += 1
    cleanup?.()
    clearTimeout(timeout)
    cleanup = undefined
    timeout = undefined
  }
  const play = (id: string | undefined) => {
    stop()
    if (!id) return
    const current = ++run
    timeout = setTimeout(() => {
      timeout = undefined
      void player(id).then((next) => {
        if (run === current) {
          cleanup = next
          return
        }
        next?.()
      })
    }, 100)
  }

  onCleanup(stop)
  return { play, stop }
}
```

### `general.tsx` — rendered sections

```tsx
const soundSettings = {
  agent:       { action: "settings-sounds-agent",       title: "settings.general.sounds.agent.title",       description: "settings.general.sounds.agent.description" },
  permissions: { action: "settings-sounds-permissions", title: "settings.general.sounds.permissions.title", description: "settings.general.sounds.permissions.description" },
  errors:      { action: "settings-sounds-errors",      title: "settings.general.sounds.errors.title",      description: "settings.general.sounds.errors.description" },
} as const

const SoundsSection: Component<{ controller: SoundSettingsController }> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>
      <SettingsListV2>
        <SoundSetting kind="agent" channel={props.controller.agent} />
        <SoundSetting kind="permissions" channel={props.controller.permissions} />
        <SoundSetting kind="errors" channel={props.controller.errors} />
      </SettingsListV2>
    </div>
  )
}

const SoundSetting: Component<{
  kind: "agent" | "permissions" | "errors"
  channel: SoundSettingsController["agent"]
}> = (props) => {
  const language = useLanguage()
  const config = () => soundSettings[props.kind]
  return (
    <SettingsRowV2 title={language.t(config().title)} description={language.t(config().description)}>
      <SelectV2
        appearance="inline"
        data-action={config().action}
        options={soundOptions}
        current={props.channel.current()}
        value={(option) => option.id}
        label={(option) => language.t(option.label)}
        onHighlight={props.channel.highlight}
        onSelect={props.channel.select}
        placement="bottom-end"
        gutter={6}
      />
    </SettingsRowV2>
  )
}

const NotificationsSection = () => (
  <div class="settings-v2-section">
    <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>
    <SettingsListV2>
      {/* three explicit rows in source; loop here preserves behavior */}
      {(["agent", "permissions", "errors"] as const).map((kind) => (
        <SettingsRowV2
          title={language.t(`settings.general.notifications.${kind}.title`)}
          description={language.t(`settings.general.notifications.${kind}.description`)}
        >
          <div data-action={`settings-notifications-${kind}`}>
            <Switch
              checked={settings.notifications[kind]()}
              onChange={(checked) =>
                settings.notifications[`set${kind[0].toUpperCase()}${kind.slice(1)}`](checked)
              }
            />
          </div>
        </SettingsRowV2>
      ))}
    </SettingsListV2>
  </div>
)
```

(Literal rows at `general.tsx#L199-L234` and `#L419-L458`.)
Note the UX detail: a sound channel's on/off state is folded into its dropdown — picking
**None** calls `setEnabled(false)`; picking any sound enables the channel.

Legacy UI: `packages/app/src/components/settings-general.tsx` has the equivalent older
`soundSelectProps` / `playDemoSound` / `stopDemoSound` logic with the same 100 ms debounce.

## 5. Runtime triggers

### `packages/app/src/context/notification.tsx` (agent + error)

```tsx
const handleSessionIdle = (directory: string, event: { properties: { sessionID?: string } }, time: number) => {
  const sessionID = event.properties.sessionID
  void lookup(directory, sessionID).then((session) => {
    if (meta.disposed) return
    if (!session) return
    if (session.parentID) return            // top-level sessions only

    if (settings.sounds.agentEnabled()) {
      void playSoundById(settings.sounds.agent())
    }

    append({ directory, time, viewed: viewedInCurrentSession(directory, sessionID), type: "turn-complete", session: sessionID })

    const href = `/${base64Encode(directory)}/session/${sessionID}`
    if (settings.notifications.agent()) {
      void platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, () =>
        input.navigate(href),
      )
    }
  })
}

// handleSessionError(...) similarly:
//   if (settings.sounds.errorsEnabled()) void playSoundById(settings.sounds.errors())
//   if (settings.notifications.errors()) void platform.notify(...)

const unsub = serverSDK().event.listen((e) => {
  const event = e.details
  if (event.type !== "session.idle" && event.type !== "session.error") return
  const directory = e.name
  const time = Date.now()
  if (event.type === "session.idle") {
    handleSessionIdle(directory, event, time)
    return
  }
  handleSessionError(directory, event, time)
})
```

### Permission sound — `packages/app/src/pages/layout.tsx` (#L391-L425)

Plays the permissions sound on `permission.asked` with a five-second per-session cooldown.
(Sound playback is independent of the native-notification toggle and window-focus check.)

## 6. Sound files — `packages/ui/src/assets/audio/`

45 sounds; each exists as `.aac` (used by the app) and `.mp3` (unused copy). The **sound ID equals
the filename minus `.aac`**. Sizes ~1.6–12 KB — which is why Vite inlines some as `data:` URLs.

| Family | IDs / files | Display labels (i18n `sound.option.*`, e.g. en.ts) |
|---|---|---|
| Alert | `alert-01` … `alert-10` → `alert-01.aac` … | "Alert 01" … |
| Bip-bop | `bip-bop-01` … `bip-bop-10` → `.aac` | "Bip-bop 01" … |
| Staplebops | `staplebops-01` … `staplebops-07` → `.aac` | "Staplebops 01" … |
| Nope | `nope-01` … `nope-12` → `.aac` | "Nope 01" … |
| Yup | `yup-01` … `yup-06` → `.aac` | "Yup 01" … |
| None | (no file — disables the channel) | "None" |

Defaults: Agent → **Staplebops 01** (`staplebops-01.aac`) · Permissions → **Staplebops 02**
(`staplebops-02.aac`) · Errors → **Nope 03** (`nope-03.aac`).

## 7. Issue #11081 & PR #11082 (data:-URL CSP fix)

- [Issue #11081](https://github.com/anomalyco/opencode/issues/11081): hovering small sounds
  (Alert 03/09, Bip-bop 01/02/05/07/10, Staplebops 01/02/05, Nope 01/03/04/06/07/09/10, Yup 02/06)
  played nothing in the **web** UI — Vite inlined <4 KB AACs as base64 `data:` URLs and the server's
  Content-Security-Policy had no `media-src`.
- [PR #11082](https://github.com/anomalyco/opencode/pull/11082): one-line fix in
  `packages/opencode/src/server/server.ts` (Hono CSP header):

```diff
- "... font-src 'self' data:; connect-src 'self' data:",
+ "... font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
```

## 8. Other notes

- `@chousyn/opencode-alert` (npm) is an unrelated third-party plugin, not the source of these sounds.
- The desktop app is **Electron** (`packages/desktop/package.json`); earlier Tauri-era layout
  (`packages/desktop-electron`) was consolidated. `renderer/index.tsx` implements the desktop
  `platform.notify` bridge using the Web Notification API.
- Sources: raw.githubusercontent.com + api.github.com tree listings on branch `dev`,
  [issue #11081](https://github.com/anomalyco/opencode/issues/11081),
  [PR #11082](https://github.com/anomalyco/opencode/pull/11082),
  [DeepWiki 6.7](https://deepwiki.com/sst/opencode/6.7-desktop-application) (stale re: Tauri).
