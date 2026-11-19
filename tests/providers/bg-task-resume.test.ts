/**
 * A background subagent the CLI parks while its own background command runs, then starts again
 * under the same call, is still running in EVERY tracker that counts backgrounded work
 * (src/providers/bg-task-resume.ts). The stream below is the 2026-11-19 shape (CLI 2.1.322),
 * neutralized: the subagent reads "completed" with a summary of what it waits for, its own
 * command runs, the command ends, the level list is empty for one line, then the subagent is
 * listed and started again with its original tool_use_id and goes on with its tools. Walnut read
 * the subagent as ended, handed the task back at the empty moment and told its lead "stopped"
 * three times while the subagent worked.
 *
 * The trackers: the daemon fold (snapshot), the server's reconcile fold, the live runner, and the
 * task count of both daemon twins (the standalone source transpiled, the template as emitted).
 * A new tracker must join this list.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { foldLines, assembleSnapshot } from '../../src/providers/daemon-fold.js'
import { foldSessionTail } from '../../src/core/session-reconcile.js'
import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { resumesEndedCall } from '../../src/providers/bg-task-resume.js'
import { PARKED, parkedSubagentStream as stream } from '../helpers/parked-subagent-stream.js'

const { SID, AGENT, CALL, sys } = PARKED

// ── the trackers, each answering "how many backgrounded tasks run after these lines" ──

const daemonFold = (lines: string[]) => {
  const snap = assembleSnapshot({ foldState: foldLines(lines.join('\n') + '\n'), pendingCtrl: null, dead: false, pid: 1, exitCode: null })
  return snap.detachedBgCount ?? 0
}

const reconcileFold = (lines: string[]) => foldSessionTail(lines.join('\n') + '\n').detachedBgCount

const runner = (lines: string[]) => {
  const session = new ClaudeCodeSession('bg-resume-task', 'test-project')
  ;(session as unknown as { _transport: unknown })._transport = {
    isRemote: true, hasPipe: true, processName: 'claude', pid: null, outputFile: null, host: null,
    fileSize: 0, imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
  }
  ;(session as unknown as { _active: boolean })._active = true
  ;(session as unknown as { _processStatus: string })._processStatus = 'running'
  const handle = session as unknown as { handleStreamLine(line: string): void }
  for (const line of lines) handle.handleStreamLine(line)
  return session.outlivingWork.includes('background') ? 1 : 0
}

function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`${name} not found`)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

type TwinState = { tasks: Record<string, { status: string; isBackgrounded?: boolean }> }
function twin(src: string): (lines: string[]) => number {
  const body = [
    "const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed']);",
    'const BG_TRANSITION_CAP = 50;',
    extractFn(src, 'emptyTaskState'), extractFn(src, 'runningTaskCount'), extractFn(src, 'applyTaskEvent'),
    'return { empty: emptyTaskState, apply: applyTaskEvent };',
  ].join('\n')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fns = new Function(body)() as { empty: () => TwinState; apply: (ts: TwinState, p: Record<string, unknown>, v: number, now: number) => boolean }
  return (lines) => {
    const ts = fns.empty()
    lines.forEach((l, i) => fns.apply(ts, JSON.parse(l), i + 1, i))
    return Object.values(ts.tasks).filter((t) => t.isBackgrounded && !['completed', 'failed', 'stopped', 'cancelled', 'killed'].includes(t.status)).length
  }
}
function standaloneSource(): string {
  const text = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
  const fns = ['emptyTaskState', 'runningTaskCount', 'applyTaskEvent'].map((n) => extractFn(text, n)).join('\n')
  return esbuild.transformSync('type TaskState = any\n' + fns, { loader: 'ts' }).code
}

const TRACKERS: Array<[string, (lines: string[]) => number]> = [
  ['daemon fold', daemonFold],
  ['reconcile fold', reconcileFold],
  ['live runner', runner],
  ['daemon template twin', twin(getDaemonSource())],
  ['daemon standalone twin', twin(standaloneSource())],
]

describe.each(TRACKERS)('a parked background subagent started again: %s', (_name, running) => {
  const { lines, working, done } = stream()

  it('counts it running at every point it is at work, the moment its own command ends included', () => {
    for (const at of working) expect(running(lines.slice(0, at)), `after line ${at}`).toBeGreaterThan(0)
  })

  it('counts nothing once it really reports done', () => {
    expect(running(lines.slice(0, done))).toBe(0)
  })

  it('a stray start of the ended call (no backgrounded flag, or another call\'s id) does not revive it', () => {
    const ended = lines.slice(0, done)
    const plain = sys('task_started', { task_id: AGENT, task_type: 'local_agent', tool_use_id: CALL })
    const progress = sys('task_progress', { task_id: AGENT })
    expect(running([...ended, plain, progress])).toBe(0)
    const noId = sys('task_started', { task_id: AGENT, task_type: 'local_agent', is_backgrounded: true })
    expect(running([...ended, noId, progress])).toBe(0)
  })
})

describe('the live runner\'s speed lane for the subagent', () => {
  it('runs again when the CLI starts the call again', () => {
    const { lines, working } = stream()
    const session = new ClaudeCodeSession('bg-resume-task', 'test-project')
    ;(session as unknown as { _transport: unknown })._transport = {
      isRemote: true, hasPipe: true, processName: 'claude', pid: null, outputFile: null, host: null,
      fileSize: 0, imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    }
    ;(session as unknown as { _active: boolean })._active = true
    const handle = session as unknown as { handleStreamLine(line: string): void; _speed: { lanes: Map<string, { status: string }> } }
    for (const line of lines.slice(0, working[working.length - 1])) handle.handleStreamLine(line)
    expect(handle._speed.lanes.get(CALL)?.status).toBe('running')
  })
})

describe('the live runner against the daemon\'s own answer (reconcileFromDaemon)', () => {
  type Remote = { status: string; v: number; t: number; isBackgrounded: boolean; toolUseId: string }
  function runnerWithDaemon(answer: () => Record<string, Remote>) {
    const session = new ClaudeCodeSession('bg-resume-task', 'test-project')
    ;(session as unknown as { _transport: unknown })._transport = {
      isRemote: true, hasPipe: true, processName: 'claude', pid: null, outputFile: null, host: null,
      fileSize: 0, imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
      getState: async () => ({ tasks: answer(), resourceVersion: 1, updatedAt: 0, derivedRunning: 0, recentTransitions: [] }),
    }
    ;(session as unknown as { _active: boolean })._active = true
    ;(session as unknown as { _processStatus: string })._processStatus = 'running'
    return session
  }
  const feed = (session: ClaudeCodeSession, lines: string[]) => {
    const handle = session as unknown as { handleStreamLine(line: string): void }
    for (const line of lines) handle.handleStreamLine(line)
  }
  const agent = (status: string, v: number): Remote => ({ status, v, t: v, isBackgrounded: true, toolUseId: CALL })

  it('an older daemon still holding the park\'s end does not end the started-again subagent; its later real end does', async () => {
    const { lines, working, done } = stream()
    let remote: Record<string, Remote> = { [AGENT]: agent('completed', 40) }
    const session = runnerWithDaemon(() => remote)
    feed(session, lines.slice(0, working[working.length - 1]))
    expect(session.outlivingWork).toContain('background')
    await session.reconcileFromDaemon()
    await session.reconcileFromDaemon()
    expect(session.outlivingWork).toContain('background')
    // The subagent's real end lands in the daemon, the live line for it lost.
    remote = { [AGENT]: agent('completed', 90) }
    await session.reconcileFromDaemon()
    expect(session.outlivingWork).not.toContain('background')
    expect(done).toBeGreaterThan(0)
  })

  it('a daemon that read the start first answers running: its later end is adopted', async () => {
    const { lines, working } = stream()
    let remote: Record<string, Remote> = { [AGENT]: agent('running', 60) }
    const session = runnerWithDaemon(() => remote)
    feed(session, lines.slice(0, working[working.length - 1]))
    await session.reconcileFromDaemon()
    expect(session.outlivingWork).toContain('background')
    remote = { [AGENT]: agent('completed', 61) }
    await session.reconcileFromDaemon()
    expect(session.outlivingWork).not.toContain('background')
  })
})

describe('resumesEndedCall', () => {
  it('needs a start, the same call id and the backgrounded flag', () => {
    const line = { subtype: 'task_started', tool_use_id: CALL, is_backgrounded: true }
    expect(resumesEndedCall(line, CALL)).toBe(true)
    expect(resumesEndedCall({ ...line, is_backgrounded: undefined }, CALL)).toBe(false)
    expect(resumesEndedCall({ ...line, tool_use_id: 'other' }, CALL)).toBe(false)
    expect(resumesEndedCall({ ...line, tool_use_id: '' }, '')).toBe(false)
    expect(resumesEndedCall({ ...line, subtype: 'task_progress' }, CALL)).toBe(false)
    expect(resumesEndedCall(line, undefined)).toBe(false)
  })
})
