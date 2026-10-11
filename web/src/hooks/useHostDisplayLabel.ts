/**
 * The display name of an exec host alias, live: it follows a rename in Settings
 * (the host status push) and never shows an internal alias (the cloud box's
 * `__cloudbox__` reads "Cloud"). Every surface that names a session's or a
 * file's host renders this, never the raw `host` field
 * (tests/web/host-alias-render-ratchet.test.ts).
 *
 * Reads the host status store directly, with a server snapshot as well: a card
 * rendered outside the browser (renderToString) names its host too, where
 * useHostStatus has no server snapshot and throws.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { getAllHostStatus, getHostStatus, subscribeHostStatus } from '@/hooks/useHostStatus';
import { hostDisplayLabel } from '@/utils/host-display-label';

/** One host's name. No host, or `__local__`, is "Local". */
export function useHostDisplayLabel(alias: string | null | undefined): string {
  const remote = alias && alias !== '__local__' ? alias : null;
  const read = () => (remote ? getHostStatus(remote)?.label : undefined);
  const label = useSyncExternalStore(subscribeHostStatus, read, read);
  return hostDisplayLabel(alias, label);
}

/** For a list of rows on different hosts: one subscription, a name for any alias. */
export function useHostDisplayLabels(): (alias: string | null | undefined) => string {
  const all = useSyncExternalStore(subscribeHostStatus, getAllHostStatus, getAllHostStatus);
  return useCallback(
    (alias: string | null | undefined) => hostDisplayLabel(alias, alias ? all.find((s) => s.host === alias)?.label : undefined),
    [all],
  );
}
