/**
 * `host_exec`: a task's session runs one command on ANOTHER host Walnut knows,
 * through the link (link.ts), and gets its exit code and output back (the user,
 * 2026-10-31: "use another host's capability ... a terminal"). The way across
 * is the link's business; the run itself is the host's daemon's
 * (src/providers/host-exec-core.ts). This file is the gate, all server-side:
 *
 *   - only a task's session asks (the user runs commands in their own terminal);
 *   - never on the caller's own host (that is its own Bash tool);
 *   - only under the user's grant for this task on this host (exec-grants.ts),
 *     asked for once by letter, kept until revoked; looked at again right before the run is
 *     sent, so a revoke or the host's hard stop during the wait for a slot or the dial starts
 *     nothing; a call naming its grant (`grant_id`) runs under that grant only, and never makes
 *     a grant or asks the user;
 *   - at most 4 runs at once per task and 8 per host; a call at a cap waits a little for a
 *     slot (takeSlot) before it is refused, so a burst from parallel agents runs, queued;
 *   - a foreground run ends by 10 minutes (the host kills its process group), a
 *     background one by 2 hours; only the tail of the output comes back (256 KB),
 *     the whole log stays in the task's directory on that host;
 *   - a line of output that looks like a credential is replaced before it leaves
 *     this server (the git-sync scanner), which stops an accident, not a reader;
 *   - a command that would make sound there (speech, a player, a volume change or an
 *     unmute) never runs (sound-guard.ts, the same rule as every session's Bash hook);
 *   - on a Mac, a command that can show a password dialog on its screen (`security`
 *     on a keychain, host-exec-prompts.ts) runs only with `allow_prompts`;
 *   - a found ~/.ssh/config row of a machine that joined the host network is that
 *     machine (joined-twins.ts): the work goes to its joined row, and the answer
 *     says so (2026-11-03: host_exec on the found row of a joined Mac answered
 *     "Could not connect", the joined row worked).
 *
 * The line runs in bash after the login shell set up the environment, with
 * WALNUT_TASK_DIR set: the host's daemon does it (host-exec-v2), and for an older
 * daemon this server shapes the run so it does the same (host-exec-legacy.ts).
 *
 * Every run is logged here and in the host's own audit file, and counted on its grant.
 */
import { randomUUID } from 'node:crypto'
import { log } from '../../logging/index.js'
import { ambientAnswerBy } from '../../lib/answer-by.js'
import { JOB_ID_RE, shellQuote } from '../../providers/host-exec-core.js'
import type { RunShape } from './host-exec-legacy.js'
import { redact } from './host-exec-redact.js'
import { soundGuardOn, soundRisk } from '../../providers/sound-guard.js'
import { INPUT_PREFIX, refusalAdvice } from '../../providers/sound-rules.js'

export { redact }
import { GRANT_ID_RE, assertStillGranted, grantFor, isOwnHost, pinnedGrant } from './host-exec-grant.js'
import { HostExecError, callerOf, hostName, normHost, targetHost, type Caller } from './host-exec-target.js'

// Who asks and where it goes (host-exec-target.ts), for every host_exec-family call.
export { HostExecError, callerOf, hostName, sameMachineAs, sameMachineNote, targetHost, type Caller } from './host-exec-target.js'

// The user's grant for a task on a host (host-exec-grant.ts), for host_mcp and host_http too.
export { assertStillGranted, grantFor, isOwnHost }

export const MAX_RUNNING_PER_TASK = 4
export const MAX_RUNNING_PER_HOST = 8
/** The longest a call waits at a cap for a slot (less for a relayed call, budgetLeft). */
const SLOT_WAIT_MAX_MS = 20_000
/** While it waits: a look at the count this often, and at the hosts' own lists this often. */
const SLOT_POLL_MS = 1_000
const SLOT_REFRESH_MS = 2_000
/** A link quiet this long (the ping loop hears every 15 s) is asked whether it answers, QUIET_PROBE_MS or its round trip's need, before work goes on it. */
const QUIET_LINK_MS = 20_000
const QUIET_PROBE_MS = 3_000
const DIAL_MS = 15_000
export const REPLY_MARGIN_MS = 30_000
export const LIST_MS = 5_000
const KILL_GRACE_MS = 3_000
/**
 * The longest a call from a session on another host holds its answer, from the start of the
 * call here, when its deadline is not known (its gateway gives up at 20 s).
 */
export const RELAYED_HOLD_MS = 12_000
/**
 * What a hold leaves before the caller's deadline (src/lib/answer-by.ts) for the answer to get
 * back: the route, the op executor's loopback, the relay frame, the tunnel, the host's gateway.
 * 2026-11-03, load ~150 on the Mac: the way in and back together took about 6 s.
 */
export const ANSWER_RETURN_MS = 8_000
const FOREGROUND_MAX_MS = 10 * 60_000
const BACKGROUND_MAX_MS = 2 * 60 * 60_000
const LOCAL = '__local__'
/**
 * The host stops what a run's shell left running in its process group when the server asks
 * (exec.run `endGroup`, src/providers/host-exec-group.ts): this server asks on every run, so the
 * help is true for it, and a daemon that updates under an older server keeps what that one says.
 */
