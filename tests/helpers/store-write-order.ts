/**
 * The order of the daemon update stores' writes (src/providers/daemon-update-store.ts), each as
 * `<file name>:set` or `<file name>:clear`; the writes still happen. For the rule that a build's
 * hold is on disk before the update's record goes (a server killed in between keeps one of them).
 *
 * `delayMs`: every write reaches the disk this much later, and `onDisk` hears it then, so a test
 * can tell a write that was awaited from one only asked for (2026-11-04 review 5).
 */
import { vi } from 'vitest'
import { KeyedUpdateStore } from '../../src/providers/daemon-update-store.js'

export function recordStoreWrites(o: { delayMs?: number; onDisk?: (write: string) => void } = {}): string[] {
  const seen: string[] = []
  const real = KeyedUpdateStore.prototype.write
  vi.spyOn(KeyedUpdateStore.prototype, 'write').mockImplementation(function (this: KeyedUpdateStore<{ at: number }>, key: string, entry: { at: number } | null) {
    const write = `${(this as unknown as { fileName: string }).fileName}:${entry ? 'set' : 'clear'}`
    seen.push(write)
    if (!o.delayMs) return real.call(this, key, entry)
    return new Promise<void>((resolve) => setTimeout(resolve, o.delayMs))
      .then(() => real.call(this, key, entry))
      .then(() => { o.onDisk?.(write) })
  })
  return seen
}

/** The writes of the build hold and the update record only. */
export const holdAndRecord = (seen: string[]) => seen.filter((w) => /^daemon-(build-backoff|update-unread)\.json:/.test(w))
