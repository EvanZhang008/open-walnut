/**
 * Folder-name recovery in WEBKIT, the engine the desktop app is.
 *
 * Same scenario as folder-registry-recovery.spec.ts. The retry lives in the
 * fetch layer (AbortSignal, timers, `fetch` rejection shapes), and that is
 * exactly where engines differ, so a Chromium pass alone does not cover the
 * Mac app. Opt in with `PW_WEBKIT=1 npx playwright test <spec> --project webkit`.
 */
import { expect, test } from '@playwright/test'
import {
  expectFolderNameRecovers, newLitter, seedFolder, sweepLitter, type Litter,
} from './folder-registry-recovery-helpers'

test.use({ browserName: 'webkit' })
test.setTimeout(120_000)

let litter: Litter = newLitter()
test.beforeEach(() => { litter = newLitter() })
test.afterEach(async () => { await sweepLitter(litter) })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('boot fetch and connect-time re-pull both lost: the folder is still named, no reload', async ({ page }) => {
  const seeded = await seedFolder(litter, 'webkit')
  await expectFolderNameRecovers(page, seeded, 1)
})