export const GROUP_CAPABILITY = 'host-exec-group-v1'

export interface ExecParams {
  host: string
  command?: string
  argv?: string[]
  cwd?: string
  timeout_ms?: number
  background?: boolean
  /**
   * The user agreed that this command may show a dialog on that host's screen: a password one
   * (host-exec-prompts.ts) or a macOS permission one (host-exec-guards.ts permissionRisk).
   */
  allow_prompts?: boolean
  /** Stop at the first failing command, pipes included, and name it in the answer (host-exec-strict.ts). */
  strict?: boolean
  /**
   * The run's id, chosen by the caller before the call leaves (the walnut CLI does): an answer
   * lost on the way back (2026-11-03: `hub_timeout` from a loaded Mac, the run started there)
   * still leaves an id to read. The same id again answers that run, never a second one.
   */
  job_id?: string
  /**
   * Run only under this grant (an id host_exec_list names, or GET /api/v1/host-exec/grants): no other grant counts,
   * none is made (not even a task on the user's own host gets one), and no letter asks the user.
   * The grant must be this task's on this host and live, and the host open, at the start and
   * again right before the run is sent; otherwise nothing runs (host-exec-grant.ts pinnedGrant).
   */
  grant_id?: string
  /** Return as soon as the output matches, a port listens or a file exists there (host-exec-wait.ts). */
  wait_for?: unknown
  /** How long the call waits for wait_for (default: a foreground run's deadline; 2 minutes with background); timeout_ms stays the run's deadline. */
  wait_ms?: number
}

/**
 * In flight, by job: who runs it and until when it may run (a background job that is never read
 * again ends by itself). `pending`: a slot taken for a run not sent to the host yet.
 */
const running = new Map<string, { taskId: string; host: string; until: number; at: number; pending?: boolean }>()
/** Calls waiting at a cap, woken when a slot frees. */
const slotWaiters = new Set<() => void>()

/** A run's slot is free again: the calls waiting at a cap look once more. */
function release(jobId: string): void {
  if (running.delete(jobId)) for (const wake of [...slotWaiters]) wake()
}

function slotFreed(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); slotWaiters.delete(done); resolve() }
    const timer = setTimeout(done, Math.max(1, ms))
    slotWaiters.add(done)
  })
}
/** A job the host has not confirmed (`at` set, not 0) may not have reached it yet: a refresh drops it only after this long. */
const REFRESH_GRACE_MS = 10_000

function countRunning(pred: (r: { taskId: string; host: string }) => boolean): number {
  const t = Date.now()
  let n = 0
  for (const [id, r] of running) {
    if (r.until < t) { release(id); continue }
    if (pred(r)) n++
  }
  return n
}

/** The link to `host`, by `within` ms, with the daemon capability the call needs. */
export async function dial(host: string, within = DIAL_MS, capability = 'host-exec-v1', what = 'run commands') {
  const { link } = await import('./link.js')
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const conn = await Promise.race([
      link(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), Math.max(1, Math.min(within, DIAL_MS))) }),
    ])
    if (!conn.hasCapability(capability)) {
      throw new HostExecError(`The Walnut daemon on ${await hostName(host)} needs an update before it can ${what} for other hosts (it updates on its next connect).`, 409, 'daemon_upgrade')
    }
    // A link that has said nothing for a while is asked first: it may have died where this side
    // cannot see it (this machine slept, its network changed), and work sent on it would be lost
    // (2026-11-04: a pinned run sent 11 s after the Mac woke went into a link that never answered
    // again). The check stays inside the dial's time: one that does not answer by then is silent.
    // Never this machine's own daemon: a loopback socket survives a sleep, and a starved daemon's
    // late pong is no dead link (work sent there waits in its socket, it is not lost).
    if (normHost(host) !== LOCAL) {
      const left = Math.max(250, Math.min(within, DIAL_MS) - (Date.now() - t0))
      // As long as this link's round trip needs (review 4: a healthy link with a 3.4 s round trip
      // was refused at 3 s, its pong 0.4 s later), within the dial's time.
      const needs = Math.max(QUIET_PROBE_MS, conn.probeDeadlineMs?.(QUIET_PROBE_MS) ?? QUIET_PROBE_MS)
      const quiet = await quietCheck(conn, Math.min(left, needs))
      if (quiet !== null) throw new HostExecError(quietRefusal(await hostName(host), quiet), 503, 'host_offline', { quietLink: quiet })
    }
    return conn
  } catch (err) {
    if (err instanceof HostExecError) throw err
    throw new HostExecError(`Walnut cannot reach ${await hostName(host)} right now (${err instanceof Error ? err.message : String(err)}).`, 503, 'host_offline')
  } finally {
    clearTimeout(timer)
  }
}

type QuietVerdict = 'heard' | 'alive' | 'dropped' | 'silent' | 'down'

