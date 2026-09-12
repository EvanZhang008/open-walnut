/**
 * One browser, one routines store.
 *
 * The homepage routines panel and /routines are both live at once (MainPage never
 * unmounts). They used to hold private `useState` copies and `toggle` was a bare
 * API pass-through, so the enable/disable switch did not move until the
 * round-trip AND the `cron:job-*` broadcast came back, and every cron tick
 * fetched the whole list twice.
 *
 * The toggle POST is held at the network layer, so a switch that still waited on
 * the server — on either surface — would fail these assertions.
 */
import { expect, test } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const HOLD_MS = 3000
/** How long a same-frame update may take to reach the other surface. */
const INSTANT_MS = 700
/** MainPage reads this on mount to decide whether the routines panel is open.
 *  localStorage (a layout preference that survives a relaunch), which also means
 *  it is a ui-prefs-mirrored key: without `isolateUiPrefs` the seeded `true` would
 *  reach the shared fixture and open the routines panel in every other spec. */
const HOME_PANEL_KEY = 'open-walnut-home-routines-visible'

test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

async function createRoutineViaApi(name: string): Promise<{ id: string; name: string }> {
  const uniqueName = `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: uniqueName,
      schedule: { kind: 'every', everyMs: 3_600_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'store sync fixture' },
    }),
  })
  if (!res.ok) throw new Error(`POST routine failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { job: { id: string; name: string } }
  return body.job
}

test('toggling a routine on /routines flips both surfaces before the POST is answered', async ({ page }) => {
  const routine = await createRoutineViaApi('RoutineStoreSync')

  try {
    await page.addInitScript(([key]) => { localStorage.setItem(key, 'true') }, [HOME_PANEL_KEY])
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The compact view is the homepage panel; the plain one is the /routines page.
    const homeCard = page.locator('.routines-view-compact .cron-job-card', { hasText: routine.name })
    const pageCard = page.locator('.routines-view:not(.routines-view-compact) .cron-job-card', { hasText: routine.name })
    await expect(homeCard).toBeVisible()
    await expect(homeCard.locator('.cron-toggle-btn')).toContainText('On')

    await page.click('.sidebar a[href="/routines"]')
    await expect(page.locator('.page-title')).toContainText('Routines')
    await expect(pageCard).toBeVisible()
    await expect(pageCard.locator('.cron-toggle-btn')).toContainText('On')

    // Hold the toggle: the server does not see it until the hold ends, so no echo
    // can arrive before the assertions below.
    let togglesAnswered = 0
    await page.route('**/api/routines/*/toggle', async (route) => {
      await new Promise((r) => setTimeout(r, HOLD_MS))
      togglesAnswered++
      await route.continue()
    })

    await pageCard.locator('.cron-toggle-btn').click()
    await expect(pageCard.locator('.cron-toggle-btn')).toContainText('Off', { timeout: INSTANT_MS })
    await expect(pageCard).toHaveClass(/cron-job-disabled/, { timeout: INSTANT_MS })
    // The homepage panel is mounted but display:none under /routines — read the DOM.
    await expect.poll(
      () => homeCard.locator('.cron-toggle-btn').evaluate((el) => el.textContent ?? ''),
      { timeout: INSTANT_MS, intervals: [50, 50, 50, 50, 100, 100, 100] },
    ).toContain('Off')
    expect(togglesAnswered).toBe(0)

    // Let the held POST land: the server's answer must agree, not fight.
    await expect.poll(() => togglesAnswered, { timeout: HOLD_MS * 3 }).toBe(1)
    await page.waitForTimeout(1000)
    await expect(pageCard.locator('.cron-toggle-btn')).toContainText('Off')
    expect(await homeCard.locator('.cron-toggle-btn').evaluate((el) => el.textContent ?? '')).toContain('Off')

    const stored = await fetch(`${API}/api/routines/${routine.id}`)
    const body = (await stored.json()) as { job: { enabled: boolean } }
    expect(body.job.enabled).toBe(false)
  } finally {
    await fetch(`${API}/api/routines/${routine.id}`, { method: 'DELETE' }).catch(() => {})
  }
})

test('a refused toggle puts the switch back on both surfaces', async ({ page }) => {
  const routine = await createRoutineViaApi('RoutineStoreRollback')

  try {
    await page.addInitScript(([key]) => { localStorage.setItem(key, 'true') }, [HOME_PANEL_KEY])
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const homeCard = page.locator('.routines-view-compact .cron-job-card', { hasText: routine.name })
    const pageCard = page.locator('.routines-view:not(.routines-view-compact) .cron-job-card', { hasText: routine.name })
    await expect(homeCard).toBeVisible()

    await page.click('.sidebar a[href="/routines"]')
    await expect(pageCard).toBeVisible()

    await page.route('**/api/routines/*/toggle', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'engine busy' }) })
    })

    await pageCard.locator('.cron-toggle-btn').click()
    // Optimistic flip, then the refusal rolls it back on BOTH surfaces.
    await expect(pageCard.locator('.cron-toggle-btn')).toContainText('On', { timeout: 5000 })
    expect(await homeCard.locator('.cron-toggle-btn').evaluate((el) => el.textContent ?? '')).toContain('On')

    const stored = await fetch(`${API}/api/routines/${routine.id}`)
    const body = (await stored.json()) as { job: { enabled: boolean } }
    expect(body.job.enabled).toBe(true)
  } finally {
    await fetch(`${API}/api/routines/${routine.id}`, { method: 'DELETE' }).catch(() => {})
  }
})
