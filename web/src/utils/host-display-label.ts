/**
 * The ONE name a surface shows for an exec host.
 *
 * Order: the live status label (it follows a rename in Settings without a
 * reload), then the label the caller already carries (a working-dirs row, the
 * draft's `hostLabel`), then the alias. No host at all is this machine: "Local",
 * the same word the folder picker's host tab uses.
 */
export const LOCAL_HOST_LABEL = 'Local';

export function hostDisplayLabel(
  alias: string | null | undefined,
  liveLabel?: string,
  fallbackLabel?: string,
): string {
  if (!alias) return LOCAL_HOST_LABEL;
  return liveLabel || fallbackLabel || alias;
}