/**
 * A quiet link's check, answered within `ms` on the probe's own clock (recheckQuiet `withinMs`: judged
 * after this loop read what came in, one more round when its timer fired late). No second timer
 * here: one fired after a held loop called a link silent while its pong was already in (review 3).
 * Null when it may carry work.
 */
async function quietCheck(conn: { recheckQuiet?: (o: { quietMs: number; deadlineMs: number; withinMs?: number }) => Promise<QuietVerdict> }, ms: number): Promise<'dropped' | 'silent' | 'down' | null> {
  if (!conn.recheckQuiet) return null
  const v = await conn.recheckQuiet({ quietMs: QUIET_LINK_MS, deadlineMs: ms, withinMs: ms })
  return v === 'heard' || v === 'alive' ? null : v
}

/** Said of this call only: what an earlier call started there runs on (a retry of a job is no new run). */
function quietRefusal(name: string, v: 'dropped' | 'silent' | 'down'): string {
  const kept = 'what an earlier call started there keeps running'
  if (v === 'down') return `Walnut cannot reach ${name} right now: its link went down just now, so this call sent nothing there (${kept}). Walnut reconnects by itself: call again in a moment.`
  if (v === 'dropped') return `Walnut cannot reach ${name} right now: its link had been quiet and did not answer a check, so Walnut closed it and this call sent nothing there (${kept}). Walnut is reconnecting to it: call again in a moment.`
  return `Walnut cannot reach ${name} right now: its link had been quiet and did not answer a check just now, so this call sent nothing there (${kept}). Call again in a moment.`
}

/** What a failed step names that looks like a credential (its command, line, the `return` it ran), hidden like the output's lines. */
const HIDDEN_STEP = '[hidden by Walnut: it looks like a credential]'
async function hideStepSecrets<T extends { command: string; text?: string; returned?: string }>(step: T): Promise<T> {
  const out = { ...step }
  for (const k of ['command', 'text', 'returned'] as const) {
    const v = out[k]
    if (typeof v === 'string' && v && (await redact(v)).redacted) out[k] = HIDDEN_STEP
  }
  return out
}

/** The host's refusal as an answer: its words, and a status by its code. */
const DAEMON_STATUS: Record<string, number> = { cwd_missing: 400, bad_request: 400, unknown_job: 404, task_dir_unset: 409, may_prompt: 409, job_exists: 409, busy: 429 }

export function daemonError(reply: Record<string, unknown>, fallback: string): HostExecError {
  const code = typeof reply.code === 'string' ? reply.code : 'host_failed'
  const msg = typeof reply.error === 'string' ? reply.error.replace(/^exec\.\w+ failed: /, '') : fallback
  return new HostExecError(msg, Object.hasOwn(DAEMON_STATUS, code) ? DAEMON_STATUS[code] : 502, code)
}

/** A failed or timed-out send to the host: the host is away, never a server error. */
export async function ask(conn: Awaited<ReturnType<typeof dial>>, host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  try {
    return await conn.send(cmd, params, timeoutMs) as Record<string, unknown>
  } catch (err) {
    throw new HostExecError(`Walnut lost ${await hostName(host)} while it answered (${err instanceof Error ? err.message : String(err)}).`, 503, 'host_offline')
  }
}

/**
 * Every read of a job's output on the server goes through here (ratchet:
 * tests/core/hosts/grant-recheck-ratchet.test.ts): the task's grant is read right before the read
 * is sent and again when its answer comes back, so nothing a job printed after a revoke is shown.
 */
export async function readJob(conn: Awaited<ReturnType<typeof dial>>, host: string, taskId: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const { assertMayRead, readStopWatch } = await import('./host-exec-grant.js')
  await assertMayRead(taskId, host, params.jobId)
  // A revoke while the host holds the read ends the call then; the host's answer, when it comes, is dropped.
  const watch = await readStopWatch(taskId, host, params.jobId)
  try {
    const reply = await Promise.race([ask(conn, host, 'exec.read', params, timeoutMs), watch.stopped])
    await assertMayRead(taskId, host, params.jobId)
    return reply
  } finally {
    watch.off()
  }
}

/** How long one call may hold its answer: a session on another host reaches us through its gateway, which gives up at 20 s. */
function holdBudget(caller: Caller, wanted: number, since: number): number {
  return Math.max(0, Math.min(wanted, budgetLeft(caller, since)))
}

/**
 * What is left of a call's answer time. A call relayed by a host's gateway carries its deadline (the
 * relay sets it, src/lib/answer-by.ts): to it less the way back, and for a session on another host
 * at most RELAYED_HOLD_MS from `since`, since the way in is not counted. A call with no deadline
 * reached this server on its own (the CLI over HTTP, the browser) and waits as long as it asks,
 * whichever host its session runs on (2026-11-05 review: a session that called the server
 * directly from the server's own machine was held 10 s a read, as if a gateway stood between).
 */
