/**
 * The search wiring gives the embedding model back (src/core/search/wiring.ts):
 *
 *  - under memory pressure it suspends the embedder (each worker lane holds a
 *    full model copy, measured +2.2 GB of footprint on the default model) and
 *    resumes it when pressure clears;
 *  - at the end of every vector backfill pass, drained or failed, it releases
 *    the passage worker at once instead of after the worker's 5 min idle timer
 *    (passes run about 10 min apart, so the copy used to stay half the time).
 *
 * The index is the real singleton on the test home, with its embedder methods
 * spied: no model is configured (an unknown model id), while the semantic lane
 * decision is opted in, so the wiring treats this as a server with a model.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../src/core/event-bus.js'
import {
  applyPressureReading,
  _resetMemoryPressureForTest,
  _setPressureHoldMsForTest,
} from '../../src/core/memory-pressure.js'
import {
  currentSemanticLaneDecision,
  getSearchV2Index,
  resetSearchV2IndexForTests,
  searchV2Lane,
  startSearchV2Wiring,
  type SearchV2Wiring,
} from '../../src/core/search/wiring.js'
import { log } from '../../src/logging/index.js'

const saved = { semantic: process.env.WALNUT_SEARCH_V2_SEMANTIC, model: process.env.WALNUT_SEARCH_V2_EMBED_MODEL }

beforeAll(() => {
  process.env.WALNUT_SEARCH_V2_SEMANTIC = '1'
  process.env.WALNUT_SEARCH_V2_EMBED_MODEL = 'no-such-model-for-tests'
  resetSearchV2IndexForTests()
})

afterAll(() => {
  if (saved.semantic === undefined) delete process.env.WALNUT_SEARCH_V2_SEMANTIC
  else process.env.WALNUT_SEARCH_V2_SEMANTIC = saved.semantic
  if (saved.model === undefined) delete process.env.WALNUT_SEARCH_V2_EMBED_MODEL
  else process.env.WALNUT_SEARCH_V2_EMBED_MODEL = saved.model
  resetSearchV2IndexForTests()
})

let wiring: SearchV2Wiring | null = null

beforeEach(() => {
  _resetMemoryPressureForTest()
  _setPressureHoldMsForTest(1)
  for (const level of ['info', 'warn', 'debug'] as const) {
    vi.spyOn(log.memory, level).mockImplementation(() => {})
    vi.spyOn(log.web, level).mockImplementation(() => {})
  }
})

afterEach(async () => {
  await wiring?.stop()
  wiring = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetMemoryPressureForTest()
})

describe('search wiring under memory pressure', () => {
  it('releases the model when pressure starts and lets it load again when it clears', async () => {
    expect(currentSemanticLaneDecision().on).toBe(true)
    const index = getSearchV2Index()
    const suspend = vi.spyOn(index, 'suspendEmbedder').mockResolvedValue(undefined)
    const resume = vi.spyOn(index, 'resumeEmbedder').mockImplementation(() => {})
    wiring = startSearchV2Wiring(new EventBus())
    applyPressureReading('warn')
    expect(suspend).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    applyPressureReading('normal', Date.now() + 10)
    expect(resume).toHaveBeenCalledTimes(1)
    await wiring.stop()
    wiring = null
    // A stopped wiring no longer listens.
    applyPressureReading('critical', Date.now() + 20)
    expect(suspend).toHaveBeenCalledTimes(1)
  })

  it('a server already under pressure when the wiring starts releases at once', () => {
    const index = getSearchV2Index()
    const suspend = vi.spyOn(index, 'suspendEmbedder').mockResolvedValue(undefined)
    applyPressureReading('critical')
    wiring = startSearchV2Wiring(new EventBus())
    expect(suspend).toHaveBeenCalledTimes(1)
  })
})

describe('search wiring vector backfill', () => {
  /** Drive the wiring's timers in fake time, yielding to real I/O between steps. */
  async function pumpUntil(cond: () => boolean, fakeMs = 120_000): Promise<void> {
    for (let t = 0; t < fakeMs && !cond(); t += 250) {
      await vi.advanceTimersByTimeAsync(250)
      await new Promise((r) => setImmediate(r))
    }
  }

  it.each([
    ['drains', 'drained'],
    ['fails', 'failed'],
  ])('releases the passage worker when a pass %s', async (_name, outcome) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const index = getSearchV2Index()
    index.upsert({ kind: 'task', ref: 't-backfill-1', title: 'Rotate the marina keys', updatedAt: Date.now() })
    const backfill = vi.spyOn(index, 'backfillVectors').mockImplementation(async () => {
      if (outcome === 'failed') throw new Error('embed worker unavailable')
      return { embedded: 1, drained: true, cursor: null, scanned: 1 }
    })
    const release = vi.spyOn(index, 'releasePassageWorker').mockResolvedValue(true)
    wiring = startSearchV2Wiring(new EventBus())
    await pumpUntil(() => release.mock.calls.length > 0)
    expect(backfill).toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  }, 60_000)
})

describe('searchV2Lane', () => {
  it('hands the caller the semantic state, which the result memo reads (src/core/search.ts)', async () => {
    // No model here, so the lane is keyword-only and says `disabled`; the memo
    // skips a result whose state is `cold` or `timeout`, so a lane that drops
    // the callback would let an incomplete answer be replayed for 20 s.
    getSearchV2Index().upsert({ kind: 'task', ref: 't-lane-1', title: 'Rotate the marina keys', updatedAt: Date.now() })
    const states: string[] = []
    const hits = await searchV2Lane('rotate marina keys', { kinds: ['task'], onSemantic: (s) => states.push(s) })
    expect(hits.map((h) => h.ref)).toContain('t-lane-1')
    expect(states).toEqual(['disabled'])
  })
})
