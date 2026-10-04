/**
 * The cloud companion's SECOND daemon: the one the paired Mac drives through
 * /daemon-tunnel (web/ws/daemon-tunnel.ts). It is never the replica's own
 * daemon (the `localDaemon` singleton, which runs `__cloud__` sessions when
 * cloud exec is on), because two servers must never share one daemon: each
 * would reconcile, reap and push hook rules into the other's sessions.
 *
 *   Mac server ──wss /daemon-tunnel──▶ replica ──ws 127.0.0.1──▶ THIS daemon ──▶ claude
 *
 * Its own dir, port, registry and streams under the service user's home, so
 * nothing it writes collides with the replica's daemon, and it survives a
 * reboot of /tmp. Its sessions belong to the Mac, not to this replica process,
 * so it keeps the contract the Mac's own daemon keeps across dev:prod:
 *   - a replica restart never ends them: no parent watchdog here, and the unit
 *     only stops its main process (KillMode=process in the harness drop-in,
 *     scripts/cloud/ensure-harness.sh); the next replica adopts the running
 *     daemon from its pid and port files instead of starting a second one;
 *   - a replica on a NEW build replaces the daemon (LocalDaemon's version
 *     check) without ending them either: WALNUT_DAEMON_KEEP_SESSIONS stops the
 *     old daemon from reaping its CLIs on exit, and the new one adopts them from
 *     the registry, as prod's does.
 */

import os from 'node:os'
import path from 'node:path'
import { LocalDaemon } from './local-daemon.js'
import { PROD_DAEMON_DIR } from './daemon-ownership.js'

/**
 * Where it lives. `WALNUT_TUNNEL_DAEMON_DIR` is for tests (a throwaway dir).
 *
 * Keyed by the credential's `daemonKey`: the immutable id of the Mac that owns
 * it (machine-credentials.ts), never its name, so two Macs can never share a
 * daemon, its sessions or its streams, and re-pairing a name inherits none. A
 * credential minted before ownership was recorded (no key) keeps the dir it
 * always had, so a box's running sessions survive the upgrade that introduced
 * the keying, and so does the Mac that adopts it.
 */
export function tunnelDaemonDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), owner?: string): string {
  const base = env.WALNUT_TUNNEL_DAEMON_DIR || path.join(home, '.local', 'state', 'open-walnut', 'primary-daemon')
  if (owner === undefined) return base
  // Device ids (and the names an earlier build keyed by) are
  // [A-Za-z0-9][A-Za-z0-9_.-]{0,63}; anything else never names a dir.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(owner)) throw new Error(`the tunnel daemon key ${JSON.stringify(owner)} is not a device id`)
  return path.join(`${base}.by-device`, owner, 'daemon')
}

/** Its streams: beside a keyed dir, or `<dir>-streams` for the unkeyed one. */
export function tunnelStreamsDir(dir: string): string {
  return path.basename(dir) === 'daemon' && path.basename(path.dirname(path.dirname(dir))).endsWith('.by-device')
    ? path.join(path.dirname(dir), 'streams')
    : `${dir}-streams`
}

/**
 * The dir must be neither the production default nor the replica's own daemon
 * dir: sharing either is exactly the two-servers-one-daemon state this exists
 * to prevent. Returns the refusal, or null when the dir is safe.
 */
export function tunnelDaemonDirRefusal(dir: string, replicaDaemonDir: string): string | null {
  const resolved = path.resolve(dir)
  if (resolved === path.resolve(PROD_DAEMON_DIR)) return `the tunnel daemon dir ${dir} is the default daemon dir`
  if (resolved === path.resolve(replicaDaemonDir)) return `the tunnel daemon dir ${dir} is this companion's own daemon dir`
  return null
}

/** What the tunnel daemon is started with, on top of the replica's own env. */
export function tunnelDaemonEnv(dir: string): Record<string, string | undefined> {
  return {
    // Its CLIs work for the Mac: nothing in them may believe it is the replica.
    WALNUT_CLOUD_MODE: undefined,
    // An explicit streams dir: an inherited WALNUT_STREAMS_DIR (the replica's
    // own daemon's, in tests) must not be shared.
    WALNUT_STREAMS_DIR: tunnelStreamsDir(dir),
    // Exiting (a replacement on a new build) leaves the CLIs to the successor.
    WALNUT_DAEMON_KEEP_SESSIONS: '1',
  }
}

const instances = new Map<string, LocalDaemon>()

/** The tunnel daemon for one owner, created on first use (that owner's first tunnel connect). */
export function getTunnelDaemon(owner?: string): LocalDaemon {
  const dir = tunnelDaemonDir(process.env, os.homedir(), owner)
  const existing = instances.get(dir)
  if (existing) return existing
  const refusal = tunnelDaemonDirRefusal(dir, process.env.WALNUT_DAEMON_DIR || PROD_DAEMON_DIR)
  if (refusal) throw new Error(refusal)
  const daemon = new LocalDaemon({
    daemonDir: dir,
    persistent: true,
    binaryPath: process.env.WALNUT_TUNNEL_DAEMON_BINARY || undefined,
    envOverrides: tunnelDaemonEnv(dir),
  })
  instances.set(dir, daemon)
  return daemon
}

/** Start it if needed; resolves to its loopback ws URL. */
export async function ensureTunnelDaemon(owner?: string): Promise<string> {
  const daemon = getTunnelDaemon(owner)
  await daemon.ensureRunning()
  const url = daemon.wsUrl
  if (!url) throw new Error('the tunnel daemon has no port after starting')
  return url
}

export function resetTunnelDaemonForTest(): void {
  instances.clear()
}
