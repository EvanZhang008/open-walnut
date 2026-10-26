/**
 * Restart loss: pure rules for a session whose process a restart killed.
 *
 * "Was this session interrupted?" is answered from what was RECORDED at its
 * death, never from a time threshold:
 *   - the daemon's fold over the session's stream file (Walnut's own format,
 *     kept on disk across a reboot): a turn still open, background commands
 *     still running, an armed ScheduleWakeup, an armed /loop cron, an open
 *     permission prompt;
 *   - when the daemon cannot fold it (host offline, file gone, old daemon), the
 *     record's last projected status, which the same fold wrote while it lived;
 *   - the task's phase: NEED_ACTION / TODO / COMPLETE means the work was already
 *     handed back, WAITING means the task parked itself on something.
 *
 * Every piece of in-flight work above dies with the process: a background
 * command is in its process group, a wakeup or cron timer is in its memory. So
 * a WAITING task whose wait rode on one of them is waiting for something that
 * will never come, while a WAITING task with none of them waits on a clock, a
 * trigger or a peer, all of which outlive the process.
 */

import type { SessionSnapshot } from '../../providers/daemon-fold.js'
import { taskDirLine } from '../work-place.js'
import type {
  RestartLossVerdict,
  RestartLostWork,
  SessionRecord,
  SessionRestartLoss,
  TaskPhase,
} from '../types.js'

export interface LossFacts {
  /** Where the facts came from: the stream fold, or the record's last status. */
  source: 'fold' | 'record'
  turnActive: boolean
  pendingPermission: boolean
  backgroundCount: number
  wakeupArmed: boolean
  cronActive: boolean
  teamActive: boolean
}

/**
 * Facts from a dead session's snapshot. A wakeup counts as lost when it was set
 * to fire after the session's last activity: it never fired, whether its time
 * came during the downtime or is still ahead.
 */
export function factsFromSnapshot(snap: SessionSnapshot, lastActiveMs: number): LossFacts {
  const wakeupAt = typeof snap.wakeupAt === 'number' ? snap.wakeupAt : 0
  return {
    source: 'fold',
    turnActive: !!snap.turnActive,
    pendingPermission: !!snap.pendingPermission,
    backgroundCount: (snap.gatingBgCount ?? 0) + (snap.detachedBgCount ?? 0),
    wakeupArmed: wakeupAt > 0 && Number.isFinite(lastActiveMs) && wakeupAt > lastActiveMs,
    cronActive: !!snap.cronActive,
    teamActive: !!snap.teamActive,
  }
}

/**
 * Facts from the record as it stood before the loss. The projection maps a
 * running turn, a live background command and an armed wakeup all to
 * 'running', so 'running' is "work in flight" without saying which. An 'error'
 * here comes from a runtime discovery site that already proved the cause is
 * infrastructure (a lost connection), which cut the work short the same way.
 */
export function factsFromRecord(before: Pick<SessionRecord, 'process_status' | 'pendingPermission'>): LossFacts {
  return {
    source: 'record',
    turnActive: before.process_status === 'running' || before.process_status === 'error',
    pendingPermission: !!before.pendingPermission,
    backgroundCount: 0,
    wakeupArmed: false,
    cronActive: false,
    teamActive: false,
  }
}

export function lostWork(f: LossFacts): RestartLostWork[] {
  const out: RestartLostWork[] = []
  if (f.turnActive) out.push('turn')
  if (f.backgroundCount > 0) out.push('background')
  if (f.wakeupArmed) out.push('wakeup')
  if (f.cronActive) out.push('cron')
  if (f.teamActive) out.push('team')
  return out
}

export function classifyRestartLoss(input: {
  facts: LossFacts
  /** null = no task, or the task is gone. */
  phase: TaskPhase | null
  cwdMissing: boolean
}): { verdict: RestartLossVerdict; reason: string } {
  const { facts, phase } = input
  if (!phase) return { verdict: 'handed_back', reason: 'no task' }
  if (phase !== 'IN_PROGRESS' && phase !== 'WAITING') {
    return { verdict: 'handed_back', reason: `task was ${phase}` }
  }
  if (facts.pendingPermission) return { verdict: 'waiting_user', reason: 'a permission prompt was open' }
  const lost = lostWork(facts)
  if (lost.length === 0) {
    return phase === 'WAITING'
      ? { verdict: 'wait_held', reason: 'waiting on something that outlives the process' }
      : { verdict: 'settled', reason: 'the last turn had finished' }
  }
  if (input.cwdMissing) return { verdict: 'cwd_missing', reason: 'the working directory no longer exists' }
  return { verdict: 'resume', reason: `lost: ${lost.join(', ')}` }
}

