/**
 * A claude-code routine's run started on its host while the Mac is away
 * (clock-host-start-v1, docs/plan/walnut-trigger.md "Clock routines").
 *
 * The routine's clock is in this daemon already (clock-routine-v1). When a run
 * comes due and no server for its Walnut takes it within the grace a trigger fire
 * gets (HOST_DELIVERY_GRACE_MS), the daemon starts the run itself, from what the
 * Mac's own clock def says (`start`, trigger-clock-core.ts ClockStartSpec):
 *
 *   1. every check first: the Mac does not answer this Walnut, this daemon owns its
 *      dir, the Mac adopts routine runs (`routine-run` in its drains), the journal
 *      has room, and the routine template fills (host-start-core.ts planRoutine: the
 *      folder exists, the mode is one the Mac allowed, the model, the limits);
 *   2. the start kept on disk (holdPending), then the CLI from the Mac's routine
 *      spawn template;
 *   3. the run's `task-create` (actor: the routine) and its `session` record;
 *   4. the fire marked as delivered here (`host` with `started`), so the Mac, when it
 *      takes the fire, records the run and never starts it again.
 *
 * The CLI goes before the records so a start that fails leaves nothing behind (no
 * task without its session); a daemon that dies between them journals both at its
 * next boot from the kept start (the twins' recoverPendingAsks), as a host ask does.
 *
 * One run per slot, whatever crashes or retries: the session id, the task id and
 * both op ids are derived from (home, routine id, slot), so a second attempt for a
 * slot (a restart, a replay, a second fire of the same slot) finds the first one's
 * session and only marks the fire, and a journal record written twice is one record
 * (byOpId while pending, the Mac's ledger and created_by_op after). A server that
 * claims a fire whose mark a daemon death cut gets the run back (`startedRun`, in the
 * twins' triggers.claim), never the fire to start again.
 *
 * A start that cannot be made leaves the run owed for the Mac, as before, and is
 * tried again after HOST_DELIVERY_RETRY_MS; each reason is logged once per run.
 *
 * How the twins get it: daemon-standalone.ts imports createClockHostStart;
 * daemon-source.ts inlines `createClockHostStart.toString()` through
 * `__CREATE_CLOCK_HOST_START__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

import type { ClockStartSpec } from './trigger-clock-core.js'
import type { HostStart, HostStartPlan, PendingTask } from './host-start-core.js'

type GatewayAnswer = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string; retryAfterMs?: number; detail?: unknown } }

/** Every id of one routine run, derived from (home, routine id, slot). */
export interface RoutineRunIds {
  /** A v4-shaped session id (the CLI's --session-id). */
  sid: string
  /** The task the run is filed under (the shape of a Walnut task id: base-36 time, dash, hex). */
  taskId: string
  taskOpId: string
  sessionOpId: string
  /** The first message's queue id (the turn-start marker). */
  messageId: string
}

export interface ClockHostStartDeps {
  hostStart: Pick<HostStart, 'planRoutine' | 'begin' | 'holdPending' | 'releasePending'>
  offline: {
    checkRoutineRun(home: string, sid: string): GatewayAnswer
    noteRoutineTask(home: string, rec: PendingTask['record'], opId: string, jobId: string): GatewayAnswer | Promise<GatewayAnswer>
    noteSession(home: string, rec: HostStartPlan['record'], opId: string): GatewayAnswer | Promise<GatewayAnswer>
    /** Whether this Walnut's copy, or a session record journaled here, names the session. */
    knowsSession(home: string, sid: string): boolean
  }
  /** A server of that Walnut answers this host now: it takes the run itself. */
  primaryAnswers(home: string): boolean
  ownsDir(): boolean
  /** A CLI for that session runs here, or did (its transcript is here). */
  ran(sid: string): boolean
  /** Start the CLI from the plan (the twin's own start path; the spawn journal names `home`). */
  spawn(home: string, taskId: string, plan: HostStartPlan): Promise<unknown>
  /** Stop a CLI whose records could not be kept: nothing would tell the Mac about it. */
  stop(sid: string): void
  /** The turn start in the stream (the CLI never echoes its stdin). */
  marker(sid: string, text: string, messageId: string): void
  /** Where the run's task id goes in the Mac's context (trigger-clock-core.ts START_TASK_TOKEN). */
  taskToken(): string
  sha256(text: string): string
  now(): number
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
  /** Tests only: the twin dies here, between the CLI and the records. */
  afterSpawn?(): void
}

