/**
 * The auth limit of a host replica (src/replica/auth.ts). Every caller reaches
 * it through the tunnel over loopback, so a limit keyed by address is either
 * dodged (a new X-Forwarded-For per try) or turned on the user (a stranger's
 * wrong tokens lock every tunnel client out). Wrong tokens share one bucket,
 * and a token in the device copy always passes, on /api and on the /ws upgrade.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'
import { sha256 } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-auth-limit'))

import { _resetReplicaAuthForTesting, replicaAuthMiddleware, replicaDeviceCopy, verifyReplicaUpgrade } from '../../src/replica/auth.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'

const PHONE_TOKEN = 'marina-phone-token'

/** One /api call: the status it answered (200 = passed to next). */
async function call(token: string | null, ip: string): Promise<number> {
  const req = {
    method: 'GET', path: '/v1/tasks', ip, socket: { remoteAddress: '127.0.0.1' },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as Request
  let status = 0
  const res = { status(n: number) { status = n; return res }, json() { return res } } as unknown as Response
  let passed = false
  await replicaAuthMiddleware(req, res, (() => { passed = true }) as NextFunction)
  return passed ? 200 : status
}

beforeEach(() => {
  _resetAuthRateLimitForTesting()
  _resetReplicaAuthForTesting()
  expect(replicaDeviceCopy().put({ devices: [{ name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }] })).toMatchObject({ ok: true })
})

describe('host replica auth limit', () => {
  it('a new forwarded address per try does not dodge the limit', async () => {
    const got: number[] = []
    for (let i = 0; i < 12; i++) got.push(await call(`guess-${i}`, `203.0.113.${i}`))
    expect(got.slice(0, 10)).toEqual(Array(10).fill(401))
    expect(got.slice(10)).toEqual([429, 429])
  })

  it('a stranger\'s wrong tokens never refuse the phone\'s good token, on /api or the /ws upgrade', async () => {
    for (let i = 0; i < 15; i++) await call(`guess-${i}`, '127.0.0.1')
    expect(await call('guess-x', '127.0.0.1')).toBe(429)
    expect(await verifyReplicaUpgrade('guess-y')).toBe(429)
    // The phone, through the same tunnel (same address), right after.
    expect(await call(PHONE_TOKEN, '127.0.0.1')).toBe(200)
    expect(await verifyReplicaUpgrade(PHONE_TOKEN)).toBe('ok')
  })

  it('the /ws upgrade counts into the same bucket as /api', async () => {
    for (let i = 0; i < 10; i++) expect(await verifyReplicaUpgrade(`ws-guess-${i}`)).toBe(401)
    expect(await call('api-guess', '198.51.100.7')).toBe(429)
  })

  it('no token is a first contact, never counted', async () => {
    for (let i = 0; i < 20; i++) expect(await call(null, '127.0.0.1')).toBe(401)
    expect(await call('one-guess', '127.0.0.1')).toBe(401)
  })
})
