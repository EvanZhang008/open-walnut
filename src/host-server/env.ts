/**
 * What a host server is told when its daemon starts it
 * (docs/plan/walnut-servers-everywhere.md, "A server on a host"). The Mac writes
 * these into the spec it hands the daemon (`server.configure`); the daemon adds
 * WALNUT_HOST_DAEMON_DIR (its own directory) and WALNUT_FOLLOWER_TOKEN.
 */

export interface HostServerEnv {
  /** Loopback port browsers reach (through this host's tunnel). Never trusted. */
  publicPort: number
  /** The host daemon's directory: its port file is how this server finds it. */
  daemonDir: string
  /** The leader's data dir and id: which Walnut this server follows. */
  leaderHome: string
  walnutId: string
  /** The token the daemon started this server with; `follower.hello` presents it. */
  followerToken: string
  /** The host's name in the Mac's settings, for the page a browser sees. */
  label: string
  /**
   * The Mac's key for this host (its `hosts` entry, a session record's `host`):
   * a replica reads that host's sessions and files here (replica/self-host.ts,
   * WP6). Absent from an older Mac: those reads go to the Mac.
   */
  hostKey?: string
}

function port(raw: string | undefined, name: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) throw new Error(`${name} must be a TCP port`)
  return n
}

function required(raw: string | undefined, name: string): string {
  if (!raw || !raw.trim()) throw new Error(`${name} is not set: a host server is started by its host's daemon, with the settings the Mac gave it`)
  return raw.trim()
}

export function readHostServerEnv(env: NodeJS.ProcessEnv = process.env): HostServerEnv {
  return {
    publicPort: port(env.WALNUT_HOST_SERVER_PORT, 'WALNUT_HOST_SERVER_PORT'),
    daemonDir: required(env.WALNUT_HOST_DAEMON_DIR, 'WALNUT_HOST_DAEMON_DIR'),
    leaderHome: required(env.WALNUT_LEADER_HOME, 'WALNUT_LEADER_HOME'),
    walnutId: required(env.WALNUT_WALNUT_ID, 'WALNUT_WALNUT_ID'),
    followerToken: required(env.WALNUT_FOLLOWER_TOKEN, 'WALNUT_FOLLOWER_TOKEN'),
    label: (env.WALNUT_HOST_LABEL ?? '').trim() || 'this host',
  }
}

/**
 * The two values a follower must not hand down (docs/plan/walnut-replica-servers-impl.md,
 * section 2, env scrub): the token the daemon started it with and the daemon's
 * directory. The full server program (`walnut web --replica`) spawns git,
 * shells, workers and model CLIs; a child holding either could present itself
 * to the host daemon as this follower. Read once at boot, then deleted from
 * the env every child is built from.
 */
export interface FollowerSecrets {
  followerToken: string | null
  hostDaemonDir: string | null
}

let taken: FollowerSecrets | null = null

export function takeFollowerSecrets(env: NodeJS.ProcessEnv = process.env): FollowerSecrets {
  taken ??= {
    followerToken: (env.WALNUT_FOLLOWER_TOKEN ?? '').trim() || null,
    hostDaemonDir: (env.WALNUT_HOST_DAEMON_DIR ?? '').trim() || null,
  }
  delete env.WALNUT_FOLLOWER_TOKEN
  delete env.WALNUT_HOST_DAEMON_DIR
  return taken
}

/** What `takeFollowerSecrets` read, or null before it ran. */
export function followerSecrets(): FollowerSecrets | null {
  return taken
}

export function _resetFollowerSecretsForTesting(): void {
  taken = null
}
