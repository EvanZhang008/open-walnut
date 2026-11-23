/**
 * Voice mode's speaker queue (web/src/voice/voice-speaker.ts): pieces said in order,
 * the next one's audio fetched while one plays (pieces added mid-play included), one
 * promise for the whole queue, stop and say, and the waiting cue. Web Audio and the
 * speech route are fakes; nothing makes a sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Fetch { text: string; previousText?: string; nextText?: string; resolve: () => void; reject: (err: Error) => void }
const fetches: Fetch[] = []

vi.mock('../../../web/src/api/voice', () => ({
  speakPiece: (piece: { text: string; previousText?: string; nextText?: string }) => new Promise<ArrayBuffer>((resolve, reject) => {
    fetches.push({ ...piece, resolve: () => resolve(new ArrayBuffer(8)), reject })
  }),
  SpeakError: class extends Error {
    constructor(message: string, readonly status: number, readonly fallback: boolean, readonly code = '') { super(message) }
  },
  spokenReply: async () => null,
}))

import { VoiceSpeaker } from '../../../web/src/voice/voice-speaker'
import { SpeakError } from '../../../web/src/api/voice'

interface FakeSource { onended: (() => void) | null; started: boolean }

class FakeContext {
  state: AudioContextState = 'running'
  currentTime = 0
  destination = {}
  sources: FakeSource[] = []
  oscillators = 0
  createAnalyser() { return { fftSize: 2048, connect() {}, getFloatTimeDomainData() {} } }
  decodeAudioData() { return Promise.resolve({ duration: 30 }) }
  createBufferSource() {
    const s: FakeSource & Record<string, unknown> = { onended: null, started: false, buffer: null, connect() {}, start() { s.started = true }, stop() {} }
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
