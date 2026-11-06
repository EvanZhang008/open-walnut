/**
 * The fixture server's one Passwords vault, shared by every browser spec (vault lock).
 *
 * Every spec unlocks the same fixture vault, and Playwright runs other files against it at once.
 * A spec that ends every unlock (a person's Lock, Lock all, the extension popup's Lock, a lock
 * route with `all` or `everywhere`), changes the master password or recovers with the recovery
 * code locked a spec beside it in the middle of its test: a key popover read locked, a popup said
 * "Walnut is locked", a Passwords page never showed its items (2026-11-06, D02 round 2: 5 of 195
 * failed in one run, each right after another file's Lock). And a spec that names a device or a
 * window for sharing an unlock (`/api/test/vault-join`) shares every unlock made beside it, so a
 * Lock it asserts was undone by another file's unlock a moment later.
 *
 * So the vault is a readers/writer lock (spec-lock.ts specRwLock):
 *
 *  - `holdVaultLock('shared', …)`: a spec that needs its unlock to hold (it unlocks through
 *    vault-session-helper.ts or the UI). Shared holders run beside each other.
 *  - `holdVaultLock('exclusive', …)`: a spec whose tests end every unlock, change the master
 *    password, recover, set the vault up through the UI, or name a joiner. It runs alone.
 *  - `vaultExclusively(fn)`: one step of a shared spec that ends every unlock (its cleanup's
 *    Lock, say): the shared hold is given back, the step runs alone, and the shared hold is
 *    taken again when the spec held one.
 *
 * A serial file holds it for the whole file, any other file per test, as the other spec locks.
 *
 * Order with the other spec locks, so no two workers wait on each other: the VAULT lock first,
 * then the approvals lock (approvals-lock.ts), then the panel count lock. A spec that holds both
 * calls holdVaultLock before holdApprovalsLock, at the same or a wider scope, and never calls
 * vaultExclusively (that would take the vault lock while it holds approvals).
 * tests/web/vault-lock-guard.test.ts reads every spec and fails on one that breaks a rule here.
 */
import { specRwLock, type RwMode } from './spec-lock'

const lock = specRwLock('vault')

/** Hold the fixture's vault for this file (serial) or for each test (any other file). */
export function holdVaultLock(mode: RwMode, scope: 'file' | 'test'): void {
  lock.hold(mode, scope)
}

/**
 * Run `step` with the vault to this worker alone: for a step that ends every unlock in a spec
 * that otherwise holds the vault shared. Wait for the step's effect inside it (the lock screen
 * showing, the route's answer), so nobody unlocks before the Lock has landed.
 */
export async function vaultExclusively<T>(step: () => Promise<T>): Promise<T> {
  const before = lock.held()
  if (before === 'exclusive') return step()
  lock.release()
  await lock.acquire('exclusive')
  try {
    return await step()
  } finally {
    lock.release()
    if (before === 'shared') await lock.acquire('shared')
  }
}
