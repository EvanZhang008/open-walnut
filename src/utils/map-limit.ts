/**
 * Bounded-concurrency map that preserves input order in the result.
 *
 * For work that pays one daemon round trip per item: awaited one after another, N items cost N
 * round trips (a ~200-skill host took 12-22 s per /api/slash-commands call; 38 running sessions
 * on a busy host link held GET /hosts/load past 10 s, 2026-11-23). Run a few at once instead; the
 * bound keeps one link from carrying hundreds of requests at once.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
