/**
 * What a host replica (`walnut web --replica`, placement host) refuses at boot
 * (docs/plan/walnut-replica-servers-impl.md, WP1).
 *
 * The full server program derives its run dir (logs, streams, dtach sockets,
 * images) from WALNUT_DAEMON_DIR and falls back to /tmp/open-walnut, the run dir
 * of the Walnut that owns this machine; and its data dir falls back to
 * ~/.open-walnut. A replica that booted on either would write into another
 * Walnut's files, or into the host daemon's own directory. So it refuses before
 * anything is opened: no run dir of its own, the shared one, the daemon's, or
 * the production data dir.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isProductionWalnutHome, productionWalnutHomes } from '../core/sessions/ephemeral-guard.js'
import { accountInfo } from '../lib/account.js'

export const PROD_RUN_DIR = '/tmp/open-walnut'
/** The streams dir of the Walnut that owns this machine (daemon stream files, FIFOs). */
export const PROD_STREAMS_DIR = '/tmp/open-walnut-streams'

/**
 * The path with its nearest existing ancestor resolved on disk, so a dir that
 * does not exist yet still compares by its real location (macOS: /tmp is
 * /private/tmp).
 */
function canonical(dir: string): string {
  let head = path.resolve(dir)
  const rest: string[] = []
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...rest) } catch { /* not there yet */ }
    const up = path.dirname(head)
    if (up === head) return path.resolve(dir)
    rest.unshift(path.basename(head))
    head = up
  }
}

/** Every spelling of a dir: as given, resolved on disk, and with macOS's /private prefix. */
function spellings(dir: string): string[] {
  const resolved = path.resolve(dir)
  return [...new Set([resolved, canonical(resolved), `/private${resolved}`])]
}

/** `child` is `parent` or lies inside it. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The two dirs are the same, or one holds the other (by any spelling). */
function overlaps(a: string, b: string): boolean {
  return spellings(a).some((x) => spellings(b).some((y) => within(x, y) || within(y, x)))
}

/** `outer` is `inner` or holds it (by any spelling). */
function holdsOrIs(outer: string, inner: string): boolean {
  return spellings(outer).some((o) => spellings(inner).some((i) => within(i, o)))
}

/** The account's home dirs: $HOME as given, os.homedir(), and the passwd entry (HOME can be faked). */
function accountHomes(env: NodeJS.ProcessEnv): string[] {
  const homes = new Set<string>()
  const add = (h: string | undefined) => { if (h && h.trim()) homes.add(path.resolve(h.trim())) }
  add(env.HOME)
  add(os.homedir())
  try { add(accountInfo().homedir) } catch { /* no passwd entry */ }
  return [...homes]
}

function same(a: string, b: string): boolean {
  return spellings(a).some((x) => spellings(b).includes(x))
}

export interface ReplicaBootInput {
  env: NodeJS.ProcessEnv
  /** The data dir constants.ts resolved (OPEN_WALNUT_HOME, else ~/.open-walnut). */
  walnutHome: string
  productionHomes?: readonly string[]
  /** The account's home dirs (default: $HOME, os.homedir(), the passwd entry). */
  accountHomes?: readonly string[]
}