export function budgetLeft(caller: Caller, since: number): number {
  const now = Date.now()
  const by = ambientAnswerBy()
  if (by === undefined) return Number.POSITIVE_INFINITY
  const relayed = caller.host === LOCAL ? Number.POSITIVE_INFINITY : RELAYED_HOLD_MS - (now - since)
  return Math.min(relayed, by - ANSWER_RETURN_MS - now)
}

/** Below this much time left, a relayed call starts nothing: its answer could not get back. */
const START_MIN_LEFT_MS = 4_000

export const HOST_WAIT_MAX_MS = 60_000 // the host holds one read at most this long

/** At a cap, ask the hosts which of our jobs still run: a background job nobody read again may have ended. */
async function refreshRunning(pred: (r: { taskId: string; host: string }) => boolean, within: number): Promise<void> {
  if (within < 2_000) return
  const hosts = new Set([...running.values()].filter(pred).map((r) => r.host))
  const asked = Date.now()
  await Promise.all([...hosts].map(async (h) => {
    try {
      const conn = await dial(h, within / 2)
      const reply = await conn.send('exec.list', {}, Math.max(1, Math.min(LIST_MS, within - (Date.now() - asked)))) as { ok?: boolean; jobs?: Array<{ jobId: string; running: boolean }> }
      if (!reply.ok || !Array.isArray(reply.jobs)) return
      const live = new Set(reply.jobs.filter((j) => j.running).map((j) => j.jobId))
      for (const [id, r] of running) if (r.host === h && !r.pending && !live.has(id) && r.at < asked - REFRESH_GRACE_MS) release(id)
    } catch { /* the host away: its count stands until the jobs' own deadlines */ }
  }))
}

/**
 * A slot for `jobId` under both caps, taken in the same step as the count (2026-11-04: the count
 * and the slot were apart by a dial, so 16 calls at once all passed a cap of 2). At a cap the call
 * waits for a slot, at most SLOT_WAIT_MAX_MS and half of what its answer time leaves, asking the
 * hosts now and then which runs still go (a background job nobody read again may have ended).
 */
async function takeSlot(caller: Caller, host: string, jobId: string, since: number, recheck: () => Promise<unknown>): Promise<number> {
  const t0 = Date.now()
  const mine = (r: { taskId: string }) => r.taskId === caller.taskId
  const theirs = (r: { host: string }) => r.host === host
  // A refresh may use at most half of what is left, so the run itself still fits.
  const share = () => Math.min(DIAL_MS + LIST_MS, (budgetLeft(caller, since) - START_MIN_LEFT_MS) / 2)
  const waitUntil = Date.now() + Math.max(0, Math.min(SLOT_WAIT_MAX_MS, (budgetLeft(caller, since) - START_MIN_LEFT_MS) / 2))
  let refreshAt = 0
  for (;;) {
    // A revoke or the host's hard stop while it waits answers as that at once (403), never as a
    // full host after the whole wait, and asks the host nothing more.
    await recheck()
    const taskFull = countRunning(mine) >= MAX_RUNNING_PER_TASK
    if (!taskFull && countRunning(theirs) < MAX_RUNNING_PER_HOST) {
      running.set(jobId, { taskId: caller.taskId, host, until: Date.now() + DIAL_MS + 2 * REPLY_MARGIN_MS, at: Date.now(), pending: true })
      return Date.now() - t0
    }
    if (Date.now() >= refreshAt) {
      refreshAt = Date.now() + SLOT_REFRESH_MS
      await refreshRunning(taskFull ? mine : theirs, share())
      continue
    }
    const left = waitUntil - Date.now()
    if (left <= 0) {
      const waited = `waited ${Math.round((Date.now() - since) / 1000)} s for one to end`
      // The caps count host_exec runs, wherever they run (2026-11-05 review: "on other hosts" for four runs on __local__).
      if (taskFull) {
        // Named, so the caller knows which to read or stop (2026-11-05 review).
        const jobs = [...running].filter(([id, r]) => mine(r) && id !== jobId && !r.pending).map(([id, r]) => ({ jobId: id, host: r.host }))
        const named = jobs.length ? `: ${jobs.map((j) => `${j.jobId} on ${j.host}`).join(', ')}` : ''
        throw new HostExecError(`This task already runs ${MAX_RUNNING_PER_TASK} host_exec commands, the most it may run at once on all hosts together (${waited})${named}; wait for one (host_exec_read) or stop one (host_exec_stop).`, 429, 'busy', jobs.length ? { running: jobs } : {})
      }
      throw new HostExecError(`${await hostName(host)} already runs ${MAX_RUNNING_PER_HOST} host_exec commands, the most it runs at once for all tasks (${waited}); try again in a moment.`, 429, 'busy')
    }
    await slotFreed(Math.min(left, SLOT_POLL_MS, Math.max(1, refreshAt - Date.now())))
  }
}

/**
 * The answer an agent reads: the run's state and its output, credential-looking lines hidden.
 * `truncated` says output BEFORE this answer's is missing: a tail that starts past the log's
 * start. A read from an offset the reader chose has everything from there (2026-11-03: a read at
 * the log's very end said truncated and sent the reader back to offset 0); `more` says output
 * AFTER it is waiting (read again from nextOffset). `blocked` is a run the host stopped at a dialog.
 */
