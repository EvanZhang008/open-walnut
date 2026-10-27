/**
 * Auto-recover: bring back sessions whose EXECUTION SUBSTRATE died under them.
 *
 * Distinct from its two siblings, and the difference is the whole point:
 *   - daemon turn-retry (providers/daemon-core) retries a turn that died to a
 *     transient upstream error. It runs INSIDE the daemon, so it cannot help
 *     when the daemon is the thing that died.
 *   - session-auto-continue nudges a turn that ended with a retry-exhaustion
 *     result. It needs a `session:result` event; a process killed by a reboot
 *     never emits one.
 *   - this module handles "the process is simply GONE": the computer rebooted,
 *     the Walnut server or a daemon restarted, a remote host rebooted. The
 *     decision needs the task's phase and the user's pending prompts, which
 *     only the leader holds, so the leader owns it; the facts it decides on
 *     (the fold of the session's stream file) come from the host's daemon.
 *
 * 2026-08-22 (inc-1787439819342): a remote host's patch reboot left a session in
 * 'error' for 3.5 hours on fully resumable work. 2026-10-26: the Mac rebooted
 * with 42 sessions on it and not one came back. Twelve tasks had work in flight
 * (an open turn, background commands, an armed wakeup) and all twelve were
 * handed back as NEED_ACTION, as if they waited on the user: the per-host
 * budget of 10 was spent in reconciler order on tasks already handed back, and
 * 30 s later the daemon's snapshot rewrote each record's status_reason, so the
 * few recoveries armed read as "not infra" and aborted.
 *
 * WHAT IS RESUMED is decided from recorded facts (sessions/restart-loss.ts) and
 * stored on the record as `restartLoss`, a field no status write touches. While
 * a loss is pending or queued, every hand-back path leaves the task's phase
 * alone (holdsHandBack), so an interrupted task never reads as waiting on the
 * user.
 *
 * HOW THE RESUME HAPPENS. This module does not spawn anything. It sends ONE
 * message through the normal queue (`sendMessageToSession`), and the existing
 * send path does the rest: a dead session's write fails and falls back to a
 * `--resume` spawn, which the daemon's one-CLI-per-session guard covers. The
 * restart note rides in front of whichever message reaches the session first
 * (pendingRestartNotice), so a human or a peer who gets there before the queue
 * does still hands the agent the facts.
 *
 * THE QUEUE: open turns first, then the most recent work; per host at most
 * `concurrency` resumes in flight (a resume holds its slot until the session
 * is back or `settleTimeoutMs`), `staggerMs` between starts, and on this
 * machine a load gate (a computer that just booted is busy). The attempt
 * budget is persisted on the record, so a reboot loop cannot respawn forever,
 * and the loss itself is persisted, so a restart in the middle of recovery
 * picks up where it stopped. A host that is not connected keeps its sessions
 * queued until it returns, for at most `ownerWaitMs`.
 */

import { randomUUID } from 'node:crypto'
import { bus, EventNames } from './event-bus.js'
import type { BusEvent } from './event-bus.js'
import type { RestartLossCause, SessionRecord, SessionRestartLoss, StatusReason } from './types.js'
import { isInfraSessionError } from './session-error-kind.js'
import {
  AUTO_RECOVER_SOURCE,
  defaultDeps,
  isLocalHost,
  LOCAL_HOST,
  resolveAutoRecoverConfig,
  type AutoRecoverConfig,
  type AutoRecoverDeps,
} from './sessions/auto-recover-env.js'
import {
  RESUME_MESSAGE,
  classifyRestartLoss,
  factsFromRecord,
  factsFromSnapshot,
  lostWork,
  resumePriority,
} from './sessions/restart-loss.js'
import { log } from '../logging/index.js'

export { AUTO_RECOVER_SOURCE, resolveAutoRecoverConfig }
export type { AutoRecoverConfig, AutoRecoverDeps, AutoRecoverTask } from './sessions/auto-recover-env.js'

/** Why schedule() did not take a session on. */
export type SkipReason = 'disabled' | 'already-tracked' | 'already-decided' | 'archived' | 'not-infra' | 'no-task' | 'not-interactive' | 'session-budget'

