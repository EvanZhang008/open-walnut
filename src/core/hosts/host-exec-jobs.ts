/**
 * A task's jobs on another host after host_exec started them (host-exec.ts): read one, stop
 * one, and list them.
 *
 * The list (host_exec_list): 2026-11-03, a session on another host called host_exec, the
 * answer was lost on the way back (`hub_timeout`), and the run's id with it, although the run
 * had started; nothing could find that job again. The host's daemon lists its jobs
 * (`exec.list`, kept an hour after they end); since host-exec-v2 each names its task and its
 * command, and the daemon gives only the asking task's. An older daemon names neither, so this
 * server keeps its own short record of the runs it started per task and host, and the list
 * takes from the host only the jobs that record names. A job the record names that the host no
 * longer holds (it restarted, or an hour went by) is listed as `gone`.
 */
import {
  HOST_WAIT_MAX_MS, LIST_MS, REPLY_MARGIN_MS, ask, budgetLeft, callerOf, daemonError, dial, grantFor, HostExecError, hostName, jobAnswer, readJob, redact, targetHost,
  type Caller,
} from './host-exec.js'
import { mayTendRuns } from './host-exec-grant.js'
import { noteFinalAnswer } from './repeat-answers.js'

/** What this server knows of a run it started (the host may know more). */
interface StartedRun { jobId: string; taskId: string; host: string; command: string; startedAt: number }

/** The record's bounds: per task and host this many runs, none older than a day. */
const RECORD_PER_KEY = 50
const RECORD_MAX_AGE_MS = 24 * 60 * 60_000
/** A list shows every running job, and this many that ended. */
const LIST_ENDED_MAX = 20

const started = new Map<string, StartedRun[]>()
/** The same runs by job id: an id the caller chose is never run twice (host-exec.ts). */
const byJob = new Map<string, StartedRun>()

function keyOf(taskId: string, host: string): string {
  return `${taskId}\u0000${host}`
}

/** A run this server started (or may have: its answer was lost), for host_exec_list. */
export function noteStarted(run: StartedRun): void {
  const key = keyOf(run.taskId, run.host)
  const cutoff = Date.now() - RECORD_MAX_AGE_MS
  const all = (started.get(key) ?? []).filter((r) => r.jobId !== run.jobId)
  all.push({ ...run, command: run.command.slice(0, 200) })
  const kept = all.slice(-RECORD_PER_KEY).filter((r) => r.startedAt >= cutoff)
  for (const r of all) if (!kept.includes(r) && byJob.get(r.jobId) === r) byJob.delete(r.jobId)
  started.set(key, kept)
  byJob.set(run.jobId, kept[kept.length - 1])
  if (byJob.size > BY_JOB_SWEEP_AT) sweep(cutoff)
}

/** Past this many ids, the ones older than a day are dropped (tasks that never run again keep none). */
const BY_JOB_SWEEP_AT = 5_000

function sweep(cutoff: number): void {
  for (const [id, r] of byJob) if (r.startedAt < cutoff) byJob.delete(id)
  for (const [key, runs] of started) {
    const fresh = runs.filter((r) => r.startedAt >= cutoff)
    if (fresh.length) started.set(key, fresh)
    else started.delete(key)
  }
}

/** The run Walnut started under `jobId` in the last day, or undefined. */
export function startedRun(jobId: string): StartedRun | undefined {
  const r = byJob.get(jobId)
  if (r && r.startedAt < Date.now() - RECORD_MAX_AGE_MS) { byJob.delete(jobId); return undefined }
  return r
}

/**
 * A job the host does not hold (`unknown_job`) is a final answer: no later read finds it. 2026-11-22:
 * the Mac's disk filled, a host_exec call's answer was lost before it reached the Mac, and a
 * session's shell loop read that job id every 10 s for 40 minutes, each read a 404 warn line, until
 * the log-spike alarm rang. The answer now says what it means and the step that converges (the same
 * host_exec call with its job_id, which answers the run if it started and runs it once if not), and
 * counts the reads of it (repeat-answers.ts), so a repeat logs at info, not warn.
 */
