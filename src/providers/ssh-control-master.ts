/**
 * The SSH ControlMaster a host's DaemonConnection multiplexes through, kept
 * across server restarts.
 *
 * Why it must outlive the server process (2026-10-07): the user's SSH
 * certificate expired at 04:45, but the master the server had authenticated at
 * 04:38 kept the host working, as an established SSH connection does. A deploy at
 * 05:09 restarted the server, and the old process sent `-O exit` on the way out;
 * the new one built its socket path from its own pid, so it had to authenticate
 * again, could not, and every session on that host stopped answering. An agent
 * deploys many times a day; none of them should cost the user a login.
 *
 * So the socket path is stable for one data dir and one SSH target, a server that
 * stops leaves the master running (ControlPersist ends it once nothing uses it),
 * and the next connect, in a new process or after a dropped tunnel, reuses a
 * master it can verify: a socket owned by this user that answers `-O check` and
 * carries a command. A different data dir (a test server) or a changed
 * hostname for the alias gets a different path, so it never multiplexes into
 * someone else's connection or the old machine.
 *
 * One more thing a reused master carries: forwards. A `-L` asked for through the
 * master is held BY the master, and stays after the client that asked for it is
 * gone (checked against OpenSSH 10.3). Each forward this data dir opens is listed
 * beside the socket and cancelled when the next process takes the master over,
 * so restarts do not pile listeners up in it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSshBounded, type SshRun } from './remote-sh.js'

export type SshRunner = (args: string[], opts: { timeoutMs: number }) => Promise<SshRun>

/** How long `-O check` / `-O cancel` may take: they talk to a local socket, never the network. */
export const MASTER_CONTROL_TIMEOUT_MS = 5_000
/** How long a new master may take to connect and authenticate. */
export const MASTER_START_TIMEOUT_MS = 15_000
/** How long an unused master lives on, which is what carries it across a restart. */
export const MASTER_PERSIST_SECS = 300

/** Room left in a unix socket path (sun_path is 104 bytes on macOS, NUL included). */
const MAX_SOCKET_PATH = 100

export interface MasterTarget {
  /** The host alias (`clouddev`): readable part of the socket name only. */
  hostKey: string
  /** Everything that decides which machine the connection reaches: user@hostname and port. */
  target: string
  /** The data dir of the Walnut that owns the connection. */
  home: string
}

/** The control socket for one data dir and one SSH target, the same in every server process. */
export function controlSocketPath(t: MasterTarget, dir: string = os.tmpdir()): string {
  const digest = crypto.createHash('sha256').update(`${path.resolve(t.home)}\0${t.target}`).digest('hex').slice(0, 12)
  // ssh expands `%` tokens in ControlPath, so only plain characters reach it.
  const alias = t.hostKey.replace(/[^A-Za-z0-9._-]/g, '_')
  const fixed = path.join(dir, `walnut-ssh--${digest}`).length
  return path.join(dir, `walnut-ssh-${alias.slice(0, Math.max(1, MAX_SOCKET_PATH - fixed))}-${digest}`)
}

/** Where the forwards opened through the master at `socketPath` are listed. */
export function forwardsFile(socketPath: string): string {
  return `${socketPath}.forwards`
}

export type MasterState =
  | 'live'       // ours, and a command through it came back: multiplex through it
  | 'absent'     // nothing there: start one
  | 'stale'      // ours but dead, or alive with a link that refuses to carry anything
  | 'foreign'    // not a socket this user owns: never use it, never remove it
  | 'unanswered' // ours, but the check or the command through it did not come back in time

/** How long the command that proves a master's link still carries traffic may take. */
export const MASTER_VERIFY_TIMEOUT_MS = 8_000
/**
 * How long a master that did not answer gets on a second look. Past ServerAlive's
 * 45 s (15 s x 3, set at start): a master whose link died ends itself by then, so
 * what still has not answered is slow, not dead.
 */
export const MASTER_PATIENT_VERIFY_TIMEOUT_MS = 50_000