/** An unstamped record the startup reconciler just marked holds its phase this
 *  long, so its own hand-back cannot beat the classification that follows. */
const UNSTAMPED_HOLD_MS = 10 * 60_000
/** How often a waiting queue re-checks the load gate and offline hosts. */
const RECHECK_MS = 15_000
/** Poll interval while a resume waits for its session to come back. */
const SETTLE_POLL_MS = 2_000
/** How often a resume parked on its host's daemon looks again. */
const HOST_WAIT_RECHECK_MS = 60_000

/** Where a loss's host-wait window starts: its observation (one clock, also while it waits on a delivery). */
const lossClock = (loss: SessionRestartLoss): number => Date.parse(loss.at)

const hostName = (host: string | null | undefined): string =>
  isLocalHost(host) ? "this computer's session daemon" : `the session daemon on ${host}`

type LossBefore = NonNullable<SessionRestartLoss['before']>

interface QueueItem { sid: string; hostKey: string; priority: number; notBefore: number; gatedSince?: number }

const isLive = (r: SessionRecord | null): boolean => r?.process_status === 'running' || r?.process_status === 'idle'


// ── Scheduler ────────────────────────────────────────────────────────────────

export class SessionAutoRecover {
  private readonly cfg: AutoRecoverConfig
  private readonly deps: AutoRecoverDeps
  /** Sessions being classified (stamp written, verdict not yet). */
  private readonly classifying = new Set<string>()
  private readonly queue = new Map<string, QueueItem>()
  private readonly inFlight = new Map<string, Set<string>>()
  private readonly hostNextStart = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = 0
  private stopped = false

  constructor(cfg: AutoRecoverConfig, deps: Partial<AutoRecoverDeps> = {}) {
    this.cfg = cfg
    this.deps = { ...defaultDeps(), ...deps }
  }

  get enabled(): boolean { return this.cfg.enabled && !this.stopped }

  handleEvent = (event: BusEvent): void => {
    if (event.name !== EventNames.SESSION_DELETED) return
    const d = event.data as { sessionId?: string; sessionIds?: string[] }
    for (const id of d.sessionIds ?? (d.sessionId ? [d.sessionId] : [])) this.queue.delete(id)
  }

  private tracked(sid: string): boolean {
    if (this.classifying.has(sid) || this.queue.has(sid)) return true
    for (const set of this.inFlight.values()) if (set.has(sid)) return true
    return false
  }

  private attemptsSpent(record: Pick<SessionRecord, 'autoRecover'>): number {
    const st = record.autoRecover
    if (!st) return 0
    const last = Date.parse(st.lastAt)
    if (Number.isNaN(last) || this.deps.now() - last > this.cfg.windowMs) return 0
    return st.attempts
  }

  /**
   * Must a hand-back leave this session's task alone? True while its restart
   * loss is being classified or waits for its resume. Every path that would
   * hand the task back (the startup reconciler, the snapshot projection, the
   * health monitor's drift rule) asks this first.
   */
  holdsHandBack(record: SessionRecord): boolean {
    if (!this.enabled || record.archived) return false
    if (this.tracked(record.claudeSessionId)) return true
    const loss = record.restartLoss
    const now = this.deps.now()
    // A loss nobody resolved within the host-wait window stops holding, so a
    // stuck record can never pin a task's phase forever.
    if (loss && now - lossClock(loss) <= this.cfg.ownerWaitMs) {
      if (loss.state === 'pending' || loss.state === 'queued') return true
      if (loss.state === 'sent') {
        // On its way back; past the settle window the session's own state speaks.
        if (now - Date.parse(loss.sentAt ?? loss.at) < this.cfg.settleTimeoutMs + 60_000) return true
      } else if (loss.revision === record.statusRevision) {
        return false  // this death, already decided
      }
      // Otherwise the loss belongs to an earlier life: judge this death afresh.
    }
    // The startup reconciler hands back right after marking a session dead,
    // before classification has stamped it. One recovery would not take on
    // (its budget is spent) is handed back at once.
    return record.status_reason === 'server_restart' && !isLive(record)
      && this.deps.now() - Date.parse(record.last_status_change ?? '') < UNSTAMPED_HOLD_MS
      && this.wouldAttempt(record, { requireInfra: false }).ok
  }