/** The final answer for a read or stop of `jobId` the host does not hold (see the note above). */
async function unknownJob(err: HostExecError, caller: { taskId: string }, host: string, jobId: string, verb: 'read' | 'stop' = 'read'): Promise<HostExecError> {
  const repeats = noteFinalAnswer(`job\u0000${caller.taskId}\u0000${host}\u0000${jobId}`)
  const name = await hostName(host)
  const run = startedRun(jobId)
  // The step depends on what Walnut knows: a run it started is gone (the same id again answers
  // job_gone and runs nothing), an id it never saw start may be a lost call's (the same id runs it once).
  const tail = run && run.taskId === caller.taskId
    ? `Walnut started it at ${new Date(run.startedAt).toISOString()} and ${name} no longer holds it (it keeps a finished job for an hour and its log stays in your task's directory there, host-exec/${jobId}.log; a restart of its daemon also ends what it held). To run the command anew, leave job_id out.`
    : `Walnut has no record of starting it there. If its host_exec call's answer was lost before the call reached ${name}, it never ran: send that same call again with "job_id":"${jobId}", which runs it at most once. If you know it ran (over an hour ago, or as another task's), leave job_id out instead.`
  return new HostExecError(`No job ${jobId} on ${name}. No later ${verb} finds it: stop asking for it. ${tail} host_exec_list lists this task's jobs there.`,
    err.status, 'unknown_job', { ...err.data, jobId, final: true, ...(repeats ? { repeats } : {}) })
}

/** The same call, with a host's `unknown_job` turned into its final answer (unknownJob). */
async function finalIfUnknown<T>(caller: { taskId: string }, host: string, jobId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof HostExecError && err.code === 'unknown_job') throw await unknownJob(err, caller, host, jobId)
    throw err
  }
}

/**
 * Read a job's output (from `offset`, or its tail), waiting up to `wait_ms` for it to end; with
 * `wait_for`, also until its output matches, a port listens or a file exists (host-exec-wait.ts),
 * by default as long as a read may hold.
 */
export async function readHostJob(params: { host: string; job_id: string; offset?: number; wait_ms?: number; wait_for?: unknown }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const waits = await import('./host-exec-wait.js')
  const waitFor = waits.checkWaitFor(params.wait_for, 'Nothing was read.')
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  await grantFor(caller, host, null)
  return finalIfUnknown(caller, host, String(params.job_id), () => readOnceKnown(params, caller, callerSid, host, waitFor, t0))
}

/** How often a read that waits looks again for a job the host does not hold yet, and for how long at most. */
const UNKNOWN_RECHECK_MS = 2_000
const UNKNOWN_HOLD_MAX_MS = 15_000

/**
 * A read that may wait (wait_ms, or wait_for) holds an unknown_job for that wait (15 s at most),
 * looking again every 2 s: a start still on its way to the host is found when it lands, and a loop of reads of an
 * id that never started goes at the pace of its own wait, not as fast as the 404s come back
 * (2026-11-22: one task's script read an id 201 times in 105 s while its start was in flight).
 */
async function readOnceKnown(params: { job_id: string; offset?: number; wait_ms?: number }, caller: Caller, callerSid: string | undefined, host: string,
  waitFor: import('./host-exec-wait.js').WaitFor | null, t0: number): Promise<Record<string, unknown>> {
  const asked = typeof params.wait_ms === 'number' && params.wait_ms >= 0 ? params.wait_ms : waitFor ? HOST_WAIT_MAX_MS : 0
  // The unknown id is held at most UNKNOWN_HOLD_MAX_MS; once found, the read waits what is left of its own.
  const until = t0 + Math.min(asked, UNKNOWN_HOLD_MAX_MS)
  for (let again = false; ; again = true) {
    try {
      return await readOn(again ? { ...params, wait_ms: Math.max(0, t0 + asked - Date.now()) } : params, caller, callerSid, host, waitFor, t0)
    } catch (err) {
      if (!(err instanceof HostExecError && err.code === 'unknown_job')) throw err
      // A run Walnut started that the host dropped never comes back: no hold helps it.
      if (startedRun(String(params.job_id))?.taskId === caller.taskId) throw err
      // Room for one more look, and for its answer to get back inside the caller's own deadline.
      if (Date.now() + UNKNOWN_RECHECK_MS >= Math.min(until, Date.now() + budgetLeft(caller, t0) - 2_000)) throw err
      await new Promise((r) => setTimeout(r, UNKNOWN_RECHECK_MS))
    }
  }
}