/** The reason this host replica must not boot, or null when it may. */
export function replicaBootRefusal(input: ReplicaBootInput): string | null {
  const runDir = (input.env.WALNUT_DAEMON_DIR ?? '').trim()
  if (!runDir) return 'WALNUT_DAEMON_DIR is not set: a host replica needs a run dir of its own (the default is /tmp/open-walnut, which belongs to another Walnut)'
  if (same(runDir, PROD_RUN_DIR)) return `WALNUT_DAEMON_DIR is ${PROD_RUN_DIR}, the run dir of the Walnut that owns this machine`
  // Logs, streams, dtach sockets and images all land under the run dir, so it
  // may neither sit inside nor hold another Walnut's run or streams dir.
  for (const shared of [PROD_RUN_DIR, PROD_STREAMS_DIR]) {
    if (overlaps(runDir, shared)) return `WALNUT_DAEMON_DIR ${runDir} is inside or holds ${shared}, which belongs to the Walnut that owns this machine`
  }
  const hostDaemonDir = (input.env.WALNUT_HOST_DAEMON_DIR ?? '').trim()
  if (hostDaemonDir && same(hostDaemonDir, runDir)) {
    return 'WALNUT_DAEMON_DIR equals WALNUT_HOST_DAEMON_DIR: the replica would write into the host daemon\'s own directory'
  }
  if (hostDaemonDir && overlaps(hostDaemonDir, runDir)) {
    return 'WALNUT_DAEMON_DIR is inside or holds WALNUT_HOST_DAEMON_DIR: the replica would write into the host daemon\'s own directory'
  }
  if (!(input.env.WALNUT_WALNUT_ID ?? '').trim()) return 'WALNUT_WALNUT_ID is not set: a host replica answers as the Walnut it follows, never with an id of its own'
  const dataDir = (input.env.OPEN_WALNUT_HOME ?? '').trim()
  if (!dataDir) return 'OPEN_WALNUT_HOME is not set: a host replica keeps its copies in a data dir of its own'
  const others: Array<[string, string]> = [['WALNUT_DAEMON_DIR', runDir], [PROD_RUN_DIR, PROD_RUN_DIR], [PROD_STREAMS_DIR, PROD_STREAMS_DIR]]
  if (hostDaemonDir) others.push(['WALNUT_HOST_DAEMON_DIR', hostDaemonDir])
  for (const [label, other] of others) {
    for (const home of new Set([dataDir, input.walnutHome])) {
      if (overlaps(home, other)) return `the data dir ${home} is, holds or sits inside ${label}: copies and run files must live apart`
    }
  }
  const prodHomes = input.productionHomes ?? productionWalnutHomes()
  if (isProductionWalnutHome(input.walnutHome, prodHomes)) {
    return `the data dir ${input.walnutHome} is the production Walnut's own (~/.open-walnut)`
  }
  // The boot makes these dirs owner-only and prunes logs in the run dir: none
  // of them may reach into another Walnut's data dir, or hold the account's
  // home (a dir inside the home, ~/.open-walnut-host/data, is the normal layout).
  const own: Array<[string, string]> = [['WALNUT_DAEMON_DIR', runDir], ['the data dir', dataDir]]
  if (input.walnutHome !== dataDir) own.push(['the data dir', input.walnutHome])
  for (const [label, dir] of own) {
    for (const prod of prodHomes) {
      if (overlaps(dir, prod)) return `${label} ${dir} is, holds or sits inside ${prod}, the production Walnut's data dir`
    }
    for (const home of input.accountHomes ?? accountHomes(input.env)) {
      if (holdsOrIs(dir, home)) return `${label} ${dir} is or holds the account's home ${home}`
    }
  }
  // This account's own Walnut (and its host daemon) runs from here when another user owns /tmp/open-walnut.
  for (const home of input.accountHomes ?? accountHomes(input.env)) {
    const own = path.join(home, '.cache', 'open-walnut')
    if (overlaps(runDir, own)) return `WALNUT_DAEMON_DIR ${runDir} is inside or holds ${own}, the run dir of this account's own Walnut`
  }
  return null
}

export function assertReplicaBootSafe(input: ReplicaBootInput): void {
  const why = replicaBootRefusal(input)
  if (why) throw new Error(`Host replica refused to start: ${why}.`)
}

/** The file that proves a dir is a host replica's own: written by the replica into a dir it found empty. */
export const REPLICA_DIR_MARKER = '.walnut-replica'

/**
 * Whether `dir` is this host replica's own. A dir that does not exist yet is
 * made (0700) and one that is empty gets the marker; one that holds the marker
 * already is its own; one that holds anything else was not made by a replica,
 * so the boot never changes a mode in it.
 */
export function claimReplicaDir(dir: string): boolean {
  const marker = path.join(dir, REPLICA_DIR_MARKER)
  try { return fs.lstatSync(marker).isFile() } catch { /* not marked yet */ }
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    names = []
  }
  if (names.length > 0) return false
  try {
    fs.writeFileSync(marker, `host replica dir, made ${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
  }
  return true
}

/**
 * Owner-only modes on what a host replica keeps: each dir 0700, each file
 * 0600, in the dirs that carry the replica's marker. The umask covers what
 * this process makes; this repairs what an older writer left looser (a copy
 * made under another umask, a dir made by hand). Symlinks are never followed or changed. Bounded: a data dir past
 * `limit` entries is left as is beyond that point (its top dir is 0700, which
 * already keeps other users out).
 */
export function tightenReplicaModes(dirs: readonly string[], limit = 20_000): { dirs: number; files: number } {
  // Only dirs a replica made (claimReplicaDir): never a tree it was merely pointed at.
  const marked = dirs.filter((d) => { try { return fs.lstatSync(path.join(d, REPLICA_DIR_MARKER)).isFile() } catch { return false } })
  const out = { dirs: 0, files: 0 }
  let seen = 0
  const visit = (p: string): void => {
    if (++seen > limit) return
    let st: fs.Stats
    try { st = fs.lstatSync(p) } catch { return }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      if ((st.mode & 0o777) !== 0o700) { try { fs.chmodSync(p, 0o700); out.dirs++ } catch { /* not ours */ } }
      let names: string[] = []
      try { names = fs.readdirSync(p) } catch { return }
      for (const n of names) visit(path.join(p, n))
    } else if (st.isFile() && (st.mode & 0o077) !== 0) {
      try { fs.chmodSync(p, (st.mode & 0o700) | 0o600); out.files++ } catch { /* not ours */ }
    }
  }
  for (const d of marked) visit(d)
  return out
}
