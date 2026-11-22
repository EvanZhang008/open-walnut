/**
 * The switch of phase 2 (docs/plan/one-service-every-host.md): a session on a host whose own
 * service can run it is assembled, run and judged there, and its leader keeps a copy.
 *
 * The experiment `host_runs_sessions` (core/experimental.ts). It keeps its own switch: "every
 * experiment on" never turns it on. The leader's config is copied to its hosts with the experiment
 * map, so both read the same choice: the leader before it hands a start to a host, the host before
 * it answers a session route. `WALNUT_HOST_RUNS_SESSIONS=1|0` overrides it for one process (tests,
 * an isolated service).
 */
import type { Config } from '../types.js'
import { experimentalEnabled } from '../experimental.js'

/** Capability a host's service names when it runs and judges sessions itself. */
export const SESSION_JUDGE_CAP = 'session-judge-v1'

export function hostRunsSessions(config: Pick<Config, 'experimental'> | null | undefined): boolean {
  const forced = process.env.WALNUT_HOST_RUNS_SESSIONS
  if (forced === '1' || forced === '0') return forced === '1'
  return experimentalEnabled(config?.experimental, 'host_runs_sessions')
}

export async function hostRunsSessionsNow(): Promise<boolean> {
  const forced = process.env.WALNUT_HOST_RUNS_SESSIONS
  if (forced === '1' || forced === '0') return forced === '1'
  try {
    const { getConfig } = await import('../config-manager.js')
    return hostRunsSessions(await getConfig())
  } catch {
    return false
  }
}
