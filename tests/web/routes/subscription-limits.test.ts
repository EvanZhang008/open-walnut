/**
 * GET /api/subscription-limits (src/web/routes/subscription-limits.ts): every
 * host's frame, one host by `?host=`, an empty list when nothing was reported,
 * and a 204 (never a hang) when the read runs past its deadline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-subscription-limits-route'))

const hold = vi.hoisted(() => ({ hang: false }))
vi.mock('../../../src/core/sessions/subscription-limits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/sessions/subscription-limits.js')>()
  return {
    ...actual,
    readSubscriptionLimits: (host?: string) => hold.hang ? new Promise(() => {}) : actual.readSubscriptionLimits(host),
  }
})

import express from 'express'
import request from 'supertest'
import { subscriptionLimitsRouter, _setReadDeadlineForTest } from '../../../src/web/routes/subscription-limits.js'
import {
  noteRateLimitEvent, subscriptionLimitsFile, _flushSubscriptionLimitsForTest, _resetSubscriptionLimitsForTest, _setSignInResolverForTest,
} from '../../../src/core/sessions/subscription-limits.js'
import fs from 'node:fs/promises'

const T0 = Math.floor(Date.now() / 1000) + 3600

function app() {
  const a = express()
  a.use('/api/subscription-limits', subscriptionLimitsRouter)
  return a
}

beforeEach(async () => {
  hold.hang = false
  _resetSubscriptionLimitsForTest()
  await fs.rm(subscriptionLimitsFile(), { force: true })
  _setSignInResolverForTest(async (host) => host === 'devbox' ? { kind: 'other', detail: 'Bedrock', checkedAt: 5 } : undefined)
})

afterEach(() => {
  _setReadDeadlineForTest(null)
  _resetSubscriptionLimitsForTest()
})

describe('GET /api/subscription-limits', () => {
  it('answers an empty list before any host reported', async () => {
    const res = await request(app()).get('/api/subscription-limits')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ hosts: [] })
  })

  it('answers every host, local first, with the sign-in and the server clock', async () => {
    noteRateLimitEvent('devbox', 'sid-r', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 } }, 10)
    noteRateLimitEvent(undefined, 'sid-l', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: T0, utilization: 0.8 } }, 20)
    await _flushSubscriptionLimitsForTest()
    const res = await request(app()).get('/api/subscription-limits')
    expect(res.status).toBe(200)
    expect(res.body.hosts.map((f: { host: string }) => f.host)).toEqual(['__local__', 'devbox'])
    expect(res.body.hosts[0].windows.seven_day).toMatchObject({ utilization: 0.8, resetsAt: T0 * 1000, sessionId: 'sid-l' })
    expect(res.body.hosts[1].signIn).toEqual({ kind: 'other', detail: 'Bedrock', checkedAt: 5 })
    expect(typeof res.body.hosts[0].serverNow).toBe('number')

    const one = await request(app()).get('/api/subscription-limits?host=devbox')
    expect(one.body.hosts.map((f: { host: string }) => f.host)).toEqual(['devbox'])
    const local = await request(app()).get('/api/subscription-limits?host=__local__')
    expect(local.body.hosts.map((f: { host: string }) => f.host)).toEqual(['__local__'])
  })

  it('a read that runs past its deadline answers 204 instead of pinning the connection', async () => {
    hold.hang = true
    _setReadDeadlineForTest(50)
    const started = Date.now()
    const res = await request(app()).get('/api/subscription-limits')
    expect(res.status).toBe(204)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
