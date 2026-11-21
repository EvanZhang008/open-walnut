/**
 * Voice activity from loudness (web/src/voice/voice-activity.ts): when speech
 * starts, when a pause ends a take, and talking over the answer read aloud.
 */
import { describe, expect, it } from 'vitest'
import { BARGE_IN_OPTIONS, floatRms, LISTEN_OPTIONS, VoiceActivity } from '../../../web/src/voice/voice-activity'

/** Feed `ms` of a constant loudness at 50 ms a sample; returns the events. */
function feed(v: VoiceActivity, rms: number, ms: number, t0: number): { events: string[]; t: number } {
  const events: string[] = []
  let t = t0
  for (let i = 0; i < ms / 50; i++) {
    t += 50
    const e = v.push(rms, t)
    if (e) events.push(`${e}@${t - t0}`)
  }
  return { events, t }
}

describe('voice activity', () => {
  it('speech after quiet starts once, and a long enough pause ends the take', () => {
    const v = new VoiceActivity(LISTEN_OPTIONS)
    let r = feed(v, 0.002, 1000, 0)
    expect(r.events).toEqual([])
    r = feed(v, 0.08, 1500, r.t)
    expect(r.events).toEqual(['speech-start@200'])
    // A short breath does not end it.
    r = feed(v, 0.002, 600, r.t)
    expect(r.events).toEqual([])
    r = feed(v, 0.08, 500, r.t)
    r = feed(v, 0.002, 2000, r.t)
    expect(r.events).toEqual(['end-of-speech@1250'])
  })

  it('a click or a cough shorter than the start time is not speech', () => {
    const v = new VoiceActivity(LISTEN_OPTIONS)
    let r = feed(v, 0.002, 500, 0)
    r = feed(v, 0.2, 100, r.t)
    r = feed(v, 0.002, 500, r.t)
    expect(r.events).toEqual([])
  })

  it('a steady hum is learned as the room: one false take at most, then never speech', () => {
    const v = new VoiceActivity(LISTEN_OPTIONS)
    const first = feed(v, 0.02, 8000, 0)
    expect(first.events.length).toBeLessThanOrEqual(2)
    if (first.events.length) expect(first.events[1]).toMatch(/^end-of-speech/)
    expect(v.threshold()).toBeGreaterThan(0.02)
    expect(feed(v, 0.021, 4000, first.t).events).toEqual([])
    // A voice over the hum still counts.
    expect(feed(v, 0.2, 400, first.t + 4000).events[0]).toMatch(/^speech-start/)
  })

  it('speech already going when the mic opens counts', () => {
    const v = new VoiceActivity(LISTEN_OPTIONS)
    expect(feed(v, 0.1, 400, 0).events).toEqual(['speech-start@200'])
  })

  it('ten seconds of talking with gaps between words never ends the take early', () => {
    const v = new VoiceActivity(LISTEN_OPTIONS)
    let r = feed(v, 0.003, 1000, 0)
    const events: string[] = []
    for (let i = 0; i < 25; i++) {
      r = feed(v, 0.09, 300, r.t); events.push(...r.events)
      r = feed(v, 0.006, 100, r.t); events.push(...r.events)
    }
    expect(events.filter((e) => e.startsWith('end-of-speech'))).toEqual([])
  })

  it('barge-in needs a louder and longer voice than the speaker leaking in', () => {
    const v = new VoiceActivity(BARGE_IN_OPTIONS)
    // The answer leaking into the mic at 0.02: never an interruption.
    expect(feed(v, 0.02, 3000, 0).events).toEqual([])
    // 200 ms of a real voice is not yet enough; 300 ms is.
    expect(feed(v, 0.15, 200, 3000).events).toEqual([])
    const v2 = new VoiceActivity(BARGE_IN_OPTIONS)
    feed(v2, 0.02, 3000, 0)
    expect(feed(v2, 0.15, 400, 3000).events).toEqual(['speech-start@350'])
  })

  it('reset forgets the speech but keeps the floor', () => {
    const v = new VoiceActivity(LISTEN_OPTIONS)
    feed(v, 0.02, 2000, 0)
    feed(v, 0.3, 500, 2000)
    expect(v.inSpeech).toBe(true)
    const floor = v.threshold()
    v.reset()
    expect(v.inSpeech).toBe(false)
    expect(v.threshold()).toBeCloseTo(floor, 5)
  })

  it('floatRms', () => {
    expect(floatRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
    expect(floatRms(new Float32Array(0))).toBe(0)
  })
})
