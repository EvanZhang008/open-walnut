/**
 * trigger_test waits as long as the check it runs may take (src/ops/triggers.ts, executor.ts).
 *
 * 2026-11-08: the CLI gave every op 10 s, so a check with a 280 s limit could not be tested at
 * all. The op's deadline now reads its args; this pins that the executor uses it, and that it
 * covers every limit the daemon allows, twice (the one retry after a dropped link).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeOp } from '../../../src/ops/executor.js'
import { getOp } from '../../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import { TIME_LIMIT_MAX_S, testRunDeadlineMs } from '../../../src/core/cron/trigger-time-limit.js'
import { withAnswerBy } from '../../../src/lib/answer-by.js'

let server: http.Server
let base = ''
const ANSWER_AFTER_MS = 400
const answerByHeaders: unknown[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    answerByHeaders.push(req.headers['x-walnut-answer-by'])
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: { parsed: { fire: false }, wouldFire: false, durationMs: 300 }, timeLimit: { seconds: 30, line: 'ran 0.3 s of its 30 s limit' } }))
    }, ANSWER_AFTER_MS)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('trigger_test\'s deadline', () => {
  it('reads the check\'s own limit, and covers two runs of it for every limit the daemon allows', () => {
    const fn = getOp('trigger_test')!.timeoutMs
    expect(typeof fn).toBe('function')
    for (let limit = 1; limit <= TIME_LIMIT_MAX_S; limit++) {
      const ms = (fn as (a: Record<string, unknown>) => number)({ run: 'x', timeoutSeconds: limit })
      expect(ms).toBeGreaterThan(2 * testRunDeadlineMs(limit))
    }
    // A 280 s check: the 10 s default could never see it end.
    expect((fn as (a: Record<string, unknown>) => number)({ run: 'x', timeoutSeconds: 280 })).toBeGreaterThan(570_000)
  })

  it('the executor uses an op\'s deadline function with the call\'s args', async () => {
    const op = getOp('trigger_test')!
    const real = op.timeoutMs
    const seen: unknown[] = []
    try {
      op.timeoutMs = (args) => { seen.push(args.timeoutSeconds); return 100 }
      const cut = await executeOp('trigger_test', { run: 'bash x.sh', timeoutSeconds: 7 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
      expect(cut.ok).toBe(false)
      expect((cut as { message: string }).message).toContain('timed out after 100ms')
      expect(seen).toEqual([7])
      op.timeoutMs = () => ANSWER_AFTER_MS * 5
      const ok = await executeOp('trigger_test', { run: 'bash x.sh' }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
      expect(ok.ok).toBe(true)
      expect((ok as { result: { outcome: string } }).result.outcome).toContain('It ran 0.3 s of its 30 s limit.')
    } finally {
      op.timeoutMs = real
    }
  })

  it('a call relayed through a host\'s gateway hands its deadline to the route, which answers pending before it', async () => {
    // The gateway runs the op inside withAnswerBy(arrival + its relay timeout) (daemon-connection.ts).
    answerByHeaders.length = 0
    const at = Date.now() + 20_000
    const out = await withAnswerBy(at, () => executeOp('trigger_test', { run: 'bash x.sh', timeoutSeconds: 280 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' }))
    expect(out.ok).toBe(true)
    expect(answerByHeaders).toEqual([String(at)])
  })
})
