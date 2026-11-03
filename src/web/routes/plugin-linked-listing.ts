/**
 * The last linked-checkout listing, kept in memory per server (stale-while-revalidate).
 *
 * The listing runs several git calls per linked dev checkout (1.3 to 2 s measured with four
 * links), and both the Apps registry (`GET /api/plugin-runtime/registry`) and the update
 * status batch (`GET /api/plugin-updates`) used to run it on EVERY request. Now:
 *
 *   - A request with a listing in hand answers with it at once; when it is older than
 *     `ttlMs`, one scan starts in the background for the next request.
 *   - A request with no listing yet waits at most `graceMs` for the first scan, then answers
 *     without (`null`), which the registry renders as `linkedScanSkipped` rows ("not
 *     scanned"), the same answer it gave when the scan ran out of budget.
 *   - A finished scan whose result differs from what was served calls `onChange`, so an
 *     open Apps page refetches (`plugin:linked-changed`, see `LINKED_CHANGED_EVENT`).
 *   - `invalidate()` (a linked check/update, a discover or reload) keeps the listing but
 *     marks it stale and rescans; `refresh()` waits for a scan that started after the
 *     latest invalidation.
 *
 * Never more than one scan at a time, and no scan ever rejects: a failed one keeps the
 * previous listing (or an empty one, which is how a failed scan always read).
 */
import { bus } from '../../core/event-bus.js'
import type { LinkedCheckoutInfo, LinkedCheckoutListing } from '../../core/plugins/linked-checkout.js'
import { withDeadline } from '../../core/plugins/update-status.js'
import { createSubsystemLogger } from '../../logging/index.js'
import type { LinkedCheckoutOps } from './plugin-linked-ops.js'

const log = createSubsystemLogger('plugin-linked')

/** How old a listing may be before a request starts a background rescan. */
export const LINKED_LISTING_TTL_MS = 30_000
/** How long a request with no listing at all waits for the first scan. */
export const LINKED_LISTING_COLD_GRACE_MS = 100
/**
 * Web-only signal that the linked listing changed. Deliberately not `plugin:runtime-changed`:
 * that one also makes the plugin-jobs manager re-send every daemon its job set, every window
 * re-read the plugin catalogue and skill list, and every connection panel reload, none of
 * which a new sha or a dirty flip in a dev checkout calls for.
 */
export const LINKED_CHANGED_EVENT = 'plugin:linked-changed'

export interface LinkedListingCache {
  /** The cached listing (stale ones trigger a background rescan), or null on a cold cache past `graceMs`. */
  read(opts?: { graceMs?: number }): Promise<LinkedCheckoutListing | null>
  /** A listing from a scan that started after the latest `invalidate()`. */
  refresh(): Promise<LinkedCheckoutListing>
  /** The listing may be wrong now: keep serving it, rescan in the background. */
  invalidate(): void
}

export interface LinkedListingCacheOptions {
  ttlMs?: number
  now?: () => number
  /** Called when a finished scan differs from what requests were served. Default: emit LINKED_CHANGED_EVENT. */
  onChange?: () => void
}

function listingKey(listing: LinkedCheckoutListing): string {
  const found = [...listing.found.entries()]
    .map(([id, info]: [string, LinkedCheckoutInfo]) => [id, info.checkout, info.branch, info.sha, info.dirty, info.remote ?? '', info.path])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return JSON.stringify({ found, skipped: [...listing.skipped].sort() })
}

export function createLinkedListingCache(ops: LinkedCheckoutOps, opts: LinkedListingCacheOptions = {}): LinkedListingCache {
  const ttlMs = opts.ttlMs ?? LINKED_LISTING_TTL_MS
  const now = opts.now ?? Date.now
  const onChange = opts.onChange ?? (() => {
    bus.emit(LINKED_CHANGED_EVENT, {}, ['web-ui'], { source: 'plugin-linked' })
  })

  /** `invalidated`: something changed the tree since this scan started; rescan, keep serving it. */
  type Cached = { listing: LinkedCheckoutListing; key: string; at: number; invalidated: boolean }
  let value: Cached | null = null
  /** Bumped by every invalidate; a scan remembers the generation it started in. */
  let generation = 0
  let inflight: { promise: Promise<LinkedCheckoutListing>; generation: number } | null = null
  /** A request was answered without the listing, so the first result is news even if empty. */
  let servedMiss = false

  const listDetailed = async (): Promise<LinkedCheckoutListing> =>
    ops.listDetailed ? ops.listDetailed() : { found: await ops.list(), skipped: [] }

  const startScan = (): { promise: Promise<LinkedCheckoutListing>; generation: number } => {
    if (inflight) return inflight
    const started = generation
    const startedAt = now()
    const promise = (async () => {
      let listing: LinkedCheckoutListing
      try {
        listing = await listDetailed()
      } catch (error) {
        log.warn('linked listing failed', { error: error instanceof Error ? error.message : String(error) })
        listing = value?.listing ?? { found: new Map(), skipped: [] }
      }
      const key = listingKey(listing)
      const changed = value ? value.key !== key : servedMiss
      // An invalidate that landed while this scan ran leaves the result stale at once.
      value = { listing, key, at: now(), invalidated: started !== generation }
      servedMiss = false
      log.debug('linked listing scanned', { ms: now() - startedAt, found: listing.found.size, skipped: listing.skipped.length, changed })
      if (changed) {
        try { onChange() } catch { /* a listener's failure is not the scan's */ }
      }
      return listing
    })().finally(() => {
      if (inflight?.promise === promise) inflight = null
      // Invalidated mid-scan: the next listing must describe the tree after the change.
      if (value?.invalidated && !inflight) void startScan()
    })
    inflight = { promise, generation: started }
    return inflight
  }

  return {
    async read({ graceMs = 0 } = {}) {
      if (value) {
        if (value.invalidated || now() - value.at >= ttlMs) void startScan()
        return value.listing
      }
      const { promise } = startScan()
      const MISS = Symbol('miss')
      const result = graceMs > 0 ? await withDeadline<LinkedCheckoutListing | typeof MISS>(promise, graceMs, () => MISS) : MISS
      if (result !== MISS) return result
      // The scan may have finished between the deadline and here: then it is no miss, and
      // nobody would be told about one (its change was judged with no miss recorded).
      // (Read again: TS keeps the narrowing from before the await.)
      const late = value as Cached | null
      if (late) return late.listing
      servedMiss = true
      return null
    },
    async refresh() {
      const wanted = generation
      for (;;) {
        const scan = startScan()
        const listing = await scan.promise
        if (scan.generation >= wanted) return listing
      }
    },
    invalidate() {
      generation += 1
      if (value) value.invalidated = true
      void startScan()
    },
  }
}
