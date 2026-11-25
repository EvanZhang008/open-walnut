/**
 * walnut-trigger, the runs: the 5 s clock, a trigger's check run, a clock routine's slot
 * (clock-routine-v1), the replay of unacked fires, and the host's own delivery of a fire no
 * server claimed (into a session here, or a routine's run started here). startTriggers and
 * stopTriggers are the clock's start (Main) and the stop of every run (cleanup).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts) over the trigger store
 * (daemon-trigger-store.ts). Checks start with the runtime's childUse. The code is the runtime's
 * as it was; deps carry the runtime's own names.
 */
import type { CheckCallers, PendingFire, TriggerDef, TriggerHostState } from './trigger-check-core.js'
import { keepUnsentCheck, takeUnsentChecks } from './trigger-unsent-checks.js'
import type { ClockHostStart } from './clock-host-start-core.js'
import type { createFollowerTriggerDelivery } from './follower-trigger-delivery-core.js'
import type { ChildProcessUse } from './daemon-child-spawn.js'
import type { RuntimeTimers } from './daemon-runtime-timers.js'
import type { ArmedTrigger, createDaemonTriggerStore } from './daemon-trigger-store.js'
import type { DaemonEnv, DaemonLog, HostTriggerJudge } from './daemon-module-deps.js'

export interface DaemonTriggerRunsDeps {
  /** The trigger logic this area runs on (daemon-module-deps.ts HostTriggerJudge), passed in by the runtime. */
  judge: HostTriggerJudge
  daemonEnv: DaemonEnv
  /** The trigger store (daemon-trigger-store.ts). */
  triggerStore: ReturnType<typeof createDaemonTriggerStore>
  /** A stopping Demo starts no check, delivery or routine run. */
  demoQuiesce: { readonly fenced: boolean }
  /** The runtime's child-process use: a check starts with the runtime's spawn and env. */
  childUse: ChildProcessUse
  /** A check's `walnut` calls act for its trigger's task (trigger-caller-v1). */
  checkCallers: CheckCallers
  GATEWAY_SOCK_PATH: string
  GATEWAY_SHIM_DIR: string
  /** Writes a fire into a session of this host while its leader is away. */
  followerTriggers: Pick<ReturnType<typeof createFollowerTriggerDelivery>, 'deliver'>
  /** Starts a routine's run on this host (clock-host-start-v1). */
  clockHostStart: Pick<ClockHostStart, 'start'>
  /** The runtime's own interval timers (the clock). */
  setInterval: RuntimeTimers['setInterval']
  clearInterval: RuntimeTimers['clearInterval']
  logMsg: DaemonLog
}

