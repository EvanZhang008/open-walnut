/**
 * A test server's own corner of every remote host it reaches.
 *
 * An ephemeral server (IS_EPHEMERAL) is a throwaway copy of the user's Walnut. On
 * its own machine it already runs its own daemon in its own dirs. On a remote
 * host it used to attach to the production daemon there, read only, and some of
 * its steps still wrote into the production places on the way: the dir probe's
 * write test in /tmp/open-walnut, bun into ~/.bun, host fixes into ~/.local/bin
 * and ~/.claude, terminal sockets and the dtach binary beside production's.
 *
 * The rule now: a test server never talks to a remote host's production daemon
 * and never writes outside a root of its own there. With remote hosts on
 * (WALNUT_EPHEMERAL_REMOTE_HOSTS=1) every host it reaches over ssh gets an
 * isolated daemon in
 *
 *   /tmp/open-walnut-test-<key>                 (or $HOME/.cache/open-walnut-test/<key>
 *     daemon/   the daemon dir (pid, port,       when /tmp cannot take it)
 *               binary, logs)
 *     daemon-images/  pictures a session gets (beside the daemon dir, as for production)
 *     streams/  session streams
 *     home/     HOME for every install: bun, host fixes (Claude Code, dtach), code-server
 *     tasks/    task directories
 *     secrets/  task secrets
 *     worktrees/ git worktrees
 *     term/     terminal dtach sockets (the terminal path does not go through the daemon)
 *
 * where <key> names the test server (walnutKeyOf of its data dir), so two test
 * servers never share one either. The daemon is started with
 * WALNUT_DAEMON_ISOLATED_FOR=<key> and says it in its hello with its dir; the
 * test server refuses a daemon that does not, and a production server refuses
 * one that does. A host that cannot be isolated (the cloud box and host network
 * machines: no ssh, their daemon is the host's own service) stays off.
 *
 * What still reaches the user's real home is what a session itself writes (the
 * agent CLI's own transcripts under ~/.claude) and the records every daemon on
 * that ~/.claude shares so the production Walnut can tell a test session from its
 * own (the spawn journal, cli-owners). Those exist for the production Walnut's
 * sake and stay where it reads them. The cloud box is the one host a test server
 * attaches to as before: it only ever takes a test companion on this machine as
 * its cloud box (core/hosts/cloud-box-probe.ts), never the real one.
 *
 * The replica check (ephemeral-replica-host.ts, WP14) is the same isolation with
 * the root named by WALNUT_EPHEMERAL_REPLICA_DIR, and only there does the test
 * server also lead the host's replica server.
 */
import path from 'node:path'
import { shq } from './remote-sh.js'
import { walnutKeyOf } from './daemon-shared.js'
import { buildDaemonStopCmd } from './daemon-start-cmd.js'
import type { DirProbeScriptOpts } from './remote-daemon-dir.js'
import { ephemeralReplicaHost, isProdDaemonDir, type EphemeralReplicaRefusal } from './ephemeral-replica-host.js'

/** `/tmp/open-walnut-test-<key>`: never a production dir (isProdDaemonDir) and never inside one. */
export const ISOLATED_TMP_PREFIX = '/tmp/open-walnut-test-'
/** `$HOME/.cache/open-walnut-test/<key>` when /tmp cannot take the daemon. */
export const ISOLATED_CACHE_SUBDIR = '.cache/open-walnut-test'
/** A test daemon with no server for this long ends itself (a test server killed with -9 leaves it behind). */
export const ISOLATED_ORPHAN_EXIT_MS = 30 * 60_000

/** Who an isolated daemon serves, as its hello says it: the test server's data dir, hashed. */
export function isolationKey(home: string): string {
  return walnutKeyOf(home)
}

export type RemoteIsolationRefusal = 'remote-hosts-off' | 'not-ssh' | EphemeralReplicaRefusal

export type RemoteIsolation =
  /** A real server: the host's production daemon, as always. */
  | { mode: 'shared' }
  /**
   * The cloud box of a test server: always a test companion on this machine, since
   * a test server takes only a loopback companion as its cloud box
   * (core/hosts/cloud-box-probe.ts). Attached read only, as before; no ssh, nothing to deploy.
   */
  | { mode: 'attach' }
  /** A test server that may not reach this host at all. */
  | { mode: 'off'; reason: RemoteIsolationRefusal; dir?: string }
  /**
   * A test server's own daemon. `roots` are the candidates in order (absolute, or
   * `$HOME/...` until the host's home is known); `replica` = the replica check's
   * host, the only one whose host server this server may run.
   */
  | { mode: 'isolated'; key: string; roots: string[]; replica: boolean }

