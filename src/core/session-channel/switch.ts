/**
 * The switch of phase 2 (docs/plan/one-service-every-host.md): a session on a host whose own
 * service can run it is assembled, run and judged there, and its leader keeps a copy.
 *
 * The leader's choice. On only when set explicitly: `WALNUT_HOST_RUNS_SESSIONS=1` for one process
 * (tests, an isolated service), else `session.host_runs_sessions: true` in the leader's config (not
 * copied to hosts: an older host refuses an unknown session field). A host runs the sessions its
 * leader hands it (`hostAnswersSessionRoutes`) unless its own process says 0. It is deliberately not an entry of
 * the experiment registry yet: a Walnut with `every_experiment` on would turn a registry entry on
 * at once, and this path is not proven on real hosts. The leader reads it before it hands a start
 * to a host.
 */
import type { Config } from '../types.js'

/** Capability a host's service names when it runs and judges sessions itself. */
export const SESSION_JUDGE_CAP = 'session-judge-v1'

export function hostRunsSessions(config: Pick<Config, 'session'> | null | undefined): boolean {
  const forced = process.env.WALNUT_HOST_RUNS_SESSIONS
  if (forced === '1' || forced === '0') return forced === '1'
  return config?.session?.host_runs_sessions === true
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

/** On a host: answer the session routes the leader calls (the leader decided); `WALNUT_HOST_RUNS_SESSIONS=0` refuses. */
export function hostAnswersSessionRoutes(): boolean {
  return process.env.WALNUT_HOST_RUNS_SESSIONS !== '0'
}
