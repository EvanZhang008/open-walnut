/**
 * scrubInheritedSessionPids: an ephemeral server clears every pid its data
 * snapshot inherited, because each one names a process another Walnut's daemon
 * spawned (2026-09-26: a hand-copied production sessions store let an ephemeral
 * server kill the user's live CLIs).
 *
 * The store is a fresh temp sessions.sqlite with fabricated rows; pids sit above
 * any real pid limit. The liveness probe is injected, and process.kill is spied
 * on and asserted never called with a real signal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-pid-scrub'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  createSessionRecord,
  getSessionByClaudeId,
  scrubInheritedSessionPids,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb, getDb } from '../../src/core/session-db.js'

const BASE = 2 ** 22

let killSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    // Only the existence probe may ever be attempted, and only on our fabricated pids.
    if (sig !== 0) throw new Error(`a real signal ${String(sig)} was sent to ${pid}`)
    if (pid <= BASE) throw new Error(`probe of a real pid ${pid}`)
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
  }) as typeof process.kill)
})

afterEach(async () => {
  for (const [, sig] of killSpy.mock.calls) expect(sig).toBe(0)
  vi.restoreAllMocks()
  closeDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function seed(): Promise<void> {
  await createSessionRecord('copied-running', 'task-1', 'proj', undefined, { pid: BASE + 1 })
  await updateSessionRecord('copied-running', { process_status: 'running' })
  await createSessionRecord('copied-stopped', 'task-2', 'proj', undefined, { pid: BASE + 2 })
  await updateSessionRecord('copied-stopped', {
    process_status: 'stopped', status_reason: 'idle_timeout', status_changed_by: 'health-monitor',
  })
  await createSessionRecord('copied-idle', 'task-3', 'proj', undefined, { pid: BASE + 3 })
  await updateSessionRecord('copied-idle', { process_status: 'idle' })
  await createSessionRecord('no-pid', 'task-4', 'proj')
}

describe('scrubInheritedSessionPids', () => {
  it('clears every pid, whatever the row status, and counts the ones still alive', async () => {
    await seed()
    const probed: number[] = []
    const result = await scrubInheritedSessionPids((pid) => { probed.push(pid); return pid === BASE + 1 })

    expect(result).toEqual({ scrubbed: 3, alive: 1 })
    expect(probed.sort()).toEqual([BASE + 1, BASE + 2, BASE + 3])
    for (const sid of ['copied-running', 'copied-stopped', 'copied-idle', 'no-pid']) {
      expect((await getSessionByClaudeId(sid))?.pid, sid).toBeUndefined()
    }
    // The rows themselves survive: only the foreign pids are gone.
    expect((await getSessionByClaudeId('copied-stopped'))?.status_reason).toBe('idle_timeout')
    expect((await getSessionByClaudeId('copied-running'))?.process_status).toBe('running')
  })

  it('is a no-op on a store with no pids, and idempotent', async () => {
    await createSessionRecord('clean', 'task-1', 'proj')
    expect(await scrubInheritedSessionPids(() => true)).toEqual({ scrubbed: 0, alive: 0 })
    await seed()
    expect((await scrubInheritedSessionPids(() => false)).scrubbed).toBe(3)
    expect(await scrubInheritedSessionPids(() => true)).toEqual({ scrubbed: 0, alive: 0 })
  })

  it('the default probe only ever uses signal 0 and treats ESRCH as dead', async () => {
    await seed()
    const result = await scrubInheritedSessionPids()
    expect(result).toEqual({ scrubbed: 3, alive: 0 })
    expect(killSpy.mock.calls.map(([pid]) => pid).sort()).toEqual([BASE + 1, BASE + 2, BASE + 3])
  })

  it('also clears a pid left only in the payload JSON, keeping every other payload key', async () => {
    // An older row shape: the pid column is empty but the payload still names a
    // pid, and rowToSession reads the payload first, so the record would carry it.
    await createSessionRecord('payload-pid', 'task-5', 'proj', undefined, { title: 'kept title' })
    const db = getDb()!
    db.prepare("UPDATE sessions SET pid = NULL, payload = json_set(COALESCE(payload, '{}'), '$.pid', ?, '$.legacyNote', 'kept') WHERE claude_session_id = ?")
      .run(BASE + 5, 'payload-pid')
    _resetSessionTrackerForTesting()
    expect((await getSessionByClaudeId('payload-pid'))?.pid, 'the leak shape this case exists for').toBe(BASE + 5)

    const probed: number[] = []
    expect(await scrubInheritedSessionPids((pid) => { probed.push(pid); return false })).toEqual({ scrubbed: 1, alive: 0 })

    expect(probed).toEqual([BASE + 5])
    const row = db.prepare('SELECT pid, payload FROM sessions WHERE claude_session_id = ?').get('payload-pid') as { pid: unknown; payload: string }
    expect(row.pid).toBeNull()
    const payload = JSON.parse(row.payload)
    expect(payload).not.toHaveProperty('pid')
    expect(payload.legacyNote).toBe('kept')
    expect((await getSessionByClaudeId('payload-pid'))?.pid).toBeUndefined()
    expect((await getSessionByClaudeId('payload-pid'))?.title).toBe('kept title')
  })

  it('leaves a row with a malformed payload readable and clears its column pid', async () => {
    await createSessionRecord('bad-payload', 'task-6', 'proj', undefined, { pid: BASE + 6 })
    getDb()!.prepare("UPDATE sessions SET payload = 'not json' WHERE claude_session_id = ?").run('bad-payload')
    _resetSessionTrackerForTesting()
    expect((await scrubInheritedSessionPids(() => false)).scrubbed).toBe(1)
    const row = getDb()!.prepare('SELECT pid, payload FROM sessions WHERE claude_session_id = ?').get('bad-payload') as { pid: unknown; payload: string }
    expect(row).toEqual({ pid: null, payload: 'not json' })
  })

  it('refuses, and changes nothing, when its data dir is the production home', async () => {
    await seed()
    await expect(scrubInheritedSessionPids(() => false, { home: WALNUT_HOME, productionHomes: [WALNUT_HOME] }))
      .rejects.toThrow(/refused to start: its data dir .* is the production Walnut's own/)
    expect((await getSessionByClaudeId('copied-running'))?.pid).toBe(BASE + 1)
    expect((await getSessionByClaudeId('copied-idle'))?.pid).toBe(BASE + 3)
  })
})
