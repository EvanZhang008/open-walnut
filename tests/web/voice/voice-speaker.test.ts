/**
 * Voice mode's speaker queue (web/src/voice/voice-speaker.ts): pieces said in order,
 * the next one's audio fetched while one plays (pieces added mid-play included), one
 * promise for the whole queue, stop and say, and the waiting cue; a streamed piece
 * (a PcmFeed) scheduled run by run as it arrives. Web Audio and the speech route
 * are fakes; nothing makes a sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Fetch {
  text: string; previousText?: string; nextText?: string; signal?: AbortSignal
  resolve: () => void; reject: (err: Error) => void; resolveWith: (audio: unknown) => void
}
const fetches: Fetch[] = []

vi.mock('../../../web/src/api/voice', () => ({
  speakPiece: (piece: { text: string; previousText?: string; nextText?: string }, signal?: AbortSignal) => new Promise<unknown>((resolve, reject) => {
    fetches.push({ ...piece, signal, resolve: () => resolve(new ArrayBuffer(8)), reject, resolveWith: resolve })
  }),
  SpeakError: class extends Error {
    constructor(message: string, readonly status: number, readonly fallback: boolean, readonly code = '') { super(message) }
  },
  spokenReply: async () => null,
}))

import { VoiceSpeaker } from '../../../web/src/voice/voice-speaker'
import { SpeakError } from '../../../web/src/api/voice'
import { PcmFeed } from '../../../web/src/voice/pcm-feed'

interface FakeSource { onended: (() => void) | null; started: boolean; at?: number; stopped?: boolean; buffer: { duration: number; data: Float32Array[] } | null }

class FakeContext {
  state: AudioContextState = 'running'
  currentTime = 0
  destination = {}
  sources: FakeSource[] = []
  oscillators = 0
  // A steady level, so outputLevel() reads non-zero whenever it measures.
  createAnalyser() { return { fftSize: 2048, connect() {}, getFloatTimeDomainData(buf: Float32Array) { buf.fill(0.5) } } }
  decodeAudioData() { return Promise.resolve({ duration: 30 }) }
  createBuffer(channels: number, length: number, rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return { duration: length / rate, data, getChannelData: (c: number) => data[c]! }
  }
  createBufferSource() {
    const s: FakeSource & Record<string, unknown> = { onended: null, started: false, buffer: null, connect() {}, start(at?: number) { s.started = true; s.at = at }, stop() { s.stopped = true } }
    this.sources.push(s)
    return s
  }
  createOscillator() {
    this.oscillators++
    return { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {}, onended: null }
  }
  createGain() {
    const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} }
    return { gain: param, connect() {}, disconnect() {} }
  }
  resume() { return Promise.resolve() }
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) }
const reply = (...chunks: string[]) => ({ text: chunks.join(' '), language: 'en-US', truncated: false, chunks })

let ctx: FakeContext
let speaker: VoiceSpeaker

beforeEach(() => {
  fetches.length = 0
  ctx = new FakeContext()
  speaker = new VoiceSpeaker(ctx as unknown as AudioContext, 'elevenlabs')
})

afterEach(() => { speaker.stop(); vi.useRealTimers() })

/** The playing piece ends. */
const endPlaying = () => { const s = ctx.sources.at(-1)!; s.onended?.() }

