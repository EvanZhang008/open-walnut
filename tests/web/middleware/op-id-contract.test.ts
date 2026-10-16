/**
 * The op-id contract between the three writers and the Mac's middleware
 * (docs/plan/walnut-replica-servers-impl.md section 3): the web client's op ids
 * (web/src/api/op-id.ts), the host replica's forward (src/replica/dispatch.ts, its
 * x-walnut-forwarded-at stamp on the host's clock) and the middleware that judges them
 * (src/web/middleware/op-id.ts), plus where src/web/server.ts mounts the middleware.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as server from '../../../src/web/middleware/op-id.js'
import * as replica from '../../../src/replica/dispatch.js'
import * as web from '../../../web/src/api/op-id.js'
import { _setLedgerFileForTesting } from '../../../src/core/offline-merge/ledger.js'
import { _resetHostClocksForTesting, hostClockOffset, measureHostClock } from '../../../src/core/offline-merge/host-clock.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-op-id-contract-'))
let srv: Server
let base = ''
let applied = 0

beforeAll(async () => {
  _setLedgerFileForTesting(path.join(tmp, 'ledger.sqlite'))
  const a = express()
  a.use(server.stampArrival())
  a.use(express.json())
  a.use('/api', server.opIdMiddleware({ home: '/data/walnut-contract', hostKeyOf: () => 'marina-box' }))
  a.post('/api/tasks', (_req, res) => { applied++; res.status(201).json({ n: applied }) })
  srv = a.listen(0, '127.0.0.1')
  await new Promise<void>((r) => srv.once('listening', () => r()))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})

afterAll(async () => {
  _setLedgerFileForTesting(null)
  _resetHostClocksForTesting()
  await new Promise<void>((r) => srv.close(() => r()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const post = (headers: Record<string, string>): Promise<Response> =>
  fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })

describe('op-id contract', () => {
  it('the client, the replica and the Mac name the same two headers', () => {
    expect(web.OP_ID_HEADER).toBe(server.OP_ID_HEADER)
    expect(replica.OP_ID_HEADER).toBe(server.OP_ID_HEADER)
    expect(replica.FORWARDED_AT_HEADER).toBe(server.FORWARDED_AT_HEADER)
  })

  it('an id the web client mints and one the replica mints are taken as they are, by the replica and by the Mac', async () => {
    for (const id of [web.mintOpId(), replica.mintOpId()]) {
      expect(id).toMatch(/^op-[0-9a-f]{16}$/)
      const req = { headers: { [replica.OP_ID_HEADER]: id } } as never
      expect(replica.ensureOpId(req)).toBe(id)
      const res = await post({ [server.OP_ID_HEADER]: id })
      expect(res.status).toBe(201)
      // The same id again is the same write: answered, not applied twice.
      const again = await post({ [server.OP_ID_HEADER]: id })
      expect([again.status, again.headers.get('x-walnut-op-replayed')]).toEqual([201, '1'])
    }
    expect(applied).toBe(2)
  })

  it("the forwarded-at stamp is the host's clock, judged with the offset measured on the daemon link", async () => {
    _resetHostClocksForTesting()
    // The host runs 50 s behind this Mac: its daemon (and the replica beside it) read Date.now() - 50 s.
    const hostNow = (): number => Date.now() - 50_000
    const sent = Date.now()
    measureHostClock('marina-box', sent, sent, hostNow())
    expect(Math.abs((hostClockOffset('marina-box') ?? 0) - 50_000)).toBeLessThan(100)
    const fresh = await post({ [server.OP_ID_HEADER]: replica.mintOpId(), [server.FORWARDED_AT_HEADER]: String(hostNow()) })
    expect(fresh.status).toBe(201)
    const stale = await post({ [server.OP_ID_HEADER]: replica.mintOpId(), [server.FORWARDED_AT_HEADER]: String(hostNow() - server.STALE_FORWARD_MS - 5_000) })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('stale_forward')
  })

  it('server.ts stamps arrival before every body parser, and runs the op-id middleware after auth', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/web/server.ts'), 'utf8')
    const at = (needle: string): number => {
      const i = src.indexOf(needle)
      expect(i, needle).toBeGreaterThan(-1)
      return i
    }
    const stamp = at("(await import('./middleware/op-id.js')).stampArrival()")
    for (const parser of ['express.json(', 'express.raw(', 'express.urlencoded(', 'boardJsonParser)']) {
      const i = src.indexOf(parser)
      if (i !== -1) expect(stamp, parser).toBeLessThan(i)
    }
    const auth = at("app.use('/api', authMiddleware)")
    expect(at("app.use('/api', opIdMiddleware())")).toBeGreaterThan(auth)
  })
})
