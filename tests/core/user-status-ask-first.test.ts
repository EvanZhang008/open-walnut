/**
 * An open ask of the user is Needs you in every open phase, whatever else the task holds
 * (src/core/user-status.ts openAskOf). 2026-11-19, the user, on a deploy task whose report asked for
 * his yes to post in a team channel while it read "Waiting: A watch: the rollout":
 *   "如果这个东西需要人去 respond，他就不应该放在 wait ... 你必须要只有那个在等 external 时候才放在 wait。"
 * That day a trigger's wake took the task off NEED_ACTION, the CLI settled the line without a turn,
 * no report came, and the ask (now older than the phase move) was read as an old turn's; the
 * IN_PROGRESS and WAITING branches never looked at an ask at all.
 *
 * The class: every input that can make a task read Waiting, crossed with every kind of ask and every
 * open phase. A new input field fails the enumeration until it is listed here as a wait source (and
 * so crossed with every ask) or as no wait, with why.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { deriveUserStatus, type StatusReport, type UserStatusInput } from '../../src/core/user-status.js'
import { PHASE_ORDER, TERMINAL_PHASES } from '../../src/core/phase.js'

const ROOT = path.resolve(__dirname, '../..')
const NOW = Date.parse('2026-11-19T20:30:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const later = (ms: number) => new Date(NOW + ms).toISOString()
const rep = (r: Partial<StatusReport>): StatusReport => ({ state: 'working', at: ago(60_000), ...r } as StatusReport)

/** Every kind of open ask of the user, each alone. */
const ASKS: Record<string, Partial<UserStatusInput>> = {
  'its current report asks': { report: rep({ state: 'needs', ask: 'May I post the question to the team channel?' }) },
  // The case: the phase moved after the ask (a wake that ran no turn), and nobody wrote since.
  'its report asked before the phase moved': { phaseChangedAt: ago(10 * 60_000), report: rep({ state: 'needs', ask: 'May I post the question to the team channel?', at: ago(30 * 60_000) }) },
  'its report waits on the user': { report: rep({ state: 'waiting', waiting_kind: 'you', waiting_on: 'Your yes to post the question' }) },
  'an unanswered decision letter': { openLetter: 'Approve the quota raise' },
  'an unanswered Board choice': { openChoice: 'Which region first?' },
}

/** Every input that makes a task read Waiting on its own, with a value that does. */
const WAIT_SOURCES: Record<string, Partial<UserStatusInput>> = {
  triggers: { triggers: ['Rollout pipeline watch'] },
  ownWorkTriggers: { ownWorkTriggers: ['Results of my test run'] },
  schedules: { schedules: [{ name: 'Nightly digest', nextAt: later(3_600_000) }] },
  waitUntil: { waitUntil: later(3_600_000) },
  waitingOnTasks: { waitingOnTasks: ['Review: the diff'] },
  workersAtWork: { workersAtWork: ['Review: the diff'] },
  openWorkers: { openWorkers: 2 },
  outliving: { outliving: ['background'] as UserStatusInput['outliving'] },
  teamStoppedAt: { teamStoppedAt: ago(5 * 60_000) },
  reportPending: { reportPending: true },
  usageLimit: { usageLimit: { state: 'waiting', engine: 'claude', window: 'five_hour', resetsAt: later(3_600_000), dueAt: later(3_660_000) } as UserStatusInput['usageLimit'] },
  endpointWait: { endpointWait: { state: 'waiting', url: 'https://model.example', since: ago(60_000) } as UserStatusInput['endpointWait'] },
  autoRetryAt: { processStatus: 'error', errorMessage: 'overloaded', autoRetryAt: later(60_000) },
  restartLoss: { restartLoss: { state: 'resuming' } },
  hostDown: { hostDown: 'clouddev' },
  undeliveredMessage: { undeliveredMessage: 'Not delivered: the host is away' },
  hasLeader: { hasLeader: true },
  processStatus: { processStatus: 'stopped' },
  lastWords: { lastWords: 'Checked the pipeline; nothing new.' },
  // A start waiting for a host slot (a wake that could not run yet), or one that did not happen.
  startQueue: { startQueue: { host: 'clouddev', reason: 'no free start slot' } },
  startFailed: { startFailed: 'no host had room' },
  // An imported program's run (PROGRAM_RUN_TAG): waits on that program, unless it really asks.
  programRun: { programRun: true },
}

