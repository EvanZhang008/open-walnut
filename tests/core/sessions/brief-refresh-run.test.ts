/**
 * The refresh turn a look at a stale Brief asks for (src/core/sessions/brief-refresh.ts): ONE note
 * into the node's session, recorded on the task first, at most once per BRIEF_REFRESH_GAP_MS; none
 * for a current Brief, a node whose turn runs (its end rewrites the Brief), a complete, stopped or
 * snoozed node, a task that keeps no Brief, or one with no session. Every org role that keeps a
 * Brief is covered (the guard below fails on a new one).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRecord, Task } from '../../../src/core/types.js'

const tasks = new Map<string, Task>()
const sends: { sid: string; text: string; source?: string }[] = []
let sessions: Record<string, SessionRecord[]> = {}

vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => { const t = tasks.get(id); if (!t) throw new Error('no task'); return t },
  listTasks: async () => [...tasks.values()],
  updateTaskRaw: async (id: string, patch: Record<string, unknown>, opts?: { shouldUpdate?: (t: Task) => boolean }) => {
    const cur = tasks.get(id)!
    if (opts?.shouldUpdate && !opts.shouldUpdate(cur)) return { changed: false }
    tasks.set(id, { ...cur, ...patch } as Task)
    return { changed: true }
  },
}))
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => sessions[id] ?? [],
}))
vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: async (sid: string, text: string, o: { source?: string }) => { sends.push({ sid, text, source: o.source }) },
}))

import { requestBriefRefresh, briefRefreshDue, BRIEF_REFRESH_GAP_MS, BRIEF_REFRESH_SOURCE } from '../../../src/core/sessions/brief-refresh.js'
import { briefSnapshot } from '../../../src/core/sessions/brief-fresh.js'
import { keepsBrief } from '../../../src/core/sessions/brief.js'

const NOW = Date.parse('2026-10-31T17:00:00Z')
const LETTER = '### Needs you\n- <task-ref id="w1" label="Review"/>: review section 3.\n### Working\n- None\n### Waiting / snoozed\n- None'
const worker = (ask?: string): Task => ({
  id: 'w1', title: 'Review the doc', phase: ask ? 'NEED_ACTION' : 'WAITING', status: 'in_progress', project: 'Marina', parent_task_id: 'L',
  user_status: ask ? { state: 'needs', source: 'session', ask } : { state: 'waiting', kind: 'task', waitingOn: 'The reviewer' },
}) as Task

function seed(role: 'lead' | 'main', moved: boolean): void {
  tasks.clear()
  const w = worker('Review section 3')
  const owner = { id: 'L', title: 'Node', phase: 'WAITING', status: 'in_progress', org_role: role, project: 'Marina' } as Task
  tasks.set('L', { ...owner, brief: { text: LETTER, at: '2026-10-31T13:03:00Z', ...briefSnapshot(LETTER, owner, [owner, w]) } } as Task)
  tasks.set('w1', moved ? worker() : w)
}

beforeEach(() => {
  sends.length = 0
  sessions = { L: [{ claudeSessionId: 's-L', taskId: 'L', process_status: 'stopped' } as SessionRecord] }
})

describe('requestBriefRefresh', () => {
  for (const role of ['lead', 'main'] as const) {
    it(`a ${role} whose Brief moved gets one note, recorded first; a second look inside the gap gets none`, async () => {
      seed(role, true)
      const r = await requestBriefRefresh('L', 'web', NOW)
      expect(r).toEqual({ sent: true, sessionId: 's-L', moved: 1 })
      expect(tasks.get('L')!.brief_refresh).toEqual({ at: new Date(NOW).toISOString(), by: 'web', moved: 1, told: {} })
      expect(sends).toHaveLength(1)
      expect(sends[0]!.source).toBe(BRIEF_REFRESH_SOURCE)
      expect(sends[0]!.text).toContain('kind="trigger"')
      expect(sends[0]!.text).toContain('"Review the doc" (w1): now Waiting: Waiting on The reviewer')
      expect((await requestBriefRefresh('L', 'phone', NOW + 60_000)).why).toBe('recent')
      expect(sends).toHaveLength(1)
      // After the gap, a look at a Brief still stale asks again.
      expect((await requestBriefRefresh('L', 'phone', NOW + BRIEF_REFRESH_GAP_MS + 1)).sent).toBe(true)
      expect(sends).toHaveLength(2)
    })
  }

  it('a current Brief, a running turn, no session, or a task that keeps none: no note', async () => {
    seed('lead', false)
    expect((await requestBriefRefresh('L', 'web', NOW)).why).toBe('fresh')
    seed('lead', true)
    sessions.L = [{ claudeSessionId: 's-L', taskId: 'L', process_status: 'running' } as SessionRecord]
    expect((await requestBriefRefresh('L', 'web', NOW)).why).toBe('running')
    sessions.L = []
    expect((await requestBriefRefresh('L', 'web', NOW)).why).toBe('no_session')
    expect(tasks.get('L')!.brief_refresh).toBeUndefined()
    expect((await requestBriefRefresh('w1', 'phone', NOW)).why).toBe('not_org_node')
    expect((await requestBriefRefresh('nope', 'phone', NOW)).why).toBe('not_found')
    expect(sends).toHaveLength(0)
  })

  it('two looks at once send one note', async () => {
    seed('lead', true)
    const [a, b] = await Promise.all([requestBriefRefresh('L', 'web', NOW), requestBriefRefresh('L', 'phone', NOW)])
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1)
    expect(sends).toHaveLength(1)
  })
})

// 2026-11-02 org review: a lead repeated the same three asks at 01:36, 01:54 and 02:19 with
// nothing changed, because every refresh told it to say "what needs him now".
describe('a refresh restates only the Needs you items that changed', () => {
  const other = (state: 'working' | 'waiting'): Task => ({
    id: 'w2', title: 'Build the page', phase: state === 'working' ? 'IN_PROGRESS' : 'WAITING', status: 'in_progress', project: 'Marina', parent_task_id: 'L',
    user_status: state === 'working' ? { state: 'working', now: 'Building' } : { state: 'waiting', kind: 'outside', waitingOn: 'The CI run' },
  }) as Task
  const look = (n: number) => requestBriefRefresh('L', 'web', NOW + n * (BRIEF_REFRESH_GAP_MS + 1))

  it('new, then unchanged (agent-ack, no list), then reworded, then gone', async () => {
    seed('lead', false)
    const letter = LETTER.replace('### Working\n- None', '### Working\n- <task-ref id="w2" label="Build"/>: building.')
    // Each look finds the Brief stale through w2 alone: written with w2 open, then w2 finished.
    const stale = () => {
      const owner = tasks.get('L')!
      tasks.set('w2', other('working'))
      tasks.set('L', { ...owner, brief: { text: letter, at: new Date(NOW).toISOString(), ...briefSnapshot(letter, owner, [...tasks.values()]) } } as Task)
      tasks.set('w2', { ...other('working'), phase: 'COMPLETE', status: 'done', user_status: { state: 'done' } } as Task)
    }
    stale()
    expect((await look(0)).sent).toBe(true)
    expect(sends[0]!.text).toContain('Needs you, changed since you last told him:')
    expect(sends[0]!.text).toContain('"Review the doc" (w1): new: "Review section 3"')
    expect(tasks.get('L')!.brief_refresh?.told).toEqual({ w1: 'Review section 3' })

    stale()
    expect((await look(1)).sent).toBe(true)
    expect(sends[1]!.text).not.toContain('Needs you, changed')
    expect(sends[1]!.text).not.toContain('Review section 3')
    expect(sends[1]!.text).toContain('do not repeat his Needs you list')
    expect(sends[1]!.text).toContain('<walnut-turn status="agent-ack"/>')

    stale()
    tasks.set('w1', worker('Review sections 3 and 4'))
    expect((await look(2)).sent).toBe(true)
    expect(sends[2]!.text).toContain('(w1): reworded: "Review sections 3 and 4"')
    expect(sends[2]!.text).toContain('only the Needs you changes above')

    stale()
    tasks.set('w1', worker())
    expect((await look(3)).sent).toBe(true)
    expect(sends[3]!.text).toContain('(w1): no longer needs him')
    expect(tasks.get('L')!.brief_refresh?.told).toEqual({})
  })

  it('a note that never arrived keeps the earlier list, so the next one still names the change', async () => {
    seed('lead', false)
    const letterOwner = tasks.get('L')!
    tasks.set('L', { ...letterOwner, brief_refresh: { at: new Date(NOW - 2 * BRIEF_REFRESH_GAP_MS).toISOString(), by: 'web', moved: 0, told: { w1: 'Review section 3' } } } as Task)
    tasks.set('w1', worker('Review sections 3 and 4'))
    const { needsChanges } = await import('../../../src/core/sessions/brief-refresh.js')
    expect(needsChanges({ w1: 'Review sections 3 and 4' }, tasks.get('L')!.brief_refresh!.told)).toEqual([{ id: 'w1', kind: 'reworded', ask: 'Review sections 3 and 4' }])
    expect(needsChanges({ w1: 'a' }, { w1: 'a' })).toEqual([])
    expect(needsChanges({ w1: 'a' }, undefined)).toEqual([{ id: 'w1', kind: 'new', ask: 'a' }])
  })
})

describe('briefRefreshDue', () => {
  it('a complete, stopped-team or snoozed node is never due', () => {
    seed('lead', true)
    const owner = tasks.get('L')!
    const all = [...tasks.values()]
    expect(briefRefreshDue({ ...owner, phase: 'COMPLETE' } as Task, all, { now: NOW, running: false })).toEqual({ due: false, why: 'complete' })
    expect(briefRefreshDue(owner, all, { now: NOW, running: false, quieted: true })).toEqual({ due: false, why: 'team_stopped' })
    expect(briefRefreshDue({ ...owner, user_status: { state: 'waiting', snoozed: { until: '2026-11-02' } } } as Task, all, { now: NOW, running: false }))
      .toEqual({ due: false, why: 'snoozed' })
    expect(briefRefreshDue({ ...owner, brief: undefined } as Task, all, { now: NOW, running: false })).toEqual({ due: false, why: 'no_brief' })
  })

  // Guard: every org role that keeps a Brief is one a refresh can reach. A new role that keeps a
  // Brief (keepsBrief) fails here until brief-refresh.ts and brief-fresh.ts take it.
  it('covers every org role that keeps a Brief', () => {
    // The roles, read from the source: a new OrgRole member joins this check by itself.
    const src = readFileSync(join(process.cwd(), 'src/core/types.ts'), 'utf8')
    const roles = [...(src.match(/export type OrgRole = ([^;]+);/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(roles.length).toBeGreaterThanOrEqual(2)
    for (const role of roles) {
      if (!keepsBrief({ org_role: role as Task['org_role'] })) continue
      seed('lead', true)
      const owner = { ...tasks.get('L')!, org_role: role } as Task
      expect(briefRefreshDue(owner, [...tasks.values()], { now: NOW, running: false }).due, `role ${role}`).toBe(true)
    }
  })
})
