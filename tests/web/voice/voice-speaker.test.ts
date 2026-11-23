/**
 * Voice mode's speaker queue (web/src/voice/voice-speaker.ts): pieces said in order,
 * the next one's audio fetched while one plays (pieces added mid-play included), one
 * promise for the whole queue, stop and say, and the waiting cue. Web Audio and the
 * speech route are fakes; nothing makes a sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Fetch { text: string; previousText?: string; nextText?: string; resolve: () => void }
const fetches: Fetch[] = []

vi.mock('../../../web/src/api/voice', () => ({
  speakPiece: (piece: { text: string; previousText?: string; nextText?: string }) => new Promise<ArrayBuffer>((resolve) => {
    fetches.push({ ...piece, resolve: () => resolve(new ArrayBuffer(8)) })
  }),
  SpeakError: class extends Error {},
  spokenReply: async () => null,
}))

import { VoiceSpeaker } from '../../../web/src/voice/voice-speaker'

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
