/**
 * The Demo's remote hosts (`walnut demo`, src/commands/demo*.ts).
 *
 * A Demo server is a test server (IS_EPHEMERAL) with a data dir of its own per
 * generation, so every host it reaches over ssh gets the isolated daemon any test
 * server gets there (remote-isolation.ts): a root of its own named by that data
 * dir, installs inside it, removed when the Demo stops it. The one difference is
 * that the Demo needs no WALNUT_EPHEMERAL_REMOTE_HOSTS for it, and that once its
 * stop began (closeDemoRemoteHosts) no host is isolated any more, so nothing dials
 * a host again and starts a daemon there after its stop. `__local__`, the
 * companion's box and host network machines are never the Demo's.
 *
 * What stays off for the Demo on a remote host: boot start setup
 * (daemon-connection.ts _bootStart reads IS_EPHEMERAL), a host server
 * (core/host-server/index.ts, web/routes/host-servers.ts), plugin jobs
 * (core/plugin-jobs/index.ts) and terminals (web/terminal/spawn.ts).
 */

/** The companion's box (core/hosts/cloud-box-host.ts CLOUD_BOX_HOST_ALIAS): reached through its tunnel, never ssh. */
const CLOUD_BOX_ALIAS = '__cloudbox__'

let closed = false

/** The Demo is stopping: no connection made from now on gets a daemon of its own. */
export function closeDemoRemoteHosts(): void {
  closed = true
}

/** Test seam ONLY. */
export function _reopenDemoRemoteHostsForTesting(): void {
  closed = false
}

/** The `demo` input of remoteIsolationFor: undefined when this is not a Demo server. */
export function demoIsolationInput(isDemo: boolean): { closed: boolean } | undefined {
  return isDemo ? { closed } : undefined
}

/** Whether a configured host is one the Demo runs its own daemon on (false outside a Demo). */
export function isDemoLiftedHost(
  hostKey: string, def: { transport?: string; cloud_box?: boolean } | undefined, isDemo: boolean,
): boolean {
  if (!isDemo || !hostKey || hostKey === '__local__') return false
  return hostKey !== CLOUD_BOX_ALIAS && def?.cloud_box !== true && def?.transport !== 'net'
}
