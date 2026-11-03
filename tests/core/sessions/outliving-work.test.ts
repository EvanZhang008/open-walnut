/**
 * A session's own work that runs on after its turn is ONE list (src/core/sessions/outliving-work.ts):
 * a background command or subagent, its agent team, an armed wakeup, an armed /loop. 2026-11-03,
 * the user's lead: a worker's background subagent ran 84 minutes, the task read as stopped, its
 * lead was told "stopped without completing its task" when the subagent ended (the stream said "no
 * background tasks" a moment before the CLI's follow-up turn), and nudged it.
 *
 * Guards for the class:
 *  - every field of the daemon's SessionSnapshot is classified: a source of such work, or not one
 *    (with why). A new field fails until someone says which it is.
 *  - each source maps from its signal, and Claude Code's real stream shapes fold into it: a
 *    background Agent and a run_in_background Bash are detached work, a Workflow holds the turn open.
 *  - the decisions the user reads (the task's status, the idle reap, a request's settling, the
 *    lead's "stopped", the drain of the last piece) go through the shared definition.
 *  - a file that reads one of the raw signals is listed with its role; a new reader fails here
 *    until it uses the shared definition or says why it reads the raw one.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { foldLines, assembleSnapshot, isWakeupArmed } from '../../../src/providers/daemon-fold.js'
import { projectProcessStatus } from '../../../src/core/session-snapshot-apply.js'
import { outlivingOf, outlivingLine, OUTLIVING_SOURCES, type OutlivingSource } from '../../../src/core/sessions/outliving-work.js'
import { deriveUserStatus } from '../../../src/core/user-status.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** SessionSnapshot fields that signal work running on after the turn, and their source. */
const OUTLIVING_FIELDS: Record<string, OutlivingSource> = {
  detachedBgCount: 'background',
  teamActive: 'team',
  wakeupAt: 'wakeup',
  cronActive: 'loop',
}
/** SessionSnapshot fields that are no such work, with why. */
const NOT_OUTLIVING: Record<string, string> = {
  v: 'a stream offset',
  cliState: 'the CLI process state',
  turnActive: 'the turn itself, not work after it',
  pendingPermission: 'a prompt the user answers',
  gatingBgCount: 'work that holds the turn open (a Workflow, a foreground task): the turn is not over',
  lastResult: 'the last turn result',
  pid: 'the process id',
  exitCode: 'how the process ended',
  streamEpoch: 'the stream file identity',
  rewrittenFrom: 'a stream compaction marker',
}

describe('every SessionSnapshot field is classified', () => {
  it('as a source of work after the turn, or not one', () => {
    const src = read('src/providers/daemon-fold.ts')
    const body = src.slice(src.indexOf('export interface SessionSnapshot {'), src.indexOf('export interface FoldState'))
    const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1])
    expect(fields.length).toBeGreaterThan(8)
    const unclassified = fields.filter((f) => !(f in OUTLIVING_FIELDS) && !(f in NOT_OUTLIVING))
    expect(unclassified, 'classify the new SessionSnapshot field in this test (and outliving-work.ts if it is one)').toEqual([])
    expect(new Set(Object.values(OUTLIVING_FIELDS))).toEqual(new Set(Object.keys(OUTLIVING_SOURCES)))
  })
})

describe('outlivingOf', () => {
  it('names each source from its signal, in order, and words them', () => {
    expect(outlivingOf({})).toEqual([])
    expect(outlivingOf({ detachedBgCount: 2 })).toEqual(['background'])
    expect(outlivingOf({ teamActive: true })).toEqual(['team'])
    expect(outlivingOf({ wakeupArmed: true })).toEqual(['wakeup'])
    expect(outlivingOf({ cronActive: true })).toEqual(['loop'])
    const all = outlivingOf({ detachedBgCount: 1, teamActive: true, wakeupArmed: true, cronActive: true })
    expect(all).toEqual(['background', 'team', 'wakeup', 'loop'])
    for (const s of all) expect(outlivingLine([s])).toContain(OUTLIVING_SOURCES[s])
    expect(outlivingLine([])).toBe('')
  })
})