export interface RemoteIsolationInput {
  hostKey: string
  env: NodeJS.ProcessEnv
  ephemeral: boolean
  /** How the host is reached (daemon-update-paths.ts DaemonLinkKind): only 'ssh' can be isolated. */
  link: string
  /** The test server's data dir (WALNUT_HOME). */
  home: string
}

/** The one decision every remote step of a test server follows. */
export function remoteIsolationFor(input: RemoteIsolationInput): RemoteIsolation {
  const { hostKey, env, ephemeral, link, home } = input
  if (!ephemeral || hostKey === '__local__' || link === 'local') return { mode: 'shared' }
  if (env.WALNUT_EPHEMERAL_REMOTE_HOSTS !== '1') return { mode: 'off', reason: 'remote-hosts-off' }
  if (link === 'cloud-tunnel') return { mode: 'attach' }
  if (link !== 'ssh') return { mode: 'off', reason: 'not-ssh' }
  const key = isolationKey(home)
  const replica = ephemeralReplicaHost(hostKey, env, true)
  if (replica.asked) {
    if (!replica.lifted) return { mode: 'off', reason: replica.reason, ...(replica.dir ? { dir: replica.dir } : {}) }
    return { mode: 'isolated', key, roots: [replica.dir], replica: true }
  }
  return { mode: 'isolated', key, roots: [`${ISOLATED_TMP_PREFIX}${key}`, `$HOME/${ISOLATED_CACHE_SUBDIR}/${key}`], replica: false }
}

/** `$HOME/...` made absolute once the host's home is known; null while it is not. */
export function resolveIsolatedRoot(root: string, remoteHome: string | null | undefined): string | null {
  if (!root.startsWith('$HOME/')) return root
  const h = (remoteHome ?? '').replace(/\/+$/, '')
  return h.startsWith('/') ? `${h}/${root.slice('$HOME/'.length)}` : null
}

export interface IsolatedLayout {
  root: string
  daemonDir: string
  streamsDir: string
  installHome: string
  taskDirRoot: string
  secretsRoot: string
  worktreesRoot: string
  termDir: string
}

export function isolatedLayout(root: string): IsolatedLayout {
  const j = (p: string) => path.posix.join(root, p)
  return {
    root,
    daemonDir: j('daemon'),
    streamsDir: j('streams'),
    installHome: j('home'),
    taskDirRoot: j('tasks'),
    secretsRoot: j('secrets'),
    worktreesRoot: j('worktrees'),
    termDir: j('term'),
  }
}

/**
 * The dir probe of a test server (remote-daemon-dir.ts): its own daemon dirs
 * only, under a root it owns. The production dirs are neither written nor read.
 */
