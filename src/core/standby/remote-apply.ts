/**
 * An apply on the standby host as a background job (remote-transport.ts): started with the
 * daemon's `exec.run` (background, up to the daemon's 2 h for one), then followed through the
 * status file the apply keeps there (apply-status.ts). No command stays open for the apply's
 * length, so a long apply is not stopped at a command's limit (exec.script's 10 minutes).
 *
 * One batch is one job id: a start sent again (its answer lost) is refused `job_exists` by the
 * daemon, which knows the ids of the runs it and its predecessor ran, so an apply never runs twice.
 * A job that ended without writing `done` or `failed` (killed there, the host restarted) is a
 * failed apply: the target's own recovery (its journal) leaves the batch before whole.
 */
import { HEARTBEAT_STALE_MS, parseStatus, type ApplyStatus } from './apply-status.js'

/** The daemon's limit for one background run (src/providers/host-exec-core.ts BACKGROUND_MAX_MS). */
export const APPLY_MAX_MS = 2 * 60 * 60_000
const GROUP_CAPABILITY = 'host-exec-group-v1'

export interface ApplyJobLink {
  /** One daemon command, sent again over a new link while the link is down; a refusal throws with its `code`. */
  call(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  /** The status file's text, or null while it is not there. */
  readText(file: string): Promise<string | null>
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
  maxMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const refusedCode = (err: unknown) => (err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '')

/** Start the apply (once) and wait for its answer. */
export async function runApplyJob<T>(link: ApplyJobLink, job: ApplyJob): Promise<T> {
  const maxMs = job.maxMs ?? APPLY_MAX_MS
  try {
    const detach = await link.detach()
    await link.call('exec.run', {
      jobId: job.jobId, argv: job.argv, background: true, timeoutMs: maxMs,
      ...(link.hasCapability(GROUP_CAPABILITY) ? { endGroup: true } : {}),
      ...(detach ? { detach: true } : {}),
    })
  } catch (err) {
    // Started already (this start sent again after its answer was lost): follow it.
    if (refusedCode(err) !== 'job_exists') throw err
  }
  const started = Date.now()
  let heardAt = started
  for (let n = 0; ; n++) {
    await sleep(job.pollMs ?? (n < 10 ? 2_000 : 5_000))
    const status = await readStatus(link, job.statusFile)
    if (status?.state === 'done') return status.answer as T
    if (status?.state === 'failed') throw new Error(`the apply there failed: ${status.error}`)
    if (status?.state === 'running' && Date.now() - Date.parse(status.at) < HEARTBEAT_STALE_MS) heardAt = Date.now()
    // Still running? A job killed there ends without writing its answer.
    const ended = await jobEnded(link, job.jobId)
    if (ended === 'running') heardAt = Date.now()
    else if (ended !== null) {
      // Its last write may have landed just before it ended.
      const last = await readStatus(link, job.statusFile)
      if (last?.state === 'done') return last.answer as T
      if (last?.state === 'failed') throw new Error(`the apply there failed: ${last.error}`)
      throw new Error(`the apply there ended without an answer (${ended})`)
    }
    // A daemon that cannot say (it forgot the job): the heartbeat decides.
    if (Date.now() - heardAt > 2 * HEARTBEAT_STALE_MS) throw new Error('the apply there stopped answering (no heartbeat, and its job cannot be read)')
    if (Date.now() - started > maxMs + 60_000) throw new Error(`the apply there ran past ${Math.round(maxMs / 60_000)} minutes`)
  }
}

async function readStatus(link: ApplyJobLink, file: string): Promise<ApplyStatus | null> {
  const text = await link.readText(file)
  return text === null ? null : parseStatus(text)
}

/** Why the job ended (exit code or signal, and the tail of its output), 'running', or null when the daemon cannot say. */
async function jobEnded(link: ApplyJobLink, jobId: string): Promise<string | null> {
  let r: Record<string, unknown>
  try {
    r = await link.call('exec.read', { jobId, maxBytes: 4_000 })
  } catch (err) {
    // Finished jobs are kept for an hour; a daemon older than the job forgot it.
    if (refusedCode(err) === 'unknown_job') return null
    throw err
  }
  if (r.running !== false) return 'running'
  const how = r.signal ? `signal ${String(r.signal)}` : `exit ${String(r.exitCode ?? 'none')}`
  const tail = typeof r.output === 'string' ? r.output.trim().slice(-400) : ''
  return tail ? `${how}: ${tail}` : how
}
