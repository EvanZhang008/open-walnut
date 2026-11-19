/**
 * An API refusal that says when to try again (its error's `retryAfter`, seconds: a host's full
 * journal, its live session brake) keeps that wait in the op's outcome (src/ops/executor.ts),
 * so a relayed call's caller hears it (capability-router.ts, gateway-answer.ts) instead of a
 * bare error it might retry in a loop.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeOp } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import '../../../src/ops/index.js'

let server: http.Server
let base = ''
let answer: { status: number; body: unknown } = { status: 503, body: {} }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"task":{"id":"t1"}}'); return }
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const run = () => executeOp('task_update', { id: 't1', title: 'x' }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })

describe('an API refusal\'s wait', () => {
  it('is kept in ms with its code, for a full journal and for the brake', async () => {
    for (const [status, code] of [[503, 'queue_full'], [429, 'throttled']] as const) {
      answer = { status, body: { error: { code, message: 'this host already holds 5000 records', retryAfter: 60 } } }
      const out = await run()
      expect(out).toMatchObject({ ok: false, status, code, retryAfterMs: 60_000 })
    }
  })

  it('is absent when the answer names none or a junk one, and capped at an hour', async () => {
    answer = { status: 503, body: { error: { code: 'queue_full', message: 'full' } } }
    expect(await run()).not.toHaveProperty('retryAfterMs')
    answer = { status: 503, body: { error: { code: 'queue_full', message: 'full', retryAfter: 'soon' } } }
    expect(await run()).not.toHaveProperty('retryAfterMs')
    answer = { status: 503, body: { error: { code: 'queue_full', message: 'full', retryAfter: 1e9 } } }
    expect(await run()).toMatchObject({ retryAfterMs: 3_600_000 })
  })
})
