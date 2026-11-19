/**
 * A phase set by hand moves the task's row to the section of its new status in the same frame,
 * before the server has answered (2026-11-19: the control changed at once, but every badge and
 * Home's status sections read `task.user_status`, a field only the SERVER derives
 * (src/core/user-status-sync.ts), so the row stayed where it was until the server's next pass).
 *
 * The page now predicts the derived status by the server's own rules
 * (web/src/hooks/status-prediction.ts, predictPhase in web/src/hooks/useTasks.ts). Proven by
 * holding the PATCH at the network layer: the server cannot have answered, and the row has moved.
 *
 * Scenario matrix (Home, Flat layout, the row's menu -> Status -> a status pill):
 *  1. Not started -> Needs you with the write held: the row is under Needs you, marked
 *     `needs-*`, inside INSTANT_MS with zero responses answered; after the release, in no frame
 *     of the next 2.5 s is it back under Not started.
 *  2. Not started -> Needs you, refused (500 after 1.2 s, and its retries): the row comes back
 *     under Not started, and the server still has it as it was.
 *  3. Not started -> In progress with the write held: Working is a running turn only, so the
 *     row stays under Not started in every frame, held and after the server's answer (the first
 *     prediction read it Working, and the row vanished from Home until the server answered).
 * The fixture is shared, so this file makes its own tasks and removes them.
 */
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSectionCard, type StatusSectionKey } from './status-section-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Phase instant ${STAMP}`
/** One frame is the claim; the budget covers a loaded test machine. */
const INSTANT_MS = 700
const HOLD_MS = 4_000
const ids = { held: '', refused: '', inProgress: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

type ServerStatus = { phase?: string; user_status?: { state?: string; kind?: string } }

async function serverTask(page: Page, id: string): Promise<ServerStatus> {
  return ((await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: ServerStatus }).task
}

/** Hold every PATCH of this task at the network layer; `release` lets them through. */
async function holdTaskWrites(page: Page, id: string): Promise<{ answered: () => number; sent: () => number; release: () => Promise<void> }> {
  let answered = 0
  let sent = 0
  let open = false
  const held: Route[] = []
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    sent += 1
    if (open) { await route.continue(); answered += 1; return }
    held.push(route)
  })
  return {
    answered: () => answered,
    sent: () => sent,
    release: async () => {
      open = true
      for (const r of held.splice(0)) { await r.continue(); answered += 1 }
    },
  }
}

/**
 * Record, every animation frame from now on, which section's rows hold the task's card. The
 * returned reader gives the places seen since (`status-section-<key>-rows`, or `not drawn`).
 */
