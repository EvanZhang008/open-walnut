/**
 * Test browsers send a failed request once: the web client's quiet retry is off in them.
 *
 * The client tries a failed GET (and a write that asks for it) again after a short wait
 * (web/src/api/background-retry.ts). A spec that fails a request once on purpose (an error
 * and its Retry button, a cached copy shown while the read failed) would see the retry
 * heal it before the page reacts (2026-11-17: three specs went red on main). So every
 * context the runner makes starts with no retries, the same switch the vitest setup sets
 * (tests/setup/quiet-retry-off.ts); pw-silence.ts adds this script to every context of
 * every config. A spec about the retry itself turns it back on with `quietRetriesOn`, and
 * tests/e2e/browser/quiet-retry-on.spec.ts proves the served build still retries.
 */
import type { Page } from '@playwright/test'

/** The page-side key web/src/api/background-retry.ts reads at load. */
const KEY = 'open-walnut.quietRetryDelaysMs'

/** Sets no retry waits at document start, before the app's own scripts. */
export const QUIET_RETRY_OFF_JS = `(() => { const k = Symbol.for(${JSON.stringify(KEY)}); if (!(k in globalThis)) globalThis[k] = []; })();`

/** This page's client retries as a person's browser does (call before the first navigation). */
export async function quietRetriesOn(page: Page): Promise<void> {
  await page.addInitScript((key) => { globalThis[Symbol.for(key) as unknown as keyof typeof globalThis] = undefined as never }, KEY)
}
