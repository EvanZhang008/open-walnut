/**
 * The cron chaos matrix in WEBKIT.
 *
 * The Mac app is a WKWebView, so the pill and the card are read there more than
 * anywhere else: a clipped card, a pill that wraps out of the header row, or a
 * tab order the engine builds differently would only show up in that engine.
 * `test.use({ browserName })` is per file, so the engine split is two spec files
 * over one set of helpers. Scenario matrix and rationale:
 * session-cron-chaos-helpers.ts; the Chromium file is session-cron-chaos.spec.ts.
 *
 * Opt in with PW_WEBKIT=1 ... --project webkit (playwright.config.ts).
 */
import { expect, test } from '@playwright/test'
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

test.use({ browserName: 'webkit', viewport: { width: 1280, height: 850 }, deviceScaleFactor: 1 })
test.setTimeout(240_000)

test.beforeAll(ensureShots)
// A rewritten /api/sessions/status poll can still be in its route callback when
// the test ends; without this the run reports the closed-page error instead of
// the real result.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

for (const seed of SEEDS) {
  test(`40 seeded cron observations, oracle after every push (seed 0x${seed.toString(16)})`, async ({ page, baseURL }) => {
    await runSeededChaos(page, baseURL!, seed)
  })
}

test('an expanded prompt follows its job through a reorder, a removal and an addition', async ({ page, baseURL }) => {
  await runPromptPersistence(page, baseURL!)
})

test('32 jobs with full prompts keep the card, the header row and the composer intact', async ({ page, baseURL }) => {
  await runDensityLayout(page, baseURL!, 'density-32-webkit')
})

// WebKit is the engine the Mac app renders this card in, so the bounded card
// and its scrolling body are pinned here as well as in Chromium.
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
