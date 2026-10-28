/** What a lead hears about its teams before its next message (src/core/org/team-note.ts), pure part. */
import { describe, it, expect } from 'vitest'
import { buildTeamNoteText, groupTeamAsks, planTeamNote, teamFingerprint, TEAM_NOTE_MAX } from '../../../src/core/org/team-note.js'
import type { TeamNewsTask } from '../../../src/core/org/team-news.js'

const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 12, min)).toISOString()
const NOW = at(60)
const lead = { id: 'lead-1', title: 'Garden lead' }

function t(id: string, extra: Partial<TeamNewsTask> = {}): TeamNewsTask {
  return { id, title: `${id} title`, phase: 'IN_PROGRESS', updated_at: at(0), ...extra }
}

const base = [
  t('a', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', now: 'Drafted the email', at: at(10) } }),
  t('b', { user_status: { state: 'working', now: 'Running the suite', at: at(20) } }),
  t('c', { phase: 'TODO', user_status: { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' } }),
]

describe('team note plan', () => {
  it('first tells where the teams stand: what needs the user and the newest own words', () => {
    const plan = planTeamNote(undefined, [...base, t('d', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Sign it', at: at(30) } })], [], NOW)
    expect(plan.kind).toBe('now')
    expect(plan.needs.map((i) => i.taskId)).toEqual(['d'])
    // Walnut's own "Not started yet" is not news.
    expect(plan.moved.map((i) => i.taskId)).toEqual(['b', 'a'])
    expect(Object.keys(plan.next.seen).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a task the status sync has not read yet is never news, whatever its phase', () => {
    const unread = [t('u', { phase: 'NEED_ACTION' }), t('v')]
    const first = planTeamNote(undefined, unread, [], NOW)
    expect(first.kind).toBe('none')
    // Read later as a plain wait: still nothing; read as a real ask: told.
    const plain = [t('u', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', waitingOn: 'You' } }), t('v', { user_status: { state: 'working' } })]
    expect(planTeamNote(first.next, plain, [], NOW).kind).toBe('none')
    const asks = [t('u', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Sign it' } }), t('v')]
    expect(planTeamNote(first.next, asks, [], NOW).needs.map((i) => i.taskId)).toEqual(['u'])
  })

  it('a first look with nothing to say records itself and says nothing', () => {
    const plan = planTeamNote(undefined, [t('c', { phase: 'TODO' })], [], NOW)
    expect(plan.kind).toBe('none')
    expect(plan.next.seen.c).toBeDefined()
  })

  it('later tells only what moved: new words, a new ask, a task stuck, new and finished tasks', () => {
    const prev = planTeamNote(undefined, base, [], at(40)).next
    expect(planTeamNote(prev, base, [], NOW).kind).toBe('none')
    // A turn that only started or ended (same words, same time) is no news.
    const flipped = [base[0]!, t('b', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', now: 'Running the suite', at: at(45) } }), base[2]!]
    expect(planTeamNote(prev, flipped, [], NOW).kind).toBe('none')
    // Words that went away (a report with nothing new) are recorded, not told.
    const quiet = [base[0]!, t('b', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', waitingOn: 'You' } }), base[2]!]
    const gone = planTeamNote(prev, quiet, [], NOW)
    expect(gone.kind).toBe('none')
    expect(gone.next.seen.b).not.toBe(prev.seen.b)

    const later = [
      t('a', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', now: 'Passed the identity check; only your signature is left', at: at(50) } }),
      t('b', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Approve the deploy', at: at(55) } }),
      t('c', { phase: 'TODO', user_status: { state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it' } }),
      t('e', { user_status: { state: 'working', now: 'Started on the port', at: at(58) } }),
    ]
    const plan = planTeamNote(prev, later, [{ id: 'gone-new', title: 'never told' }], NOW)
    expect(plan.kind).toBe('moved')
    expect(plan.needs.map((i) => i.taskId)).toEqual(['b'])
    expect(plan.moved.map((i) => i.taskId)).toEqual(['a', 'c'])
    expect(plan.added.map((i) => i.taskId)).toEqual(['e'])
    // Only a task the lead was told about is reported done.
    expect(plan.done).toEqual([])
    const told = planTeamNote(plan.next, later.slice(1), [{ id: 'a', title: 'a title' }], NOW)
    expect(told).toMatchObject({ kind: 'moved', done: ['a title'], needs: [], moved: [], added: [] })
  })

  it('the fingerprint moves with the ask and the session\'s words, not with a turn or a phase', () => {
    const ask = (text: string) => t('x', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: text } })
    expect(teamFingerprint(ask('Sign it'))).not.toBe(teamFingerprint(ask('Send the scan')))
    expect(teamFingerprint(t('x', { user_status: { state: 'working', at: at(1) } })))
      .toBe(teamFingerprint(t('x', { phase: 'NEED_ACTION', user_status: { state: 'waiting', at: at(1) } })))
    // Every turn end writes a report with a new time: the same words again are no news.
    const said = (words: string, min: number) => t('x', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', now: words, at: at(min) } })
    expect(teamFingerprint(said('Running the suite', 1))).toBe(teamFingerprint(said('Running the suite', 9)))
    expect(teamFingerprint(said('Running the suite', 1))).not.toBe(teamFingerprint(said('The suite passed', 9)))
    // What Walnut says a task waits on after a phase move is not the lead's news.
    const waits = (waitingOn: string) => t('x', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'task', waitingOn } })
    expect(teamFingerprint(waits('Not started yet'))).toBe(teamFingerprint(waits('Its worker (1 open)')))
  })
})

describe('team note text', () => {
  it('reads as one Walnut notification: sections, times, words, and counts past the cap', () => {
    const prev = planTeamNote(undefined, [], [], at(0)).next
    const many = Array.from({ length: TEAM_NOTE_MAX.added + 2 }, (_, i) => t(`n${i}`, { updated_at: at(i), user_status: { state: 'working', now: `Step ${i}`, at: at(i) } }))
    const plan = planTeamNote(prev, [t('d', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Sign it', at: at(30) } }), ...many], [], NOW)
    const text = buildTeamNoteText(lead, plan, at(0), Date.parse(NOW), (id) => (id === 'd' ? 'Seeds' : 'Garden'))
    expect(text).toContain('outcome="org-update"')
    expect(text).toContain('about-task="lead-1"')
    expect(text).toContain('Team update (last note 1 h ago)')
    expect(text).toContain('Needs the user:\n- [Seeds] "d title": Sign it')
    expect(text).toContain(`- [Garden] "n${TEAM_NOTE_MAX.added + 1} title" (working, ${60 - TEAM_NOTE_MAX.added - 1} min ago): Step ${TEAM_NOTE_MAX.added + 1}`)
    expect(text).toContain('- and 2 more')
    expect(text).toContain('Background, not a request')
  })

  it('the first note says where things stand, without project names for one project', () => {
    const plan = planTeamNote(undefined, base, [], NOW)
    const text = buildTeamNoteText(lead, plan, undefined, Date.parse(NOW))
    expect(text).toContain('Your teams now, from their own status:')
    expect(text).toContain('Latest:\n- "b title" (working, 40 min ago): Running the suite\n- "a title" (waiting, 50 min ago): Drafted the email')
    expect(text).not.toContain('[')
  })
})

describe('what waits on the lead, what it leads, what others asked', () => {
  const LEAD = 'lead-1'
  const ctx = { leadId: LEAD, led: ['Garden'] }
  const waiting = (id: string, extra: Partial<TeamNewsTask> = {}) => t(id, {
    phase: 'NEED_ACTION', parent_task_id: LEAD,
    user_status: { state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to check the result and close it', now: 'Fixed the parser', at: at(50) },
    ...extra,
  })

  it('a task that now waits on this lead is told once, under its own section', () => {
    const prev = planTeamNote(undefined, base, [], at(40), ctx).next
    const plan = planTeamNote(prev, [...base.slice(0, 2), waiting('c')], [], NOW, ctx)
    expect(plan.kind).toBe('moved')
    expect(plan.waits.map((w) => [w.taskId, w.waitingOn])).toEqual([['c', 'Its lead, to check the result and close it']])
    expect(plan.moved).toEqual([])
    // Told: the same wait again is no news, and so is its end.
    expect(planTeamNote(plan.next, [...base.slice(0, 2), waiting('c')], [], NOW, ctx).kind).toBe('none')
    const ended = [...base.slice(0, 2), t('c', { user_status: { state: 'working', now: 'Fixed the parser', at: at(50) } })]
    expect(planTeamNote(plan.next, ended, [], NOW, ctx).kind).toBe('none')
    // The same worker waiting again after another turn is a new wait, told again, with no note
    // in between (the lead answered it with a plain message, which carries none).
    const again = [...base.slice(0, 2), waiting('c', { phase_changed_at: at(58), user_status: { state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to check the result and close it', now: 'Fixed the parser', at: at(50) } })]
    expect(planTeamNote(plan.next, again, [], NOW, ctx).waits.map((w) => w.taskId)).toEqual(['c'])
    // Waiting on another leader is that leader's: not this lead's to act on.
    const other = planTeamNote(prev, [...base.slice(0, 2), waiting('c', { parent_task_id: 'someone-else' })], [], NOW, ctx)
    expect(other.waits).toEqual([])
  })

  it('the first note names what waits on the lead and the projects it leads', () => {
    const plan = planTeamNote(undefined, [...base, waiting('w')], [], NOW, { leadId: LEAD, led: ['Seeds', 'Garden'] })
    expect(plan.waits.map((w) => w.taskId)).toEqual(['w'])
    expect(plan.moved.map((i) => i.taskId)).not.toContain('w')
    const text = buildTeamNoteText(lead, plan, undefined, Date.parse(NOW))
    expect(text).toContain('You lead "Garden", "Seeds".')
    expect(text).toContain('Waiting on you:\n- "w title" (10 min ago): Its lead, to check the result and close it. It said: Fixed the parser')
    expect(text).toContain('wait for you: read each (task_get) and answer or close it')
    expect(text).not.toContain('Background, not a request')
  })

  it('a project taken over or let go is news, told as one line, its tasks not one by one', () => {
    const prev = planTeamNote(undefined, base, [], at(40), ctx).next
    const idea = [t('i1', { project: 'Idea', user_status: { state: 'working', now: 'Sketching', at: at(55) } }), t('i2', { project: 'Idea' })]
    const plan = planTeamNote(prev, [...base, ...idea], [], NOW, { leadId: LEAD, led: ['Garden', 'Idea'] })
    expect([plan.kind, plan.ledAdded, plan.added]).toEqual(['moved', ['Idea'], []])
    expect(buildTeamNoteText(lead, plan, at(40), Date.parse(NOW))).toContain('You lead "Garden", "Idea". New to you: "Idea".')
    const gone = planTeamNote(plan.next, base, [], NOW, ctx)
    expect([gone.kind, gone.ledRemoved]).toEqual(['moved', ['Idea']])
    // A state from before Walnut kept the led projects: recorded, not news.
    expect(planTeamNote({ at: prev.at, seen: prev.seen }, base, [], NOW, ctx).kind).toBe('none')
  })

  it('asks from outside the team are news, with who asked and what', () => {
    const prev = planTeamNote(undefined, base, [], at(40), ctx).next
    const asks = [{ id: 'k1', taskId: 'a', title: 'a title', from: 'Main', gist: 'Also check the fence', at: at(58) }]
    const plan = planTeamNote(prev, base, [], NOW, { ...ctx, asks })
    expect(plan.kind).toBe('moved')
    expect(buildTeamNoteText(lead, plan, at(40), Date.parse(NOW))).toContain('Asked of your teams by others:\n- "a title": Main added (2 min ago): "Also check the fence"\n')
  })

  it('everything asked of one task is one line: the user\'s chat with its count and latest words, then each other sender', () => {
    const prev = planTeamNote(undefined, base, [], at(40)).next
    const ask = (id: string, min: number, extra: Record<string, unknown>) =>
      ({ id, taskId: 'a', title: 'a title', from: 'the user', gist: '', at: at(min), ...extra })
    // An older Walnut's rows: one per message, the question kept as its banner line.
    const asks = [
      ask('q1', 41, { gist: 'Who removes the finalizer?', question: 12 }),
      ask('q2', 42, { gist: '[Question Q12]' }),
      ask('q3', 43, { gist: '[Question Q13]' }),
      ask('q4', 44, { gist: '[Question Q12]' }),
      ask('q5', 45, { gist: '[Question Q13]' }),
      ask('c1', 46, { gist: 'sure, what else to decide?' }),
      ask('c2', 47, { gist: '(Back to the main conversation)' }),
      ask('c3', 48, { gist: 'is the big function async?', count: 2, lastAt: at(50) }),
      { id: 'm1', taskId: 'a', title: 'a title', from: 'Main', by: 'peer', gist: 'Check the fence too', at: at(49) },
    ]
    const lines = groupTeamAsks(asks)
    expect(lines.map((l) => [l.rows.map((r) => r.id), l.count])).toEqual([
      [['q1', 'q2', 'q4'], 3], [['q3', 'q5'], 2], [['m1'], 1], [['c1', 'c2', 'c3'], 4],
    ])
    const text = buildTeamNoteText(lead, planTeamNote(prev, base, [], NOW, { ...ctx, asks }), at(40), Date.parse(NOW))
    expect(text).toContain('Asked of your teams by others:\n'
      + '- "a title": the user is talking with it in its own chat (9 messages, the latest 10 min ago): "is the big function async?"; '
      + 'Main added (11 min ago): "Check the fence too"\n')
    // Several tasks: one line each, the newest last, the rest counted.
    const many = Array.from({ length: TEAM_NOTE_MAX.asks + 2 }, (_, i) => ({ id: `t${i}`, taskId: `task-${i}`, title: `task ${i}`, from: 'Main', by: 'peer' as const, gist: `Do ${i}`, at: at(41 + i) }))
    const told = buildTeamNoteText(lead, planTeamNote(prev, base, [], NOW, { ...ctx, asks: many }), at(40), Date.parse(NOW))
    expect(told.match(/^- "task \d+": Main added/gm)).toHaveLength(TEAM_NOTE_MAX.asks)
    expect(told).toContain(`- "task ${TEAM_NOTE_MAX.asks + 1}": Main added`)
    expect(told).toContain('- and 2 more tasks, in the next note')
    expect(text).not.toContain('[Question')
    expect(text).not.toContain('Back to the main')
  })
})

// 2026-10-28: a host drop and a full disk put tasks under "Needs the user now". The lead is the one
// to bring them back when Walnut cannot, so its note says it, once per stop.
describe('team note: stopped by the machine', () => {
  const machine = (id: string, waitingOn = 'Its host to come back: Walnut reconnects and resumes it by itself') =>
    t(id, { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'machine', waitingOn, stoppedBy: 'machine' } })

  it('first note: the stopped tasks have their own section and an instruction to restart them', () => {
    const plan = planTeamNote(undefined, [...base, machine('m')], [], NOW)
    expect(plan.machine.map((i) => i.taskId)).toEqual(['m'])
    expect(plan.moved.map((i) => i.taskId)).not.toContain('m')
    const text = buildTeamNoteText(lead, plan, undefined, Date.parse(NOW))
    expect(text).toContain('Stopped by the machine, not the work')
    expect(text).toContain('"m title"')
    expect(text).toContain('Its host to come back')
    expect(text).toContain('restart it (task_restart)')
    expect(text).toContain('Tell the user only what you cannot fix yourself')
    expect(text).not.toContain('Needs the user:')
  })

  it('later: a new stop is told once; the same stop again is no news; a lost-then-back task is recorded', () => {
    const prev = planTeamNote(undefined, base, [], at(40)).next
    const stopped = planTeamNote(prev, [...base.slice(0, 2), machine('c')], [], NOW)
    expect(stopped.kind).toBe('moved')
    expect(stopped.machine.map((i) => i.taskId)).toEqual(['c'])
    expect(planTeamNote(stopped.next, [...base.slice(0, 2), machine('c')], [], NOW).kind).toBe('none')
    // A task that reported waiting on the machine itself (the disk) is in the same section.
    const disk = t('c', { phase: 'WAITING', user_status: { state: 'waiting', kind: 'machine', waitingOn: 'Free disk on the Walnut server', now: 'Tests passed; the commit waits on disk space', at: at(55) } })
    expect(planTeamNote(prev, [...base.slice(0, 2), disk], [], NOW).machine.map((i) => i.taskId)).toEqual(['c'])
    // No instruction when nothing stopped.
    expect(buildTeamNoteText(lead, planTeamNote(undefined, base, [], NOW), undefined, Date.parse(NOW))).not.toContain('task_restart')
  })
})