  /** Cheap sync verdict: would schedule() take this record on? */
  wouldAttempt(record: SessionRecord, opts: { requireInfra?: boolean } = {}): { ok: true } | { ok: false; reason: SkipReason } {
    if (!this.enabled) return { ok: false, reason: 'disabled' }
    if (this.tracked(record.claudeSessionId)) return { ok: false, reason: 'already-tracked' }
    if (record.archived) return { ok: false, reason: 'archived' }
    // This death was decided already (a runtime site re-reports it every tick).
    const prior = record.restartLoss
    if (prior && prior.state !== 'pending' && prior.state !== 'resumed' && !isLive(record)
      && prior.revision !== undefined && prior.revision === record.statusRevision) {
      return { ok: false, reason: 'already-decided' }
    }
    // Embedded/derived sessions (triage, hook, cron, subagent) have no
    // standalone work to continue and no human waiting on them.
    if (record.type && record.type !== 'interactive') return { ok: false, reason: 'not-interactive' }
    if (!record.taskId) return { ok: false, reason: 'no-task' }
    if (opts.requireInfra !== false && !isInfraSessionError(record)) return { ok: false, reason: 'not-infra' }
    if (record.status_reason === 'spawn_outcome_unknown' && !record.pid && !record.outputFile) return { ok: false, reason: 'not-infra' }
    if (this.attemptsSpent(record) >= this.cfg.maxAttempts) return { ok: false, reason: 'session-budget' }
    return { ok: true }
  }

  /**
   * A process was lost: classify it and, when its work was in flight, queue a
   * resume. `before` is the record as it stood before the loss was written
   * (its last projected status). Returns true when the session is taken on:
   * the caller then leaves the task's phase alone, and this module hands it
   * back itself if the verdict is not to resume.
   */
  noteLoss(record: SessionRecord, cause: RestartLossCause, before?: SessionRecord, opts: { requireInfra?: boolean; fallbackInFlight?: boolean } = {}): boolean {
    const verdict = this.wouldAttempt(record, opts)
    if (!verdict.ok) {
      log.session.debug('restart recovery: not taken on', { sessionId: record.claudeSessionId, reason: verdict.reason })
      return false
    }
    const b = before ?? record
    this.startClassify(record, cause, {
      status: b.process_status, lastActiveAt: b.lastActiveAt, permission: !!b.pendingPermission,
    }, !!opts.fallbackInFlight)
    return true
  }

  private startClassify(record: SessionRecord, cause: RestartLossCause, before: LossBefore, fallbackInFlight: boolean): void {
    const sid = record.claudeSessionId
    this.classifying.add(sid)
    void this.classify(record, cause, before, fallbackInFlight)
      .catch(async (err) => {
        log.session.warn('restart recovery: classification failed', {
          sessionId: sid, error: err instanceof Error ? err.message : String(err),
        })
        // Never leave it 'pending' (that holds the phase): hand it back.
        this.classifying.delete(sid)
        const rec = await this.deps.getSession(sid).catch(() => null)
        if (rec) await this.giveUp(rec, 'its restart could not be assessed').catch(() => undefined)
      })
      .finally(() => this.classifying.delete(sid))
  }

  /** Compatibility entry for the runtime discovery sites (health monitor, daemon reconnect). */
  schedule(record: SessionRecord, cause?: StatusReason): boolean {
    const lossCause: RestartLossCause = cause === 'server_restart'
      ? 'server_restart'
      : isLocalHost(record.host) ? 'server_restart' : 'host_restart'
    // The record here was already relabelled (stopped / error) and its
    // activity time moved; without the host's fold, the cause these sites
    // proved (a lost host or daemon) is taken to have cut work short, as before.
    return this.noteLoss(record, lossCause, record, { fallbackInFlight: true })
  }

