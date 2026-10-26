/** A team's news in its tasks' own words (src/core/org/team-news.ts). */
import { describe, it, expect } from 'vitest'
import { newsLine, newsSubject, shortTitle, statusWords, teamNews, type TeamNewsTask } from '../../../src/core/org/team-news.js'

const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 12, min)).toISOString()

function t(id: string, extra: Partial<TeamNewsTask> = {}): TeamNewsTask {
  return { id, title: `${id} title`, phase: 'IN_PROGRESS', updated_at: at(0), ...extra }
}

describe('team news', () => {
  it('reads a status in its own words: the ask, else where it stands, else what it waits on', () => {
    expect(statusWords({ state: 'needs', ask: 'Sign the form', now: 'Checked it' }, 'needs')).toBe('Sign the form')
    expect(statusWords({ state: 'working', now: '  Running   the suite ' }, 'working')).toBe('Running the suite')
    expect(statusWords({ state: 'waiting', now: 'Passed the check', waitingOn: 'You' }, 'waiting')).toBe('Passed the check')
    expect(statusWords({ state: 'waiting', kind: 'task', waitingOn: 'A reply from Docs' }, 'waiting')).toBe('A reply from Docs')
    // A plain wait says nothing the title does not.
    expect(statusWords({ state: 'waiting', kind: 'you', waitingOn: 'You, to read the latest turn (no rush)' }, 'waiting')).toBe('')
    expect(statusWords({ state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' }, 'waiting')).toBe('')
    // A status for another state than the one read says nothing.
    expect(statusWords({ state: 'waiting', now: 'x' }, 'working')).toBe('')
    expect(statusWords(undefined, 'working')).toBe('')
  })

  it('puts what needs the user first, then the newest of the sessions\' own words, then work running now, then the rest', () => {
    const news = teamNews([
      t('old-words', { phase: 'NEED_ACTION', user_status: { state: 'waiting', now: 'Drafted the email', at: at(5) } }),
      t('new-words', { phase: 'NEED_ACTION', updated_at: at(1), user_status: { state: 'waiting', kind: 'you', waitingOn: 'You, no rush', now: 'Passed the identity check', at: at(30) } }),
      t('derived', { phase: 'NEED_ACTION', updated_at: at(50), user_status: { state: 'waiting', kind: 'task', waitingOn: 'A reply from Docs' } }),
      t('plain', { phase: 'TODO', updated_at: at(58), user_status: { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' } }),
      t('running', { updated_at: at(55), user_status: { state: 'working' } }),
      t('parked', { phase: 'WAITING', updated_at: at(59) }),
      t('asks', { phase: 'NEED_ACTION', updated_at: at(2), user_status: { state: 'needs', ask: 'Approve the send', at: at(2) } }),
      t('done', { phase: 'COMPLETE', updated_at: at(59) }),
    ])
    expect(news.map((i) => i.taskId)).toEqual(['asks', 'new-words', 'old-words', 'running', 'derived', 'parked', 'plain'])
    expect(news[1]).toMatchObject({ state: 'waiting', words: 'Passed the identity check', reported: true, at: Date.parse(at(30)) })
    // Walnut's own "waits on" words are not the session's report: their time is the task's last move.
    expect(news[4]).toMatchObject({ words: 'A reply from Docs', reported: false, at: Date.parse(at(50)) })
    expect(news[6]).toMatchObject({ words: '', reported: false })
  })

  it('a day-old report gives way to work running now, and keeps the time it was written', () => {
    const news = teamNews([
      t('old', { phase: 'NEED_ACTION', updated_at: at(58), user_status: { state: 'waiting', now: 'Waiting for the vendor quote', at: at(1), stale: true } }),
      t('busy', { updated_at: at(20), user_status: { state: 'working' } }),
    ])
    expect(news.map((i) => i.taskId)).toEqual(['busy', 'old'])
    expect(news[1]).toMatchObject({ words: 'Waiting for the vendor quote', reported: false, at: Date.parse(at(1)) })
  })

  it('an ask from a letter, a prompt or a choice takes the task\'s last move, not an older report\'s time', () => {
    const [letter, own] = teamNews([
      t('letter', { phase: 'NEED_ACTION', last_session_update: at(55), user_status: { state: 'needs', source: 'letter', ask: 'Pick a date', now: 'Drafted it', at: at(1) } }),
      t('own', { phase: 'NEED_ACTION', last_session_update: at(56), user_status: { state: 'needs', source: 'session', ask: 'Which one?', at: at(40) } }),
    ])
    expect([letter!.taskId, letter!.at]).toEqual(['letter', Date.parse(at(55))])
    expect([own!.taskId, own!.at]).toEqual(['own', Date.parse(at(40))])
  })

  it('says one line, the words first, and names the task beside it; or what it does when it has no words', () => {
    const [needs, words, working, waiting] = teamNews([
      t('a', { title: 'File the form', phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'Sign it' } }),
      t('b', { title: 'Check the case', user_status: { state: 'waiting', now: 'It passed', at: at(9) } }),
      t('c', { title: 'Write the parser', user_status: { state: 'working' } }),
      t('d', { title: 'Plan the trip', phase: 'WAITING' }),
    ])
    expect([newsLine(needs!), newsSubject(needs!)]).toEqual(['Needs you: Sign it', 'File the form'])
    expect([newsLine(words!), newsSubject(words!)]).toEqual(['It passed', 'Check the case'])
    expect([newsLine(working!), newsSubject(working!)]).toEqual(['Working on: Write the parser', ''])
    expect([newsLine(waiting!), newsSubject(waiting!)]).toEqual(['Waiting: Plan the trip', ''])
  })

  it('cuts a long title by characters, Unicode included, so the words still show', () => {
    expect(shortTitle('short')).toBe('short')
    const cjk = '跟进'.repeat(30)
    const cut = shortTitle(cjk, 10)
    expect(Array.from(cut)).toHaveLength(10)
    expect(cut.endsWith('…')).toBe(true)
  })
})
