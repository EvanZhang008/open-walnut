/**
 * One spec at a time drives the app-wide panel count (`ui.session_panels`) on a fixture server.
 *
 * The count is one config value the whole server shares, and `fullyParallel` runs other files
 * against the same server at once: a spec that set 3 and counted columns read 4, or its saved
 * count read 2, because another file's `setPanelMode` landed in between (2026-11-03, CI shard 11:
 * session-panel-lock-grant failed twice while session-panel-count ran on the next worker).
 * Serial within a file never covered that. Every spec that writes the count calls
 * `holdPanelCountLock()` once at its top level; tests/web/panel-count-lock-guard.test.ts fails on
 * one that writes it without. The lock itself is spec-lock.ts.
 *
 * The holder also leaves the count as it found it: the value read when the lock is taken is put
 * back when it is let go (2026-11-10: a taskbar test set 1 and "restored" Auto, which holds one
 * column at the fixture's window size, so a later file's second column was pushed out on CI).
 */
import { request, test } from '@playwright/test'
import { specLock } from './spec-lock'

const lock = specLock('panel-count')
const BASE = `http://localhost:${Number(process.env.PW_TEST_PORT ?? 3457)}`

async function withApi<T>(fn: (api: Awaited<ReturnType<typeof request.newContext>>) => Promise<T>): Promise<T> {
  const api = await request.newContext({ baseURL: BASE })
  try { return await fn(api) } finally { await api.dispose() }
}
// A fixture with no count set reads as the app's fallback, 2 (useSessionPanelMode.ts).
const readCount = () => withApi(async (api) => ((await (await api.get('/api/config')).json())?.config?.ui?.session_panels ?? '2') as unknown)

/** Hold the fixture's panel count for this file (serial) or for each test (any other file). */
export function holdPanelCountLock(scope: 'file' | 'test'): void {
  let saved: { value: unknown } | null = null
  const take = async () => {
    await lock.acquire()
    saved = { value: await readCount().catch(() => undefined) }
  }
  const give = async () => {
    try {
      const was = saved?.value
      if (was !== undefined && (await readCount().catch(() => was)) !== was) {
        await withApi((api) => api.put('/api/config', { data: { ui: { session_panels: was } } }))
      }
    } finally {
      saved = null
      lock.release()
    }
  }
  if (scope === 'file') { test.beforeAll(take); test.afterAll(give) }
  else { test.beforeEach(take); test.afterEach(give) }
}
