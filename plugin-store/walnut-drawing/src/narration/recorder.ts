/**
 * Recording a walkthrough: the microphone, cut into sentences (segmenter.ts), each sentence sent to
 * Walnut's speech to text one at a time, and the canvas steps, all in one Take (take.ts) saved
 * beside the drawing (POST /api/drawings/narration). Saved again every AUTOSAVE_MS while it grows,
 * so a closed window keeps what was said, and once more when it stops.
 *
 * The microphone feeds a silent graph (gain 0): nothing is ever played. Everything outside the
 * page (the mic, speech to text, the save) comes in as `deps`, so tests drive it with fakes.
 */

import type { DrawingActivity } from '@open-walnut/plugin-api/web'
import { downsample, encodeWav, SAMPLE_RATE, Segmenter, type Sentence } from './segmenter'
import { Take, type TakeData } from './take'

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'saving' | 'saved' | 'error'

export interface RecorderState {
  phase: RecorderPhase
  /** Date.now() when recording started (for the timer). */
  startedAt?: number
  /** The newest sentence heard. */
  caption: string
  /** Sentences cut but not transcribed yet. */
  pending: number
  error?: string
  /** A failed save can be tried again. */
  canRetry?: boolean
}

export interface RecorderDeps {
  transcribe(wav: Blob, signal: AbortSignal): Promise<{ text: string; recordingId?: string }>
  save(path: string, take: TakeData): Promise<void>
  /** The audio input: samples arrive through `onSamples` at `sampleRate`; the answer stops it. */
  openMic(onSamples: (samples: Float32Array, sampleRate: number) => void): Promise<() => void>
  now(): number
  warn(message: string, data?: Record<string, unknown>): void
}

const AUTOSAVE_MS = 20_000
/** At stop, how long to wait for sentences still being transcribed before saving without them. */
const DRAIN_MS = 90_000
const SAVED_SHOWN_MS = 4_000
/** Sentences waiting for speech to text past this are kept with their times only (no words). */
const MAX_PENDING = 20
/** How far back the audio clock keeps its marks (a sentence is at most 20 s long). */
const ANCHOR_KEEP_MS = 60_000
/** A walkthrough longer than this stops by itself. */
export const MAX_TAKE_MS = 2 * 60 * 60 * 1000

