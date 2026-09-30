/**
 * Which source wins when several contribute the same data type.
 *
 * Mirrors the Health app's documented rule (support.apple.com/108779, "Manage
 * Health data on your iPhone, iPad, or Apple Watch", published 2026-09-14):
 *   "If multiple sources contribute the same data type, the data source at the
 *    top will take priority over others."
 *   "By default, Health prioritizes data in this order: 1. Health data that you
 *    enter manually. 2. Data from your iPhone, iPad, and Apple Watch. 3. Data from
 *    apps and Bluetooth devices."
 *   "When you add a new data source, it appears above all apps and devices that
 *    contribute data in Health."
 *   "New apps or devices that you add are listed at the top automatically, above
 *    your iPhone or iPad."
 * Read together: the three-tier order describes the sources you start with, and
 * every source added later goes above ALL apps and devices, whatever its tier. So
 * after manual entries the order is simply newest-added first, across tiers.
 *
 * HealthKit exposes neither the user's own reordering nor the date a source was
 * added, so:
 *   - a saved `sleepSourceOrder` (bundle ids, set in Walnut) wins outright;
 *   - otherwise `manual` first, then newest-added first, where "added" is the
 *     PROXY first time Walnut saw the source (sources.first_seen_ms). Sources first
 *     seen in the same upload fall back to the later first sample (the source whose
 *     data starts later was most likely added later), then bundle id.
 *
 * Manually entered samples (HKMetadataKeyWasUserEntered) are their own virtual
 * source, `manual`, whatever app wrote them.
 */

export const MANUAL_SOURCE = 'manual'

export interface SourceInfo {
  bundle: string
  /** When Walnut first saw this source: the stand-in for "added to Health". */
  firstSeenMs: number
  firstSampleMs: number
  /** An iPhone / iPad / Apple Watch device source (display only; not a rank input). */
  apple: boolean
}

/** HealthKit device sources carry `com.apple.health.<UUID>` bundle ids. */
export function isAppleDeviceSource(bundle: string, device?: string): boolean {
  if (/^com\.apple\.health\./i.test(bundle)) return true
  return /^com\.apple\./i.test(bundle) && /^(iPhone|iPad|Watch)/i.test(device ?? '')
}

export function sourceKey(bundle: string, userEntered: boolean): string {
  return userEntered ? MANUAL_SOURCE : bundle
}


/**
 * Rank every key (0 = highest priority). `userOrder` holds bundle ids (and may name
 * `manual`); keys it does not list follow in the default order.
 */
export function rankSources(
  keys: Iterable<string>,
  infos: ReadonlyMap<string, SourceInfo>,
  userOrder?: readonly string[] | null,
): Map<string, number> {
  const unique = [...new Set(keys)]
  const saved = new Map((userOrder ?? []).map((k, i) => [k, i] as const))
  const listed = unique.filter((k) => saved.has(k)).sort((a, b) => saved.get(a)! - saved.get(b)!)
  const rest = unique.filter((k) => !saved.has(k)).sort((a, b) => {
    if ((a === MANUAL_SOURCE) !== (b === MANUAL_SOURCE)) return a === MANUAL_SOURCE ? -1 : 1
    const ia = infos.get(a)
    const ib = infos.get(b)
    const seen = (ib?.firstSeenMs ?? 0) - (ia?.firstSeenMs ?? 0)
    if (seen !== 0) return seen
    const firstSample = (ib?.firstSampleMs ?? 0) - (ia?.firstSampleMs ?? 0)
    if (firstSample !== 0) return firstSample
    return a < b ? -1 : a > b ? 1 : 0
  })
  const ranks = new Map<string, number>()
  ;[...listed, ...rest].forEach((k, i) => ranks.set(k, i))
  return ranks
}
