/**
 * The one-card setting (threads_one_card, src/core/experimental.ts) for the specs that read its
 * cards: on in beforeAll, put back exactly as it was in afterAll. Config writes merge
 * (routes/config.ts), so only this flag moves, and only a `null` removes it: a flag that was never
 * set goes back to unset, not to `false`, so every_experiment counts it again (server-flags.ts).
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { readServerFlags } from './server-flags'

/** The flag as it was: its value, or 'unset' when it was never set. */
export type OneCardWas = boolean | 'unset'

/** Sets it; returns what it was, for `restoreOneCard`. */
export async function setOneCard(request: APIRequestContext, on: boolean): Promise<OneCardWas> {
  const flags = await readServerFlags(request)
  const was: OneCardWas = 'threads_one_card' in flags ? flags.threads_one_card : 'unset'
  const res = await request.put('/api/config', { data: { experimental: { threads_one_card: on } } })
  expect(res.ok(), await res.text()).toBe(true)
  return was
}

export async function restoreOneCard(request: APIRequestContext, was: OneCardWas | null): Promise<void> {
  if (was === null) return
  const res = await request.put('/api/config', { data: { experimental: { threads_one_card: was === 'unset' ? null : was } } })
  expect(res.ok(), await res.text()).toBe(true)
}
