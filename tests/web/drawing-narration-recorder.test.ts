/**
 * The Drawing plugin's walkthrough recorder (plugin-store/walnut-drawing/src/narration/): audio cut
 * into sentences where the person pauses, a take that keeps sentences and canvas steps on one
 * clock, and the recorder that transcribes each sentence, saves while it grows and once at the
 * end. The microphone, speech to text and the save are fakes; no audio is ever played.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downsample, encodeWav, MAX_MS, SAMPLE_RATE, Segmenter, type Sentence } from '../../plugin-store/walnut-drawing/src/narration/segmenter'
import { Take, type TakeData } from '../../plugin-store/walnut-drawing/src/narration/take'
import { elapsed, NarrationRecorder, type RecorderDeps } from '../../plugin-store/walnut-drawing/src/narration/recorder'

/** `ms` of a 220 Hz tone (speech-loud) or of near silence. */
function sound(ms: number, loud: boolean): Float32Array {
  const n = Math.round((ms / 1000) * SAMPLE_RATE)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = loud ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) : 0.0005 * Math.sin(i)
  return out
}

function cut(...parts: Array<[number, boolean]>): Sentence[] {
  const found: Sentence[] = []
  const seg = new Segmenter((s) => found.push(s))
  for (const [ms, loud] of parts) {
    const samples = sound(ms, loud)
    // In pieces of a ScriptProcessor buffer, as the microphone delivers them.
    for (let i = 0; i < samples.length; i += 1365) seg.push(samples.slice(i, i + 1365))
  }
  seg.flush()
  return found
}

describe('Segmenter', () => {
  it('cuts sentences at pauses, with their times', () => {
    const found = cut([1_000, false], [1_500, true], [1_000, false], [2_000, true], [900, false])
    expect(found).toHaveLength(2)
    // Each starts a little before its first sound (pre-roll) and ends soon after its last.
    expect(found[0].t0).toBeGreaterThanOrEqual(600)
    expect(found[0].t0).toBeLessThanOrEqual(1_000)
    expect(found[0].t1).toBeGreaterThanOrEqual(2_500)
    expect(found[0].t1).toBeLessThan(3_000)
    expect(found[1].t0).toBeGreaterThan(3_000)
    expect(found[1].t1).toBeGreaterThanOrEqual(5_500)
    expect(found[0].samples.length).toBe(Math.round(((found[0].t1 - found[0].t0) / 1000) * SAMPLE_RATE))
  })

  it('keeps a short pause inside one sentence, drops a click, and cuts a monologue at MAX_MS', () => {
    expect(cut([500, false], [1_000, true], [400, false], [1_000, true], [1_000, false])).toHaveLength(1)
    expect(cut([500, false], [90, true], [1_500, false])).toHaveLength(0)
    const long = cut([500, false], [MAX_MS + 5_000, true], [1_000, false])
    expect(long).toHaveLength(2)
    expect(long[0].t1 - long[0].t0).toBeLessThanOrEqual(MAX_MS + 100)
  })

  it('ends a sentence still open when the recording stops', () => {
    expect(cut([500, false], [1_200, true])).toHaveLength(1)
  })

  it('downsamples to 16 kHz and writes a WAV header speech to text accepts', () => {
    expect(downsample(new Float32Array(48_000), 48_000)).toHaveLength(16_000)
    const wav = encodeWav(new Float32Array([0, 1, -1]))
    const view = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(46, true)).toBe(32767)
    expect(view.getInt16(48, true)).toBe(-32768)
  })
})

describe('the timer on the pill', () => {
  it('always shows two digits of minutes, as the design does, and hours only past one', () => {
    expect([0, 39_000, 725_000, 3_723_000].map(elapsed)).toEqual(['00:00', '00:39', '12:05', '1:02:03'])
  })
})

