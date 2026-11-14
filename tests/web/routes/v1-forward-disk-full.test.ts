/**
 * A full disk on the companion refuses only the writes that land on it (src/web/middleware/disk-guard.ts
 * deferDiskGuardTo, src/web/v1-forward/proxy.ts takesWrite). 2026-11-14: the companion's disk reached
 * 95%, and a phone's signed Face ID answer to an approval got 507 three times and never reached the
 * Mac, which had room. A write the forward carries to the Mac passes; one answered here is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

let blocked = true
vi.mock('../../../src/core/disk-watermark.js', () => ({
  isDiskWriteBlocked: () => blocked,
  getDiskWatermarkState: () => ({ level: 'critical', usedPct: 95 }),
}))

const { diskGuardMiddleware, deferDiskGuardTo } = await import('../../../src/web/middleware/disk-guard.js')
const { createV1Forward } = await import('../../../src/web/v1-forward/proxy.js')

const NOW = 1_800_000_000_000
function harness(macUp: boolean) {
  const calls: unknown[] = []
  const fwd = createV1Forward({
    now: () => NOW,
    enabled: () => true,
    primary: async () => (macUp ? { bridge: true, heard: true, lastSeenAt: NOW - 5_000, leading: 0, backupAllowed: true, takeoverMs: 60_000 } : null),
    call: async (params) => {
      calls.push(params)
      const buf = Buffer.from(JSON.stringify({ from: 'mac' }))
      return { ok: true, result: { status: 200, headers: { 'content-type': 'application/json' }, size: buf.byteLength, data: buf.toString('base64') } }
    },
  })
  const app = express()
  app.use(express.json())
  app.use('/api', diskGuardMiddleware)
  app.use('/api/v1', fwd.middleware)
  // The companion's own routes: reaching one means the write landed here.
  app.all('/api/*rest', (_req, res) => { res.status(200).json({ from: 'companion' }) })
  deferDiskGuardTo(fwd.takesWrite)
  return { app, calls }
}

beforeEach(() => { blocked = true; deferDiskGuardTo(null) })

describe('the companion with a critically full disk', () => {
  const answer = { decision: 'approve', keyId: 'ak-0123456789abcdef', signature: 'c2ln', device: { name: 'iPhone', kind: 'iphone' } }

  it('carries a phone\'s approval answer to the Mac that answers', async () => {
    const h = harness(true)
    const res = await request(h.app).post('/api/v1/approvals/apr-C_Ax-e-QNHlo/answer').send(answer)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ from: 'mac' })
    expect(h.calls).toHaveLength(1)
  })

  it('refuses the same answer when the Mac is away and it would be written here', async () => {
    const h = harness(false)
    const res = await request(h.app).post('/api/v1/approvals/apr-C_Ax-e-QNHlo/answer').send(answer)
    expect(res.status).toBe(507)
    expect(res.body.code).toBe('disk_full')
    expect(h.calls).toHaveLength(0)
  })

  it('refuses a write the companion keeps for itself, Mac up or not', async () => {
    const h = harness(true)
    expect((await request(h.app).post('/api/v1/sessions/s-1/messages').send({ text: 'hi' })).status).toBe(507)
    // Off the forward (a console route the forward never takes): the guard as before.
    expect((await request(h.app).post('/api/notes').send({})).status).toBe(507)
    expect(h.calls).toHaveLength(0)
  })

  it('with no forward registered (the Mac itself), every write here is refused as before', async () => {
    const app = express()
    app.use('/api', diskGuardMiddleware)
    app.all('/api/*rest', (_req, res) => { res.status(200).end() })
    expect((await request(app).post('/api/v1/approvals/apr-1/answer').send({})).status).toBe(507)
  })

  it('a disk with room lets every write through, forwarded or here', async () => {
    blocked = false
    const h = harness(false)
    expect((await request(h.app).post('/api/v1/approvals/apr-1/answer').send(answer)).body).toEqual({ from: 'companion' })
  })
})
