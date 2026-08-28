/**
 * Who may claim the PRODUCTION daemon dir, and who claimed the one that is running.
 *
 * The daemon dir is the ownership token for a host's daemon: whoever writes
 * `<dir>/daemon.pid` becomes the daemon every walnut on this box talks to, and
 * the daemon exports ITS OWN env into every `claude` process it spawns. So an
 * instance that isolates its data dir but inherits WALNUT_DAEMON_DIR is not
 * isolated at all: it silently takes over production's session plumbing.
 *
 * This has now happened twice, from opposite directions:
 *   - inc-1783280584117 (2026-07-05): a vitest-spawned server warmed the prod
 *     daemon, which then leaked VITEST/OPEN_WALNUT_HOME into every CLI it
 *     spawned. Fixed by scrubbing those vars in spawnDaemon(), plus the test-env
 *     refusal below.
 *   - 2026-08-28: a leftover demo server (plain `node dist/cli.js web --port
 *     <n>`, so NOT a test env) ran with a throwaway HOME and a stripped PATH but
 *     WALNUT_DAEMON_DIR=/tmp/open-walnut. It restarted the prod daemon under that
 *     fake HOME, so the spawn preamble appended `$HOME/.local/bin` inside the
 *     throwaway tree and every NEW session died with `exit 127 … exec: claude:
 *     not found`. Sessions from the previous daemon kept working, which is why it
 *     read as "Claude Code is broken" rather than as a misconfigured daemon.
 *
 * The lesson the test-env check missed: the disqualifying property is not "am I
 * a test", it is "is $HOME the real user's home". Whatever launched a process, if
 * its HOME is a throwaway then every tool the daemon resolves through it (the
 * claude binary, shell rc files, ~/.claude) is the wrong one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'

/** The machine-global daemon dir. Remote daemons hardcode the same path. */
export const PROD_DAEMON_DIR = '/tmp/open-walnut'

/** Identity of the walnut instance a daemon serves. */
export interface DaemonOwnerIdentity {
  /** Resolved data dir (WALNUT_HOME): the task/session registry this daemon serves. */
  walnutHome: string
  /** $HOME as the daemon will see it. It inherits our env, and the spawn preamble
   *  resolves `~/.local/bin`, `~/.zshrc` and `~/.claude` against exactly this. */
  envHome: string
  /** The OS-level home from the passwd entry. NOT env-derived, so a faked HOME
   *  cannot hide behind it (os.homedir() returns $HOME when set, userInfo() does not). */
  realHome: string
}

export interface ProdClaimPosture extends DaemonOwnerIdentity {
  isTestEnv: boolean
}

export function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  if (ra === rb) return true
  // /var/root vs /private/var/root and friends: a symlinked prefix is the same home.
  try { return fs.realpathSync(ra) === fs.realpathSync(rb) } catch { return false }
}

/**
 * Why this process must NOT own the production daemon dir, or null when it may.
 *
 * Pure so the whole matrix is unit-testable; `currentProdClaimPosture()`
 * snapshots the real process. Only consulted for the production dir: an isolated
 * WALNUT_DAEMON_DIR is always allowed, that IS the correct posture.
 *
 * Deliberately NOT a rule: a throwaway DATA dir. An ephemeral server runs on a
 * snapshot of production data and is documented to share this machine's local
 * daemon ("same machine + same binary version means ensureRunning() reuses
 * rather than fights", see DaemonConnection.isReadOnlyRemote). A different
 * registry is a difference of opinion about tasks; a different HOME is a broken
 * toolchain, and only the second one can never be legitimate.
 */
export function prodDaemonClaimRefusal(p: ProdClaimPosture): string | null {
  const suffix =
    ` Set WALNUT_DAEMON_DIR to an isolated temp dir (or pass daemonDir explicitly)` +
    ` so this instance gets its own daemon.`
  if (p.isTestEnv) {
    return `Refusing to touch the production daemon dir ${PROD_DAEMON_DIR} from a test process.` + suffix
  }
  if (p.envHome && p.realHome && !samePath(p.envHome, p.realHome)) {
    return (
      `Refusing to touch the production daemon dir ${PROD_DAEMON_DIR}: HOME is ${p.envHome} but this` +
      ` user's home is ${p.realHome}. The daemon inherits this env, so every session it spawns would` +
      ` look for the claude CLI, shell rc files and ~/.claude under the wrong home (exit 127).` + suffix
    )
  }
  return null
}