export async function jobAnswer(host: string, jobId: string, reply: Record<string, unknown>, opts: { known?: RunShape; fromOffset?: boolean; bashLine?: boolean } = {}): Promise<Record<string, unknown> & { redactedLines?: number }> {
  const { shapeOf } = await import('./host-exec-legacy.js')
  if (reply.running !== true) release(jobId)
  const raw = typeof reply.output === 'string' ? reply.output : ''
  const { text, redacted, keyToEnd } = await redact(raw)
  const strict = await import('./host-exec-strict.js')
  // Read from the output as it came: a step whose command looks like a credential had its whole
  // line hidden, and the step with it (2026-11-05 review sol13: `test password=… = x` named none).
  const failedStep = reply.running !== true ? strict.failedStepOf(raw, jobId, reply.exitCode) : null
  // bash's own line number serves only the run's lookup of the step (functionCall); never shown.
  if (failedStep && !opts.bashLine) { delete failedStep.bashLine; delete failedStep.inner }
  // A strict run's own lines say the failing step once, and name what failedStep names. The run's
  // lookup (bashLine) still reads the command as it is, and hides it after.
  const hidden = failedStep ? await hideStepSecrets(failedStep) : null
  const named = opts.bashLine ? failedStep : hidden
  // The run names it once, after its own lookup (the line's sealed marker is still there for it).
  const shown = !hidden ? text : opts.bashLine ? strict.withoutInnerMarks(text, jobId) : strict.withStepNamed(strict.withoutInnerMarks(text, jobId), hidden, jobId)
  const offset = typeof reply.offset === 'number' ? reply.offset : undefined
  // What it left running that was stopped, named by ps on the host: hidden like the output (an
  // argument may carry a token the line took from the environment).
  const left = Array.isArray(reply.leftCommands) ? (await redact(reply.leftCommands.filter((c) => typeof c === 'string').join('\n'))).text.split('\n').filter(Boolean) : []
  const more = opts.fromOffset === true && typeof reply.nextOffset === 'number' && typeof reply.outputBytes === 'number' && reply.nextOffset < reply.outputBytes
  const blocked = reply.blocked && typeof reply.blocked === 'object' ? reply.blocked : null
  return {
    host, jobId, running: reply.running === true, exitCode: reply.exitCode ?? null, signal: reply.signal ?? null,
    timedOut: reply.timedOut === true, ms: reply.ms, cwd: reply.cwd, ...shapeOf(reply, opts.known), output: shown,
    truncated: opts.fromOffset === true ? false : offset !== undefined ? offset > 0 : reply.truncated === true,
    ...(more ? { more: true } : {}),
    offset: reply.offset, nextOffset: reply.nextOffset,
    outputBytes: reply.outputBytes, logFile: reply.logFile, ...(blocked ? { blocked } : {}), ...(redacted ? { redactedLines: redacted } : {}), ...(keyToEnd ? { redactedToEnd: true } : {}),
    // Processes it left running in the background were stopped when the shell exited (host-exec-group.ts);
    // `outputCut`: one outside its group held its output, and still runs.
    ...(reply.leftBehind === true ? { leftBehind: true, ...(left.length ? { leftCommands: left } : {}) } : {}),
    ...(reply.outputCut === true ? { outputCut: true } : {}),
    // While it runs: its shell has exited (what it left is being stopped), or how long to its
    // deadline on the host (0: the host is stopping it there).
    ...(reply.running === true && reply.shellExited === true ? { shellExited: true } : {}),
    // host_exec_stop asked, and the host is stopping it (its 3 s before SIGKILL).
    ...(reply.running === true && reply.killed === true ? { stopAsked: true } : {}),
    // It ended because host_exec_stop asked (the only sender of exec.kill).
    ...(reply.running !== true && reply.killed === true ? { stoppedByCall: true } : {}),
    ...(reply.running === true && typeof reply.deadlineInMs === 'number' ? { deadlineInMs: reply.deadlineInMs } : {}),
    ...(named ? { failedStep: named } : {}),
  }
}

/**
 * A command that would make sound on that machine (speech, a player, a volume change or an unmute) never
 * runs, with no override: the same rule the Bash hook holds every session to (src/providers/sound-guard.ts).
 * Nor one that sends real input to its front window (cliclick, System Events keys), unless its own line
 * names why (WALNUT_INPUT_REASON).
 */
function refuseSound(line: string): void {
  if (!soundGuardOn()) return
  const what = soundRisk(line)
  if (!what) return
  if (what.startsWith(INPUT_PREFIX)) {
    throw new HostExecError(`Walnut refused this command: ${refusalAdvice(what)} Nothing ran.`, 409, 'foreground_input', { input: what.slice(INPUT_PREFIX.length) })
  }
  throw new HostExecError(`Walnut refused this command: ${refusalAdvice(what)} Nothing ran.`, 409, 'makes_sound', { sound: what })
}

