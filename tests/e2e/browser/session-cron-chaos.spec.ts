/**
 * Seeded chaos over the CRON pill and the cron job card (Chromium).
 *
 * Scenario matrix, rationale and every helper: session-cron-chaos-helpers.ts.
 * The WebKit twin (session-cron-chaos.webkit.spec.ts) runs the same bodies,
 * because the desktop app is a WKWebView and `test.use({ browserName })` is
 * per file.
 */
import { test } from '@playwright/test'
import {
  SEEDS,
  ensureShots,
  runDensityLayout,
  runDensityReach,
  runKeyboardPath,
  runPromptPersistence,
  runRapidBurst,
  runSeededChaos,
  runSurfaceConsistency,
} from './session-cron-chaos-helpers'

test.use({ viewport: { width: 1280, height: 850 }, deviceScaleFactor: 1 })
// 40 pushes with a full DOM oracle after each, twice, plus a 32-job card.
test.setTimeout(240_000)

test.beforeAll(ensureShots)
// Every scenario rewrites /api/sessions/status on top of the real body, and a
// poll can still be in that callback when the test ends: without this the run
// reports "route.fetch: Target page ... has been closed" INSTEAD of the real
// result (session-cron-supervision.spec.ts does the same).
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

for (const seed of SEEDS) {
  test(`40 seeded cron observations, oracle after every push (seed 0x${seed.toString(16)})`, async ({ page, baseURL }) => {
    await runSeededChaos(page, baseURL!, seed)
  })
}

test('an expanded prompt follows its job through a reorder, a removal and an addition', async ({ page, baseURL }) => {
  await runPromptPersistence(page, baseURL!)
})

test('32 jobs with full prompts keep the card, the header row and the composer intact', async ({ page, baseURL }) => {
  await runDensityLayout(page, baseURL!, 'density-32')
})

// A full card used to take its whole content height inside the overflow-hidden
// panel body, so rows past the first few were clipped with nothing to scroll.
// The card is now bounded and its body scrolls; this keeps it that way.
test('every job in a full cron card can be reached', async ({ page, baseURL }) => {
  await runDensityReach(page, baseURL!)
})

test('the pill opens and closes the card from the keyboard alone', async ({ page, baseURL }) => {
  await runKeyboardPath(page, baseURL!)
})

test('a 30-frame burst settles on the last frame and stays there', async ({ page, baseURL }) => {
  await runRapidBurst(page, baseURL!)
})

test('the task row pill and the header pill flip together on every presence change', async ({ page, baseURL }) => {
  await runSurfaceConsistency(page, baseURL!)
})
