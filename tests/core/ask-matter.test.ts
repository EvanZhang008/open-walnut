/**
 * What ties two asks to one matter across teams (src/core/ask-matter.ts): the ticket or issue ids
 * a task is tagged with, and those an ask's words name. Ids and hosts are invented.
 */
import { describe, it, expect } from 'vitest'
import { askMatter, matterIndex, matterKeysOfTask, matterKeysInText, MAX_OWN_MATTERS, MAX_KEY_HOLDERS, matterWords } from '../../src/core/ask-matter.js'
import { matterReportsOf } from '../../src/core/same-ask-tree.js'
import type { Task } from '../../src/core/types.js'

const task = (id: string, tags: string[], extra: Partial<Task> = {}) => ({ id, title: id, tags, phase: 'IN_PROGRESS', status: 'todo', ...extra }) as unknown as Task

describe('matter keys', () => {
  it('reads ids from ticket, issue and review tags, a URL by its id segment', () => {
    expect(matterKeysOfTask(task('a', ['ticket:TKT-1101', 'ticket:https://tickets.example.com/00000000-0000-4000-8000-000000000101', 'issue:https://example.com/org/app/issues/42', 'project:alpha', 'sev:2'])))
      .toEqual(['tkt-1101', '00000000-0000-4000-8000-000000000101', 'app/issues/42'])
  })

  it('a task tracking many tickets has no matter of its own', () => {
    const many = Array.from({ length: MAX_OWN_MATTERS + 1 }, (_, i) => `ticket:TKT-130${i}`)
    expect(matterKeysOfTask(task('lead', many))).toEqual([])
  })

  it('finds a known key as a whole token in any language, never inside a longer id or a plain word', () => {
    const known = new Set(['tkt-1101', 'alm-2203'])
    // "New high-severity ticket **TKT-1101** (confirmed)".
    expect(matterKeysInText('\u65b0 **TKT-1101**\uff08\u5df2\u786e\u8ba4\uff09', known)).toEqual(['tkt-1101'])
    expect(matterKeysInText('See TKT-11011 and xTKT-1101', known)).toEqual([])
    expect(matterKeysInText('Alarm ALM-2203.', known)).toEqual(['alm-2203'])
    expect(matterKeysInText('', known)).toEqual([])
  })

  it("an ask's matter is its task's own keys plus what its words name; a task's id names it", () => {
    const index = matterIndex([task('mwmerk-b675', ['ticket:TKT-1101']), task('lead-1234', ['ticket:TKT-1001']), task('done-9999', ['ticket:TKT-1777'], { phase: 'COMPLETE' } as Partial<Task>)])
    expect([...askMatter('lead-1234', 'Who deletes it? Reply in mwmerk-b675', index)].sort()).toEqual(['lead-1234', 'mwmerk-b675', 'tkt-1001'])
    // A finished task's ticket is still a word to look for (its result is news), a plain word never.
    expect([...askMatter('lead-1234', 'About TKT-1777', index)]).toContain('tkt-1777')
    expect([...askMatter('lead-1234', 'About the record', index)]).toEqual(['tkt-1001', 'lead-1234'])
    expect(matterWords('tkt-1101')).toBe('TKT-1101')
    expect(matterWords('eng-12x')).toBe('eng-12x')
  })

  it('a wide ticket (more holders than MAX_KEY_HOLDERS) and a digest naming many keys tie nothing', () => {
    const wide = Array.from({ length: MAX_KEY_HOLDERS + 1 }, (_, i) => task(`w${i}-0000`, ['ticket:TKT-1500']))
    const index = matterIndex([...wide, task('solo-0001', ['ticket:TKT-1600'])])
    expect(index.own('w0-0000')).toEqual(['w0-0000'])
    expect(index.known.has('tkt-1500')).toBe(false)
    const many = matterIndex(Array.from({ length: 8 }, (_, i) => task(`m${i}-0000`, [`ticket:TKT-17${i}0`])))
    const digest = Array.from({ length: 8 }, (_, i) => `TKT-17${i}0`).join(', ')
    expect([...askMatter('m0-0000', `Open tickets: ${digest}`, many)]).toEqual(['tkt-1700', 'm0-0000'])
    expect(matterKeysOfTask(task('pr', ['pr:https://example.com/org/app/pull/12']))).toEqual(['org/app/pull/12'.split('/').slice(-3).join('/')])
  })
})

describe('matterReportsOf: another team\'s latest word on the matter', () => {
  const now = Date.parse('2026-11-18T19:00:00Z')
  const at = new Date(now - 60_000).toISOString()
  const asker = task('ask-0001', [], { project: 'A' } as Partial<Task>)
  const reporter = (extra: Partial<Task>) => task('rep-0001', ['ticket:TKT-1800'], { project: 'B', user_status: { state: 'working', now: 'Switched back', at }, ...extra } as Partial<Task>)
  const index = (all: Task[]) => matterIndex(all)

  it('reads it, but not from a task folded under the asker or waiting on it, nor an old one', () => {
    const keys = new Set(['tkt-1800'])
    let all = [asker, reporter({})]
    expect(matterReportsOf('ask-0001', keys, all, index(all).own, now).map((r) => r.said)).toEqual(['Switched back'])
    all = [asker, reporter({ user_status: { state: 'waiting', now: 'Waits on the lead', at, sameAsk: { id: 'ask-0001' } } as never })]
    expect(matterReportsOf('ask-0001', keys, all, index(all).own, now)).toEqual([])
    all = [asker, reporter({ user_status: { state: 'waiting', now: 'x', at, waitingOn: 'ask-0001 to decide' } as never })]
    expect(matterReportsOf('ask-0001', keys, all, index(all).own, now)).toEqual([])
    all = [asker, reporter({ user_status: { state: 'working', now: 'Old news', at: new Date(now - 25 * 3_600_000).toISOString() } as never })]
    expect(matterReportsOf('ask-0001', keys, all, index(all).own, now)).toEqual([])
  })
})
