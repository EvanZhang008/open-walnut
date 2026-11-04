/**
 * This machine's own daemon service, as the server (local-daemon.ts) handles it:
 *
 *   update   `walnut daemon update` runs in the detached runner every remote update uses
 *            (daemon-net-update-io.ts runDetachedUpdate), the tail after it
 *            (daemon-update-tail.ts), out of the server's process group and off its pipes.
 *            2026-11-04 review: it ran as the server's own child, so a deploy that stopped
 *            the server between the bootout and the bootstrap left no LaunchAgent loaded,
 *            and the next server then refused to start a daemon beside the service.
 *            Its record (the runner's dir and the build) is kept from the launch on, until it
 *            was read (daemon-update-readback.ts unreadUpdates): a server restarted mid-update
 *            (a deploy) reads it back before it tries again, so a build that failed there is
 *            held its day and the dir removed (2026-11-04 review 4: nothing was kept, and the
 *            next server stopped the healthy daemon once more for the same build).
 *   revive   a service whose config is on disk while nothing of it runs (that gap, a unit
 *            past systemd's start limit, a cron supervisor that gave up) is loaded or
 *            started the way the tail does it, under the service install lock, before the
 *            server refuses to start a daemon of its own. Never while an update's runner
 *            is at work: its own tail decides.
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import { NetUpdateHeldError, runDetachedUpdate, shq, type DetachedUpdateHost, type NetUpdateIoOptions } from './daemon-net-update-io.js'
import { judgeServiceUpdate } from './daemon-service-update.js'
import { readBackUpdate, unreadUpdates } from './daemon-update-readback.js'
import { writeBuildBackoff } from './daemon-build-backoff.js'
import { parseUpdateTail, REVIVE_UPDATING, reviveScript, TAIL_STAY_SECONDS, type UpdateTail } from './daemon-update-tail.js'
import { JOB_GONE_BY_MS } from './daemon-service-launchd.js'
import { laterLines, LOCK_WAIT_SECONDS } from './daemon-update-shell.js'
import { parseProbing, probingCheckScript } from './daemon-update-probation.js'
import { daemonBusyRefusal } from './exec-runs-hold.js'
import { OVER_BUSY_FLAG } from './daemon-over-busy.js'

/** The runner's own dir: the name every update path checks (daemon-net-update-io.ts STAGING). */
const STAGING_PREFIX = '/tmp/open-walnut-update.'
/** How long the revive waits for a daemon after it loaded the service. */
export const REVIVE_WAIT_SECONDS = 30

export interface LocalServiceOptions extends NetUpdateIoOptions {
  /** The environment the runner and the tail run in (tests: stand-in launchctl and systemctl, a HOME of their own). */
  env?: NodeJS.ProcessEnv
  /**
   * Keep this update's record under `key` from its launch, for the build `expected` (the server's
   * LocalDaemon). A failure of the build (buildFailed) also writes its day's hold under `key`
   * (daemon-build-backoff.ts), before the record and its dir go: a server killed in between keeps
   * one of them, never neither (2026-11-04 review 5).
   */
  record?: { key: string; expected: string }
  /** An overdue update: the CLI goes over the daemon's own work (daemon-over-busy.ts). */
  overBusy?: boolean
}

