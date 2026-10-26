/**
 * Voice lives in Settings (2026-10-26, the user: "the voice can be part of
 * setting"): the sidebar has no Voice button and no Voice history slide-out;
 * Settings > Voice opens on its recent recordings, then Dictation and Read aloud.
 *  - a recording from today shows its time, an older one its day too;
 *  - a row with words copies them (no chat box on the Settings page);
 *  - a failed take re-transcribes from its stored audio, and the new words
 *    replace the failure once the list reloads;
 *  (Dictation itself is untouched; the mics are pinned by voice-mic-everywhere.spec.ts.)
 * The recordings and the redo are answered here, so nothing is transcribed.
 * Run both engines: PW_WEBKIT=1 ... --project webkit for the Mac app.
 */
import { test, expect, type Page } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

const today = new Date()
today.setHours(9, 5, 0, 0)
const older = new Date(Date.UTC(2026, 0, 14, 17, 30))

function recordings(redone: boolean) {
  return {
    recordings: [
      { id: 'rec-new', timestamp: today.toISOString(), result: { text: 'Spoken words from this morning' } },
      redone
        ? { id: 'rec-failed', timestamp: today.toISOString(), result: { text: 'Words recovered from the stored audio' } }
        : { id: 'rec-failed', timestamp: today.toISOString(), error: 'The engine timed out' },
      { id: 'rec-old', timestamp: older.toISOString(), result: { text: 'A take from January' } },
    ],
  }
}

async function routeRecordings(page: Page) {
  let redone = false
  const redo: string[] = []
  await page.route('**/api/stt/recordings?**', (route) => route.fulfill({ json: recordings(redone) }))
  await page.route('**/api/stt/recordings/*/transcribe', (route) => {
    redo.push(new URL(route.request().url()).pathname)
    redone = true
    return route.fulfill({ json: { text: 'Words recovered from the stored audio' } })
  })
  return redo
}

test('the sidebar has no Voice entry; Settings > Voice shows the recordings', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const redo = await routeRecordings(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await expect(page.locator('.sidebar-notification-btn')).toBeVisible({ timeout: 60_000 })

  // No rail button, no slide-out.
  await expect(page.getByRole('button', { name: 'Voice history' })).toHaveCount(0)
  await expect(page.locator('.voice-panel')).toHaveCount(0)

  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-stt')
  await nav.scrollIntoViewIfNeeded()
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')

  const group = page.getByTestId('stt-recordings')
  await expect(group).toBeVisible({ timeout: 20_000 })
  await expect(group).toContainText('Recent recordings')
  // The recordings come first, Dictation after them.
  const groupBox = await group.boundingBox()
  const dictationBox = await page.getByTestId('stt-dictation').boundingBox()
  expect(groupBox!.y).toBeLessThan(dictationBox!.y)

  const rows = group.locator('.voice-panel-item')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Spoken words from this morning')
  await expect(rows.nth(0).locator('.voice-panel-time')).not.toContainText(',')
  await expect(rows.nth(2).locator('.voice-panel-time')).toContainText('Jan')
  await expect(rows.nth(1)).toContainText('The engine timed out')
  await expect(rows.nth(1).locator('.voice-panel-badge')).toHaveText('failed')

  // A row with words: no chat box on this page, so its words are copied.
  await rows.nth(0).click()
  await expect(rows.nth(0).locator('.voice-panel-flash')).toHaveText(/Copied/)
  if (browserName === 'chromium') {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Spoken words from this morning')
  }

  // A failed take is re-transcribed from its stored audio.
  await rows.nth(1).click()
  await expect.poll(() => redo).toEqual(['/api/stt/recordings/rec-failed/transcribe'])
  await expect(rows.nth(1)).toContainText('Words recovered from the stored audio', { timeout: 15_000 })
  await expect(rows.nth(1).locator('.voice-panel-badge')).toHaveCount(0)

  await page.locator('.settings-pane').screenshot({ path: `test-results/voice-in-settings-${browserName}.png` })
  expect(errors).toEqual([])
})
