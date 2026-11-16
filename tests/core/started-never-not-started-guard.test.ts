/**
 * Not started means no session ever ran the task (2026-11-16, the user: "why this si nto stared, I
 * mean not starrted means no sesisonc reate"). Five tasks imported from outside Walnut sat under
 * Not started with a finished session and a full result, because their phase stayed TODO and the
 * status read TODO alone.
 *
 * The class: every way a session gets attached to a task. Three guards:
 *   1. deriveUserStatus never answers Not started for a task with a session that ran, whatever its
 *      phase and other facts (enumerated from PHASE_ORDER). A start's own record before its CLI is
 *      up is no session that ran: Working while the start is on the way, "Did not start: why" when
 *      it failed.
 *   2. statusInputOf counts every store a link is written to (the slot, the history, a record
 *      naming the task), so any path that links a session sets hasSession.
 *   3. Every file that writes such a link is listed below. A new one fails until it is listed,
 *      so whoever adds it checks that its link goes through one of the writers statusInputOf reads.
 * The importer's own phase and its one-time move are pinned in external-session-import.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PHASE_ORDER } from '../../src/core/phase.js'
import { deriveUserStatus, type UserStatusInput } from '../../src/core/user-status.js'
import { statusInputOf, type StatusFacts } from '../../src/core/user-status-sync.js'
import type { Task } from '../../src/core/types.js'

const NOW = Date.parse('2026-11-16T20:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('a task with a session never reads Not started', () => {
  const processes = [undefined, 'running', 'idle', 'stopped', 'error'] as const
  const roles: Array<Partial<UserStatusInput>> = [{}, { hasLeader: true }, { isMain: true }, { isLead: true }, { projectLead: true }]
  const extras: Array<Partial<UserStatusInput>> = [
    {},
    { report: { at: ago(60_000), state: 'done' } },
    { report: { at: ago(60_000), state: 'needs', ask: 'Approve the plan?' } },
    { report: { at: ago(60_000), state: 'waiting', waiting_kind: 'outside', waiting_on: 'CI' } },
    { lastWords: 'The finding: the alarm is a false positive.' },
    { triggers: ['CI watch'] },
    { openWorkers: 2 },
    { markedByPerson: true },
  ]

  it('for every phase, process state, role and fact', () => {
    let checked = 0
    for (const phase of PHASE_ORDER) {
      for (const processStatus of processes) {
        for (const role of roles) {
          for (const extra of extras) {
            const input: UserStatusInput = { phase, hasSession: true, ...(processStatus ? { processStatus } : {}), ...role, ...extra }
            const status = deriveUserStatus(input, NOW)
            expect(status.kind, JSON.stringify(input)).not.toBe('not-started')
            checked++
          }
        }
      }
    }
    expect(checked).toBe(PHASE_ORDER.length * processes.length * roles.length * extras.length)
  })

  it('a TODO with a finished session is a result to read, a running one is Working', () => {
    expect(deriveUserStatus({ phase: 'TODO', hasSession: true, processStatus: 'stopped' }, NOW).state).toBe('read')
    expect(deriveUserStatus({ phase: 'TODO', hasSession: true, processStatus: 'running' }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'TODO', hasSession: true, processStatus: 'stopped', hasLeader: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead' })
  })

  // Review round 1: task-start.ts makes the session record (idle, awaiting_spawn) and links it
  // before the CLI is up, with the phase still TODO; that window is no finished turn.
  it('a start on the way is Working, a failed one says why, never a result to read', () => {
    expect(deriveUserStatus({ phase: 'TODO', hasSession: true, processStatus: 'idle', startInFlight: true }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'TODO', hasSession: true, processStatus: 'idle', startInFlight: true, hasLeader: true }, NOW).state).toBe('working')
    const failed = deriveUserStatus({ phase: 'TODO', hasSession: true, processStatus: 'error', startFailed: 'no host had room' }, NOW)
    expect(failed).toMatchObject({ state: 'waiting', kind: 'not-started', waitingOn: 'Did not start: no host had room' })
    // Once a turn ran after it, the failure is gone (statusInputOf drops it) and the turn speaks.
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', startFailed: 'no host had room' }, NOW).kind).not.toBe('not-started')
  })

  // A person or a lead set it back to TODO with its sessions in its history (a reopen): it was
  // started, so what its last turn left is read, never Not started.
  it('a reopened task with a session reads what its last turn left', () => {
    expect(deriveUserStatus({ phase: 'TODO', hasSession: true, processStatus: 'stopped', lastWords: 'Done: the fix landed.' }, NOW).state).toBe('read')
  })

  it('a task no session ever ran still reads Not started', () => {
    expect(deriveUserStatus({ phase: 'TODO', hasSession: false }, NOW)).toMatchObject({ state: 'waiting', kind: 'not-started' })
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: false }, NOW)).toMatchObject({ state: 'waiting', kind: 'not-started' })
  })
})

describe('statusInputOf counts every store a session link is written to', () => {
  const task = (over: Partial<Task> = {}): Task => ({
    id: 't1', title: 'Imported run', phase: 'TODO', status: 'todo', priority: 'none', project: 'p', source: 'local',
    session_ids: [], description: '', summary: '', note: '', created_at: ago(3_600_000), updated_at: ago(3_600_000), ...over,
  } as Task)
  const facts = (sessions: Array<[string, Record<string, unknown>]>, linked: string[] = sessions.map(([sid]) => sid)): StatusFacts => ({
    sessions: new Map(sessions) as StatusFacts['sessions'], letters: new Map(), choices: new Map(), requestsFrom: new Map(),
    triggers: new Map(), schedules: new Map(), titles: new Map(), sessionsOf: new Map(linked.length ? [['t1', linked]] : []),
  })
  const cases: Record<string, { task: Task; facts: StatusFacts }> = {
    'the slot (linkSession, linkSessionSlot)': { task: task({ session_id: 's1' }), facts: facts([]) },
    'a session record naming the task (createSessionRecord, importSessionRecord, linkSessionToTask)': { task: task(), facts: facts([['s1', { processStatus: 'stopped', taskId: 't1' }]]) },
    'the history (addSessionToHistory)': { task: task({ session_ids: ['s1'] }), facts: facts([['s1', { processStatus: 'stopped' }]]) },
  }
  for (const [name, c] of Object.entries(cases)) {
    it(name, () => {
      const input = statusInputOf(c.task, c.facts, NOW)
      expect(input.hasSession).toBe(true)
      expect(deriveUserStatus(input, NOW).kind).not.toBe('not-started')
    })
  }
  it('and none of them: Not started', () => {
    expect(deriveUserStatus(statusInputOf(task(), facts([]), NOW), NOW).kind).toBe('not-started')
  })
  it('a start whose record waits for its CLI is on the way: Working', () => {
    const waiting = facts([['s1', { processStatus: 'idle', taskId: 't1', errorReason: 'awaiting_spawn' }]])
    expect(statusInputOf(task({ session_id: 's1' }), waiting, NOW).startInFlight).toBe(true)
    expect(deriveUserStatus(statusInputOf(task({ session_id: 's1' }), waiting, NOW), NOW).state).toBe('working')
    const starting = task({ session_id: 's1', last_start: { id: 'st1', at: ago(1_000), state: 'starting' } } as Partial<Task>)
    expect(deriveUserStatus(statusInputOf(starting, facts([['s1', { processStatus: 'idle', taskId: 't1' }]]), NOW), NOW).state).toBe('working')
  })
})

/** The writers of a task's session link (session-tracker.ts, task-manager.ts). */
const LINK_WRITERS = /\b(linkSession|linkSessionSlot|linkSessionToTask|addSessionToHistory|createSessionRecord|importSessionRecord)\(/

/**
 * Every file that attaches a session to a task, by a writer statusInputOf reads (above). Paths
 * that mint a task for a session that already ran (an import, an adopted search result, a
 * promoted side thread, a fork) get a session-derived status from that link whatever their phase.
 */
const LINKING_FILES = [
  'src/core/ai/ai-agent.ts',
  'src/core/offline-merge/apply-session.ts',
  'src/core/sessions/adopt-search-session.ts',
  'src/core/sessions/cloud-chat-lane.ts',
  'src/core/sessions/engine-switch-resume.ts',
  'src/core/sessions/engine-switch-watch.ts',
  'src/core/sessions/engine-switch.ts',
  'src/core/sessions/external-session-import.ts',
  'src/core/sessions/lane-ask-link.ts',
  'src/core/sessions/lane-ask-repair.ts',
  'src/core/sessions/lane-fork.ts',
  'src/core/sessions/personal-ai-lane.ts',
  'src/core/sessions/quick-start.ts',
  'src/core/sessions/session-controls.ts',
  'src/core/sessions/session-lifecycle.ts',
  'src/core/sessions/session-record-recovery.ts',
  'src/core/sessions/session-rewind.ts',
  'src/core/sessions/side-thread-fork.ts',
  'src/core/sessions/side-thread-promote.ts',
  'src/core/sessions/task-start.ts',
  'src/core/subagents/on-host.ts',
  'src/providers/acp-session.ts',
  'src/providers/claude-code-session.ts',
  'src/web/routes/test-task-fixture.ts',
]

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

describe('every path that attaches a session to a task is listed', () => {
  it('matches the source', () => {
    const root = path.resolve(__dirname, '../..')
    const found = walk(path.join(root, 'src'))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .filter((f) => f !== 'src/core/session-tracker.ts' && f !== 'src/core/task-manager.ts')
      .filter((f) => LINK_WRITERS.test(fs.readFileSync(path.join(root, f), 'utf8')))
      .sort()
    const added = found.filter((f) => !LINKING_FILES.includes(f))
    expect(added, 'A new path attaches a session to a task. Link it through one of LINK_WRITERS (statusInputOf reads '
      + 'each of them, so its task never reads Not started), then list the file in LINKING_FILES.').toEqual([])
    expect(LINKING_FILES.filter((f) => !found.includes(f)), 'Listed files that no longer link a session: drop them.').toEqual([])
  })
})
