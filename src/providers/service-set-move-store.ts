/**
 * Where a service set move is kept (service-set-move.ts): the record in serviceSetMoves, and the
 * triggers' memory it owes in a file of its own beside it (0600, the same machine-local dir), so the
 * record, rewritten at every session the move stops, stays small (the memory holds up to 2000 seen
 * ids per trigger) and the memory is written once per take.
 */
import { KeyedUpdateStore } from './daemon-update-store.js'
import type { TriggerMemory } from './service-set-move-checks.js'
import { serviceSetMoves, validMemory, type MoveDeps } from './service-set-move.js'
import { isServiceSetId } from './service-set.js'

/** The triggers' memory a move record owes, per place, in a file of its own (0600, beside the record). */
interface KeptMemory { at: number; set: string; memory: TriggerMemory[] }
const validKept = (e: unknown): e is KeptMemory => {
  const k = e as KeptMemory
  return !!k && typeof k === 'object' && Number.isFinite(k.at) && isServiceSetId(k.set) && validMemory(k.memory)
}
/** Beside the move's record; a test that names the record's file gets this one beside it. */
const memoryFile = (): string | undefined => {
  const move = process.env.WALNUT_SERVICE_SET_MOVE_FILE
  return process.env.WALNUT_SERVICE_SET_MOVE_MEMORY_FILE || (move ? move.replace(/(\.json)?$/, '-memory.json') : undefined)
}
export const serviceSetMoveMemory = new KeyedUpdateStore<KeptMemory>('daemon-service-set-move-memory.json', memoryFile, 30 * 24 * 3600_000, validKept)

/**
 * The move's store for a place: the record in serviceSetMoves, its owed memory in serviceSetMoveMemory,
 * written only when it is a new copy (once per take), before the record that says it is owed; cleared
 * after the record that says it is not. A write that did not land rejects. A record that owes memory
 * whose copy cannot be read reads with none (keptMemory: null, never "no memory").
 */
export function moveStoreFor(place: string): MoveDeps['store'] {
  /** The copy on disk now, as last read or written here; undefined: not known. */
  let onDisk: TriggerMemory[] | null | undefined
  return {
    read: async () => {
      const r = await serviceSetMoves.read(place)
      if (!r) return null
      const { memory: _inRecord, ...rec } = r
      if (!rec.owed) return rec
      const kept = await serviceSetMoveMemory.read(place).catch(() => null)
      onDisk = kept && kept.set === rec.set ? kept.memory : undefined
      return onDisk ? { ...rec, memory: onDisk } : rec
    },
    write: async (r) => {
      if (r?.owed && r.memory !== undefined && r.memory !== onDisk) {
        await serviceSetMoveMemory.writeOrThrow(place, { at: Date.now(), set: r.set, memory: r.memory })
        onDisk = r.memory
      }
      if (r) {
        const { memory: _m, ...rec } = r
        await serviceSetMoves.writeOrThrow(place, rec)
      } else await serviceSetMoves.writeOrThrow(place, null)
      if (!r?.owed && onDisk !== null) {
        await serviceSetMoveMemory.write(place, null)
        onDisk = null
      }
    },
  }
}
