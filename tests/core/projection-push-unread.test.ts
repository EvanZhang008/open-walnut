/**
 * The Mac's side of stage 2c of docs/plan/walnut-companion-unified-replica.md: a
 * companion that lists sessions from its own copy answers the sessions projection
 * push `unread` (web/routes/bridge-ingest.ts, pinned on a real server by
 * tests/web/routes/companion-session-readers-cloud.test.ts), and the Mac stops
 * sending it there (projection-push-state.ts noteUnread).
 *
 * Locked down here:
 *   - after an `unread` answer, a sessions push goes on neither lane until the rest
 *     ends; the task list and the transcript tails go as before, the sweep's too;
 *   - an older companion never says it, so its pushes never rest;
 *   - the rest ends after UNREAD_REST_MS (one push asks again), when the companion
 *     changes build (forgetUnread), and when the Mac drops the companion's sessions
 *     copy (a purge of a kind on the sessions choice), but not for a host's purge.
 *
 * Real projection-cache and copy-kind code; the ingest client's network call and
 * the daemon connection are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-push-unread'))

const sendSpy = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ ok: true, relayed: true, connId: 'd-1.1' }))
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: () => ({ hasCapability: () => true, send: sendSpy }),
}))
type Outcome = 'sent' | 'unread' | 'failed' | 'unsupported'
let answer: (kind: string, wire: string) => Outcome = () => 'sent'
const ingestSpy = vi.fn(async (kind: string, wire: string): Promise<Outcome> => answer(kind, wire))
vi.mock('../../src/core/cloud-ingest.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/cloud-ingest.js')>()),
  postToCloudIngest: (kind: string, wire: string) => ingestSpy(kind, wire),
  cloudIngestResting: () => false,
}))
vi.mock('../../src/core/host-model-catalog.js', () => ({ listHostModelCatalogs: async () => ({}), onHostModelCatalogWritten: () => () => {} }))

import { pushProjectionToCloudNow, runProjectionSelfHealSweep, writeProjectionCache, writeTranscriptCache, _resetProjectionCacheForTesting } from '../../src/core/projection-cache.js'
import { UNREAD_REST_MS, forgetUnread, unreadResting } from '../../src/core/projection-push-state.js'
import { syncCopyKinds, type CopyKind, type CopyTarget } from '../../src/core/replication/kinds/copy-kind.js'
import { SESSIONS_KIND } from '../../src/core/replication/kinds/sessions.js'
import { MODEL_CATALOGS_KIND } from '../../src/core/replication/kinds/model-catalogs.js'
import { _resetReplicaStatusForTesting } from '../../src/core/replication/replica-status.js'
import { WALNUT_HOME } from '../../src/constants.js'

const sessions = (title: string) => ({
  which: 'sessions',
  data: { version: 1, exportedAt: new Date().toISOString(), sessions: [{ id: 's1', title, host: '', process_status: 'running', started_at: 'x', last_active_at: 'y', message_count: 1 }] },
})
const tasks = (title: string) => ({
  which: 'tasks',
  data: { version: 2, exportedAt: new Date().toISOString(), tasks: [{ id: 't1', title, status: 'todo', phase: 'TODO', priority: 'none', project: '', created_at: 'x', updated_at: 'x' }] },
})
const sessionsSent = () => ingestSpy.mock.calls.filter((c) => (JSON.parse(c[1]) as { which?: string }).which === 'sessions').length
const bridgeSends = () => sendSpy.mock.calls.filter((c) => c[0] === 'mobile-event').length
/** The companion: `unread` for a sessions projection, as one holding its copies answers. */
const readsCopy = (_kind: string, wire: string): Outcome => ((JSON.parse(wire) as { which?: string }).which === 'sessions' ? 'unread' : 'sent')

beforeEach(async () => {
  _resetProjectionCacheForTesting()
  _resetReplicaStatusForTesting()
  ingestSpy.mockClear()
  sendSpy.mockClear()
  answer = () => 'sent'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})
afterEach(() => { vi.useRealTimers() })