describe('Take', () => {
  it('keeps steps on the take clock, closes a pointer rest, and folds a drag into one edit', () => {
    const take = new Take(10_000, 'take-x')
    take.activity({ kind: 'point', ids: ['a'], labels: ['A'], at: 10_500 })
    take.activity({ kind: 'edit', ids: ['a'], labels: ['A'], at: 11_000 })
    take.activity({ kind: 'edit', ids: ['a'], labels: ['A2'], at: 11_400 })
    take.activity({ kind: 'point', ids: [], labels: [], at: 12_000 })
    const i = take.sentence(500, 1_500)
    take.heard(i, { text: ' hello ', recordingId: 'r1' })
    take.end(13_000)
    take.activity({ kind: 'add', ids: ['late'], labels: [''], at: 13_500 })
    const data = take.data(99_999)
    expect(data).toEqual({
      id: 'take-x', startedAt: new Date(10_000).toISOString(), durationMs: 3_000,
      speech: [{ t0: 500, t1: 1_500, text: 'hello', recordingId: 'r1' }],
      events: [
        { t: 500, kind: 'point', ids: ['a'], labels: ['A'], untilT: 2_000 },
        { t: 1_000, kind: 'edit', ids: ['a'], labels: ['A2'] },
      ],
    } satisfies TakeData)
  })
})