// Real Claude Code stream shapes (a worker's stream, 2026-11-03), ids and text neutral.
const SID = 'outliving-sid'
const user = JSON.stringify({ type: 'user', session_id: SID, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok', session_id: SID })
const idle = JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
const started = (id: string, taskType: string, backgrounded?: boolean) => JSON.stringify({
  type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `tu-${id}`, description: 'work',
  ...(backgrounded === undefined ? {} : { is_backgrounded: backgrounded }), task_type: taskType, session_id: SID,
})
const level = (ids: Array<[string, string]>) => JSON.stringify({
  type: 'system', subtype: 'background_tasks_changed', tasks: ids.map(([id, t]) => ({ task_id: id, task_type: t, description: 'work' })), session_id: SID,
})
const snapOf = (lines: string[]) => assembleSnapshot({ foldState: foldLines(lines.join('\n') + '\n'), pendingCtrl: null, dead: false, pid: 1, exitCode: null })

describe('Claude Code stream shapes fold into the sources', () => {
  it.each([['a background Agent subagent', 'local_agent'], ['a run_in_background Bash command', 'local_bash']])(
    '%s is detached work after the turn: running, and the status reads Working', (_name, taskType) => {
      const snap = snapOf([user, started('a1', taskType, true), level([['a1', taskType]]), result, idle])
      expect(snap.turnActive).toBe(false)
      expect(snap.detachedBgCount).toBe(1)
      expect(outlivingOf({ detachedBgCount: snap.detachedBgCount })).toEqual(['background'])
      expect(projectProcessStatus(snap)).toBe('running')
      // Its drain ("no background tasks") leaves nothing running: the follow-up turn is the CLI's.
      const drained = snapOf([user, started('a1', taskType, true), level([['a1', taskType]]), result, idle, level([])])
      expect(drained.detachedBgCount).toBe(0)
      expect(projectProcessStatus(drained)).toBe('idle')
    })

  it('a Workflow (no is_backgrounded) holds the turn open, so it is no work after the turn', () => {
    const snap = snapOf([user, started('w1', 'local_workflow'), level([['w1', 'local_workflow']]), result, idle])
    expect(snap.gatingBgCount).toBe(1)
    expect(snap.detachedBgCount).toBe(0)
    expect(projectProcessStatus(snap)).toBe('running')
  })

  it('an armed wakeup is read by the caller through isWakeupArmed', () => {
    expect(outlivingOf({ wakeupArmed: isWakeupArmed(Date.now() + 600_000) })).toEqual(['wakeup'])
    expect(outlivingOf({ wakeupArmed: isWakeupArmed(Date.now() - 3_600_000) })).toEqual([])
  })
})

describe('the task reads Working while its own work runs on', () => {
  const base = { hasSession: true, hasLeader: true }
  it.each(['background', 'team', 'wakeup', 'loop'] as OutlivingSource[])('%s, idle process, whatever its phase', (source) => {
    for (const phase of ['IN_PROGRESS', 'NEED_ACTION', 'WAITING']) {
      const s = deriveUserStatus({ ...base, phase, processStatus: 'idle', outliving: [source] })
      expect(s.state, `${source} ${phase}`).toBe('working')
      expect(s.carriesOn).toBe('process')
      expect(s.now).toContain(OUTLIVING_SOURCES[source])
    }
  })

  it('but not over an ask of the user, a finished task, a failed or stopped process, Main or a lead', () => {
    const ask = { state: 'needs' as const, ask: 'Pick a name for the release', at: new Date().toISOString() }
    expect(deriveUserStatus({ ...base, phase: 'NEED_ACTION', processStatus: 'idle', outliving: ['background'], report: ask }).state).toBe('needs')
    expect(deriveUserStatus({ ...base, phase: 'COMPLETE', processStatus: 'idle', outliving: ['background'] }).state).toBe('done')
    expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'error', outliving: ['background'] }).state).not.toBe('working')
    expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'idle', outliving: ['loop'], isLead: true }).state).not.toBe('working')
    expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'idle', outliving: [] }).state).not.toBe('working')
  })

  it.each(['you', 'outside', 'task', 'lead', 'machine'] as const)('a /loop that re-checks a wait on %s is watching, not working', (kind) => {
    const report = { state: 'waiting' as const, waiting_kind: kind, waiting_on: 'The release review', at: new Date().toISOString() }
    const s = deriveUserStatus({ ...base, phase: 'WAITING', processStatus: 'idle', outliving: ['loop'], report })
    expect(s.state).not.toBe('working')
  })

  it('a report of its own work, or of nothing, still reads Working', () => {
    for (const report of [
      { state: 'waiting' as const, waiting_kind: 'own' as const, waiting_on: 'Its test run', at: new Date().toISOString() },
      { state: 'working' as const, at: new Date().toISOString() },
      { state: 'waiting' as const, waiting_kind: 'other' as const, waiting_on: 'Its subagent', at: new Date().toISOString() },
    ]) {
      expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'idle', outliving: ['team'], report }).state).toBe('working')
    }
  })
})