/** A command that can show a dialog on a Mac's screen runs only with `allow_prompts` (host-exec-prompts.ts). */
async function screenForPrompts(host: string, line: string, allowed: boolean, cwd: string | undefined, taskId: string): Promise<void> {
  if (allowed) return
  const { promptRefusal } = await import('./host-exec-prompts.js')
  const refusal = await promptRefusal(host, line, cwd, taskId)
  if (refusal) throw new HostExecError(refusal.message, 409, 'may_prompt', { prompt: refusal.what })
}

/**
 * Run one command on another host for the caller's task. The host always runs it as a
 * job; a foreground call then waits for it to end, at most until its deadline, or, for a
 * call that crossed a host's gateway (it gives up at 20 s), until ANSWER_RETURN_MS before
 * that (budgetLeft): a retry after a lost answer would run the command twice. A run still
 * going comes back `running` with its jobId.
 */
export async function execOnHost(params: ExecParams, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const hasCommand = typeof params.command === 'string' && params.command.trim() !== ''
  const hasArgv = Array.isArray(params.argv) && params.argv.length > 0
  if (hasCommand === hasArgv) throw new HostExecError('Give exactly one of command (a shell line) or argv (a program and its arguments)', 400, 'bad_request')
  const waits = await import('./host-exec-wait.js')
  const waitFor = waits.checkWaitFor(params.wait_for)
  // Every refusal of the call's own arguments comes before the grant, so a bad call never asks the user.
  if (params.wait_ms !== undefined && !waitFor) throw new HostExecError('wait_ms is how long the call waits for wait_for: give wait_for too, or leave wait_ms out (host_exec_read with wait_ms waits for a run to end). Nothing ran.', 400, 'bad_request')
  const asked = typeof params.job_id === 'string' && params.job_id !== '' ? params.job_id : null
  if (asked !== null && !JOB_ID_RE.test(asked)) throw new HostExecError('job_id must be hx- and 4 to 64 letters, digits, - or _ (the walnut CLI picks one)', 400, 'bad_request')
  // Any grant_id at all is the pinned mode: an empty or malformed one is refused, never read as none.
  const pinned = params.grant_id !== undefined ? String(params.grant_id) : null
  if (pinned !== null && !GRANT_ID_RE.test(pinned)) throw new HostExecError('grant_id must be a grant\'s id (xg-...; host_exec_list on the host names this task\'s as grantId)', 400, 'bad_request')
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  const preview = hasCommand ? params.command! : params.argv!.join(' ')
  // The line the host runs (host-exec-core.ts commandLine): argv too may start a dialog.
  const line = hasCommand ? params.command! : 'exec ' + params.argv!.map(shellQuote).join(' ')
  // Before the grant: a command it would refuse asks nothing of the user.
  refuseSound(line)
  await screenForPrompts(host, line, params.allow_prompts === true, params.cwd, caller.taskId)
  const grantId = pinned !== null ? await pinnedGrant(caller, host, pinned) : await grantFor(caller, host, preview)
  const jobId = asked ?? `hx-${randomUUID()}`
  // The same call again (a retry after a lost answer): its run, never a second one.
  const known = running.get(jobId)
  if (known && (known.taskId !== caller.taskId || known.host !== host)) throw jobTaken(jobId)
  const jobs = await import('./host-exec-jobs.js')
  const ran = asked ? jobs.startedRun(jobId) : undefined
  // The same id with another command: its run all the same, and the answer says so (2026-11-05
  // review: a reused job_id with a new command answered the old run without a word).
  const other = ran && ran.taskId === caller.taskId && ran.command !== preview.slice(0, 200) ? ran.command : undefined
  const again = { background: params.background === true, waitFor, asked: params.timeout_ms, waitMs: params.wait_ms, ...(other !== undefined ? { other } : {}) }
  if (known) return sameJob(caller, host, jobId, t0, again)
  // An id Walnut already ran (it may have ended, and the host forgotten it since): never again.
  if (ran && (ran.taskId !== caller.taskId || ran.host !== host)) throw jobTaken(jobId)
  if (ran) return sameJob(caller, host, jobId, t0, { ...again, ranAt: ran.startedAt })
  const slotMs = await takeSlot(caller, host, jobId, t0, () => assertStillGranted(caller.taskId, host, grantId, pinned !== null))

  const background = params.background === true
  const cap = background ? BACKGROUND_MAX_MS : FOREGROUND_MAX_MS
  const timeoutMs = Math.min(typeof params.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : (background ? cap : 2 * 60_000), cap)
  // Too little time left to start it and get the answer back before the caller gives up: start nothing.
  const tooLate = async () => new HostExecError(`There was not time to start the command on ${await hostName(host)} and answer before your call gives up; nothing ran. Try again.`, 503, 'host_offline')
  let conn: Awaited<ReturnType<typeof dial>>
  let send: Record<string, unknown>
  let shape: RunShape | undefined
  let before: (() => void) | undefined
  // The grant the run counts on: a revoked one the user gave again while this call waited counts the new one.
  let used = grantId
  try {
    // Each wait (the slot, the dial) is followed by a look at the grant and the host's stop,
    // before the time check, so a revoke answers as a revoke.
    await assertStillGranted(caller.taskId, host, grantId, pinned !== null)
    if (budgetLeft(caller, t0) < START_MIN_LEFT_MS) throw await tooLate()
    conn = await dial(host, budgetLeft(caller, t0) - START_MIN_LEFT_MS)
    await assertStillGranted(caller.taskId, host, grantId, pinned !== null)
    if (budgetLeft(caller, t0) < START_MIN_LEFT_MS) throw await tooLate()
    await waits.assertWaitSupported(conn, host, waitFor)
    // Strict shapes the line here, after the dialog guards read the user's own text.
    const strict = params.strict === true && hasCommand
    const { strictLine } = await import('./host-exec-strict.js')
    const runParams = strict ? { ...params, command: strictLine(params.command!, jobId) } : params
    ;({ send, known: shape, before } = await (await import('./host-exec-legacy.js')).runRequest(conn, host, caller, runParams, strict ? strictLine(line, jobId) : line))
    // Last look before anything reaches the host: from here to the send nothing waits.
    used = await assertStillGranted(caller.taskId, host, grantId, pinned !== null)
  } catch (err) {
    release(jobId) // nothing was sent: the slot is free
    throw err
  }
  running.set(jobId, { taskId: caller.taskId, host, until: Date.now() + timeoutMs + REPLY_MARGIN_MS, at: Date.now() })
  // This task's runs there, for host_exec_list (an older host does not say whose a job is).
  const noteRun = () => jobs.noteStarted({ jobId, taskId: caller.taskId, host, command: preview, startedAt: Date.now() })
  let reply: Record<string, unknown>
  try {
    before?.() // an older daemon's task directory marker, then the run
    reply = await ask(conn, host, 'exec.run', {
      jobId, taskId: caller.taskId, ...send,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      // The user agreed to a dialog there: the host neither refuses the line nor stops it at one.
      ...(params.allow_prompts === true ? { allowPrompts: true } : {}),
      // A foreground run keeps its own deadline on the host; only our wait for it is bounded.
      timeoutMs, background: true, caller: { task: caller.taskId, host: caller.host },
      // The host refuses a wait_for that could never hold there before it runs anything.
      ...(waitFor && conn.hasCapability(waits.WAIT_CAPABILITY) ? { until: waitFor } : {}),
      // What its shell leaves in its process group is stopped when it exits (the help says so).
      ...(conn.hasCapability(GROUP_CAPABILITY) ? { endGroup: true } : {}),
    }, Math.min(REPLY_MARGIN_MS, budgetLeft(caller, t0)))
  } catch (err) {
    // The host may have started it: the job keeps its slot until its deadline, and the
    // answer names it, so the session reads it instead of running the command again.
    if (err instanceof HostExecError) {
      err.message += ` It may have started there as job ${jobId}: read it with host_exec_read before running it again.`
      err.data = { ...err.data, jobId, mayHaveStarted: true }
      noteRun()
    }
    throw err
  }
  if (!reply.ok) {
    // The host has a job by this id: this task's own run (its answer was lost, or a call with the
    // same id at once holds the slot), or another task's.
    if (reply.code === 'job_exists' || (typeof reply.error === 'string' && / already exists$/.test(reply.error))) {
      return sameJob(caller, host, jobId, t0, again)
    }
    release(jobId)
    throw daemonError(reply, 'the host refused the command')
  }
  // The host has it now: a refresh may judge it by the host's list from here on.
  const entry = running.get(jobId)
  if (entry) entry.at = 0
  noteRun()
  void import('./exec-grants.js').then((g) => g.noteRun(used, preview))
  let last = reply
  // Cut short by the call's own answer time (a session on another host): the answer says so.
  let cut = false
  // wait_for: the host waits for it, as long as a foreground run is held (host-exec-wait.ts).
  if (waitFor) cut = waits.execWaitWanted(background, timeoutMs, params.wait_ms) > budgetLeft(caller, t0)
  const waited = waitFor ? await waits.waitOnJob(conn, host, caller, jobId, waitFor, { since: t0, within: waits.execWaitWindow(caller, t0, background, timeoutMs, params.wait_ms), started: reply, scanFrom: 0 }) : null
  if (waited) last = { ...waited.reply, cwd: reply.cwd }
  else if (!background) {
    cut = timeoutMs + KILL_GRACE_MS + 2_000 > budgetLeft(caller, t0)
    const until = Date.now() + holdBudget(caller, timeoutMs + KILL_GRACE_MS + 2_000, t0)
    while (last.running === true && Date.now() < until) {
      const wait = Math.min(until - Date.now(), HOST_WAIT_MAX_MS)
      // A read that fails leaves the run as it was: running, with its jobId to read later; a
      // revoke while it waited ends the call (the run keeps going).
      const read = await readJob(conn, host, caller.taskId, { jobId, taskId: caller.taskId, wait }, wait + Math.min(REPLY_MARGIN_MS, Math.max(1_000, budgetLeft(caller, t0) - wait)))
        .catch(async (err) => { if ((await import('./host-exec-grant.js')).isReadStop(err)) throw err; return null })
      if (!read?.ok) break
      last = { ...read, cwd: reply.cwd }
    }
  }
  const out = await jobAnswer(host, jobId, last, { known: shape, bashLine: true })
  // An older daemon there leaves a child that sent its output elsewhere running: the answer says so.
  if (!conn.hasCapability(GROUP_CAPABILITY)) out.groupKept = true
  if (waited) out.waitedFor = await waits.shownWait(last, out, waited.waitedFor, waits.readAtOf(conn, host, caller, jobId, t0))
  if (cut && out.running === true && waits.ranOut(waited?.waitedFor)) out.heldMs = Date.now() - t0
  // It waited for a slot under a cap first: the answer says how long (2026-11-05 review).
  if (slotMs >= 1_000) out.slotWaitMs = slotMs
  // A deadline over the most a run of its kind may have ran with that most: the answer says so (2026-11-05 review 12).
  if (typeof params.timeout_ms === 'number' && params.timeout_ms > cap) out.timeoutCappedMs = cap
  const step = out.failedStep as import('./host-exec-strict.js').FailedStep | undefined
  if (step && hasCommand) {
    const strict = await import('./host-exec-strict.js')
    const called = strict.functionCall(step, params.command!)
    const at = called === step ? strict.lineOf(step, params.command!) : undefined
    if (called !== step) out.failedStep = called
    else if (at) {
      step.line = at
      step.text = params.command!.split('\n')[at - 1].trim().slice(0, 200)
      out.failedStep = strict.pipeMember(step)
    }
  }
  if (step) {
    const strict = await import('./host-exec-strict.js')
    out.failedStep = await hideStepSecrets(out.failedStep as typeof step)
    if (typeof out.output === 'string') out.output = strict.withStepNamed(out.output, out.failedStep as typeof step, jobId)
  }
  // bash's own line number only serves the lookup above.
  if (out.failedStep && typeof out.failedStep === 'object') { delete (out.failedStep as { bashLine?: number }).bashLine; delete (out.failedStep as { inner?: true }).inner }
  log.session.info('host exec', {
    taskId: caller.taskId, fromHost: caller.host, host, jobId, cwd: reply.cwd, background, running: out.running, shell: out.shell, legacy: !conn.hasCapability('host-exec-v2'),
    exitCode: out.exitCode, timedOut: out.timedOut, ms: Date.now() - t0, bytes: out.outputBytes, redacted: out.redactedLines ?? 0, waitedFor: waited?.waitedFor.matched,
    command: preview.slice(0, 200),
  })
  return out
}

