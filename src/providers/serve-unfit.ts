/**
 * "This build cannot be the host's one Walnut service there" (one-service-mode.ts walnutFileUnfit),
 * kept per host and build, with the rule that decides it outside an update (the host's system is the
 * mode decision's own fact, one-service-mode.ts wantedNow through one-service-targets.ts):
 *
 *   - roleFallbackUnfit: the host's service fell back to the daemon (its launcher facts name the
 *     fallback marker, service-lead-ready.ts) on the build this leader expects;
 *   - serveUnfits: the store, so a leader restart on the same build (a deploy, up to every 10
 *     minutes) does not ask the host's service again and put it through more unready starts. A week:
 *     a build lives less, and a newer build is asked again.
 */
import { KeyedUpdateStore } from './daemon-update-store.js'
import type { LauncherFacts } from './service-launcher-beat.js'

export interface ServeUnfit { expected: string; why: string }
export interface ServeUnfitRecord extends ServeUnfit { at: number }

const validUnfit = (e: unknown): e is ServeUnfitRecord => {
  const r = e as ServeUnfitRecord
  return !!r && typeof r === 'object' && Number.isFinite(r.at) && typeof r.expected === 'string' && r.expected.length > 0 && typeof r.why === 'string'
}

/** Per `ssh:<host>` (the key the other update records use). */
export const serveUnfits = new KeyedUpdateStore<ServeUnfitRecord>('daemon-update-serve-unfit.json', 'WALNUT_UPDATE_SERVE_UNFIT_FILE', 7 * 24 * 3600_000, validUnfit)

/**
 * The fallback marker in the host's launcher facts as an unfit of `expected`: only this Walnut's
 * follower role (`home`), on the version the launcher runs now, while the host runs that build.
 */
export function roleFallbackUnfit(i: { launcher: LauncherFacts | null; expected: string | null; running: string | null; home: string }): ServeUnfit | null {
  const f = i.launcher?.roleFallback
  if (!f || f.role !== 'replica' || f.home !== i.home || !i.expected || i.running !== i.expected || f.exe !== i.launcher?.current) return null
  return { expected: i.expected, why: `the walnut file did not come up as the Walnut service there (${f.why || 'no reason given'}), so it runs the two programs` }
}
