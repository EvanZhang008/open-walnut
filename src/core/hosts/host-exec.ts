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

// The user's grant for a task on a host (host-exec-grant.ts), for host_mcp and host_http too.
export { assertStillGranted, grantFor, isOwnHost }

export const MAX_RUNNING_PER_TASK = 4
export const MAX_RUNNING_PER_HOST = 8
/** The longest a call waits at a cap for a slot (less for a relayed call, budgetLeft). */
const SLOT_WAIT_MAX_MS = 20_000
/** While it waits: a look at the count this often, and at the hosts' own lists this often. */
const SLOT_POLL_MS = 1_000
const SLOT_REFRESH_MS = 2_000
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

export class HostExecError extends Error {
  constructor(message: string, public status: number, public code: string, public data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HostExecError'
  }
}

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
   * Run only under this grant (an id from GET /api/v1/host-exec/grants): no other grant counts,
   * none is made (not even a task on the user's own host gets one), and no letter asks the user.
   * The grant must be this task's on this host and live, and the host open, at the start and
   * again right before the run is sent; otherwise nothing runs (host-exec-grant.ts pinnedGrant).
   */
  grant_id?: string
}

export interface Caller { sid: string; taskId: string; taskTitle: string; host: string }

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

function normHost(h: string | undefined | null): string {
  return !h || h === 'local' ? LOCAL : h
}

export async function callerOf(sid: string | undefined): Promise<Caller> {
  const { resolveCaller } = await import('../sessions/session-send-core.js')
  const c = await resolveCaller(sid)
  if (c.kind !== 'session' || !c.record.taskId) {
    throw new HostExecError('host_exec runs for a task\'s session; a person runs commands in their own terminal', 403, 'session_only')
  }
  const { getTask } = await import('../task-manager.js')
  const task = await getTask(c.record.taskId).catch(() => undefined)
  return { sid: c.record.claudeSessionId, taskId: c.record.taskId, taskTitle: task?.title ?? c.record.taskId, host: normHost(c.record.host) }
}

/**
 * The joined row of the machine whose found ~/.ssh/config row `alias` is, or null:
 * one machine, and the joined row is the one that works (joined-twins.ts).
 */
export async function sameMachineAs(alias: string): Promise<string | null> {
  const name = alias.trim()
  if (!name || normHost(name) === LOCAL) return null
  const [{ getConfig }, { joinedAliasOf }] = await Promise.all([import('../config-manager.js'), import('./joined-twins.js')])
  const config = await getConfig()
  const to = joinedAliasOf(config.hosts ?? {}, config.net)(name)
  return to && to !== name ? to : null
}

/** What an answer for a call on a found twin says (`refused`: nothing ran there), or null for any other host. */
export async function sameMachineNote(alias: string, refused = false): Promise<string | null> {
  const to = await sameMachineAs(alias).catch(() => null)
  if (!to) return null
  const name = await hostName(to)
  return `${alias.trim()} is the same machine as ${name === to ? to : `${name} (host ${to})`}, which joined over the host network; `
    + `${refused ? `this answer is ${to}'s` : `Walnut used ${to}`}. Name ${to} from now on.`
}

export async function targetHost(raw: string, caller: Caller, sameHostHint = 'run the command with your own Bash tool'): Promise<string> {
  const { parseHostSelector, pickHost, HostSelectorError } = await import('./host-select.js')
  let host: string
  try {
    const tags = parseHostSelector(raw)
    host = normHost(tags ? (await pickHost(tags)).host : raw.trim())
  } catch (err) {
    if (err instanceof HostSelectorError) throw new HostExecError(err.message, err.code === 'bad_selector' ? 400 : 409, err.code)
    throw err
  }
  // A selector already picks the joined row (pickHost); a named found twin goes there too.
  const joined = await sameMachineAs(host)
  if (joined) {
    log.session.info('host exec: a found twin is its joined machine', { asked: host, host: joined, taskId: caller.taskId })
    host = joined
  }
  if (host === caller.host) {
    throw new HostExecError(`This session already runs on ${host === LOCAL ? 'this Mac' : host}: ${sameHostHint}`, 400, 'same_host')
  }
  if (host !== LOCAL) {
    const { getConfig } = await import('../config-manager.js')
    const hosts = (await getConfig()).hosts ?? {}
    if (!Object.hasOwn(hosts, host)) throw new HostExecError(`Unknown host: ${host} (host_list names them)`, 404, 'unknown_host')
  }
  return host
}

export async function hostName(host: string): Promise<string> {
  if (host === LOCAL) return 'the Mac'
  const { hostDisplayNameFor } = await import('./host-display-name.js')
  return hostDisplayNameFor(host)
}