describe('a companion that reads its sessions copy', () => {
  it('after its `unread` answer, sessions pushes go on neither lane; tasks and transcripts go as before', async () => {
    answer = readsCopy
    expect(await pushProjectionToCloudNow('projection-upsert', sessions('v1'))).toBe('sent')
    expect(unreadResting('projection:sessions')).toBe(true)
    for (const v of ['v2', 'v3']) expect(await pushProjectionToCloudNow('projection-upsert', sessions(v))).toBe('unchanged')
    expect(sessionsSent()).toBe(1)
    expect(bridgeSends()).toBe(0)
    expect(await pushProjectionToCloudNow('projection-upsert', tasks('T'))).toBe('sent')
    expect(await pushProjectionToCloudNow('transcript-upsert', { sid: 's1', data: { version: 1, sessionId: 's1', exportedAt: 'z', truncated: false, messages: [] } })).toBe('sent')
  })

  it('the sweep skips the sessions list too, and still sends the rest', async () => {
    answer = readsCopy
    await pushProjectionToCloudNow('projection-upsert', sessions('v1'))
    await writeProjectionCache('sessions', sessions('v2').data)
    await writeProjectionCache('tasks', tasks('T').data)
    await writeTranscriptCache('s1', { version: 1, sessionId: 's1', exportedAt: 'z', truncated: false, messages: [{ role: 'user', text: 'hi', timestamp: 't' }] })
    ingestSpy.mockClear()
    const counts = await runProjectionSelfHealSweep()
    expect(sessionsSent()).toBe(0)
    expect(ingestSpy.mock.calls.map((c) => c[0]).sort()).toEqual(['projection-upsert', 'transcript-upsert'])
    expect(counts).toMatchObject({ sent: 2, unchanged: 1 })
  })

  it('an older companion never says it: every changed sessions list goes', async () => {
    for (const v of ['v1', 'v2', 'v3']) expect(await pushProjectionToCloudNow('projection-upsert', sessions(v))).toBe('sent')
    expect(sessionsSent()).toBe(3)
    expect(unreadResting('projection:sessions')).toBe(false)
  })
})

describe('the rest ends', () => {
  it('after UNREAD_REST_MS: one push asks again, and an answer without the word ends it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    answer = readsCopy
    await pushProjectionToCloudNow('projection-upsert', sessions('v1'))
    vi.setSystemTime(Date.now() + UNREAD_REST_MS - 1_000)
    expect(await pushProjectionToCloudNow('projection-upsert', sessions('v2'))).toBe('unchanged')
    vi.setSystemTime(Date.now() + 2_000)
    answer = () => 'sent' // the copy went away there: it reads the push again
    expect(await pushProjectionToCloudNow('projection-upsert', sessions('v3'))).toBe('sent')
    expect(await pushProjectionToCloudNow('projection-upsert', sessions('v4'))).toBe('sent')
    expect(sessionsSent()).toBe(3)
  })

  it('when the companion changes build (forgetUnread)', async () => {
    answer = readsCopy
    await pushProjectionToCloudNow('projection-upsert', sessions('v1'))
    forgetUnread()
    expect(await pushProjectionToCloudNow('projection-upsert', sessions('v2'))).toBe('sent')
    expect(sessionsSent()).toBe(2)
  })

  it('when the Mac drops the companion\'s sessions copy; a host\'s purge leaves it', async () => {
    answer = readsCopy
    await pushProjectionToCloudNow('projection-upsert', sessions('v1'))
    const kinds: CopyKind<any>[] = [SESSIONS_KIND, MODEL_CATALOGS_KIND].map((k) => ({ ...k, rows: async () => [], watch: () => () => {} }))
    const purges: string[] = []
    const target = (id: string, kind: 'companion' | 'host'): CopyTarget => ({
      id, kind, label: id, available: async () => true, copies: async () => ({ sessions: false }), program: () => 'replica',
      post: async (p) => { purges.push(`${id}:${String(p.op)}:${String(p.kind)}`); return { ok: true, reply: { ok: true, removed: 1 } } },
    })
    await syncCopyKinds(kinds, { targets: () => [target('host:devbox', 'host')] })
    expect(unreadResting('projection:sessions')).toBe(true)
    await syncCopyKinds(kinds, { targets: () => [target('companion', 'companion')] })
    expect(purges).toEqual(['host:devbox:purge:sessions', 'host:devbox:purge:model-catalogs', 'companion:purge:sessions', 'companion:purge:model-catalogs'])
    expect(unreadResting('projection:sessions')).toBe(false)
  })
})
