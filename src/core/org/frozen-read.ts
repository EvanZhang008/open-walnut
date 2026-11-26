/**
 * The shared threads read, frozen in a test run (threads-sync.ts sharedView, threads-store.ts):
 * every reader of a node gets one value per version, so a reader that changes it changes it for
 * every other reader. A test run freezes it (on by default: tests/setup/threads-freeze-reads.ts; one run
 * opts out with WALNUT_THREADS_FREEZE_READS=0), so such a reader throws there. Never in a server:
 * nothing is frozen at run time.
 *
 * A catch-all on a read path would turn that throw into its quiet fallback and hide the mutation;
 * it calls rethrowFrozenWrite first, which rethrows a frozen write in a test process only.
 */

const TEST_PROCESS = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')

const freezing = () => TEST_PROCESS && process.env.WALNUT_THREADS_FREEZE_READS === '1'

/** Deep-freezes `file` in a test run that freezes shared reads; the same value either way. */
export function freezeReadForTests<T>(file: T): T {
  if (freezing()) deepFreeze(file)
  return file
}

function deepFreeze(v: unknown): void {
  if (!v || typeof v !== 'object' || Object.isFrozen(v)) return
  Object.freeze(v)
  for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
}

/** The TypeError a write to a frozen object throws, in JavaScriptCore (bun) and V8 (node) words. */
const FROZEN_WRITE = /read[ -]?only|not extensible|not writable|unable to delete property|cannot delete property/i

export function isFrozenWrite(err: unknown): boolean {
  return err instanceof TypeError && FROZEN_WRITE.test(err.message)
}

/** In a test process, a frozen write a catch-all caught goes on up; elsewhere it does nothing. */
export function rethrowFrozenWrite(err: unknown): void {
  if (TEST_PROCESS && isFrozenWrite(err)) throw err
}
