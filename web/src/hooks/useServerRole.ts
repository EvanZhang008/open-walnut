/**
 * React's view of api/server-role.ts: whether this server is a replica answering
 * without its leader (it cannot dial ssh or run a fix, so Retry / Connect now /
 * Update / Install hide there and Check again relays to the Mac), and whether it
 * offers a capability. Both re-render when the server under the page changes
 * (a host replica's 4001/4002 handover, a reconnect, the Mac's presence).
 */
import { useSyncExternalStore } from 'react';
import type { ServerCapability, ServerRoleFacts } from '@/api/config';
import { getServerRole, getSettledServerRole, hasServerCapability, subscribeServerRole } from '@/api/server-role';

const replicaSnapshot = (): boolean => getServerRole().replica;

/** True while a replica answers this page without its leader; false (the Mac's view) until known. */
export function useIsReplicaServer(): boolean {
  return useSyncExternalStore(subscribeServerRole, replicaSnapshot, replicaSnapshot);
}

/** Whether this server offers `name`; false until known. */
export function useServerCapability(name: ServerCapability): boolean {
  const snap = () => hasServerCapability(name, getServerRole());
  return useSyncExternalStore(subscribeServerRole, snap, snap);
}

/** The facts, or null while the first read is on its way (the leader's facts if it failed). */
export function useSettledServerRole(): ServerRoleFacts | null {
  return useSyncExternalStore(subscribeServerRole, getSettledServerRole, getSettledServerRole);
}
