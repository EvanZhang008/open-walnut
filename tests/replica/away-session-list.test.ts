/**
 * session_list (GET /api/v1/sessions) and search (GET /api/v1/search) on a host replica while the
 * Mac is away (src/replica/away-read-folds.ts withHostSessions, withTasksMadeHere): the sessions copy holds the Mac's last word,
 * so this host's own sessions take the state the host's daemon reads now (follower.sessions),
 * as the daemon's own away list did (offline-host-core.ts opSessionList: running or stopped by
 * what is live here); a session of another host, and one the copy says ended in an error, keep
 * the copy's; a task made here is named from the overlay (the task copy does not hold it).
 * A search finds the tasks made here as the daemon's keyword search did (opSearch): the search
 * copy holds only what the Mac indexed.
 */
import { describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { awayReads } from '../../src/replica/away-reads.js'
import { withHostSessions, withTasksMadeHere } from '../../src/replica/away-read-folds.js'
import type { Overlay } from '../../src/replica/overlay.js'

const HERE = 'aaaaaaaa-1111-4111-8111-000000000001'
const IDLE = 'aaaaaaaa-1111-4111-8111-000000000002'
const ELSEWHERE = 'bbbbbbbb-2222-4222-8222-000000000003'
const FAILED = 'aaaaaaaa-1111-4111-8111-000000000004'
const MADE = 'mtaskmade-0001aa22bb33cc44'

const overlay = {
  refresh: async () => {},
  taskForReaders: (id: string) => (id === MADE ? { id, title: 'Import the venue rows' } : null),
} as unknown as Overlay

const copy = {
  sessions: [
    { id: HERE, host: 'devbox', process_status: 'running', last_active_at: '2026-11-21T08:00:00.000Z', task_id: MADE },
    { id: IDLE, host: 'devbox', process_status: 'running', last_active_at: '2026-11-21T08:00:00.000Z', task_id: 'mtask-mac', task_title: 'From the Mac' },
    { id: ELSEWHERE, host: 'buildbox', process_status: 'running' },
    { id: FAILED, host: 'devbox', process_status: 'error' },
  ],
  scope: 'all',
}
const live = new Map([
  [HERE, { state: 'working', lastActiveAt: '2026-11-21T09:00:00.000Z' }],
  [IDLE, { state: 'stopped', lastActiveAt: '2026-11-21T07:00:00.000Z' }],
  [ELSEWHERE, { state: 'stopped' }],
  [FAILED, { state: 'stopped' }],
])

describe('withHostSessions', () => {
  it('this host\'s sessions read what they do now; the others, and an error, keep the copy\'s', () => {
    const out = withHostSessions(copy, live, { overlay, hostKey: 'devbox' }) as typeof copy
    expect(out.scope).toBe('all')
    expect(out.sessions).toEqual([
      { id: HERE, host: 'devbox', process_status: 'running', last_active_at: '2026-11-21T09:00:00.000Z', task_id: MADE, task_title: 'Import the venue rows' },
      { id: IDLE, host: 'devbox', process_status: 'stopped', last_active_at: '2026-11-21T08:00:00.000Z', task_id: 'mtask-mac', task_title: 'From the Mac' },
      { id: ELSEWHERE, host: 'buildbox', process_status: 'running' },
      { id: FAILED, host: 'devbox', process_status: 'error' },
    ])
    // Nothing known of the host now: the copy's states stand (the task made here is still named).
    const unknown = withHostSessions(copy, null, { overlay, hostKey: 'devbox' }) as typeof copy
    expect(unknown.sessions.map((s) => s.process_status)).toEqual(['running', 'running', 'running', 'error'])
    expect(withHostSessions({ error: 'x' }, live, { overlay, hostKey: 'devbox' })).toEqual({ error: 'x' })
  })

  it('the route\'s answer gets it when answered away, after the host was asked', async () => {
    const asked: string[] = []
    const handler = awayReads({ overlay, answeredAway: () => true, hostKey: 'devbox', hostSessions: async () => { asked.push('live'); return live } })
    const body = await new Promise<typeof copy>((resolve) => {
      const res = { statusCode: 200, headersSent: false, json(b: unknown) { resolve(b as typeof copy); return this } } as unknown as Response
      handler({ method: 'GET', path: '/v1/sessions', query: {}, get: () => undefined } as unknown as Request, res, () => { (res as unknown as { json(b: unknown): unknown }).json(copy) })
    })
    expect(asked).toEqual(['live'])
    expect(body.sessions.map((s) => s.process_status)).toEqual(['running', 'stopped', 'running', 'error'])
  })
})

describe('session_list status= after the fold', () => {
  it('status=running answers the sessions running now, and `you` reads what it does now too', () => {
    const body = { ...copy, you: { id: IDLE, host: 'devbox', process_status: 'running' } }
    const out = withHostSessions(body, live, { overlay, hostKey: 'devbox' }, 'running') as typeof body
    // IDLE stopped here although the copy says running: out. HERE runs: in. ELSEWHERE keeps the copy's running.
    expect(out.sessions.map((s) => s.id)).toEqual([HERE, ELSEWHERE])
    expect(out.you).toMatchObject({ id: IDLE, process_status: 'stopped' })
    const stopped = withHostSessions({ ...copy, sessions: copy.sessions.map((s) => s.id === HERE ? { ...s, process_status: 'stopped' } : s) }, live, { overlay, hostKey: 'devbox' }, 'stopped') as typeof copy
    // The copy says HERE stopped, it works here now: not stopped. IDLE stopped here: in.
    expect(stopped.sessions.map((s) => s.id)).toEqual([IDLE])
  })

  it('the route never sees the status (it would filter the copy\'s stale states); the fold applies it', async () => {
    const handler = awayReads({ overlay, answeredAway: () => true, hostKey: 'devbox', hostSessions: async () => live })
    const req = { method: 'GET', path: '/v1/sessions', query: { status: 'running', scope: 'all' }, get: () => undefined } as unknown as Request
    let routeQuery: unknown
    const body = await new Promise<typeof copy>((resolve) => {
      const res = { statusCode: 200, headersSent: false, json(b: unknown) { resolve(b as typeof copy); return this } } as unknown as Response
      handler(req, res, () => { routeQuery = req.query; (res as unknown as { json(b: unknown): unknown }).json(copy) })
    })
    expect(routeQuery).toEqual({ scope: 'all' })
    expect(body.sessions.map((s) => s.id)).toEqual([HERE, ELSEWHERE])
  })
})

describe('withTasksMadeHere', () => {
  const made = {
    createdTaskIds: () => [MADE, 'mtaskmade-0002', 'mtaskmade-0003'],
    taskForReaders: (id: string) => ({
      [MADE]: { id: MADE, title: 'Import the venue rows', description: 'From the marina export' },
      'mtaskmade-0002': { id: 'mtaskmade-0002', title: 'Tidy the venue list', plugin_only: true },
      'mtaskmade-0003': { id: 'mtaskmade-0003', title: 'Unrelated' },
    } as Record<string, Record<string, unknown>>)[id] ?? null,
  } as unknown as Overlay
  const answer = { results: [{ type: 'task', title: 'Venue sync', taskId: 'mtask-mac', score: 3, matchField: 'title', snippet: '' }], offline: true }

  it('puts a task made here that holds every word first; a plugin\'s own task and a miss stay out', () => {
    const out = withTasksMadeHere(answer, { q: 'venue IMPORT' }, made) as typeof answer
    expect(out.offline).toBe(true)
    expect(out.results.map((r) => r.taskId)).toEqual([MADE, 'mtask-mac'])
    expect(out.results[0]).toMatchObject({ type: 'task', title: 'Import the venue rows', matchField: 'title', snippet: 'From the marina export' })
    // A word only in its description still finds it.
    expect((withTasksMadeHere(answer, { q: 'marina' }, made) as typeof answer).results[0]).toMatchObject({ taskId: MADE, matchField: 'description' })
  })

  it('keeps the route\'s limit after the merge (20 when not asked)', () => {
    const many = { results: Array.from({ length: 25 }, (_, i) => ({ type: 'task', title: `Venue ${i}`, taskId: `mtask-mac-${i}`, score: 2 })) }
    const five = withTasksMadeHere({ results: many.results.slice(0, 5) }, { q: 'venue', limit: '5' }, made) as typeof answer
    expect(five.results).toHaveLength(5)
    expect(five.results[0]!.taskId).toBe(MADE)
    expect((withTasksMadeHere({ results: many.results.slice(0, 20) }, { q: 'venue' }, made) as typeof answer).results).toHaveLength(20)
  })

  it('with tasks=1 the tasks list holds the made task, and only the tasks the kept rows name', () => {
    const phone = {
      results: [
        { type: 'task', title: 'Venue sync', taskId: 'mtask-mac', score: 3 },
        { type: 'session', title: 'Venue run', sessionId: 's1', taskId: 'mtask-cut', score: 2 },
      ],
      tasks: [{ id: 'mtask-mac', title: 'Venue sync' }, { id: 'mtask-cut', title: 'Cut by the limit' }],
    }
    const out = withTasksMadeHere(phone, { q: 'venue', limit: '2', tasks: '1' }, made) as { results: Array<{ taskId: string }>; tasks: Array<Record<string, unknown>> }
    expect(out.results.map((r) => r.taskId)).toEqual([MADE, 'mtask-mac'])
    expect(out.tasks.map((t) => t.id)).toEqual([MADE, 'mtask-mac'])
    expect(out.tasks[0]).toMatchObject({ id: MADE, title: 'Import the venue rows' })
    // Without tasks asked, no tasks list appears.
    expect((withTasksMadeHere(answer, { q: 'venue' }, made) as Record<string, unknown>).tasks).toBeUndefined()
  })

  it('leaves the answer as it is for a search of other kinds, a task already found, or no match', () => {
    expect(withTasksMadeHere(answer, { q: 'venue', types: 'memory,session' }, made)).toBe(answer)
    const found = { results: [{ type: 'task', title: 'Import the venue rows', taskId: MADE, score: 9 }] }
    expect(withTasksMadeHere(found, { q: 'venue' }, made)).toBe(found)
    expect(withTasksMadeHere(answer, { q: 'harbour' }, made)).toBe(answer)
    // A session result of the task (the copy holds its session) is not the task: it is still added.
    const sessionOnly = { results: [{ type: 'session', title: 'Import the venue rows', sessionId: 'aaaaaaaa-1111-4111-8111-000000000009', taskId: MADE, score: 1 }] }
    expect((withTasksMadeHere(sessionOnly, { q: 'venue' }, made) as typeof answer).results.map((r) => r.type)).toEqual(['task', 'session'])
  })
})
