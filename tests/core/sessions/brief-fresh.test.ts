/**
 * Is a Brief still current (src/core/sessions/brief-fresh.ts)? A line moved when its task's status
 * mark (state, what it asks the user, on whom it waits) differs from the one stored as the letter
 * was written; a letter stored before marks is read by its sections; a team ask the letter does
 * not name and that was not asking then is new. Main's lines name the VP second: only the first
 * pill is the line's task.
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../../src/core/types.js'
import {
  briefFreshness, briefLineTasks, briefSnapshot, briefUpdating, freshnessWords, liveWords, markHash, statusMark,
  BRIEF_UPDATING_SHOW_MS,
} from '../../../src/core/sessions/brief-fresh.js'
import { seenOf } from '../../../src/core/sessions/status-push.js'

const T0 = '2026-10-31T13:03:02.720Z'
const lead = (brief?: Task['brief']): Task => ({
  id: 'lead', title: 'Marina lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Marina',
  ...(brief ? { brief } : {}),
}) as Task
const task = (id: string, s: Partial<NonNullable<Task['user_status']>> & { state: NonNullable<Task['user_status']>['state'] }, extra: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, phase: s.state === 'done' ? 'COMPLETE' : s.state === 'needs' ? 'NEED_ACTION' : s.state === 'working' ? 'IN_PROGRESS' : 'WAITING',
  status: 'in_progress', project: 'Marina', user_status: s, ...extra,
}) as Task

const LETTER = [
  '### Needs you',
  '- <task-ref id="a" label="A"/>: review section 3, reply "next".',
  '### Working',
  '- <task-ref id="b" label="B"/>: running the integration test.',
  '### Waiting / snoozed',
  '- <task-ref id="c" label="C"/>: waits on the review.',
].join('\n')

function world() {
  return [
    task('a', { state: 'needs', source: 'session', ask: 'Review section 3' }),
    task('b', { state: 'working', now: 'running the integration test' }),
    task('c', { state: 'waiting', kind: 'task', waitingOn: 'The review' }),
    task('d', { state: 'waiting', kind: 'task', waitingOn: 'A deploy' }),
  ]
}

describe('statusMark', () => {
  it('is the one key status-push tells a move by', () => {
    for (const t of world()) expect(seenOf(t).key).toBe(statusMark(t))
  })
  it("a Working task's progress words are no move; its ask or its wait is", () => {
    const [a, b, c] = world()
    expect(statusMark({ ...b!, user_status: { state: 'working', now: 'other words' } })).toBe(statusMark(b!))
    expect(statusMark({ ...a!, user_status: { ...a!.user_status!, ask: 'Review section 4' } })).not.toBe(statusMark(a!))
    expect(statusMark({ ...c!, user_status: { ...c!.user_status!, waitingOn: 'The deploy' } })).not.toBe(statusMark(c!))
  })
  it('hashes to a short stable string', () => {
    expect(markHash('needs||x')).toBe(markHash('needs||x'))
    expect(markHash('needs||x')).not.toBe(markHash('needs||y'))
    expect(markHash('needs||x').length).toBeLessThanOrEqual(7)
  })
})

describe('briefLineTasks', () => {
  it("names each line's first task with its section, skipping the owner; Main's VP pill is second", () => {
    const text = '### Needs you\n- <task-ref id="w" label="W"/> (VP <task-ref id="vp" label="VP"/>): pick one.\n- <task-ref id="main" label="Main"/>: my own.\n### Working\n- <task-ref id="x" label="X"/>: on it.'
    expect(briefLineTasks(text, 'main')).toEqual([{ id: 'w', section: 'needs' }, { id: 'x', section: 'working' }])
  })
})

describe('briefFreshness', () => {
  const written = () => {
    const tasks = world()
    const owner = lead({ text: LETTER, at: T0, ...briefSnapshot(LETTER, lead(), tasks) })
    return { owner, tasks }
  }

  it('a letter written from the live state is current', () => {
    const { owner, tasks } = written()
    expect(owner.brief!.marks).toEqual({ a: expect.any(String), b: expect.any(String), c: expect.any(String) })
    expect(owner.brief!.asks).toEqual(['a'])
    expect(briefFreshness(owner, tasks)).toEqual({ writtenAt: T0, moved: [], finished: [], newAsks: [], stale: false })
  })

  it('the user answered one ask and a waiting task finished: one line moved with its live words, one finished', () => {
    const { owner, tasks } = written()
    const now = tasks.map((t) => t.id === 'a' ? task('a', { state: 'working', now: 'writing section 4' })
      : t.id === 'c' ? task('c', { state: 'done' }) : t)
    const f = briefFreshness(owner, now)!
    expect(f.moved).toEqual([{ id: 'a', state: 'working', words: 'writing section 4' }])
    expect(f.finished).toEqual(['c'])
    expect(f.stale).toBe(true)
    expect(freshnessWords(f)).toBe('1 line moved since · 1 finished')
  })

  it('a line that only moved between Working and Waiting is no move (every turn of a worker flips it)', () => {
    const { owner, tasks } = written()
    const now = tasks.map((t) => t.id === 'b' ? task('b', { state: 'waiting', kind: 'lead', waitingOn: 'Its lead' })
      : t.id === 'c' ? task('c', { state: 'working', now: 'reviewing' }) : t)
    expect(briefFreshness(owner, now)!.stale).toBe(false)
    // Nor in a letter stored before marks.
    expect(briefFreshness(lead({ text: LETTER, at: T0 }), now)!.stale).toBe(false)
  })

  it('progress words of a Working line are no move', () => {
    const { owner, tasks } = written()
    const now = tasks.map((t) => t.id === 'b' ? task('b', { state: 'working', now: 'the test passed, writing docs' }) : t)
    expect(briefFreshness(owner, now)!.stale).toBe(false)
  })

  it('a new ask the letter does not name is counted; one that already asked when it was written is not', () => {
    const { owner, tasks } = written()
    const now = tasks.map((t) => t.id === 'd' ? task('d', { state: 'needs', source: 'session', ask: 'Approve the deploy' }) : t)
    const f = briefFreshness(owner, now)!
    expect(f.moved).toEqual([])
    expect(f.newAsks).toEqual(['d'])
    expect(freshnessWords(f)).toBe('1 ask added by Walnut')
    // Written while d already asked (left out of the letter): not new.
    const owner2 = lead({ text: LETTER, at: T0, ...briefSnapshot(LETTER, lead(), now) })
    expect(briefFreshness(owner2, now)!.stale).toBe(false)
  })

  it('a task between its turn end and its report is not judged yet', () => {
    const { owner, tasks } = written()
    const now = tasks.map((t) => t.id === 'a' ? task('a', { state: 'waiting', kind: 'other', waitingOn: 'Its report', transient: true }) : t)
    expect(briefFreshness(owner, now)!.stale).toBe(false)
  })

  it('a letter stored before marks: a line whose task changed section moved, a new ask after it is new', () => {
    const owner = lead({ text: LETTER, at: T0 })
    const tasks = world().map((t) => t.id === 'a' ? task('a', { state: 'waiting', kind: 'task', waitingOn: 'The reviewer' })
      : t.id === 'd' ? task('d', { state: 'needs', ask: 'Approve', at: '2026-10-31T15:00:00Z' }) : t)
    const f = briefFreshness(owner, tasks)!
    expect(f.moved.map((m) => m.id)).toEqual(['a'])
    expect(f.newAsks).toEqual(['d'])
    expect(briefFreshness(owner, world())!.stale).toBe(false)
  })

  it("Main's asks cover the whole org, not only its leads", () => {
    const main: Task = { id: 'main', title: 'Main', phase: 'WAITING', status: 'in_progress', org_role: 'main' } as Task
    const text = '### Needs you\n- <task-ref id="a" label="A"/> (VP <task-ref id="lead" label="L"/>): review.\n### Working\n- None\n### Waiting / snoozed\n- None'
    const tasks = [lead(), ...world()]
    const owner = { ...main, brief: { text, at: T0, ...briefSnapshot(text, main, tasks) } } as Task
    expect(owner.brief!.asks).toEqual(['a'])
    const now = tasks.map((t) => t.id === 'd' ? task('d', { state: 'needs', ask: 'Approve' }) : t)
    expect(briefFreshness(owner, now)!.newAsks).toEqual(['d'])
  })

  it('a task that keeps no Brief, or has none, has no freshness', () => {
    expect(briefFreshness({ ...lead({ text: LETTER, at: T0 }), org_role: undefined } as Task, world())).toBeNull()
    expect(briefFreshness(lead(), world())).toBeNull()
  })
})

describe('liveWords', () => {
  it('says what the task asks, waits on, does, or that it is snoozed', () => {
    expect(liveWords(task('x', { state: 'needs', ask: 'Pick one' }))).toBe('Pick one')
    expect(liveWords(task('x', { state: 'waiting', kind: 'task', waitingOn: 'The review' }))).toBe('Waiting on The review')
    expect(liveWords(task('x', { state: 'waiting', snoozed: { until: '2026-11-02T08:00:00Z' } } as never))).toBe('Snoozed until 2026-11-02')
    expect(liveWords(task('x', { state: 'working' }))).toBe('Working')
  })
})

describe('briefUpdating', () => {
  const at = Date.parse('2026-10-31T17:00:00Z')
  it('while a refresh asked after the letter has not landed, for a while', () => {
    const owner = { brief: { text: 'x', at: T0 }, brief_refresh: { at: new Date(at).toISOString(), by: 'web' as const, moved: 2 } }
    expect(briefUpdating(owner, at + 1000)).toBe(true)
    expect(briefUpdating(owner, at + BRIEF_UPDATING_SHOW_MS + 1)).toBe(false)
    expect(briefUpdating({ ...owner, brief: { text: 'y', at: new Date(at + 60_000).toISOString() } }, at + 61_000)).toBe(false)
    expect(briefUpdating({ brief: owner.brief }, at)).toBe(false)
    // A note that could not be delivered is not on its way.
    expect(briefUpdating({ ...owner, brief_refresh: { ...owner.brief_refresh, failed: true } }, at + 1000)).toBe(false)
  })
})
