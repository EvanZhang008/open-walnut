/**
 * A program's run (types.ts isProgramRunTask: an imported one, or one a plugin's job runs in Walnut)
 * is no one's to read while it asks the user nothing: it waits on the program that runs it
 * (src/core/user-status.ts programRun, PROGRAM_RUN_WAIT).
 *
 * 2026-11-21: the first run a plugin's job started in Walnut ended "The result is ready", in the
 * user's To read, where every imported run reads Waiting. Walnut asks each turn of its own sessions
 * for a report, that session said done, and a done report was read before the program-run rule,
 * which until then only a run with no report at all (an imported one) ever reached.
 * 2026-11-22: the third real run reported needs-you with no ask and read "It answered your question":
 * that report was listed here as the one exception, which real data showed to be the same class.
 *
 * The class: every report a session can leave that asks the user nothing, in every open phase. A new
 * report state, or a new kind of wait, fails the enumeration until it is listed here with what a
 * program's run reads for it.
 *
 * Its turn end puts it on NEED_ACTION like any task, but nobody asked for the run, so that phase is
 * not the user's turn: a wait its report names is theirs only when it names them (a wait on a clock
 * or a check is its program's), where a regular task's wait on NEED_ACTION is theirs whatever it is.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  deriveUserStatus, PROGRAM_RUN_WAIT, RESULT_TO_READ, USER_STATE_MEANINGS,
  type StatusReport, type UserState, type UserStatusInput, type WaitKind,
} from '../../src/core/user-status.js'
import { PHASE_ORDER, TERMINAL_PHASES } from '../../src/core/phase.js'

const NOW = Date.parse('2026-11-21T21:30:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const rep = (r: Partial<StatusReport>): StatusReport => ({ state: 'working', at: ago(60_000), ...r } as StatusReport)

/** A report in each state that asks nothing: none of them is the user's to read for a program's run. */
const ASKS_NOTHING: Record<UserState, { report: StatusReport }> = {
  done: { report: rep({ state: 'done', now: 'The report is on the ticket.' }) },
  working: { report: rep({ state: 'working', now: 'Reading the alarm history.' }) },
  waiting: { report: rep({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'The on-call engineer, to close the ticket' }) },
  read: { report: rep({ state: 'read', now: 'Nothing new.' }) },
  // 2026-11-22, the third real ticket run: its session reported needs-you with no ask ("nothing for
  // you to decide") and read "It answered your question". For a regular task those words are the
  // user's to read (tests/core/user-status-ask-first.test.ts); nobody asked a program's run anything.
  needs: { report: rep({ state: 'needs', now: 'The report is on the ticket.', next: 'Nothing for you to decide.' }) },
}

/** A waiting report of each kind, on words that name no one: whose it is for a program's run. */
const WAITS: Record<WaitKind, 'the program' | 'the user'> = {
  task: 'the program', time: 'the program', machine: 'the program', outside: 'the program', own: 'the program',
  'not-started': 'the program', stuck: 'the program', other: 'the program',
  // The session itself said it waits on the user, or on a lead where none is above it: a real ask.
  you: 'the user', lead: 'the user',
}

/** An ask Walnut took no kind of the user's own for: no ask of theirs, in any report state. */
const KINDLESS: StatusReport = rep({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'Should the ticket be closed?', kindless_ask: true })

const run = (over: Partial<UserStatusInput>): UserStatusInput => ({
  phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', programRun: true, ...over,
})