/** True when running under vitest (or any runner that sets NODE_ENV=test). */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.VITEST || env.VITEST_WORKER_ID || env.NODE_ENV === 'test')
}

/** Snapshot of THIS process's posture. */
export function currentProdClaimPosture(): ProdClaimPosture {
  let realHome = ''
  // userInfo() reads the passwd entry and throws when there is none (some
  // containers/CI images). No passwd entry means no trustworthy signal, so the
  // fake-HOME rule simply does not fire. Never substitute os.homedir() here: it
  // IS $HOME, so the comparison would be a value against itself.
  try { realHome = os.userInfo().homedir || '' } catch { realHome = '' }
  return {
    walnutHome: WALNUT_HOME,
    envHome: process.env.HOME || '',
    realHome,
    isTestEnv: isTestEnv(),
  }
}

/**
 * `<daemonDir>/daemon.owner` — written ONLY by the process that spawns a daemon,
 * because only it knows the env that daemon inherited. Never re-stamped on
 * adoption: a stamp naming the adopter would describe the wrong environment,
 * which is exactly the confusion this file exists to end.
 *
 * `instanceId` ties the stamp to one daemon incarnation (daemon.instance is
 * written by the daemon itself), so a stamp left behind by an earlier daemon
 * reads as "unknown owner" instead of quietly vouching for a foreign one.
 */
export interface DaemonOwnerStamp extends DaemonOwnerIdentity {
  instanceId: string | null
  daemonPid: number | null
  /** pid of the walnut server that spawned it (a dead pid means a stale claim). */
  serverPid: number
  /** The claude CLI resolvable in the env we handed the daemon, or null. */
  claudeCli: string | null
  at: string
}

export const DAEMON_OWNER_FILE = 'daemon.owner'

/**
 * Verdict on a daemon THIS process did not spawn.
 *   ours             — the stamp names this exact daemon incarnation.
 *   unstamped        — no stamp, or one from before this feature existed.
 *   foreign-identity — stamped by an instance with a different home or data dir.
 *   no-claude        — same identity, but claude was not resolvable at spawn.
 *   stale-stamp      — same identity, an earlier incarnation left the stamp.
 */
export type AdoptedDaemonOwnerVerdict =
  | 'ours' | 'unstamped' | 'foreign-identity' | 'no-claude' | 'stale-stamp'

/**
 * De-dup key for the adoption audit. Both instance ids are in it on purpose: the
 * latch must suppress the same news repeated on every ensureRunning(), yet still
 * speak up when the daemon is replaced mid-run or a stamp appears. Keying on the
 * verdict alone would hide a real takeover behind an earlier benign warning.
 */
export function ownerAuditKey(
  verdict: AdoptedDaemonOwnerVerdict,
  liveInstanceId: string | null,
  stampInstanceId: string | null | undefined,
): string {
  return `${verdict}:${liveInstanceId ?? ''}:${stampInstanceId ?? ''}`
}

export function classifyAdoptedDaemonOwner(
  stamp: DaemonOwnerStamp | null,
  mine: DaemonOwnerIdentity,
  liveInstanceId: string | null,
): AdoptedDaemonOwnerVerdict {
  if (!stamp || !stamp.instanceId) return 'unstamped'
  if (liveInstanceId && stamp.instanceId === liveInstanceId) return 'ours'
  // Identity first: a foreign home is the dangerous case whatever else is true.
  if (!samePath(stamp.walnutHome, mine.walnutHome) || !samePath(stamp.envHome, mine.envHome)) {
    return 'foreign-identity'
  }
  if (!stamp.claudeCli) return 'no-claude'
  return 'stale-stamp'
}
