/**
 * The sessions copy at the Mac's real density (docs/plan/walnut-replica-servers-impl.md,
 * WP4 acceptance): 5,000 session rows reach a host replica's own store in one
 * first round under 5 s, and a turn ending afterwards (one row changed) costs
 * one put and no manifest: the digest on that put proves the copy matches.
 * Real route, real store (the replica's sessions.sqlite through the apply
 * connection), real leader round. The timings go to the log for the notes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../helpers/copy-kind-harness.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-copy-sessions-scale', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { runCopyRound, type CopyKind } from '../../../src/core/replication/kinds/copy-kind.js'
import { SESSIONS_KIND, projectSession } from '../../../src/core/replication/kinds/sessions.js'
import { buildKindManifest } from '../../../src/core/replication/kind-leader.js'
import { forgetKindManifests } from '../../../src/core/replication/replica-status.js'
import type { SessionRecord } from '../../../src/core/types.js'

const N = 5_000
const T0 = '2026-10-15T08:00:00.000Z'
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let rows: SessionRecord[] = []

/** A row shaped like the Mac's: titles, a history, a summary, a plan on some. */
function session(i: number): SessionRecord {
  return {
    claudeSessionId: `5f3c2a10-${String(i).padStart(4, '0')}-4b7e-9a21-acme${String(i).padStart(8, '0')}`,
    taskId: `t-${i % 900}`, project: i % 5 === 0 ? 'Marina' : 'Acme', process_status: i < 30 ? 'running' : 'stopped', mode: 'bypassPermissions',
    provider: 'cli', startedAt: T0, lastActiveAt: T0, messageCount: i % 200, cwd: `/home/acme/src/pkg-${i % 60}`, host: i % 4 === 0 ? 'devbox' : undefined,
    title: `Fix the flaky build step in package ${i % 60} and ship the release notes`, model: 'opus', cliModel: 'opus-4',
    summary: 'Investigated the failing step, found the race in the cache writer, fixed it and added a test.'.repeat(2),
    status_history: Array.from({ length: 6 }, (_, k) => ({ from: k % 2 ? 'idle' : 'running', to: k % 2 ? 'running' : 'idle', at: T0 })),
    ...(i % 25 === 0 ? { planContent: '# Plan\n' + '- step that changes one module and its test\n'.repeat(40) } : {}),
    pid: 50_000 + i, outputFile: `/tmp/streams/${i}.jsonl`,
  } as unknown as SessionRecord
}

const kind: CopyKind<SessionRecord> = { ...SESSIONS_KIND, rows: async () => rows.map(projectSession), watch: () => () => {} }

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  sessionDb.getDb()
  h = await startCopyHarness()
  rows = Array.from({ length: N }, (_, i) => session(i))
})

afterAll(async () => {
  await h.close()
  sessionDb.closeDb()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('5,000 session rows', () => {
  it('first round under 5 s, then one turn ending = one put, the manifest skipped by digest', async () => {
    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    const started = performance.now()
    const manifest = await buildKindManifest(kind, [...await kind.rows()])
    const manifestMs = performance.now() - started
    const first = await runCopyRound(kind, manifest, h.target, { asOf: Date.now() })
    const firstMs = performance.now() - started
    loop.disable()
    const puts = h.calls.filter((c) => c.op === 'put')
    const putBytes = puts.reduce((s, c) => s + c.bytes, 0)
    console.log(JSON.stringify({ scale: 'sessions-first-round', rows: N, manifestMs: Math.round(manifestMs), firstRoundMs: Math.round(firstMs), puts: puts.length, putBytes, maxLoopDelayMs: Math.round(loop.max / 1e6) }))
    expect(first).toMatchObject({ action: 'synced', entries: N, sent: N, held: 0 })
    expect(firstMs).toBeLessThan(5_000)
    expect(puts.every((c) => c.bytes <= 600 * 1024)).toBe(true)
    expect((await tracker.listSessions()).length).toBe(N)

    // A turn ends on one session: one row changes on the leader.
    rows[17] = { ...rows[17], process_status: 'idle', messageCount: 201, lastActiveAt: '2026-10-15T09:00:00.000Z' } as SessionRecord
    const from = h.calls.length
    const t1 = performance.now()
    const turn = await runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
    const turnMs = performance.now() - t1
    console.log(JSON.stringify({ scale: 'sessions-turn-end', turnRoundMs: Math.round(turnMs), steps: stepsSince(h.calls, from) }))
    expect(turn).toMatchObject({ action: 'synced', sent: 1 })
    expect(stepsSince(h.calls, from)).toEqual(['put:sessions:1+digest'])
    expect((await tracker.getSessionByClaudeId(rows[17].claudeSessionId))?.process_status).toBe('idle')

    // The sweep: one status step, no manifest of 5,000 entries.
    forgetKindManifests(['sessions'])
    const swept = h.calls.length
    expect((await runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })).action).toBe('unchanged')
    expect(stepsSince(h.calls, swept)).toEqual(['status:sessions'])
  }, 60_000)
})
