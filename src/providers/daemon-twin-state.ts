/**
 * What a daemon keeps ONCE per Walnut, and how the several aliases that can reach one daemon share it.
 *
 * One machine can sit in Settings under two names (a row found in ~/.ssh/config and the row it joined
 * the host network as) that reach ONE daemon process (daemon-twins.ts). Each name has its own link,
 * and every link pushes its copies. A copy the daemon keeps per Walnut, not per name, is then
 * overwritten by whichever link pushed last unless every link pushes the same one. 2026-11-20: the
 * bridge took the name `newdev` and the read copy held no `clouddev` session, so with the Mac asleep
 * the phone found `clouddev` unreachable; the found name's links also stopped the host server and the
 * plugin jobs the other name runs there.
 *
 * Every command the daemons take whose name ends in `.configure` or `.sync` (and the two others below)
 * is listed here with its rule; tests/providers/daemon-twin-state-ratchet.test.ts fails on one that is
 * not, so a new kind of copy says how two names share it before it ships.
 *
 * Each also says what it carries of a task the Mac keeps local (core/replication/host-private.ts):
 * `filteredIn`, the module that builds it through that one filter, or `taskFree`, why it holds no
 * task's data. tests/core/replication/host-private-guard.test.ts holds every entry to it.
 */
export type TwinRule =
  /** The same payload from every link, the one the name it goes by would send (daemonNames().keeper). */
  | 'one-name'
  /** One payload built over every alias of the daemon (daemonNames().aliases). */
  | 'all-names'
  /** Only the name it goes by sends it; another name's link leaves it alone. */
  | 'keeper-only'
  /** The payload does not depend on the link's name, so every link sends the same one. */
  | 'no-name'
  /** Kept per session, sent over that session's own link. */
  | 'per-session'

/** What a copy carries of a task kept local: built through host-private.ts in `filteredIn`, or none (`taskFree`, why). */
export type HostPrivate = { filteredIn: string } | { taskFree: string }

export const DAEMON_TWIN_STATE: Readonly<Record<string, { rule: TwinRule; where: string; hostPrivate: HostPrivate }>> = {
  'bridge.configure': { rule: 'one-name', where: 'DaemonConnection.pushBridgeConfig', hostPrivate: { taskFree: 'the bridge address and this host\'s credential to it' } },
  'host.slice': { rule: 'all-names', where: 'DaemonConnection.pushHostSlice, host-slice.ts buildHostSlice', hostPrivate: { filteredIn: 'src/core/host-slice.ts' } },
  'triggers.configure': { rule: 'all-names', where: 'DaemonConnection.pushTriggers, routines/trigger-push.ts', hostPrivate: { filteredIn: 'src/core/routines/trigger-push.ts' } },
  'server.configure': { rule: 'keeper-only', where: 'host-server/manager.ts reconcileOnce', hostPrivate: { taskFree: 'whether this host runs its own Walnut server, and how' } },
  'jobs.configure': { rule: 'keeper-only', where: 'plugin-jobs/manager.ts reconcileOnce (a plugin set to run on any alias runs)', hostPrivate: { taskFree: 'which plugin jobs run on this host and their schedules' } },
  'replica.sync': { rule: 'one-name', where: 'host-replica.ts keepSettingsOf (the keep settings of the name it goes by)', hostPrivate: { filteredIn: 'src/core/host-replica.ts' } },
  'attachments.sync': { rule: 'one-name', where: 'attachment-replica.ts, through host-replica.ts keepSettingsOf', hostPrivate: { filteredIn: 'src/core/host-replica.ts' } },
  'leader.configure': { rule: 'no-name', where: 'leader/primary-leader.ts', hostPrivate: { taskFree: 'which server leads the hosts and how to reach it' } },
  'leader.spawnTemplate': { rule: 'no-name', where: 'spawn-template.ts (launch mode from the link host readiness)', hostPrivate: { taskFree: 'how this host launches an engine CLI, the same for every task' } },
  'workspace.configure': { rule: 'no-name', where: 'workspaces/daemon-client.ts', hostPrivate: { taskFree: 'the workspace providers this host may use, the same for every task' } },
  'turns.configure': { rule: 'no-name', where: 'turn-snapshots/settings-push.ts', hostPrivate: { taskFree: 'the turn snapshot settings, the same for every session' } },
  'net.configure': { rule: 'no-name', where: 'net/net-mac.ts (only host-network rows)', hostPrivate: { taskFree: 'the host network rows: names and addresses of machines' } },
  'hooks.configure': { rule: 'no-name', where: 'DaemonConnection.pushDaemonHooks', hostPrivate: { taskFree: 'the hook scripts every session on the host runs' } },
  'skills.sync': { rule: 'no-name', where: 'DaemonConnection skills sync', hostPrivate: { taskFree: 'the one walnut skill file every host gets (core/skill-sync.ts)' } },
  'secrets.sync': { rule: 'no-name', where: 'secrets/fleet-secrets.ts', hostPrivate: { taskFree: 'the secrets the user shares with his hosts, no task data' } },
  'usage.budget.configure': { rule: 'per-session', where: 'usage/session-budget.ts', hostPrivate: { taskFree: 'one session\'s own budget, sent only over its own link to the host it runs on' } },
}