/** Inputs that are no wait of their own, or read before any ask by design, and why. */
const NOT_A_WAIT: Record<string, string> = {
  phase: 'the phase is crossed below',
  status: 'done is Done, whatever it asks',
  hasSession: 'set on every case',
  startInFlight: 'a start on its way reads Working',
  errorMessage: 'part of a failure, which is the user\'s or its lead\'s (failureOf)',
  errorReason: 'part of a failure',
  errorKind: 'part of a failure',
  projectLead: 'routing of a failure, not a wait',
  leaderOpen: 'routing of a failure, not a wait',
  hasMain: 'routing of a failure, not a wait',
  statusSince: 'a timestamp',
  pendingPermissionTool: 'a live prompt is itself Needs you, read first',
  openReview: 'a review letter adds a category to a result, never a wait',
  threads: 'a thread waiting on the user makes it Needs you (taskThreadNeeds)',
  openChoiceAt: 'part of openChoice',
  openChoiceRef: 'part of openChoice',
  isMain: 'Main never reads Needs you (orgNodeNeverNeeds): its asks stay in its chat',
  isLead: 'a lead never reads Needs you (orgNodeNeverNeeds): its asks stay in its chat',
  markedByPerson: 'a person\'s own Needs you mark, itself an ask',
  personSpokeAt: 'a person\'s message answers an older ask: crossed below',
  owedHold: 'what a close left for the user, itself Needs you, read first',
  workspaceHold: 'a workspace question for the person, itself Needs you, read first',
  phaseChangedAt: 'crossed in the asks above',
  report: 'crossed in the asks above',
  dueDate: 'a due date adds words, never a wait',
  checkRanAt: 'when a watch last checked: a stamp on an ask',
  askCheckedAt: 'when a watch last checked the ask: a stamp on it',
  // The person chose to put it away until later (2026-10-27, snooze is a real state).
  snoozedUntil: 'the person\'s own snooze, their choice over the ask',
  openLetter: 'crossed in the asks above',
  openChoice: 'crossed in the asks above',
}

