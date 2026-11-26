/**
 * Experimental flags set on the shared test server, and put back exactly as they were.
 *
 * GET /api/config answers `{ config: { experimental } }`, and a PUT of `experimental` merges flag by
 * flag (src/core/config-section-write.ts): a flag is removed only when sent as `null`. A spec that
 * read the flags off the top level of the answer got `{}`, and "put back" `{}`, which changed
 * nothing: threads-turn-end-still left every_experiment on for every spec after it on the fixture
 * (2026-11-26, CI 45784774186: quiet_rail took Routines off the rail, and the trigger-pause and
 * trigger-time-limit specs waited on its rail link until their test timeout).
 *
 * A flag that only chooses what the page draws belongs on the page instead (page-flags.ts).
 */
import { expect, type APIRequestContext } from '@playwright/test'

/** The server's experimental flags as stored (a flag never set is absent). */
export async function readServerFlags(request: APIRequestContext): Promise<Record<string, boolean>> {
  const res = await request.get('/api/config')
  expect(res.ok(), await res.text()).toBe(true)
  return { ...((await res.json()) as { config?: { experimental?: Record<string, boolean> } }).config?.experimental }
}

/** Puts back the flags a setServerFlags call moved; pass the request of the hook it runs in. */
export type RestoreServerFlags = (request: APIRequestContext) => Promise<void>

/**
 * Sets `flags` on the server and returns the write that puts each of them back: its value before,
 * or `null` (removed) for one that was never set, so every_experiment counts it again as before.
 * The restore takes its own request: a beforeAll's `request` cannot be used again in afterAll.
 */
export async function setServerFlags(request: APIRequestContext, flags: Record<string, boolean>): Promise<RestoreServerFlags> {
  const before = await readServerFlags(request)
  const res = await request.put('/api/config', { data: { experimental: flags } })
  expect(res.ok(), await res.text()).toBe(true)
  const restore = Object.fromEntries(Object.keys(flags).map((k) => [k, k in before ? before[k] : null]))
  return async (later) => {
    const put = await later.put('/api/config', { data: { experimental: restore } })
    expect(put.ok(), await put.text()).toBe(true)
  }
}