  private async classify(record: SessionRecord, cause: RestartLossCause, before: LossBefore, fallbackInFlight: boolean): Promise<void> {
    const sid = record.claudeSessionId
    const taskId = record.taskId!
    const nowIso = new Date(this.deps.now()).toISOString()
    // Stamp first: from here the loss survives a restart even if the facts
    // below take a while (a cold fold of a large stream file).
    // A re-report of a death already told about keeps that: one notice per death.
    const prior = record.restartLoss
    const toldBefore = !!prior?.told && prior.state !== 'resumed' && prior.revision === record.statusRevision
    await this.deps.patchLoss(sid, () => ({ at: nowIso, cause, lost: [], state: 'pending', before }))
    const beforeActive = Date.parse(before.lastActiveAt ?? '')

    const snap = await this.deps.fetchSnapshot(record)
    if (snap && snap.cliState !== 'dead') {
      // The host says the process lives: nothing was lost.
      await this.deps.patchLoss(sid, (cur) => cur && { ...cur, state: 'skipped', reason: 'process is alive', told: true })
      log.session.info('restart recovery: process is alive, nothing to recover', { sessionId: sid, cliState: snap.cliState })
      return
    }
    const facts = snap
      ? factsFromSnapshot(snap, beforeActive)
      : factsFromRecord({
        process_status: (fallbackInFlight ? 'running' : before.status) as SessionRecord['process_status'],
        pendingPermission: before.permission ? { requestId: 'before-loss', receivedAt: '' } : undefined,
      })
    const task = await this.deps.getTask(taskId)
    const cwdOk = await this.deps.cwdExists(record)
    const taskDir = await this.deps.taskDir(taskId, record.host)
    let finalCause = cause
    let bootAt: string | undefined
    if (isLocalHost(record.host) && cause !== 'host_restart') {
      const boot = this.deps.bootTimeMs()
      // The machine booted after this session last did anything: the reboot,
      // not a server restart, is what killed it.
      if (Number.isFinite(boot) && boot > beforeActive) {
        finalCause = 'machine_reboot'
        bootAt = new Date(boot).toISOString()
      }
    }
    const { verdict, reason } = classifyRestartLoss({ facts, phase: task?.phase ?? null, cwdMissing: cwdOk === false })
    const lost = lostWork(facts)
    const loss: SessionRestartLoss = {
      at: nowIso,
      cause: finalCause,
      ...(bootAt ? { bootAt } : {}),
      lost,
      ...(facts.backgroundCount ? { backgroundCount: facts.backgroundCount } : {}),
      phaseAtLoss: task?.phase ?? null,
      verdict,
      reason,
      state: verdict === 'resume' ? 'queued' : 'skipped',
      // Nothing to say to an idle session a server restart merely recycled.
      told: toldBefore || (lost.length === 0 && finalCause !== 'machine_reboot'),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(cwdOk === false ? { cwdMissing: true } : {}),
      ...(taskDir ? { taskDir } : {}),
      before,
    }
    const latest = await this.deps.getSession(sid)
    if (latest?.statusRevision !== undefined) loss.revision = latest.statusRevision
    const stored = await this.deps.patchLoss(sid, (cur) => (cur && cur.state === 'pending' ? loss : cur))
    log.session.info('restart recovery: classified', {
      sessionId: sid, taskId, verdict, reason, cause: finalCause, facts: facts.source,
      phase: task?.phase ?? null, lost,
    })
    if (!stored || stored.state !== loss.state || stored.at !== loss.at) return
    // Decided: the stored verdict speaks for this session from here (the
    // hand-back below must not be held off by our own bookkeeping).
    this.classifying.delete(sid)

    if (verdict === 'resume') {
      this.enqueue(sid, record.host, resumePriority(loss, beforeActive), this.deps.now() + this.cfg.delayMs)
      this.deps.emitNote(sid, taskId, `Restart recovery: ${finalCause === 'machine_reboot' ? 'the computer rebooted' : 'a restart'} killed this session while its work was in flight (${lost.join(', ')}). It will resume automatically.`)
      return
    }
    if (verdict === 'cwd_missing') {
      this.deps.emitNote(sid, taskId, `Restart recovery: not resumed, because the working directory ${record.cwd ?? ''} no longer exists (the reboot cleared it).`)
    }
    // Not resumed: the task gets the hand-back the guard held off, unless it
    // sits where a hand-back does not apply (WAITING, Main between turns).
    if ((task?.phase === 'IN_PROGRESS' || task?.phase === 'TODO') && !(task.isMain && verdict === 'settled')) {
      await this.deps.handBack(taskId, sid)
    }
  }

