/**
 * May a replica hand a letter turn straight to its session while the Mac is away? The experiment
 * `replica_takeover` (experimental.ts; the design: task mval96lc-975c's takeover-design.html,
 * decided 2026-11-21).
 *
 * Without it, a letter reply and an option picked on a letter while the Mac is away wait in the
 * companion's journal for the Mac (human-inbox-replica.ts). With it on, the turn goes straight to
 * the session by the same direct path a chat message already takes (sessions/direct-host-send.ts),
 * only while all of this holds:
 *  - the companion leads the session's host (leader/backup-leader.ts): the user lets it stand in
 *    for the Mac ("Cloud companion takes over"), the Mac's heartbeat stopped, and that host's
 *    daemon granted the lead because it cannot hear the Mac either, so the Mac cannot be
 *    delivering there at the same time;
 *  - the Mac has been silent for TAKEOVER_AFTER_MS, not only the lead's minute: a Mac that is only
 *    reconnecting (a Wi-Fi change, a restart) gets every turn itself, in its own order, as before.
 * Sessions on the Mac itself keep waiting for it: only the Mac can reach them. A permission answer
 * on a led host is the lead's own (leader/host-session-control.ts), switch or not.
 *
 * The switch is the user's, set on the Mac: a replica reads the Mac's config copy
 * (replication/kinds/config.ts), never its own config, which the user does not edit.
 */
import { envTimerMs } from '../providers/daemon-core.js';
import { experimentalEnabled, type ExperimentalFeatureId } from './experimental.js';
import { isFollower } from './server-role.js';

/** How long the Mac must not have answered before a replica takes over. WALNUT_TAKEOVER_AFTER_MS for tests. */
export const TAKEOVER_AFTER_MS = envTimerMs(process.env.WALNUT_TAKEOVER_AFTER_MS, 5 * 60_000, 1_000);

/** An experiment's switch as the user set it on the Mac: the Mac's own config there, its copy on a replica. */
export async function leaderExperimentOn(id: ExperimentalFeatureId): Promise<boolean> {
  try {
    if (!isFollower()) {
      const { getConfig } = await import('./config-manager.js');
      return experimentalEnabled((await getConfig()).experimental, id);
    }
    const { readConfigCopy } = await import('./replication/kinds/config.js');
    const copy = await readConfigCopy();
    const flags = copy?.experimental;
    return experimentalEnabled(flags && typeof flags === 'object' ? flags as Record<string, boolean> : undefined, id);
  } catch {
    // No copy readable: the switch's default (off).
    return false;
  }
}

export type TakeoverState = { on: true } | { on: false; why: 'leader' | 'no-backup-leader' | 'too-soon' | 'switch-off' };

/**
 * Takeover may hold now: a replica that can stand in for the Mac, the Mac's heartbeat silent for
 * TAKEOVER_AFTER_MS (since this box started, when it never heard one), and the user's switch on.
 * Which session it may reach is takeoverHost's question.
 */
export async function takeoverState(now = Date.now()): Promise<TakeoverState> {
  if (!isFollower()) return { on: false, why: 'leader' };
  const { getBackupLeader } = await import('./leader/backup-leader.js');
  const leader = await getBackupLeader();
  if (!leader) return { on: false, why: 'no-backup-leader' };
  if (now - leader.status().primaryLastSeenAt < TAKEOVER_AFTER_MS) return { on: false, why: 'too-soon' };
  if (!(await leaderExperimentOn('replica_takeover'))) return { on: false, why: 'switch-off' };
  return { on: true };
}

/** The Mac's own hosts: a session there is reached only through the Mac (bridge-send.ts refuses them too). */
const MAC_SIDE_HOSTS = new Set(['__local__', '__cloudbox__', '__cloud__']);

export interface TakeoverHost { host: string; cwd?: string; model?: string; stopRequest?: unknown }

/**
 * Where a taken-over turn of `sessionId` goes: its host, when that is not the Mac's, its daemon is
 * on this box's bridge and this box leads it. Null: the turn waits for the Mac. `lead: false` only
 * asks for a host this box can question (whether an earlier delivery reached the CLI).
 */
export async function takeoverHost(sessionId: string, opts: { lead?: boolean } = {}): Promise<TakeoverHost | null> {
  const { resolveCloudSessionHost } = await import('./sessions/cloud-session-host.js');
  let target: Awaited<ReturnType<typeof resolveCloudSessionHost>>;
  try {
    target = await resolveCloudSessionHost(sessionId);
  } catch {
    return null;
  }
  if (!target || MAC_SIDE_HOSTS.has(target.host)) return null;
  const [{ bridgeForHost }, { getBackupLeader }] = await Promise.all([
    import('../web/ws/bridge-registry.js'),
    import('./leader/backup-leader.js'),
  ]);
  if (!bridgeForHost(target.host).connected) return null;
  if (opts.lead !== false && !(await getBackupLeader())?.leadFor(target.host)) return null;
  return {
    host: target.host,
    ...(target.cwd ? { cwd: target.cwd } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.stopRequest !== undefined ? { stopRequest: target.stopRequest } : {}),
  };
}
