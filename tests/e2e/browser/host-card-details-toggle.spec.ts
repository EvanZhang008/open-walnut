/**
 * A host card's details: ONE toggle, one state.
 *
 * A failure whose raw text is not SSH output (DETAILS_NOT_SSH_KINDS: the
 * daemon did not come up, the cloud companion refusing) used to show two
 * toggles in an open banner row, the row's own fold toggle and the failure
 * text's inner one, reading "Show details" and "Hide details" at the same time.
 * Now the raw text opens with the row. An SSH failure keeps its inner "Show SSH
 * output" (a different thing, often long) beside the row's "Hide details".
 *
 * Statuses are routed the way the server shapes them (host-problems-helpers.ts);
 * the headline, hint and toggle words are the real shared model's.
 * page.goto only loads the app; everything after is a real click.
 *
 * Run: PW_TEST_PORT=35993 ./node_modules/.bin/playwright test host-card-details-toggle --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35993 ./node_modules/.bin/playwright test host-card-details-toggle --project=webkit --workers=1
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Locator } from '@playwright/test'
import { banner, failed, resetServerHostFixture, row, setup, type HS } from './host-problems-helpers'

const SHOTS = process.env.HOST_CARD_SHOTS ?? path.join(os.tmpdir(), 'walnut-host-card-shots')
test.describe.configure({ timeout: 120_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

const CASES: Array<{ name: string; status: HS; headline: string }> = [
  {
    name: 'daemon',
    status: failed('devbox', 'Dev box', 'daemon', {
      error: 'daemon did not start on devbox: exited with code 1 before writing its port file',
      hint: 'SSH works but the session daemon did not come up. Retry; if it keeps failing, check daemon-start.log in the daemon directory on the host.',
      retryable: true,
    }),
    headline: 'did not start',
  },
  {
    name: 'cloud-exec-off',
    status: failed('__cloudbox__', 'Cloud', 'cloud_exec_off', {
      hostname: 'companion.example.com',
      error: 'Cloud companion has session hosting turned off (cloud.exec.enabled is off there)',
      hint: 'The cloud companion at companion.example.com is not set up to run sessions. Set `cloud.exec.enabled: true` in its config.yaml and restart it, then Retry.',
      retryable: false,
    }),
    headline: 'Cloud companion has session hosting turned off',
  },
  {
    name: 'cloud-update',
    status: failed('__cloudbox__', 'Cloud', 'cloud_update', {
      hostname: 'companion.example.com',
      error: 'Cloud companion needs an update: its build predates the session tunnel',
      hint: "The cloud companion at companion.example.com runs an older Walnut build that cannot host this Mac's sessions. Deploy the current build there; Cloud connects on its own once it answers.",
      retryable: false,
    }),
    headline: 'Cloud companion needs an update',
  },
]

/** The details toggles a user can see in a row right now. */
const toggles = (r: Locator): Locator => r.locator('button.hft-details:visible')

/**
 * The card's host list is its one scroll region (banner-scroll.ts), so an open
 * row's tail can sit below the list's fold. Scroll it there as a user would, and
 * prove the toggle is really on screen: toBeInViewport counts the clip of every
 * scrolling ancestor, which :visible does not.
 */
async function showToggle(r: Locator): Promise<void> {
  await toggles(r).scrollIntoViewIfNeeded()
  await expect(toggles(r)).toBeInViewport()
}

for (const c of CASES) {
  test(`${c.name}: one details toggle, open and closed, and the raw text opens with the row`, async ({ page, browserName }) => {
    await setup(page, [c.status])
    const r = row(page, c.status.host)
    await expect(r).toBeVisible({ timeout: 30_000 })
    await expect(r).toContainText(c.headline)
    await expect(r).toHaveAttribute('data-kind', c.status.kind!)

    // Open it (the first row may already be open).
    if (await toggles(r).first().innerText() === 'Show details') await toggles(r).first().click()
    await expect(toggles(r)).toHaveCount(1)
    await expect(toggles(r)).toHaveText('Hide details')
    await expect(r.locator('pre.hft-summary')).toHaveText(c.status.error!)
    await expect(r).not.toContainText('Show SSH output')
    await showToggle(r)
    await expect(r.locator('pre.hft-summary')).toBeInViewport()
    await banner(page).screenshot({ path: path.join(SHOTS, `host-card-${c.name}-open-${browserName}.png`) })

    // Closed: still one toggle, and the details are gone with it.
    await toggles(r).click()
    await expect(toggles(r)).toHaveCount(1)
    await expect(toggles(r)).toHaveText('Show details')
    await expect(r.locator('pre.hft-summary')).toHaveCount(0)
    await showToggle(r)
    await banner(page).screenshot({ path: path.join(SHOTS, `host-card-${c.name}-closed-${browserName}.png`) })
  })
}

test('an SSH failure keeps its SSH output behind its own toggle (unchanged)', async ({ page }) => {
  const s = failed('netbox', 'Net box', 'unreachable')
  await setup(page, [s])
  const r = row(page, 'netbox')
  await expect(r).toBeVisible({ timeout: 30_000 })
  if (await toggles(r).first().innerText() === 'Show details') await toggles(r).first().click()
  await expect(toggles(r)).toHaveText(['Show SSH output', 'Hide details'])
  await expect(r.locator('pre.hft-summary')).toHaveCount(0)
  await r.getByRole('button', { name: 'Show SSH output' }).click()
  await expect(r.locator('pre.hft-summary')).toHaveText(s.error!)
})