/** The link to `host`, by `within` ms, with the daemon capability the call needs. */
export async function dial(host: string, within = DIAL_MS, capability = 'host-exec-v1', what = 'run commands') {
  const { link } = await import('./link.js')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const conn = await Promise.race([
      link(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), Math.max(1, Math.min(within, DIAL_MS))) }),
    ])
    if (!conn.hasCapability(capability)) {
      throw new HostExecError(`The Walnut daemon on ${await hostName(host)} needs an update before it can ${what} for other hosts (it updates on its next connect).`, 409, 'daemon_upgrade')
    }
    return conn
  } catch (err) {
    if (err instanceof HostExecError) throw err
    throw new HostExecError(`Walnut cannot reach ${await hostName(host)} right now (${err instanceof Error ? err.message : String(err)}).`, 503, 'host_offline')
  } finally {
    clearTimeout(timer)
  }
}

/** The host's refusal as an answer: its words, and a status by its code. */
const DAEMON_STATUS: Record<string, number> = { cwd_missing: 400, bad_request: 400, unknown_job: 404, task_dir_unset: 409, may_prompt: 409, job_exists: 409 }

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

/** How long one call may hold its answer: a session on another host reaches us through its gateway, which gives up at 20 s. */
function holdBudget(caller: Caller, wanted: number, since: number): number {
  return Math.max(0, Math.min(wanted, budgetLeft(caller, since)))
}

/**
 * What is left of a call's answer time: to the caller's own deadline less the way back, when the
 * call carries one (a relayed call, src/lib/answer-by.ts), and for a session on another host at
 * most RELAYED_HOLD_MS from `since`; unbounded for a caller on the Mac whose call has no deadline.
 */
