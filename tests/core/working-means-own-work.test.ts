/**
 * Waiting is only a real wait; a task's own build is Working; a finished result is To read
 * (2026-11-02, the user, on a task parked on its own build: "look htis one is runing why it is in
 * wait? wait is not waintg wait is just acutally waitng, if it is runnig it shoud be i progress
 * right?", then "it is not finish it is working right, the implementaiton is working"; on the
 * Waiting / snoozed section: "this is not waiting looks kike they are waiting for my input").
 *
 * Guards for the class:
 *  - every report that says the task's own work goes on (FOR_USER_STATE working, or a wait of kind
 *    `own`), in every phase and with every way it comes back (a live process, an armed watch, its
 *    wait clock), reads Working, never Waiting; with nothing to bring it back it is no Working;
 *  - every status with something to read and nothing asked (`toRead`) reads To read, in every phase
 *    and lead combination, and never Waiting or Needs you; snoozed, it reads Waiting with its mark;
 *  - a real wait (a person's review, another task, its lead, a set time) stays Waiting;
 *  - the self-report prompt names own work as working and lists `own` as a kind;
 *  - an older stored status (Waiting with toRead) reads To read, and an older client's state
 *    (legacyUserState) never meets the new value.
 */
import { describe, it, expect } from 'vitest'
import {
  deriveUserStatus, legacyUserState, storedUserState, countUserStates, userStatusLine,
  USER_STATES, USER_STATE_LABELS, BRIEF_SECTIONS, STATUS_RULE_VERSION,
  type StatusReport, type UserStatusInput,
} from '../../src/core/user-status.js'
import { readStatusReport, FOR_USER_PROMPT } from '../../src/core/session-hooks/builtins.js'
import { phaseForReport } from '../../src/core/sessions/report-phase.js'
import { reportUnderOldWaitRule, statusMissed } from '../../src/core/sessions/status-reconcile.js'
import { routineRunToClose } from '../../src/core/routines/run-close.js'

const NOW = Date.parse('2026-11-02T23:50:00Z')
const AT = '2026-11-02T23:40:00Z'
const MOVED = '2026-11-02T23:39:00Z'
const LATER = '2026-11-03T02:13:00Z'

const own = (r: Partial<StatusReport>): StatusReport => ({ at: AT, ...r })

const OWN_REPORTS: Record<string, StatusReport> = {
  working: own({ state: 'working', now: 'The build of my change is running' }),
  'waiting own': own({ state: 'waiting', waiting_kind: 'own', waiting_on: 'the build of my change' }),
}
const PHASES = ['WAITING', 'IN_PROGRESS', 'NEED_ACTION'] as const
const BACK = {
  process: { processStatus: 'idle' },
  watch: { processStatus: 'stopped', triggers: ['build 8102649705'] },
  clock: { processStatus: 'stopped', waitUntil: LATER },
} as const

