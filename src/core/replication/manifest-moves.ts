/**
 * Files that moved, said as moves to a host's copy ('host-replica-moves-v1').
 *
 * A manifest has no rename: a note that moved is one key gone and one key added. When the
 * one tree (notes_unified, src/core/artifacts/unify/) moved every note at once, each host's
 * copy saw a manifest that removes most of it and refused it, as the half rule says it must
 * (host-replica-core.ts, attachment-copy-core.ts). So the leader sends, beside the manifest,
 * `renamed: [[oldKey, newKey], ...]`: the removed keys it pairs with added keys. The host
 * moves each row it holds to its new key before the half rule counts, so the rule sees only
 * what is really gone, and a body that did not change is never sent again.
 *
 * Pairing, each removed key and each added key used at most once:
 *   1. the move's own map: the old key's place in the tree (mapVaultPath), or the added
 *      key's place before the move (the record's pairs);
 *   2. the same note id (frontmatter `id`, `m.id`) on both sides, when only one added key has it;
 *   3. the same body hash and size, one to one in key order.
 * A wrong pair costs nothing but the guard's count: the host still checks every body's hash
 * and asks for the ones it lacks. A leader that lost its store names no added keys, so it
 * still cannot empty a copy.
 */
import { mapVaultPath, type MoveMap } from '../artifacts/unify/map.js'
import { noteMoves, notePathBefore } from '../notes/note-path-moves.js'

/** The daemon capability (and the companion's `replica.status` feature) that takes `renamed`. */
export const HOST_REPLICA_MOVES = 'host-replica-moves-v1'

export type MovePair = [string, string]

/** The fields of a manifest line the pairing reads (a notes, memory, skills or attachments entry). */
export interface MovableEntry { k: string; h: string; n?: number; m?: Record<string, unknown> }

export interface MoveLookups {
  /** Where an old key is now, or null (no map). */
  after?: (oldKey: string) => string | null
  /** Where a key now was before the move, or null. */
  before?: (newKey: string) => string | null
}

/** The one tree's lookups for vault keys (notes, attachments), or none while the notes are where they were. */
export function vaultMoveLookups(map: MoveMap | null = noteMoves()): MoveLookups {
  if (!map) return {}
  return {
    after: (k) => mapVaultPath(k, map),
    before: (k) => { const b = notePathBefore(k); return b === k ? null : b },
  }
}

const idOf = (e: MovableEntry): string | null => (e.m && typeof e.m.id === 'string' && e.m.id ? e.m.id : null)

/**
 * The moves from `before` (the manifest the host took) to `entries` (the one now): removed
 * keys paired with added keys, by the map, then the id, then hash and size.
 */
export function pairMoves(before: ReadonlyMap<string, MovableEntry>, entries: readonly MovableEntry[], look: MoveLookups = {}): MovePair[] {
  const now = new Map<string, MovableEntry>()
  for (const e of entries) if (!now.has(e.k)) now.set(e.k, e)
  const removed = [...before.keys()].filter((k) => !now.has(k)).sort()
  const added = [...now.keys()].filter((k) => !before.has(k)).sort()
  if (removed.length === 0 || added.length === 0) return []
  const freeOld = new Set(removed)
  const freeNew = new Set(added)
  const out: MovePair[] = []
  const take = (o: string, n: string): void => { out.push([o, n]); freeOld.delete(o); freeNew.delete(n) }

  // 1. The move's map, both ways (an old folder named like a tree folder has exact entries only).
  if (look.after) for (const o of removed) { const n = look.after(o); if (n && n !== o && freeNew.has(n)) take(o, n) }
  if (look.before) {
    const oldByLower = new Map<string, string>()
    for (const o of freeOld) if (!oldByLower.has(o.toLowerCase())) oldByLower.set(o.toLowerCase(), o)
    for (const n of added) {
      if (!freeNew.has(n)) continue
      const b = look.before(n)
      const o = b ? (freeOld.has(b) ? b : oldByLower.get(b.toLowerCase())) : undefined
      if (o && freeOld.has(o)) take(o, n)
    }
  }

  // 2. The same note id, when it names one added key only.
  const newById = new Map<string, string | null>()
  for (const n of freeNew) { const id = idOf(now.get(n)!); if (id) newById.set(id, newById.has(id) ? null : n) }
  if (newById.size > 0) {
    for (const o of removed) {
      if (!freeOld.has(o)) continue
      const id = idOf(before.get(o)!)
      const n = id ? newById.get(id) : undefined
      if (n && freeNew.has(n)) take(o, n)
    }
  }

  // 3. The same body, one to one in key order.
  const sig = (e: MovableEntry): string => `${e.h}\u0000${e.n ?? ''}`
  const newBySig = new Map<string, string[]>()
  for (const n of added) if (freeNew.has(n)) { const s = sig(now.get(n)!); const l = newBySig.get(s); if (l) l.push(n); else newBySig.set(s, [n]) }
  for (const o of removed) {
    if (!freeOld.has(o)) continue
    const n = newBySig.get(sig(before.get(o)!))?.shift()
    if (n) take(o, n)
  }
  return out
}

/**
 * The moves the one tree's record names for `entries` (no manifest of the host's to compare):
 * each key's path before the move, where it differs. The host takes only the pairs whose old key
 * it holds and whose new key it does not.
 */
export function recordMoves(entries: readonly MovableEntry[], look: MoveLookups = vaultMoveLookups()): MovePair[] {
  if (!look.before) return []
  const out: MovePair[] = []
  const seenOld = new Set<string>()
  const seenNew = new Set<string>()
  for (const e of entries) {
    if (seenNew.has(e.k)) continue
    const b = look.before(e.k)
    if (!b || b === e.k || seenOld.has(b)) continue
    seenOld.add(b)
    seenNew.add(e.k)
    out.push([b, e.k])
  }
  return out
}

/** Two lists of moves as one: the first list wins a key both name. */
export function mergeMoves(first: readonly MovePair[], second: readonly MovePair[]): MovePair[] {
  const olds = new Set<string>()
  const news = new Set<string>()
  const out: MovePair[] = []
  for (const [o, n] of [...first, ...second]) {
    if (olds.has(o) || news.has(n)) continue
    olds.add(o)
    news.add(n)
    out.push([o, n])
  }
  return out
}
