/**
 * Every follower the primary keeps copies on (docs/plan/walnut-servers-everywhere.md):
 * the cloud companion, and each host server. A copy (task-replica.ts,
 * search-replica.ts) loops `replicaTargets()` and keeps its own state per
 * `target.id`; how a step reaches a follower is the target's business.
 *
 *   companion  POST /bridge/replica over HTTPS (cloud-ingest.ts postToCloudReplica)
 *   host       POST /bridge/replica on the host server, over a stream the host's
 *              daemon passes from the Mac's link to the host server's
 *              (registered by core/host-server/)
 *
 * Every follower answers /bridge/replica with the same stores, so a payload is
 * the same for every target.
 */

import type { CloudReplicaReply } from '../cloud-ingest.js'
import type { FollowerKind } from '../server-role.js'

export interface ReplicaTarget {
  /** 'companion' | `host:<hostKey>` */
  id: string
  kind: FollowerKind
  /** For Settings: "Cloud companion", a host's label. */
  label: string
  post(payload: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<CloudReplicaReply>
  /** Set up and reachable enough to build a manifest for. */
  available(): Promise<boolean>
}

const COMPANION: ReplicaTarget = {
  id: 'companion',
  kind: 'companion',
  label: 'Cloud companion',
  post: async (payload, opts) => (await import('../cloud-ingest.js')).postToCloudReplica(payload, opts),
  available: async () => (await import('../cloud-ingest.js')).cloudReplicaAvailable(),
}

const registered = new Map<string, ReplicaTarget>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const cb of listeners) {
    try { cb() } catch { /* one listener never stops the others */ }
  }
}

/** The companion first, then the host servers in the order they were registered. */
export function replicaTargets(): ReplicaTarget[] {
  return [COMPANION, ...registered.values()]
}

/** A host server came up (or its forward changed). Returns the unregister. */
export function registerReplicaTarget(target: ReplicaTarget): () => void {
  registered.set(target.id, target)
  changed()
  return () => {
    if (registered.get(target.id) !== target) return
    registered.delete(target.id)
    changed()
  }
}

export function onReplicaTargetsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function _resetReplicaTargetsForTesting(): void {
  registered.clear()
  listeners.clear()
}
