/**
 * The dispatcher and this host's own `walnut` calls (dispatch.ts `selfCall`, the
 * `host-local-calls` capability): such a request carries the replica's in-process credential,
 * so it is answered here whoever leads, under its row's `localAway`, and never forwarded; a
 * daemon that says the Mac answers gets `needs_leader` back. A phone on the same routes keeps
 * its answers: the start and message rows are needs_leader for it, as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type net from 'node:net'
import { createDispatcher, type DispatchDeps } from '../../src/replica/dispatch.js'

const servers: http.Server[] = []
let connects = 0
let opAnswer: Record<string, unknown> = { ok: true, seq: 1 }
/** Answers taken first, one per try: an Error is a lost answer (the try reached the daemon). */
const firstAnswers: Array<Record<string, unknown> | Error> = []
const nextAnswer = async (): Promise<Record<string, unknown>> => {
  const a = firstAnswers.shift()
  if (a instanceof Error) throw a
  return a ?? opAnswer
}

async function serve(route: DispatchDeps['route']): Promise<number> {
  const deps: DispatchDeps = {
    route,
    asOf: () => 1,
    connect: async () => { connects++; throw new Error('never forwarded in these cases') },
    suspect: () => {},
    ownUpgrade: (_req, socket) => { socket.end() },
    log: () => {},
    followerOp: nextAnswer,
    followerCall: nextAnswer,
    followerOpCap: () => true,
    authorized: (req) => req.headers.authorization === 'Bearer device' || req.headers.authorization === 'Bearer self',
    selfCall: (req) => req.headers.authorization === 'Bearer self',
  }
  const dispatcher = createDispatcher(deps)
  const server = http.createServer((req, res) => dispatcher.middleware(req, res, async () => {
    // The replica's own route: a write runs through its replicaWrite.
    const w = req.replicaWrite
    if (!w) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"here":true}'); return }
    const r = await w.submit('task_update', { id: 't1' })
    if (r.kind === 'answered') return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ away: w.away, result: r.kind }))
  }))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return (server.address() as net.AddressInfo).port
}

function call(port: number, method: string, p: string, token: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(method === 'GET' ? undefined : '{}')
  })
}

let away = 0
let leads = 0
beforeAll(async () => {
  away = await serve(() => ({ kind: 'alone', why: 'mac-away' }))
  leads = await serve(() => ({ kind: 'leader' }))
})
afterAll(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))) })

describe('this host\'s own calls in the dispatcher', () => {
  it('the start and message rows: a local write for the host\'s call, needs_leader for a phone, as before', async () => {
    for (const p of ['/api/v1/tasks/t1/start', '/api/v1/messages']) {
      expect(await call(away, 'POST', p, 'self')).toEqual({ status: 200, json: { away: 'host-write', result: 'applied' } })
      const phone = await call(away, 'POST', p, 'device')
      expect(phone.status).toBe(503)
      expect(phone.json.error).toMatchObject({ code: 'needs_leader', why: 'mac-away' })
    }
  })

  it('never forwarded, whoever leads: answered here under its row', async () => {
    connects = 0
    expect(await call(leads, 'PATCH', '/api/v1/tasks/t1', 'self')).toEqual({ status: 200, json: { away: 'host-write', result: 'applied' } })
    expect(await call(leads, 'GET', '/api/v1/tasks/t1', 'self')).toEqual({ status: 200, json: { here: true } })
    expect(connects).toBe(0)
  })

  it('the daemon says the Mac answers: needs_leader back, the daemon relays it there itself', async () => {
    opAnswer = { ok: false, errorKind: 'leader_answers', error: 'the Mac answers' }
    try {
      connects = 0
      const r = await call(away, 'PATCH', '/api/v1/tasks/t1', 'self')
      expect(r.status).toBe(503)
      expect(r.json.error).toMatchObject({ code: 'needs_leader', why: 'leader_answers' })
      expect(connects).toBe(0)
    } finally {
      opAnswer = { ok: true, seq: 1 }
    }
  })

  // The Mac came back in the middle of a local call: its first try was journaled but its answer
  // was lost. A needs_leader now would send the whole call to the Mac (gateway-answer.ts lifts
  // it) while the journaled copy drains too: two tasks, or two sessions.
  it('the Mac returns after a lost answer: unsure, never handed to the Mac', async () => {
    for (const p of ['/api/v1/tasks/t1', '/api/v1/tasks/t1/start']) {
      firstAnswers.push(new Error('follower.op timed out'), { ok: false, errorKind: 'leader_answers', error: 'the Mac answers' })
      connects = 0
      const r = await call(away, p.endsWith('/start') ? 'POST' : 'PATCH', p, 'self')
      expect(r.status).toBe(503)
      expect(r.json.error).toMatchObject({ code: 'leader_unsure', why: 'lost_answer' })
      expect(connects).toBe(0)
      expect(firstAnswers).toEqual([])
    }
    // The daemon says the lost try never ran (opPending false): then the Mac takes it.
    firstAnswers.push(new Error('follower.op timed out'), { ok: false, errorKind: 'leader_answers', opPending: false, error: 'the Mac answers' })
    const r = await call(away, 'PATCH', '/api/v1/tasks/t1', 'self')
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why: 'leader_answers' })
  })
})