  /** After boot: pick up losses a previous run left unresolved. */
  async resumeUnfinished(): Promise<number> {
    if (!this.enabled) return 0
    let picked = 0
    for (const rec of await this.deps.listSessions()) {
      const loss = rec.restartLoss
      const sid = rec.claudeSessionId
      if (!loss || this.tracked(sid) || rec.archived) continue
      if (loss.state !== 'pending' && loss.state !== 'queued') continue
      if (this.deps.now() - lossClock(loss) > this.cfg.ownerWaitMs) continue
      if (isLive(rec)) {
        await this.deps.patchLoss(sid, (cur) => cur && { ...cur, state: 'resumed', reason: 'came back' })
        continue
      }
      picked++
      // The facts of the death were stored with the stamp (the record itself
      // has been rewritten since).
      const before = loss.before ?? { status: rec.process_status, lastActiveAt: rec.lastActiveAt, permission: !!rec.pendingPermission }
      if (loss.state === 'pending') {
        this.startClassify(rec, loss.cause, before, false)
      } else {
        this.enqueue(sid, rec.host, resumePriority(loss, Date.parse(before.lastActiveAt ?? '')), this.deps.now() + this.cfg.delayMs)
      }
    }
    if (picked) log.session.info('restart recovery: picked up unfinished recoveries', { count: picked })
    return picked
  }

  private enqueue(sid: string, host: string | null | undefined, priority: number, notBefore: number): void {
    if (this.stopped) return
    this.queue.set(sid, { sid, hostKey: host ?? LOCAL_HOST, priority, notBefore })
    log.session.info('restart recovery: queued', { sessionId: sid, host: host ?? LOCAL_HOST, queueDepth: this.queue.size })
    this.pump()
  }

  private inFlightOn(hostKey: string): Set<string> {
    let set = this.inFlight.get(hostKey)
    if (!set) { set = new Set(); this.inFlight.set(hostKey, set) }
    return set
  }

  private arm(at: number): void {
    if (this.stopped) return
    if (this.timer && this.timerAt <= at) return
    if (this.timer) this.deps.clearTimer(this.timer)
    this.timerAt = at
    this.timer = this.deps.setTimer(() => { this.timer = null; this.pump() }, Math.max(0, at - this.deps.now()))
  }

  /** Start every resume the caps allow now; arm a timer for the next one. */
  pump(): void {
    if (this.stopped) return
    const now = this.deps.now()
    let next = Infinity
    const items = [...this.queue.values()].sort((a, b) => a.priority - b.priority)
    for (const item of items) {
      if (item.notBefore > now) { next = Math.min(next, item.notBefore); continue }
      const flying = this.inFlightOn(item.hostKey)
      if (flying.size >= this.cfg.concurrency) continue
      const slot = this.hostNextStart.get(item.hostKey) ?? 0
      if (slot > now) { next = Math.min(next, slot); continue }
      if (isLocalHost(item.hostKey)) {
        const load = this.deps.loadPerCpu()
        if (load > this.cfg.maxLoadPerCpu) {
          item.gatedSince ??= now
          // Past the wait the queue goes on, but one at a time.
          if (now - item.gatedSince < this.cfg.loadWaitMs || flying.size > 0) {
            if (item.gatedSince === now) log.session.info('restart recovery: waiting for the machine to settle', { load: Number(load.toFixed(2)), max: this.cfg.maxLoadPerCpu })
            next = Math.min(next, now + RECHECK_MS)
            continue
          }
        }
      }
      this.queue.delete(item.sid)
      flying.add(item.sid)
      this.hostNextStart.set(item.hostKey, now + this.cfg.staggerMs)
      void this.fire(item).finally(() => {
        flying.delete(item.sid)
        this.pump()
      })
    }
    if (next < Infinity) this.arm(next)
  }