describe('an open ask of the user is Needs you, whatever else wakes the task', () => {
  const open = PHASE_ORDER.filter((p) => !TERMINAL_PHASES.has(p))

  it('every ask, crossed with every wait source, in every open phase, reads Needs you with that ask', () => {
    expect(open.length).toBeGreaterThan(2)
    const wrong: string[] = []
    for (const phase of open) {
      for (const [askName, ask] of Object.entries(ASKS)) {
        for (const [waitName, wait] of Object.entries({ none: {}, ...WAIT_SOURCES })) {
          const input: UserStatusInput = { phase, hasSession: true, processStatus: 'idle', ...wait, ...ask }
          const s = deriveUserStatus(input, NOW)
          if (s.state !== 'needs') wrong.push(`${phase} + ${askName} + ${waitName}: ${s.state} (${s.waitingOn ?? s.toRead ?? ''})`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  // The same day, its next trigger turn reported "needs you" with no question: something to read.
  it('a current report that needs the user but asks nothing is theirs to read in every open phase, never a wait', () => {
    const wrong: string[] = []
    for (const phase of open) {
      for (const [waitName, wait] of Object.entries({ none: {}, ...WAIT_SOURCES })) {
        if (waitName === 'reportPending') continue
        const s = deriveUserStatus({ phase, hasSession: true, processStatus: 'idle', ...wait, report: rep({ state: 'needs' }) }, NOW)
        if (s.state === 'waiting') wrong.push(`${phase} + ${waitName}: waiting (${s.waitingOn})`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('the case that showed it: a watch, a trigger wake that ran no turn, and the ask from before it', () => {
    const s = deriveUserStatus({
      phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', hasLeader: true,
      triggers: ['WSS ListBucket rollout'], phaseChangedAt: ago(60 * 60_000),
      report: rep({ state: 'needs', ask: 'May I ask a colleague in the team channel why the test keeps failing?', at: ago(78 * 60_000) }),
    }, NOW)
    expect(s).toMatchObject({ state: 'needs', source: 'session', ask: 'May I ask a colleague in the team channel why the test keeps failing?' })
  })

  it('a person\'s message after an older ask answers it: the watch speaks again', () => {
    const s = deriveUserStatus({
      phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', triggers: ['Rollout pipeline watch'],
      phaseChangedAt: ago(10 * 60_000), personSpokeAt: ago(12 * 60_000),
      report: rep({ state: 'needs', ask: 'May I post the question?', at: ago(30 * 60_000) }),
    }, NOW)
    expect(s).toMatchObject({ state: 'waiting', waitingOn: 'A watch: Rollout pipeline watch' })
  })

  // Review round 1: a wait on a clock, a check or a build is no ask, in any phase but NEED_ACTION
  // (where the phase itself says it is the user's turn).
  it('a waiting report that does not name the user stays a wait outside NEED_ACTION, with or without a watch', () => {
    const waits: Partial<StatusReport>[] = [
      { waiting_kind: 'time', waiting_on: 'next check at 21:00' },
      { waiting_kind: 'other', waiting_on: 'the nightly build' },
      { waiting_on: 'CI to finish' },
      { waiting_kind: 'outside', waiting_on: 'the vendor\'s reply' },
      { waiting_kind: 'task', waiting_on: 'The review task' },
    ]
    const wrong: string[] = []
    for (const phase of open.filter((p) => p !== 'NEED_ACTION' && p !== 'TODO')) {
      for (const r of waits) {
        for (const extra of [{}, { triggers: ['CI on main'] }]) {
          const s = deriveUserStatus({ phase, hasSession: true, processStatus: 'idle', report: rep({ state: 'waiting', ...r }), ...extra }, NOW)
          if (s.state === 'needs') wrong.push(`${phase} + ${r.waiting_kind ?? 'no kind'} "${r.waiting_on}"${'triggers' in extra ? ' + watch' : ''}: needs "${s.ask}"`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('an ask standing from before the phase move reads as checked when it was said, not at the move', () => {
    const s = deriveUserStatus({ ...ASKS['its report asked before the phase moved'], phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', triggers: ['Rollout pipeline watch'] }, NOW)
    expect(s).toMatchObject({ state: 'needs', checkedAt: ago(30 * 60_000), checkedBy: 'session' })
  })

  it('a turn running is Working, and nothing asked is still Waiting on its watch', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', ...ASKS['its current report asks'] }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', triggers: ['CI on main'] }, NOW))
      .toMatchObject({ state: 'waiting', waitingOn: 'A watch: CI on main' })
  })

  it('every field of UserStatusInput is a listed wait source or says why it is none', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/user-status.ts'), 'utf8')
    const body = src.slice(src.indexOf('export interface UserStatusInput {'))
    const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1])
    expect(fields.length).toBeGreaterThan(40)
    const unlisted = fields.filter((f) => !(f in WAIT_SOURCES) && !(f in NOT_A_WAIT))
    expect(unlisted, 'A new status input: list it in WAIT_SOURCES (it can make a task read Waiting, so it is crossed with every ask) or NOT_A_WAIT with why').toEqual([])
    const gone = [...Object.keys(WAIT_SOURCES), ...Object.keys(NOT_A_WAIT)].filter((f) => !fields.includes(f))
    expect(gone, 'listed here but no longer a field').toEqual([])
  })

  it('derive reads the open ask before every phase branch and every wait', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/user-status.ts'), 'utf8')
    const body = src.slice(src.indexOf('function derive(input: UserStatusInput'))
    const asked = body.indexOf('openAskOf(input')
    expect(asked, 'derive no longer calls openAskOf').toBeGreaterThan(0)
    expect(body.indexOf("input.phase === 'NEED_ACTION'")).toBeGreaterThan(asked)
    const before = body.slice(0, asked)
    expect(before.match(/state: 'waiting'/g) ?? [], 'a Waiting read before the open ask').toEqual([])
  })
})
