/**
 * One decision, asked once (src/core/same-ask.ts, same-ask-tree.ts): the sameness test, the fold of
 * an ancestor's ask under the subtask that asks the same, and the tree a write is checked against.
 * Pure. Non-ASCII strings below are test data (CJK asks), written as \u escapes.
 */
import { describe, it, expect } from 'vitest'
import { askKey, foldSameAsk, sameAskText, findSameAsk, sameAskMessage, sameAskReasonOf } from '../../src/core/same-ask.js'
import { treeAround, treeAsksOf } from '../../src/core/same-ask-tree.js'
import { readStatusReport } from '../../src/core/session-hooks/builtins.js'
import type { RolledAsk, UserStatus } from '../../src/core/user-status.js'
import type { Task } from '../../src/core/types.js'

// "Should we create three alpha test accounts?" and a reworded copy, in Chinese.
const ZH_A = '\u8981\u4e0d\u8981\u5efa\u4e09\u4e2a alpha \u6d4b\u8bd5\u8d26\u53f7\uff1f'
const ZH_B = '\u662f\u5426\u5efa\u4e09\u4e2a alpha \u6d4b\u8bd5\u8d26\u53f7'
const ZH_OTHER = '\u8bf7\u5728\u5f00\u53d1\u673a\u4e0a\u91cd\u65b0\u767b\u5f55'

describe('sameAskText', () => {
  it('reads a reworded copy of one question as the same, in English and in CJK', () => {
    expect(sameAskText('Should we create three alpha test accounts?', 'should we create three alpha test accounts')).toBe(true)
    expect(sameAskText('Create the three alpha test accounts?', 'Should we create three alpha test accounts?')).toBe(true)
    expect(sameAskText('Should we create 3 alpha test accounts?', 'Create 3 alpha test accounts?')).toBe(true)
    expect(sameAskText(ZH_A, ZH_B)).toBe(true)
  })

  it('never folds two asks that differ in one content word (the 2026-11-04 review\'s pairs)', () => {
    const pairs: Array<[string, string]> = [
      ['Should I delete the staging database?', 'Should I delete the production database?'],
      ['Rotate the API key for Slack?', 'Rotate the API key for GitHub?'],
      ['Merge the PR to main?', 'Merge the PR to release?'],
      ['Approve sending the email to the customer?', 'Approve sending the email to the vendor?'],
      ['Approve the release', 'Approve the release notes and then publish the release to npm'],
      ['Approve creating the three alpha test accounts', 'Approve creating the three alpha test accounts, so the alpha stages deploy before Monday'],
    ]
    for (const [a, b] of pairs) expect(sameAskText(a, b), `${a} / ${b}`).toBe(false)
  })

  it('reads the order and a "no", and never folds an ask of fewer than three content words by its words', () => {
    expect(sameAskText('Copy the database from staging to production?', 'Copy the database from production to staging?')).toBe(false)
    expect(sameAskText('Ship the release with no tests?', 'Ship the release with tests?')).toBe(false)
    expect(sameAskText('Merge it?', 'Merge it?')).toBe(false)
    expect(sameAskText('Approve the release?', 'Approve the release?')).toBe(false)
    expect(sameAskText('Approve the npm release?', 'approve the npm release')).toBe(true)
  })

  it('never folds two different decisions, numbers that differ, or empty words', () => {
    expect(sameAskText('Should we create three alpha test accounts?', 'Sign in again on the dev box?')).toBe(false)
    expect(sameAskText(ZH_A, ZH_OTHER)).toBe(false)
    expect(sameAskText('Approve change 1234?', 'Approve change 5678?')).toBe(false)
    expect(sameAskText('', 'Approve?')).toBe(false)
    expect(sameAskText('Approve?', 'Merge?')).toBe(false)
  })
})

const needs = (ask: string, extra: Partial<UserStatus> = {}): UserStatus => ({ state: 'needs', source: 'session', ask, now: 'Accounts drafted', at: '2026-11-04T10:00:00.000Z', ...extra })
const child: RolledAsk = { id: 'child', title: 'Alpha stages', ask: 'Create the three alpha test accounts?' }

