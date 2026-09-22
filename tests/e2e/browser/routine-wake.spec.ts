/**
 * `wake` in the real UI (acceptance 10): the counter is VISIBLE on the card and
 * in the edit form, it is read-only, and saving the form with nothing changed
 * must not erase it.
 *
 * That last one is the whole reason this spec exists. The form sends
 * {name, schedule, executor, check?} and never mentions `wake`, so the guarantee
 * is the server merging a patch by key presence. A future form change that
 * started sending `wake: undefined` (or a normalizer that stopped distinguishing
 * absent from null) would silently drop a counter nobody can see in the form —
 * the routine would then only ever run on its clock, and the user would have no
 * way to tell from the UI. Chromium only: nothing here is engine-specific.
 */
import { test, expect } from './shortcut-test-fixture'

const API = 'http://localhost:3457'
const ITEMS_EVENT = 'plugin:walnuttest:items-received'

async function createWakeRoutine(name: string): Promise<string> {
  const res = await fetch(`${API}/api/routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      schedule: { kind: 'every', everyMs: 1_800_000 },
      wakeMode: 'next-cycle',
      executor: { type: 'main-agent', config: { instructions: 'Triage the inbox.' } },
      wake: { events: [ITEMS_EVENT], countField: 'count', threshold: 20 },
    }),
  })
  // ONE read of the body: a `await res.text()` inside the expect message runs eagerly, and the
  // json() after it then fails with "Body is unusable" whether the assertion passed or not.
  const body = await res.text()
  expect(res.status, body).toBe(201)
  const { job } = JSON.parse(body) as { job: { id: string; wake?: unknown } }
  expect(job.wake).toBeTruthy()
  return job.id
}

async function fetchRoutine(id: string): Promise<any> {
  const res = await fetch(`${API}/api/routines/${id}`)
  const { job } = (await res.json()) as { job: any }
  return job
}

async function openRoutines(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const link = page.getByTestId('sidebar-core-app-routines')
  await expect(link).toBeVisible()
  await link.click()
  await expect(page.locator('.page-title')).toContainText('Routines')
}

test('the card shows the counter, the form shows it read-only, and an unchanged save keeps it', async ({ page }) => {
  const name = `PW wake ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const id = await createWakeRoutine(name)
  try {
    await openRoutines(page)

    // The clock is not the whole trigger, and the card says so.
    const card = page.locator('.routine-list .routine-card', { hasText: name }).first()
    await expect(card).toBeVisible()
    await expect(card.locator('.cron-job-desc')).toContainText('Every 30 min')
    await expect(card.locator('.cron-job-desc')).toContainText('or after 20 new items')

    // Edit → the counter is a line of text, not a control.
    await card.locator('.cron-menu-btn').click()
    await card.getByRole('button', { name: 'Edit' }).click()
    const form = page.locator('.routine-modal')
    await expect(form).toBeVisible()
    const wakeLine = form.getByTestId('routine-wake-line')
    await expect(wakeLine).toHaveText('Also runs after 20 new items')
    expect(await wakeLine.locator('input, select, textarea').count()).toBe(0)

    // Save with nothing changed.
    const saved = page.waitForResponse((r) => r.url().includes(`/api/routines/${id}`) && r.request().method() === 'PATCH')
    await form.getByRole('button', { name: 'Save' }).click()
    const res = await saved
    expect(res.status(), await res.text()).toBe(200)
    await expect(form).toBeHidden()

    // The counter survived the round trip, unchanged.
    const after = await fetchRoutine(id)
    expect(after.wake).toEqual({ events: [ITEMS_EVENT], countField: 'count', threshold: 20 })
    await expect(card.locator('.cron-job-desc')).toContainText('or after 20 new items')
  } finally {
    await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
  }
})
