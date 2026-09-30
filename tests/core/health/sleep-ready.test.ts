/**
 * health:sleep-ready fires ONCE per wake date: `ready` once the last asleep
 * sample is 30 minutes old at an upload, `missing` at 10:30 local when no night
 * arrived, and nothing at all for a paused store. The 10:30 timer is armed in the
 * phone's zone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-health-ready'))

import { ingestHealthSync } from '../../../src/core/health/ingest.js'
import { destroyHealthDbFiles, closeHealthDb } from '../../../src/core/health/db.js'
import { resetMaterializeQueue } from '../../../src/core/health/materialize.js'
import { checkSleepReady, disarmMissingCheck, nextMissingCheckAt } from '../../../src/core/health/sleep-ready.js'
import { updateHealthSettings } from '../../../src/core/health/settings.js'
import { bus } from '../../../src/core/event-bus.js'
import { rawBatch, watchNight, bucketBatch, hrBuckets, sleepSample, APP } from './fixtures.js'

const at = (iso: string): number => Date.parse(iso)
let fired: Array<{ date: string; status: string }> = []

beforeEach(() => {
  resetMaterializeQueue()
  destroyHealthDbFiles()
  fired = []
  bus.subscribe('test-sleep-ready', (e) => {
    if (e.name === 'health:sleep-ready') fired.push(e.data as { date: string; status: string })
  }, { global: true })
})

afterEach(() => {
  bus.unsubscribe('test-sleep-ready')
  disarmMissingCheck()
  closeHealthDb()
})

describe('health:sleep-ready', () => {
  it('waits until the last asleep sample is 30 minutes old, then fires ready exactly once', () => {
    const night = rawBatch('sleep', watchNight('2026-09-20', '2026-09-21'))
    ingestHealthSync(night, { now: at('2026-09-21T07:10:00-04:00') })
    expect(fired).toEqual([])
    // Any later upload (here: heart-rate buckets) is the moment to decide.
    ingestHealthSync(bucketBatch('heart_rate', hrBuckets(at('2026-09-21T07:00:00-04:00'), 2)), { now: at('2026-09-21T07:31:00-04:00') })
    expect(fired).toEqual([{ date: '2026-09-21', status: 'ready' }])
    ingestHealthSync(bucketBatch('heart_rate', hrBuckets(at('2026-09-21T07:10:00-04:00'), 2)), { now: at('2026-09-21T08:00:00-04:00') })
    expect(checkSleepReady(at('2026-09-21T10:30:00-04:00'), { atMissingCheck: true })).toBeNull()
    expect(fired).toHaveLength(1)
  })

  it('an upload in the middle of the night never calls a half night ready', () => {
    // First half of the night, uploaded at 03:30 during a bathroom trip: the last
    // asleep sample is 90 minutes old, but it is not morning yet.
    const half = watchNight('2026-09-20', '2026-09-21').slice(0, 2)
    ingestHealthSync(rawBatch('sleep', half), { now: at('2026-09-21T03:30:00-04:00') })
    expect(fired).toEqual([])
    ingestHealthSync(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21').slice(2)), { now: at('2026-09-21T07:31:00-04:00') })
    expect(fired).toEqual([{ date: '2026-09-21', status: 'ready' }])
  })

  it('fires missing at the 10:30 check when no night arrived, once', () => {
    ingestHealthSync(bucketBatch('heart_rate', hrBuckets(at('2026-09-21T06:00:00-04:00'), 2)), { now: at('2026-09-21T06:30:00-04:00') })
    expect(checkSleepReady(at('2026-09-21T10:30:00-04:00'), { atMissingCheck: true })).toBe('missing')
    expect(checkSleepReady(at('2026-09-21T10:31:00-04:00'), { atMissingCheck: true })).toBeNull()
    expect(fired).toEqual([{ date: '2026-09-21', status: 'missing' }])
  })

  it('the 10:30 check fires ready for a night whose only upload came right after waking', () => {
    ingestHealthSync(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')), { now: at('2026-09-21T07:05:00-04:00') })
    expect(fired).toEqual([])
    expect(checkSleepReady(at('2026-09-21T10:30:00-04:00'), { atMissingCheck: true })).toBe('ready')
  })

  it('an In-Bed-only night (an iPhone with no Watch) fires ready, not missing', () => {
    const inBed = [sleepSample('2026-09-20T23:15:00-04:00', '2026-09-21T07:00:00-04:00', 0, APP)]
    ingestHealthSync(rawBatch('sleep', inBed), { now: at('2026-09-21T07:40:00-04:00') })
    expect(fired).toEqual([{ date: '2026-09-21', status: 'ready' }])
    expect(checkSleepReady(at('2026-09-21T10:30:00-04:00'), { atMissingCheck: true })).toBeNull()
    expect(fired).toHaveLength(1)
  })

  it('a paused store, or one that never uploaded, fires nothing', () => {
    expect(checkSleepReady(at('2026-09-21T10:30:00-04:00'), { atMissingCheck: true })).toBeNull()
    ingestHealthSync(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')), { now: at('2026-09-21T07:05:00-04:00') })
    updateHealthSettings({ paused: true })
    expect(checkSleepReady(at('2026-09-21T10:30:00-04:00'), { atMissingCheck: true })).toBeNull()
    expect(fired).toEqual([])
  })

  it('arms the missing check for the next 10:30 in the phone zone, DST included', () => {
    expect(nextMissingCheckAt(at('2026-09-21T09:00:00-04:00'), 'America/New_York')).toBe(at('2026-09-21T10:30:00-04:00'))
    expect(nextMissingCheckAt(at('2026-09-21T11:00:00-04:00'), 'America/New_York')).toBe(at('2026-09-22T10:30:00-04:00'))
    expect(nextMissingCheckAt(at('2026-10-31T12:00:00-04:00'), 'America/New_York')).toBe(at('2026-11-01T10:30:00-05:00'))
    expect(nextMissingCheckAt(at('2026-09-21T09:00:00-04:00'), 'Asia/Tokyo')).toBe(at('2026-09-22T10:30:00+09:00'))
  })
})