describe('foldSameAsk', () => {
  const report = { at: '2026-11-04T10:00:00.000Z' }
  const NOW = '2026-11-04T10:05:00.000Z'

  it('shows an ancestor\'s same ask as Waiting on the subtask that asks it, keeping its words', () => {
    const out = foldSameAsk('lead', { ...needs('Should we create three alpha test accounts?'), asks: [child] }, [child], { report, nowIso: NOW })
    expect(out).toMatchObject({ state: 'waiting', kind: 'task', now: 'Accounts drafted', asks: [child], sameAsk: { id: 'child', title: 'Alpha stages', at: NOW } })
    expect(out.waitingOn).toContain('Alpha stages')
    expect(out).not.toHaveProperty('ask')
    expect(out).not.toHaveProperty('source')
  })

  it('leaves a different ask, a live prompt, a failure, a letter, a person\'s mark and every other state alone', () => {
    const other = needs('Sign in again on the dev box?')
    expect(foldSameAsk('lead', other, [child], { report })).toBe(other)
    for (const source of ['prompt', 'error', 'letter'] as const) {
      const s = needs('Create the three alpha test accounts?', { source })
      expect(foldSameAsk('lead', s, [child], { report }), source).toBe(s)
    }
    const marked = needs('It was set to need you by hand: open it.', { source: undefined })
    expect(foldSameAsk('lead', marked, [{ ...child, ask: 'It was set to need you by hand: open it.' }], {})).toBe(marked)
    const working: UserStatus = { state: 'working' }
    expect(foldSameAsk('lead', working, [child], { report })).toBe(working)
    // A Board choice folds like a session's ask.
    expect(foldSameAsk('lead', needs('Create the three alpha test accounts?', { source: 'choice' }), [child], {})).toMatchObject({ state: 'waiting' })
  })

  it('takes the sessions\' own word over the text test, and a "different" from either side wins', () => {
    const differentWords = needs('Go ahead with the stage plan?')
    expect(foldSameAsk('lead', differentWords, [child], { report: { ...report, same_as: 'child' } })).toMatchObject({ state: 'waiting', sameAsk: { id: 'child' } })
    expect(foldSameAsk('lead', differentWords, [child], { report, declared: (id) => (id === 'child' ? { same_as: 'lead' } : null) }))
      .toMatchObject({ state: 'waiting', sameAsk: { id: 'child' } })
    const same = needs('Should we create three alpha test accounts?')
    expect(foldSameAsk('lead', same, [child], { report: { ...report, ask_distinct: true } })).toBe(same)
    expect(foldSameAsk('lead', same, [child], { report: { ...report, ask_distinct: true }, declared: () => ({ same_as: 'lead' }) })).toBe(same)
    expect(foldSameAsk('lead', same, [child], { report, declared: () => ({ ask_distinct: true }) })).toBe(same)
  })

  it('keeps the fold once the subtask asks no more only when the user wrote to it after the fold', () => {
    const own = needs('Should we create three alpha test accounts?')
    const folded = foldSameAsk('lead', own, [child], { report, nowIso: NOW })
    // The user wrote to the subtask after the fold: the answer went there, until the lead reports anew.
    const after = foldSameAsk('lead', own, [], { report, prev: folded, personInputAt: () => '2026-11-04T10:06:00.000Z' })
    expect(after).toMatchObject({ state: 'waiting', kind: 'task', sameAsk: { id: 'child', answered: true } })
    expect(after.waitingOn).toContain('you answered it there')
    expect(foldSameAsk('lead', own, [], { report, prev: after })).toMatchObject({ sameAsk: { answered: true } })
    expect(foldSameAsk('lead', own, [], { report: { at: '2026-11-04T12:00:00.000Z' }, prev: after })).toBe(own)
    // No word from the user (the subtask was moved away, snoozed, or asks something else): its own ask is back.
    expect(foldSameAsk('lead', own, [], { report, prev: folded })).toBe(own)
    expect(foldSameAsk('lead', own, [], { report, prev: folded, personInputAt: () => '2026-11-04T09:00:00.000Z' })).toBe(own)
    // The subtask still holds it (its turn runs on it, it is snoozed with it): the fold stays as it is.
    const held = foldSameAsk('lead', own, [], { report, prev: folded, stillAsks: (id, ask) => id === 'child' && ask === child.ask })
    expect(held).toMatchObject({ state: 'waiting', sameAsk: { id: 'child', at: NOW } })
    expect(held.sameAsk).not.toHaveProperty('answered')
    // A refold keeps the time it was first folded.
    expect(foldSameAsk('lead', own, [child], { report, prev: folded, nowIso: '2026-11-04T11:00:00.000Z' }).sameAsk?.at).toBe(NOW)
  })
})

