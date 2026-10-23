/**
 * `scripts/walnut-logs.sh replica --host <alias>` (WP14, section 13 of
 * docs/plan/walnut-replica-servers-impl.md) and the route behind its host-side
 * lines (GET /api/replicas/logs, the daemon's logs.tail).
 *
 * The script and its helper (scripts/replica-logs-fetch.mjs) run for real, over a
 * temp log dir of Mac lines; the "Mac's server" is the real router in a small
 * express app on a random port (never 3456), whose pooled connection to the host
 * is the one stand-in (the daemon's logs.tail itself is
 * tests/integration/replica-logs-twins.test.ts).
 *
 * Invariants:
 *   - each section reads its line by name: presence changes, forwards by outcome,
 *     away answers, journal appends, drains, conflicts, letters, copy rounds;
 *   - only lines of the asked host are counted (another host's drain is not);
 *   - a host that is not connected, or a daemon without the cap, is said so,
 *     and the Mac's own lines still print.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-logs-replica', { CLOUD_MODE: false }))

import { replicasStatusRouter } from '../../src/web/routes/replicas-status.js'
import { setPooledConnectionForTest, type DaemonConnection } from '../../src/providers/daemon-connection.js'
import { WALNUT_HOME } from '../../src/constants.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts/walnut-logs.sh')
let server: Server | null = null
let port = 0
let logDir = ''
const asked: Array<Record<string, unknown>> = []

const at = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString()
const j = (o: Record<string, unknown>) => JSON.stringify(o)

/** The host's lines as logs.tail answers them (the replica's and the daemon's own shapes). */
const HOST_LINES = [
  { source: 'replica', file: 'open-walnut-x.log', line: j({ time: at(1), level: 'info', subsystem: 'web', message: 'replica presence', answers: false, why: 'quiet' }) },
  { source: 'replica', file: 'open-walnut-x.log', line: j({ time: at(2), level: 'info', subsystem: 'web', message: 'replica forward', outcome: 'answered', write: false, ms: 10, bytes: 100 }) },
  { source: 'replica', file: 'open-walnut-x.log', line: j({ time: at(3), level: 'info', subsystem: 'web', message: 'replica forward', outcome: 'answered', write: true, ms: 30, bytes: 50, opId: 'op-a' }) },
  { source: 'replica', file: 'open-walnut-x.log', line: j({ time: at(4), level: 'info', subsystem: 'web', message: 'replica forward', outcome: 'unreachable', write: true, ms: 5, bytes: 0, opId: 'op-b' }) },
  { source: 'replica', file: 'open-walnut-x.log', line: j({ time: at(5), level: 'info', subsystem: 'web', message: 'replica away answer', route: '/api/tasks', cls: 'leader', away: 'read', why: 'quiet' }) },
  { source: 'journal', file: 'daemon-d-1-ab.log', line: j({ ts: at(6), level: 'info', msg: 'journal append', home: '/h', kind: 'task-fields', opId: 'op-c', actor: 'device:marina' }) },
  { source: 'journal', file: 'daemon-d-1-ab.log', line: j({ ts: at(7), level: 'info', msg: 'journal: acked', home: '/h', seqs: 1, remaining: 0 }) },
]

function fakeConn(caps: string[]): DaemonConnection {
  return {
    connected: true, host: 'devbox',
    hasCapability: (c: string) => caps.includes(c),
    send: async (cmd: string, params: Record<string, unknown>) => { asked.push({ cmd, ...params }); return { ok: true, lines: HOST_LINES, files: ['x'], truncated: false, running: true } },
  } as unknown as DaemonConnection
}

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('bash', [SCRIPT, ...args], {
      env: { ...process.env, WALNUT_LOG_DIR: logDir, WALNUT_LOGS_API_URL: `http://127.0.0.1:${port}`, WALNUT_BUN: process.execPath },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }))
  })
}

