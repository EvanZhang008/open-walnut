/**
 * An apply on the standby host as a background job (remote-transport.ts): started with the
 * daemon's `exec.run` (background, up to the daemon's 2 h for one), then followed through the
 * status file the apply keeps there (apply-status.ts). No command stays open for the apply's
 * length, so a long apply is not stopped at a command's limit (exec.script's 10 minutes).
 *
 * One batch is one job id: a start sent again (its answer lost) is refused `job_exists` by the
 * daemon, which knows the ids of the runs it and its predecessor ran, so an apply never runs twice.
 *
 * The leader hears the apply by its heartbeat changing (not by comparing clocks: the two machines'
 * clocks may differ). When it stops changing, the host is asked whether the apply's process still
 * lives (`walnut standby receive job`, judged there on that machine's clock); an apply that ended
 * without writing `done` or `failed` (killed there, the host restarted) is a failed apply, and the
 * target's own recovery (its journal) leaves the batch before whole. The daemon's job record is
 * never read: reading a job's output is a task's host_exec, under that task's grant.
 */
import { linkFailureKind, markLinkFailure } from '../../providers/link-failure.js'
import { parseStatus, type ApplyStatus } from './apply-status.js'

/** The daemon's limit for one background run (src/providers/host-exec-core.ts BACKGROUND_MAX_MS). */
export const APPLY_MAX_MS = 2 * 60 * 60_000
/** No new heartbeat for this long: ask the host whether the apply lives (it beats every 10 s). */
const LATE_MS = 20_000
const GROUP_CAPABILITY = 'host-exec-group-v1'
/** A daemon that runs commands for others at all (exec.run with argv, background and a job id). */
const EXEC_CAPABILITY = 'host-exec-v1'
/** Who the run is for, in the host's job log and the wait a daemon update shows (no task: no task folder there). */
const CALLER = { task: 'standby-copy' }

/** What the host says of a job: its status file, and whether its process lives with a fresh heartbeat there. */
export interface JobProbe { status: ApplyStatus | null; running: boolean }

export interface ApplyJobLink {
  /** One daemon command, sent again over a new link while the link is down; a refusal throws with its `code`. */
  call(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  /** The status file's text, or null while it is not there. */
  readText(file: string): Promise<string | null>
  /** Ask the host about the job whose status file this is. */
  probe(statusFile: string): Promise<JobProbe>
  hasCapability(name: string): boolean
  /** Run the job so it outlives the host's daemon (work-survives.ts), when the host and this server can. */
  detach(): Promise<boolean>
}

export interface ApplyJob {
  jobId: string
  argv: string[]
  statusFile: string
  /** How often the status is read (default 2 s at first, then 5 s). */
  pollMs?: number
  /** How long without a new heartbeat before the host is asked (default 20 s). */
  lateMs?: number
  maxMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const refusedCode = (err: unknown) => (err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '')

/** Start the apply (once) and wait for its answer. */
export async function runApplyJob<T>(link: ApplyJobLink, job: ApplyJob): Promise<T> {
  const maxMs = job.maxMs ?? APPLY_MAX_MS
  const lateMs = job.lateMs ?? LATE_MS
  try {
    // As host_exec runs one (src/core/hosts/host-exec.ts): a detached run also ends its group.
    const group = link.hasCapability(GROUP_CAPABILITY)
    const detach = group && await link.detach()
    await link.call('exec.run', {
      jobId: job.jobId, argv: job.argv, background: true, timeoutMs: maxMs, caller: CALLER,
      ...(group ? { endGroup: true } : {}),
      ...(detach ? { detach: true } : {}),
    })
  } catch (err) {
    // Started already (this start sent again after its answer was lost): follow it.
    if (refusedCode(err) !== 'job_exists') throw startFailed(err, link.hasCapability(EXEC_CAPABILITY))
  }
  // Until the apply writes its first status (its CLI starts, about a second), another op there is
  // not told "busy" and waits on the target's lock instead: safe (the apply checks its base), only slower.
  const started = Date.now()
  let heardAt = started
  let lastBeat = ''
  for (let n = 0; ; n++) {
    await sleep(job.pollMs ?? (n < 10 ? 2_000 : 5_000))
    const status = await readStatus(link, job.statusFile)
    const final = answerOf<T>(status)
    if (final) return final.answer
    if (status?.state === 'running' && status.at !== lastBeat) { lastBeat = status.at; heardAt = Date.now() }
    if (Date.now() - heardAt < lateMs) continue
    // No new heartbeat: does its process still live there?
    const probe = await link.probe(job.statusFile)
    const last = answerOf<T>(probe.status)
    if (last) return last.answer
    if (probe.running) { heardAt = Date.now(); continue }
    if (!probe.status) throw new Error(`the apply there never started (no status after ${Math.round((Date.now() - started) / 1000)} s)`)
    throw new Error(`the apply there ended without an answer (its process ${probe.status.state === 'running' ? probe.status.pid : '?'} is gone; last heard at ${probe.status.at})`)
  }
}

/** Why the start failed, with the likely cause when the host's daemon does not say it runs commands. */
function startFailed(err: unknown, canRun: boolean): Error {
  const why = err instanceof Error ? err.message : String(err)
  const kind = linkFailureKind(err)
  const e = Object.assign(new Error(`the standby host could not start the apply: ${why}${canRun || kind ? '' : ` (its Walnut daemon does not say it runs background commands, ${EXEC_CAPABILITY}: update Walnut on that host)`}`), { code: refusedCode(err) || undefined })
  // A lost link stays a lost link for the caller's own checks.
  return kind ? markLinkFailure(e, kind) : e
}

/** `done` as its answer, `failed` as an error; null while it runs. */
function answerOf<T>(status: ApplyStatus | null): { answer: T } | null {
  if (status?.state === 'done') return { answer: status.answer as T }
  if (status?.state === 'failed') throw new Error(`the apply there failed: ${status.error}`)
  return null
}

async function readStatus(link: ApplyJobLink, file: string): Promise<ApplyStatus | null> {
  const text = await link.readText(file)
  return text === null ? null : parseStatus(text)
}
