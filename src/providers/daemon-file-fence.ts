/**
 * The file-change fence of each host's pooled DaemonConnection, reachable without importing it
 * (local-daemon.ts cannot: daemon-connection.ts imports it). An overdue swap of this Mac's managed
 * daemon fences its connection the way the SSH and host network paths fence theirs
 * (DaemonConnection.fenceFileChanges, daemon-over-busy.ts).
 */
const fences = new Map<string, () => () => void>()

export function setDaemonFileFence(hostKey: string, fence: (() => () => void) | null): void {
  if (fence) fences.set(hostKey, fence)
  else fences.delete(hostKey)
}

/** Hold the host's file changes until the release; a host with no connection has nothing to hold. */
export function fenceDaemonFileChanges(hostKey: string): () => void {
  return fences.get(hostKey)?.() ?? (() => {})
}