describe('voice speaker queue', () => {
  it('says the pieces in order and resolves done once, for pieces added while it plays too', async () => {
    const outcome = vi.fn()
    const first = speaker.enqueue(reply('One.', 'Two.'))
    void first.then(outcome)
    expect(fetches.map((f) => f.text)).toEqual(['One.'])
    fetches[0]!.resolve()
    await settle()
    // One plays, Two's audio is on its way; Three joins the same queue.
    expect(fetches.map((f) => f.text)).toEqual(['One.', 'Two.'])
    expect(speaker.enqueue(reply('Three.'))).toBe(first)
    endPlaying()
    fetches[1]!.resolve()
    await settle()
    expect(fetches.map((f) => f.text)).toEqual(['One.', 'Two.', 'Three.'])
    endPlaying()
    fetches[2]!.resolve()
    await settle()
    endPlaying()
    await settle()
    expect(outcome).toHaveBeenCalledTimes(1)
    expect(outcome).toHaveBeenCalledWith('done')
    expect(speaker.idle).toBe(true)
    // Each piece names the one before it, across replies, for the voice's continuity.
    expect(fetches.map((f) => f.previousText)).toEqual([undefined, 'One.', 'Two.'])
  })

  it('a piece added while the last one plays is fetched at once, not after it ends', async () => {
    void speaker.enqueue(reply('Only.'))
    fetches[0]!.resolve()
    await settle()
    expect(ctx.sources.at(-1)!.started).toBe(true)
    void speaker.enqueue(reply('Streamed next.'))
    expect(fetches.map((f) => f.text)).toEqual(['Only.', 'Streamed next.'])
  })

  it('stop resolves stopped and drops the queue; the next enqueue starts a new one', async () => {
    const first = speaker.enqueue(reply('A.', 'B.'))
    fetches[0]!.resolve()
    await settle()
    speaker.stop()
    expect(await first).toBe('stopped')
    expect(speaker.idle).toBe(true)
    const second = speaker.enqueue(reply('C.'))
    expect(second).not.toBe(first)
    expect(fetches.at(-1)!.text).toBe('C.')
    expect(fetches.at(-1)!.previousText).toBeUndefined()
  })

  it('say replaces whatever is queued', async () => {
    const first = speaker.enqueue(reply('Old one.', 'Old two.'))
    const said = speaker.say(reply('New.'))
    expect(await first).toBe('stopped')
    expect(fetches.at(-1)!.text).toBe('New.')
    fetches.at(-1)!.resolve()
    await settle()
    endPlaying()
    expect(await said).toBe('done')
  })

  it('the waiting cue chimes only while idle, stops at speech, and goes quiet after a minute', async () => {
    vi.useFakeTimers()
    speaker.waitingCue(true)
    vi.advanceTimersByTime(800)
    expect(ctx.oscillators).toBe(2)
    expect(speaker.outputLevel()).not.toBeNull()
    // Speech turns it off at once.
    void speaker.enqueue(reply('Words.'))
    vi.advanceTimersByTime(5_000)
    expect(ctx.oscillators).toBe(2)
    speaker.stop()
    // A long wait: no chime after about a minute.
    speaker.waitingCue(true)
    vi.advanceTimersByTime(70_000)
    const atCap = ctx.oscillators
    vi.advanceTimersByTime(20_000)
    expect(ctx.oscillators).toBe(atCap)
    // Asking again in the same wait does not restart it; a new wait does.
    speaker.waitingCue(true)
    vi.advanceTimersByTime(5_000)
    expect(ctx.oscillators).toBe(atCap)
    speaker.waitingCue(false)
    speaker.waitingCue(true)
    vi.advanceTimersByTime(800)
    expect(ctx.oscillators).toBe(atCap + 2)
  })

  it('the cue makes no notes while the audio context is suspended', () => {
    vi.useFakeTimers()
    ctx.state = 'suspended'
    speaker.waitingCue(true)
    vi.advanceTimersByTime(10_000)
    expect(ctx.oscillators).toBe(0)
  })
})

