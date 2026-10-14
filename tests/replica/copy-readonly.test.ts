/**
 * On a host replica the copy stores read only, except the one follower apply
 * connection (docs/plan/walnut-replica-servers-impl.md, section 2, runtime
 * guard; src/replica/copy-guard.ts). The real task and session stores, on a
 * temp data dir: a write through the shared handle throws, the apply
 * connection writes, and the shared handle reads what it wrote. On the leader
 * (same stores, role reset) the shared handle writes as before.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-copy-ro'))

let env: HostReplicaEnv | null = null

beforeAll(async () => {
  const c = await import('../../src/constants.js')
  env = useHostReplicaEnv(c.WALNUT_HOME)
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
})

afterAll(async () => {
  ;(await import('../../src/core/task-db.js')).closeDb()
  ;(await import('../../src/core/session-db.js')).closeDb()
  env?.restore()
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
})

const NOW = '2026-10-14T00:00:00.000Z'

describe('copy stores on a host replica', () => {
  it('tasks.sqlite: the shared handle refuses a write; the apply connection writes; the shared handle reads it', async () => {
    const taskDb = await import('../../src/core/task-db.js')
    const db = taskDb.getDb()!
    expect(db.pragma('query_only', { simple: true })).toBe(1)
    const insert = "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
    expect(() => db.prepare(insert).run('t-marina-1', 'marina', NOW, NOW)).toThrow(/readonly/i)
    expect(() => taskDb.transaction((d) => d.prepare('DELETE FROM tasks').run())).toThrow(/readonly/i)
    const apply = taskDb.openCopyApplyConnection()
    try {
      apply.prepare(insert).run('t-marina-1', 'marina', NOW, NOW)
    } finally { apply.close() }
    expect(db.prepare('SELECT title FROM tasks WHERE id = ?').get('t-marina-1')).toEqual({ title: 'marina' })
  })

  it('sessions.sqlite: the same', async () => {
    const sessionDb = await import('../../src/core/session-db.js')
    const db = sessionDb.getDb()!
    expect(db.pragma('query_only', { simple: true })).toBe(1)
    const cols = (db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }>)
    expect(cols.length).toBeGreaterThan(0)
    expect(() => db.prepare('DELETE FROM sessions').run()).toThrow(/readonly/i)
    const apply = sessionDb.openCopyApplyConnection()
    try {
      expect(apply.prepare('DELETE FROM sessions').run().changes).toBe(0)
    } finally { apply.close() }
  })

  it('on the leader the shared handles write as before', async () => {
    const taskDb = await import('../../src/core/task-db.js')
    const sessionDb = await import('../../src/core/session-db.js')
    taskDb.closeDb()
    sessionDb.closeDb()
    env?.restore()
    env = null
    ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
    const db = taskDb.getDb()!
    expect(db.pragma('query_only', { simple: true })).toBe(0)
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('acme', 't-marina-1')
    expect(db.prepare('SELECT title FROM tasks WHERE id = ?').get('t-marina-1')).toEqual({ title: 'acme' })
    expect(sessionDb.getDb()!.pragma('query_only', { simple: true })).toBe(0)
  })
})