describe('the decisions go through the shared definition', () => {
  it.each([
    ['src/providers/claude-code-session.ts', /get outlivingWork\(\)[\s\S]{0,200}outlivingOf\(\{[\s\S]{0,400}_detachedBgCount\(\)[\s\S]{0,80}_teamActive && this\._teamIdleTimer !== null[\s\S]{0,80}_wakeupArmed\(\)[\s\S]{0,80}_loopActive\(\)/],
    // A /loop's fires are turns of their own: no request settling or reply nudge waits on it.
    ['src/providers/claude-code-session.ts', /get workOutlivesTurn\(\): boolean \{\s*return this\.outlivingWork\.some\(\(s\) => s !== 'loop'\)/],
    ['src/core/user-status-sync.ts', /outlivingWorkOf\(/],
    ['src/core/user-status.ts', /input\.outliving/],
    ['src/core/session-health-monitor.ts', /hasWorkOutlivingTurn\?\.\(/],
    ['src/core/sessions/request-progress.ts', /hasWorkOutlivingTurn\(/],
    ['src/core/sessions/turn-end-wait.ts', /hasWorkOutlivingTurn\(/],
    ['src/core/session-hooks/builtins.ts', /workRunsOn[\s\S]{0,400}outlivingWorkOf\(childSid\)\.length > 0/],
    ['src/core/session-snapshot-apply.ts', /outlivingOf\(\{/],
  ])('%s', (file, pattern) => {
    expect(read(file)).toMatch(pattern)
  })
})

/** Files that read a raw signal of such work, by role. A new one is listed here with its reason. */
const RAW_READERS: Record<string, string> = {
  'src/core/sessions/outliving-work.ts': 'the shared definition',
  'src/providers/claude-code-session.ts': 'the live runner: keeps the signals and its turn-over rules',
  'src/providers/daemon-fold.ts': 'the daemon fold that makes the signals',
  'src/providers/daemon-source.ts': 'the daemon (JS twin): folds and adopts',
  'src/providers/daemon-standalone.ts': 'the daemon (bun twin): folds and adopts',
  'src/providers/stream-fold-core.ts': 'the daemon stream fold',
  'src/providers/remote-session-manager.ts': 'arms the runner from a daemon snapshot',
  'src/core/session-reconcile.ts': 'the server-side fold of a stream tail',
  'src/core/session-snapshot-apply.ts': 'projects a snapshot to the process status and settles turns',
  'src/core/sessions/restart-loss.ts': 'what a restart interrupted, from the fold at death',
  'src/core/sessions/endpoint-wait-takes.ts': 'a session:result: the endpoint wait takes only a real turn end',
  'src/core/human-inbox/item-status.ts': 'an inbox item\'s live status from a snapshot',
  'src/core/session-health-monitor.ts': 'the idle reap: a /loop gets the cron timeout',
  'src/core/sessions/session-lifecycle.ts': 'refuses to terminate a /loop owner (cron_owner)',
  'src/core/session-history.ts': 'carries the team signal across a restart',
  'src/core/event-types.ts': 'the session:result payload',
  'src/web/server.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/hints/hint-drift-live.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/org/thread-answers.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/session-auto-continue.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/session-hooks/derive/session.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/sessions/lane-turn-gate.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/sessions/lane-turn.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/sessions/thread-takeaway.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/sessions/thread-title.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/time-tracking/agent-time.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/triage/runs.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/observability/invariants.ts': 'a session:result: an intermediate result is no turn end',
  'src/core/observability/recorder.ts': 'records a session:result',
  'src/core/observability/types.ts': 'the recorder\'s turn record',
}

const RAW_SIGNAL = /detachedBgCount|_detachedBgCount\(\)|detachedBgActive|\bteamActive\b|_teamActive|\bwakeupAt\b|_wakeupArmed\(\)|wakeupPending|\bcronActive\b|_cronArmed|isCronArmed|\bcronArmed\b/

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return sources(rel)
    return /\.tsx?$/.test(e.name) ? [rel] : []
  })
}

describe('a reader of a raw signal is listed', () => {
  it('every file in src that reads one, and no listed file that no longer does', () => {
    const readers = sources('src').filter((f) => RAW_SIGNAL.test(read(f)))
    expect(readers.filter((f) => !(f in RAW_READERS)),
      'use sessions/outliving-work.ts (outlivingOf, sessionRunner.hasWorkOutlivingTurn / outlivingWorkOf), or list the file here with why it reads the raw signal').toEqual([])
    expect(Object.keys(RAW_READERS).filter((f) => !readers.includes(f))).toEqual([])
  })
})
