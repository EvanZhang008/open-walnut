/**
 * The narrow opt-in of the replica check on a real dev box
 * (docs/plan/walnut-replica-servers-impl.md section 13 step 2, WP14).
 *
 * An ephemeral server is read only against every remote host (C10,
 * daemon-connection.ts isReadOnlyRemote): no slice, no leader.configure, no
 * host server, no drain. That is right for every host but one: the check runs
 * an ISOLATED daemon on the box, in its own dir, and needs the ephemeral server
 * to lead it. So:
 *
 *   WALNUT_EPHEMERAL_REPLICA_HOST=<alias>   the one host whose read only is lifted
 *   WALNUT_EPHEMERAL_REPLICA_DIR=<abs dir>  that host's isolated daemon dir
 *
 * lift it for that alias only, only on an ephemeral server that may reach
 * remote hosts at all (WALNUT_EPHEMERAL_REMOTE_HOSTS=1), only for a host reached
 * over ssh (the companion's box comes through its tunnel, where no isolated dir
 * applies), only when the dir is not a production daemon dir
 * (`/tmp/open-walnut`, `~/.cache/open-walnut`, or inside either), and only when
 * the host server root is an isolated one too (WALNUT_HOST_SERVER_ROOT set, and
 * not the production replica's `~/.open-walnut-host` or inside it: else this
 * server would install into, and run a replica over, the production replica's
 * data, run and log dirs). Anything else is refused with a logged reason, and
 * the host stays read only. The connection then uses that dir for the host
 * instead of the one its probe would choose, with the dir's own streams dir.
 */
import path from 'node:path'
import { FALLBACK_DAEMON_SUBDIR, PROD_REMOTE_DAEMON_DIR } from './remote-daemon-dir.js'

/** The companion's box (core/hosts/cloud-box-host.ts CLOUD_BOX_HOST_ALIAS): reached through its tunnel, never ssh. */
const CLOUD_BOX_ALIAS = '__cloudbox__'
/** The production replica's root segment (core/host-server/install.ts HOST_ROOT). */
const PROD_HOST_ROOT_SEGMENT = '.open-walnut-host'

export type EphemeralReplicaRefusal = 'remote-hosts-off' | 'not-ssh' | 'no-dir' | 'dir-not-absolute' | 'prod-dir'
  | 'no-host-root' | 'prod-host-root'

export type EphemeralReplicaDecision =
  /** Not asked for this host: nothing to say. */
  | { lifted: false; asked: false }
  | { lifted: false; asked: true; reason: EphemeralReplicaRefusal; dir?: string }
  | { lifted: true; asked: true; dir: string }

/** Whether `dir` is a production daemon dir, or inside one (any user's home). */
export function isProdDaemonDir(dir: string): boolean {
  // macOS spells /tmp as /private/tmp (a symlink): the same dir.
  const d = (path.posix.normalize(dir).replace(/\/+$/, '') || '/').replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, '')
  const tmp = PROD_REMOTE_DAEMON_DIR
  // The daemon dir, its streams dir (`/tmp/open-walnut-streams`) and anything inside them.
  const streams = `${tmp}-streams`
  if (d === tmp || d.startsWith(tmp + '/') || d === streams || d.startsWith(streams + '/')) return true
  // The production replica's root (its `run` dir and the rest).
  if (isProdHostRoot(d)) return true
  // `~/.cache/open-walnut` of whatever home: the fallback dir's tail anywhere.
  const tail = '/' + FALLBACK_DAEMON_SUBDIR
  if (d.endsWith(tail) || d.includes(tail + '/')) return true
  // The host's own Walnut dirs are never a daemon dir to lead.
  return /\/\.open-walnut(\/|$)/.test(d)
}

/** Whether a host server root is the production replica's (`$HOME/.open-walnut-host`, any spelling) or inside it. */
export function isProdHostRoot(root: string): boolean {
  return root.split('/').includes(PROD_HOST_ROOT_SEGMENT)
}

export function ephemeralReplicaHost(hostKey: string, env: NodeJS.ProcessEnv, ephemeral: boolean): EphemeralReplicaDecision {
  const alias = (env.WALNUT_EPHEMERAL_REPLICA_HOST ?? '').trim()
  if (!ephemeral || !alias || alias !== hostKey || hostKey === '__local__') return { lifted: false, asked: false }
  if (env.WALNUT_EPHEMERAL_REMOTE_HOSTS !== '1') return { lifted: false, asked: true, reason: 'remote-hosts-off' }
  if (hostKey === CLOUD_BOX_ALIAS) return { lifted: false, asked: true, reason: 'not-ssh' }
  const raw = (env.WALNUT_EPHEMERAL_REPLICA_DIR ?? '').trim()
  if (!raw) return { lifted: false, asked: true, reason: 'no-dir' }
  if (!raw.startsWith('/') || raw.split('/').includes('..')) return { lifted: false, asked: true, reason: 'dir-not-absolute', dir: raw }
  const dir = path.posix.normalize(raw).replace(/\/+$/, '')
  if (isProdDaemonDir(dir)) return { lifted: false, asked: true, reason: 'prod-dir', dir }
  const root = (env.WALNUT_HOST_SERVER_ROOT ?? '').trim()
  if (!root) return { lifted: false, asked: true, reason: 'no-host-root', dir }
  if (isProdHostRoot(root)) return { lifted: false, asked: true, reason: 'prod-host-root', dir }
  return { lifted: true, asked: true, dir }
}

/** The env a lifted host's daemon starts with: its own dir and its own streams dir. */
export function ephemeralReplicaDirEnv(dir: string): Record<string, string> {
  return { WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.posix.join(dir, 'streams') }
}