export function createDaemonTriggerRuns(deps: DaemonTriggerRunsDeps) {
  const { daemonEnv, triggerStore, demoQuiesce, childUse, checkCallers, GATEWAY_SOCK_PATH, GATEWAY_SHIM_DIR, followerTriggers, clockHostStart, setInterval, clearInterval, logMsg } = deps
  const { hostBatch, markHostBatch, applyCheckError, applyCheckOutcome, applyClockFire, buildCheckStdin, checkErrorOf, decideCheck, checkIdleOf, fireDueOnHost, markHostDelivered, parseCheckStdout, runCheckProcess, CHECK_ERROR_BACKOFF_MS, HOST_DELIVERY_GRACE_MS, HOST_DELIVERY_RETRY_MS, MAX_CONSECUTIVE_CHECK_ERRORS, PENDING_FIRE_REPLAY_MS, applyMachineFault, checkCallerEnv, buildScheduledMessage, buildTriggerMessage, clockDueMs, clockFireOwed, clockStateOnArm, dropStaleClockFires, createClockSchedule } = deps.judge
  const { TRIGGER_TICK_MS, armedTriggers, hostDeliveriesInFlight, triggerChecksRunning, triggerKey, heldTrigger, fireHolders, readTriggerState, persistTriggerState, sendTriggerEvent, sendTriggerFire } = triggerStore

  // The clock: startTriggers (Main) sets it, stopTriggers (cleanup) clears it.
  let triggerTickTimer: ReturnType<typeof setInterval> | null = null

  // Check pids not closed yet (runs in flight: triggerChecksRunning): demo.quiesce alone aborts them and waits for 0.
  const demoTriggerChecks = new AbortController()
  const demoTriggerCheckPids = new Set<number>()
  // Set by cleanup(): a run its abort ended writes no state and sends no event (the successor runs it next).
  let triggerChecksEnded = false
  /** runCheckProcess options every check of this daemon runs with: its fence, and the runtime's own spawn and env. */
  function checkRunFence(): { maySpawn: () => boolean; signal: AbortSignal; children: Set<number>; childProcess: ChildProcessUse } {
    return { maySpawn: () => !demoQuiesce.fenced, signal: demoTriggerChecks.signal, children: demoTriggerCheckPids, childProcess: childUse }
  }

  /** Replay cadence for unacked fires; the env override exists for tests. */
  function triggerReplayMs(): number {
    const raw = Math.floor(Number(daemonEnv.WALNUT_TRIGGER_REPLAY_MS))
    return Number.isFinite(raw) && raw > 0 ? Math.max(1_000, raw) : PENDING_FIRE_REPLAY_MS
  }

  /** How long a fire waits for a server's claim before this host delivers it; tests shorten it. */
  function hostDeliveryGraceMs(): number {
    const raw = Math.floor(Number(daemonEnv.WALNUT_TRIGGER_HOST_GRACE_MS))
    return Number.isFinite(raw) && raw > 0 ? Math.max(500, raw) : HOST_DELIVERY_GRACE_MS
  }

  function newArmedTrigger(home: string, def: TriggerDef, state: TriggerHostState, nextRunAtMs: number, now: number, keepFires = false): ArmedTrigger {
    const entry: ArmedTrigger = { home, def, state, nextRunAtMs, running: false, fireSentAt: new Map(), armedAtMs: now }
    if (def.clock) armClock(entry, now, nextRunAtMs - now, keepFires)
    return entry
  }

  // ── Clock routines (clock-routine-v1): the schedule is the fire condition ──
  // A routine whose work runs on this host keeps its clock here (trigger-clock-core.ts):
  // no script runs; a due slot queues a fire with no items, which goes the way a
  // trigger's does (claims, host delivery into the task's session, acks). The server
  // stopped ticking it before it pushed the def, and takes it back only from this
  // daemon's report that it disarmed it (configure's `released`).
  const clockSchedule = createClockSchedule()

  /**
   * Arm a clock def on `entry`: its place under the same handover, else a fresh start
   * at the def's slot, and never at a slot the routine already ran (notBeforeMs).
   * `keepFires`: the fires are a released clock's, which the server still records.
   */
  function armClock(entry: ArmedTrigger, now: number, delayMs: number, keepFires = false): void {
    const spec = entry.def.clock!
    const prev = entry.state.clock
    const clock = clockStateOnArm(spec, prev)
    if (clock !== prev) {
      entry.state.clock = clock
      // A new handover: runs nobody took under an older one are not this clock's.
      if (!keepFires) dropStaleClockFires(entry.state, spec.fromMs)
      persistTriggerState(entry.home, entry.def.id, entry.state)
      logMsg('info', 'clock routine armed', {
        id: entry.def.id, fromMs: spec.fromMs, nextRunAtMs: clock.nextRunAtMs,
        handover: !prev ? 'first' : prev.fromMs === spec.fromMs ? 'past-last-run' : 'new',
        ...(spec.notBeforeMs !== undefined ? { notBeforeMs: spec.notBeforeMs } : {}),
      })
    }
    entry.nextRunAtMs = clockDueMs(clock, now, Math.max(0, delayMs))
  }

  /**
   * A clock's slot came, or someone asked for a run now (`manual`, which leaves the
   * schedule where it is). While a run nobody took yet is owed, a slot only moves the
   * clock on: the owed one stands for it.
   */
  function runClock(entry: ArmedTrigger, manual: boolean): 'fired' | 'held' {
    const now = Date.now()
    const spec = entry.def.clock!
    const clock = entry.state.clock ?? clockStateOnArm(spec, undefined)
    const slotMs = manual ? now : (clock.nextRunAtMs ?? now)
    if (!manual) {
      const next = clockSchedule.afterRun(spec.schedule, Math.max(now, slotMs))
      entry.state.clock = { fromMs: clock.fromMs, ...(next !== undefined ? { nextRunAtMs: next } : {}) }
      entry.nextRunAtMs = next ?? Number.POSITIVE_INFINITY
    }
    const owed = !manual && clockFireOwed(entry.state.pendingFires)
    // Arbitrated (a server claims it, else the host takes it) when the host can deliver
    // the run itself: into a session here, or by starting the routine's session here.
    const fire = owed ? null : applyClockFire(entry.state, now, slotMs, !!entry.def.deliver || !!entry.def.start, clock.fromMs)
    persistTriggerState(entry.home, entry.def.id, entry.state)
    logMsg('info', 'clock routine run', {
      id: entry.def.id, outcome: fire ? 'fired' : 'held', slotMs, manual,
      ...(fire ? { seq: fire.seq } : {}), nextRunAtMs: entry.state.clock?.nextRunAtMs ?? null,
    })
    if (fire) sendTriggerFire(entry, fire, false)
    return fire ? 'fired' : 'held'
  }

  /** Errors keep the trigger armed (the server disables it) but slow it down. */
  function triggerCadenceMs(entry: ArmedTrigger): number {
    if (entry.state.consecutiveErrors >= MAX_CONSECUTIVE_CHECK_ERRORS) {
      return Math.max(entry.def.everyMs, CHECK_ERROR_BACKOFF_MS)
    }
    return entry.def.everyMs
  }

  /**
   * Report a check to the servers of its trigger's Walnut. One no server took goes into the trigger's
   * file, for the next configure (trigger-unsent-checks.ts); with a server here again, those kept go
   * first, oldest first, so the record, which takes only what is newer than it holds, keeps each.
   */
  function reportCheck(entry: ArmedTrigger, fields: Record<string, unknown>): void {
    const kept = entry.state.unsentChecks ?? []
    if (kept.length && sendTriggerEvent(entry.home, 'trigger.checked', { ...kept[0], replay: true })) {
      for (const c of kept.slice(1)) sendTriggerEvent(entry.home, 'trigger.checked', { ...c, replay: true })
      takeUnsentChecks(entry.state)
      persistTriggerState(entry.home, entry.def.id, entry.state)
    }
    if (sendTriggerEvent(entry.home, 'trigger.checked', fields) || !entry.state.lastCheck) return
    keepUnsentCheck(entry.state, entry.state.lastCheck)
    persistTriggerState(entry.home, entry.def.id, entry.state)
  }

  async function runTrigger(entry: ArmedTrigger): Promise<{ outcome: 'fired' | 'quiet' | 'error'; reason?: string; error?: string }> {
    if (demoQuiesce.fenced) return { outcome: 'quiet', reason: 'demo_stopping' }
    if (entry.def.clock) return runClock(entry, false) === 'fired' ? { outcome: 'fired' } : { outcome: 'quiet' }
    if (!entry.def.check) return { outcome: 'error', error: 'trigger has no check' }
    entry.running = true
    triggerChecksRunning.add(entry)
    const startedAt = Date.now()
    // A configure that lands mid-run may have disarmed this trigger. The run is
    // discarded then: the server no longer knows this id, so the fire would name a
    // stranger, and the persisted state would be a stale write racing whatever a
    // re-arm has already read from that file.
    const stillArmed = () => armedTriggers.get(triggerKey(entry.home, entry.def.id)) === entry
    try {
      // Its `walnut` calls act for this trigger's task (trigger-caller-v1), only while it runs.
      const caller = checkCallers.mint({ kind: 'armed', id: entry.def.id, ...(entry.home ? { home: entry.home } : {}) })
      const proc = await runCheckProcess(entry.def.check, buildCheckStdin(entry.state, startedAt), {
        env: { WALNUT_TRIGGER_ID: entry.def.id, WALNUT_TRIGGER_NAME: entry.def.name, ...checkCallerEnv(caller.sid, GATEWAY_SOCK_PATH) },
        templateShimDir: GATEWAY_SHIM_DIR,
        ...checkRunFence(),
      }).finally(() => caller.release())
      const parsed = parseCheckStdout(proc.stdout)
      const error = checkErrorOf(proc, parsed)
      // A failure the machine caused (one of the run's calls said so) is no strike against the script.
      const fault = error ? caller.fault() : undefined
      const now = Date.now()
      // A stopping Demo writes no state and sends no event for a run its stop ended.
      if (demoQuiesce.fenced || triggerChecksEnded) {
        logMsg('info', triggerChecksEnded ? 'trigger run discarded: the daemon is stopping' : 'trigger run discarded: Demo is stopping', { id: entry.def.id })
        return { outcome: 'quiet', reason: 'demo_stopping' }
      }
      if (!stillArmed()) {
        logMsg('info', 'trigger run discarded: disarmed mid-run', { id: entry.def.id })
        return { outcome: error ? 'error' : 'quiet', ...(error ? { error } : {}) }
      }
      if (error) {
        if (fault) applyMachineFault(entry.state, now)
        else applyCheckError(entry.state, now)
        entry.nextRunAtMs = now + triggerCadenceMs(entry)
        entry.state.lastCheck = {
          type: 'trigger.checked', id: entry.def.id, atMs: now, outcome: 'error', error, durationMs: proc.durationMs,
          nextRunAtMs: entry.nextRunAtMs, consecutiveErrors: entry.state.consecutiveErrors,
        }
        persistTriggerState(entry.home, entry.def.id, entry.state)
        logMsg('warn', 'trigger run', {
          id: entry.def.id, outcome: 'error', error, durationMs: proc.durationMs,
          consecutiveErrors: entry.state.consecutiveErrors, nextRunAtMs: entry.nextRunAtMs,
          ...(fault ? { fault } : {}),
        })
        reportCheck(entry, { ...entry.state.lastCheck, ...(fault ? { fault } : {}) })
        return { outcome: 'error', error }
      }
      // checkErrorOf already reported every failed parse above; this is the narrow.
      if (!parsed.ok) return { outcome: 'error', error: parsed.error }
      const output = parsed.output
      const decision = decideCheck(entry.def, output, entry.state, now)
      const fire = applyCheckOutcome(entry.state, output, decision, now, proc.durationMs, {
        itemsTruncated: parsed.itemsTruncated,
        arbitrated: !!entry.def.deliver,
      })
      entry.nextRunAtMs = now + triggerCadenceMs(entry)
      if (!fire) entry.state.lastCheck = {
        type: 'trigger.checked', id: entry.def.id, atMs: now, outcome: 'quiet',
        ...(decision.kind === 'quiet' ? { reason: decision.reason } : {}),
        durationMs: proc.durationMs, nextRunAtMs: entry.nextRunAtMs, consecutiveErrors: entry.state.consecutiveErrors,
        ...(output.warnings?.length ? { warnings: output.warnings } : {}),
      }
      persistTriggerState(entry.home, entry.def.id, entry.state)
      logMsg('info', 'trigger run', {
        id: entry.def.id, outcome: fire ? 'fired' : 'quiet',
        ...(fire ? { seq: fire.seq, items: fire.items.length } : { reason: decision.kind === 'quiet' ? decision.reason : undefined }),
        ...(output.warnings?.length ? { warnings: output.warnings } : {}),
        durationMs: proc.durationMs, nextRunAtMs: entry.nextRunAtMs,
      })
      if (fire) {
        sendTriggerFire(entry, fire, false)
        return { outcome: 'fired' }
      }
      const reason = decision.kind === 'quiet' ? decision.reason : undefined
      // `idle` rides the event only, never the state file (trigger-check-core.ts TriggerCheckedEvent.idle).
      reportCheck(entry, { ...entry.state.lastCheck!, ...(checkIdleOf(output, decision, entry.state) ? { idle: true } : {}) })
      return { outcome: 'quiet', ...(reason ? { reason } : {}) }
    } finally {
      entry.running = false
      triggerChecksRunning.delete(entry)
    }
  }

  /**
   * Re-send fires the server never acked. The configure replay only covers a
   * reconnect; this covers the server that stayed connected but lost the event
   * (a restart mid-frame, a dropped job write), which otherwise waited for the
   * next configure that may never come. A Walnut's first undelivered send ends
   * its replay this tick: with no client of it there is nowhere to replay to. The
   * other Walnuts' fires go on.
   */
  function replayPendingFires(now: number): void {
    const interval = triggerReplayMs()
    const unreached = new Set<string>()
    for (const entry of fireHolders()) {
      if (unreached.has(entry.home)) continue
      // Marks for acked (or trimmed) fires would otherwise pile up for the
      // daemon's life; pendingFires is the authority on what is still owed.
      if (entry.fireSentAt.size > entry.state.pendingFires.length) {
        const live = new Set(entry.state.pendingFires.map((f) => f.seq))
        for (const seq of [...entry.fireSentAt.keys()]) if (!live.has(seq)) entry.fireSentAt.delete(seq)
      }
      for (const fire of entry.state.pendingFires) {
        const sentAt = entry.fireSentAt.get(fire.seq)
        if (sentAt !== undefined && now - sentAt < interval) continue
        if (!sendTriggerFire(entry, fire, true)) { unreached.add(entry.home); break }
      }
    }
  }

  /**
   * Deliver, on this host, the fires no server claimed in time (trigger-claim-v1).
   * The fires of one trigger that are due go as ONE envelope, the same one the
   * server builds for a backlog, into the target task's live session (the offline
   * host's copy says which). No live session, a complete task, or a failed write:
   * the fire stays for the server and is tried here again after a minute.
   */
  function deliverUnclaimedFires(now: number): void {
    if (demoQuiesce.fenced) return
    const grace = hostDeliveryGraceMs()
    for (const entry of fireHolders()) {
      const spec = entry.def.deliver
      const id = entry.def.id
      const home = entry.home
      const key = triggerKey(home, id)
      if ((!spec && !entry.def.start) || hostDeliveriesInFlight.has(key)) continue
      const due = entry.state.pendingFires.filter((f) => fireDueOnHost(f, now, entry.armedAtMs, grace, HOST_DELIVERY_RETRY_MS))
      if (due.length === 0) continue
      if (!spec) { startUnclaimedRun(entry, due[0], now); continue }
      const epoch = entry.state.epoch
      // The same batch goes by the same id on every try, saved before the write (trigger-check-core.ts
      // hostBatch): a delivery a restart cut before its mark is written again under that id, and the
      // session's line record keeps one.
      const batch = hostBatch(due, id, epoch)
      const { seqs, messageId } = batch
      markHostBatch(entry.state, seqs, messageId)
      persistTriggerState(home, id, entry.state)
      const text = entry.def.clock
        ? buildScheduledMessage(entry.def.name, spec.prompt, { dueAtMs: Math.min(...batch.fires.map((f) => f.clock?.slotMs ?? f.atMs)), deliveredAtMs: now })
        : buildTriggerMessage({ name: entry.def.name }, batch.fires, spec.prompt, { deliveredAtMs: now })
      hostDeliveriesInFlight.set(key, new Set(seqs))
      // The host's own Walnut server picks the session while its leader is away; else this daemon's copy does.
      void followerTriggers.deliver({ home: spec.home, triggerId: id, taskId: spec.taskId, text, messageId }).then((r) => {
        // Recorded on whatever holds this trigger's state NOW: a configure may have
        // re-armed it, released it into the draining set, or disarmed it.
        const current = heldTrigger(home, id)
        const state = current ? current.state : readTriggerState(home, id, Date.now())
        if (state.epoch !== epoch) {
          logMsg('warn', 'trigger host delivery outcome dropped: state file started over', { id, seqs, delivered: r.ok })
          return
        }
        if (r.ok) {
          markHostDelivered(state, { atMs: now, sessionId: r.sid, messageId, seqs, ...(r.resumed ? { resumed: true as const } : {}) })
          logMsg('info', 'trigger delivered on host', { id, seqs, sessionId: r.sid, messageId, taskId: spec.taskId, resumed: r.resumed === true })
        } else {
          for (const fire of state.pendingFires) if (seqs.includes(fire.seq)) fire.hostTriedAt = now
          logMsg('info', 'trigger host delivery skipped', { id, seqs, taskId: spec.taskId, reason: r.reason })
        }
        persistTriggerState(home, id, state)
        // A server that is connected but slow records it now instead of a minute later.
        if (r.ok && current) {
          for (const fire of current.state.pendingFires) if (seqs.includes(fire.seq)) sendTriggerFire(current, fire, true)
        }
      }).catch((err) => {
        logMsg('error', 'trigger host delivery threw', { id, seqs, error: (err as Error).message })
      }).finally(() => {
        hostDeliveriesInFlight.delete(key)
      })
    }
  }

  /**
   * Start, on this host, the run of a claude-code routine no server claimed in time
   * (clock-host-start-v1, clock-host-start-core.ts): one fire at a time per routine, its
   * outcome recorded on whatever holds the trigger's state when the start ends, as a host
   * delivery is. A start that could not be made leaves the fire for the server and is
   * tried again after a minute; one held back because a server answers is not held back.
   */
  function startUnclaimedRun(entry: ArmedTrigger, fire: PendingFire, now: number): void {
    const id = entry.def.id
    const home = entry.home
    const key = triggerKey(home, id)
    const def = entry.def
    const start = def.start
    if (!start || demoQuiesce.fenced) return
    const epoch = entry.state.epoch
    const seqs = [fire.seq]
    hostDeliveriesInFlight.set(key, new Set(seqs))
    void clockHostStart.start({ id, name: def.name, start }, fire).then((r) => {
      const current = heldTrigger(home, id)
      const state = current ? current.state : readTriggerState(home, id, Date.now())
      if (state.epoch !== epoch) {
        logMsg('warn', 'routine run outcome dropped: state file started over', { id, seqs, started: r.ok })
        return
      }
      if (r.ok) {
        markHostDelivered(state, { atMs: Date.now(), sessionId: r.sid, messageId: r.messageId, seqs, started: true, taskId: r.taskId })
      } else if (!r.wait) {
        for (const f of state.pendingFires) if (seqs.includes(f.seq)) f.hostTriedAt = now
      } else {
        return
      }
      persistTriggerState(home, id, state)
      // A server that is connected but slow records it now instead of a minute later.
      if (r.ok && current) {
        for (const f of current.state.pendingFires) if (seqs.includes(f.seq)) sendTriggerFire(current, f, true)
      }
    }).catch((err) => {
      logMsg('error', 'routine run start threw', { id, seqs, error: (err as Error).message })
    }).finally(() => {
      hostDeliveriesInFlight.delete(key)
    })
  }

  /** Overlap is SKIPPED, never queued: a slow check must not build a backlog. */
  function tickTriggers(): void {
    // A stopping Demo starts no check, delivery or routine run, and replays nothing.
    if (demoQuiesce.fenced) return
    const now = Date.now()
    for (const entry of armedTriggers.values()) {
      if (entry.running || entry.nextRunAtMs > now) continue
      void runTrigger(entry).catch((err) => {
        logMsg('error', 'trigger run threw', { id: entry.def.id, error: (err as Error).message })
      })
    }
    deliverUnclaimedFires(now)
    replayPendingFires(now)
  }

  /** walnut-trigger clock (Main): a tick that starts a check while the daemon exits would outlive it, so stopTriggers ends it. */
  function startTriggers(): void {
    triggerTickTimer = setInterval(tickTriggers, TRIGGER_TICK_MS)
  }

  /** cleanup(): the clock, then the check runs still going. */
  function stopTriggers(): void {
    // Stop the trigger clock first: no new check may start while we are dying.
    if (triggerTickTimer) {
      try { clearInterval(triggerTickTimer) } catch {}
      triggerTickTimer = null
    }
    // Then end the check runs still going: a run outlives the daemon that started it otherwise, with a
    // token (WALNUT_CHECK_TOKEN) only this daemon knows, no deadline anyone enforces and an answer
    // nobody reads. 2026-11-23: after each restart the land link's relay check ran on for about three
    // minutes, and every host_exec_read it relayed reached the server as an unknown caller and got 403
    // session_only (about 500 a week). The successor starts each trigger's next run on its own clock.
    triggerChecksEnded = true
    try { demoTriggerChecks.abort() } catch {}
  }

  return {
    demoTriggerChecks, demoTriggerCheckPids, checkRunFence,
    newArmedTrigger, armClock, runClock, runTrigger,
    startTriggers, stopTriggers,
  }
}