  private async giveUp(rec: SessionRecord, reason: string): Promise<void> {
    await this.deps.patchLoss(rec.claudeSessionId, (cur) => cur && { ...cur, state: 'gave_up', reason, revision: rec.statusRevision })
    log.session.warn('restart recovery: gave up', { sessionId: rec.claudeSessionId, taskId: rec.taskId, reason })
    this.deps.emitNote(rec.claudeSessionId, rec.taskId, `Restart recovery gave up: ${reason}. The task is handed back to you.`)
    if (rec.taskId) {
      const task = await this.deps.getTask(rec.taskId)
      if (task?.phase === 'IN_PROGRESS') await this.deps.handBack(rec.taskId, rec.claudeSessionId)
    }
  }

  private requeue(item: QueueItem, delayMs: number): void {
    this.queue.set(item.sid, { ...item, notBefore: this.deps.now() + delayMs })
  }

  private async fire(item: QueueItem): Promise<void> {
    const sid = item.sid
    try {
      const rec = await this.deps.getSession(sid)
      const loss = rec?.restartLoss
      if (!rec || rec.archived || !loss || loss.state !== 'queued' || !rec.taskId) {
        log.session.info('restart recovery: dropped, record changed', { sessionId: sid, state: loss?.state ?? null })
        return
      }
      if (isLive(rec)) {
        // A human, a peer or a trigger got there first; the note rode on it.
        await this.deps.patchLoss(sid, (cur) => cur && { ...cur, state: 'resumed', reason: 'resumed by another message', waitingHost: undefined })
        return
      }
      const task = await this.deps.getTask(rec.taskId)
      if (!task || task.phase !== loss.phaseAtLoss) {
        await this.deps.patchLoss(sid, (cur) => cur && { ...cur, state: 'skipped', reason: `task moved to ${task?.phase ?? 'nothing'}`, revision: rec.statusRevision })
        log.session.info('restart recovery: skipped, task phase changed', { sessionId: sid, was: loss.phaseAtLoss, now: task?.phase ?? null })
        return
      }
      if (loss.waitingHost) {
        // Its resume is still in the session's queue, put back when the host's
        // daemon could not take it; the daemon's reconnect delivers it. Nothing
        // is sent again and no attempt is spent while it waits.
        if (await this.deps.pendingMessages(sid) > 0) {
          if (this.deps.now() - lossClock(loss) > this.cfg.ownerWaitMs) {
            // A resume that goes out after the hand-back would start work the user now owns.
            if (loss.waitingHost.messageId) await this.deps.dropMessage(sid, loss.waitingHost.messageId)
            await this.giveUp(rec, `${hostName(rec.host)} could not take the resume within ${Math.round(this.cfg.ownerWaitMs / 3_600_000)} h of the restart (last error: ${loss.waitingHost.error})`)
            return
          }
          this.requeue(item, HOST_WAIT_RECHECK_MS)
          return
        }
        // The batch left the queue without bringing the session back: judge it afresh.
        await this.deps.patchLoss(sid, (cur) => cur && { ...cur, waitingHost: undefined })
      }
      const owner = await this.deps.recoveryOwner(rec)
      if (owner === 'daemon') {
        await this.deps.patchLoss(sid, (cur) => cur && { ...cur, state: 'skipped', reason: 'the host daemon supervises it', revision: rec.statusRevision })
        return
      }
      if (owner === 'unknown') {
        if (this.deps.now() - Date.parse(loss.at) > this.cfg.ownerWaitMs) {
          await this.giveUp(rec, `its host ${rec.host ?? ''} did not come back`.replace('  ', ' '))
          return
        }
        log.session.info('restart recovery: host not connected, will retry', { sessionId: sid, host: item.hostKey })
        this.requeue(item, 60_000)
        return
      }
      const attempts = this.attemptsSpent(rec) + 1
      if (attempts > this.cfg.maxAttempts) {
        await this.giveUp(rec, `${this.cfg.maxAttempts} resume attempts failed`)
        return
      }
      // Persist BEFORE sending: if the send wedges or the server dies mid-resume,
      // the attempt must still count, or a crash loop gets unlimited retries.
      await this.deps.noteAttempt(sid, attempts, rec.status_reason)
      log.session.info('restart recovery: resuming', {
        sessionId: sid, taskId: rec.taskId, host: item.hostKey, attempt: attempts, lost: loss.lost,
      })
      if (this.stopped) return
      const revBefore = rec.statusRevision
      // A delivery the host's daemon could not take puts the batch back in the
      // queue and says so only on the bus (the record is left as it was), and it
      // can say so before the send returns: listen first.
      const undelivered: { error?: string; messageId: string } = { messageId: `qm-recover-${randomUUID()}` }
      const stopListening = this.deps.onDeliveryFailed(sid, (error) => { undelivered.error = error })
      try {
        await this.deps.send(sid, RESUME_MESSAGE, { source: AUTO_RECOVER_SOURCE, taskId: rec.taskId, messageId: undelivered.messageId })
        const sentAt = new Date(this.deps.now()).toISOString()
        await this.deps.patchLoss(sid, (cur) => cur && cur.state === 'queued' ? { ...cur, state: 'sent', sentAt } : cur)
        await this.settle(item, attempts, revBefore, undelivered)
      } finally {
        stopListening()
      }
    } catch (err) {
      log.session.warn('restart recovery: resume failed', {
        sessionId: sid, error: err instanceof Error ? err.message : String(err),
      })
      // Back into the queue: the budget check above bounds the retries.
      const rec = await this.deps.getSession(sid).catch(() => null)
      if (rec?.restartLoss && (rec.restartLoss.state === 'queued' || rec.restartLoss.state === 'sent')) {
        await this.deps.patchLoss(sid, (cur) => cur && { ...cur, state: 'queued' }).catch(() => null)
        this.requeue(item, this.cfg.retryDelayMs)
      }
    }
  }

