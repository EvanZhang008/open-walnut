/**
 * A Board choice's "needs you" is checked like a session's (2026-10-31: an unanswered choice on a
 * leader's Board kept a task on the user's list a day after the task had moved on and the user had
 * answered it in the task's chat; its leader was COMPLETE).
 *  - the Board records when each choice was written (board-store.ts stampChoiceTimes): an edit of
 *    its tag (a `checked` date its owner sets) writes it again, any other edit keeps its time;
 *  - the status carries that time as its check and goes unverified like a session ask; a choice
 *    with no time was never checked (user-status.ts stampChoiceChecked, checkedLine);
 *  - the task's own newer words win over an older choice nobody confirmed since (choiceOverruled);
 *  - a COMPLETE Board owner's choices ask nothing (user-status-sync.ts choiceInput);
 *  - the re-check clock asks the Board owner to confirm or remove it (needs-recheck.ts).
 * Guard: every status source that asks the user is a live record or has a re-check; a new source
 * fails here until it says which.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stampChoiceTimes } from '../../src/core/boards/board-store.js'
import { NEEDS_RECHECK_MS, UNVERIFIED_AFTER_MS, checkedLine, deriveUserStatus, type StatusReport } from '../../src/core/user-status.js'
import { choiceRecheckBody, recheckDue } from '../../src/core/sessions/needs-recheck.js'
import { statusInputOf, type StatusFacts } from '../../src/core/user-status-sync.js'
import type { Task } from '../../src/core/types.js'

const NOW = Date.parse('2026-10-31T18:00:00Z')
const H = 3_600_000
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const tag = (extra = '') => `<walnut-choice id="ask-stacks" task="w1" title="When do we delete the 12 old stacks?" options="now:Now|later:Later"${extra}></walnut-choice>`

describe('the Board records when each choice was written', () => {
  it('a new choice is written now; an unchanged one keeps its time, or its lack of one; a changed tag is written again; a removed one goes', () => {
    const t1 = ago(10 * H)
    const first = stampChoiceTimes('', undefined, `<p>x</p>${tag()}`, t1)!
    expect(first['ask-stacks']!.at).toBe(t1)
    // Another part of the page edited: the choice keeps its time.
    expect(stampChoiceTimes(`<p>x</p>${tag()}`, first, `<p>y</p>${tag()}`, ago(H))!['ask-stacks']!.at).toBe(t1)
    // Its owner confirms it by setting its checked date: written again now.
    expect(stampChoiceTimes(tag(), first, tag(' checked="2026-10-31"'), ago(H))!['ask-stacks']!.at).toBe(ago(H))
    // A Board stored before Walnut kept the time: an unchanged choice still has none.
    expect(stampChoiceTimes(tag(), undefined, `<p>z</p>${tag()}`, ago(H))).toBeUndefined()
    expect(stampChoiceTimes(tag(), first, '<p>gone</p>', ago(H))).toBeUndefined()
  })
})

const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(30 * H) } as const
const ref = { board: 'lead1', id: 'ask-stacks' }

describe('a choice ask is stamped like a session ask', () => {
  it('fresh: checked when written; old: not verified; no time: never checked', () => {
    const fresh = deriveUserStatus({ ...base, openChoice: 'When?', openChoiceAt: ago(H), openChoiceRef: ref }, NOW)
    expect(fresh).toMatchObject({ state: 'needs', source: 'choice', choice: ref, checkedAt: ago(H) })
    expect(fresh.unverified).toBeUndefined()
    expect(checkedLine(fresh, NOW)).toEqual({ text: 'Checked 1 hour ago', unverified: false })
    const old = deriveUserStatus({ ...base, openChoice: 'When?', openChoiceAt: ago(UNVERIFIED_AFTER_MS + 60_000), openChoiceRef: ref }, NOW)
    expect(old.unverified).toBe(true)
    expect(checkedLine(old, NOW)?.unverified).toBe(true)
    const never = deriveUserStatus({ ...base, openChoice: 'When?', openChoiceRef: ref }, NOW)
    expect(never).toMatchObject({ source: 'choice', unverified: true })
    expect(checkedLine(never, NOW)).toEqual({ text: 'Not verified: no check recorded, may be done already', unverified: true })
  })

  it("the task's own ask comes first; its newer words overrule an older choice; a choice confirmed after them wins", () => {
    const report: StatusReport = { at: ago(10 * H), state: 'needs', ask: 'Confirm the plan for stack cleanup' }
    const input = { ...base, phaseChangedAt: ago(10 * H), report, openChoice: 'When do we delete the 12 old stacks?', openChoiceRef: ref }
    // The task's own current ask comes first in any case.
    expect(deriveUserStatus(input, NOW)).toMatchObject({ source: 'session', ask: 'Confirm the plan for stack cleanup' })
    // Its newer words that ask nothing still overrule an older choice; a choice with no time is kept, unverified.
    const says = { ...input, report: { at: ago(10 * H), state: 'waiting', waiting_kind: 'task', waiting_on: 'The reviewer' } as StatusReport }
    expect(deriveUserStatus({ ...says, openChoiceAt: ago(20 * H) }, NOW).source).not.toBe('choice')
    expect(deriveUserStatus(says, NOW)).toMatchObject({ source: 'choice', unverified: true })
    // Confirmed after its words: the choice is what it asks.
    expect(deriveUserStatus({ ...says, openChoiceAt: ago(H) }, NOW)).toMatchObject({ source: 'choice', ask: 'When do we delete the 12 old stacks?' })
  })
})

describe("a COMPLETE Board owner's choices ask nothing", () => {
  const facts = (owner: Partial<Task>) => ({
    sessions: new Map(), letters: new Map(), requestsFrom: new Map(), triggers: new Map(), schedules: new Map(),
    titles: new Map(), sessionsOf: new Map(),
    choices: new Map([['w1', [
      { title: 'Old ask', board: 'lead1', id: 'ask-a', at: ago(30 * H) },
      { title: 'Open ask', board: 'lead2', id: 'ask-b', at: ago(H) },
    ]]]),
    tasksById: new Map([
      ['lead1', { id: 'lead1', title: 'Lead 1', phase: 'COMPLETE', ...owner } as Task],
      ['lead2', { id: 'lead2', title: 'Lead 2', phase: 'WAITING' } as Task],
    ]),
  }) as unknown as StatusFacts
  const w1 = { id: 'w1', title: 'Worker', phase: 'NEED_ACTION' } as Task
  it("skips a completed owner's choice for the next open Board's", () => {
    expect(statusInputOf(w1, facts({}))).toMatchObject({ openChoice: 'Open ask', openChoiceAt: ago(H), openChoiceRef: { board: 'lead2', id: 'ask-b' } })
    expect(statusInputOf(w1, facts({ phase: 'WAITING' }))).toMatchObject({ openChoice: 'Old ask', openChoiceRef: { board: 'lead1', id: 'ask-a' } })
  })
})

describe('the re-check of a choice', () => {
  const asked = (checkedAt?: string): Task => ({
    id: 'w1', title: 'THF receivers', phase: 'NEED_ACTION', status: 'in_progress',
    user_status: { state: 'needs', source: 'choice', ask: 'When?', choice: ref, ...(checkedAt ? { checkedAt } : { unverified: true }) },
  }) as Task
  it('is due when its write is NEEDS_RECHECK_MS old or has no time, not before', () => {
    expect(recheckDue(asked(ago(H)), { nowMs: NOW })).toBe(false)
    expect(recheckDue(asked(ago(NEEDS_RECHECK_MS + 60_000)), { nowMs: NOW })).toBe(true)
    expect(recheckDue(asked(), { nowMs: NOW })).toBe(true)
    // Choices with no time seen since a start are spread over the window, not all due at once.
    const boot = NOW - H
    const due = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'].filter((id) => recheckDue({ ...asked(), id }, { nowMs: NOW, unknownSince: boot }))
    expect(due.length).toBeLessThan(8)
    expect(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'].every((id) => recheckDue({ ...asked(), id }, { nowMs: boot + NEEDS_RECHECK_MS, unknownSince: boot }))).toBe(true)
    // An ephemeral server never asks about one it copied.
    expect(recheckDue(asked(), { nowMs: NOW, notBefore: NOW - H })).toBe(false)
  })
  it("asks the Board owner to confirm it with a checked date or remove it, quoting the task's own words", () => {
    const body = choiceRecheckBody(ref, 'When?', { ...asked(), status_report: { at: ago(H), state: 'needs', ask: 'Nothing to delete after all' } } as Task, undefined, NOW)
    expect(body).toContain('"When?" (id ask-stacks)')
    expect(body).toContain('no one ever confirmed it')
    expect(body).toContain('"Nothing to delete after all"')
    expect(body).toContain('<walnut-choice id="ask-stacks">')
    expect(body).toContain('checked="2026-10-31T18:00Z"')
    expect(body).toContain('agent-ack')
  })
})

// Guard: every way a status can ask the user is either Walnut's live record of something open now,
// or carries a check time and has a re-check. Read from the source, so a new source fails here.
describe('every source of a "needs you" is live or re-checked', () => {
  const RULE: Record<string, string> = {
    prompt: 'live: a permission prompt open now',
    error: 'live: the failure is the session record now',
    letter: 'letter-recheck.ts asks its sender again',
    session: 'needs-recheck.ts asks its session again (stampChecked)',
    choice: 'needs-recheck.ts asks its Board owner again (stampChoiceChecked)',
    thread: "live: the node's thread store now (user-status-sync re-reads it on every threads change)",
  }
  it('names a rule for each', () => {
    const src = readFileSync(join(process.cwd(), 'src/core/user-status.ts'), 'utf8')
    const union = src.match(/\n\s*source\?: ((?:'[a-z]+'\s*\|?\s*)+);/)?.[1] ?? ''
    const sources = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
    expect(sources.length).toBeGreaterThanOrEqual(5)
    for (const s of sources) expect(RULE[s], `user_status source '${s}': say how it is kept current`).toBeTruthy()
    const recheck = readFileSync(join(process.cwd(), 'src/core/sessions/needs-recheck.ts'), 'utf8')
    for (const s of sources.filter((x) => RULE[x]!.startsWith('needs-recheck'))) expect(recheck).toContain(`'${s}'`)
  })
})
