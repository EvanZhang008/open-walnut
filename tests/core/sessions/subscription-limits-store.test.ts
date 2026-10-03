/**
 * The per-host subscription limit store (src/core/sessions/subscription-limits.ts):
 * readings keyed by host, newest per window, one `host:subscription-limits`
 * push per event (never carrying a top-level sessionId, so every client gets
 * it), a cache file that survives a restart, and the host's sign-in attached
 * to each frame.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-subscription-limits'))

import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import {
  noteRateLimitEvent, readSubscriptionLimits, subscriptionLimitsFile,
  _flushSubscriptionLimitsForTest, _resetSubscriptionLimitsForTest, _setSignInResolverForTest,
} from '../../../src/core/sessions/subscription-limits.js'
import { store as readinessStore, type StoredReadiness } from '../../../src/core/hosts/host-readiness-store.js'

const T0 = Math.floor(Date.now() / 1000) + 3600
const line = (info: object, sid = 'sid-1') => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u-1', session_id: sid })

function collectPushes(): BusEvent[] {
  const out: BusEvent[] = []
  bus.subscribe('limits-test', (e) => { if (e.name === EventNames.HOST_SUBSCRIPTION_LIMITS) out.push(e) }, { global: true })
  return out
}

beforeEach(async () => {
  bus.clear()
  _resetSubscriptionLimitsForTest()
  _setSignInResolverForTest(async () => undefined)
  await fs.rm(subscriptionLimitsFile(), { force: true })
})

afterEach(() => {
  bus.clear()
  readinessStore.clear()
  _resetSubscriptionLimitsForTest()
})

describe('subscription limit store', () => {
  it('keys readings by host (no host = this machine), local first', async () => {
    expect(noteRateLimitEvent('devbox', 'sid-r', line({ status: 'allowed', rateLimitType: 'seven_day', resetsAt: T0, utilization: 0.3 }), 1000)).toBe(true)
    expect(noteRateLimitEvent(null, 'sid-l', line({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0, utilization: 0.9 }), 1001)).toBe(true)
    await _flushSubscriptionLimitsForTest()
    const frames = await readSubscriptionLimits()
    expect(frames.map((f) => f.host)).toEqual(['__local__', 'devbox'])
    expect(frames[0].windows.five_hour).toMatchObject({ utilization: 0.9, sessionId: 'sid-l', seenAt: 1001 })
    expect(frames[1].windows.seven_day).toMatchObject({ utilization: 0.3, sessionId: 'sid-r' })
    expect(Object.keys(frames[1].windows)).toEqual(['seven_day'])
    expect((await readSubscriptionLimits('devbox')).map((f) => f.host)).toEqual(['devbox'])
    expect(await readSubscriptionLimits('nowhere')).toEqual([])
  })

  it('the newest event wins per window, in arrival order', async () => {
    noteRateLimitEvent(null, 'a', line({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0, utilization: 0.81 }), 1000)
    noteRateLimitEvent(null, 'b', line({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0, utilization: 0.86 }), 2000)
    noteRateLimitEvent(null, 'c', line({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: T0, utilization: 1 }), 3000)
    await _flushSubscriptionLimitsForTest()
    const [f] = await readSubscriptionLimits()
    expect(f.windows.five_hour).toMatchObject({ utilization: 1, sessionId: 'c', seenAt: 3000 })
    expect(f.current).toMatchObject({ status: 'rejected', type: 'five_hour' })
  })

  it('pushes one host frame per event, with no top-level session id (it is about a host)', async () => {
    const pushes = collectPushes()
    noteRateLimitEvent('devbox', 'sid-9', line({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 }), 1000)
    await _flushSubscriptionLimitsForTest()
    expect(pushes).toHaveLength(1)
    const data = pushes[0].data as Record<string, unknown>
    expect(data.host).toBe('devbox')
    expect(data.sessionId).toBeUndefined()
    expect(data.taskId).toBeUndefined()
    expect(typeof data.serverNow).toBe('number')
    expect(pushes[0].destinations).toEqual(['web-ui'])
  })

  it('an unreadable line records nothing and pushes nothing', async () => {
    const pushes = collectPushes()
    expect(noteRateLimitEvent(null, 's', { type: 'rate_limit_event', rate_limit_info: { status: 'boom' } })).toBe(false)
    expect(noteRateLimitEvent(null, 's', { type: 'rate_limit_event' })).toBe(false)
    await _flushSubscriptionLimitsForTest()
    expect(pushes).toHaveLength(0)
    expect(await readSubscriptionLimits()).toEqual([])
  })

  it('persists: a restart (fresh memory) reads the same readings back from the cache file', async () => {
    noteRateLimitEvent('devbox', 'sid-p', line({
      status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0,
      unifiedWindows: { five_hour: { utilization: 0.44, resetsAt: T0 }, seven_day: { utilization: 0.21, resetsAt: T0 + 86_400 } },
      overageStatus: 'allowed', isUsingOverage: true,
    }), 1234)
    await _flushSubscriptionLimitsForTest()
    const before = await readSubscriptionLimits()
    const onDisk = JSON.parse(await fs.readFile(subscriptionLimitsFile(), 'utf-8'))
    expect(onDisk.version).toBe(1)
    expect(Object.keys(onDisk.hosts)).toEqual(['devbox'])

    _resetSubscriptionLimitsForTest()
    _setSignInResolverForTest(async () => undefined)
    const after = await readSubscriptionLimits()
    const strip = (fs2: typeof before) => fs2.map(({ serverNow: _n, ...rest }) => rest)
    expect(strip(after)).toEqual(strip(before))
    expect(after[0].windows.seven_day).toMatchObject({ utilization: 0.21, seenAt: 1234 })
    expect(after[0].overage).toMatchObject({ isUsingOverage: true })
  })

  it('a corrupt cache file is a fresh start, not a crash', async () => {
    await fs.mkdir((await import('node:path')).dirname(subscriptionLimitsFile()), { recursive: true })
    await fs.writeFile(subscriptionLimitsFile(), '{ not json', 'utf-8')
    expect(await readSubscriptionLimits()).toEqual([])
    noteRateLimitEvent(null, 's', line({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 }), 1)
    await _flushSubscriptionLimitsForTest()
    expect((await readSubscriptionLimits()).map((f) => f.host)).toEqual(['__local__'])
  })

  it('each frame carries the host\'s sign-in from its readiness check (default resolver)', async () => {
    _setSignInResolverForTest(null)
    readinessStore.set('devbox', {
      checkedAt: 777, problems: [], compiler: { found: true }, dtach: { found: true },
      claude: { found: true, auth: 'ok', authDetail: 'Bedrock' },
    } as StoredReadiness)
    readinessStore.set('subhost', {
      checkedAt: 888, problems: [], compiler: { found: true }, dtach: { found: true },
      claude: { found: true, auth: 'ok', authDetail: 'a Claude account' },
    } as StoredReadiness)
    noteRateLimitEvent('devbox', 's', line({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 }), 1)
    noteRateLimitEvent('subhost', 's', line({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 }), 2)
    noteRateLimitEvent('unchecked', 's', line({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 }), 3)
    await _flushSubscriptionLimitsForTest()
    const byHost = Object.fromEntries((await readSubscriptionLimits()).map((f) => [f.host, f.signIn]))
    expect(byHost.devbox).toEqual({ kind: 'other', detail: 'Bedrock', checkedAt: 777 })
    expect(byHost.subhost).toEqual({ kind: 'subscription', detail: 'a Claude account', checkedAt: 888 })
    expect(byHost.unchecked).toBeUndefined()
  })
})