export function isolatedProbeOpts(iso: Extract<RemoteIsolation, { mode: 'isolated' }>): DirProbeScriptOpts {
  const [first, second] = iso.roots
  const tmpDir = isolatedLayout(first).daemonDir
  if (!second) return { tmpDir, noCache: true, guardParent: true }
  const cacheSubdir = isolatedLayout(second).daemonDir.replace(/^\$HOME\//, '')
  return { tmpDir, cacheSubdir, guardParent: true }
}

/** The root a daemon dir of the layout belongs to. */
export function isolatedRootOfDaemonDir(daemonDir: string): string {
  return path.posix.dirname(daemonDir)
}

/** Everything the isolated daemon starts with: every dir it writes is under the root. */
export function isolatedDaemonEnv(root: string, key: string): Record<string, string> {
  const l = isolatedLayout(root)
  return {
    WALNUT_DAEMON_DIR: l.daemonDir,
    WALNUT_STREAMS_DIR: l.streamsDir,
    WALNUT_TASK_DIR_ROOT: l.taskDirRoot,
    WALNUT_SECRETS_DIR_ROOT: l.secretsRoot,
    WALNUT_WORKTREES_ROOT: l.worktreesRoot,
    WALNUT_INSTALL_HOME: l.installHome,
    WALNUT_DAEMON_ISOLATED_FOR: key,
    WALNUT_DAEMON_ORPHAN_EXIT_MS: String(ISOLATED_ORPHAN_EXIT_MS),
  }
}

/**
 * True only for a root this test server made: `/tmp/open-walnut-test-<key>`,
 * `<home>/.cache/open-walnut-test/<key>`, or the replica check's own dir. The
 * one check in front of every `rm -rf` of a root.
 */
export function isOwnIsolatedRoot(root: string, iso: RemoteIsolation): boolean {
  if (iso.mode !== 'isolated') return false
  if (!root.startsWith('/') || root.split('/').includes('..') || root.includes('\n')) return false
  const d = path.posix.normalize(root).replace(/\/+$/, '')
  if (isProdDaemonDir(d) || d === '/tmp' || d.split('/').length < 3) return false
  if (iso.replica) return iso.roots.includes(d)
  return d === `${ISOLATED_TMP_PREFIX}${iso.key}` || d.endsWith(`/${ISOLATED_CACHE_SUBDIR}/${iso.key}`)
}

/**
 * Where a test server's in-app terminals live on every remote host: under its
 * /tmp root (the terminal reaches the host over ssh on its own, not through the
 * daemon). Null for a real server. A host whose /tmp cannot take it gets no
 * persistent terminal from a test server.
 */
export function testServerRemoteTermRoot(ephemeral: boolean, home: string): IsolatedLayout | null {
  return ephemeral ? isolatedLayout(`${ISOLATED_TMP_PREFIX}${isolationKey(home)}`) : null
}

/** Answer of the identity check on a daemon's hello. */
export type DaemonIdentityVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Does this daemon serve this server? A test server's daemon must say the test
 * server's key and the dir the test server chose; a production server's daemon
 * must not be a test server's. An older daemon says neither field: fine for a
 * production server (it never dials a test dir), never for a test server.
 */
export function daemonIdentityVerdict(hello: Record<string, unknown>, expect: { key: string; daemonDir: string } | null): DaemonIdentityVerdict {
  const said = typeof hello.isolatedFor === 'string' && hello.isolatedFor ? hello.isolatedFor : null
  const dir = typeof hello.dir === 'string' && hello.dir ? hello.dir : null
  if (!expect) {
    return said ? { ok: false, reason: `the daemon there is a test server's own (it serves ${said}), not this host's daemon` } : { ok: true }
  }
  if (said !== expect.key) {
    return { ok: false, reason: said ? `the daemon there serves another test server (${said})` : 'the daemon there is not this test server\'s own (its hello names no test server)' }
  }
  const norm = (d: string) => path.posix.normalize(d).replace(/(.)\/+$/, '$1')
  if (dir !== null && norm(dir) !== norm(expect.daemonDir)) {
    return { ok: false, reason: `the daemon there runs from ${dir}, not this test server's ${expect.daemonDir}` }
  }
  if (dir === null) return { ok: false, reason: 'the daemon there does not say its dir' }
  return { ok: true }
}

/**
 * Stops the isolated daemon of `root` (the stop proves the pid is that dir's
 * daemon first) and removes the root, only once the stop is confirmed
 * (`remove: false` keeps it). Prints `walnut-isolated-retired` when done.
 */
export function buildIsolatedRetireScript(root: string, opts: { remove?: boolean; alsoRemove?: string[] } = {}): string {
  const l = isolatedLayout(root)
  const remove = opts.remove !== false
  // The test server's other root (its /tmp one holds its terminals when the daemon lives in ~/.cache).
  const also = (opts.alsoRemove ?? []).filter((r) => r !== root).map((r) => `O=${shq(r)}; if [ -d "$O" ] && [ ! -L "$O" ] && [ -O "$O" ]; then rm -rf "$O" 2>/dev/null; fi`)
  return [
    `R=${shq(root)}`,
    `if [ ! -e "$R" ]; then echo walnut-isolated-retired; exit 0; fi`,
    // Never a symlink or another user's dir: what it points at is not ours to remove.
    `if [ -L "$R" ] || [ ! -O "$R" ]; then echo walnut-isolated-not-owned; exit 1; fi`,
    `S=$( (${buildDaemonStopCmd(l.daemonDir).split('\n').join('\n')}) 2>&1 )`,
    'case "$S" in *walnut-daemon-stop-confirmed*) ;; *) printf "%s\\n" "$S"; exit 1;; esac',
    ...(remove ? [
      ...also,
      `rm -rf "$R" ${shq(`${l.daemonDir}-images`)} 2>/dev/null`,
      `if [ -e "$R" ]; then echo walnut-isolated-left; exit 1; fi`,
    ] : []),
    'echo walnut-isolated-retired',
  ].join('\n')
}

/** A short sentence for the connect error of a refused host. */
export function describeIsolationRefusal(hostKey: string, reason: RemoteIsolationRefusal, dir?: string): string {
  switch (reason) {
    case 'remote-hosts-off': return `ephemeral server: remote host '${hostKey}' is off for test servers (set WALNUT_EPHEMERAL_REMOTE_HOSTS=1 to give it a daemon of its own there)`
    case 'not-ssh': return `ephemeral server: remote host '${hostKey}' is not reached over ssh, so its daemon is the host's own and a test server never talks to it`
    default: return `ephemeral server: the replica check on '${hostKey}' was refused (${reason}${dir ? `: ${dir}` : ''}), so the host stays off`
  }
}