  /** Hold the slot until the session is back, its spawn failed, or the timeout. */
  private async settle(item: QueueItem, attempt: number, revBefore: number | undefined, undelivered: { error?: string; messageId?: string }): Promise<void> {
    const deadline = this.deps.now() + this.cfg.settleTimeoutMs
    while (!this.stopped && this.deps.now() < deadline) {
      await new Promise<void>((resolve) => { this.deps.setTimer(resolve, SETTLE_POLL_MS) })
      const rec = await this.deps.getSession(item.sid)
      if (!rec) return
      if (isLive(rec)) {
        await this.deps.patchLoss(item.sid, (cur) => cur && { ...cur, state: 'resumed', reason: `resumed (attempt ${attempt})`, waitingHost: undefined })
        log.session.info('restart recovery: session is back', { sessionId: item.sid, attempt })
        return
      }
      if (undelivered.error !== undefined && await this.deps.pendingMessages(item.sid) > 0) {
        await this.waitForHost(item, rec, attempt, undelivered.error, undelivered.messageId)
        return
      }
      // Only an error written after the send is this spawn's failure.
      if (rec.process_status === 'error' && rec.statusRevision !== revBefore) {
        log.session.warn('restart recovery: resume spawn failed, will retry', { sessionId: item.sid, attempt, error: rec.errorMessage ?? null })
        await this.deps.patchLoss(item.sid, (cur) => cur && { ...cur, state: 'queued' })
        this.requeue(item, this.cfg.retryDelayMs)
        return
      }
    }
    // Still not back: the message waits in the session's queue, which owns its
    // delivery from here. The loss stays 'sent' and stops holding the phase
    // once the host-wait window passes.
  }