describe('a language with a voice of its own (the local Chinese voice)', () => {
  const zh = (...chunks: string[]) => ({ text: chunks.join(''), language: 'zh-CN', truncated: false, chunks })

  it('with the device voice, a Chinese piece is still fetched from the server and an English one is not', async () => {
    speaker.stop()
    speaker = new VoiceSpeaker(ctx as unknown as AudioContext, 'device', undefined, { zh: 'qwen' })
    const done = speaker.enqueue(zh('\u4f60\u597d\u3002'))
    expect(fetches.map((f) => f.text)).toEqual(['\u4f60\u597d\u3002'])
    fetches[0]!.resolve()
    await settle()
    endPlaying()
    expect(await done).toBe('done')
    await speaker.enqueue(reply('Hello.'))
    expect(fetches).toHaveLength(1)
    expect(speaker.currentEngine).toBe('device')
  })

  it('without one, a device conversation fetches nothing', async () => {
    speaker.stop()
    speaker = new VoiceSpeaker(ctx as unknown as AudioContext, 'device')
    await speaker.enqueue(zh('\u4f60\u597d\u3002'))
    expect(fetches).toHaveLength(0)
  })

  /** A device conversation with the local Chinese voice, its device voice heard through `spoken`. */
  function zhSpeaker(): string[] {
    const spoken: string[] = []
    vi.stubGlobal('speechSynthesis', { getVoices: () => [], cancel() {}, speak(u: { text: string; onend?: () => void }) { spoken.push(u.text); setTimeout(() => u.onend?.(), 0) } })
    vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; voice = null; onend: (() => void) | null = null; onerror = null; constructor(readonly text: string) {} })
    speaker.stop()
    speaker = new VoiceSpeaker(ctx as unknown as AudioContext, 'device', undefined, { zh: 'qwen' })
    return spoken
  }
  const unavailable = () => new SpeakError('The local voice is still loading', 503, true, 'tts_unavailable')

  it('a tts_unavailable from its own voice says that piece on the device and asks the voice again for the next', async () => {
    const spoken = zhSpeaker()
    try {
      const done = speaker.enqueue(zh('\u4e00\u3002', '\u4e8c\u3002'))
      fetches[0]!.reject(unavailable())
      await settle()
      expect(spoken).toEqual(['\u4e00\u3002'])
      // The next piece still goes to the server, and it plays.
      expect(fetches.map((f) => f.text)).toEqual(['\u4e00\u3002', '\u4e8c\u3002'])
      fetches[1]!.resolve()
      await settle()
      endPlaying()
      expect(await done).toBe('done')
      expect(spoken).toEqual(['\u4e00\u3002'])
    } finally { vi.unstubAllGlobals() }
  })

  it('three misses in a row, or another failure, and the language is said on the device from then on', async () => {
    const spoken = zhSpeaker()
    try {
      const pieces = ['\u4e00\u3002', '\u4e8c\u3002', '\u4e09\u3002', '\u56db\u3002']
      const done = speaker.enqueue(zh(...pieces))
      for (let i = 0; i < 3; i++) {
        await settle()
        fetches[i]!.reject(unavailable())
        await settle()
      }
      expect(await done).toBe('done')
      // The fourth piece was never asked of the server.
      expect(fetches.map((f) => f.text)).toEqual(pieces.slice(0, 3))
      expect(spoken).toEqual(pieces)

      // A failure that is not "unavailable" (the engine refused the piece) drops it at once.
      fetches.length = 0
      spoken.length = 0
      const again = zhSpeaker()
      const next = speaker.enqueue(zh('\u4e94\u3002', '\u516d\u3002'))
      fetches[0]!.reject(new SpeakError('The local voice answered 500', 502, false, 'tts_failed'))
      expect(await next).toBe('done')
      expect(fetches).toHaveLength(1)
      expect(again).toEqual(['\u4e94\u3002', '\u516d\u3002'])
    } finally { vi.unstubAllGlobals() }
  })

  it('a piece that plays clears the misses: two, a success, then two more keep the voice', async () => {
    zhSpeaker()
    try {
      const pieces = ['\u4e00\u3002', '\u4e8c\u3002', '\u4e09\u3002', '\u56db\u3002', '\u4e94\u3002', '\u516d\u3002']
      const done = speaker.enqueue(zh(...pieces))
      for (let i = 0; i < pieces.length - 1; i++) {
        await settle()
        if (i === 2) { fetches[i]!.resolve(); await settle(); endPlaying() } else fetches[i]!.reject(unavailable())
        await settle()
      }
      await settle()
      expect(fetches.map((f) => f.text)).toEqual(pieces)
      fetches[5]!.resolve()
      await settle()
      endPlaying()
      expect(await done).toBe('done')
    } finally { vi.unstubAllGlobals() }
  })
})

/** A streamed piece's body the test writes: big-endian 16-bit samples at 1 kHz (100 samples = 0.1 s). */
function pcmStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
  const be = (n: number, value: number) => { const b = new Uint8Array(n * 2); const v = new DataView(b.buffer); for (let i = 0; i < n; i++) v.setInt16(i * 2, value, false); return b }
  return { body, push: (n: number, value = 16384) => ctrl.enqueue(be(n, value)), bytes: (b: Uint8Array) => ctrl.enqueue(b), end: () => ctrl.close(), fail: () => ctrl.error(new Error('cut')) }
}

/** Answer fetch i with a stream, as speakPiece does: resolved at its first audio. */
async function answerStream(i: number, stream: ReturnType<typeof pcmStream>): Promise<PcmFeed> {
  const feed = new PcmFeed(stream.body, { rate: 1000, channels: 1 }, fetches[i]!.signal)
  await feed.firstAudio
  fetches[i]!.resolveWith(feed)
  await settle()
  return feed
}