/**
 * What sits at `socketPath`, and whether this process may multiplex through it.
 *
 * `-O check` only asks the master process; after a sleep or a network change the
 * process is still there while its TCP link is dead, and every command through
 * it would hang. So a master is live only once a `true` run through it answered.
 */
export async function probeControlMaster(
  socketPath: string,
  sshArgs: string[],
  host: string,
  opts: { run?: SshRunner; uid?: number; verifyTimeoutMs?: number } = {},
): Promise<MasterState> {
  let st: fs.Stats
  try {
    st = fs.lstatSync(socketPath)
  } catch {
    return 'absent'
  }
  // A path in a shared tmp dir can be planted by another user: a master is only
  // trusted when this user made the socket.
  const uid = opts.uid ?? process.getuid?.()
  if (!st.isSocket() || uid === undefined || st.uid !== uid) return 'foreign'
  const run = opts.run ?? runSshBounded
  const control = ['-o', `ControlPath=${socketPath}`]
  const check = await run([...sshArgs, ...control, '-O', 'check', host], { timeoutMs: MASTER_CONTROL_TIMEOUT_MS })
  if (check.timedOut) return 'unanswered'
  if (check.code !== 0) return 'stale'
  // ControlMaster=no: a mux client only, so a master that just died cannot turn
  // this into a fresh login (BatchMode would refuse one anyway).
  const verify = await run([...sshArgs, ...control, '-o', 'ControlMaster=no', host, 'true'], {
    timeoutMs: opts.verifyTimeoutMs ?? MASTER_VERIFY_TIMEOUT_MS,
  })
  if (verify.timedOut) return 'unanswered'
  return verify.code === 0 ? 'live' : 'stale'
}

export type MasterPlan =
  | { action: 'reuse'; state: MasterState; patient?: boolean }
  | { action: 'start'; state: MasterState; replaced?: 'stale' | 'unanswered' }
  | { action: 'fallback'; state: MasterState; reason: 'foreign' | 'unanswered' }

/**
 * What a connect does with the master at `socketPath`: reuse it, start one (after
 * ending a dead one), or connect without one. Ends a master only when it is dead,
 * or when it did not answer AND a fresh login works, so nothing is lost by it.
 *
 * Slow is not dead. A master that did not answer in time used to be ended like a
 * dead one, but on a starved machine (load over 150 is common here) or a remote
 * slow to run a shell, a live master misses an 8 s budget, and once the SSH
 * credential that made it has expired, ending it is the one step nothing undoes
 * (2026-10-08: the first deploy after the certificate expired lost the host).
 */
export async function planControlMaster(
  socketPath: string,
  sshArgs: string[],
  host: string,
  opts: { run?: SshRunner; uid?: number } = {},
): Promise<MasterPlan> {
  const state = await probeControlMaster(socketPath, sshArgs, host, opts)
  if (state === 'live') return { action: 'reuse', state }
  if (state === 'foreign') return { action: 'fallback', state, reason: 'foreign' }
  if (state === 'absent') return { action: 'start', state }
  if (state === 'stale') {
    await removeStaleMaster(socketPath, sshArgs, host, opts)
    return { action: 'start', state, replaced: 'stale' }
  }
  // Unanswered. When a new login works, a new master costs nothing: replace it.
  if (await freshLoginWorks(sshArgs, host, opts)) {
    await removeStaleMaster(socketPath, sshArgs, host, opts)
    return { action: 'start', state, replaced: 'unanswered' }
  }
  // It is the only way in: look again, longer than a dead link survives.
  const again = await probeControlMaster(socketPath, sshArgs, host, { ...opts, verifyTimeoutMs: MASTER_PATIENT_VERIFY_TIMEOUT_MS })
  if (again === 'live') return { action: 'reuse', state, patient: true }
  if (again === 'stale') {
    await removeStaleMaster(socketPath, sshArgs, host, opts)
    return { action: 'start', state, replaced: 'stale' }
  }
  if (again === 'absent') return { action: 'start', state }
  // Still no answer (or no longer ours): keep it for the next connect to try.
  return { action: 'fallback', state, reason: again === 'foreign' ? 'foreign' : 'unanswered' }
}

