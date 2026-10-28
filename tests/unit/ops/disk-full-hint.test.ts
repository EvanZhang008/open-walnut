/**
 * A 507 (the server's disk guard: its data disk is full) tells the agent it is the machine, not its
 * work, and how to report it (src/ops/executor.ts DISK_FULL_HINT). 2026-10-28: agents that hit it
 * asked the user to free space, and their tasks read Needs you.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeOp, DISK_FULL_HINT } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import '../../../src/ops/index.js'

let server: http.Server
let base = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"task":{"id":"t1"}}'); return }
    res.writeHead(507, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Data disk is critically full (99% used). Free disk space on the server, then retry.', code: 'disk_full', usedPct: 99 }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('a 507 from the disk guard', () => {
  it('tells the agent to report waiting on the machine, never to ask the user', async () => {
    const out = await executeOp('task_update', { id: 't1', title: 'x' }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(out.ok).toBe(false)
    const message = (out as { message: string }).message
    expect(message).toContain('Walnut API error (507): Data disk is critically full')
    expect(message.endsWith(DISK_FULL_HINT)).toBe(true)
    expect(DISK_FULL_HINT).toContain('FOR_USER_WAITING_ON: machine')
    expect(DISK_FULL_HINT).toContain('do not ask the user')
  })
})