/** Verdicts that keep the task's phase where it was until the resume resolves. */
export function holdsPhase(loss: SessionRestartLoss | undefined): boolean {
  if (!loss) return false
  if (loss.state === 'pending') return true
  return loss.verdict === 'resume' && (loss.state === 'queued' || loss.state === 'sent')
}

/** Order of the resume queue: open turns first, then the most recent work. */
export function resumePriority(loss: SessionRestartLoss, lastActiveMs: number): number {
  const turn = loss.lost.includes('turn') ? 0 : 1
  return turn * 1e15 - (Number.isFinite(lastActiveMs) ? lastActiveMs : 0)
}

function describeCause(loss: SessionRestartLoss, host: string | undefined): string {
  const at = (loss.bootAt ?? loss.at).replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC')
  if (loss.cause === 'machine_reboot') return `This computer rebooted (${at})`
  if (loss.cause === 'host_restart') return `The host ${host ?? ''} or its session daemon restarted (seen ${at})`.replace('  ', ' ')
  return `The Walnut server or its session daemon restarted (${at})`
}

function describeLost(loss: SessionRestartLoss): string {
  const parts: string[] = []
  if (loss.lost.includes('turn')) parts.push('in the middle of a turn')
  if (loss.lost.includes('background')) {
    const n = loss.backgroundCount ?? 0
    parts.push(n > 0 ? `while ${n} background command${n === 1 ? '' : 's'} you started ${n === 1 ? 'was' : 'were'} still running` : 'while background commands you started were still running')
  }
  if (loss.lost.includes('wakeup')) parts.push('while your ScheduleWakeup timer was armed')
  if (loss.lost.includes('cron')) parts.push('while your /loop cron job was armed')
  if (loss.lost.includes('team')) parts.push('while your agent team was working')
  return parts.join(', ')
}

/**
 * The note a session reads on the first message after the loss (whoever sends
 * it). Honest about the cause so the agent does not spend a turn diagnosing its
 * own "failure", and explicit that it must check real state first.
 */
export function buildRestartNotice(loss: SessionRestartLoss, opts: { host?: string } = {}): string {
  const lostText = describeLost(loss)
  const lines: string[] = []
  lines.push(lostText
    ? `[Walnut restart recovery] ${describeCause(loss, opts.host)} and killed your session process ${lostText}. Nothing you did caused it.`
    : `[Walnut restart notice] ${describeCause(loss, opts.host)} while this session was idle, so its process was restarted for this message.`)
  if (lostText) {
    lines.push('Output after the last saved line was lost. Background commands, timers and cron jobs from before the restart are gone and will not report back.')
  }
  if (loss.cause === 'machine_reboot') {
    lines.push('The reboot cleared /tmp: anything kept there (clones, worktrees, builds, logs, evidence) is gone.')
  } else if (loss.cause === 'host_restart') {
    lines.push('If that host rebooted, its /tmp was cleared: anything kept there (clones, worktrees, builds, logs, evidence) may be gone.')
  }
  if (loss.cwd) {
    lines.push(loss.cwdMissing
      ? `Your working directory ${loss.cwd} no longer exists.`
      : `Your working directory is ${loss.cwd}.`)
  }
  // Where work that must outlive a reboot belongs (src/core/work-place.ts).
  lines.push(taskDirLine(loss.taskDir ?? null).trim())
  if (lostText) {
    lines.push('Before continuing, check the real state (files you were editing, whether builds or commands actually finished, git status) instead of assuming your last action completed. Start again or re-arm anything you were waiting on, then carry on with the task.')
  }
  return lines.join('\n')
}

/** The body of the resume message itself; the notice above rides in front of it. */
export const RESUME_MESSAGE = 'Continue the task from where the restart stopped you.'