async function readOn(params: { job_id: string; offset?: number; wait_ms?: number }, caller: Caller, callerSid: string | undefined, host: string,
  waitFor: import('./host-exec-wait.js').WaitFor | null, t0: number): Promise<Record<string, unknown>> {
  const waits = await import('./host-exec-wait.js')
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
  // The host's answer needs a moment to get back: the wait leaves it 2 s. With wait_for the wait
  // is relayed in reads of at most HOST_WAIT_MAX_MS, so it may be as long as host_exec's.
  const asked = typeof params.wait_ms === 'number' && params.wait_ms >= 0 ? params.wait_ms : waitFor ? HOST_WAIT_MAX_MS : 0
  const most = waitFor ? waits.WAIT_MAX_MS : HOST_WAIT_MAX_MS
  const wait = asked > 0 ? Math.max(0, Math.min(asked, most, budgetLeft(caller, t0) - 2_000)) : 0
  const fromOffset = typeof params.offset === 'number'
  // The call's own answer time (a session on another host) cut the wait asked for: the answer says so.
  const cut = asked > 0 && wait < Math.min(asked, most)
  // Only when the hold is what ended the wait: not a match, a pattern stopped as too slow, an error.
  const held = (out: Record<string, unknown>, w?: import('./host-exec-wait.js').WaitedFor) => (cut && out.running === true && waits.ranOut(w) ? { heldMs: Date.now() - t0 } : {})
  if (waitFor) {
    await waits.assertWaitSupported(conn, host, waitFor)
    const { reply, waitedFor } = await waits.waitOnJob(conn, host, caller, params.job_id, waitFor, { since: t0, within: wait, ...(fromOffset ? { offset: params.offset } : {}) })
    const out = await jobAnswer(host, params.job_id, reply, { fromOffset })
    return { ...out, ...held(out, waitedFor), waitedFor: await waits.shownWait(reply, out, waitedFor, waits.readAtOf(conn, host, caller, params.job_id, t0)) }
  }
  const reply = await readJob(conn, host, caller.taskId, {
    jobId: params.job_id, taskId: caller.taskId, ...(fromOffset ? { offset: params.offset } : {}), ...(wait ? { wait } : {}),
  }, wait + Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, t0) - wait)))
  if (!reply.ok) throw daemonError(reply, 'the host could not read the job')
  const out = await jobAnswer(host, params.job_id, reply, { fromOffset })
  // A read without wait_for waits a minute at most (2026-11-04 review: a refusal of a longer one cost a call).
  const capped = !cut && asked > most && out.running === true ? { waitCappedMs: most } : {}
  const repeat = fromOffset ? {} : repeatedTailRead(callerSid, host, params.job_id, out)
  return { ...out, ...held(out), ...capped, ...repeat }
}

/**
 * Each session's last tail read (no offset, no wait_for) of a running job: its next read of the
 * same job that finds the log no longer than then is marked `noNewOutput`, and an agent reads a
 * sentence and the output's last lines instead of the same tail again (ops/host-exec-shown.ts).
 * Keyed by the calling session, never the task: a subagent of the task has not read it. A session
 * that compacted lost what it read; nothing tells this server cheaply, so the quiet answer always
 * carries the last lines and the read that shows all of it. 2026-11-21: 27% of host_exec_read
 * calls in seven days repeated the previous call's exact arguments within 30 minutes.
 */
const lastTailRead = new Map<string, { outputBytes: number; at: number }>()
const TAIL_READ_KEEP_MS = 30 * 60_000
const TAIL_READ_MAX = 2_000

export function repeatedTailRead(callerSid: string | undefined, host: string, jobId: string, out: Record<string, unknown>): { noNewOutput?: { sinceMs: number } } {
  // Per calling session: another session of the task has not read it; a caller with no session gets the plain answer.
  const sid = callerSid?.trim()
  if (!sid) return {}
  const key = `${sid}\u0000${host}\u0000${jobId}`
  const now = Date.now()
  const before = lastTailRead.get(key)
  lastTailRead.delete(key)
  if (typeof out.outputBytes !== 'number' || out.running !== true) return {}
  lastTailRead.set(key, { outputBytes: out.outputBytes, at: now })
  // The oldest reads go first (a Map keeps insertion order, and each read is put back at the end).
  for (const k of lastTailRead.keys()) {
    if (lastTailRead.size <= TAIL_READ_MAX) break
    lastTailRead.delete(k)
  }
  if (!before || now - before.at > TAIL_READ_KEEP_MS || before.outputBytes !== out.outputBytes) return {}
  return { noNewOutput: { sinceMs: now - before.at } }
}

/** Stop a running job (its whole process group). */
export async function stopHostJob(params: { host: string; job_id: string }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  const { revoked } = await mayTendRuns(caller, host)
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
  const reply = await ask(conn, host, 'exec.kill', { jobId: params.job_id, taskId: caller.taskId }, Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, t0))))
  if (!reply.ok) {
    const err = daemonError(reply, 'the host could not stop the job')
    throw err.code === 'unknown_job' ? await unknownJob(err, caller, host, String(params.job_id), 'stop') : err
  }
  const running = reply.running === true
  // A job that had already ended says how, so its stop is not read as one in flight.
  const ended = running ? {} : {
    exitCode: typeof reply.exitCode === 'number' ? reply.exitCode : null,
    signal: typeof reply.signal === 'string' ? reply.signal : null,
    timedOut: reply.timedOut === true, killed: reply.killed === true,
    ...(typeof reply.ms === 'number' ? { ms: reply.ms } : {}),
  }
  // Under a revoked grant only stop and list reach the run: the answer says so, for the next step.
  return { host, jobId: params.job_id, running, stopping: running, ...ended, ...(revoked ? { grantRevoked: true } : {}) }
}

