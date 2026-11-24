/**
 * The switch of phase 2 (docs/plan/one-service-every-host.md): a session on a host whose own
 * service can run it is assembled, run and judged there, and its leader keeps a copy.
 *
 * Two levels, read in ONE place (this file):
 *
 *   the experiment `host_runs_sessions` (core/experimental.ts). It keeps its own switch: "every
 *     experiment on" never turns it on.
 *   `hosts.<name>.runs_sessions` in the leader's config: true turns that one host on even with the
 *     experiment off, false keeps it off even with the experiment on, absent follows the experiment.
 *
 * Two questions, and every caller asks exactly one of them (tests/core/session-channel/switch-readers.test.ts):
 *
 *   hostRunsSessionsFor(config, host)  the leader's start decision for one host (judge-of.ts's
 *                                       start probe, through leader-side.ts hostJudges)
 *   hostRunsSessionsAny(config)         everything else, on any server: the host answering session
 *                                       routes and dialing the door, the door being open, the
 *                                       credential issuer, the companion's listener, the heartbeat.
 *                                       On while the experiment is on or some host is turned on.
 *
 * A host replica reads the leader's config through the config copy, which never carries
 * `hosts.*.runs_sessions` (an older replica would refuse the whole hosts row): the leader's copy
 * says the hosts turned on as the copy-only row `hosts_run_sessions` (replication/config-allowlist.ts).
 *
 * `WALNUT_HOST_RUNS_SESSIONS=1|0` overrides both questions for one process (tests, an isolated service).
 */
import type { Config } from '../types.js'
import { experimentalEnabled } from '../experimental.js'

/** Capability a host's service names when it runs and judges sessions itself. */
export const SESSION_JUDGE_CAP = 'session-judge-v1'
/**
 * Capability a host's service names when its start route also resumes a session the leader ran
 * until now (host-api.ts StartBody `resumeSessionId`): a host from before it would read such a
 * start as a new session, so a leader hands a resume only to a host that names this.
 */
export const SESSION_RESUME_CAP = 'session-resume-v1'
/**
 * Capability a host's service names when its resume also takes an ACP engine's session (Codex and
 * the rest): it asks its runtime for the ACP worker by the row's runtime id and attaches the session
 * to its own daemon. A host naming only SESSION_RESUME_CAP keeps ACP sessions legacy.
 */
export const SESSION_RESUME_ACP_CAP = 'session-resume-acp-v1'
/**
 * Capability a host's service names when it answers the leader's checks of its own sessions as
 * `lifecycle` calls (host-calls.ts: readSessionSupervision, lineAlreadyRan, cancelPendingStart;
 * sessions/host-lifecycle.ts). A host from before it is not asked them (sessions/host-judged-controls.ts).
 */
export const SESSION_HOST_CHECKS_CAP = 'session-host-checks-v1'

/**
 * Capability a host's service names when it answers the transcript reads of the sessions it runs
 * (host-calls.ts `history`, sessions/host-history-reads.ts): a leader reads such a session's
 * history there, parsed, instead of parsing the host's lines itself. Without it, read as before.
 */
export const SESSION_HISTORY_CAP = 'session-history-v1'

type SwitchConfig = Pick<Config, 'experimental' | 'hosts' | 'hosts_run_sessions'>

function forced(): boolean | null {
  const v = process.env.WALNUT_HOST_RUNS_SESSIONS
  return v === '1' ? true : v === '0' ? false : null
}

/** The host keys whose own `runs_sessions` is true (the leader's config), sorted. */
export function hostsTurnedOn(hosts: SwitchConfig['hosts'] | null | undefined): string[] {
  if (!hosts || typeof hosts !== 'object') return []
  return Object.entries(hosts).filter(([, h]) => !!h && (h as { runs_sessions?: unknown }).runs_sessions === true).map(([k]) => k).sort()
}

/** Would a new start on `hostKey` go to its service (given it names SESSION_JUDGE_CAP)? The leader's start decision. */
export function hostRunsSessionsFor(config: Partial<SwitchConfig> | null | undefined, hostKey: string): boolean {
  const f = forced()
  if (f !== null) return f
  const own = (config?.hosts?.[hostKey] as { runs_sessions?: unknown } | undefined)?.runs_sessions
  if (typeof own === 'boolean') return own
  return experimentalEnabled(config?.experimental, 'host_runs_sessions')
}

/** Is the switch on for any host: the experiment, or a host turned on by itself (on a replica, the copy's row). */
export function hostRunsSessionsAny(config: Partial<SwitchConfig> | null | undefined): boolean {
  const f = forced()
  if (f !== null) return f
  if (experimentalEnabled(config?.experimental, 'host_runs_sessions')) return true
  if (hostsTurnedOn(config?.hosts).length > 0) return true
  const copied = config?.hosts_run_sessions
  return Array.isArray(copied) && copied.some((k) => typeof k === 'string' && k !== '')
}

async function configNow(): Promise<Config | null> {
  try {
    const { getConfig } = await import('../config-manager.js')
    return await getConfig()
  } catch {
    return null
  }
}

/** hostRunsSessionsAny on this server's config now (false when it cannot be read). */
export async function hostRunsSessionsAnyNow(): Promise<boolean> {
  const f = forced()
  if (f !== null) return f
  const config = await configNow()
  return config ? hostRunsSessionsAny(config) : false
}

/** The leader's start decision per host, on its config now: one read, asked per host (off for every host when unreadable). */
export async function hostSwitchNow(): Promise<(hostKey: string) => boolean> {
  const f = forced()
  if (f !== null) return () => f
  const config = await configNow()
  return config ? (hostKey) => hostRunsSessionsFor(config, hostKey) : () => false
}
