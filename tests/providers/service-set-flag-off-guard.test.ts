/**
 * Guard for review round 1, B7, through the connection's own update path: after a host's move into
 * this Walnut's service set, turning the experiment host_service_sets off never makes this leader
 * update the default service there, which is the other Walnut's. Its update lines keep naming this
 * Walnut (`--walnut`), and a link that reaches the shared daemon updates nothing.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-set-flag-off-guard'))
const WALNUT = '0123456789abcdef0123456789abcdef'
vi.mock('../../src/core/device-auth.js', async (orig) => ({ ...(await orig<object>()), getInstanceId: async () => WALNUT }))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { hostServiceSets } from '../../src/providers/service-set-leader.js'
import type { ServiceTakeover } from '../../src/providers/local-daemon.js'

const SET = WALNUT.slice(0, 16)
type Conn = {
  _connected: boolean
  _helloServiceSet: string
  _remoteSet: string
  serviceSetLink: { check: () => Promise<void>; setAsk: () => Promise<unknown> } | null
  sshExec: (c: string) => Promise<string>
  updateManagedDaemon: (t: ServiceTakeover, expected: string) => Promise<boolean | 'held'>
  serviceSetUpdateWords: (set: string) => Promise<{ walnut?: { walnutId: string } }>
}

describe('B7 guard: the experiment off after a move never updates the other Walnut\'s service', () => {
  let dir = ''
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-flag-off-'))
    for (const k of ['WALNUT_HOST_SERVICE_SETS', 'WALNUT_SERVICE_SET_FILE', 'WALNUT_SERVICE_SET_MOVE_FILE']) saved[k] = process.env[k]
    process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
    process.env.WALNUT_SERVICE_SET_MOVE_FILE = path.join(dir, 'moves.json')
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function moved() {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'tester' })
    const c = conn as unknown as Conn
    c._connected = true
    const ran: string[] = []
    vi.spyOn(c, 'sshExec').mockImplementation(async (cmd: string) => { ran.push(cmd); return '{"ok":true}' })
    const link = c.serviceSetLink
    expect(link).not.toBe(null)
    const looks = vi.spyOn(link!, 'check').mockResolvedValue(undefined)
    return { conn, c, ran, looks }
  }

  it('a link that reaches the shared daemon (hello names the default) updates nothing there', async () => {
    await hostServiceSets.write('ssh:devbox', { at: Date.now(), set: SET, runtimeDir: `/home/tester/.open-walnut-host/walnuts/${SET}/rt`, movedAt: Date.now() })
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    const { c, ran, looks } = moved()
    c._helloServiceSet = ''
    const takeover: ServiceTakeover = { managed: true, present: ['$HOME/.config/systemd/user/open-walnut-daemon.service'], unknown: [] } as ServiceTakeover
    expect(await c.updateManagedDaemon(takeover, 'v2')).toBe(false)
    expect(ran).toEqual([])
    // It looks again for its own set instead.
    expect(looks).toHaveBeenCalled()
  })

  it('on its own set\'s daemon every update line still names this Walnut', async () => {
    await hostServiceSets.write('ssh:devbox', { at: Date.now(), set: SET, runtimeDir: '/r', movedAt: Date.now() })
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    const { c } = moved()
    c._helloServiceSet = SET
    expect((await c.serviceSetUpdateWords(SET)).walnut?.walnutId).toBe(WALNUT)
  })

  it('a host that never moved takes today\'s path with the experiment off (no --walnut)', async () => {
    await hostServiceSets.write('ssh:devbox', { at: Date.now(), set: SET, runtimeDir: '/r' })
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    const { c } = moved()
    expect(await c.serviceSetUpdateWords('')).toEqual({})
  })
})
