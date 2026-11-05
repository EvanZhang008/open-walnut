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
import * as SAME from '../../../src/core/same-ask.js'

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

  // 2026-11-04: three VPs each told the user "nothing changed, only reworded" after a refresh named
  // a reworded ask as moved. The same ask in other words is no move; another ask, or the same words
  // asked another way (a Board choice, a yes/no), is.
  it('an ask in other words is no move; another ask, more numbers or another way to answer is', () => {
    const { owner, tasks } = written()
    const ask = (s: Partial<NonNullable<Task['user_status']>>) => tasks.map((t) => t.id === 'a' ? task('a', { state: 'needs', source: 'session', ask: 'Review section 3', ...s }) : t)
    expect(briefFreshness(owner, ask({ ask: 'Please review section 3 when you can' }))!.stale).toBe(false)
    expect(briefFreshness(owner, ask({ ask: 'Could you review section 3?' }))!.stale).toBe(false)
    expect(briefFreshness(owner, ask({ ask: 'Approve the production deploy plan' }))!.moved.map((m) => m.id)).toEqual(['a'])
    expect(briefFreshness(owner, ask({ ask: 'Review sections 3 and 4' }))!.moved.map((m) => m.id)).toEqual(['a'])
    expect(briefFreshness(owner, ask({ source: 'choice', choice: { board: 'lead', id: 'c1' } }))!.moved.map((m) => m.id)).toEqual(['a'])
    expect(briefFreshness(owner, ask({ askForm: { summary: 'Review section 3', kind: 'yes_no' } }))!.moved.map((m) => m.id)).toEqual(['a'])
  })

  // 2026-11-05 review: overlap alone called these the same ask.
  it('another target, the other direction or a "not" is a move, however many words stay', () => {
    const { owner } = (() => {
      const tasks = [task('a', { state: 'needs', source: 'session', ask: 'Approve deleting the staging database' }), ...world().slice(1)]
      return { owner: lead({ text: LETTER, at: T0, ...briefSnapshot(LETTER, lead(), tasks) }) }
    })()
    const now = (ask: string) => [task('a', { state: 'needs', source: 'session', ask }), ...world().slice(1)]
    expect(briefFreshness(owner, now('Approve deleting the production database'))!.stale).toBe(true)
    expect(briefFreshness(owner, now('Do not approve deleting the staging database'))!.stale).toBe(true)
    expect(briefFreshness(owner, now('Please approve deleting the staging database now'))!.stale).toBe(false)
    const { sameAskReworded } = SAME
    expect(sameAskReworded('Approve migrating staging to production', 'Approve migrating production to staging')).toBe(false)
    expect(sameAskReworded('Approve publishing the release', 'Do not approve publishing the release')).toBe(false)
    expect(sameAskReworded('Approve publishing the 2.4 release to the store', 'Can you approve publishing the 2.4 release to the store today?')).toBe(true)
  })

  // 2026-11-05 review, round 2: a long ask diluted the swap, and a two-word swap passed.
  it('a direction or target change in a long ask is a move too, through the stored mark', () => {
    const start = (ask: string) => {
      const tasks = [task('a', { state: 'needs', source: 'session', ask }), ...world().slice(1)]
      return lead({ text: LETTER, at: T0, ...briefSnapshot(LETTER, lead(), tasks) })
    }
    const now = (ask: string) => [task('a', { state: 'needs', source: 'session', ask }), ...world().slice(1)]
    const migrate = start('Approve migrating account records from staging to production')
    expect(briefFreshness(migrate, now('Approve migrating account records from production to staging'))!.stale).toBe(true)
    expect(briefFreshness(migrate, now('Can we migrate the account records from staging to production, after the backup finishes?'))!.stale).toBe(false)
    // Round 3: the targets share their first words ("the old ... database").
    const long = start('Approve carefully migrating customer account records from the old staging database to the old production database')
    expect(briefFreshness(long, now('Approve carefully migrating customer account records from the old production database to the old staging database'))!.stale).toBe(true)
    expect(briefFreshness(long, now('Please approve carefully migrating the customer account records from the old staging database to the old production database tonight'))!.stale).toBe(false)
    const drop = start('Approve deleting the staging account database')
    expect(briefFreshness(drop, now('Approve deleting the production customer database'))!.stale).toBe(true)
    const { sameAskReworded } = SAME
    // "Move the data from the test environment to production" against the other way round.
    expect(sameAskReworded('\u8bf7\u628a\u6570\u636e\u4ece\u6d4b\u8bd5\u73af\u5883\u8fc1\u79fb\u5230\u751f\u4ea7\u73af\u5883\uff0c\u53ef\u4ee5\u5417\uff1f',
      '\u8bf7\u628a\u6570\u636e\u4ece\u751f\u4ea7\u73af\u5883\u8fc1\u79fb\u5230\u6d4b\u8bd5\u73af\u5883\uff0c\u53ef\u4ee5\u5417\uff1f')).toBe(false)
  })

  it('Chinese asks: the same ask reworded is no move, a different one is', () => {
    const zh = (ask: string) => [task('a', { state: 'needs', source: 'session', ask }), ...world().slice(1)]
    const before = zh('\u0058 \u4e0a\u7684\u5e16\u5b50\u4ee5\u540e\u7531\u6211\u4eec\u5199\u8349\u7a3f\uff0c\u4f60\u4eb2\u624b\u5728\u624b\u673a\u4e0a\u53d1\u51fa\u53bb\uff0c\u884c\u5417\uff1f')
    const owner = lead({ text: LETTER, at: T0, ...briefSnapshot(LETTER, lead(), before) })
    // Same ask, other words: "drafts by us, you post them by hand on the phone".
    expect(briefFreshness(owner, zh('\u0058 \u4e0a\u7684\u5e16\u5b50\u548c\u56de\u590d\u4ee5\u540e\u7531\u6211\u4eec\u5199\u8349\u7a3f\uff0c\u4f60\u4eb2\u624b\u5728\u624b\u673a\u4e0a\u6253\u5b57\u53d1\u51fa\u53bb\uff0c\u884c\u5417\uff1f'))!.stale).toBe(false)
    // Another ask: "scan the QR code once to sign in".
    expect(briefFreshness(owner, zh('\u8bf7\u7528\u624b\u673a\u626b\u4e00\u6b21\u4e8c\u7ef4\u7801\u767b\u5f55\u5c0f\u7ea2\u4e66'))!.stale).toBe(true)
  })

  it('a letter whose marks were stored before the reword rule compares them as written', () => {
    const tasks = world()
    const marks = { a: markHash('needs|Review section 3'), b: markHash('open'), c: markHash('open') }
    const owner = lead({ text: LETTER, at: T0, marks, asks: ['a'] })
    expect(briefFreshness(owner, tasks)!.stale).toBe(false)
    expect(briefFreshness(owner, tasks.map((t) => t.id === 'a' ? task('a', { state: 'needs', source: 'session', ask: 'Please review section 3' }) : t))!.stale).toBe(true)
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