/** One job in the list. */
export interface HostJobRow {
  jobId: string
  command: string | null
  startedAt: string
  running: boolean | null
  /**
   * running, exited, timed_out (its deadline), stopped (asked), blocked (at a dialog), gone (the
   * host no longer holds it), unknown (the host did not answer)
   */
  state: 'running' | 'exited' | 'timed_out' | 'stopped' | 'blocked' | 'gone' | 'unknown'
  exitCode: number | null
  signal: string | null
  ms: number | null
  logFile: string | null
  blocked?: unknown
}

function stateOf(j: Record<string, unknown>): HostJobRow['state'] {
  if (j.running === true) return 'running'
  if (j.blocked && typeof j.blocked === 'object') return 'blocked'
  if (j.timedOut === true) return 'timed_out'
  if (j.killed === true) return 'stopped'
  return 'exited'
}

/**
 * This task's jobs on `host`, newest first: every running one and the latest that ended. A host
 * that does not answer leaves the jobs this server started, with their state unknown.
 */
export async function listHostJobs(params: { host: string }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  const { revoked, grantId } = await mayTendRuns(caller, host)
  const cutoff = Date.now() - RECORD_MAX_AGE_MS
  const mine = (started.get(keyOf(caller.taskId, host)) ?? []).filter((r) => r.startedAt >= cutoff)
  const byId = new Map(mine.map((r) => [r.jobId, r]))
  let fromHost: Array<Record<string, unknown>> | null = null
  let away: string | null = null
  try {
    const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
    const reply = await ask(conn, host, 'exec.list', { taskId: caller.taskId }, Math.max(1_000, Math.min(LIST_MS, budgetLeft(caller, t0) - 1_000)))
    if (!reply.ok || !Array.isArray(reply.jobs)) throw daemonError(reply, 'the host could not list its jobs')
    fromHost = (reply.jobs as Array<Record<string, unknown>>).filter((j) =>
      typeof j.jobId === 'string' && (typeof j.taskId === 'string' ? j.taskId === caller.taskId : byId.has(j.jobId)))
  } catch (err) {
    // A host too old to run commands for others has no jobs to list; one that is away still has the record.
    if (err instanceof HostExecError && err.code !== 'host_offline') throw err
    away = err instanceof Error ? err.message : String(err)
  }
  const rows: HostJobRow[] = []
  const seen = new Set<string>()
  for (const j of fromHost ?? []) {
    const id = String(j.jobId)
    seen.add(id)
    const startedAt = typeof j.startedAt === 'number' ? j.startedAt : byId.get(id)?.startedAt ?? Date.now()
    rows.push({
      jobId: id,
      // The command as the task gave it (the host holds the line it ran, strict:true's wrapped one too).
      command: byId.get(id)?.command ?? (typeof j.command === 'string' ? j.command : null),
      startedAt: new Date(startedAt).toISOString(),
      running: j.running === true,
      state: stateOf(j),
      exitCode: typeof j.exitCode === 'number' ? j.exitCode : null,
      signal: typeof j.signal === 'string' ? j.signal : null,
      ms: typeof j.ms === 'number' ? j.ms : null,
      logFile: typeof j.logFile === 'string' ? j.logFile : null,
      ...(j.blocked && typeof j.blocked === 'object' ? { blocked: j.blocked } : {}),
    })
  }
  for (const r of mine) {
    if (seen.has(r.jobId)) continue
    rows.push({
      jobId: r.jobId, command: r.command, startedAt: new Date(r.startedAt).toISOString(),
      // The host answered without it: it ended over an hour ago, or the host restarted since.
      running: fromHost ? false : null, state: fromHost ? 'gone' : 'unknown', exitCode: null, signal: null, ms: null, logFile: null,
    })
  }
  rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const endedAll = rows.filter((r) => r.running !== true)
  const kept = [...rows.filter((r) => r.running === true), ...endedAll.slice(0, LIST_ENDED_MAX)]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  // A command line can hold a secret: the same filter as the output.
  for (const r of kept) if (r.command) r.command = (await redact(r.command)).text
  // The task's grant there, so host_exec_pinned can name it without another lookup (2026-11-05 review).
  // grantId first: host_exec_pinned's help sends a caller here for it (2026-11-05 review 12).
  return { host, ...(grantId ? { grantId } : {}), jobs: kept, ...(endedAll.length > LIST_ENDED_MAX ? { endedOf: endedAll.length } : {}), ...(away ? { hostAway: away } : {}), ...(revoked ? { grantRevoked: true } : {}) }
}

/** Tests: forget the record. */
export function resetHostJobsForTest(): void {
  started.clear()
  byJob.clear()
  lastTailRead.clear()
}
