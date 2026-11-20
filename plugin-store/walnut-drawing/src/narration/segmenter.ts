/**
 * Cutting a walkthrough's audio into sentences where the person pauses, so each sentence has its
 * own start and end time before speech to text sees it (Walnut's STT answers words, not times).
 * Pure: samples in, sentences out, no browser API. `recorder.ts` feeds it the microphone.
 *
 * Loudness is measured per 30 ms window against a floor that follows the room's quiet: speech is
 * a window well above the floor. A sentence starts at two loud windows in a row (with a little
 * audio before them, so its first sound is kept) and ends after PAUSE_MS of quiet, or at MAX_MS.
 */

export const SAMPLE_RATE = 16_000
const WINDOW = 480 // 30 ms at 16 kHz
const PRE_ROLL_WINDOWS = 10 // 300 ms kept before the first loud window
const START_WINDOWS = 2
export const PAUSE_MS = 700
export const MAX_MS = 20_000
/** Shorter than this much loud audio is a cough or a click, not a sentence. */
const MIN_VOICED_MS = 300
const MIN_LEVEL = 0.01
const FLOOR_RATIO = 3

export interface Sentence {
  /** Milliseconds from the first sample fed. */
  t0: number
  t1: number
  samples: Float32Array
}

/** Average down to 16 kHz mono (a plain box filter: speech to text needs no more). */
export function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return input.slice()
  const ratio = fromRate / SAMPLE_RATE
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio)
    const b = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = a; j < b; j++) sum += input[j]
    out[i] = b > a ? sum / (b - a) : 0
  }
  return out
}

/** 16-bit PCM WAV of 16 kHz mono samples. */
export function encodeWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return bytes
}

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, to - from))
}

const msOf = (samples: number) => Math.round((samples / SAMPLE_RATE) * 1000)

export class Segmenter {
  private pending = new Float32Array(0)
  /** Windows seen so far (each WINDOW samples). */
  private windows = 0
  private floor = MIN_LEVEL
  private recent: Float32Array[] = []
  private loudRun = 0
  private current: { startWindow: number; chunks: Float32Array[]; quiet: number; voiced: number } | null = null

  constructor(private readonly onSentence: (s: Sentence) => void) {}

  /** More 16 kHz samples. */
  push(samples: Float32Array): void {
    const all = new Float32Array(this.pending.length + samples.length)
    all.set(this.pending)
    all.set(samples, this.pending.length)
    let at = 0
    for (; at + WINDOW <= all.length; at += WINDOW) this.window(all.slice(at, at + WINDOW))
    this.pending = all.slice(at)
  }

  /** The recording stopped: a sentence still open ends here. */
  flush(): void {
    if (this.current) this.finish()
  }

  private window(w: Float32Array): void {
    const level = rms(w, 0, w.length)
    const loud = level > Math.max(MIN_LEVEL, this.floor * FLOOR_RATIO)
    // The floor follows the quiet quickly down and slowly up, so speech never becomes the floor.
    if (!loud) this.floor = level < this.floor ? level * 0.5 + this.floor * 0.5 : this.floor * 0.98 + level * 0.02
    this.floor = Math.max(this.floor, MIN_LEVEL / FLOOR_RATIO)
    this.windows++
    if (this.current) {
      this.current.chunks.push(w)
      if (loud) {
        this.current.quiet = 0
        this.current.voiced++
      } else {
        this.current.quiet++
      }
      const length = this.current.chunks.length * WINDOW
      if (this.current.quiet * WINDOW >= (PAUSE_MS / 1000) * SAMPLE_RATE || length >= (MAX_MS / 1000) * SAMPLE_RATE) this.finish()
      return
    }
    this.recent.push(w)
    if (this.recent.length > PRE_ROLL_WINDOWS + START_WINDOWS) this.recent.shift()
    this.loudRun = loud ? this.loudRun + 1 : 0
    if (this.loudRun >= START_WINDOWS) {
      const chunks = this.recent
      this.recent = []
      this.loudRun = 0
      this.current = { startWindow: this.windows - chunks.length, chunks, quiet: 0, voiced: START_WINDOWS }
    }
  }

  private finish(): void {
    const cur = this.current
    this.current = null
    if (!cur) return
    // The trailing quiet is not part of the sentence (keep 150 ms of it).
    const keep = Math.max(1, cur.chunks.length - Math.max(0, cur.quiet - 5))
    const chunks = cur.chunks.slice(0, keep)
    if (msOf(cur.voiced * WINDOW) < MIN_VOICED_MS) return
    const samples = new Float32Array(chunks.length * WINDOW)
    chunks.forEach((c, i) => samples.set(c, i * WINDOW))
    const t0 = msOf(cur.startWindow * WINDOW)
    this.onSentence({ t0, t1: t0 + msOf(samples.length), samples })
  }
}
