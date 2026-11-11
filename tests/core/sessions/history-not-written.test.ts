/**
 * A session with no transcript yet reads as no conversation, never "History unavailable"
 * (src/core/sessions/history-not-written.ts; 2026-11-11: the Personal router, started idle by the
 * org, waited for its first mail and its page read "History unavailable: Session history file not
 * found" for hours). The last block is the class guard: every place that answers
 * `historyUnavailable` asks the one predicate first.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const tasks = new Map<string, { org_role?: string }>()
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => {
    const t = tasks.get(id)
    if (!t) throw new Error(`Task ${id} not found`)
    return { id, ...t }
  },
}))

const { historyNotWrittenYet } = await import('../../../src/core/sessions/history-not-written.js')
import type { SessionRecord } from '../../../src/core/types.js'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const HOURS_AGO = new Date(NOW - 6 * 3600_000).toISOString()
const record = (extra: Partial<SessionRecord> = {}): SessionRecord => ({
  claudeSessionId: 's1', taskId: 't-plain', project: '', process_status: 'idle', mode: 'default',
  last_status_change: HOURS_AGO, startedAt: HOURS_AGO, lastActiveAt: HOURS_AGO, messageCount: 1, ...extra,
} as SessionRecord)

beforeEach(() => {
  tasks.clear()
  tasks.set('t-plain', {})
  tasks.set('t-router', { org_role: 'router' })
})

describe('a missing transcript that is the normal state', () => {
  it('a session started with no message reads as no conversation, idle or reaped', async () => {
    for (const process_status of ['idle', 'running', 'stopped'] as const) {
      expect(await historyNotWrittenYet(record({ startedIdle: true, process_status }), NOW), process_status).toBe(true)
    }
  })

  it('a router session reads as no conversation even without the flag (started before it existed)', async () => {
    expect(await historyNotWrittenYet(record({ taskId: 't-router' }), NOW)).toBe(true)
    expect(await historyNotWrittenYet(record({ taskId: 't-router', process_status: 'stopped' }), NOW)).toBe(true)
  })

  it('still shows the fault for a failed session, and for an ordinary one past its startup window', async () => {
    expect(await historyNotWrittenYet(record({ startedIdle: true, process_status: 'error' }), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record({ taskId: 't-router', process_status: 'error' }), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record(), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record({ taskId: 'gone' }), NOW)).toBe(false)
    // Another host may be unreachable: its own answer stays.
    expect(await historyNotWrittenYet(record({ startedIdle: true, host: 'devbox' }), NOW)).toBe(false)
    expect(await historyNotWrittenYet(record({ startedIdle: true, host: '__local__' }), NOW)).toBe(true)
  })

  it('keeps the launch grace: a session seconds old is still booting', async () => {
    const fresh = new Date(NOW - 2_000).toISOString()
    expect(await historyNotWrittenYet(record({ startedAt: fresh, last_status_change: fresh }), NOW)).toBe(true)
  })
})

describe('every "History unavailable" answer asks historyNotWrittenYet first', () => {
  const ROOT = path.resolve(import.meta.dirname, '../../..')
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])
  it('finds each site and the predicate within the lines before it', () => {
    const sites: string[] = []
    for (const file of walk(path.join(ROOT, 'src'))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/historyUnavailable:\s*(reason|unavailableHistoryReason)\b/.test(line)) return
        const rel = `${path.relative(ROOT, file)}:${i + 1}`
        sites.push(rel)
        const before = lines.slice(Math.max(0, i - 14), i).join('\n')
        expect(before, `${rel} answers historyUnavailable without asking historyNotWrittenYet`).toMatch(/historyNotWrittenYet\(/)
      })
    }
    // The four known sites: the web history route (two) and the core history reads (two).
    expect(sites.length).toBeGreaterThanOrEqual(4)
  })
})
