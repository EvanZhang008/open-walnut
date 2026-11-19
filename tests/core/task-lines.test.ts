/**
 * A task's lines (src/core/task-lines.ts): each thing it asks, does and waits on at once, with its
 * own state (2026-11-19, the user: "它这个里面至少有几个小 thread……那这几个 thread 这这个 status
 * 是什么？……总体的 status 当然就是一个 aggregate"). The status stays the authority in this first
 * step; the lines must never contradict it: its state always has a line, and a Needs you line is
 * there exactly when the task is Needs you.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { deriveUserStatus, type StatusReport, type UserStatus, type UserStatusInput } from '../../src/core/user-status.js'
import { aggregateLines, taskLines, type LineKind } from '../../src/core/task-lines.js'
import { applyActions } from '../../src/core/action-needed.js'
import { PHASE_ORDER, TERMINAL_PHASES } from '../../src/core/phase.js'

const ROOT = path.resolve(__dirname, '../..')
const NOW = Date.parse('2026-11-19T20:30:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const later = (ms: number) => new Date(NOW + ms).toISOString()
const rep = (r: Partial<StatusReport>): StatusReport => ({ state: 'working', at: ago(60_000), ...r } as StatusReport)
const statusOf = (input: UserStatusInput): UserStatus => applyActions(deriveUserStatus(input, NOW), [], [], { nowMs: NOW })

/** Every input field taskLines turns into a line of its own, with a value and the line it gives. */
const LINE_SOURCES: Record<string, { input: Partial<UserStatusInput>; kind: LineKind; state: string }> = {
  processStatus: { input: { processStatus: 'running' }, kind: 'turn', state: 'working' },
  ownWorkTriggers: { input: { ownWorkTriggers: ['Results of my test run'] }, kind: 'own', state: 'working' },
  outliving: { input: { outliving: ['background'] }, kind: 'own', state: 'working' },
  triggers: { input: { triggers: ['Rollout pipeline watch'] }, kind: 'watch', state: 'waiting' },
  schedules: { input: { schedules: [{ name: 'Nightly digest', nextAt: later(3_600_000) }] }, kind: 'schedule', state: 'waiting' },
  waitingOnTasks: { input: { waitingOnTasks: ['Review: the diff'] }, kind: 'reply', state: 'waiting' },
  workersAtWork: { input: { workersAtWork: ['Review: the diff'] }, kind: 'subtask', state: 'waiting' },
  report: { input: { report: rep({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'The vendor\'s reply' }) }, kind: 'wait', state: 'waiting' },
}
/** Fields it reads that make no line of their own, and why. */
const NOT_A_LINE: Record<string, string> = {
  pendingPermissionTool: 'a live prompt is an Action needed item, or the status\'s own ask',
  waitUntil: 'a clock is written on the waiting lines it checks again by',
  phaseChangedAt: 'with report: whether the report is current',
  hasLeader: 'with report: whether a wait on a lead is the user\'s',
  isMain: 'with report: whether a wait on a lead is the user\'s',
  isLead: 'with report: whether a wait on a lead is the user\'s',
}