beforeAll(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlr-'))
  const mac = [
    { time: at(8), level: 'info', subsystem: 'session', message: 'journal drain', host: 'devbox', drainId: 'd-1', records: 3, applied: 2, merged: 1, conflicts: 1, failed: 0 },
    { time: at(8), level: 'info', subsystem: 'session', message: 'journal drain', host: 'buildbox', drainId: 'd-2', records: 9, applied: 9, merged: 0, conflicts: 0, failed: 0 },
    { time: at(9), level: 'info', subsystem: 'session', message: 'offline merge conflict', host: 'devbox', kind: 'field', id: 'task-marina-1', seq: 2, drainId: 'd-1' },
    { time: at(9), level: 'error', subsystem: 'session', message: 'drain record failed', host: 'devbox', seq: 3, kind: 'task-fields', attempt: 1, nextRetryMs: 5000 },
    { time: at(10), level: 'info', subsystem: 'session', message: 'offline drain: conflict letter sent', host: 'devbox', items: 1 },
    { time: at(11), level: 'info', subsystem: 'task', message: 'replica copy round', target: 'host:devbox', kind: 'tasks', need: 4, held: 0, removed: 1, ms: 40 },
    { time: at(12), level: 'warn', subsystem: 'web', message: 'forward stale refused', hostKey: 'devbox', opId: 'op-z', ageMs: 120000 },
  ]
  fs.writeFileSync(path.join(logDir, `open-walnut-${new Date().toISOString().slice(0, 10)}.log`), mac.map(j).join('\n') + '\n')
  const { default: express } = await import('express')
  const app = express()
  app.use('/api', replicasStatusRouter)
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  setPooledConnectionForTest('devbox', null)
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  fs.rmSync(logDir, { recursive: true, force: true })
})

describe('walnut-logs.sh replica --host', () => {
  it('prints each section from its named lines, the host\'s through the Mac\'s server', async () => {
    setPooledConnectionForTest('devbox', fakeConn(['replica-logs-v1']))
    const { code, out } = await run(['replica', '--host', 'devbox'])
    expect(code, out).toBe(0)
    // The route asked the host's daemon for this Walnut's own home, the named lines only.
    expect(asked.at(-1)).toMatchObject({ cmd: 'logs.tail', home: WALNUT_HOME, sources: ['replica', 'journal'], n: 2000 })
    expect(String((asked.at(-1)!.match as string[]).join(','))).toContain('replica forward')
    expect(out).toMatch(/7 host lines, 6 Mac lines/)
    expect(out).toMatch(/answers=false why=quiet/)
    expect(out).toMatch(/answered: n=2 writes=1 p50=30ms max=30ms bytes=150/)
    expect(out).toMatch(/unreachable: n=1 writes=1/)
    expect(out).toMatch(/leader read why=quiet: n=1/)
    expect(out).toMatch(/task-fields: n=1 coalesced=0 last opId=op-c/)
    expect(out).toMatch(/journal: acked/)
    expect(out).toMatch(/drain=d-1 records=3 applied=2 merged=1 conflicts=1 failed=0/)
    expect(out).not.toMatch(/drain=d-2/)
    expect(out).toMatch(/record failed seq=3 kind=task-fields attempt=1 nextRetryMs=5000/)
    expect(out).toMatch(/conflict field: n=1 ids=task-marina-1/)
    expect(out).toMatch(/conflict letter sent items=1/)
    expect(out).toMatch(/tasks: rounds=1 need=4 held=0 removed=1 max=40ms/)
    expect(out).toMatch(/stale forward refused opId=op-z ageMs=120000/)
  }, 90_000)

  it('a daemon without the cap, or a host not connected: said so, and the Mac\'s lines still print', async () => {
    setPooledConnectionForTest('devbox', fakeConn([]))
    let r = await run(['replica', '--host', 'devbox'])
    expect(r.out).toMatch(/\(host\) host lines of devbox: daemon_needs_upgrade/)
    expect(r.out).toMatch(/0 host lines, 6 Mac lines/)
    expect(r.out).toMatch(/drain=d-1/)
    setPooledConnectionForTest('devbox', null)
    r = await run(['replica', '--host', 'devbox'])
    expect(r.out).toMatch(/host lines of devbox: host_not_connected/)
    // No host named: the usage line, not a run over every host.
    r = await run(['replica'])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/usage: replica --host <alias>/)
  }, 90_000)
})