describe('a streamed piece (the local voice, audio/L16)', () => {
  it('plays as it arrives: runs back to back, a run after a gap from now, done only after the stream ended and its last buffer did', async () => {
    const outcome = vi.fn()
    void speaker.enqueue(reply('One.')).then(outcome)
    const s = pcmStream()
    s.push(100)
    await answerStream(0, s)
    expect(ctx.sources).toHaveLength(1)
    // The first buffer starts a lead from now (room for the next chunk).
    expect(ctx.sources[0]!.at).toBeCloseTo(0.2)
    expect(ctx.sources[0]!.buffer!.data[0]![0]).toBe(0.5)
    expect(speaker.outputLevel()).toBeGreaterThan(0)
    // The next run starts where the first ends, with no gap.
    s.push(50)
    await settle()
    expect(ctx.sources[1]!.at).toBeCloseTo(0.3)
    // The buffers ran out and the stream fell behind: the next run starts a longer lead from now.
    ctx.sources[0]!.onended?.()
    ctx.currentTime = 1
    s.push(20)
    await settle()
    expect(ctx.sources[2]!.at).toBeCloseTo(1.4)
    // Buffers played out, but the stream has not ended: not done.
    ctx.sources[1]!.onended?.()
    await settle()
    expect(outcome).not.toHaveBeenCalled()
    s.end()
    await settle()
    expect(outcome).not.toHaveBeenCalled()
    expect(speaker.outputLevel()).toBeGreaterThan(0)
    ctx.sources[2]!.onended?.()
    await settle()
    expect(outcome).toHaveBeenCalledWith('done')
    expect(speaker.outputLevel()).toBe(0)
  })

  it('a sample cut across two network chunks waits for its other half', async () => {
    void speaker.enqueue(reply('One.'))
    const s = pcmStream()
    s.bytes(new Uint8Array([0x40, 0x00, 0xc0]))
    await answerStream(0, s)
    s.bytes(new Uint8Array([0x00]))
    await settle()
    expect(ctx.sources.map((x) => [...x.buffer!.data[0]!])).toEqual([[0.5], [-0.5]])
  })

  it('stop stops every scheduled buffer and ends the reading', async () => {
    const said = speaker.enqueue(reply('One.'))
    const s = pcmStream()
    s.push(100)
    const feed = await answerStream(0, s)
    s.push(100)
    await settle()
    expect(ctx.sources).toHaveLength(2)
    speaker.stop()
    expect(await said).toBe('stopped')
    expect(ctx.sources.every((x) => x.stopped)).toBe(true)
    expect(feed.failed).toBeTruthy()
    expect(fetches[0]!.signal!.aborted).toBe(true)
    expect(speaker.outputLevel()).toBe(0)
  })

  it('the next piece is fetched once the current stream ended (the local voice makes one at a time), read while that one plays, then plays from what it held', async () => {
    const done = speaker.enqueue(reply('One.', 'Two.'))
    const first = pcmStream()
    first.push(100)
    await answerStream(0, first)
    // One is still being made: a fetch of Two now would only wait in the voice's line.
    expect(fetches.map((f) => f.text)).toEqual(['One.'])
    void speaker.enqueue(reply('Three.'))
    expect(fetches.map((f) => f.text)).toEqual(['One.'])
    first.end()
    await settle()
    expect(fetches.map((f) => f.text)).toEqual(['One.', 'Two.'])
    // Two's whole stream comes while One still plays.
    const second = pcmStream()
    second.push(30)
    second.push(30)
    second.end()
    const held = await answerStream(1, second)
    expect(ctx.sources).toHaveLength(1)
    ctx.sources[0]!.onended?.()
    await settle()
    // What it held plays as one buffer, then the queue is done.
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[1]!.buffer!.data[0]!.length).toBe(60)
    expect(held.failed).toBeNull()
    // Two's stream had ended: Three is on its way while Two plays.
    expect(fetches.map((f) => f.text)).toEqual(['One.', 'Two.', 'Three.'])
    ctx.sources[1]!.onended?.()
    fetches[2]!.resolve()
    await settle()
    ctx.sources[2]!.onended?.()
    expect(await done).toBe('done')
  })

  it('every underrun doubles the lead, up to a second, and the next piece starts with the grown lead', async () => {
    void speaker.enqueue(reply('One.', 'Two.'))
    const s = pcmStream()
    s.push(100)
    await answerStream(0, s)
    expect(ctx.sources[0]!.at).toBeCloseTo(0.2)
    // Each run comes after the one before ran out: 0.4, 0.8, then 1.0 (the cap).
    const leads: number[] = []
    for (const now of [1, 3, 5, 7]) {
      ctx.currentTime = now
      s.push(10)
      await settle()
      leads.push(ctx.sources.at(-1)!.at! - now)
    }
    expect(leads.map((l) => Math.round(l * 10) / 10)).toEqual([0.4, 0.8, 1, 1])
    // A run that comes in time adds no lead: right after the one before.
    const end = ctx.sources.at(-1)!.at! + 0.01
    s.push(10)
    await settle()
    expect(ctx.sources.at(-1)!.at).toBeCloseTo(end)
    s.end()
    await settle()
    ctx.sources.at(-1)!.onended?.()
    await settle()
    const t = pcmStream()
    t.push(10)
    ctx.currentTime = 10
    await answerStream(1, t)
    expect(ctx.sources.at(-1)!.at).toBeCloseTo(11)
  })

  it('a stream that breaks part way ends that piece; the next one plays, and the server voice stays', async () => {
    const done = speaker.enqueue(reply('One.', 'Two.'))
    const s = pcmStream()
    s.push(100)
    await answerStream(0, s)
    s.fail()
    await settle()
    ctx.sources[0]!.onended?.()
    fetches[1]!.resolve()
    await settle()
    // Two arrived whole (a cached piece): it plays.
    expect(ctx.sources).toHaveLength(2)
    ctx.sources[1]!.onended?.()
    expect(await done).toBe('done')
    expect(speaker.currentEngine).toBe('elevenlabs')
  })
})
