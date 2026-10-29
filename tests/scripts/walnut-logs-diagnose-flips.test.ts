/**
 * `scripts/walnut-logs.sh diagnose` row fates and `flips`.
 *
 * diagnose used to call every enqueue without a `message delivered` line STUCK.
 * A log study found every such row had a later fate: the CLI settled the line
 * itself (that IS its delivery), the row was parked on purpose, or it waited
 * behind a permission prompt. Only a row with no fate at all is STUCK.
 *
 * flips counts moves into NEED_ACTION that a new turn undid within 30 s: the
 * monitor for the 20 s hand-back hold of the user status.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SCRIPT = path.resolve(process.cwd(), 'scripts/walnut-logs.sh')
const SID = '11111111-2222-3333-4444-555555555555'

/** Today's LOCAL date, which is how the log FILENAME is dated (timestamps are UTC). */
function localDateStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** ISO-8601 UTC, `secs` seconds after a base 10 minutes ago (inside a 30-min window). */
const BASE = Date.now() - 10 * 60_000
function at(secs: number): string {
  return new Date(BASE + secs * 1000).toISOString()
}

let logDir: string

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-logs-diag-'))
})
afterEach(async () => {
  await fs.rm(logDir, { recursive: true, force: true })
})

async function writeLog(lines: unknown[]): Promise<void> {
  await fs.writeFile(
    path.join(logDir, `open-walnut-${localDateStamp()}.log`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  )
}

async function run(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('bash', [SCRIPT, ...args], {
    env: { ...process.env, WALNUT_LOG_DIR: logDir },
    encoding: 'utf-8',
  })
  return stdout
}

const enq = (secs: number, id: string) => ({ time: at(secs), level: 'info', subsystem: 'session', message: 'message enqueued', sessionId: SID, messageId: id, queueDepth: 1 })

describe('walnut-logs.sh diagnose: a row is read by its fate', () => {
  it('counts a CLI-settled line as delivered at that time, and labels parked, held and stuck rows', async () => {
    await writeLog([
      enq(0, 'qm-delivered'),
      { time: at(0.05), level: 'info', subsystem: 'session', message: 'message delivered', sessionId: SID, path: 'stdin', count: 1, deliveryMs: 50, messageId: 'qm-delivered' },
      enq(1, 'qm-settled'),
      // Settled 14 s later: the latency must be ~14000ms, not "?".
      { time: at(15), level: 'info', subsystem: 'session', message: 'queued line settled by the CLI, rows leave the queue', sessionId: SID, why: 'started', messageIds: ['qm-settled'] },
      enq(2, 'qm-parked'),
      { time: at(3), level: 'warn', subsystem: 'session', message: 'message parked: permanent delivery failure', sessionId: SID, messageId: 'qm-parked', reason: 'Not delivered yet: the user (or someone) has this session open in a terminal right now (Claude Code pid 4087 on host "devbox"). The task is fine, not broken.' },
      enq(4, 'qm-held'),
      { time: at(5), level: 'info', subsystem: 'session', message: 'messages wait behind a pending permission prompt', sessionId: SID, messageIds: ['qm-held'], permissions: ['AskUserQuestion'] },
      enq(6, 'qm-stuck'),
    ])
    const out = await run('diagnose', '', '30')
    expect(out).toMatch(/1[34]\d{3}ms .*SLOW DELIVER \(enqueue→delivered, path=cli-settled\)/)
    expect(out).toContain('PARKED (session_live, held elsewhere: pid 4087 on host "devbox")')
    expect(out).toContain('HELD (prompt: AskUserQuestion)')
    expect(out.match(/STUCK/g)).toHaveLength(2) // the row line + the summary line
    expect(out).toContain('n=5 messages')
  })

  it('a row routed mid-turn on hasPipe=False but settled by the CLI is labelled by its fate, not Bug D', async () => {
    await writeLog([
      enq(0, 'qm-routed'),
      { time: at(0.01), level: 'info', subsystem: 'session', message: 'handleSend: routing send', sessionId: SID, path: 'injectMidTurn', hasPipe: false },
      { time: at(20), level: 'info', subsystem: 'session', message: 'queued line settled by the CLI, rows leave the queue', sessionId: SID, why: 'started', messageIds: ['qm-routed'] },
    ])
    const out = await run('diagnose', '', '30')
    expect(out).toContain('SLOW DELIVER (enqueue→delivered, path=cli-settled; routed injectMidTurn, hasPipe=False)')
    expect(out).not.toContain('BUG D')
  })

  it('a mid-turn send on hasPipe=False while the process starts is a send during a start, not Bug D', async () => {
    const routed = (secs: number, processStatus?: string) => ({
      time: at(secs), level: 'info', subsystem: 'session', message: 'handleSend: routing send', sessionId: SID,
      path: 'injectMidTurn', hasPipe: false, ...(processStatus ? { processStatus } : {}),
    })
    const delivered = (secs: number, id: string) => ({ time: at(secs), level: 'info', subsystem: 'session', message: 'message delivered', sessionId: SID, messageId: id, path: 'mid-turn', deliveryMs: 20_000 })
    await writeLog([
      enq(0, 'qm-starting'), routed(0.01, 'starting'), delivered(20, 'qm-starting'),
      enq(30, 'qm-running'), routed(30.01, 'running'), delivered(55, 'qm-running'),
      enq(60, 'qm-old-log'), routed(60.01), delivered(85, 'qm-old-log'),
    ])
    const out = await run('diagnose', '', '30')
    expect(out).toContain('SEND DURING START (process starting; the wait is the start, not Bug D)')
    // A running process on a stale pipe, and a routing line from before the field, stay Bug D.
    expect(out).toMatch(/2×\s+BUG D: mid-turn stall \(injectMidTurn, stale hasPipe=False\)/)
    expect(out).toMatch(/1×\s+SEND DURING START/)
  })

  it('a fate whose enqueue is before the window is not a message of its own', async () => {
    await writeLog([
      { time: at(0), level: 'info', subsystem: 'session', message: 'queued line settled by the CLI, rows leave the queue', sessionId: SID, why: 'started', messageIds: ['qm-old'] },
    ])
    const out = await run('diagnose', '', '30')
    expect(out).toContain('n=0 messages')
  })
})

describe('walnut-logs.sh flips', () => {
  const phase = (secs: number, taskId: string, oldPhase: string, newPhase: string, trigger: string, source: string) =>
    ({ time: at(secs), level: 'info', subsystem: 'session', message: 'phase transition', taskId, oldPhase, newPhase, trigger, source })

  it('counts moves into NEED_ACTION undone within 30 s, by bucket and by who moved in and back', async () => {
    await writeLog([
      phase(0, 'task-a', 'IN_PROGRESS', 'NEED_ACTION', 'reconciler', 'snapshot-apply:daemon-push'),
      phase(3, 'task-a', 'NEED_ACTION', 'IN_PROGRESS', 'session:turn-start', 'session-runner:state-running'),
      phase(10, 'task-b', 'IN_PROGRESS', 'NEED_ACTION', 'session:result', 'server.ts:session-result'),
      phase(35, 'task-b', 'NEED_ACTION', 'IN_PROGRESS', 'session:input', 'session.ts:handleSend'),
      // Undone after 40 s: not a flip.
      phase(50, 'task-c', 'IN_PROGRESS', 'NEED_ACTION', 'session:result', 'server.ts:session-result'),
      phase(90, 'task-c', 'NEED_ACTION', 'IN_PROGRESS', 'session:input', 'session.ts:handleSend'),
      // Left NEED_ACTION for COMPLETE: not undone by a turn.
      phase(100, 'task-d', 'IN_PROGRESS', 'NEED_ACTION', 'session:result', 'server.ts:session-result'),
      phase(101, 'task-d', 'NEED_ACTION', 'COMPLETE', 'api', 'api'),
    ])
    const out = await run('flips', '30')
    expect(out).toContain('NEED_ACTION entries=4  undone within 30s=2  (<=5s 1, <=20s 1, 20-30s 1)')
    expect(out).toContain('undone AFTER the hold (could reach the user status): 1')
    // A log from a build without the user-status lines: the column is skipped, not zero.
    expect(out).toContain('reached Needs you: column skipped')
    expect(out).toMatch(/1 {2}reconciler\/snapshot-apply:daemon-push {2}-> {2}session:turn-start\/session-runner:state-running/)
    expect(out).toMatch(/task-b {2}25\.0s/)
    expect(out).not.toContain('task-c')
  })

  it('fills "reached Needs you" from the user-status lines between the move in and the move back', async () => {
    const us = (secs: number, message: string, taskId: string) =>
      ({ time: at(secs), level: 'info', subsystem: 'task', message, taskId, untilMs: 0, source: 'session' })
    await writeLog([
      // Undone in 3 s, inside the hold: held, never reached.
      phase(0, 'task-a', 'IN_PROGRESS', 'NEED_ACTION', 'reconciler', 'snapshot-apply:daemon-push'),
      us(0.1, 'user-status: hand-back held', 'task-a'),
      phase(3, 'task-a', 'NEED_ACTION', 'IN_PROGRESS', 'session:turn-start', 'session-runner:state-running'),
      // Undone in 25 s, after the hold settled into needs at +20 s: reached.
      phase(10, 'task-b', 'IN_PROGRESS', 'NEED_ACTION', 'session:result', 'server.ts:session-result'),
      us(10.1, 'user-status: hand-back held', 'task-b'),
      us(30, 'user-status: now needs you', 'task-b'),
      phase(35, 'task-b', 'NEED_ACTION', 'IN_PROGRESS', 'session:input', 'session.ts:handleSend'),
      // A needs line of another task, or one before the move in, does not count.
      us(40, 'user-status: now needs you', 'task-c'),
      phase(50, 'task-c', 'IN_PROGRESS', 'NEED_ACTION', 'session:result', 'server.ts:session-result'),
      phase(52, 'task-c', 'NEED_ACTION', 'IN_PROGRESS', 'session:input', 'session.ts:handleSend'),
    ])
    const out = await run('flips', '30')
    expect(out).toContain('user-status lines in the window: hand-back held=2 (tasks 2)  now needs you=2')
    expect(out).toContain('flips that REACHED Needs you: 1 of 3  (undone within the hold: 0, after it: 1)')
    expect(out).not.toContain('the hold is not holding')
    expect(out).toMatch(/task-b {2}25\.0s .*REACHED Needs you/)
    expect(out).not.toMatch(/task-c .*REACHED/)
    expect(out).not.toContain('column skipped')
  })

  it('says so when there are no flips', async () => {
    await writeLog([phase(0, 'task-a', 'TODO', 'IN_PROGRESS', 'api', 'api')])
    const out = await run('flips')
    expect(out).toContain('(no flips in the window)')
  })
})