  /**
   * The host could not take the resume: the same infra loss as a host that is
   * offline, not a failed attempt. 2026-10-26: after the user's login on this Mac
   * ended, its session daemon could not start for hours ("port file not created
   * within 30s"); each resume burned an attempt and the tasks were handed back as
   * if they waited on the user. Now the attempt is given back, the task stays
   * held, and the queued message goes out when the daemon serves again.
   */
  private async waitForHost(item: QueueItem, rec: SessionRecord, attempt: number, error: string, messageId?: string): Promise<void> {
    await this.deps.noteAttempt(item.sid, Math.max(0, attempt - 1), rec.status_reason)
    const since = new Date(this.deps.now()).toISOString()
    await this.deps.patchLoss(item.sid, (cur) => cur && {
      ...cur, state: 'queued', reason: `waiting for ${hostName(rec.host)}: ${error}`,
      waitingHost: {
        since: cur.waitingHost?.since ?? since, error: error.slice(0, 300),
        ...(messageId ?? cur.waitingHost?.messageId ? { messageId: messageId ?? cur.waitingHost?.messageId } : {}),
      },
    })
    log.session.warn('restart recovery: the host could not take the resume, waiting for it', { sessionId: item.sid, host: item.hostKey, error })
    this.requeue(item, HOST_WAIT_RECHECK_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) this.deps.clearTimer(this.timer)
    this.timer = null
    this.queue.clear()
    this.hostNextStart.clear()
  }

  // ── Test-only introspection ──
  hasPending(sessionId: string): boolean { return this.tracked(sessionId) }
  queuedIds(): string[] { return [...this.queue.values()].sort((a, b) => a.priority - b.priority).map((i) => i.sid) }
  inFlightIds(hostKey = LOCAL_HOST): string[] { return [...(this.inFlight.get(hostKey) ?? [])] }
}

// ── Module wiring ────────────────────────────────────────────────────────────

let instance: SessionAutoRecover | null = null

export function startSessionAutoRecover(
  cfg: AutoRecoverConfig = resolveAutoRecoverConfig(),
  deps: Partial<AutoRecoverDeps> = {},
): { stop: () => void; instance: SessionAutoRecover } {
  const sar = new SessionAutoRecover(cfg, deps)
  instance = sar
  bus.subscribe('session-auto-recover', sar.handleEvent, {
    global: true,
    interest: ['session:deleted'],
  })
  log.session.info('auto-recover watcher started', {
    enabled: cfg.enabled, delayMs: cfg.delayMs, staggerMs: cfg.staggerMs, concurrency: cfg.concurrency,
    maxAttempts: cfg.maxAttempts, maxLoadPerCpu: cfg.maxLoadPerCpu,
  })
  return {
    stop: () => {
      bus.unsubscribe('session-auto-recover')
      sar.stop()
      if (instance === sar) instance = null
    },
    instance: sar,
  }
}

export function getSessionAutoRecover(): SessionAutoRecover | null {
  return instance
}

/**
 * Convenience for the runtime discovery sites (daemon reconnect, health
 * monitor): take a lost session on if the watcher is running. Returns true when
 * taken, so the caller knows not to advance the task phase behind it.
 */
export function scheduleSessionAutoRecover(record: SessionRecord, cause?: StatusReason): boolean {
  return instance?.schedule(record, cause) ?? false
}

/**
 * Startup catch-up: every session the reconciler found dead after this boot,
 * with its record as it stood before (its last projected status).
 */
export async function recoverAfterBoot(dead: SessionRecord[], before: Map<string, SessionRecord>): Promise<{ taken: number; picked: number }> {
  const sar = instance
  if (!sar) return { taken: 0, picked: 0 }
  let taken = 0
  for (const rec of dead) {
    // The reconciler's own stamp ('server_restart') is the infra fact here. A
    // record it only tidied (an 'error' that had died before this boot) was not
    // killed by the restart.
    if (rec.process_status !== 'stopped' || rec.status_reason !== 'server_restart') continue
    if (sar.noteLoss(rec, 'server_restart', before.get(rec.claudeSessionId), { requireInfra: false })) taken++
  }
  const picked = await sar.resumeUnfinished()
  return { taken, picked }
}