describe('a task\'s lines', () => {
  it('a deploy task: its yes, two watches and the reply it waits on are four lines, and it is Needs you', () => {
    const input: UserStatusInput = {
      phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', hasLeader: true,
      triggers: ['Storage service rollout', 'Staging approval'], waitingOnTasks: ['the partner engineer'],
      report: rep({ state: 'needs', ask: 'May I ask a colleague in the team channel why the test keeps failing?' }),
    }
    // Its own ask is its Action needed item (applyActions makes it one): the line points at it.
    const status = statusOf(input)
    const lines = taskLines(input, status, NOW)
    expect(lines.map((l) => [l.kind, l.state, l.what])).toEqual([
      ['ask', 'needs', 'May I ask a colleague in the team channel why the test keeps failing?'],
      ['watch', 'waiting', 'Storage service rollout'],
      ['watch', 'waiting', 'Staging approval'],
      ['reply', 'waiting', 'A reply from the partner engineer'],
    ])
    expect(lines[0].item).toBe(status.actions?.[0]?.id)
    expect(aggregateLines(lines)).toBe('needs')
    expect(status.state).toBe('needs')
    // Answered: the same task is Waiting, and its lines name what on.
    const after = { ...input, report: rep({ state: 'waiting', waiting_kind: 'task', waiting_on: 'The partner engineer\'s reply' }) }
    const s2 = statusOf(after)
    const l2 = taskLines(after, s2, NOW)
    expect(s2.state).toBe('waiting')
    expect(aggregateLines(l2)).toBe('waiting')
    expect(l2.map((l) => l.what)).toEqual(expect.arrayContaining(['Storage service rollout', 'Staging approval', 'The partner engineer\'s reply']))
  })

  it('every input that makes a line makes its own kind of line', () => {
    for (const [field, c] of Object.entries(LINE_SOURCES)) {
      const input: UserStatusInput = { phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', ...c.input }
      const lines = taskLines(input, statusOf(input), NOW)
      expect(lines.some((l) => l.kind === c.kind && l.state === c.state), field).toBe(true)
    }
  })

  it('a clock is written on the waiting lines, and a scheduled run keeps its own time', () => {
    const input: UserStatusInput = { phase: 'WAITING', hasSession: true, processStatus: 'idle', triggers: ['CI on main'], waitUntil: later(1_800_000), schedules: [{ name: 'Nightly digest', nextAt: later(7_200_000) }] }
    const lines = taskLines(input, statusOf(input), NOW)
    expect(lines.find((l) => l.kind === 'watch')?.until).toBe(later(1_800_000))
    expect(lines.find((l) => l.kind === 'schedule')?.until).toBe(later(7_200_000))
  })

  it('never contradicts the status: its state has a line, and a Needs you line only when it is Needs you', () => {
    const open = PHASE_ORDER.filter((p) => !TERMINAL_PHASES.has(p))
    const extras: Partial<UserStatusInput>[] = [
      {}, ...Object.values(LINE_SOURCES).map((c) => c.input),
      { report: rep({ state: 'needs', ask: 'Pick A or B?' }) }, { report: rep({ state: 'needs' }) },
      { report: rep({ state: 'done' }) }, { openLetter: 'Approve the quota raise' }, { hasLeader: true },
      { processStatus: 'error', errorMessage: 'API Error: 401 invalid api key' }, { hostDown: 'clouddev' },
      { usageLimit: { state: 'waiting', engine: 'claude', window: 'five_hour', resetsAt: later(3_600_000), dueAt: later(3_660_000) } as UserStatusInput['usageLimit'] },
    ]
    const wrong: string[] = []
    for (const phase of open) {
      for (const a of extras) {
        for (const b of extras) {
          const input: UserStatusInput = { phase, hasSession: true, processStatus: 'idle', ...a, ...b }
          const status = statusOf(input)
          const lines = taskLines(input, status, NOW)
          if (status.state === 'done') { if (lines.length) wrong.push(`${phase}: done with lines`); continue }
          if (!lines.some((l) => l.state === status.state)) wrong.push(`${phase} ${JSON.stringify({ ...a, ...b })}: ${status.state} has no line`)
          if ((aggregateLines(lines) === 'needs') !== (status.state === 'needs')) wrong.push(`${phase} ${JSON.stringify({ ...a, ...b })}: needs ${status.state} vs lines ${aggregateLines(lines)}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('a snoozed item, or one that only rides along, is no line', () => {
    const input: UserStatusInput = { phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', triggers: ['CI on main'] }
    const status: UserStatus = { ...deriveUserStatus(input, NOW), actions: [{ kind: 'letter', id: 'lt-1', summary: 'Approve?', snoozedUntil: later(3_600_000) }] }
    expect(taskLines(input, status, NOW).some((l) => l.kind === 'ask')).toBe(false)
  })

  it('every input field the lines read is a line source or says why it is none', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/task-lines.ts'), 'utf8')
    const read = [...new Set([...src.matchAll(/\binput\.(\w+)/g)].map((m) => m[1]))]
    const unlisted = read.filter((f) => !(f in LINE_SOURCES) && !(f in NOT_A_LINE))
    expect(unlisted, 'A new input the lines read: list it in LINE_SOURCES with the line it gives, or NOT_A_LINE with why').toEqual([])
  })
})