function jobTaken(jobId: string): HostExecError {
  return new HostExecError(`Job ${jobId} is another run's; leave job_id out and Walnut picks a new one.`, 409, 'job_id_taken')
}

/**
 * A job_id this task already started on this host: its run as it is now (a foreground
 * call waits for it as the first one would have, a wait_for waits again), marked `sameJob`,
 * so nothing runs twice.
 */
async function sameJob(caller: Caller, host: string, jobId: string, t0: number, o: Parameters<typeof import('./host-exec-wait.js').readAgain>[5] & { ranAt?: number; other?: string }): Promise<Record<string, unknown>> {
  const { ranAt, other } = o
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
  const waits = await import('./host-exec-wait.js')
  const { reply, waitedFor } = await waits.readAgain(conn, host, caller, jobId, t0, o)
  if (!reply.ok) {
    if (reply.code === 'unknown_job' && ranAt !== undefined) {
      throw new HostExecError(`Job ${jobId} already ran for this task on ${await hostName(host)} (started ${new Date(ranAt).toISOString()}), and that host no longer holds it `
        + '(it keeps a finished job for an hour; its log stays in your task\'s directory there). Nothing ran again. Leave job_id out to run the command anew.', 409, 'job_gone', { jobId })
    }
    if (reply.code === 'unknown_job') throw jobTaken(jobId)
    throw daemonError(reply, 'the host could not read the job')
  }
  // Still running: it holds a slot here too (a call with the same id at once, or the server restarted).
  if (reply.running === true && !running.has(jobId)) running.set(jobId, { taskId: caller.taskId, host, until: Date.now() + BACKGROUND_MAX_MS + REPLY_MARGIN_MS, at: 0 })
  log.session.info('host exec: the same job id again, answered with its run', { taskId: caller.taskId, host, jobId })
  const out = { ...await jobAnswer(host, jobId, reply), sameJob: true, ...(other !== undefined ? { sameJobCommand: (await redact(other)).text } : {}) }
  return waitedFor ? { ...out, waitedFor: await waits.shownWait(reply, out, waitedFor, waits.readAtOf(conn, host, caller, jobId, t0)) } : out
}

/** Tests: forget the in-flight runs. */
export function resetHostExecForTest(): void {
  running.clear()
  for (const wake of [...slotWaiters]) wake()
}