/** This machine as a DetachedUpdateHost: a line in /bin/sh (never a login shell), files written and read directly. */
export function localServiceHost(env: NodeJS.ProcessEnv = process.env): DetachedUpdateHost {
  return {
    run: (command, timeoutMs = 30_000) => new Promise((resolve, reject) => {
      execFile('/bin/sh', ['-c', command], { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${String(stdout).trim()} ${String(stderr).trim() || error.message}`.trim()))
        else resolve(String(stdout).trim())
      })
    }),
    async writeFile(file, data) {
      try {
        await fsp.writeFile(`${file}.tmp`, data, { mode: 0o600 })
        await fsp.rename(`${file}.tmp`, file)
        return true
      } catch { return false }
    },
    readText: (file) => fsp.readFile(file, 'utf8').catch(() => null),
  }
}

/**
 * Update this machine's service to `executable` (the daemon binary or the compiled walnut
 * file). 'busy': the daemon refused before anything changed, or another update or the last
 * one's probation is at work (asked again later); 'deferred': launchd starts no jobs now (a dark
 * wake), so nothing was stopped. Throws with the reason, the tail's words
 * included, when the update did not leave the new daemon serving.
 */
export async function updateLocalService(executable: string, scope: 'user' | 'cron', opts: LocalServiceOptions = {}): Promise<'applied' | 'busy' | 'deferred'> {
  // 2026-11-04 review: a server restarted by a deploy mid-update started a second runner beside
  // the first. The launcher refuses too (another server, a race); this asks first, for free.
  // An update a server before this one launched, and did not live to read (a deploy restarted it).
  if (opts.record && (await readBackEarlier(opts.record, opts.env)) === 'running') return 'busy'
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  // The last update's probation still watches its daemon: its copies are the way back from a build
  // that fails late, and this update's snapshot would take them (2026-11-05 review 6).
  if (await updateRunning(opts.latestMarker ?? `/tmp/open-walnut-update-latest-${uid}`, scope, opts.env)) return 'busy'
  const directory = await fsp.mkdtemp(STAGING_PREFIX)
  let keep = false
  let launched = false
  try {
    const command = `${shq(executable)} walnut daemon update --yes --scope ${scope} --executable ${shq(executable)}${opts.overBusy ? ` ${OVER_BUSY_FLAG}` : ''}`
    const onLaunched = (dir: string) => {
      launched = true
      if (opts.record) void unreadUpdates.write(opts.record.key, { at: Date.now(), directory: dir, expected: opts.record.expected })
      opts.onLaunched?.(dir)
    }
    // One try: a busy daemon is asked again on the server's upgrade clock. No settle: no exec job started it.
    const answer = await runDetachedUpdate(localServiceHost(opts.env), { command, directory, executable, scope, build: opts.record?.expected }, { tries: 1, pollMs: 1_000, settleSeconds: 0, ...opts, onLaunched })
    if (daemonBusyRefusal(answer.output)) return 'busy'
    if (answer.output.includes('"launchdNotSpawning"')) return 'deferred'
    return judgeServiceUpdate(answer.output, answer.tail)
  } catch (error) {
    // Another update's runner is at work: nothing was started, asked again on the upgrade clock.
    if (error instanceof NetUpdateHeldError) return 'busy'
    // The server stopped waiting: the runner's record stays for whoever looks.
    keep = (error as { keepStaging?: unknown } | null)?.keepStaging === true
    if (opts.record && (error as { buildFailed?: unknown } | null)?.buildFailed === true) await holdBuild(opts.record, error)
    throw error
  } finally {
    if (!keep) await fsp.rm(directory, { recursive: true, force: true }).catch(() => {})
    // Read here (and a failed build held above), so not left to read back.
    if (opts.record && launched && !keep) void unreadUpdates.write(opts.record.key, null)
  }
}

/**
 * The record of an update a server before this one launched (`record.key`), read back once its
 * runner is done: 'running' while it may still work; it throws a failure of this same build that
 * stopped the daemon (buildFailed: the caller's day off), as an answer in time would.
 */
async function readBackEarlier(record: { key: string; expected: string }, env?: NodeJS.ProcessEnv): Promise<'running' | null> {
  const u = await unreadUpdates.read(record.key)
  if (!u) return null
  const failure = (message: string, tail?: string | null) => Object.assign(new Error(`an update a server before this one started did not go through: ${message}`), { buildFailed: true, tailOutcome: tail ?? null })
  const sameFailed = (b: { applied: boolean; buildFailed: boolean }) => !b.applied && b.buildFailed && u.expected === record.expected
  // A build that failed holds its day before its dir goes (readBackUpdate's `decided`), then the record.
  const back = await readBackUpdate(localServiceHost(env), u, Date.now(), async (read) => {
    if (sameFailed(read)) await holdBuild(record, failure(read.message, read.record.tail?.outcome))
  })
  if (back.state === 'running') return 'running'
  await unreadUpdates.write(record.key, null)
  if (back.state === 'read' && sameFailed(back)) throw failure(back.message, back.record.tail?.outcome)
  return null
}

/** The day's hold of a build that stopped the daemon and did not stay serving, under the record's key (as LocalDaemon keeps it). */
async function holdBuild(record: { key: string; expected: string }, error: unknown): Promise<void> {
  await writeBuildBackoff(record.key, { expected: record.expected, at: Date.now(), reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) })
}

export interface ReviveOptions {
  env?: NodeJS.ProcessEnv
  waitSeconds?: number
  /** The runner's latest marker (daemon-net-update-io.ts); tests point it elsewhere. */
  latestMarker?: string
  lockWaitSeconds?: number
  standInCheckSeconds?: number
}

/**
 * Load or start the service when its config is on disk and nothing of it runs, the tail's
 * way (daemon-update-tail.ts reviveScript: under the install lock, a launchd job loaded and
 * idle kickstarted, a stand-in when launchd starts nothing). 'updating': an update's runner
 * is at work, so nothing was done. Otherwise the tail's record: 'loaded', 'serving' or
 * 'standin' means a daemon answers now.
 */
export async function reviveLocalService(scope: 'user' | 'cron', opts: ReviveOptions = {}): Promise<UpdateTail | 'updating'> {
  return reviveServiceOn((command, timeoutMs) => localServiceHost(opts.env).run(command, timeoutMs), scope, opts)
}

/** The revive on any host: `run` runs one sh line there (this machine, or SSH: daemon-connection.ts). */
export async function reviveServiceOn(
  run: (command: string, timeoutMs: number) => Promise<string>, scope: 'user' | 'cron', opts: Omit<ReviveOptions, 'env'> = {},
): Promise<UpdateTail | 'updating'> {
  const wait = opts.waitSeconds ?? REVIVE_WAIT_SECONDS
  const script = reviveScript({ scope, waitSeconds: wait, lockWaitSeconds: opts.lockWaitSeconds, standInCheckSeconds: opts.standInCheckSeconds, latest: opts.latestMarker })
  // Its longest path: two lock waits (dropping stale copies, then the check), the wait, the stay, a
  // put-back's bootout (launchd's ExitTimeOut), the wait and the stay again. Cut short, a put-back
  // could stop between its bootout and its load (2026-11-04 review 7: the budget had one lock wait).
  const lock = opts.lockWaitSeconds ?? LOCK_WAIT_SECONDS
  const said = await run(script, (2 * lock + 2 * (wait + TAIL_STAY_SECONDS) + Math.ceil(JOB_GONE_BY_MS / 1000) + 60) * 1000).catch(() => '')
  if (said.includes(REVIVE_UPDATING)) return 'updating'
  return parseUpdateTail(said) ?? { outcome: 'down', words: 'the check of the service did not finish' }
}

/** The tail's record says a daemon answers now. */
export function reviveServes(answer: UpdateTail | 'updating'): boolean {
  return answer !== 'updating' && (answer.outcome === 'serving' || answer.outcome === 'loaded' || answer.outcome === 'restored' || answer.outcome === 'standin')
}

/**
 * The latest marker names another runner at work, or a probation is at work in the install root:
 * the shell's own rules (daemon-update-shell.ts t_later, daemon-update-probation.ts t_probing).
 */
async function updateRunning(marker: string, scope: 'user' | 'cron', env?: NodeJS.ProcessEnv): Promise<boolean> {
  const later = /^\/[A-Za-z0-9._/-]+$/.test(marker) ? [`L='${marker}'; d=`, ...laterLines(), 't_later && echo walnut-runner-at-work'] : []
  const said = await localServiceHost(env).run([...later, probingCheckScript(scope)].join('\n'), 15_000).catch(() => '')
  return said.includes('walnut-runner-at-work') || parseProbing(said) !== null
}
