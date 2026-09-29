/**
 * ephemeral-guard: an ephemeral server must run on a snapshot copy, never on the
 * production Walnut's own data dir.
 *
 * An ephemeral server clears every session pid it holds at boot (it inherited
 * them from another Walnut's data, see scrubInheritedSessionPids) and treats its
 * data as disposable. Pointed at the production dir, that boot would rewrite the
 * user's real session store. This happens when the child is started by hand or
 * by an in-process harness without OPEN_WALNUT_HOME: constants.ts then falls back
 * to ~/.open-walnut. Production always runs on that default home (dev-prod.sh
 * unsets OPEN_WALNUT_HOME), so the default is the home to refuse.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The data dirs a production Walnut uses for this OS account: ~/.open-walnut
 * under $HOME and under the account's own home, because HOME can be faked (test
 * fixtures do exactly that) and must not hide the real one.
 */
export function productionWalnutHomes(): string[] {
  const homes = new Set<string>()
  const add = (home: string | undefined) => { if (home) homes.add(path.join(home, '.open-walnut')) }
  add(os.homedir())
  try { add(os.userInfo().homedir) } catch { /* no passwd entry: $HOME is all there is */ }
  return [...homes]
}

function canonical(dir: string): string {
  const resolved = path.resolve(dir)
  try { return fs.realpathSync(resolved) } catch { return resolved }
}

export function isProductionWalnutHome(dir: string, productionHomes: readonly string[] = productionWalnutHomes()): boolean {
  const target = canonical(dir)
  return productionHomes.some((home) => canonical(home) === target)
}

/** Throws when `dir` is a production data dir. Runs before an ephemeral server touches its store. */
export function assertEphemeralHomeIsNotProduction(dir: string, productionHomes?: readonly string[]): void {
  if (!isProductionWalnutHome(dir, productionHomes)) return
  throw new Error(
    `Ephemeral server refused to start: its data dir ${dir} is the production Walnut's own. `
    + 'An ephemeral server runs on a snapshot copy (open-walnut web --ephemeral makes one) and would rewrite this store.',
  )
}
