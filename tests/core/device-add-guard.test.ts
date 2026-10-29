/**
 * `walnut device add` refuses to pair a device with the real Walnut from a test
 * run, and from a Walnut session without --production (src/core/device-add-guard.ts).
 * 2026-10-29: a UI test agent paired a device with production's auth.json.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

const REAL_HOME = path.join(os.homedir(), '.open-walnut')
const created = vi.hoisted(() => ({ calls: [] as unknown[] }))

// The command under test believes it writes the real data home, but the write itself is a
// spy: nothing here can touch the account's auth.json.
vi.mock('../../src/constants.js', async (orig) => ({ ...await orig<Record<string, unknown>>(), WALNUT_HOME: path.join(os.homedir(), '.open-walnut') }))
vi.mock('../../src/core/device-auth.js', () => ({
  createDevice: async (...args: unknown[]) => { created.calls.push(args); return { token: 'tok-test', createdAt: '2026-10-29T00:00:00.000Z' } },
  revokePairing: async () => ({}), listDevices: async () => [], readDeviceRegistry: async () => ({}),
  setCompanionOwner: async () => ({}), setDeviceKind: async () => ({}),
}))

import { deviceAddRefusal } from '../../src/core/device-add-guard.js'
import { runDeviceAdd } from '../../src/commands/device.js'

describe('deviceAddRefusal', () => {
  const prod = '/Users/someone/.open-walnut'
  const base = { productionHome: prod, production: false }

  it('a person at a terminal pairs with the real Walnut', () => {
    expect(deviceAddRefusal({ ...base, env: {}, home: prod })).toBeNull()
  })

  it('a session needs --production for the real Walnut, and nothing for an ephemeral home', () => {
    const env = { WALNUT_SESSION_ID: 'sess-1' }
    expect(deviceAddRefusal({ ...base, env, home: prod })).toMatch(/user's real Walnut .*--production/)
    expect(deviceAddRefusal({ ...base, env, home: `${prod}/` })).not.toBeNull()
    expect(deviceAddRefusal({ ...base, env, home: prod, production: true })).toBeNull()
    expect(deviceAddRefusal({ ...base, env, home: '/tmp/walnut-ephemeral-1/.open-walnut' })).toBeNull()
  })

  it('a test run never pairs with the real Walnut, even with --production', () => {
    const env = { WALNUT_TEST_RUN: 'ios-gate', WALNUT_SESSION_ID: 'sess-1' }
    expect(deviceAddRefusal({ ...base, env, home: prod, production: true })).toMatch(/test run \(WALNUT_TEST_RUN=ios-gate\)/)
    expect(deviceAddRefusal({ ...base, env, home: '/tmp/walnut-ephemeral-1/.open-walnut' })).toBeNull()
  })
})

describe('walnut device add', () => {
  const saved = { sid: process.env.WALNUT_SESSION_ID, run: process.env.WALNUT_TEST_RUN }
  beforeEach(() => { created.calls = []; process.exitCode = undefined; vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => {
    process.exitCode = undefined
    if (saved.sid === undefined) delete process.env.WALNUT_SESSION_ID; else process.env.WALNUT_SESSION_ID = saved.sid
    if (saved.run === undefined) delete process.env.WALNUT_TEST_RUN; else process.env.WALNUT_TEST_RUN = saved.run
    vi.restoreAllMocks()
  })

  it('from a session, against the real home, creates nothing and exits 1', async () => {
    process.env.WALNUT_SESSION_ID = 'sess-ui-gate'
    delete process.env.WALNUT_TEST_RUN
    await runDeviceAdd('tsios-gate', {} as never)
    expect(created.calls).toHaveLength(0)
    expect(process.exitCode).toBe(1)
    expect(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain(REAL_HOME)
  })

  it('from a session with --production, pairs', async () => {
    process.env.WALNUT_SESSION_ID = 'sess-ui-gate'
    delete process.env.WALNUT_TEST_RUN
    await runDeviceAdd('phone-1', {} as never, { production: true })
    expect(created.calls).toHaveLength(1)
  })
})
