/**
 * /api/host-doors (src/web/routes/host-doors.ts): a person and a session may both revoke a host's
 * door and allow it again, and the record says who (`by`); a host with nothing to hold a revoke
 * on is told so; the answer never carries a key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-doors-route'))
// A session caller: the task of the session that asks (session-send-core.ts resolveCaller).
vi.mock('../../../src/core/sessions/session-send-core.js', () => ({
  resolveCaller: async (sid: string) => (sid === 'sid-of-t9' ? { kind: 'session', record: { taskId: 't9' } } : null),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { hostCredentialOf, mintHostCredential } from '../../../src/core/session-channel/host-credentials.js'
import { setRevokeStandbySync } from '../../../src/core/session-channel/leader-issue.js'
import { hostDoorsRouter } from '../../../src/web/routes/host-doors.js'
import { setRevokedHostResolver, setRevokedHosts } from '../../../src/core/session-channel/revoked-hosts.js'

const MACHINE = 'd4'.repeat(16)
const app = express().use(express.json()).use('/api/host-doors', hostDoorsRouter)

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  await fsp.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fsp.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  setRevokeStandbySync(async () => null)
})
afterEach(() => { setRevokeStandbySync(null); setRevokedHostResolver(null); setRevokedHosts([]) })

describe('/api/host-doors', () => {
  it('a session revokes, a person allows; each is recorded by who it was, and no key is ever answered', async () => {
    await mintHostCredential({ machineId: MACHINE, walnutId: 'w'.repeat(32), hostKey: 'devbox-a' })
    expect((await request(app).get('/api/host-doors/devbox-a')).body).toEqual({ hostKey: 'devbox-a', revoked: false, credentials: 1 })

    const rv = await request(app).post('/api/host-doors/devbox-a/revoke').set('x-walnut-caller-sid', 'sid-of-t9').send({})
    expect(rv.status).toBe(200)
    expect(rv.body).toMatchObject({ hostKey: 'devbox-a', revoked: true, by: 'task:t9', credentials: 0, closed: 1 })
    // What a revoke does not end is said, with how to end it (R2-S2).
    expect(rv.body.stillReaches.join(' ')).toMatch(/daemon link[\s\S]*remove the host from the config or turn it off/)
    // And what it ends, from the same table (revoked-reach.ts).
    expect(rv.body.refused.join(' ')).toMatch(/a new session aimed at it[\s\S]*its offline journal: held/)
    expect(JSON.stringify(rv.body)).not.toMatch(/verifyKey|[0-9a-f]{64}/)
    expect((await hostCredentialOf(MACHINE))?.revoked?.by).toBe('task:t9')

    const al = await request(app).post('/api/host-doors/devbox-a/allow').send({})
    expect(al.status).toBe(200)
    expect(al.body).toMatchObject({ hostKey: 'devbox-a', revoked: false, allowedNow: true, allowed: { by: 'human' } })
    // Allowed twice: nothing to do the second time.
    expect((await request(app).post('/api/host-doors/devbox-a/allow').send({})).body.allowedNow).toBe(false)
  })

  it('a revoke or allow that came through the host\'s own link is refused; through another host it is recorded with it (S3)', async () => {
    await mintHostCredential({ machineId: MACHINE, walnutId: 'w'.repeat(32), hostKey: 'devbox-a' })
    const rv = await request(app).post('/api/host-doors/devbox-a/revoke').set('x-walnut-origin', 'host:devbox-b').set('x-walnut-caller-sid', 'sid-of-t9').send({})
    expect(rv.status).toBe(200)
    expect(rv.body).toMatchObject({ revoked: true, by: 'task:t9 via host:devbox-b', standbySynced: true })
    // The revoked host's own sessions, relayed by its daemon: refused, whatever session they name.
    for (const sid of ['sid-of-t9', '']) {
      const al = await request(app).post('/api/host-doors/devbox-a/allow').set('x-walnut-origin', 'host:devbox-a').set('x-walnut-caller-sid', sid).send({})
      expect(al.status, sid).toBe(403)
      expect(al.body.code).toBe('own_host')
    }
    // An origin repeated (unknown) neither.
    expect((await request(app).post('/api/host-doors/devbox-a/allow').set('x-walnut-origin', ['host:devbox-b', 'host:devbox-c']).send({})).status).toBe(403)
    expect((await hostCredentialOf(MACHINE))?.revoked).toBeTruthy()
    // Another host's call with no session is an agent's, never a person's.
    const al = await request(app).post('/api/host-doors/devbox-a/allow').set('x-walnut-origin', 'host:devbox-b').send({})
    expect(al.body).toMatchObject({ allowedNow: true, allowed: { by: 'agent via host:devbox-b' } })
  })

  it('a ban is of the machine: revoked under one name, the other says so; never through the machine itself, under any name', async () => {
    await mintHostCredential({ machineId: MACHINE, walnutId: 'w'.repeat(32), hostKey: 'devbox-a' })
    // `devbox-a-net` is the same daemon's host-network row; `devbox-b`'s hello names the same machine.
    setRevokedHostResolver({ machineOf: (k) => (k === 'devbox-b' || k === 'devbox-a' ? MACHINE : null), aliasesOf: (k) => (k === 'devbox-a-net' ? ['devbox-a'] : k === 'devbox-a' ? ['devbox-a-net'] : []) })
    expect((await request(app).get('/api/host-doors/devbox-a-net')).body).toEqual({ hostKey: 'devbox-a-net', revoked: false, credentials: 1 })
    // Through the machine's other name: refused, as through its own.
    for (const via of ['host:devbox-a-net', 'host:devbox-b']) {
      expect((await request(app).post('/api/host-doors/devbox-a/revoke').set('x-walnut-origin', via).send({})).status, via).toBe(403)
    }
    const rv = await request(app).post('/api/host-doors/devbox-a-net/revoke').send({})
    expect(rv.body).toMatchObject({ hostKey: 'devbox-a-net', revoked: true, as: 'devbox-a', by: 'human', closed: 1 })
    expect((await request(app).get('/api/host-doors/devbox-b')).body).toMatchObject({ revoked: true, as: 'devbox-a' })
    expect((await request(app).post('/api/host-doors/devbox-a-net/allow').set('x-walnut-origin', 'host:devbox-b').send({})).status).toBe(403)
    expect((await request(app).post('/api/host-doors/devbox-b/allow').send({})).body).toMatchObject({ allowedNow: true, revoked: false })
    expect((await hostCredentialOf(MACHINE))?.revoked).toBeUndefined()
  })

  it('a host that holds no credential and has not linked: 404, nothing written; a bad host key: 400', async () => {
    const r = await request(app).post('/api/host-doors/nowhere/revoke').send({})
    expect(r.status).toBe(404)
    expect(r.body.code).toBe('no_door_credential')
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect((await request(app).post('/api/host-doors/bad%20key/revoke').send({})).status).toBe(400)
  })
})
