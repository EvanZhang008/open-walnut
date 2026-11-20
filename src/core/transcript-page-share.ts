/**
 * One build per older page of a session's transcript, kept a short while after it ends.
 *
 * GET /api/v1/sessions/:id/transcript?before=… builds its page inside a 5 s deadline and,
 * past it, answers 503 "retry shortly" while the build goes on. Before this the build's
 * answer was thrown away and the retry built again. An older page of a whale JSONL on
 * another host reads up to four 4 MB windows over the tunnel; the windows it read are
 * kept (jsonl-window.ts), but only 32 MB of them, which a burst of pages evicts before
 * the retries come (2026-11-19 20:10Z: an agent reading 110 tasks' history, 8 at a time,
 * got 503 on the older page of 36 sessions on one dev host, each retry as slow as the first).
 *
 * Now a read of a page that is being built joins that build, and a finished page answers
 * reads of the same page for PAGE_KEEP_MS. Only a page whose rows are settled is shared
 * (pageIsSettled): one cut at a recent time is the turn still being written. A build that
 * failed is not kept, and the kept pages stay under PAGE_KEEP_MAX_CHARS together.
 */

/**
 * Longest deadline a `before` read may ask for with `wait=` (an agent's task_history). An
 * older page has no saved copy, and agents' pages of whale JSONLs on one host shared the
 * tunnel past the phone's 5 s (2026-11-19 and 11-20: 37 and 41 x 503 in one run each).
 */
export const PAGE_WAIT_MAX_MS = 25_000

/** The deadline a `before` read asked for: `wait` within [the default, PAGE_WAIT_MAX_MS]. */
export function pageDeadlineMs(rawWait: unknown, defaultMs: number): number {
  const wait = typeof rawWait === 'string' && /^\d+$/.test(rawWait) ? Number(rawWait) : NaN
  if (!Number.isFinite(wait) || wait <= defaultMs) return defaultMs
  return Math.min(wait, PAGE_WAIT_MAX_MS)
}

/** How long a finished page answers reads of the same page. */
export const PAGE_KEEP_MS = 30_000
/** Most pages kept at once (the oldest goes first). */
const PAGE_KEEP_MAX = 32
/** Most text all kept pages may hold together; a page larger than this is not kept. */
export const PAGE_KEEP_MAX_CHARS = 16 * 1024 * 1024
/** A page cut this long before now holds only rows already written. */
const SETTLED_MS = 60_000

interface Entry<T> {
  promise: Promise<T>
  /** When the build finished; undefined while it runs. */
  doneAt?: number
  /** The finished page's size (sizeOf). */
  chars: number
}

const pages = new Map<string, Entry<unknown>>()
let keptChars = 0

/** The key of one page: the session and every option that shapes the page. */
export function pageKey(sessionId: string, opts: Record<string, unknown>): string {
  const shape = Object.keys(opts).sort().map((k) => [k, opts[k]])
  return `${sessionId}\u0000${JSON.stringify(shape)}`
}

/** Whether a page cut at `before` holds only rows written a while ago (a recent cut is the live turn). */
export function pageIsSettled(before: string, now = Date.now()): boolean {
  const at = Date.parse(before)
  return Number.isFinite(at) && at < now - SETTLED_MS
}

function drop(key: string): void {
  const e = pages.get(key)
  if (!e) return
  keptChars -= e.chars
  pages.delete(key)
}

/** Forget finished pages past their time, then the oldest finished ones over the bounds. */
function trim(now: number): void {
  for (const [k, e] of pages) {
    if (e.doneAt !== undefined && now - e.doneAt >= PAGE_KEEP_MS) drop(k)
  }
  // Map order is insertion order; a running build is never dropped (its readers hold it).
  for (const [k, e] of pages) {
    if (pages.size <= PAGE_KEEP_MAX && keptChars <= PAGE_KEEP_MAX_CHARS) break
    if (e.doneAt !== undefined) drop(k)
  }
}

/**
 * `build`'s page for `key`: the running build of the same page when there is one, the
 * finished one while it is kept, else a new build. A rejected build is forgotten at once.
 * `sizeOf` measures a finished page for the shared text budget.
 */
export function sharedPageBuild<T>(
  key: string, build: () => Promise<T>, sizeOf: (page: T) => number = () => 0, now: () => number = Date.now,
): Promise<T> {
  trim(now())
  const held = pages.get(key) as Entry<T> | undefined
  if (held) return held.promise
  const entry: Entry<T> = { promise: Promise.resolve().then(build), chars: 0 }
  pages.set(key, entry)
  entry.promise.then(
    (page) => {
      if (pages.get(key) !== entry) return
      const chars = sizeOf(page)
      if (chars > PAGE_KEEP_MAX_CHARS) { pages.delete(key); return }
      entry.doneAt = now()
      entry.chars = chars
      keptChars += chars
      trim(now())
    },
    () => { if (pages.get(key) === entry) pages.delete(key) },
  )
  return entry.promise
}

/** Test seam: forget every page. */
export function _resetPageShareForTests(): void {
  pages.clear()
  keptChars = 0
}
