/**
 * "Open Settings" for a host: navigate to Settings › Remote Hosts, scroll to
 * that host's row and flash it. The same hash requested twice fires no
 * hashchange, so the row listens to a NONCE that bumps on every request.
 */
import { useSyncExternalStore } from 'react';

export const REMOTE_HOSTS_HASH = '#remote-hosts';
export const HOST_ROW_ID_PREFIX = 'rh-host-';

/** The DOM id of a host's Settings row (the hash target). */
export function hostRowId(alias: string): string {
  return HOST_ROW_ID_PREFIX + encodeURIComponent(alias);
}

/** The Settings URL for a host (or the Remote Hosts section). */
export function hostSettingsHref(alias?: string): string {
  return `/settings${alias ? `#${hostRowId(alias)}` : REMOTE_HOSTS_HASH}`;
}

interface FocusRequest { alias: string | null; nonce: number }
let focus: FocusRequest = { alias: null, nonce: 0 };
const listeners = new Set<() => void>();

/** Navigation state for 'and N more': the rows the cap hid, each flashed once in Settings. */
export interface HostSettingsNavState { flashHosts: readonly string[] }
export type HostSettingsNavigate = (to: string, options?: { state?: unknown }) => void;

/**
 * Navigate to the host's Settings row and ask it to scroll + flash (even when
 * the hash is unchanged). `flashHosts` rides the navigation state (read once
 * by the Remote hosts pane, then replaced, so a reload does not flash again).
 */
export function openHostSettings(navigate: HostSettingsNavigate, alias?: string, opts?: { flashHosts?: readonly string[] }): void {
  focus = { alias: alias ?? null, nonce: focus.nonce + 1 };
  for (const l of listeners) l();
  if (opts?.flashHosts) navigate(hostSettingsHref(alias), { state: { flashHosts: [...opts.flashHosts] } satisfies HostSettingsNavState });
  else navigate(hostSettingsHref(alias));
}

/** The flash list a navigation carried, if any (anything else in the state is ignored). */
export function flashHostsOf(state: unknown): string[] {
  const list = (state as { flashHosts?: unknown } | null | undefined)?.flashHosts;
  return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The latest focus request; the Settings panel scrolls and flashes on every new nonce. */
export function useHostSettingsFocus(): FocusRequest {
  return useSyncExternalStore(subscribe, () => focus, () => focus);
}

/** Test hook. */
export function __resetHostSettingsFocusForTests(): void {
  focus = { alias: null, nonce: 0 };
  listeners.clear();
}
