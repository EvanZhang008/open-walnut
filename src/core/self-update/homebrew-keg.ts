/**
 * A Homebrew keg of the 0.6.x formula whose Node archive updated itself onto
 * the npm launcher (install-kind.ts `homebrewKeg`). That formula promised
 * "Walnut keeps itself up to date", so the keg goes on updating itself with the
 * archive's npm, as 0.6.x did; `brew upgrade open-walnut` is only offered as the
 * way to the compiled file, and only when the formula would not take it back:
 *
 *   - Homebrew acts only when the formula's version is newer than the keg's own
 *     (the directory name, `Cellar/open-walnut/0.6.17`), which never moves when
 *     the archive updates itself inside it.
 *   - Whatever the keg now runs may be newer than the formula (the formula
 *     follows releases, the keg follows npm, and a tap is as old as its last
 *     `brew update`). An upgrade then installs an older Walnut, so no hint.
 *
 * The formula's version is read from the tap the keg was installed from (its
 * INSTALL_RECEIPT.json names it): a couple of small file reads, no `brew` run.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { HOMEBREW_UPDATE_COMMAND } from './install-kind.js'
import { isNewer } from './version-compare.js'

export interface KegReaders {
  readFile?: (p: string) => Promise<string>
}

const readText = (p: string) => fsp.readFile(p, 'utf8')

/** `version "x.y.z"` of a formula file, or null. */
export function formulaVersionOf(rb: string): string | null {
  return /^\s*version\s+"([^"]+)"/m.exec(rb)?.[1] ?? null
}

/**
 * The formula file this keg was installed from: the receipt's own path, else the
 * tap it names (`user/repo` is `Library/Taps/user/homebrew-repo`, under the
 * prefix on Apple silicon and Linux, under `<prefix>/Homebrew` on Intel).
 */
export async function formulaVersionForKeg(keg: string, readers: KegReaders = {}): Promise<string | null> {
  const read = readers.readFile ?? readText
  let source: { path?: unknown; tap?: unknown } = {}
  try {
    source = ((JSON.parse(await read(path.join(keg, 'INSTALL_RECEIPT.json'))) as { source?: typeof source }).source) ?? {}
  } catch {
    return null
  }
  const candidates: string[] = []
  if (typeof source.path === 'string' && source.path.endsWith('.rb')) candidates.push(source.path)
  if (typeof source.tap === 'string' && /^[^/]+\/[^/]+$/.test(source.tap)) {
    const [user, repo] = source.tap.split('/') as [string, string]
    const prefix = path.dirname(path.dirname(path.dirname(keg)))
    for (const root of [prefix, path.join(prefix, 'Homebrew')]) {
      const tapDir = path.join(root, 'Library', 'Taps', user, repo.startsWith('homebrew-') ? repo : `homebrew-${repo}`)
      candidates.push(path.join(tapDir, 'Formula', 'open-walnut.rb'), path.join(tapDir, 'Formula', 'o', 'open-walnut.rb'), path.join(tapDir, 'open-walnut.rb'))
    }
  }
  for (const file of candidates) {
    try {
      const version = formulaVersionOf(await read(file))
      if (version) return version
    } catch { /* the next place */ }
  }
  return null
}

export interface BrewHint {
  /** One line for the update card and `walnut update`. */
  note: string
  command: string
  /** The formula's version on this Mac now. */
  formula: string
}

/**
 * The `brew upgrade` line for a keg that updates itself, or null: when the
 * formula on this Mac is newer than the keg's own version (so brew acts) and not
 * older than `current` (so it takes nothing back).
 */
export async function brewUpgradeHint(keg: string | null | undefined, current: string, readers: KegReaders = {}): Promise<BrewHint | null> {
  if (!keg) return null
  const formula = await formulaVersionForKeg(keg, readers)
  if (!formula) return null
  const kegVersion = path.basename(keg)
  if (!isNewer(formula, kegVersion)) return null
  if (isNewer(current, formula)) return null
  return {
    note: `Homebrew installed this copy, and it updates itself; ${HOMEBREW_UPDATE_COMMAND} moves it to the compiled file (formula ${formula}).`,
    command: HOMEBREW_UPDATE_COMMAND,
    formula,
  }
}
