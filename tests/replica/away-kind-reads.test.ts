/**
 * A replica answering without the Mac, with the sessions copy turned off for it (Settings):
 * the sessions' reads answer `503 needs_leader {why:'not_kept_here'}`, never this
 * replica's emptied store as "no sessions" (src/replica/away-kind-reads.ts; 4f of
 * docs/plan/walnut-companion-unified-replica.md). While the Mac answers (or the companion
 * stands in), with the sessions kept (the default), for a read that reads no session, and
 * for the replica's own session, every read passes to the routes.
 *
 * A real express app with the middleware mounted as server.ts mounts it (under /api);
 * the routes behind it are stand-ins that say they ran.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import type net from 'node:net'
import { awayKindReads, SESSIONS_NOT_KEPT } from '../../src/replica/away-kind-reads.js'

const state = { alone: true, off: new Set<string>(), offFails: false, own: new Set<string>() }
let port = 0
let server: http.Server

beforeAll(async () => {
  const app = express()
  app.use('/api', awayKindReads({
    alone: () => state.alone,
    off: async (kind) => { if (state.offFails) throw new Error('unreadable'); return state.off.has(kind) },
    own: async (sid) => state.own.has(sid),
  }))
  app.use('/api', (req, res) => { res.json({ ran: req.path }) })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as net.AddressInfo).port
})
afterAll(async () => { await new Promise((r) => server.close(r)) })
beforeEach(() => { state.alone = true; state.off = new Set(); state.offFails = false; state.own = new Set() })

async function call(p: string, method = 'GET'): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

const READS = ['/api/sessions', '/api/sessions/s-1', '/api/sessions/s-1/history', '/api/sessions/recent', '/api/sessions/status?ids=s-1', '/api/sessions/task/t-1', '/api/v1/sessions', '/api/v1/sessions/s-1/transcript']

describe('the sessions copy turned off, the replica alone', () => {
  it('every sessions read needs the Mac, in plain words', async () => {
    state.off.add('sessions')
    for (const p of READS) {
      const r = await call(p)
      expect([p, r.status, r.json?.error?.code, r.json?.error?.why]).toEqual([p, 503, 'needs_leader', 'not_kept_here'])
      expect(r.json.error.message).toBe(SESSIONS_NOT_KEPT)
    }
  })

  it('reads under /sessions that read no session, writes, and other paths pass to their routes', async () => {
    state.off.add('sessions')
    for (const p of ['/api/sessions/ask-walnut-launch', '/api/sessions/host-model-catalogs', '/api/sessions/list-dirs', '/api/sessions/working-dirs', '/api/v1/sessions/launch-options', '/api/tasks', '/api/sessionsx']) {
      expect([p, (await call(p)).json]).toEqual([p, { ran: p.slice('/api'.length) }])
    }
    expect((await call('/api/sessions/s-1/messages', 'POST')).json).toEqual({ ran: '/sessions/s-1/messages' })
  })

  it('the replica\'s own session reads pass; the list still needs the Mac', async () => {
    state.off.add('sessions')
    state.own.add('s-own')
    for (const p of ['/api/sessions/s-own', '/api/sessions/s-own/history', '/api/v1/sessions/s-own/transcript']) {
      expect([p, (await call(p)).status]).toEqual([p, 200])
    }
    expect((await call('/api/sessions/s-1')).status).toBe(503)
    expect((await call('/api/sessions')).status).toBe(503)
  })
})

describe('everything else passes', () => {
  it('the sessions kept (the default): the routes answer', async () => {
    for (const p of READS) expect([p, (await call(p)).status]).toEqual([p, 200])
  })

  it('the Mac answers (not alone): the routes answer, even with the sessions off', async () => {
    state.off.add('sessions')
    state.alone = false
    for (const p of READS) expect([p, (await call(p)).status]).toEqual([p, 200])
  })

  it('an unreadable off mark: the routes answer', async () => {
    state.offFails = true
    expect((await call('/api/sessions')).status).toBe(200)
  })
})
