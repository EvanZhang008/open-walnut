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

export const DAEMON_TWIN_STATE: Readonly<Record<string, { rule: TwinRule; where: string }>> = {
  'bridge.configure': { rule: 'one-name', where: 'DaemonConnection.pushBridgeConfig' },
  'host.slice': { rule: 'all-names', where: 'DaemonConnection.pushHostSlice, host-slice.ts buildHostSlice' },
  'triggers.configure': { rule: 'all-names', where: 'DaemonConnection.pushTriggers, routines/trigger-push.ts' },
  'server.configure': { rule: 'keeper-only', where: 'host-server/manager.ts reconcileOnce' },
  'jobs.configure': { rule: 'keeper-only', where: 'plugin-jobs/manager.ts reconcileOnce (a plugin set to run on any alias runs)' },
  'replica.sync': { rule: 'one-name', where: 'host-replica.ts keepSettingsOf (the keep settings of the name it goes by)' },
  'attachments.sync': { rule: 'one-name', where: 'attachment-replica.ts, through host-replica.ts keepSettingsOf' },
  'leader.configure': { rule: 'no-name', where: 'leader/primary-leader.ts' },
  'leader.spawnTemplate': { rule: 'no-name', where: 'spawn-template.ts (launch mode from the link host readiness)' },
  'workspace.configure': { rule: 'no-name', where: 'workspaces/daemon-client.ts' },
  'turns.configure': { rule: 'no-name', where: 'turn-snapshots/settings-push.ts' },
  'net.configure': { rule: 'no-name', where: 'net/net-mac.ts (only host-network rows)' },
  'hooks.configure': { rule: 'no-name', where: 'DaemonConnection.pushDaemonHooks' },
  'skills.sync': { rule: 'no-name', where: 'DaemonConnection skills sync' },
  'secrets.sync': { rule: 'no-name', where: 'secrets/fleet-secrets.ts' },
  'usage.budget.configure': { rule: 'per-session', where: 'usage/session-budget.ts' },
}
