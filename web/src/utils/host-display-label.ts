/**
 * The ONE name a surface shows for an exec host.
 *
 * Order: the live status label (it follows a rename in Settings without a
 * reload), then the label the caller already carries (a working-dirs row, the
 * draft's `hostLabel`), then the alias. No host at all (or `__local__`) is this
 * machine: "This Mac", the same word the folder picker's host tab uses. The cloud
 * box's alias is internal and never shown: without a label it is "Cloud", the
 * server's twin rule (core/hosts/host-display-name.ts).
 */
export const LOCAL_HOST_LABEL = 'This Mac';

/** This machine in a sentence ("This Mac" / "This computer", as the server's start source names it):
 *  the new task draft's Where field (experiment project_first_start), where the host leads the path. */
export function thisMachineName(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac/i.test(platform) ? 'This Mac' : 'This computer';
}

/** The cloud companion's host alias (core/hosts/cloud-box-host.ts), and its name when nothing else is known. */
export const CLOUD_BOX_ALIAS = '__cloudbox__';
export const CLOUD_BOX_LABEL = 'Cloud';

export function hostDisplayLabel(
  alias: string | null | undefined,
  liveLabel?: string,
  fallbackLabel?: string,
): string {
  if (!alias || alias === '__local__') return LOCAL_HOST_LABEL;
  return liveLabel || fallbackLabel || (alias === CLOUD_BOX_ALIAS ? CLOUD_BOX_LABEL : alias);
}

/**
 * How this machine reaches a host: itself, over SSH, through the host network, or (the
 * cloud box) through the cloud companion. From the host's status frame (`ssh: false` +
 * `via`, src/core/hosts/host-status.ts); a frame from an older server names no route, and
 * then a host-network machine is still known by its placeholder hostname.
 */
export type HostRoute = 'local' | 'ssh' | 'host-network' | 'cloud';

/** The placeholder hostname a host-network machine carries (core/net/net-mac.ts). */
const NET_HOSTNAME_SUFFIX = '.walnut-net.invalid';

export function hostRoute(
  alias: string | null | undefined,
  status?: { ssh?: false; via?: 'host-network' | 'cloud'; hostname?: string } | null,
): HostRoute {
  if (!alias || alias === '__local__') return 'local';
  if (alias === CLOUD_BOX_ALIAS) return 'cloud';
  if (status?.ssh === false) return status.via ?? 'host-network';
  if (status?.hostname?.endsWith(NET_HOSTNAME_SUFFIX)) return 'host-network';
  return 'ssh';
}

/**
 * The small host tag beside a remote file, terminal or editor, by the real connection:
 * "SSH: Dev box" over SSH, "Host network: Studio" on the host network, just "Cloud" for
 * the cloud box.
 */
export function remoteHostTag(alias: string, label: string, route: HostRoute = hostRoute(alias)): string {
  if (route === 'cloud' || route === 'local') return label;
  return route === 'host-network' ? `Host network: ${label}` : `SSH: ${label}`;
}

/** How a port of the host reaches this machine, in words ("over an SSH tunnel"). */
export function hostRouteTunnelWords(route: HostRoute): string {
  if (route === 'host-network') return 'through the host network';
  if (route === 'cloud') return 'through the cloud companion';
  if (route === 'local') return 'directly';
  return 'over an SSH tunnel';
}
