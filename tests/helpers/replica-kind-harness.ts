/**
 * A generic replication kind end to end in one process, for the kind tests
 * (docs/plan/walnut-replica-servers-impl.md, section 4): the REAL leader round
 * (core/replication/kind-leader.ts) against the REAL follower store side
 * (core/replication/kind-follower.ts createRowSetFollower + followerStep),
 * over a target that carries only what JSON carries. The follower's store is
 * an ordered in-memory map with the task store's apply rules (a row replaces
 * the whole row, an existing row keeps its place, a new one goes last, an
 * order places the rows it names first).
 */
import type { CloudReplicaReply } from '../../src/core/cloud-ingest.js'
import { createRowSetFollower, followerStep, serialChain, type RowSetFollower, type RowSetState } from '../../src/core/replication/kind-follower.js'
import { sha12 } from '../../src/core/replication/kind.js'
import type { LeaderKind } from '../../src/core/replication/kind-leader.js'
import type { ReplicaTarget } from '../../src/core/replication/replica-targets.js'

export interface Row { id: string; title: string; n?: number }

export const quietLog = { info: () => {}, warn: () => {} }

export function rowKind(kind = 'acme-rows', schemaVersion = 1): LeaderKind<Row> {
  return { kind, schemaVersion, key: (r) => r.id, hash: (r) => sha12(JSON.stringify(r)) }
}

export interface MemFollower {
  handler: RowSetFollower
  rows: Map<string, Row>
  order: string[]
  state: RowSetState
  held: Set<string>
  /** Every apply with removals: [local count before, removed]. */
  removals: Array<[number, number]>
  saves: number
  ids(): string[]
  /** A restart: the store and its saved state stay, memory goes. */
  restart(): void
}

export function memFollower(opts: { kind?: string; schemaVersion?: number; floor?: number } = {}): MemFollower {
  let saved: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
  const f: MemFollower = {
    handler: null as unknown as RowSetFollower,
    rows: new Map(), order: [], state: structuredClone(saved), held: new Set(), removals: [], saves: 0,
    ids: () => f.order.filter((k) => f.rows.has(k)),
    restart: () => { f.state = structuredClone(saved) },
  }
  f.handler = createRowSetFollower<Row>({
    kind: opts.kind ?? 'acme-rows',
    schemaVersion: opts.schemaVersion ?? 1,
    label: 'test replica',
    log: quietLog,
    removalFloor: opts.floor ?? 50,
    ordered: true,
    serial: serialChain(),
    load: async () => f.state,
    save: async () => { saved = structuredClone(f.state); f.saves++ },
    isRow: (v): v is Row => !!v && typeof (v as Row).id === 'string' && typeof (v as Row).title === 'string',
    key: (r) => r.id,
    localKeys: async () => f.ids(),
    apply: async ({ rows = [], removeIds = [], order }) => {
      if (removeIds.length > 0) f.removals.push([f.ids().length, removeIds.length])
      for (const r of rows) {
        if (!f.rows.has(r.id)) f.order.push(r.id)
        f.rows.set(r.id, { ...r })
      }
      for (const id of removeIds) f.rows.delete(id)
      f.order = f.order.filter((k) => f.rows.has(k))
      if (order) {
        const named = order.filter((k) => f.rows.has(k))
        const set = new Set(named)
        f.order = [...named, ...f.order.filter((k) => !set.has(k))]
      }
      return { skipped: [] }
    },
    held: async () => ({ has: (k) => f.held.has(k), orderWriteRecent: () => false }),
    changed: () => {},
  })
  return f
}

/** A host-like target over followerStep (404 -> unsupported, as core/host-server/index.ts maps it). */
export function memTarget(id: string, follower: { handler: RowSetFollower } | null, hooks: { calls?: Array<Record<string, unknown>> } = {}): ReplicaTarget {
  return {
    id, kind: 'host', label: id, available: async () => true,
    post: async (payload): Promise<CloudReplicaReply> => {
      const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
      hooks.calls?.push(body)
      const r = await followerStep(body, follower ? [follower.handler] : [])
      if (r.ok) return { ok: true, reply: r }
      if (r.status === 404) return { ok: false, outcome: 'unsupported', status: 404, error: r.error }
      // The route's JSON body: the refusal's own fields (local, removing) ride along.
      const { status, ...answer } = r
      return { ok: false, outcome: 'failed', status, error: r.error, body: { ...answer, ok: false } }
    },
  }
}