async function watchSections(page: Page, id: string): Promise<() => Promise<string[]>> {
  const slot = `__phaseSeen_${id.replace(/\W/g, '_')}`
  await page.evaluate(([taskId, key]) => {
    const seen = new Set<string>()
    const w = window as unknown as Record<string, Set<string>>
    w[key] = seen
    const tick = () => {
      if (w[key] !== seen) return
      const card = document.querySelector(`.status-section-card[data-task-id="${taskId}"]`)
      const rows = card?.closest('[data-testid^="status-section-"][data-testid$="-rows"]')?.getAttribute('data-testid')
      // Not drawn at all counts too: a row predicted into a section the view does not draw vanished.
      seen.add(rows ?? (card ? 'outside a section' : 'not drawn'))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [id, slot] as const)
  return () => page.evaluate((key) => [...((window as unknown as Record<string, Set<string>>)[key] ?? [])], slot)
}

const rows = (key: StatusSectionKey) => `status-section-${key}-rows`

/** Home in the Flat layout on the Focus tab, the task's row drawn under Not started. */
async function openHome(page: Page, id: string): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await selectSection(page, 'Focus')
  const panel = page.locator('.todo-panel').first()
  await setStatusSectionOpen(panel, 'notstarted', true)
  if (await panel.getByTestId('status-section-needs').count()) await setStatusSectionOpen(panel, 'needs', true)
  await showSectionCard(panel, 'notstarted', id)
  await expect(statusSectionCard(panel, 'notstarted', id).locator('.task-phase-icon-btn')).toHaveAttribute('data-row-mark', 'not-started')
  return panel
}

/** The row's own menu -> Status -> the pill of `phase`, the way a user sets it. */
async function pickPhase(page: Page, card: Locator, phase: string): Promise<void> {
  await card.hover()
  await card.locator('.task-kebab-btn').click()
  await page.getByTestId('task-status-toggle').click()
  await page.locator(`.task-status-options [data-phase="${phase}"]`).click()
}

test.beforeAll(async ({ request }) => {
  for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
    const res = await request.post('/api/tasks', { data: { title: `Phase instant ${key} ${STAMP}`, project: PROJECT, source: 'local' } })
    expect(res.ok(), await res.text()).toBe(true)
    const id = ((await res.json()) as { task: { id: string } }).task.id
    ids[key] = id
    expect((await request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
    expect((await request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
  }
  // Each starts as the server derives a task nobody started.
  for (const id of Object.values(ids)) {
    await expect.poll(async () => {
      const task = ((await (await request.get(`/api/tasks/${id}`)).json()) as { task: ServerStatus }).task
      return `${task.user_status?.state}/${task.user_status?.kind}`
    }, { timeout: 30_000 }).toBe('waiting/not-started')
  }
})

test.afterAll(async ({ request }) => {
  for (const id of Object.values(ids)) {
    if (!id) continue
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

test('Needs you set by hand moves the row before the server has answered, and the answer keeps it there', async ({ page }) => {
  const id = ids.held
  const panel = await openHome(page, id)
  const hold = await holdTaskWrites(page, id)

  await pickPhase(page, statusSectionCard(panel, 'notstarted', id), 'NEED_ACTION')
  // The claim: the row has moved to its new status's section while the write is still held.
  const moved = statusSectionCard(panel, 'needs', id)
  await expect(moved).toBeVisible({ timeout: INSTANT_MS })
  await expect(moved.locator('.task-phase-icon-btn')).toHaveAttribute('data-row-mark', /^needs-/, { timeout: INSTANT_MS })
  expect(hold.answered(), 'the server answered before the row moved: the row may have followed the server').toBe(0)
  expect((await serverTask(page, id)).user_status?.state, 'the server has not seen the write').not.toBe('needs')
  await expect(statusSectionCard(panel, 'notstarted', id)).toHaveCount(0)
  await panel.screenshot({ path: `${SHOTS}/phase-status-held-${test.info().project.name}.png` }).catch(() => {})

  // From here on, every frame: the row must never be drawn back under Not started.
  const seen = await watchSections(page, id)
  await page.waitForTimeout(HOLD_MS - INSTANT_MS)
  expect(hold.sent(), 'the write was made').toBeGreaterThanOrEqual(1)
  expect(hold.answered()).toBe(0)
  await hold.release()
  await expect.poll(() => hold.answered(), { timeout: 15_000 }).toBe(hold.sent())
  await expect.poll(async () => (await serverTask(page, id)).user_status?.state, { timeout: 15_000 }).toBe('needs')
  // Every echo has had time to land (the write's event, the derived status, the list re-read).
  await page.waitForTimeout(2_500)
  await expect(moved.locator('.task-phase-icon-btn')).toHaveAttribute('data-row-mark', /^needs-/)
  expect(await seen(), 'the row was drawn outside Needs you after it moved').toEqual([rows('needs')])
})

test('a write the server refuses puts the row back under Not started', async ({ page }) => {
  const id = ids.refused
  const panel = await openHome(page, id)
  let refusals = 0
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    await new Promise((r) => setTimeout(r, 1_200))
    refusals += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'disk full' } }) })
  })

  await pickPhase(page, statusSectionCard(panel, 'notstarted', id), 'NEED_ACTION')
  await expect(statusSectionCard(panel, 'needs', id)).toBeVisible({ timeout: INSTANT_MS })
  expect(refusals).toBe(0)
  // Refused (after the page's own retries): the row is back where it was.
  const back = statusSectionCard(panel, 'notstarted', id)
  await expect(back).toBeVisible({ timeout: 15_000 })
  await expect(back.locator('.task-phase-icon-btn')).toHaveAttribute('data-row-mark', 'not-started')
  await expect(statusSectionCard(panel, 'needs', id)).toHaveCount(0)
  expect(refusals).toBeGreaterThanOrEqual(1)
  const server = await serverTask(page, id)
  expect(server.phase).toBe('TODO')
  expect(`${server.user_status?.state}/${server.user_status?.kind}`).toBe('waiting/not-started')
})

test('In progress set by hand on a task nobody started never draws it under Working', async ({ page }) => {
  const id = ids.inProgress
  const panel = await openHome(page, id)
  const seen = await watchSections(page, id)
  const hold = await holdTaskWrites(page, id)

  await pickPhase(page, statusSectionCard(panel, 'notstarted', id), 'IN_PROGRESS')
  // The write is out and held; the row has had its frame to move, and must not have.
  await expect.poll(() => hold.sent(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(INSTANT_MS)
  expect(hold.answered()).toBe(0)
  await expect(statusSectionCard(panel, 'notstarted', id)).toBeVisible()

  await hold.release()
  await expect.poll(() => hold.answered(), { timeout: 15_000 }).toBe(hold.sent())
  await expect.poll(async () => {
    const t = await serverTask(page, id)
    return `${t.phase}/${t.user_status?.state}/${t.user_status?.kind}`
  }, { timeout: 15_000 }).toBe('IN_PROGRESS/waiting/not-started')
  await page.waitForTimeout(2_500)
  await expect(statusSectionCard(panel, 'notstarted', id)).toBeVisible()
  expect(await seen(), 'the row was drawn outside Not started').toEqual([rows('notstarted')])
})
