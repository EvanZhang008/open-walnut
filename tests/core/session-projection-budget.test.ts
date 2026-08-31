/**
 * Session projection SELECTION — which rows survive the export budget.
 *
 * The projection is what the phone lists (GET /api/v1/sessions, served verbatim,
 * no paging params), so a row missing from it is a session the phone believes
 * does not exist: tapping that board task opens a New Session draft instead of
 * the conversation that already exists. The visibility rule is meant to be the
 * 14-day retention window; the row budget is only a payload backstop. When the
 * budget was 500 it silently BECAME the rule on a real box (962 in-window
 * sessions → 462 dropped, 8.1-day effective window, 88 pinned board tasks
 * stranded), which is the bug these cases pin shut.
 *
 * Everything asserts through the REAL buildSessionProjection — the store reads
 * are the only thing mocked, so the selection order, the budgets and the warn
 * under test are the shipped ones, not a copy.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { log } from '../../src/logging/index.js'
import type { SessionRecord, Task } from '../../src/core/types.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-budget'))

let mockSessions: SessionRecord[] = []
let mockTasks: Task[] = []

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: async () => mockSessions,
  // Real rule (session-tracker): no environment sessions, no lane-bound ones.
  isListableSession: (s: SessionRecord) => !s.lane,
}))
vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: async () => mockTasks,
}))

const DAY_MS = 24 * 60 * 60 * 1000

/** A session that is `daysAgo` old and stopped (the retention-gated shape). */
function session(id: string, daysAgo: number, taskId?: string): SessionRecord {
  const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString()
  return {
    claudeSessionId: id,
    ...(taskId ? { taskId } : {}),
    process_status: 'stopped',
    mode: 'bypass',
    startedAt: at,
    lastActiveAt: at,
    messageCount: 3,
  } as SessionRecord
}

function pinnedTask(id: string): Task {
  return { id, title: `task ${id}`, pinned: true, focus_tier: 'focus' } as Task
}

async function build() {
  const { buildSessionProjection } = await import('../../src/core/session-projection.js')
  return buildSessionProjection()
}

