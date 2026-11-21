/**
 * The live draft of a take of any length (web/src/utils/recorder-draft-lanes.ts).
 * 2026-11-20: the draft stopped at 5 minutes of a mock interview because every
 * tick decoded the whole recorder; now it moves onto a fresh recorder and keeps
 * its place by the clock. A simulated 30-minute take checks the decode a tick
 * costs never grows past one lane.
 */
import { describe, it, expect } from 'vitest'
import { DraftLanes, type DraftLane, type LanePcm } from '../../web/src/utils/recorder-draft-lanes'

const RATE = 16000

/** A lane whose recorder has run since `startedAt` on a shared fake clock. */
class FakePcm implements LanePcm {
  readonly sampleRate = RATE
  decodedSamples = 0
  totalSamples = 0
  refreshes = 0
  constructor(private readonly clock: { now: number }, private readonly startedAt: number, private readonly repeat = 1) {}
  async refresh(): Promise<void> {
    this.refreshes++
    const heard = Math.round((this.clock.now - this.startedAt) * (RATE / 1000))
    this.totalSamples = heard
    this.decodedSamples = heard * this.repeat
  }
  takeRebase(): number { return 0 }
}

function setup(opts: { maxMs?: number; repeat?: number; refuse?: boolean; brokenNext?: boolean; silentNext?: boolean } = {}) {
  const clock = { now: 0 }
  const stopped: number[] = []
  const lanes: Array<DraftLane<FakePcm>> = []
  const lane = (startedAt: number): DraftLane<FakePcm> => {
    const id = lanes.length
    const pcm = new FakePcm(clock, startedAt, opts.repeat)
    if (id > 0 && opts.brokenNext) pcm.refresh = async () => { throw new Error('does not decode') }
    const l: DraftLane<FakePcm> = { pcm, chunks: () => (id > 0 && opts.silentNext ? [] : [new Blob(['x'])]), startedAt, stop: () => { stopped.push(id) } }
    lanes.push(l)
    return l
  }
  const main = lane(0)
  const draft = new DraftLanes<FakePcm>(main, () => (opts.refuse ? null : lane(clock.now)), opts.maxMs ?? 60_000)
  return { clock, draft, lanes, stopped, main }
}

describe('DraftLanes', () => {
  it('opens the next lane halfway and moves onto it once the lane is full, keeping its place by the clock', async () => {
    const { clock, draft, lanes, stopped } = setup()
    clock.now = 20_000; await draft.pcm.refresh(new Blob())
    expect(await draft.advance(0, 'audio/webm')).toBeNull()
    expect(lanes).toHaveLength(1)
    clock.now = 31_000; await draft.pcm.refresh(new Blob())
    expect(await draft.advance(0, 'audio/webm')).toBeNull()
    expect(lanes).toHaveLength(2)                   // opened at 31 s
    clock.now = 61_000; await draft.pcm.refresh(new Blob())
    // The draft window opened 55 s into the take: 24 s into the lane that began at 31 s.
    const moved = await draft.advance(55 * RATE, 'audio/webm')
    expect(moved).toBe(24 * RATE)
    expect(draft.pcm).toBe(lanes[1]!.pcm)
    expect(lanes[1]!.pcm.refreshes).toBe(1)        // refreshed before the draft reads it
    expect(stopped).toEqual([0])                    // the lane left behind ends (the take's own recorder ignores it)
  })

  it('a 30-minute take never decodes more than one lane in a tick', async () => {
    const { clock, draft, lanes } = setup({ maxMs: 4 * 60_000 })
    let windowStart = 0
    let maxDecodedMs = 0
    for (clock.now = 1000; clock.now <= 30 * 60_000; clock.now += 2000) {
      await draft.pcm.refresh(new Blob())
      // The window trails the newest audio by about ten seconds, as commits keep it.
      windowStart = Math.max(windowStart, draft.pcm.totalSamples - 10 * RATE)
      const moved = await draft.advance(windowStart, 'audio/webm')
      if (moved !== null) windowStart = moved
      maxDecodedMs = Math.max(maxDecodedMs, draft.pcm.decodedSamples / 16)
      expect(draft.exhausted).toBe(false)
    }
    expect(lanes.length).toBeGreaterThanOrEqual(7)
    expect(maxDecodedMs).toBeLessThanOrEqual(4 * 60_000 + 4000)
  })

  it('a recorder that writes each 10 ms twice moves sooner, by its decoded length', async () => {
    const { clock, draft, lanes } = setup({ repeat: 2 })
    for (clock.now = 1000; clock.now <= 40_000; clock.now += 1000) {
      await draft.pcm.refresh(new Blob())
      await draft.advance(0, 'audio/webm')
    }
    expect(lanes.length).toBeGreaterThanOrEqual(2)
    expect(draft.pcm).toBe(lanes[1]!.pcm)
  })

  it('a browser that refuses a second recorder is exhausted past the lane, so the draft says it paused', async () => {
    const { clock, draft } = setup({ refuse: true })
    clock.now = 70_000; await draft.pcm.refresh(new Blob())
    expect(await draft.advance(0, 'audio/webm')).toBeNull()
    expect(draft.exhausted).toBe(false)
    clock.now = 80_000; await draft.pcm.refresh(new Blob())
    expect(await draft.advance(0, 'audio/webm')).toBeNull()
    expect(draft.exhausted).toBe(true)
  })

  it('stopAll ends every lane recorder', async () => {
    const { clock, draft, stopped } = setup()
    clock.now = 40_000; await draft.pcm.refresh(new Blob()); await draft.advance(0, 'audio/webm')
    draft.stopAll()
    expect(stopped.sort()).toEqual([0, 1])
  })

  it('a second recorder that never decodes or never gives audio pauses the draft past the ceiling, never silently forever', async () => {
    for (const kind of ['brokenNext', 'silentNext'] as const) {
      const { clock, draft, stopped } = setup({ [kind]: true })
      let exhaustedAt = 0
      for (clock.now = 1000; clock.now <= 120_000 && !exhaustedAt; clock.now += 1000) {
        await draft.pcm.refresh(new Blob())
        expect(await draft.advance(0, 'audio/webm')).toBeNull()
        if (draft.exhausted) exhaustedAt = clock.now
      }
      expect(exhaustedAt, kind).toBeGreaterThan(60_000)
      expect(exhaustedAt, kind).toBeLessThanOrEqual(91_000)
      if (kind === 'brokenNext') expect(stopped).toContain(1)
    }
  })
})
