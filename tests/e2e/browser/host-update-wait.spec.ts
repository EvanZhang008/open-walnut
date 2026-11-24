/**
 * A connected host whose daemon update waits (src/providers/daemon-update-wait.ts) says what it
 * waits for and since when in its Settings Details, as a plain grey note: no failure block, no
 * warning, no button (a normal wait needs nothing from the person). Before, a postponed or skipped
 * update showed nowhere but the log.
 *
 * Against the SERVER's host fixture (POST /api/test/host-fixture): the frame is the real
 * buildHostStatus over the fixture's connect state. page.goto only loads the app.
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/host-update-wait.spec.ts --project chromium-host-fixture --retries=0
 */
import { test, expect } from '@playwright/test'
import { HEALTHY, fixtureFile, hostRow, isolatePrefs, loadApp, loadFixture, openHostDetails, openRemoteHosts, resetServerHostFixture, wireHost } from './host-problems-fixture-helpers'

const SHOTS = process.env.WALNUT_SHOTS_DIR ?? '/tmp/walnut-host-update-wait'
const WHY = 'waiting: service.handover: active ACP workers or relay requests must finish first'

test.beforeEach(async ({ page }) => { await isolatePrefs(page) })
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

test('a host whose daemon update waits says what for and since when, as a plain note in its Details', async ({ page, request }) => {
  await loadFixture(request, fixtureFile({
    buildbox: { label: 'Build box', hostname: 'buildbox.example.test', phase: 'connected', claude: HEALTHY, daemonUpdateWait: { kind: 'postponed', why: WHY, sinceMinutesAgo: 25 } },
    calmbox: { label: 'Calm box', hostname: 'calmbox.example.test', phase: 'connected', claude: HEALTHY },
    // Held three days by its setting: a wait over a day says the day too, not a time that reads as today's.
    heldbox: { label: 'Held box', hostname: 'heldbox.example.test', phase: 'connected', claude: HEALTHY, daemonUpdateWait: { kind: 'held', why: 'the host\'s setting says autofix: false', sinceMinutesAgo: 3 * 24 * 60 } },
  }))
  const wire = await wireHost(request, 'buildbox') as { warnings?: string[]; phase: string }
  expect(wire.phase).toBe('connected')
  expect(wire.warnings).toEqual([expect.stringMatching(/^The daemon update on Build box waits \(since (?:[A-Z][a-z]{2} \d{1,2}, )?\d\d:\d\d\): service\.handover: active ACP workers or relay requests must finish first$/)])
  const held = await wireHost(request, 'heldbox') as { warnings?: string[] }
  expect(held.warnings).toEqual([expect.stringMatching(/^Daemon updates on Held box are held by its setting \(since [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d\): the host's setting says autofix: false$/)])
  expect((await wireHost(request, 'calmbox') as { warnings?: string[] }).warnings ?? []).toEqual([])

  await page.setViewportSize({ width: 1280, height: 900 })
  await loadApp(page)
  await openRemoteHosts(page)
  const details = await openHostDetails(page, 'buildbox')
  const note = details.locator('.rh-readiness-note', { hasText: 'The daemon update on Build box waits' })
  await expect(note).toBeVisible()
  await expect(note).toHaveText(wire.warnings![0]!)
  // A normal wait: no failure block, no alert, no button beside it.
  await expect(details.locator('.rh-failure')).toHaveCount(0)
  await expect(note.locator('button')).toHaveCount(0)
  await expect(details.getByRole('alert')).toHaveCount(0)
  // Its row stays a connected host's row.
  await expect(hostRow(page, 'buildbox').locator('.rh-failure')).toHaveCount(0)
  await hostRow(page, 'buildbox').scrollIntoViewIfNeeded()
  const box = await hostRow(page, 'buildbox').boundingBox()
  const detailsBox = await details.boundingBox()
  if (box && detailsBox) {
    const y = Math.max(0, box.y - 8)
    await page.screenshot({ path: `${SHOTS}/host-update-wait.png`, clip: { x: 0, y, width: 1280, height: Math.min(900 - y, detailsBox.y + detailsBox.height - y + 16) } })
  }
  // The wait held for days names its day.
  const heldNote = (await openHostDetails(page, 'heldbox')).locator('.rh-readiness-note', { hasText: 'are held by its setting' })
  await expect(heldNote).toHaveText(held.warnings![0]!)
  await heldNote.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/host-update-wait-held.png` })
})