/** Whether a new SSH connection, without any master, authenticates now. */
async function freshLoginWorks(sshArgs: string[], host: string, opts: { run?: SshRunner }): Promise<boolean> {
  const run = opts.run ?? runSshBounded
  const res = await run([...sshArgs, '-o', 'ControlPath=none', '-o', 'ControlMaster=no', host, 'true'], { timeoutMs: MASTER_START_TIMEOUT_MS })
  return res.code === 0 && !res.timedOut
}

/** End a master that failed its probe and remove what it left. Bounded. */
export async function removeStaleMaster(socketPath: string, sshArgs: string[], host: string, opts: { run?: SshRunner } = {}): Promise<void> {
  // A live process with a dead link still holds the path: ask it to go first.
  await exitControlMaster(socketPath, sshArgs, host, opts)
  try { fs.unlinkSync(socketPath) } catch { /* already gone */ }
}

/** Start a master at `socketPath`. Throws with ssh's own words when it cannot. */
export async function startControlMaster(
  socketPath: string,
  sshArgs: string[],
  host: string,
  opts: { run?: SshRunner } = {},
): Promise<void> {
  const args = [
    ...sshArgs,
    '-o', `ControlPath=${socketPath}`,
    '-o', 'ControlMaster=yes',
    '-o', `ControlPersist=${MASTER_PERSIST_SECS}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-fN', host, // -f: background once authenticated, -N: no command
  ]
  const run = opts.run ?? runSshBounded
  const res = await run(args, { timeoutMs: MASTER_START_TIMEOUT_MS })
  if (res.spawnError) throw res.spawnError
  if (res.timedOut || res.code !== 0) {
    throw new Error(`Command failed: ssh ${args.join(' ')}\n${res.timedOut ? `timed out after ${MASTER_START_TIMEOUT_MS}ms` : res.stderr.trim() || `exit code ${res.code}`}`)
  }
  // A fresh master holds no forwards: a list left by an older one means nothing now.
  try { fs.unlinkSync(forwardsFile(socketPath)) } catch { /* none */ }
}

/** End the master at `socketPath` (a deliberate teardown, never a server restart). */
export async function exitControlMaster(socketPath: string, sshArgs: string[], host: string, opts: { run?: SshRunner } = {}): Promise<void> {
  const run = opts.run ?? runSshBounded
  try {
    await run([...sshArgs, '-o', `ControlPath=${socketPath}`, '-O', 'exit', host], { timeoutMs: MASTER_CONTROL_TIMEOUT_MS })
  } catch { /* already gone */ }
  try { fs.unlinkSync(forwardsFile(socketPath)) } catch { /* none */ }
}

/** Note a `-L` forward opened through the master, so the next process can cancel it. */
export function recordForward(socketPath: string, spec: string): void {
  try { fs.appendFileSync(forwardsFile(socketPath), `${spec}\n`, { mode: 0o600 }) } catch { /* best effort: a leftover forward is harmless */ }
}

/** Cancel the forwards an earlier process opened through a master this one took over. */
export async function cancelRecordedForwards(
  socketPath: string,
  sshArgs: string[],
  host: string,
  opts: { run?: SshRunner } = {},
): Promise<string[]> {
  const file = forwardsFile(socketPath)
  let specs: string[]
  try {
    specs = [...new Set(fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))]
  } catch {
    return []
  }
  try { fs.unlinkSync(file) } catch { /* raced away */ }
  const run = opts.run ?? runSshBounded
  await Promise.all(specs.map((spec) =>
    run([...sshArgs, '-o', `ControlPath=${socketPath}`, '-O', 'cancel', '-L', spec, host], { timeoutMs: MASTER_CONTROL_TIMEOUT_MS }).catch(() => undefined)))
  return specs
}
