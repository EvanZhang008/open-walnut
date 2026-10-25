import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants())
vi.mock('../../../src/web/server.js', () => ({ getSystemHealth: () => ({}) }))
const send = vi.fn()
const capability = vi.fn(() => true)
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonPoolStatus: () => [], getConnectedDaemonConnection: () => ({ hasCapability: capability, send }),
}))
vi.mock('../../../src/web/routes/expose.js', () => ({ isPersonAtThisMachine: (req: express.Request) => req.get('x-test-person') === 'yes' }))
const { systemRouter } = await import('../../../src/web/routes/system.js')
const app = express().use(express.json()).use('/api/system', systemRouter)

beforeEach(() => { send.mockReset(); capability.mockReturnValue(true) })

describe.skipIf(process.platform !== 'darwin')('desktop installed update API', () => {
  it('relays status through one deadline-bounded local daemon call', async () => {
    send.mockResolvedValue({ ok: true, available: true, token: '12:old:new', version: '1.0', windows: 2 })
    const res = await request(app).get('/api/system/desktop-update?notice=1').set('x-test-person', 'yes')
    expect(res.body).toMatchObject({ available: true, token: '12:old:new', windows: 2 })
    expect(send).toHaveBeenCalledWith('desktop.updateStatus', {}, 7000)
  })
  it('tells a page from before the bottom notice nothing, so its sidebar item never shows', async () => {
    send.mockResolvedValue({ ok: true, available: true, token: '12:old:new', version: '1.0' })
    const res = await request(app).get('/api/system/desktop-update').set('x-test-person', 'yes')
    expect(res.body.available).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  it('passes force only as a real boolean', async () => {
    send.mockResolvedValue({ ok: true, accepted: true })
    await request(app).post('/api/system/desktop-update/restart').set('x-test-person', 'yes').send({ token: 'new', force: true }).expect(202)
    expect(send).toHaveBeenLastCalledWith('desktop.restart', { token: 'new', force: true }, 7000)
    await request(app).post('/api/system/desktop-update/restart').set('x-test-person', 'yes').send({ token: 'new', force: 'true' }).expect(202)
    expect(send).toHaveBeenLastCalledWith('desktop.restart', { token: 'new', force: false }, 7000)
  })
  it('does not expose or restart to remote/device/session callers', async () => {
    const status = await request(app).get('/api/system/desktop-update?notice=1')
    expect(status.body.available).toBe(false)
    await request(app).post('/api/system/desktop-update/restart').send({ token: '12:old:new' }).expect(403)
    expect(send).not.toHaveBeenCalled()
  })
  it('requires a token, refuses changed installs, and reports acceptance not completion', async () => {
    await request(app).post('/api/system/desktop-update/restart').set('x-test-person', 'yes').send({}).expect(400)
    send.mockResolvedValue({ ok: true, accepted: false })
    await request(app).post('/api/system/desktop-update/restart').set('x-test-person', 'yes').send({ token: 'old' }).expect(409)
    send.mockResolvedValue({ ok: true, accepted: true })
    const r = await request(app).post('/api/system/desktop-update/restart').set('x-test-person', 'yes').send({ token: 'new' }).expect(202)
    expect(r.body).toEqual({ accepted: true })
  })
  it('degrades quietly when daemon capability is absent', async () => {
    capability.mockReturnValue(false)
    expect((await request(app).get('/api/system/desktop-update?notice=1').set('x-test-person', 'yes')).body.available).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
