/**
 * Restart loss (src/core/sessions/restart-loss.ts + restart-notice.ts): what a
 * restart cost a session, decided from recorded facts, and the note the session
 * reads on the first message after it.
 *
 * The fixture is the real 2026-10-26 reboot (ids dropped): 36 of the 42
 * sessions the reconciler found dead (the other six were resumed by hand before
 * their pre-reboot fold could be read back), each with the fold of its stream
 * file at death and its task's phase then. Before the fix none was resumed and twelve
 * IN_PROGRESS tasks with work in flight were handed back as NEED_ACTION.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-restart-loss'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  buildRestartNotice, classifyRestartLoss, factsFromRecord, factsFromSnapshot, holdsPhase, lostWork, type LossFacts,
} from '../../../src/core/sessions/restart-loss.js'
import type { SessionRestartLoss, TaskPhase } from '../../../src/core/types.js'
import type { SessionSnapshot } from '../../../src/providers/daemon-fold.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { sendMessageToSession, getQueue, resetCache } from '../../../src/core/session-message-queue.js'

const LAST_ACTIVE = Date.parse('2026-10-26T01:00:00.000Z')

function facts(over: Partial<LossFacts> = {}): LossFacts {
  return { source: 'fold', turnActive: false, pendingPermission: false, backgroundCount: 0, wakeupArmed: false, cronActive: false, teamActive: false, ...over }
}

describe('the 2026-10-26 reboot, session by session', () => {
  // [phase at loss, fold at death, expected verdict]
  type Row = [TaskPhase, Partial<LossFacts>, string]
  const rows: Row[] = [
    // Handed back before the reboot: the user already had them.
    ...Array.from({ length: 13 }, (): Row => ['NEED_ACTION', {}, 'handed_back']),
    // Parked on a clock or a trigger, nothing of theirs in the process.
    ...Array.from({ length: 11 }, (): Row => ['WAITING', {}, 'wait_held']),
    // Parked, but mid-turn with its own background command: that wait died.
    ['WAITING', { turnActive: true, backgroundCount: 1 }, 'resume'],
    // In progress, ended the turn waiting on background commands.
    ['IN_PROGRESS', { backgroundCount: 1 }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 1 }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 1 }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 2 }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 1, cronActive: true }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 1, wakeupArmed: true }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 1 }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 1 }, 'resume'],
    ['IN_PROGRESS', { backgroundCount: 1 }, 'resume'],
    // In progress, mid-turn.
    ['IN_PROGRESS', { turnActive: true, backgroundCount: 4, cronActive: true }, 'resume'],
    ['IN_PROGRESS', { turnActive: true, backgroundCount: 5 }, 'resume'],
  ]

  it('resumes exactly the work that was in flight', () => {
    const verdicts = rows.map(([phase, f]) => classifyRestartLoss({ facts: facts(f), phase, cwdMissing: false }).verdict)
    expect(verdicts).toEqual(rows.map((r) => r[2]))
    const tally = verdicts.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})
    expect(tally).toEqual({ handed_back: 13, wait_held: 11, resume: 12 })
  })
})

describe('classifyRestartLoss', () => {
  it('a permission prompt waits on the user even mid-turn', () => {
    expect(classifyRestartLoss({ facts: facts({ turnActive: true, pendingPermission: true }), phase: 'IN_PROGRESS', cwdMissing: false }).verdict).toBe('waiting_user')
  })
  it('no task, a done task, a TODO: nothing to resume', () => {
    for (const phase of [null, 'COMPLETE', 'TODO'] as const) {
      expect(classifyRestartLoss({ facts: facts({ turnActive: true }), phase, cwdMissing: false }).verdict).toBe('handed_back')
    }
  })
  it('in-flight work in a directory the reboot removed is not resumed into', () => {
    expect(classifyRestartLoss({ facts: facts({ turnActive: true }), phase: 'IN_PROGRESS', cwdMissing: true }).verdict).toBe('cwd_missing')
    // Nothing in flight: it is just settled; the directory is the next turn's problem.
    expect(classifyRestartLoss({ facts: facts(), phase: 'IN_PROGRESS', cwdMissing: true }).verdict).toBe('settled')
  })
})

describe('facts', () => {
  const snap = (over: Partial<SessionSnapshot>): SessionSnapshot => ({
    v: 1, cliState: 'dead', turnActive: false, pendingPermission: null, gatingBgCount: 0, detachedBgCount: 0,
    teamActive: false, cronActive: false, wakeupAt: null, lastResult: null, pid: null, exitCode: null, ...over,
  })
  it('a wakeup set after the last activity never fired: lost, whether due during the downtime or later', () => {
    expect(factsFromSnapshot(snap({ wakeupAt: LAST_ACTIVE + 60_000 }), LAST_ACTIVE).wakeupArmed).toBe(true)
    expect(factsFromSnapshot(snap({ wakeupAt: LAST_ACTIVE - 60_000 }), LAST_ACTIVE).wakeupArmed).toBe(false)
  })
  it('both background kinds count; an older daemon without the detached field still reads', () => {
    expect(factsFromSnapshot(snap({ gatingBgCount: 1, detachedBgCount: 2 }), LAST_ACTIVE).backgroundCount).toBe(3)
    expect(factsFromSnapshot(snap({ gatingBgCount: 1, detachedBgCount: undefined }), LAST_ACTIVE).backgroundCount).toBe(1)
  })
  it('the record fallback: running (or an infra error) is work in flight, idle is not', () => {
    expect(lostWork(factsFromRecord({ process_status: 'running' }))).toEqual(['turn'])
    expect(lostWork(factsFromRecord({ process_status: 'error' }))).toEqual(['turn'])
    expect(lostWork(factsFromRecord({ process_status: 'idle' }))).toEqual([])
    expect(factsFromRecord({ process_status: 'idle', pendingPermission: { requestId: 'r', receivedAt: 'x' } }).pendingPermission).toBe(true)
  })
})

describe('holdsPhase', () => {
  const loss = (over: Partial<SessionRestartLoss>): SessionRestartLoss => ({ at: 'x', cause: 'machine_reboot', lost: ['turn'], state: 'queued', verdict: 'resume', ...over })
  it('holds while undecided or on its way back, not once resolved', () => {
    expect(holdsPhase(loss({ state: 'pending', verdict: undefined }))).toBe(true)
    expect(holdsPhase(loss({ state: 'queued' }))).toBe(true)
    expect(holdsPhase(loss({ state: 'sent' }))).toBe(true)
    for (const state of ['resumed', 'skipped', 'gave_up'] as const) expect(holdsPhase(loss({ state }))).toBe(false)
    expect(holdsPhase(loss({ state: 'skipped', verdict: 'settled' }))).toBe(false)
    expect(holdsPhase(undefined)).toBe(false)
  })
})

describe('buildRestartNotice', () => {
  const base: SessionRestartLoss = {
    at: '2026-10-26T02:03:54.000Z', bootAt: '2026-10-26T01:57:10.000Z', cause: 'machine_reboot',
    lost: ['turn', 'background'], backgroundCount: 2, state: 'queued', verdict: 'resume', cwd: '/repo/marina',
  }
  it('a reboot mid-work: cause, what was lost, /tmp cleared, the directory, check state first', () => {
    const text = buildRestartNotice(base)
    expect(text).toContain('This computer rebooted (2026-10-26 01:57 UTC)')
    expect(text).toContain('in the middle of a turn, while 2 background commands you started were still running')
    expect(text).toContain('Nothing you did caused it.')
    expect(text).toContain('will not report back')
    expect(text).toContain('The reboot cleared /tmp')
    expect(text).toContain('Your working directory is /repo/marina.')
    expect(text).toContain('check the real state')
  })
  it('names the task directory, where work that must outlive a reboot belongs', () => {
    expect(buildRestartNotice({ ...base, taskDir: '/state/open-walnut/tasks/t-1' }))
      .toContain('Your task directory on this host is /state/open-walnut/tasks/t-1 (also `$WALNUT_TASK_DIR`).')
    expect(buildRestartNotice(base)).toContain('Your task directory is `$WALNUT_TASK_DIR` on the host your session runs on.')
  })
  it('a missing directory is named as missing', () => {
    expect(buildRestartNotice({ ...base, cwdMissing: true, cwd: '/tmp/clone-1' })).toContain('Your working directory /tmp/clone-1 no longer exists.')
  })
  it('an idle session after a reboot gets the short form', () => {
    const text = buildRestartNotice({ ...base, lost: [], verdict: 'settled', state: 'skipped' })
    expect(text).toContain('[Walnut restart notice] This computer rebooted (2026-10-26 01:57 UTC) while this session was idle')
    expect(text).toContain('The reboot cleared /tmp')
    expect(text).not.toContain('check the real state')
  })
  it('a server restart says so and does not claim /tmp was cleared; a remote host may have', () => {
    const server = buildRestartNotice({ ...base, cause: 'server_restart', bootAt: undefined })
    expect(server).toContain('The Walnut server or its session daemon restarted (2026-10-26 02:03 UTC)')
    expect(server).not.toContain('/tmp')
    expect(buildRestartNotice({ ...base, cause: 'host_restart', bootAt: undefined }, { host: 'devbox' }))
      .toContain('If that host rebooted, its /tmp was cleared')
  })
  it('names a wakeup and a cron job', () => {
    const text = buildRestartNotice({ ...base, lost: ['wakeup', 'cron'] })
    expect(text).toContain('while your ScheduleWakeup timer was armed, while your /loop cron job was armed')
  })
})

describe('the notice rides on the first message into the session (real store and queue)', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    resetCache()
  })

  async function lostSession(loss: Partial<SessionRestartLoss>) {
    const { task } = await addTask({ title: 'Rail sync', project: 'acme' } as Parameters<typeof addTask>[0])
    const sid = `sid-${task.id}`
    await createSessionRecord(sid, task.id, 'acme', '/repo/marina', { title: task.title })
    await updateSessionRecord(sid, {
      output_mode: 'markdown',
      restartLoss: { at: '2026-10-26T02:03:54.000Z', bootAt: '2026-10-26T01:57:10.000Z', cause: 'machine_reboot', lost: ['turn'], state: 'queued', verdict: 'resume', cwd: '/repo/marina', ...loss },
    } as Parameters<typeof updateSessionRecord>[1])
    return sid
  }
  const rows = async (sid: string) => (await getQueue(sid)).map((m) => m.message)

  it('a human who gets there first still hands the agent the facts, once', async () => {
    const sid = await lostSession({})
    await sendMessageToSession(sid, 'are you there?', { source: 'ui' })
    const [first] = await rows(sid)
    expect(first).toMatch(/^<walnut-message kind="notification"/)
    expect(first).toContain('outcome="restarted"')
    expect(first).toContain('This computer rebooted')
    expect(first.endsWith('\n\nare you there?')).toBe(true)
    expect((await getSessionByClaudeId(sid))?.restartLoss).toMatchObject({ told: true, state: 'queued' })
    await sendMessageToSession(sid, 'second', { source: 'peer' })
    expect((await rows(sid))[1]).toBe('second')
  })

  it('a loss still being classified says nothing yet; a told one says nothing again', async () => {
    const pending = await lostSession({ state: 'pending', verdict: undefined, lost: [] })
    await sendMessageToSession(pending, 'hi', { source: 'ui' })
    expect(await rows(pending)).toEqual(['hi'])
    const told = await lostSession({ told: true })
    await sendMessageToSession(told, 'hi', { source: 'ui' })
    expect(await rows(told)).toEqual(['hi'])
  })
})
