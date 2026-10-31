/** What a lead hears about its teams before its next message (src/core/org/team-note.ts), pure part. */
import { describe, it, expect } from 'vitest'
import { buildTeamNoteText, groupTeamAsks, noteDue, planTeamNote, teamFingerprint, TEAM_NOTE_FORM, TEAM_NOTE_GAP_MS, TEAM_NOTE_MAX } from '../../../src/core/org/team-note.js'
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

  it('later tells only what moved: a new ask, a task stuck, finished tasks; never progress or a new task', () => {
    const prev = planTeamNote(undefined, base, [], at(40)).next
    expect(planTeamNote(prev, base, [], NOW).kind).toBe('none')
    // A turn that only started or ended (same words, same time) is no news.
    const flipped = [base[0]!, t('b', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', now: 'Running the suite', at: at(45) } }), base[2]!]
    expect(planTeamNote(prev, flipped, [], NOW).kind).toBe('none')
    // Words that went away, or new progress words, are no news either.
    const quiet = [base[0]!, t('b', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', waitingOn: 'You' } }), base[2]!]
    expect(planTeamNote(prev, quiet, [], NOW).kind).toBe('none')
    const progress = [base[0]!, t('b', { user_status: { state: 'working', now: 'Running the type check', at: at(58) } }), base[2]!]
    expect(planTeamNote(prev, progress, [], NOW).kind).toBe('none')

    const later = [
      t('a', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', now: 'Passed the identity check; only your signature is left', at: at(50) } }),
      t('b', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Approve the deploy', at: at(55) } }),
      t('c', { phase: 'TODO', user_status: { state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it' } }),
      t('e', { user_status: { state: 'working', now: 'Started on the port', at: at(58) } }),
    ]
    const plan = planTeamNote(prev, later, [{ id: 'gone-new', title: 'never told' }], NOW)
    expect(plan.kind).toBe('moved')
    expect(plan.needs.map((i) => i.taskId)).toEqual(['b'])
    // 'a' only said new words and 'e' is new: progress, not news.
    expect(plan.moved.map((i) => i.taskId)).toEqual(['c'])
    // Only a task the lead was told about is reported done.
    expect(plan.done).toEqual([])
    const told = planTeamNote(plan.next, later.slice(1), [{ id: 'a', title: 'a title' }], NOW)
    expect(told).toMatchObject({ kind: 'moved', done: ['a title'], needs: [], moved: [] })
  })

  it('the fingerprint moves with the ask and being stuck, not with progress words, a turn or a phase', () => {
    const ask = (text: string) => t('x', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: text } })
    expect(teamFingerprint(ask('Sign it'))).not.toBe(teamFingerprint(ask('Send the scan')))
    expect(teamFingerprint(t('x', { user_status: { state: 'working', at: at(1) } })))
      .toBe(teamFingerprint(t('x', { phase: 'NEED_ACTION', user_status: { state: 'waiting', at: at(1) } })))
    const said = (words: string, min: number) => t('x', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'you', now: words, at: at(min) } })
    expect(teamFingerprint(said('Running the suite', 1))).toBe(teamFingerprint(said('The suite passed', 9)))
    expect(teamFingerprint(said('Running the suite', 1)))
      .not.toBe(teamFingerprint(t('x', { user_status: { state: 'waiting', kind: 'stuck', now: 'Running the suite', at: at(1) } })))
    // What Walnut says a task waits on after a phase move is not the lead's news.
    const waits = (waitingOn: string) => t('x', { phase: 'NEED_ACTION', user_status: { state: 'waiting', kind: 'task', waitingOn } })
    expect(teamFingerprint(waits('Not started yet'))).toBe(teamFingerprint(waits('Its worker (1 open)')))
  })
})

describe('team note text', () => {
  it('reads as one Walnut notification: sections, times, words, and counts past the cap', () => {
    const prev = planTeamNote(undefined, [], [], at(0)).next
    const many = Array.from({ length: TEAM_NOTE_MAX.moved + 2 }, (_, i) => t(`n${i}`, { updated_at: at(i), user_status: { state: 'waiting', kind: 'stuck', now: `Step ${i}`, at: at(i) } }))
    const plan = planTeamNote(prev, [t('d', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Sign it', at: at(30) } }), ...many], [], NOW)
    const text = buildTeamNoteText(lead, plan, at(0), Date.parse(NOW), (id) => (id === 'd' ? 'Seeds' : 'Garden'))
    expect(text).toContain('outcome="org-update"')
    expect(text).toContain('about-task="lead-1"')
    expect(text).toContain('Team update (last note 1 h ago)')
    expect(text).toContain('Needs the user:\n- [Seeds] "d title": Sign it')
    expect(text).toContain('Stuck (nothing will wake it):\n- [Garden] "n9 title" (waiting, 51 min ago): Step 9')
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
    expect([plan.kind, plan.ledAdded, plan.moved]).toEqual(['moved', ['Idea'], []])
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

// 2026-10-31, the org's reflection: the Walnut lead got 80 notes in 12 hours (about 200K characters),
// most of them progress such as '(working, 3 min ago): running type check'. A later note carries only
// what the lead may act on or must know: what needs the user, waits on it, stopped, stuck, done, or
// was asked of its teams. Progress, in any section, must not come back.
describe('team note: no progress lines, paced like the main agent\'s', () => {
  const LEAD = 'lead-1'
  const ctx = { leadId: LEAD, led: ['Garden'] }
  // Every status a team task can show, each with its own progress words.
  const statuses: NonNullable<TeamNewsTask['user_status']>[] = [
    { state: 'working', now: 'Running the type check' },
    { state: 'working', now: 'Type check passed; running the suite' },
    { state: 'waiting', kind: 'you', now: 'Parked on CI' },
    { state: 'waiting', kind: 'outside', waitingOn: 'The CI run', now: 'Waiting on CI to finish' },
    { state: 'waiting', kind: 'task', waitingOn: 'Its worker (1 open)', now: 'Its worker builds it' },
    { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' },
    { state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it', now: 'Half done' },
    { state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to check the result', now: 'Fixed the parser' },
    { state: 'waiting', kind: 'machine', waitingOn: 'Its host to come back', stoppedBy: 'machine', now: 'Was building' },
    { state: 'needs', ask: 'Sign it', now: 'Ready to send' },
  ]
  // The sections a note may carry. A new section goes here only if it is not progress.
  const ALLOWED = ['Needs the user:', 'Waiting on you:', 'Stopped by the machine, not the work (Walnut resumes these once the cause clears):',
    'Asked of your teams by others:', 'Latest:', 'Stuck (nothing will wake it):']

  it('every section the note can write is one the lead acts on; progress has none', async () => {
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(new URL('../../../src/core/org/team-note.ts', import.meta.url), 'utf8')
    const heads = [...src.matchAll(/section\(\s*(?:plan\.kind === 'now' \? )?'([^']+)'(?: : '([^']+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean))
    heads.push(...[...src.matchAll(/`(Asked of your teams by others:)/g)].map((m) => m[1]!))
    expect(heads.length).toBeGreaterThan(4)
    for (const h of heads) expect(ALLOWED, `a new section "${h}": progress must not ride a team note`).toContain(h)
  })

  it('a later note never carries a working line or a progress section, whatever moved', () => {
    for (const [i, from] of statuses.entries()) {
      for (const [j, to] of statuses.entries()) {
        const before = [t('x', { parent_task_id: LEAD, user_status: { ...from, at: at(10) } }), t('y', { user_status: { state: 'working', now: 'Step one', at: at(10) } })]
        const after = [
          t('x', { parent_task_id: LEAD, phase_changed_at: at(50), user_status: { ...to, now: `${to.now ?? ''} (later)`, at: at(50) } }),
          t('y', { user_status: { state: 'working', now: 'Step two', at: at(55) } }),
          t(`new-${i}-${j}`, { user_status: { state: 'working', now: 'Just started', at: at(56) } }),
        ]
        const prev = planTeamNote(undefined, before, [], at(10), ctx).next
        const plan = planTeamNote(prev, after, [], NOW, ctx)
        if (plan.kind === 'none') continue
        const text = buildTeamNoteText(lead, plan, at(10), Date.parse(NOW))
        expect(text, `${from.state}/${from.kind} -> ${to.state}/${to.kind}`).not.toMatch(/\(working[,)]/)
        expect(text).not.toContain('Step two')
        expect(text).not.toContain('Just started')
        expect(text).not.toMatch(/^(Changed|New|Latest):/m)
      }
    }
  })

  it('a note with nothing to act on waits an hour after the last; one the lead must act on goes at once', () => {
    const prev = planTeamNote(undefined, base, [], at(0), ctx).next
    const needs = planTeamNote(prev, [...base, t('d', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Sign it' } })], [], at(30), ctx)
    expect(needs.kind).toBe('moved')
    expect(noteDue(needs, prev.at, Date.parse(at(30)))).toBe(false)
    expect(noteDue(needs, prev.at, Date.parse(at(0)) + TEAM_NOTE_GAP_MS)).toBe(true)
    const done = planTeamNote(prev, base.slice(1), [{ id: 'a', title: 'a title' }], at(5), ctx)
    expect(noteDue(done, prev.at, Date.parse(at(5)))).toBe(false)
    // Waiting on the lead, stopped by the machine, or stuck: the lead's to act on now.
    for (const s of statuses.filter((x) => x.kind === 'lead' || x.kind === 'machine' || x.kind === 'stuck')) {
      const plan = planTeamNote(prev, [...base.slice(0, 2), t('c', { parent_task_id: LEAD, user_status: s })], [], at(5), ctx)
      expect(plan.kind, s.kind).toBe('moved')
      expect(noteDue(plan, prev.at, Date.parse(at(5))), s.kind).toBe(true)
    }
    // The first note is where things stand: at once.
    expect(noteDue(planTeamNote(undefined, base, [], at(5), ctx), undefined, Date.parse(at(5)))).toBe(true)
  })

  it('a state an older Walnut wrote, words in its fingerprints: the change of form is no news, a real move still is', () => {
    // The old form, as an older Walnut hashed it: '|<now words>|<stuck>|machine:<on>', or 'needs|<ask>'.
    const hash = (raw: string) => { let h = 5381; for (let i = 0; i < raw.length; i++) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0; return h.toString(36) }
    const team = [
      t('m', { user_status: { state: 'waiting', kind: 'machine', waitingOn: 'Its host to come back', stoppedBy: 'machine', now: 'Was building' } }),
      t('s', { user_status: { state: 'waiting', kind: 'stuck', waitingOn: 'Nothing will wake it', now: 'Half done' } }),
      t('w', { parent_task_id: LEAD, phase_changed_at: at(3), user_status: { state: 'waiting', kind: 'lead', waitingOn: 'Its lead' } }),
      t('n', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Sign it' } }),
      t('p', { user_status: { state: 'working', now: 'Running the suite' } }),
    ]
    const old = { at: at(0), led: ['Garden'], seen: {
      m: hash('|Was building||machine:Its host to come back'), s: hash('|Half done|stuck'),
      w: hash('||') + '+lead@' + at(3), n: hash('needs|Sign it'), p: hash('|Running the suite|'),
    } }
    const plan = planTeamNote(old, team, [], at(10), ctx)
    expect(plan.kind).toBe('none')
    expect(plan.next.form).toBe(TEAM_NOTE_FORM)
    // Told before the upgrade as working; now it needs the user, is stuck, or the machine stopped it: told.
    const was = { ...old, seen: { ...old.seen, x: hash('|Building it|'), y: hash('|Building it|'), z: hash('|Building it|') } }
    const moved = planTeamNote(was, [...team,
      t('x', { phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Pick one' } }),
      t('y', { user_status: { state: 'waiting', kind: 'stuck', waitingOn: 'Nothing will wake it', now: 'Building it' } }),
      t('z', { user_status: { state: 'waiting', kind: 'machine', waitingOn: 'Its host to come back', stoppedBy: 'machine', now: 'Building it' } }),
    ], [], at(10), ctx)
    expect([moved.needs.map((i) => i.taskId), moved.moved.map((i) => i.taskId), moved.machine.map((i) => i.taskId)]).toEqual([['x'], ['y'], ['z']])
    // Only new words: still no news.
    const words = planTeamNote({ ...old, seen: { ...old.seen, p: hash('|Started the suite|') } }, team, [], at(10), ctx)
    expect(words.kind).toBe('none')
    // A wait it was not told about is still news.
    const fresh = planTeamNote({ ...old, seen: { ...old.seen, w: hash('||') } }, team, [], at(10), ctx)
    expect(fresh.waits.map((w) => w.taskId)).toEqual(['w'])
  })
})