/**
 * `ok`: the run's session runs here (`again`: an earlier attempt started it). Not ok:
 * the run stays owed for the server; `wait` means nothing was tried (a server answers
 * this Walnut and will take the run), so the twin does not hold the next try back.
 */
export type ClockStartOutcome =
  | { ok: true; sid: string; taskId: string; messageId: string; again?: true }
  | { ok: false; code: string; reason: string; wait?: true }

export interface ClockHostStart {
  idsOf(home: string, jobId: string, slotMs: number): RoutineRunIds
  /** The `task-create` record of a run: the fields the claude-code executor files a run's task with. */
  taskRecordOf(spec: ClockStartSpec, ids: RoutineRunIds): PendingTask['record']
  /** Start the run of this fire on this host. Never throws. */
  start(def: { id: string; name: string; start: ClockStartSpec }, fire: { seq: number; atMs: number; clock?: { slotMs: number } }): Promise<ClockStartOutcome>
  /**
   * The run of this fire when this host started it already (its session record is
   * here): a server's claim of a fire whose mark a daemon death cut is answered with
   * the run, never handed to the server to start again.
   */
  startedRun(def: { id: string; start: ClockStartSpec }, fire: { atMs: number; clock?: { slotMs: number } }): RoutineRunIds | null
}

export function createClockHostStart(deps: ClockHostStartDeps): ClockHostStart {
  /** The last reason a run was not started, by run: each is logged once. */
  const told = new Map<string, string>()
  const TOLD_MAX = 500

  function idsOf(home: string, jobId: string, slotMs: number): RoutineRunIds {
    const h = deps.sha256('walnut-routine-run\u0000' + home + '\u0000' + jobId + '\u0000' + String(Math.floor(slotMs)))
    const variant = '89ab'.charAt(parseInt(h.charAt(16), 16) & 3)
    return {
      sid: h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-' + variant + h.slice(17, 20) + '-' + h.slice(20, 32),
      taskId: Math.max(0, Math.floor(slotMs)).toString(36) + '-' + h.slice(32, 40),
      taskOpId: 'routine-' + h.slice(40, 56),
      sessionOpId: 'routine-' + h.slice(40, 56) + '-session',
      messageId: 'qm-routine-' + h.slice(48, 64),
    }
  }

  function taskRecordOf(spec: ClockStartSpec, ids: RoutineRunIds): PendingTask['record'] {
    // As the executor files a run (quickStartSession): its title, its project, and
    // never pinned (a daily routine would otherwise add a card a day).
    return { kind: 'task-create', taskId: ids.taskId, fields: { title: spec.title, pinned: false }, placement: { project: spec.project } }
  }

  function refuse(key: string, data: Record<string, unknown>, code: string, reason: string): ClockStartOutcome {
    if (told.get(key) !== code) {
      if (told.size >= TOLD_MAX) { const first = told.keys().next(); if (!first.done) told.delete(first.value) }
      told.set(key, code)
      deps.log('info', 'routine run not started on this host: it waits for the Mac', { ...data, code, reason })
    }
    return { ok: false, code, reason }
  }

  function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  async function start(def: { id: string; name: string; start: ClockStartSpec }, fire: { seq: number; atMs: number; clock?: { slotMs: number } }): Promise<ClockStartOutcome> {
    const spec = def.start
    const home = spec.home
    const slotMs = fire.clock ? fire.clock.slotMs : fire.atMs
    const key = def.id + '|' + String(slotMs)
    const data = { id: def.id, seq: fire.seq, slotMs, home }
    try {
      // The Mac takes its own runs while it answers (it claims each fire it receives).
      if (deps.primaryAnswers(home)) return { ok: false, code: 'leader_answers', reason: 'a server of this Walnut answers this host', wait: true }
      const ids = idsOf(home, def.id, slotMs)
      // Started already (a restart, a replay, a second fire of this slot): never a second CLI.
      if (deps.offline.knowsSession(home, ids.sid)) {
        told.delete(key)
        deps.log('info', 'routine run started here already: the fire is marked', { ...data, sid: ids.sid, taskId: ids.taskId })
        return { ok: true, sid: ids.sid, taskId: ids.taskId, messageId: ids.messageId, again: true }
      }
      // A CLI ran for this run and no record names it (its records were refused, and it was
      // stopped): its session id is spent, so the run is the Mac's.
      if (deps.ran(ids.sid)) return refuse(key, data, 'start_failed', 'a session for this run started here and its record was not kept')
      if (!deps.ownsDir()) return refuse(key, data, 'journal_unwritable', 'this daemon no longer owns its directory')
      const room = deps.offline.checkRoutineRun(home, ids.sid)
      if (!room.ok) return refuse(key, data, room.error.code, room.error.message)
      const planned = deps.hostStart.planRoutine(home, {
        sid: ids.sid, taskId: ids.taskId, title: spec.title, cwd: spec.cwd, mode: spec.mode,
        ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}),
        ...(spec.context ? { context: spec.context, taskToken: deps.taskToken() } : {}),
        firstMessage: spec.message, routine: { id: def.id, slotMs },
      }, spec.host)
      if (!planned.ok) return refuse(key, data, planned.code, planned.message)
      const p = planned.plan
      const task = taskRecordOf(spec, ids)
      const release = deps.hostStart.begin(home)
      try {
        // On disk before the CLI runs: a daemon that dies before the records below are
        // kept journals them at its next boot (recoverPendingAsks), so the Mac adopts the run.
        try {
          deps.hostStart.holdPending(home, { sid: ids.sid, record: p.record, opId: ids.sessionOpId, task: { record: task, opId: ids.taskOpId, jobId: def.id } })
        } catch (err) {
          return refuse(key, data, 'journal_unwritable', 'this host could not keep the start: ' + messageOf(err))
        }
        try {
          await deps.spawn(home, ids.taskId, p)
        } catch (err) {
          deps.hostStart.releasePending(home, ids.sid)
          return refuse(key, data, 'spawn_failed', 'the session did not start: ' + messageOf(err))
        }
        if (deps.afterSpawn) deps.afterSpawn()
        const madeTask = await deps.offline.noteRoutineTask(home, task, ids.taskOpId, def.id)
        const saved = madeTask.ok ? await deps.offline.noteSession(home, p.record, ids.sessionOpId) : madeTask
        deps.hostStart.releasePending(home, ids.sid)
        if (!saved.ok) {
          // Nothing would tell the Mac about this CLI: it must not run unseen.
          deps.stop(ids.sid)
          deps.log('warn', 'routine run: its records were not kept, the CLI is stopped', { ...data, sid: ids.sid, code: saved.error.code, taskKept: madeTask.ok })
          return refuse(key, data, saved.error.code, 'the run was not journaled: ' + saved.error.message)
        }
        try { deps.marker(ids.sid, p.message, ids.messageId) } catch (err) {
          deps.log('warn', 'routine run: no turn-start marker', { sid: ids.sid, error: messageOf(err) })
        }
        told.delete(key)
        deps.log('info', 'routine run started on this host while the Mac is away', { ...data, sid: ids.sid, taskId: ids.taskId, mode: p.mode, cwd: p.cwd })
        return { ok: true, sid: ids.sid, taskId: ids.taskId, messageId: ids.messageId }
      } finally {
        release()
      }
    } catch (err) {
      return refuse(key, data, 'internal', messageOf(err))
    }
  }

  function startedRun(def: { id: string; start: ClockStartSpec }, fire: { atMs: number; clock?: { slotMs: number } }): RoutineRunIds | null {
    try {
      const ids = idsOf(def.start.home, def.id, fire.clock ? fire.clock.slotMs : fire.atMs)
      return deps.offline.knowsSession(def.start.home, ids.sid) ? ids : null
    } catch {
      return null
    }
  }

  return { idsOf, taskRecordOf, start, startedRun }
}
