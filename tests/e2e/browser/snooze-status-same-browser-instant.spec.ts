/**
 * A snooze cleared by hand wakes the task's row in the same frame, before the server has answered
 * (2026-11-19: clearing a snooze changed the start date at once, but the row kept reading Snoozed
 * under Waiting until the server's pass derived `user_status` again, a field only the
 * server writes).
 *
 * The store now predicts the woken status by the server's own rule (predictedForStart in
 * web/src/hooks/status-prediction.ts, laid on by `update` in web/src/hooks/useTasks.ts). Proven by
 * holding the PATCH at the network layer: the server cannot have answered, and the row has moved.
 *
 * Scenario matrix (Home, Flat layout, a handed-back task snoozed for three days, the row's menu ->
 * Snooze until -> Clear date):
 *  1. Cleared with the write held: the row is under Needs you inside INSTANT_MS with zero
 *     responses answered; after the release, in no frame of the next 2.5 s is it back under
 *     Waiting, and the server reads Needs you.
 *  2. Cleared, refused (500 after 1.2 s, and its retries): the row is back under Waiting,
 *     and the server still has the snooze.
 * The fixture is shared, so this file makes its own tasks and removes them.
 */
import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSectionCard, type StatusSectionKey } from './status-section-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Snooze instant ${STAMP}`
const INSTANT_MS = 700
const HOLD_MS = 4_000
const ids = { held: '', refused: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
// A time, not a bare day: the page and the server read a time the same way (snoozedAhead).
const LATER = new Date(Date.now() + 3 * 86_400_000).toISOString()

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

type ServerStatus = { phase?: string; start_date?: string; user_status?: { state?: string; snoozed?: unknown } }

async function serverTask(request: APIRequestContext, id: string): Promise<ServerStatus> {
  return ((await (await request.get(`/api/tasks/${id}`)).json()) as { task: ServerStatus }).task
}
const stateOf = (t: ServerStatus) => `${t.user_status?.state}${t.user_status?.snoozed ? '+snoozed' : ''}`

/** Record, every animation frame from now on, which section's rows hold the task's card. */
async function watchSections(page: Page, id: string): Promise<() => Promise<string[]>> {
  const slot = `__snoozeSeen_${id.replace(/\W/g, '_')}`
  await page.evaluate(([taskId, key]) => {
    const seen = new Set<string>()
    const w = window as unknown as Record<string, Set<string>>
    w[key] = seen
    const tick = () => {
      if (w[key] !== seen) return
      const card = document.querySelector(`.status-section-card[data-task-id="${taskId}"]`)
      const rows = card?.closest('[data-testid^="status-section-"][data-testid$="-rows"]')?.getAttribute('data-testid')
      seen.add(rows ?? (card ? 'outside a section' : 'not drawn'))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [id, slot] as const)
  return () => page.evaluate((key) => [...((window as unknown as Record<string, Set<string>>)[key] ?? [])], slot)
}

const rows = (key: StatusSectionKey) => `status-section-${key}-rows`

async function openHome(page: Page, id: string): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await selectSection(page, 'Focus')
  const panel = page.locator('.todo-panel').first()
  await setStatusSectionOpen(panel, 'waiting', true)
  if (await panel.getByTestId('status-section-needs').count()) await setStatusSectionOpen(panel, 'needs', true)
  await showSectionCard(panel, 'waiting', id)
  return panel
}

/** The row's own menu -> Snooze until -> Clear date, the way a user wakes it. */
async function clearSnooze(page: Page, card: Locator): Promise<void> {
  await card.hover()
  await card.locator('.task-kebab-btn').click()
  const row = page.locator('.task-kebab-menu').getByTestId('task-snooze-row')
  const toggle = row.locator('.task-kebab-date-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await row.getByRole('button', { name: 'Clear date' }).click()
}

test.beforeAll(async ({ request }) => {
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    const res = await request.post('/api/tasks', { data: { title: `Snooze instant ${key} ${STAMP}`, project: PROJECT, source: 'local' } })
    expect(res.ok(), await res.text()).toBe(true)
    const id = ((await res.json()) as { task: { id: string } }).task.id
    ids[key] = id
    expect((await request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
    expect((await request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
    // Handed back to the user, then snoozed for three days.
    expect((await request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
    expect((await request.patch(`/api/tasks/${id}`, { data: { start_date: LATER } })).ok()).toBe(true)
  }
  for (const id of Object.values(ids)) {
    await expect.poll(async () => stateOf(await serverTask(request, id)), { timeout: 30_000 }).toBe('waiting+snoozed')
  }
})

test.afterAll(async ({ request }) => {
  for (const id of Object.values(ids)) {
    if (!id) continue
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

test('a snooze cleared wakes the row before the server has answered, and the answer keeps it there', async ({ page }) => {
  const id = ids.held
  const panel = await openHome(page, id)
  let sent = 0
  let answered = 0
  let open = false
  const held: Route[] = []
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    sent += 1
    if (open) { await route.continue(); answered += 1; return }
    held.push(route)
  })

  await clearSnooze(page, statusSectionCard(panel, 'waiting', id))
  const woke = statusSectionCard(panel, 'needs', id)
  await expect(woke).toBeVisible({ timeout: INSTANT_MS })
  expect(answered, 'the server answered before the row moved').toBe(0)
  expect(stateOf(await serverTask(page.request, id)), 'the server has not seen the write').toBe('waiting+snoozed')
  await expect(statusSectionCard(panel, 'waiting', id)).toHaveCount(0)
  await panel.screenshot({ path: `${SHOTS}/snooze-cleared-held-${test.info().project.name}.png` }).catch(() => {})

  const seen = await watchSections(page, id)
  await page.waitForTimeout(HOLD_MS - INSTANT_MS)
  expect(sent, 'the write was made').toBeGreaterThanOrEqual(1)
  expect(answered).toBe(0)
  open = true
  for (const r of held.splice(0)) { await r.continue(); answered += 1 }
  await expect.poll(async () => stateOf(await serverTask(page.request, id)), { timeout: 15_000 }).toBe('needs')
  await page.waitForTimeout(2_500)
  await expect(woke).toBeVisible()
  expect(await seen(), 'the row was drawn outside Needs you after it woke').toEqual([rows('needs')])
})

test('a refused unsnooze puts the row back under Waiting', async ({ page }) => {
  const id = ids.refused
  const panel = await openHome(page, id)
  let refusals = 0
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    await new Promise((r) => setTimeout(r, 1_200))
    refusals += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'disk full' } }) })
  })
  await clearSnooze(page, statusSectionCard(panel, 'waiting', id))
  await expect(statusSectionCard(panel, 'needs', id)).toBeVisible({ timeout: INSTANT_MS })
  expect(refusals).toBe(0)
  await expect(statusSectionCard(panel, 'waiting', id)).toBeVisible({ timeout: 15_000 })
  await expect(statusSectionCard(panel, 'needs', id)).toHaveCount(0)
  expect(refusals).toBeGreaterThanOrEqual(1)
  const server = await serverTask(page.request, id)
  expect(server.start_date).toBe(LATER)
  expect(stateOf(server)).toBe('waiting+snoozed')
})