/** 00:39, 12:05, 1:02:03: always two digits of minutes, as the design shows. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`
}

function micError(err: unknown): string {
  const name = (err as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone blocked: allow it for Walnut, then press Record again'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found'
  return `Could not start the microphone: ${(err as Error)?.message ?? String(err)}`
}

export class NarrationRecorder {
  private state: RecorderState = { phase: 'idle', caption: '', pending: 0 }
  private listeners = new Set<(s: RecorderState) => void>()
  private take: Take | null = null
  private path: string | null = null
  private closeMic: (() => void) | null = null
  private segmenter: Segmenter | null = null
  private queue: Promise<void> = Promise.resolve()
  private abort = new AbortController()
  private timers: ReturnType<typeof setTimeout>[] = []
  private autosave: ReturnType<typeof setInterval> | null = null
  private savedVersion = -1
  private failedTake: { path: string; data: TakeData } | null = null
  /** One save at a time, in order: an autosave in flight never lands after the final save. */
  private saving: Promise<unknown> = Promise.resolve()
  /**
   * The audio clock against the take's: for each piece of samples, how many came before it and
   * when it arrived. A sentence's time is read from the piece it falls in, so audio the browser
   * dropped (a busy page, a laptop asleep) never shifts later sentences against the canvas steps.
   */
  private anchors: Array<{ sample: number; at: number }> = []
  private samplesIn = 0

  constructor(private readonly deps: RecorderDeps) {}

  get current(): RecorderState { return this.state }

  subscribe(fn: (s: RecorderState) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private set(next: Partial<RecorderState>): void {
    this.state = { ...this.state, ...next }
    for (const fn of this.listeners) fn(this.state)
  }

  get recording(): boolean { return this.state.phase === 'recording' || this.state.phase === 'starting' }

  /** Start a take of the drawing at `path`. */
  async start(path: string): Promise<void> {
    if (this.recording || this.state.phase === 'saving') return
    this.clearTimers()
    this.abort = new AbortController()
    this.failedTake = null
    this.path = path
    const take = new Take(this.deps.now())
    this.take = take
    this.anchors = []
    this.samplesIn = 0
    this.savedVersion = -1
    this.set({ phase: 'starting', startedAt: take.startedAt, caption: '', pending: 0, error: undefined, canRetry: false })
    const segmenter = new Segmenter((s) => this.onSentence(take, s))
    this.segmenter = segmenter
    try {
      const close = await this.deps.openMic((samples, rate) => {
        if (this.take !== take || take.ended) return
        const pcm = downsample(samples, rate)
        // This piece ends now: its first sample was heard its own length ago.
        const at = this.deps.now() - take.startedAt - (pcm.length / SAMPLE_RATE) * 1000
        this.anchors.push({ sample: this.samplesIn, at: Math.max(0, at) })
        const keepFrom = this.anchors.findIndex((a) => a.at >= at - ANCHOR_KEEP_MS)
        if (keepFrom > 0) this.anchors.splice(0, keepFrom)
        this.samplesIn += pcm.length
        segmenter.push(pcm)
      })
      // Stopped (or started again) while the microphone was opening.
      if (this.take !== take || take.ended) { close(); return }
      this.closeMic = close
    } catch (err) {
      // Only this start's failure: a stop or a newer start since then is left as it is.
      if (this.take !== take) return
      this.take = null
      this.set({ phase: 'error', error: micError(err), canRetry: false })
      return
    }
    this.set({ phase: 'recording' })
    this.autosave = setInterval(() => { void this.saveNow(false) }, AUTOSAVE_MS)
    this.timers.push(setTimeout(() => { void this.stop() }, MAX_TAKE_MS))
  }

  /** The drawing being recorded was renamed or moved: the take is kept at its new path (while saving too). */
  retarget(path: string): void {
    if (this.take) this.path = path
    if (this.failedTake) this.failedTake = { ...this.failedTake, path }
  }

  /** The take's time of a sample the segmenter counted (16 kHz since the first piece). */
  private timeOf(sampleMs: number): number {
    const sample = (sampleMs / 1000) * SAMPLE_RATE
    let anchor = this.anchors[0]
    for (const a of this.anchors) {
      if (a.sample > sample) break
      anchor = a
    }
    if (!anchor) return sampleMs
    return anchor.at + ((sample - anchor.sample) / SAMPLE_RATE) * 1000
  }

  /** A step on the canvas: kept while recording. */
  activity(a: DrawingActivity): void {
    if (this.state.phase === 'recording' && this.take && !this.take.ended) this.take.activity(a)
  }

  private onSentence(take: Take, s: Sentence): void {
    const t0 = this.timeOf(s.t0)
    const i = take.sentence(t0, t0 + (s.t1 - s.t0))
    if (i < 0) return
    if (this.state.pending >= MAX_PENDING) {
      // Speech to text is far behind: keep when it was said, not the audio.
      take.heard(i, { failed: true })
      return
    }
    const wav = new Blob([encodeWav(s.samples) as BlobPart], { type: 'audio/wav' })
    this.set({ pending: this.state.pending + 1 })
    const signal = this.abort.signal
    this.queue = this.queue.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) break
        try {
          const heard = await this.deps.transcribe(wav, signal)
          take.heard(i, heard)
          if (this.take === take && heard.text.trim()) this.set({ caption: heard.text.trim() })
          return
        } catch (err) {
          if (signal.aborted) break
          this.deps.warn('a walkthrough sentence was not transcribed', { error: String(err), attempt })
        }
      }
      take.heard(i, { failed: true })
    }).finally(() => { this.set({ pending: Math.max(0, this.state.pending - 1) }) })
  }

  /** Save the take as it is now, after any save still on its way; `final` reports a failure. */
  private saveNow(final: boolean): Promise<boolean> {
    const run = this.saving.then(() => this.saveOnce(final))
    this.saving = run.catch(() => {})
    return run
  }

  private async saveOnce(final: boolean): Promise<boolean> {
    const take = this.take
    const path = this.path
    if (!take || !path) return true
    if (take.empty || take.version === this.savedVersion) return true
    const version = take.version
    const data = take.data(this.deps.now())
    try {
      await this.deps.save(path, data)
      this.savedVersion = Math.max(this.savedVersion, version)
      return true
    } catch (err) {
      this.deps.warn('a walkthrough was not saved', { error: String(err), final })
      if (final) this.failedTake = { path, data }
      if (final) this.set({ phase: 'error', error: `Walkthrough not saved: ${(err as Error)?.message ?? String(err)}`, canRetry: true })
      return false
    }
  }

  /** Stop recording, let the last sentences finish, and save. */
  async stop(): Promise<void> {
    const take = this.take
    if (!take || take.ended || (this.state.phase !== 'recording' && this.state.phase !== 'starting')) return
    this.set({ phase: 'saving' })
    this.stopAudio()
    this.segmenter?.flush()
    this.segmenter = null
    take.end(this.deps.now())
    let drained = false
    await Promise.race([
      this.queue.then(() => { drained = true }),
      new Promise<void>((resolve) => this.timers.push(setTimeout(resolve, DRAIN_MS))),
    ])
    if (!drained) this.abort.abort()
    if (take.empty) {
      this.take = null
      this.set({ phase: 'idle', pending: 0 })
      return
    }
    if (await this.saveNow(true)) {
      this.take = null
      this.set({ phase: 'saved', pending: 0 })
      this.timers.push(setTimeout(() => { if (this.state.phase === 'saved') this.set({ phase: 'idle' }) }, SAVED_SHOWN_MS))
    }
  }

  /** Try a failed final save again. */
  async retrySave(): Promise<void> {
    const failed = this.failedTake
    if (!failed || this.state.phase !== 'error') return
    this.set({ phase: 'saving', error: undefined, canRetry: false })
    try {
      await this.deps.save(failed.path, failed.data)
      this.failedTake = null
      this.take = null
      this.set({ phase: 'saved' })
      this.timers.push(setTimeout(() => { if (this.state.phase === 'saved') this.set({ phase: 'idle' }) }, SAVED_SHOWN_MS))
    } catch (err) {
      this.set({ phase: 'error', error: `Walkthrough not saved: ${(err as Error)?.message ?? String(err)}`, canRetry: true })
    }
  }

  /** Close an error notice (a take that could not be saved is let go). */
  dismiss(): void {
    if (this.state.phase !== 'error' && this.state.phase !== 'saved') return
    this.failedTake = null
    this.take = null
    this.set({ phase: 'idle', error: undefined, canRetry: false })
  }

  private stopAudio(): void {
    if (this.autosave) clearInterval(this.autosave)
    this.autosave = null
    const close = this.closeMic
    this.closeMic = null
    try { close?.() } catch { /* already closed */ }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  /** The view went away: a take in progress still stops and saves. */
  dispose(): void {
    this.listeners.clear()
    if (this.recording) void this.stop()
    else this.stopAudio()
  }
}

/** The real microphone through a silent Web Audio graph. */
export async function openBrowserMic(onSamples: (samples: Float32Array, sampleRate: number) => void): Promise<() => void> {
  // As Walnut's own dictation asks (web/src/utils/mic-constraints.ts): no echo cancellation, which in
  // WebKit routes the mic through a voice unit that fails with Bluetooth headphones; nothing plays back.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: false } })
  const Ctx = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) {
    for (const t of stream.getTracks()) t.stop()
    throw new Error('this browser has no Web Audio')
  }
  const ctx = new Ctx()
  const source = ctx.createMediaStreamSource(stream)
  // A ScriptProcessor runs everywhere (WebKit too); it must reach the destination to run, so it
  // goes through a gain of 0: silence, never the microphone played back.
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0
  proc.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0).slice(), ctx.sampleRate)
  source.connect(proc)
  proc.connect(mute)
  mute.connect(ctx.destination)
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
  return () => {
    proc.onaudioprocess = null
    try { source.disconnect(); proc.disconnect(); mute.disconnect() } catch { /* gone */ }
    for (const t of stream.getTracks()) t.stop()
    void ctx.close().catch(() => {})
  }
}
