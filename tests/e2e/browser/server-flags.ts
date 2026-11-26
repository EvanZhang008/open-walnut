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
 * The flags a spec moves on the server, over any number of writes, each put back after it exactly as
 * it was before the first write that moved it: its old value, or `null` (removed) when it was never set.
 * A "put back" of a map read before cannot do that: config writes merge, so a flag the spec added stays
 * on (2026-11-26: resize-observer-loop.webkit put back the map it read and left every_experiment and
 * chat_glass_edges on for every WebKit spec after it). Pass each call the request of the hook it runs in.
 */
export interface ServerFlags {
  set(request: APIRequestContext, flags: Record<string, boolean>): Promise<void>
  restore(request: APIRequestContext): Promise<void>
}

export function serverFlags(): ServerFlags {
  let was: Record<string, boolean | null> = {}
  return {
    async set(request, flags) {
      const now = await readServerFlags(request)
      for (const k of Object.keys(flags)) if (!(k in was)) was[k] = k in now ? now[k] : null
      const res = await request.put('/api/config', { data: { experimental: flags } })
      expect(res.ok(), await res.text()).toBe(true)
    },
    async restore(request) {
      if (Object.keys(was).length === 0) return
      const put = await request.put('/api/config', { data: { experimental: was } })
      expect(put.ok(), await put.text()).toBe(true)
      was = {}
    },
  }
}

/**
 * Sets `flags` on the server and returns the write that puts each of them back (serverFlags above).
 * The restore takes its own request: a beforeAll's `request` cannot be used again in afterAll.
 */
export async function setServerFlags(request: APIRequestContext, flags: Record<string, boolean>): Promise<RestoreServerFlags> {
  const ledger = serverFlags()
  await ledger.set(request, flags)
  return (later) => ledger.restore(later)
}
