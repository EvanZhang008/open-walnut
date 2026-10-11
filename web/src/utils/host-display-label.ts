/**
 * The ONE name a surface shows for an exec host.
 *
 * Order: the live status label (it follows a rename in Settings without a
 * reload), then the label the caller already carries (a working-dirs row, the
 * draft's `hostLabel`), then the alias. No host at all (or `__local__`) is this
 * machine: "Local", the same word the folder picker's host tab uses. The cloud
 * box's alias is internal and never shown: without a label it is "Cloud", the
 * server's twin rule (core/hosts/host-display-name.ts).
 */
export const LOCAL_HOST_LABEL = 'Local';

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
 * The small host tag beside a remote file, terminal or editor: "SSH: Dev box"
 * for a host reached over SSH, just "Cloud" for the cloud box (no SSH there).
 */
export function remoteHostTag(alias: string, label: string): string {
  return alias === CLOUD_BOX_ALIAS ? label : `SSH: ${label}`;
}
