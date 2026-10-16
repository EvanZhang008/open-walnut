/**
 * GET /api/config on a host replica names this host as the Mac knows it
 * (`replica: {hostKey}`, WALNUT_HOST_KEY; src/web/routes/config.ts), so the
 * console tells a session that runs here from one on the Mac while it answers
 * from this replica. The Mac's answer has no such field, also when the env
 * carries a host key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-config-host-key'))

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../src/constants.js'
import { configRouter } from '../../src/web/routes/config.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'
import { _resetWriteLockForTest } from '../../src/core/config-manager.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'

const KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_KEY'] as const
const saved: Record<string, string | undefined> = {}

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/config', configRouter)
  a.use(errorHandler)
  return a
}

beforeEach(async () => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  _resetServerRoleForTesting()
  _resetWriteLockForTest()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
})

describe('GET /api/config: the host key', () => {
  it('a host replica answers replica.hostKey (trimmed)', async () => {
    process.env.WALNUT_ROLE = 'replica'
    process.env.WALNUT_PLACEMENT = 'host'
    process.env.WALNUT_HOST_KEY = ' devbox '
    const r = await request(app()).get('/api/config')
    expect(r.status).toBe(200)
    expect(r.body.role).toBe('replica')
    expect(r.body.placement).toBe('host')
    expect(r.body.replica).toEqual({ hostKey: 'devbox' })
  })

  it('a host replica with no host key told has no field', async () => {
    process.env.WALNUT_ROLE = 'replica'
    process.env.WALNUT_PLACEMENT = 'host'
    const r = await request(app()).get('/api/config')
    expect(r.status).toBe(200)
    expect('replica' in r.body).toBe(false)
  })

  it('the Mac: the same fields with or without a host key in its env, and no replica field', async () => {
    const plain = await request(app()).get('/api/config')
    process.env.WALNUT_HOST_KEY = 'devbox'
    _resetServerRoleForTesting()
    const keyed = await request(app()).get('/api/config')
    expect(keyed.body.role).toBe('leader')
    expect('replica' in keyed.body).toBe(false)
    expect(Object.keys(keyed.body)).toEqual(Object.keys(plain.body))
  })
})