describe('session projection budget', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockSessions = []
    mockTasks = []
    warnSpy = vi.spyOn(log.session, 'warn').mockImplementation(() => {})
  })

  it('keeps a pinned task\'s in-window session and cuts older unpinned ones instead', async () => {
    // 2000 eligible sessions > the 1500 row budget. The pinned one is the OLDEST
    // in-window row, i.e. the first thing a blind recency slice would drop —
    // exactly the shape of the real incident (rank 596 of 962 under a 500 cap).
    for (let i = 0; i < 1999; i++) mockSessions.push(session(`plain-${i}`, i * 0.005))
    mockSessions.push(session('pinned-oldest', 13.9, 'task-pin'))
    mockTasks.push(pinnedTask('task-pin'))

    const projection = await build()
    const ids = projection.sessions.map((s) => s.id)

    expect(ids).toContain('pinned-oldest')
    // The row it displaced is an unpinned NEWER one, and the newest rows still ship.
    expect(ids).toContain('plain-0')
    expect(ids).not.toContain('plain-1998')
    // The pinned row carries the flags the phone routes on.
    const pinnedRow = projection.sessions.find((s) => s.id === 'pinned-oldest')
    expect(pinnedRow?.pinned).toBe(true)
    expect(pinnedRow?.focus_tier).toBe('focus')
    // Output order is still recency-descending (the pinned pass must not leak out).
    const stamps = projection.sessions.map((s) => s.last_active_at)
    expect([...stamps].sort().reverse()).toEqual(stamps)
  })

  it('never evicts a pinned session even when pinned rows alone fill the budget', async () => {
    // 1600 pinned sessions, all in-window: the budget binds entirely inside the
    // pinned set, so the survivors must be pinned rather than an arbitrary mix.
    for (let i = 0; i < 1600; i++) {
      mockSessions.push(session(`pin-${i}`, i * 0.005, `task-${i}`))
      mockTasks.push(pinnedTask(`task-${i}`))
    }
    const projection = await build()
    expect(projection.sessions.length).toBe(1500)
    expect(projection.sessions.every((s) => s.pinned)).toBe(true)
  })

  it('ships the whole 14-day window at real volume, and drops what falls outside it', async () => {
    // ~1000 in-window (real box: 962) plus records each exclusion rule owns.
    for (let i = 0; i < 1000; i++) mockSessions.push(session(`in-${i}`, i * 0.0139))
    mockSessions.push(session('too-old', 20))
    mockSessions.push(session('lane-bound', 1))
    ;(mockSessions[mockSessions.length - 1] as { lane?: string }).lane = 'personal-ai'
    // Archived is a SEPARATE exclusion from the lane rule the mock above covers
    // (290 of 4,995 real records are archived), and an in-window archived row
    // would otherwise sail through every other check.
    mockSessions.push(session('archived-recent', 1))
    ;(mockSessions[mockSessions.length - 1] as { archived?: boolean }).archived = true
    // An errored session is terminal too, so the retention window applies to it
    // exactly like `stopped` — otherwise it leaks into eligible forever.
    mockSessions.push(session('errored-in-window', 2))
    ;(mockSessions[mockSessions.length - 1] as { process_status?: string }).process_status = 'error'
    mockSessions.push(session('errored-ancient', 400))
    ;(mockSessions[mockSessions.length - 1] as { process_status?: string }).process_status = 'error'
    // A LIVE session is never retention-gated, however old its last activity.
    mockSessions.push(session('running-ancient', 400))
    ;(mockSessions[mockSessions.length - 1] as { process_status?: string }).process_status = 'running'

    const projection = await build()
    const ids = projection.sessions.map((s) => s.id)
    expect(ids).not.toContain('too-old')
    expect(ids).not.toContain('lane-bound')
    expect(ids).not.toContain('archived-recent')
    expect(ids).not.toContain('errored-ancient')
    expect(ids).toContain('errored-in-window')
    expect(ids).toContain('running-ancient')
    expect(projection.sessions.length).toBe(1002) // 1000 in-window + error + running
    // Nothing was truncated, so the budget warn must stay silent and the
    // envelope must NOT claim truncation.
    expect(warnSpy).not.toHaveBeenCalled()
    expect(projection.truncated).toBeUndefined()
  })

  it('warns exactly once per export when the budget truncates, with the lost counts', async () => {
    for (let i = 0; i < 1700; i++) mockSessions.push(session(`plain-${i}`, i * 0.005))
    mockSessions.push(session('pinned-oldest', 13.9, 'task-pin'))
    mockTasks.push(pinnedTask('task-pin'))

    await build()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('session projection truncated by budget')
    expect(fields.eligible).toBe(1701)
    expect(fields.shipped).toBe(1500)
    expect(fields.dropped).toBe(201)
    expect(fields.droppedPinned).toBe(0)
    expect(fields.retentionDays).toBe(14)
    expect(typeof fields.oldestShipped).toBe('string')
    // These slim rows are nowhere near the byte ceiling, so ROWS alone bound.
    expect(fields.boundBy).toBe('rows')

    // Once PER EXPORT, not once per process: a second export warns again.
    warnSpy.mockClear()
    await build()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('reports BOTH binders when the row cap and the byte ceiling each reject rows', async () => {
    // A uniform set can only ever hit ONE binder; a MIXED one hits both, which is
    // the realistic shape (cwd/title have no clip). 1,600 slim rows fill the row
    // cap, and one pathological row is rejected on bytes alone. Reporting just
    // 'rows' here hid the byte ceiling — the binder that can silently kill the
    // bridge push.
    for (let i = 0; i < 1_600; i++) mockSessions.push(session(`slim-${i}`, i * 0.005))
    const whale = session('one-whale-row', 13)
    ;(whale as { cwd?: string }).cwd = 'x'.repeat(3_500_000)
    mockSessions.push(whale)

    const projection = await build()
    const ids = projection.sessions.map((s) => s.id)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const fields = warnSpy.mock.calls[0]![1] as Record<string, unknown>
    expect(fields.boundBy).toBe('rows+bytes')
    expect(fields.shipped).toBe(1500)
    expect(fields.dropped).toBe(101) // 100 over the row cap + the whale
    expect(ids).not.toContain('one-whale-row')
    // Truncation is recorded on the envelope so no future consumer reads absence
    // as deletion (the task projection's importer already does exactly that).
    expect(projection.truncated).toBe(true)
  })

  it('bounds the payload by bytes too, so the list can never outgrow one bridge frame', async () => {
    // description is clipped at 300 chars but title/cwd are NOT, so one row is
    // unbounded and the row cap alone cannot promise a payload size. These rows
    // are ~4KB each, which makes bytes bind before 1500 rows do. A projection
    // past the bridge frame budget is not an error — the push is skipped and the
    // cloud replica freezes on its last copy — so the ceiling has to be enforced
    // here, in the only writer.
    const { PROJECTION_PUSH_MAX_BYTES } = await import('../../src/core/projection-cache.js')
    for (let i = 0; i < 1500; i++) {
      const s = session(`fat-${i}`, i * 0.009)
      ;(s as { description?: string; cwd?: string; title?: string }).description = 'd'.repeat(400)
      ;(s as { description?: string; cwd?: string; title?: string }).cwd = '/deep/'.repeat(500)
      ;(s as { description?: string; cwd?: string; title?: string }).title = 't'.repeat(700)
      mockSessions.push(s)
    }

    const projection = await build()
    const bytes = Buffer.byteLength(
      JSON.stringify({ which: 'sessions', data: projection }),
      'utf8',
    )
    expect(projection.sessions.length).toBeLessThan(1500) // bytes bound first
    expect(bytes).toBeLessThan(PROJECTION_PUSH_MAX_BYTES) // ...and stayed pushable
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect((warnSpy.mock.calls[0]![1] as Record<string, unknown>).boundBy).toBe('bytes')
  })
})