describe('the task\'s own work is Working, whatever its phase', () => {
  for (const [name, report] of Object.entries(OWN_REPORTS)) {
    for (const phase of PHASES) {
      for (const [how, facts] of Object.entries(BACK)) {
        // A clock only ever wakes a parked task.
        if (how === 'clock' && phase !== 'WAITING') continue
        for (const hasLeader of [false, true]) {
          it(`${name}, ${phase}, back by ${how}, leader ${hasLeader}`, () => {
            const s = deriveUserStatus({ phase, hasSession: true, hasLeader, phaseChangedAt: MOVED, report, ...facts }, NOW)
            expect(s.state).toBe('working')
            expect(s.carriesOn).toBe(how)
          })
        }
      }
    }
  }

  it('the Sandbox case: parked on its build with a 10-minute trigger and a clock, session idle', () => {
    const s = deriveUserStatus({
      phase: 'WAITING', hasSession: true, processStatus: 'idle', triggers: ['mvzvk04j-ea85'], waitUntil: LATER,
      phaseChangedAt: MOVED, report: OWN_REPORTS.working,
    }, NOW)
    expect(s).toMatchObject({ state: 'working', carriesOn: 'process', until: LATER })
    expect(s.line?.text).toBe('The build of my change is running')
  })

  it('a claim of work with nothing to bring it back is no Working', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped', phaseChangedAt: MOVED, report: OWN_REPORTS.working }, NOW)
    expect(s.state).toBe('waiting')
    expect(s.kind).toBe('stuck')
  })

  it('a failed session is never Working on its claim', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'error', triggers: ['x'], phaseChangedAt: MOVED, report: OWN_REPORTS.working }, NOW)
    expect(s.state).not.toBe('working')
  })

  it('a report older than the latest phase move lends no Working', () => {
    const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', phaseChangedAt: '2026-11-02T23:45:00Z', waitUntil: LATER, report: OWN_REPORTS.working }, NOW)
    expect(s.state).toBe('waiting')
  })

  it('an ask of the user still wins over its own work', () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', openLetter: 'Approve the spend?', phaseChangedAt: MOVED, report: OWN_REPORTS.working }, NOW)
    expect(s.state).toBe('needs')
  })

  it('a task the user snoozed sleeps under Waiting with its mark, its own work or not', () => {
    for (const report of Object.values(OWN_REPORTS)) {
      const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', triggers: ['t'], waitUntil: LATER, snoozedUntil: '2026-11-06', phaseChangedAt: MOVED, report }, NOW)
      expect(s.state).toBe('waiting')
      expect(s.snoozed?.until).toBe('2026-11-06')
    }
  })

  it('a lead never reads Working on an idle claim: it waits on its teams', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', isLead: true, openWorkers: 2, hasSession: true, processStatus: 'idle', triggers: ['t'], phaseChangedAt: MOVED, report: OWN_REPORTS.working }, NOW)
    expect(s.state).toBe('waiting')
  })

  it('Main never reads Working on an idle claim', () => {
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', isMain: true, hasSession: true, processStatus: 'idle', phaseChangedAt: MOVED, report: OWN_REPORTS.working }, NOW)
    expect(s.state).toBe('waiting')
  })
})

describe('a real wait stays Waiting', () => {
  const REAL: Array<[string, StatusReport]> = [
    ['a reviewer', own({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'the code review approval' })],
    ['another task', own({ state: 'waiting', waiting_kind: 'task', waiting_on: 'the migration lead\'s commit' })],
    ['a scheduled time', own({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'the scheduled posting time' })],
  ]
  for (const [name, report] of REAL) {
    it(name, () => {
      const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', triggers: ['t'], waitUntil: LATER, phaseChangedAt: MOVED, report }, NOW)
      expect(s.state).toBe('waiting')
    })
  }
})

describe('something to read with nothing asked is To read', () => {
  const READS: Array<[string, Partial<UserStatusInput>]> = [
    ['a finished result, no lead', { phase: 'NEED_ACTION', report: own({ state: 'done' }) }],
    ['a finished result parked', { phase: 'WAITING', report: own({ state: 'done' }) }],
    ['an answer to the user', { phase: 'NEED_ACTION', report: own({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'CI', answered_person: true }) }],
    ['a kindless ask, no lead', { phase: 'NEED_ACTION', report: own({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'check it', kindless_ask: true }) }],
    ['a turn that asked nothing', { phase: 'NEED_ACTION', processStatus: 'idle' }],
  ]
  for (const [name, facts] of READS) {
    it(name, () => {
      const s = deriveUserStatus({ hasSession: true, phaseChangedAt: MOVED, ...facts }, NOW)
      expect(s.state).toBe('read')
      expect(s.toRead).toBeTruthy()
      expect(s.waitingOn).toBeTruthy()
      expect(s.waitingOn).not.toMatch(/^Nothing/)
    })
    it(`${name}, snoozed: Waiting with its snooze mark`, () => {
      const s = deriveUserStatus({ hasSession: true, phaseChangedAt: MOVED, snoozedUntil: '2026-11-04', ...facts }, NOW)
      expect(s.state).toBe('waiting')
      expect(s.snoozed?.until).toBe('2026-11-04')
    })
  }

  it('a routine run reading To read closes itself', () => {
    const task = { routine_start: { state: 'started' }, phase: 'NEED_ACTION' } as Parameters<typeof routineRunToClose>[0]
    expect(routineRunToClose(task, { state: 'read', toRead: 'result' })).toBe(true)
    // Stored by an older server.
    expect(routineRunToClose(task, { state: 'waiting', toRead: 'result' })).toBe(true)
  })
})

