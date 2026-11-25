/**
 * The one shape of a host's Walnut service as a daemon runs it (`server.configure`): the environment
 * every host server gets, and the replica program (`web --replica`) with the plain host server as its
 * crash-loop fallback. The leader's host-server manager (manager.ts) sends it to each host; the leader
 * switch sends the same thing to the old leader's own daemon at a handover, so the old machine goes
 * on as an ordinary host of the new leader (core/leader/switch/host-follow.ts).
 */
import { copylessEnv } from './copyless.js'

export interface HostServerEnvInput {
  /** The service's own data dir on that machine (never a leader's home). */
  dataDir: string
  /** Its run dir (logs, scratch): never the daemon's own dir. */
  runDir: string
  port: number
  /** The leader's data dir the service follows (the `home` the daemon keeps the spec under). */
  leaderHome: string
  walnutId: string
  label: string
}

/** The environment of a host server, replica or plain. */
export function hostServerEnvOf(i: HostServerEnvInput): Record<string, string> {
  return {
    OPEN_WALNUT_HOME: i.dataDir,
    // Its own run dir (logs, scratch): never the host daemon's /tmp/open-walnut.
    WALNUT_DAEMON_DIR: i.runDir,
    WALNUT_HOST_SERVER: '1',
    WALNUT_HOST_SERVER_PORT: String(i.port),
    WALNUT_LEADER_HOME: i.leaderHome,
    WALNUT_WALNUT_ID: i.walnutId,
    WALNUT_HOST_LABEL: i.label,
    WALNUT_NO_AUTO_UPDATE: '1',
  }
}

export interface ProgramRun { args: string[]; env: Record<string, string>; fallback?: { args: string[]; env: Record<string, string> } }

/**
 * What runs: the replica (`web --replica`) with the plain host server as its fallback, or the plain
 * host server alone. `prefix`: the program's own leading args (the CLI entry, for a Node).
 */
export function hostProgramRun(o: { prefix: readonly string[]; env: Record<string, string>; replica: boolean; hostKey: string; gateway: boolean; copyless?: boolean }): ProgramRun {
  const hostServerArgs = [...o.prefix, 'host-server']
  if (!o.replica) return { args: hostServerArgs, env: o.env }
  return {
    args: [...o.prefix, 'web', '--replica'],
    // Its own run dir (hostServerEnvOf): a replica never writes the daemon's dir or /tmp/open-walnut.
    // WALNUT_HOST_KEY: this leader's name for the host, the `host` of the sessions that run there:
    // the replica reads them and their files itself (replica/self-host.ts, WP6), and the
    // console tells a session here from one on the leader (WP7).
    // WALNUT_CAPABILITIES: the replica answers this host's own `walnut` calls while the leader
    // is away (capabilities/host-local-calls.ts), when the daemon can hand them over.
    env: {
      ...o.env, WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: o.hostKey,
      ...(o.gateway ? { WALNUT_CAPABILITIES: 'host-local-calls' } : {}),
      // A host that keeps no copy of the leader's data (copyless.ts, kinds/gate.ts keepsNoCopy).
      ...copylessEnv(o.copyless === true),
    },
    // The daemon runs this by itself after a crash loop (it works while the leader sleeps).
    fallback: { args: hostServerArgs, env: o.env },
  }
}
