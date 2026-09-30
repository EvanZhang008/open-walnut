/**
 * A server that loses the instance lock while running as the deploy's launchd
 * job removes that job before it exits, so launchd cannot relaunch it.
 *
 * Why (2026-09-25, 02:42 to 09:36Z): scripts/dev-prod.sh starts the production
 * server with `launchctl submit`, which implies KeepAlive. The deploy killed the
 * server the Mac app had started, and the Mac app's own auto-restart spawned a
 * replacement one second later. That replacement won the instance lock, so the
 * job's server exited as a duplicate, and launchd relaunched it about every 11s
 * for seven hours: about two thousand duplicate boots, each of which ran part
 * of the startup (daemon connect, recovery passes) before it reached the lock.
 * A duplicate exit is not a crash that a restart can fix; it is final while the
 * other server lives. So the duplicate takes its own job down with it.
 *
 * Safety: removing a launchd job kills its process, and the production server's
 * environment (WALNUT_LAUNCHD_LABEL, and the XPC_SERVICE_NAME launchd exports) is
 * inherited by every daemon, CLI session and shell under it. A server started by
 * hand from one of those shells that hit the lock would otherwise remove the
 * PRODUCTION job. Environment is therefore only a cheap prefilter; the decision
 * rests on launchd's own answer: `launchctl list <label>` must report THIS pid.
 */

import { execFile } from 'node:child_process'
import { log } from '../logging/index.js'
import { flushLogBufferNow } from '../logging/logger.js'

export type LaunchctlExec = (args: string[]) => Promise<string>

/** Bounded, async (never blocks the event loop), stdout only. */
const defaultExec: LaunchctlExec = (args) => new Promise((resolve, reject) => {
  execFile('launchctl', args, { timeout: 5_000 }, (err, stdout) => {
    if (err) reject(err)
    else resolve(String(stdout))
  })
})

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The job label this process claims to run under, or null (env prefilter only). */
export function claimedLaunchdLabel(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'darwin') return null
  const label = env.WALNUT_LAUNCHD_LABEL?.trim()
  if (!label || !LABEL_RE.test(label)) return null
  // launchd exports XPC_SERVICE_NAME=<label> to every process it spawns for a job.
  if (env.XPC_SERVICE_NAME !== label) return null
  return label
}

/** The PID launchd reports for a job, from `launchctl list <label>` output. */
export function parseLaunchdJobPid(listOutput: string): number | null {
  const m = /"PID"\s*=\s*(\d+);/.exec(listOutput)
  return m ? Number(m[1]) : null
}

export interface SelfRemoveOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  pid?: number
  exec?: LaunchctlExec
  /** Puts the buffered log on disk (tests stub it). */
  flushLog?: () => Promise<void>
}

export type SelfRemoveOutcome =
  | 'not-a-launchd-job'
  | 'job-not-listed'
  | 'not-the-job-process'
  | 'removed'
  | 'remove-failed'

/**
 * Remove this process's own launchd job. Called only on the duplicate-server
 * exit path. Never throws. Note that a successful `launchctl remove` makes
 * launchd SIGTERM this process, which is the exit it was about to take anyway.
 */
export async function removeOwnLaunchdJob(reason: string, opts: SelfRemoveOptions = {}): Promise<SelfRemoveOutcome> {
  const label = claimedLaunchdLabel(opts.env, opts.platform)
  if (!label) return 'not-a-launchd-job'
  const exec = opts.exec ?? defaultExec
  const pid = opts.pid ?? process.pid
  let jobPid: number | null
  try {
    jobPid = parseLaunchdJobPid(await exec(['list', label]))
  } catch {
    return 'job-not-listed'
  }
  if (jobPid !== pid) {
    log.web.info('duplicate server: its launchd label belongs to another process, leaving the job alone', {
      label, jobPid, pid,
    })
    return 'not-the-job-process'
  }
  // Logged BEFORE the remove, and FLUSHED: launchd SIGTERMs this process before
  // the call returns, and the file logger only writes every 2s, so an entry left
  // in its buffer never reached the log (seen on a real job: the line was only in
  // the job's stdout).
  log.web.warn('duplicate server: removing its own launchd job so KeepAlive cannot relaunch it', {
    label, pid, reason: reason.slice(0, 300),
  })
  await (opts.flushLog ?? flushLogBufferNow)().catch(() => { /* best-effort */ })
  try {
    await exec(['remove', label])
    return 'removed'
  } catch (err) {
    log.web.error('duplicate server: could not remove its own launchd job', {
      label, error: err instanceof Error ? err.message : String(err),
    })
    return 'remove-failed'
  }
}
