/**
 * The cloud companion's copy of the Mac's notes, memory and skills (stage 4 of
 * docs/plan/walnut-companion-unified-replica.md): the host replica a daemon keeps
 * (providers/host-replica-core.ts), run in this server, under `cache/replica/host/`.
 * The Mac sends it the rounds it sends a host (core/host-replica.ts syncHostReplica,
 * host key `companion`) through `POST /bridge/host-replica`
 * (web/routes/bridge-host-replica.ts), with a daemon's command names and replies.
 *
 * One home: the companion has one Mac, so every round and every read uses `mac`,
 * whatever data dir the Mac names.
 *
 * Cloud companion only: anywhere else there is no copy (null).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { createHostReplica, type HostReplica, type ReplicaKind } from '../providers/host-replica-core.js'
import { followerKind } from './server-role.js'

/** The one home this copy keeps (its files are named by it). */
export const COMPANION_REPLICA_HOME = 'mac'

export const companionHostReplicaDir = (): string => path.join(WALNUT_HOME, 'cache', 'replica', 'host')

let replica: HostReplica | null = null

/** The copy, or null on anything but a cloud companion. */
export function companionHostReplica(): HostReplica | null {
  if (followerKind() !== 'companion') return null
  if (!replica) {
    replica = createHostReplica({
      fs, path,
      dir: companionHostReplicaDir(),
      now: () => Date.now(),
      keyOf: (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 16),
      hash: (body) => crypto.createHash('sha256').update(body).digest('hex').slice(0, 12),
      log: (level, msg, data) => log.session[level](`companion copy: ${msg}`, data),
    })
  }
  return replica
}

/** True when a whole manifest of `kind` arrived at least once (a read can take the copy). */
export function companionCopyHolds(kind: ReplicaKind): boolean {
  const r = companionHostReplica()
  return r !== null && r.status(COMPANION_REPLICA_HOME)[kind]?.asOf != null
}

export type HostReplicaReply = { ok: true } & Record<string, unknown> | { ok: false; error: string; errorKind?: string; detail?: unknown }

/**
 * One command of the Mac's round, answered as a daemon answers it
 * (daemon-standalone.ts cmdReplica): `replica.sync`, `replica.put`, `replica.drop`,
 * `replica.status`. A refusal the Mac reads (`manifest_removes_most_rows`) carries
 * its code and sizes. Never throws.
 */
export function companionHostReplicaCommand(cmd: unknown, params: Record<string, unknown>): HostReplicaReply {
  const r = companionHostReplica()
  if (!r) return { ok: false, error: 'not a cloud companion' }
  const home = COMPANION_REPLICA_HOME
  try {
    switch (cmd) {
      case 'replica.sync':
        return { ok: true, ...r.sync(home, params.kind, params.entries, params.asOf, params.opts as Record<string, unknown> | undefined, { confirm: params.confirm, confirmFor: params.confirmFor }) }
      case 'replica.put':
        return { ok: true, ...r.put(home, params.kind, params.files) }
      case 'replica.drop':
        return { ok: true, ...r.drop(home, params.kind) }
      case 'replica.status':
        return { ok: true, kinds: r.status(home) }
      default:
        return { ok: false, error: 'unknown command', errorKind: 'bad_request' }
    }
  } catch (err) {
    const e = err as Error & { code?: unknown; detail?: unknown }
    return {
      ok: false, error: e.message,
      ...(typeof e.code === 'string' ? { errorKind: e.code } : {}),
      ...(e.detail && typeof e.detail === 'object' ? { detail: e.detail } : {}),
    }
  }
}

/** Tests: a fresh copy object over the files on disk. */
export function _resetCompanionHostReplicaForTesting(): void {
  replica = null
}