describe('the states every surface reads', () => {
  it('To read sits right under Needs you, with its own name', () => {
    expect(USER_STATES).toEqual(['needs', 'read', 'working', 'waiting', 'done'])
    expect(USER_STATE_LABELS.read).toBe('To read')
    expect(BRIEF_SECTIONS.map((s) => s.state)).toEqual(['needs', 'read', 'working', 'waiting'])
  })

  it('an older stored status reads To read; an older client\'s state never meets read', () => {
    expect(storedUserState({ state: 'waiting', toRead: 'result' })).toBe('read')
    expect(storedUserState({ state: 'waiting', toRead: 'result', snoozed: { until: '2026-11-04' } })).toBe('waiting')
    expect(storedUserState({ state: 'waiting' })).toBe('waiting')
    for (const s of USER_STATES) expect(['needs', 'working', 'waiting', 'done']).toContain(legacyUserState(s))
  })

  it('counts carry To read, and the line names it only when there is one', () => {
    const c = countUserStates([{ state: 'needs' }, { state: 'read' }, { state: 'working' }])
    expect(c).toEqual({ needs: 1, read: 1, working: 1, waiting: 0, done: 0 })
    expect(userStatusLine(c)).toBe('1 Needs you · 1 To read · 1 Working · 0 Waiting / snoozed · 0 Completed')
    expect(userStatusLine({ needs: 0, working: 1, waiting: 2, done: 0 })).not.toContain('To read')
  })
})

describe('the self-report says own work is working', () => {
  it('the prompt names the task\'s own build, test run and deploy as working, and lists own', () => {
    expect(FOR_USER_PROMPT).toMatch(/working while the task's own work goes on[^.]*build, test run, CI run, deploy or land/)
    expect(FOR_USER_PROMPT).toMatch(/<outside \| task \| lead \| machine \| own>/)
    // A build is no longer listed as a reason to wait.
    const waitingLine = FOR_USER_PROMPT.split('\n').find((l) => l.startsWith('FOR_USER_STATE'))!
    expect(waitingLine.slice(waitingLine.indexOf('waiting ONLY'))).not.toMatch(/a build|CI run/)
  })

  it('reads an own: wait', () => {
    const r = readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: own: the build of my change\nFOR_USER_NOW: building')
    expect(r).toMatchObject({ state: 'waiting', waiting_kind: 'own', waiting_on: 'the build of my change' })
  })

  it('an own: wait may park the task (its trigger and clock bring it back)', () => {
    expect(phaseForReport(own({ state: 'waiting', waiting_kind: 'own', waiting_on: 'my build' }), {}, true)).toBe('WAITING')
  })
})

describe('a wait reported under the old rule is asked once again', () => {
  const session = { process_status: 'idle', last_status_change: '2026-11-02T23:30:00Z' } as Parameters<typeof statusMissed>[1]
  const task = (r: StatusReport) => ({ phase: 'WAITING', status_report: r }) as Parameters<typeof statusMissed>[0]

  it('an outside wait with no rule stamp is asked again; one under the current rule is not', () => {
    const old = own({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'the build', turn_ended_at: '2026-11-02T23:30:00Z' })
    expect(reportUnderOldWaitRule(old)).toBe(true)
    expect(statusMissed(task(old), session, NOW)).not.toBeNull()
    const fresh = { ...old, rule: STATUS_RULE_VERSION }
    expect(reportUnderOldWaitRule(fresh)).toBe(false)
    expect(statusMissed(task(fresh), session, NOW)).toBeNull()
  })

  it('a wait set by a lead or on the user, or any other state, is not asked again', () => {
    expect(reportUnderOldWaitRule(own({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'x', by: 'human' }))).toBe(false)
    expect(reportUnderOldWaitRule(own({ state: 'waiting', waiting_kind: 'task', waiting_on: 'x' }))).toBe(false)
    expect(reportUnderOldWaitRule(own({ state: 'done' }))).toBe(false)
  })
})
