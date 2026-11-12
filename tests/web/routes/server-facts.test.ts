/**
 * What a server says it is (src/web/server-facts.ts): GET /api/v1/status and
 * GET /api/config carry `role`, `placement`, `serverCapabilities` and `leader`
 * beside the `cloud` and `mode` fields older clients read, on the Mac, on a host
 * replica and on the companion. A host replica answering alone (the Mac away)
 * says `mode: 'REPLICA'`, never 'LIVE' (it used to read as the Mac), and its own
 * paths and desktop are not offered as the Mac's. GET /api/leader on a replica
 * names the replica, never `role: 'primary'`.
 *
 * Real routers on a bare express app; constants point at a temp home, and
 * CLOUD_MODE is flipped between cases (the role facts are reset with it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const box = vi.hoisted(() => ({ cloud: false }))
vi.mock('../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../helpers/mock-constants.js')
  return { ...createMockConstants('walnut-server-facts'), get CLOUD_MODE() { return box.cloud } }
})

import express from 'express'
import request from 'supertest'
import { apiV1Router } from '../../../src/web/routes/api-v1.js'
import { configRouter } from '../../../src/web/routes/config.js'
import { leaderRouter } from '../../../src/web/routes/leader.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import {
  _resetLeaderPresenceForTesting, _resetServerRoleForTesting, setLeaderPresence,
} from '../../../src/core/server-role.js'
import { _setCloudChatCliProbeForTesting } from '../../../src/web/routes/cloud-chat-fallback.js'

const ENV_KEYS = ['WALNUT_ROLE', 'WALNUT_HOST_SERVER', 'WALNUT_PLACEMENT', 'WALNUT_CAPABILITIES'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', apiV1Router)
  a.use('/api/config', configRouter)
  a.use('/api', leaderRouter)
  a.use(errorHandler)
  return a
}

function become(where: 'mac' | 'host' | 'cloud'): void {
  for (const k of ENV_KEYS) delete process.env[k]
  box.cloud = where === 'cloud'
  if (where === 'host') process.env.WALNUT_ROLE = 'replica'
  _resetServerRoleForTesting()
  _resetLeaderPresenceForTesting()
}

beforeEach(() => { _setCloudChatCliProbeForTesting(() => false) })
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  box.cloud = false
  _resetServerRoleForTesting()
  _resetLeaderPresenceForTesting()
  _setCloudChatCliProbeForTesting(null)
})

describe('GET /api/v1/status', () => {
  it('the Mac: LIVE, the leader that answers, no capability', async () => {
    become('mac')
    const { body } = await request(app()).get('/api/v1/status').expect(200)
    expect(body).toMatchObject({
      mode: 'LIVE', cloud: false, role: 'leader', placement: 'mac', serverCapabilities: [],
      leader: { answers: true, why: 'leader', since: 0 },
    })
    // The v1 feature list keeps its name and meaning.
    expect(body.capabilities).toContain('asks')
    expect(body).not.toHaveProperty('bridgeHosts')
    expect(body).not.toHaveProperty('daemonTunnel')
  })

  it('a host replica answering alone says REPLICA (not the Mac), and whether its leader answers', async () => {
    become('host')
    const away = (await request(app()).get('/api/v1/status').expect(200)).body
    expect(away).toMatchObject({
      mode: 'REPLICA', cloud: false, role: 'replica', placement: 'host', serverCapabilities: [],
      leader: { answers: false, why: 'not-heard' },
    })
    // No companion-only fields: a phone must not read "the cloud server may answer".
    for (const k of ['bridgeHosts', 'cloudExec', 'daemonTunnel', 'cloudChat']) expect(away).not.toHaveProperty(k)
    setLeaderPresence(true, 'link-up', 1_750_000_000_000)
    const back = (await request(app()).get('/api/v1/status').expect(200)).body
    expect(back.leader).toEqual({ answers: true, why: 'answers', since: 1_750_000_000_000 })
  })

  it('the companion: REPLICA and cloud as before, with its four capabilities and its doors', async () => {
    become('cloud')
    const { body } = await request(app()).get('/api/v1/status').expect(200)
    expect(body).toMatchObject({
      mode: 'REPLICA', cloud: true, role: 'replica', placement: 'cloud',
      serverCapabilities: ['public-door', 'bridge-door', 'cloud-exec', 'backup-leader'],
      leader: { answers: false },
      bridgeHosts: [],
      cloudExec: { enabled: false, reason: 'not_enabled' },
      daemonTunnel: { enabled: false, reason: 'not_enabled' },
      cloudChat: 'unavailable',
    })
  })

  it('a companion with only the bridge door keeps the daemon tunnel field and says why it is off', async () => {
    become('cloud')
    process.env.WALNUT_CAPABILITIES = 'bridge-door'
    const { body } = await request(app()).get('/api/v1/status').expect(200)
    expect(body.serverCapabilities).toEqual(['bridge-door'])
    expect(body.daemonTunnel).toEqual({ enabled: false, reason: 'not_cloud_mode' })
    expect(body).not.toHaveProperty('cloudExec')
    expect(body).not.toHaveProperty('cloudChat')
  })
})

describe('GET /api/config', () => {
  it('carries the same facts; a host replica offers no paths or desktop of its own', async () => {
    become('mac')
    const mac = (await request(app()).get('/api/config').expect(200)).body
    expect(mac).toMatchObject({ cloud: false, role: 'leader', placement: 'mac', serverCapabilities: [], leader: { answers: true, why: 'leader' } })
    expect(typeof mac.installDir === 'string' || mac.installDir === null).toBe(true)
    expect(mac.canRevealLocalFiles).toBe(process.platform === 'darwin')

    become('host')
    const host = (await request(app()).get('/api/config').expect(200)).body
    expect(host).toMatchObject({
      cloud: false, role: 'replica', placement: 'host', serverCapabilities: [], leader: { answers: false },
      installDir: null, notesDir: null, canRevealLocalFiles: false,
    })

    become('cloud')
    const cloud = (await request(app()).get('/api/config').expect(200)).body
    expect(cloud).toMatchObject({ cloud: true, role: 'replica', placement: 'cloud', installDir: null, notesDir: null, canRevealLocalFiles: false })
    expect(cloud.serverCapabilities).toHaveLength(4)
  })
})

describe('GET /api/leader', () => {
  it('a host replica names itself a replica with its leader presence, never the primary', async () => {
    become('host')
    const { body } = await request(app()).get('/api/leader').expect(200)
    expect(body.role).toBe('replica')
    expect(body.leader).toMatchObject({ answers: false })
    expect(body).not.toHaveProperty('hosts')
    expect(body).not.toHaveProperty('forward')
  })

  it('the companion stays `backup` with its forward status; the Mac stays `primary`', async () => {
    become('cloud')
    const cloud = (await request(app()).get('/api/leader').expect(200)).body
    expect(cloud.role).toBe('backup')
    expect(cloud).toHaveProperty('forward')
    become('mac')
    const mac = (await request(app()).get('/api/leader').expect(200)).body
    expect(mac.role).toBe('primary')
    expect(typeof mac.hosts).toBe('object')
  })
})
