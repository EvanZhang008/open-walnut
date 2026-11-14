/**
 * Put one config section back exactly as a spec wants it on the shared fixture
 * server. A config write merges a section one level deep and keeps the keys it
 * leaves out (src/core/config-section-write.ts), so a restore that sends the old
 * section whole would keep every key the spec added: each of those goes as null.
 */
import { expect, type APIRequestContext } from '@playwright/test'

/** `want` as a write body over `stored`: every stored key it does not name is removed. */
export function exactSection(stored: unknown, want: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) for (const k of Object.keys(stored)) out[k] = null
  return { ...out, ...(want ?? {}) }
}

/** PUT `{ [key]: want }` so the section ends up holding exactly `want` (nothing, when undefined). */
export async function putExactSection(request: APIRequestContext, key: string, want: Record<string, unknown> | undefined): Promise<void> {
  const read = await request.get('/api/config')
  expect(read.ok(), await read.text()).toBe(true)
  const body = await read.json() as { config?: Record<string, unknown> } & Record<string, unknown>
  const stored = (body.config ?? body)[key]
  const res = await request.put('/api/config', { data: { [key]: exactSection(stored, want) } })
  expect(res.ok(), await res.text()).toBe(true)
}