export function budgetLeft(caller: Caller, since: number): number {
  const now = Date.now()
  const by = ambientAnswerBy()
  const relayed = caller.host === LOCAL ? Number.POSITIVE_INFINITY : RELAYED_HOLD_MS - (now - since)
  return by === undefined ? relayed : Math.min(relayed, by - ANSWER_RETURN_MS - now)
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
async function takeSlot(caller: Caller, host: string, jobId: string, since: number): Promise<void> {
  const mine = (r: { taskId: string }) => r.taskId === caller.taskId
  const theirs = (r: { host: string }) => r.host === host
  // A refresh may use at most half of what is left, so the run itself still fits.
  const share = () => Math.min(DIAL_MS + LIST_MS, (budgetLeft(caller, since) - START_MIN_LEFT_MS) / 2)
  const waitUntil = Date.now() + Math.max(0, Math.min(SLOT_WAIT_MAX_MS, (budgetLeft(caller, since) - START_MIN_LEFT_MS) / 2))
  let refreshAt = 0
  for (;;) {
    const taskFull = countRunning(mine) >= MAX_RUNNING_PER_TASK
    if (!taskFull && countRunning(theirs) < MAX_RUNNING_PER_HOST) {
      running.set(jobId, { taskId: caller.taskId, host, until: Date.now() + DIAL_MS + 2 * REPLY_MARGIN_MS, at: Date.now(), pending: true })
      return
    }
    if (Date.now() >= refreshAt) {
      refreshAt = Date.now() + SLOT_REFRESH_MS
      await refreshRunning(taskFull ? mine : theirs, share())
      continue
    }
    const left = waitUntil - Date.now()
    if (left <= 0) {
      const waited = `waited ${Math.round((Date.now() - since) / 1000)} s for one to end`
      if (taskFull) throw new HostExecError(`This task already runs ${MAX_RUNNING_PER_TASK} commands on other hosts (${waited}); wait for one (host_exec_read) or stop one (host_exec_stop).`, 429, 'busy')
      throw new HostExecError(`${await hostName(host)} already runs ${MAX_RUNNING_PER_HOST} commands for other hosts (${waited}); try again in a moment.`, 429, 'busy')
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
export async function jobAnswer(host: string, jobId: string, reply: Record<string, unknown>, opts: { known?: RunShape; fromOffset?: boolean } = {}): Promise<Record<string, unknown> & { redactedLines?: number }> {
  const { shapeOf } = await import('./host-exec-legacy.js')
  if (reply.running !== true) release(jobId)
  const { text, redacted } = await redact(typeof reply.output === 'string' ? reply.output : '')
  const { failedStepOf } = await import('./host-exec-strict.js')
  const failedStep = reply.running !== true ? failedStepOf(text) : null
  const offset = typeof reply.offset === 'number' ? reply.offset : undefined
  const more = opts.fromOffset === true && typeof reply.nextOffset === 'number' && typeof reply.outputBytes === 'number' && reply.nextOffset < reply.outputBytes
  const blocked = reply.blocked && typeof reply.blocked === 'object' ? reply.blocked : null
  return {
    host, jobId, running: reply.running === true, exitCode: reply.exitCode ?? null, signal: reply.signal ?? null,
    timedOut: reply.timedOut === true, ms: reply.ms, cwd: reply.cwd, ...shapeOf(reply, opts.known), output: text,
    truncated: opts.fromOffset === true ? false : offset !== undefined ? offset > 0 : reply.truncated === true,
    ...(more ? { more: true } : {}),
    offset: reply.offset, nextOffset: reply.nextOffset,
    outputBytes: reply.outputBytes, logFile: reply.logFile, ...(blocked ? { blocked } : {}), ...(redacted ? { redactedLines: redacted } : {}),
    ...(failedStep ? { failedStep } : {}),
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
  const asked = typeof params.job_id === 'string' && params.job_id !== '' ? params.job_id : null
  if (asked !== null && !JOB_ID_RE.test(asked)) throw new HostExecError('job_id must be hx- and 4 to 64 letters, digits, - or _ (the walnut CLI picks one)', 400, 'bad_request')
  // Any grant_id at all is the pinned mode: an empty or malformed one is refused, never read as none.
  const pinned = params.grant_id !== undefined ? String(params.grant_id) : null
  if (pinned !== null && !GRANT_ID_RE.test(pinned)) throw new HostExecError('grant_id must be a grant\'s id (xg-..., GET /api/v1/host-exec/grants lists them)', 400, 'bad_request')
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
  if (known) return sameJob(caller, host, jobId, params.background === true, t0)
  // An id Walnut already ran (it may have ended, and the host forgotten it since): never again.
  const jobs = await import('./host-exec-jobs.js')
  const ran = asked ? jobs.startedRun(jobId) : undefined
  if (ran && (ran.taskId !== caller.taskId || ran.host !== host)) throw jobTaken(jobId)
  if (ran) return sameJob(caller, host, jobId, params.background === true, t0, ran.startedAt)
  await takeSlot(caller, host, jobId, t0)

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
    // Strict shapes the line here, after the dialog guards read the user's own text.
    const strict = params.strict === true && hasCommand
    const { strictLine } = await import('./host-exec-strict.js')
    const runParams = strict ? { ...params, command: strictLine(params.command!) } : params
    ;({ send, known: shape, before } = await (await import('./host-exec-legacy.js')).runRequest(conn, host, caller, runParams, strict ? strictLine(line) : line))
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
      return sameJob(caller, host, jobId, background, t0)
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
  if (!background) {
    const until = Date.now() + holdBudget(caller, timeoutMs + KILL_GRACE_MS + 2_000, t0)
    while (last.running === true && Date.now() < until) {
      const wait = Math.min(until - Date.now(), HOST_WAIT_MAX_MS)
      // A read that fails leaves the run as it was: running, with its jobId to read later.
      const read = await ask(conn, host, 'exec.read', { jobId, taskId: caller.taskId, wait }, wait + Math.min(REPLY_MARGIN_MS, Math.max(1_000, budgetLeft(caller, t0) - wait)))
        .catch(() => null)
      if (!read?.ok) break
      last = { ...read, cwd: reply.cwd }
    }
  }
  const out = await jobAnswer(host, jobId, last, { known: shape })
  const step = out.failedStep as import('./host-exec-strict.js').FailedStep | undefined
  if (step && hasCommand) {
    const at = (await import('./host-exec-strict.js')).lineOf(step, params.command!)
    if (at) { step.line = at; step.text = params.command!.split('\n')[at - 1].trim().slice(0, 200) }
  }
  log.session.info('host exec', {
    taskId: caller.taskId, fromHost: caller.host, host, jobId, cwd: reply.cwd, background, running: out.running, shell: out.shell, legacy: !conn.hasCapability('host-exec-v2'),
    exitCode: out.exitCode, timedOut: out.timedOut, ms: Date.now() - t0, bytes: out.outputBytes, redacted: out.redactedLines ?? 0,
    command: preview.slice(0, 200),
  })
  return out
}

function jobTaken(jobId: string): HostExecError {
  return new HostExecError(`Job ${jobId} is another run's; leave job_id out and Walnut picks a new one.`, 409, 'job_id_taken')
}

/**
 * A job_id this task already started on this host: its run as it is now (a foreground
 * call waits for it as the first one would have), marked `sameJob`, so nothing runs twice.
 */
async function sameJob(caller: Caller, host: string, jobId: string, background: boolean, t0: number, ranAt?: number): Promise<Record<string, unknown>> {
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
  const wait = background ? 0 : Math.max(0, Math.min(HOST_WAIT_MAX_MS, holdBudget(caller, FOREGROUND_MAX_MS, t0) - 2_000))
  const reply = await ask(conn, host, 'exec.read', { jobId, taskId: caller.taskId, ...(wait ? { wait } : {}) }, wait + Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, t0) - wait)))
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
  return { ...await jobAnswer(host, jobId, reply), sameJob: true }
}

/** Tests: forget the in-flight runs. */
export function resetHostExecForTest(): void {
  running.clear()
  for (const wake of [...slotWaiters]) wake()
}