describe('NarrationRecorder', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup(overrides: Partial<RecorderDeps> = {}) {
    let now = 1_000_000
    let feed: ((s: Float32Array, rate: number) => void) | null = null
    const closed = vi.fn()
    const heard: string[] = []
    const saves: Array<{ path: string; take: TakeData }> = []
    const deps: RecorderDeps = {
      transcribe: vi.fn(async () => ({ text: heard.shift() ?? '', recordingId: 'rec' })),
      save: vi.fn(async (path: string, take: TakeData) => { saves.push({ path, take }) }),
      openMic: vi.fn(async (onSamples) => { feed = onSamples; return closed }),
      now: () => now,
      warn: vi.fn(),
      ...overrides,
    }
    const recorder = new NarrationRecorder(deps)
    const speak = (ms: number, loud: boolean) => {
      const s = sound(ms, loud)
      for (let i = 0; i < s.length; i += 1600) { now += 100; feed?.(s.slice(i, i + 1600), SAMPLE_RATE) }
    }
    return { recorder, deps, closed, heard, saves, speak, advance: (ms: number) => { now += ms } }
  }

  it('transcribes each sentence in order, keeps the canvas steps, and saves the take at stop', async () => {
    const { recorder, heard, saves, speak, closed } = setup()
    heard.push('this table is the core table', 'this is only a cache')
    await recorder.start('inbox/Shop.excalidraw')
    expect(recorder.current.phase).toBe('recording')
    speak(500, false)
    recorder.activity({ kind: 'point', ids: ['orders'], labels: ['orders'], at: 1_000_400 })
    speak(1_500, true)
    speak(1_000, false)
    speak(1_500, true)
    speak(1_000, false)
    await vi.advanceTimersByTimeAsync(0)
    expect(recorder.current.caption).toBe('this is only a cache')
    await recorder.stop()
    expect(closed).toHaveBeenCalledOnce()
    expect(recorder.current.phase).toBe('saved')
    expect(saves).toHaveLength(1)
    const { path, take } = saves[0]
    expect(path).toBe('inbox/Shop.excalidraw')
    expect(take.speech.map((s) => s.text)).toEqual(['this table is the core table', 'this is only a cache'])
    expect(take.speech[0].t0).toBeLessThan(take.speech[1].t0)
    expect(take.events).toEqual([expect.objectContaining({ kind: 'point', ids: ['orders'], t: 400 })])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(recorder.current.phase).toBe('idle')
  })

  it('saves while it grows, and a sentence speech to text could not read keeps its time', async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error('engine down'))
    const { recorder, saves, speak, deps } = setup({ transcribe })
    await recorder.start('inbox/A.excalidraw')
    speak(500, false)
    speak(1_200, true)
    speak(1_000, false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(saves.length).toBeGreaterThanOrEqual(1)
    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(deps.warn).toHaveBeenCalled()
    await recorder.stop()
    expect(saves.at(-1)!.take.speech).toEqual([expect.objectContaining({ failed: true, text: '' })])
  })

  it('says when the microphone is blocked, and saves nothing for an empty take', async () => {
    const blocked = setup({ openMic: vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' })) })
    await blocked.recorder.start('inbox/A.excalidraw')
    expect(blocked.recorder.current).toMatchObject({ phase: 'error', error: expect.stringMatching(/Microphone blocked/) })
    const quiet = setup()
    await quiet.recorder.start('inbox/A.excalidraw')
    quiet.speak(2_000, false)
    await quiet.recorder.stop()
    expect(quiet.saves).toEqual([])
    expect(quiet.recorder.current.phase).toBe('idle')
  })

  it('offers a retry when the last save fails, and keeps recording into a renamed drawing', async () => {
    let fail = true
    const { recorder, saves, deps } = setup({ save: vi.fn(async (path: string, take: TakeData) => { if (fail) throw new Error('offline'); saves.push({ path, take }) }) })
    await recorder.start('inbox/Old.excalidraw')
    recorder.activity({ kind: 'add', ids: ['a'], labels: ['A'], at: 1_000_100 })
    recorder.retarget('inbox/New.excalidraw')
    await recorder.stop()
    expect(recorder.current).toMatchObject({ phase: 'error', canRetry: true, error: 'Walkthrough not saved: offline' })
    fail = false
    await recorder.retrySave()
    expect(recorder.current.phase).toBe('saved')
    expect(saves.map((s) => s.path)).toEqual(['inbox/New.excalidraw'])
    expect(deps.save).toHaveBeenCalledTimes(2)
  })

  it('saves one at a time: an autosave still on its way never lands after the final save', async () => {
    const landed: number[] = []
    let release!: () => void
    let first = true
    const save = vi.fn(async (_path: string, take: TakeData) => {
      if (first) { first = false; await new Promise<void>((r) => { release = r }) }
      landed.push(take.events.length)
    })
    const { recorder } = setup({ save })
    await recorder.start('inbox/A.excalidraw')
    recorder.activity({ kind: 'add', ids: ['a'], labels: ['A'], at: 1_000_100 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(save).toHaveBeenCalledTimes(1)
    recorder.activity({ kind: 'add', ids: ['b'], labels: ['B'], at: 1_000_200 })
    const stopped = recorder.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
    release()
    await stopped
    expect(landed).toEqual([1, 2])
  })

  it('a rename while the last save fails moves the retry, and Dismiss lets the take go', async () => {
    const saves: string[] = []
    let fail = true
    const { recorder } = setup({ save: vi.fn(async (path: string) => { if (fail) throw new Error('offline'); saves.push(path) }) })
    await recorder.start('inbox/Old.excalidraw')
    recorder.activity({ kind: 'add', ids: ['a'], labels: ['A'], at: 1_000_100 })
    await recorder.stop()
    expect(recorder.current.phase).toBe('error')
    recorder.retarget('inbox/Renamed.excalidraw')
    fail = false
    await recorder.retrySave()
    expect(saves).toEqual(['inbox/Renamed.excalidraw'])
    fail = true
    await recorder.start('inbox/B.excalidraw')
    recorder.activity({ kind: 'add', ids: ['b'], labels: ['B'], at: 1_000_300 })
    await recorder.stop()
    recorder.dismiss()
    expect(recorder.current).toMatchObject({ phase: 'idle', canRetry: false })
  })

  it('a microphone that fails after the take was stopped leaves the state alone', async () => {
    let fail!: (e: Error) => void
    const { recorder } = setup({ openMic: vi.fn(() => new Promise<() => void>((_r, reject) => { fail = reject })) })
    const started = recorder.start('inbox/A.excalidraw')
    await recorder.stop()
    fail(Object.assign(new Error('gone'), { name: 'NotFoundError' }))
    await started
    expect(recorder.current.phase).toBe('idle')
  })

  it('a stop while the microphone is still opening leaves it closed', async () => {
    let open!: (close: () => void) => void
    const close = vi.fn()
    const { recorder } = setup({ openMic: vi.fn(() => new Promise<() => void>((resolve) => { open = resolve })) })
    const started = recorder.start('inbox/A.excalidraw')
    await recorder.stop()
    open(close)
    await started
    expect(close).toHaveBeenCalledOnce()
    expect(recorder.current.phase).toBe('idle')
  })
})