describe('a program\'s run that asks nothing is never the user\'s to read', () => {
  const open = PHASE_ORDER.filter((p) => !TERMINAL_PHASES.has(p))

  it('lists every report state (ratchet)', () => {
    expect(Object.keys(ASKS_NOTHING).sort()).toEqual(Object.keys(USER_STATE_MEANINGS).sort())
  })

  it('whatever its session reported, in every open phase, it reads neither To read nor Needs you', () => {
    expect(open.length).toBeGreaterThan(2)
    const wrong: string[] = []
    const reports: Array<[string, StatusReport | undefined]> = [
      ['no report', undefined],
      ['a kindless ask', KINDLESS],
      ...Object.entries(ASKS_NOTHING).map(([state, c]) => [`report ${state}`, c.report] as [string, StatusReport]),
    ]
    for (const phase of open) {
      for (const processStatus of ['idle', 'stopped'] as const) {
        for (const [name, report] of reports) {
          const s = deriveUserStatus(run({ phase, processStatus, ...(report ? { report } : {}) }), NOW)
          if (s.state === 'needs' || s.state === 'read') {
            wrong.push(`${phase} + ${processStatus} + ${name}: ${s.state} (${s.toRead ?? ''} ${s.waitingOn ?? s.ask ?? ''})`)
          }
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('lists every kind of wait (ratchet)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/user-status.ts'), 'utf-8')
    const union = /export type WaitKind = ([^;]+);/.exec(src)?.[1] ?? ''
    const kinds = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(kinds.length).toBeGreaterThan(5)
    expect(Object.keys(WAITS).sort()).toEqual(kinds.sort())
  })

  it('a wait its report names is the user\'s only when it names them, on NEED_ACTION too', () => {
    const wrong: string[] = []
    for (const phase of open) {
      for (const [kind, whose] of [['none', 'the program'], ...Object.entries(WAITS)] as Array<[string, string]>) {
        const report = rep({ state: 'waiting', waiting_on: 'The next check at 21:00', ...(kind === 'none' ? {} : { waiting_kind: kind as WaitKind }) })
        const s = deriveUserStatus(run({ phase, report }), NOW)
        const ok = whose === 'the user' ? s.state === 'needs' : s.state !== 'needs' && s.state !== 'read'
        if (!ok) wrong.push(`${phase} + waiting ${kind}: ${s.state} (${s.waitingOn ?? s.ask ?? ''})`)
      }
    }
    expect(wrong).toEqual([])
    // Words that name the user are an ask of theirs under any kind.
    expect(deriveUserStatus(run({ report: rep({ state: 'waiting', waiting_on: 'You, to say whether to page the owner' }) }), NOW))
      .toMatchObject({ state: 'needs', ask: 'You, to say whether to page the owner' })
    // A regular task on NEED_ACTION keeps the old rule: any wait it names is the user's.
    expect(deriveUserStatus(run({ programRun: false, report: rep({ state: 'waiting', waiting_on: 'The next check at 21:00' }) }), NOW))
      .toMatchObject({ state: 'needs', ask: 'The next check at 21:00' })
  })

  it('the case that showed it: its turn ended and its session reported done', () => {
    const s = deriveUserStatus(run({ report: ASKS_NOTHING.done.report }), NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: PROGRAM_RUN_WAIT, now: 'The report is on the ticket.' })
    expect(s.toRead).toBeUndefined()
  })

  it('the second case: its session reported needs-you and asked nothing', () => {
    const s = deriveUserStatus(run({ report: ASKS_NOTHING.needs.report }), NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: PROGRAM_RUN_WAIT, now: 'The report is on the ticket.' })
    expect(s.toRead).toBeUndefined()
    // A regular task's same report is still the user's answer to read.
    expect(deriveUserStatus(run({ programRun: false, report: ASKS_NOTHING.needs.report }), NOW)).toMatchObject({ state: 'read', toRead: 'answer' })
  })

  it('an ask with no kind of the user\'s own is the program\'s to take too', () => {
    expect(deriveUserStatus(run({ report: KINDLESS }), NOW)).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: PROGRAM_RUN_WAIT })
  })

  it('a real ask still wins', () => {
    const s = deriveUserStatus(run({ report: rep({ state: 'needs', ask: 'May I page the service owner?' }) }), NOW)
    expect(s).toMatchObject({ state: 'needs', ask: 'May I page the service owner?' })
  })

  it('one a person filed under a leader is that leader\'s to check, as before', () => {
    const s = deriveUserStatus(run({ hasLeader: true, report: ASKS_NOTHING.done.report }), NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'lead' })
  })

  it('a regular task that reports done with no lead above it is still the user\'s to read', () => {
    const s = deriveUserStatus(run({ programRun: false, report: ASKS_NOTHING.done.report }), NOW)
    expect(s).toMatchObject({ state: 'read', toRead: 'result', waitingOn: RESULT_TO_READ })
  })
})