const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id.toUpperCase(), phase: 'NEED_ACTION', project: 'Garden', ...extra }) as Task

describe('the tree a write is checked against', () => {
  const tasks = [
    task('vp', { org_role: 'lead', project: 'Garden', user_status: { state: 'waiting' } }),
    task('lead', { parent_task_id: 'top', user_status: needs('Should we create three alpha test accounts?') }),
    task('top', { project: 'Garden', user_status: needs('Pick a launch date?') }),
    task('child', { parent_task_id: 'lead', user_status: needs('Create the three alpha test accounts?') }),
    task('grand', { parent_task_id: 'child', user_status: needs('Rename the stage?') }),
    task('done', { parent_task_id: 'lead', phase: 'COMPLETE', user_status: needs('Old?') }),
    task('elsewhere', { project: 'Orchard', user_status: needs('Should we create three alpha test accounts?') }),
  ]

  it('walks up the leader chain and down every level, and a lead\'s team too', () => {
    expect(treeAround('child', tasks).map((a) => `${a.task.id}:${a.relation}`).sort()).toEqual(['grand:descendant', 'lead:ancestor', 'top:ancestor'])
    expect(treeAround('vp', tasks).map((a) => a.task.id).sort()).toEqual(['child', 'done', 'grand', 'lead', 'top'])
  })

  it('checks a write against the asks below and every open letter, never an ancestor\'s status ask', () => {
    const letters = [{ id: 'lt-1', subject: 'Pick a launch date for the alpha', taskId: 'top' }, { id: 'lt-2', subject: 'Unrelated', taskId: 'elsewhere' }]
    const forLead = treeAsksOf('lead', tasks, letters, true)
    expect(forLead.map((a) => `${a.taskId}:${a.where}:${a.relation}`)).toEqual(['child:status:descendant', 'grand:status:descendant', 'top:letter:ancestor'])
    // The subtask asking what its lead asks is the deeper one: let through.
    expect(findSameAsk('Should we create three alpha test accounts?', treeAsksOf('child', tasks, [], true))).toBeNull()
    // The lead asking what its subtask asks is refused, naming it.
    const hit = findSameAsk('Should we create three alpha test accounts?', forLead)
    expect(hit).toMatchObject({ taskId: 'child', relation: 'descendant' })
    expect(sameAskMessage(hit!, 'letter')).toMatch(/^Not sent: a subtask of this one, "CHILD" \(child\), already asks the user this/)
    // The status question lists every open ask around it, ancestors' too.
    expect(treeAsksOf('child', tasks, [], false).map((a) => a.taskId)).toEqual(['grand', 'lead', 'top'])
  })

  it('takes a reason of ten characters or more, and none shorter', () => {
    expect(sameAskReasonOf({ same_ask_reason: 'short' })).toBe('')
    expect(sameAskReasonOf({ same_ask_reason: '  a different account set  ' })).toBe('a different account set')
  })
})

describe('the turn-end report', () => {
  const base = 'FOR_USER_STATE: needs-you\nFOR_USER_ASK: Create the accounts?\nFOR_USER_ASK_OWN: spending: it creates paid accounts\n'
  it('reads FOR_USER_ASK_SAME as the task it is the same as, or a different decision', () => {
    expect(readStatusReport(`${base}FOR_USER_ASK_SAME: [abcd1234-5678]\nFOR_USER_NOW: drafted`)).toMatchObject({ state: 'needs', same_as: 'abcd1234-5678', now: 'drafted' })
    expect(readStatusReport(`${base}FOR_USER_ASK_SAME: [abcd1234-5678] Alpha stages (your subtask)\n`)).toMatchObject({ same_as: 'abcd1234-5678' })
    expect(readStatusReport(`${base}FOR_USER_ASK_SAME: different\n`)).toMatchObject({ ask_distinct: true })
    const plain = readStatusReport(`${base}FOR_USER_ASK_SAME: none\n`)!
    expect(plain).not.toHaveProperty('same_as')
    expect(plain).not.toHaveProperty('ask_distinct')
    expect(plain.ask).toBe('Create the accounts?')
  })
})

describe('askKey', () => {
  it('folds case, width and spacing', () => {
    expect(askKey('  Create   THE accounts? ')).toBe(askKey('create the accounts'))
  })
})
