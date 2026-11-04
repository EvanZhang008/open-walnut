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
  HOST_WAIT_MAX_MS, LIST_MS, REPLY_MARGIN_MS, ask, budgetLeft, callerOf, daemonError, dial, grantFor, HostExecError, jobAnswer, readJob, redact, targetHost,
} from './host-exec.js'
import { mayTendRuns } from './host-exec-grant.js'

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
  return { ...out, ...held(out), ...capped }
}

/** Stop a running job (its whole process group). */
export async function stopHostJob(params: { host: string; job_id: string }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  const { revoked } = await mayTendRuns(caller, host)
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
  const reply = await ask(conn, host, 'exec.kill', { jobId: params.job_id, taskId: caller.taskId }, Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, t0))))
  if (!reply.ok) throw daemonError(reply, 'the host could not stop the job')
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
}
