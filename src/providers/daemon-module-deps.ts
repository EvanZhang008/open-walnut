/**
 * The few things every area module of the session daemon's runtime takes from it
 * (createDaemonRuntime in daemon-standalone.ts): how a command is answered and how it logs.
 *
 * An area module (daemon-git.ts, daemon-skills.ts, ...) is `create<Area>(deps)`: code moved
 * out of the runtime's body as it was. Its deps name only what the area uses, each under the
 * runtime's own name (`HOME_DIR`, `daemonEnv`, `logMsg`), so the moved code reads the same and
 * the runtime passes them by name; these types keep the common part one shape. `W` is the
 * runtime's socket type (a Bun ServerWebSocket with the runtime's own data); a module never
 * looks inside it, it only hands it back to the runtime's functions.
 *
 * A command that answers once is a function of the command that returns its Answer (AnswerFn):
 * the runtime keeps one table of them by name (daemon-standalone.ts `commandAnswers`). A socket's
 * command gets the Answer as its reply frame (sendOk / sendError); a client in the same process
 * gets it from the call itself, with no frame between (DaemonClient.call).
 */

import type * as TriggerCheck from './trigger-check-core.js'
import type * as TriggerEnvelope from './trigger-envelope-core.js'
import type * as TriggerClock from './trigger-clock-core.js'
import type * as ClockSchedule from './clock-schedule-core.js'
import type * as TriggerStateSnapshot from './trigger-state-snapshot-core.js'
import type * as TriggerStateSeed from './trigger-state-seed-core.js'

/**
 * The trigger logic the runtime's trigger area (daemon-trigger-store/runs/set/commands.ts) runs on:
 * a check's input, run and verdict, a trigger's state, the claim, ack and host delivery of fires,
 * their envelope, a clock's schedule, a pushed set's validation, a trigger's memory moved between
 * daemons. Task logic (tests/providers/daemon-task-logic-ratchet.test.ts), so an area module
 * never loads it: it takes it as its `judge` dep, which the runtime fills from the trigger code
 * (trigger-check-core.ts and friends).
 */
export type HostTriggerJudge =
  Pick<typeof TriggerCheck,
    | 'buildCheckStdin' | 'runCheckProcess' | 'parseCheckStdout' | 'checkErrorOf' | 'decideCheck' | 'applyCheckOutcome'
    | 'applyCheckError' | 'applyMachineFault' | 'checkIdleOf' | 'newItemsOf' | 'checkCallerEnv' | 'testCheckCaller'
    | 'clampTimeoutSeconds' | 'CHECK_ERROR_BACKOFF_MS' | 'MAX_CONSECUTIVE_CHECK_ERRORS' | 'MIN_EVERY_MS'
    | 'emptyHostState' | 'coerceHostState' | 'triggerStateFileName' | 'TRIGGER_STATE_TTL_MS'
    | 'claimFires' | 'ackFire' | 'fireDueOnHost' | 'hostBatch' | 'markHostBatch' | 'markHostDelivered'
    | 'HOST_DELIVERY_GRACE_MS' | 'HOST_DELIVERY_RETRY_MS' | 'PENDING_FIRE_REPLAY_MS' | 'applyClockFire'
    | 'validateTriggerDef' | 'validateTriggerSet' | 'applyTriggersDelta' | 'triggersSetHash'>
  & Pick<typeof TriggerEnvelope, 'buildTriggerMessage' | 'buildScheduledMessage'>
  & Pick<typeof TriggerClock, 'clockStateOnArm' | 'clockDueMs' | 'clockFireOwed' | 'dropStaleClockFires'>
  & Pick<typeof ClockSchedule, 'createClockSchedule'>
  & Pick<typeof TriggerStateSnapshot, 'takeTriggerStateSnapshot'>
  & Pick<typeof TriggerStateSeed, 'seedTriggerState'>

/** The runtime's answer to one command: `sendOk` / `sendError` (daemon-standalone.ts, "Protocol helpers"). */
export interface DaemonReplies<W> {
  sendOk: (ws: W, id: number | null, data: Record<string, unknown>) => void
  /** `level`: an expected refusal is logged below error. */
  sendError: (ws: W, id: number | null, error: string, data?: Record<string, unknown>, level?: 'error' | 'warn' | 'info') => void
}

/** The runtime's push of one event to one socket (sendEvent, "Protocol helpers"). */
export type DaemonSendEvent<W> = (ws: W, ev: string, data: Record<string, unknown>) => void

/** The runtime's log (logMsg): one JSON line in the daemon's log; debug lines only on opt-in. */
export type DaemonLog = (level: string, msg: string, data?: Record<string, unknown>) => void

/** The runtime's env (`options.env`): what its modules read where a program would read process.env. */
export type DaemonEnv = Record<string, string | undefined>

/** A command handler that answers on its socket itself (a session command: it streams or subscribes). */
export type DaemonCommand<W> = (ws: W, id: number, cmd: Record<string, unknown>) => unknown

/**
 * One command's answer: what sendOk (`ok: true`, the data's fields) or sendError (`ok: false`,
 * `error`, the data's fields) put in its reply. `level`: an expected refusal is logged below error.
 */
export type Answer =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; data?: Record<string, unknown>; level?: 'error' | 'warn' | 'info' }

/** The command answered: its reply carries `data`'s fields (an `ok: false` among them keeps it, as sendOk does). */
export function ok(data: Record<string, unknown>): Answer {
  return { ok: true, data }
}

/** The command refused or failed with `error` (sendError's arguments). */
export function fail(error: string, data?: Record<string, unknown>, level?: 'error' | 'warn' | 'info'): Answer {
  return { ok: false, error, ...(data ? { data } : {}), ...(level ? { level } : {}) }
}

/**
 * A command that answers once, nothing pushed after. `from` is the socket that asks, read only
 * to know who asks (the Walnut it speaks for); an answer function never sends on it.
 */
export type AnswerFn<W> = (cmd: Record<string, unknown>, from: W) => Answer | Promise<Answer>

/** An area's answer functions by command name. */
export type Answers<W> = Record<string, AnswerFn<W>>

/**
 * Run `make` and hand its Answer to `then`: at once when it answered at once, else when its
 * promise settles. A throw or a rejection becomes `threw(err)`, so `then` runs exactly once.
 */
export function settleAnswer<R>(make: () => Answer | Promise<Answer>, threw: (err: unknown) => Answer, then: (answer: Answer) => R): R | Promise<R> {
  let out: Answer | Promise<Answer>
  try { out = make() } catch (err) { return then(threw(err)) }
  if (out && typeof (out as Promise<Answer>).then === 'function') return (out as Promise<Answer>).then(then, (err: unknown) => then(threw(err)))
  return then(out as Answer)
}

/** Expand a leading `~` against the host's HOME, as every path-taking command does. */
export function expandHome(p: string, homeDir: string): string {
  return (p === '~' || p.startsWith('~/')) ? homeDir + p.slice(1) : p
}
