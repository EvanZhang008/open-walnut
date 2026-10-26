/** What a lead hears about its teams before its next message (src/core/org/team-note.ts), pure part. */
import { describe, it, expect } from 'vitest'
import { buildTeamNoteText, planTeamNote, teamFingerprint, TEAM_NOTE_MAX } from '../../../src/core/org/team-note.js'
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
