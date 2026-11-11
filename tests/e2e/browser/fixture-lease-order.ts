/**
 * How a test that already holds fixture leases takes one more, without two tests waiting on each
 * other for good (fixture-lease.ts).
 *
 * A test takes its leases one at a time, as its resets run: a beforeEach takes some, the body more.
 * Two tests that each held the lease the other then asked for waited until one gave up after 600 s
 * (2026-11-10, CI: session-threads-landing held the dense session and asked for the failed one,
 * which session-threads-send held while it asked for the dense one). The rule that rules this out
 * is the usual one: never wait for a lease while holding one that sorts after it. So a key that
 * sorts after every lease held is waited for as before; one that sorts before a held lease is
 * taken at once if it is free, and else the later leases go back first, the key is waited for, and
 * the later ones are taken again in key order. Another test may have used them in between, so
 * each one's reset runs again (`again`), as when it was first taken: a test asks for its leases
 * before it uses the records they guard, as every reset at the start of a test does.
 *
 * Kept free of Playwright so a unit test can drive two holders at once
 * (tests/scripts/fixture-lease-order.test.ts).
 */

export interface HeldLease {
  key: string
  /** The write that was made under it: run again when the lease is taken back. */
  again: () => Promise<unknown>
}

export interface LeaseOps {
  /** Take the lease if it is free, at once. */
  tryTake: (key: string) => boolean
  /** Wait for the lease and take it. */
  take: (key: string) => Promise<void>
  /** Let the lease go. */
  release: (key: string) => void
}

/** Add `key` to `held`, waiting for it only while holding no lease that sorts after it. */
export async function takeInOrder(held: HeldLease[], key: string, again: () => Promise<unknown>, ops: LeaseOps): Promise<void> {
  const later = held.filter((one) => one.key > key).sort((a, b) => (a.key < b.key ? -1 : 1))
  if (later.length === 0) {
    await ops.take(key)
    held.push({ key, again })
    return
  }
  if (ops.tryTake(key)) {
    held.push({ key, again })
    return
  }
  for (const one of later) {
    ops.release(one.key)
    held.splice(held.indexOf(one), 1)
  }
  await ops.take(key)
  held.push({ key, again })
  for (const one of later) {
    await ops.take(one.key)
    held.push(one)
    await one.again()
  }
}
