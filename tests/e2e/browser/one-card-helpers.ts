/**
 * The one-card setting (threads_one_card, src/core/experimental.ts) for the specs that read its
 * cards: on in beforeAll, put back as it was in afterAll. Config writes merge (routes/config.ts),
 * so only this flag moves.
 */
import { expect, type APIRequestContext } from '@playwright/test'

/** Sets it; returns what it was, for `restoreOneCard`. */
export async function setOneCard(request: APIRequestContext, on: boolean): Promise<boolean> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const was = cfg.config?.experimental?.threads_one_card === true
  const res = await request.put('/api/config', { data: { experimental: { threads_one_card: on } } })
  expect(res.ok(), await res.text()).toBe(true)
  return was
}

export async function restoreOneCard(request: APIRequestContext, was: boolean | null): Promise<void> {
  if (was !== null) await request.put('/api/config', { data: { experimental: { threads_one_card: was } } })
}
