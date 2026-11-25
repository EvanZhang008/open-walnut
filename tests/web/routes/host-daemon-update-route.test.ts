/**
 * POST /api/v1/hosts/:host/daemon-update (src/web/routes/host-exec-v1.ts): the body is optional,
 * as an older client sends none, and `over_busy` (a boolean) reaches the update as the asker's
 * words (core/hosts/host-daemon-update.ts). The update itself is faked at the module boundary.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-daemon-update-route'))

const asked = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../../../src/core/hosts/host-daemon-update.js', () => ({
  requestHostDaemonUpdate: async (...args: unknown[]) => {
    asked.calls.push(args)
    return { host: args[0], kind: 'ssh', phase: 'running' }
  },
}))
vi.mock('../../../src/core/hosts/host-exec.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sameMachineNote: async () => null,
}))

const { hostExecV1Router } = await import('../../../src/web/routes/host-exec-v1.js')
const app = express()
app.use(express.json())
app.use('/api/v1', hostExecV1Router)
const SID = { 'x-walnut-caller-sid': 's1' }

beforeEach(() => { asked.calls = [] })

describe('POST /api/v1/hosts/:host/daemon-update', () => {
  it('with no body (an older client) asks as before, waiting for the host\'s work', async () => {
    const res = await request(app).post('/api/v1/hosts/devbox/daemon-update').set(SID)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ host: 'devbox', phase: 'running' })
    expect(asked.calls).toEqual([['devbox', 's1', { overBusy: false }]])
  })

  it('over_busy: true reaches the update; false is the plain ask', async () => {
    await request(app).post('/api/v1/hosts/devbox/daemon-update').set(SID).send({ over_busy: true }).expect(200)
    await request(app).post('/api/v1/hosts/devbox/daemon-update').set(SID).send({ over_busy: false }).expect(200)
    expect(asked.calls).toEqual([['devbox', 's1', { overBusy: true }], ['devbox', 's1', { overBusy: false }]])
  })

  it('an over_busy that is not a boolean is refused before anything is asked', async () => {
    const res = await request(app).post('/api/v1/hosts/devbox/daemon-update').set(SID).send({ over_busy: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'bad_request' })
    expect(asked.calls).toEqual([])
  })
})

describe('the host_daemon_update op', () => {
  it('names over_busy in its input and its description, and sends it in the body', async () => {
    const { listOps, opInputJsonSchema } = await import('../../../src/ops/index.js')
    const op = (listOps() as Array<{ name: string; description: string; bind?: { method: string; path: string } }>).find((o) => o.name === 'host_daemon_update')!
    expect(op.bind).toEqual({ method: 'POST', path: '/hosts/:host/daemon-update' })
    const schema = opInputJsonSchema(op as never) as { properties: Record<string, { type?: string }>; required?: string[] }
    expect(schema.properties.over_busy).toMatchObject({ type: 'boolean' })
    expect(schema.required ?? []).not.toContain('over_busy')
    expect(op.description).toMatch(/over_busy: true/)
    expect(op.description).toMatch(/CLI sessions keep running and the next daemon adopts them/)
  })
})
