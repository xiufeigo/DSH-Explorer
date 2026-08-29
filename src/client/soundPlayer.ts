/**
 * DSH-Explorer notification sound player.
 * Uses Web Audio API to play lightweight notification sounds.
 * Sounds are embedded as base64 data URLs to avoid external file dependencies.
 */

import { type SoundId, getPrefs } from './prefs'

/** Sound metadata for the UI dropdown. */
export interface SoundMeta {
  id: SoundId
  label: string
}

export const SOUND_OPTIONS: SoundMeta[] = [
  { id: 'none', label: '无' },
  { id: 'staplebops-01', label: 'Staplebops 01' },
  { id: 'staplebops-02', label: 'Staplebops 02' },
  { id: 'nope-03', label: 'Nope 03' },
  { id: 'chime-soft', label: 'Chime Soft' },
  { id: 'chime-bright', label: 'Chime Bright' },
  { id: 'alert-low', label: 'Alert Low' },
  { id: 'alert-high', label: 'Alert High' },
]

/**
 * Synthesized notification sounds using Web Audio API.
 * Each sound is a short synthesized tone — no external files needed.
 */
const AudioCtx = typeof AudioContext !== 'undefined' ? AudioContext : typeof (globalThis as any).webkitAudioContext !== 'undefined' ? (globalThis as any).webkitAudioContext : null

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (ctx !== null) return ctx
  if (AudioCtx === null) return null
  try {
    ctx = new AudioCtx()
    return ctx
  } catch {
    return null
  }
}

export function disposeSoundPlayer(): void {
  if (ctx !== null) {
    try { void ctx.close() } catch { /* ignore */ }
    ctx = null
  }
}

/** Resume a suspended AudioContext (required after user gesture). */
function ensureRunning(audioCtx: AudioContext): void {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {})
  }
}

/** Play a simple sine wave beep. */
function playTone(
  frequency: number,
  duration: number,
  volume: number = 0.3,
  rampDown: boolean = false,
): void {
  const audioCtx = getCtx()
  if (audioCtx === null) return
  ensureRunning(audioCtx)

  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()

  osc.connect(gain)
  gain.connect(audioCtx.destination)

  osc.frequency.value = frequency
  osc.type = 'sine'

  const now = audioCtx.currentTime
  gain.gain.setValueAtTime(volume, now)
  if (rampDown) {
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
  }
  osc.start(now)
  osc.stop(now + duration)
}

/** Play a sequence of notes. */
function playSequence(
  notes: Array<{ freq: number; start: number; dur: number; vol?: number }>,
): void {
  const audioCtx = getCtx()
  if (audioCtx === null) return
  ensureRunning(audioCtx)

  for (const note of notes) {
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.frequency.value = note.freq
    osc.type = 'sine'

    const now = audioCtx.currentTime + note.start
    const vol = note.vol ?? 0.25
    gain.gain.setValueAtTime(vol, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + note.dur)
    osc.start(now)
    osc.stop(now + note.dur)
  }
}

/** Play a noise burst (for error sounds). */
function playNoise(duration: number, volume: number = 0.15): void {
  const audioCtx = getCtx()
  if (audioCtx === null) return
  ensureRunning(audioCtx)

  const bufferSize = Math.floor(audioCtx.sampleRate * duration)
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-3 * i / bufferSize)
  }

  const source = audioCtx.createBufferSource()
  const gain = audioCtx.createGain()
  source.buffer = buffer
  source.connect(gain)
  gain.connect(audioCtx.destination)
  gain.gain.setValueAtTime(volume, audioCtx.currentTime)
  source.start()
}

// ── Sound definitions ─────────────────────────────────────────────────────

const SOUNDS: Record<SoundId, () => void> = {
  'none': () => {},

  // Staplebops 01: cheerful ascending chime (agent complete)
  'staplebops-01': () => playSequence([
    { freq: 523, start: 0, dur: 0.15, vol: 0.2 },
    { freq: 659, start: 0.08, dur: 0.15, vol: 0.2 },
    { freq: 784, start: 0.16, dur: 0.2, vol: 0.25 },
  ]),

  // Staplebops 02: two-tone attention (permission needed)
  'staplebops-02': () => playSequence([
    { freq: 440, start: 0, dur: 0.12, vol: 0.2 },
    { freq: 587, start: 0.15, dur: 0.2, vol: 0.25 },
  ]),

  // Nope 03: descending buzz (error)
  'nope-03': () => playSequence([
    { freq: 350, start: 0, dur: 0.12, vol: 0.2 },
    { freq: 280, start: 0.1, dur: 0.2, vol: 0.25 },
  ]),

  // Chime Soft: gentle single chime
  'chime-soft': () => playTone(880, 0.3, 0.15, true),

  // Chime Bright: bright two-note chime
  'chime-bright': () => playSequence([
    { freq: 880, start: 0, dur: 0.15, vol: 0.2 },
    { freq: 1175, start: 0.1, dur: 0.25, vol: 0.2 },
  ]),

  // Alert Low: low attention-grab
  'alert-low': () => playSequence([
    { freq: 330, start: 0, dur: 0.1, vol: 0.2 },
    { freq: 440, start: 0.12, dur: 0.15, vol: 0.2 },
    { freq: 330, start: 0.3, dur: 0.1, vol: 0.2 },
  ]),

  // Alert High: high urgent chime
  'alert-high': () => playSequence([
    { freq: 880, start: 0, dur: 0.08, vol: 0.25 },
    { freq: 1100, start: 0.1, dur: 0.08, vol: 0.25 },
    { freq: 880, start: 0.2, dur: 0.08, vol: 0.25 },
    { freq: 1100, start: 0.3, dur: 0.15, vol: 0.3 },
  ]),
}

/** 音效冷却：短窗口内的批量事件只响一次，避免叠爆音。 */
const SOUND_COOLDOWN_MS = 200
let lastSoundAt = 0

/**
 * Play a notification sound by id.
 * Uses the sound assignment from user preferences.
 * Throttled: plays at most once per SOUND_COOLDOWN_MS.
 */
export function playNotificationSound(soundId: SoundId): void {
  if (soundId === 'none') return
  const player = SOUNDS[soundId]
  if (player === undefined) return
  const now = Date.now()
  if (now - lastSoundAt < SOUND_COOLDOWN_MS) return
  lastSoundAt = now
  player()
}

/**
 * Play the sound for a specific event type,
 * looking up the user's preference.
 */
export function playEventSound(event: 'agent' | 'permission' | 'error'): void {
  const prefs = getPrefs()
  let soundId: SoundId
  switch (event) {
    case 'agent':
      if (!prefs.notifyAgent) return
      soundId = prefs.soundAgent
      break
    case 'permission':
      if (!prefs.notifyPermission) return
      soundId = prefs.soundPermission
      break
    case 'error':
      if (!prefs.notifyError) return
      soundId = prefs.soundError
      break
    default:
      return
  }
  playNotificationSound(soundId)
}
