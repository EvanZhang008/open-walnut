/**
 * One browser, one session-settings store: pressing the composer's permission-mode
 * pill moves the pill AND every other surface showing that session before the
 * server has answered.
 *
 * Regression guarded (2026-09-03): the pill's optimistic update was DEAD CODE.
 * SessionPanel patched its private record copy (`setSession({ ...session, mode })`)
 * while it rendered `useResolvedSessionRecord`, which overwrites `mode` from the
 * session-status store on every read — so nothing moved until the PATCH returned,
 * and that PATCH also reaches the live CLI. The task detail rows, which read the
 * store, learned only from the WS echo. Both now read ONE shared overlay.
 *
 * The PATCH is held for HOLD_MS at the network layer: the server does not even
 * see the request until the hold ends, so nothing asserted below could have
 * arrived via the round-trip or its echo.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

// Both tests drive the same fixture session's mode; serial keeps the second from
// starting on a mode the first left behind mid-flight.
test.describe.configure({ mode: 'serial' })

const SESSION_ID = 'pw-store-sync-session'
const TASK_ID = 'pw-task-store-sync'
/** Long enough to open the task detail modal (two clicks) inside the hold. */
const HOLD_MS = 8000
/** How long a same-frame update may take to reach a surface. Far below HOLD_MS. */
const INSTANT_MS = 700

async function openHomepageSession(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  // First kebab item = the session row (its label is live state, so positional).
  // It is INERT until the row's task payload carries a session slot — the row can
  // render from a slim list payload first — and an inert click leaves the menu
  // open, so retry instead of assuming the first one lands.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await page.waitForTimeout(800)
    // Click the row's title: the task menu has no open-session row.
    await row.locator('.todo-item-title').click()
    try {
      await panel.waitFor({ state: 'visible', timeout: 2500 })
      return { panel, row }
    } catch { /* fall through and retry */ }
    if (await menu.count() > 0) await page.keyboard.press('Escape')
  }
  throw new Error(`session column for ${SESSION_ID} never opened from the task row kebab`)
}

/** The permission-mode pill, not the reply-style one beside it: only the
 *  permission pill carries the ⇧Tab shortcut hint. */
function modePill(panel: Locator): Locator {
  return panel.locator('.session-mode-bar .mode-toggle-pill:has(.mode-toggle-pill-shortcut)').first()
}

async function openTaskDetail(page: Page, row: Locator): Promise<Locator> {
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  return modal
}

async function closeTaskDetail(page: Page): Promise<void> {
  // Escape, not the close button: under machine load the fixture raises API
  // toasts that sit over the modal's chrome and swallow a real click.
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
}

function detailSessionRow(modal: Locator): Locator {
  return modal.locator(`.todo-detail-session-item[title="${SESSION_ID}"]`)
}

/**
 * Put the chat lane composer on the SAME session the column shows.
 *
 * The lane surface is a real product state (Ask Walnut Provider = Claude Code),
 * and a lane session genuinely doubles as a column: promote-to-task links it to
 * a task and the task's circle opens that sessionId. The fixture has no lane
 * conversation bound to a known session, so the binding is stubbed at the
 * network layer — the config flag that turns the lane on, and the resolve that
 * hands MainPage its lane sessionId. Everything under test (both composers, the
 * store, the PATCH) is the real code.
 */
async function pinLaneToFixtureSession(page: Page): Promise<void> {
  // Path predicate, not a glob: `**/api/config**` also matches the Vite dev
  // server's own /src/api/config.ts module URL and breaks the app's boot.
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    const res = await route.fetch()
    const body = await res.json() as { config?: Record<string, unknown> }
    const config = body.config ?? {}
    const agent = { ...(config.agent as Record<string, unknown> ?? {}), provider: 'claude-code' }
    await route.fulfill({ json: { ...body, config: { ...config, agent } } })
  })
  await page.route((url) => url.pathname.endsWith('/lane-session'), async (route) => {
    await route.fulfill({
      json: { sessionId: SESSION_ID, cwd: '/tmp', engine: 'claude', created: false },
    })
  })
}

test('the mode pill flips itself and the task detail rows before the PATCH is answered', async ({ page, request }) => {
  // Deterministic start: the pill cycles Plan → Auto → Bypass, so the assertions
  // below only hold from a known mode (and a re-run must not inherit the last).
  const reset = await request.patch(`/api/sessions/${SESSION_ID}`, { data: { mode: 'bypass' } })
  expect(reset.ok()).toBe(true)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const { panel, row } = await openHomepageSession(page)

  const pill = modePill(panel)
  await expect(pill).toHaveText(/Bypass/)

  // Baseline on the other surface: no Plan badge on the session row.
  const baselineModal = await openTaskDetail(page, row)
  await expect(detailSessionRow(baselineModal)).toBeVisible()
  await expect(detailSessionRow(baselineModal).locator('.todo-detail-plan-badge')).toHaveCount(0)
  await closeTaskDetail(page)

  // Hold the mode PATCH at the network layer. The server never sees it until the
  // hold ends, so no response and no WS echo can explain what moves below.
  let patchesAnswered = 0
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    patchesAnswered++
    await route.continue()
  })

  // 1. The pill itself flips in the same frame (before the fix: frozen on Bypass
  //    for the whole round-trip).
  await pill.click()
  await expect(pill).toHaveText(/Plan/, { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(0)

  // 2. The task detail session rows read the SAME store, with the request still
  //    held: the Plan badge is there and the mode suffix is gone.
  const heldModal = await openTaskDetail(page, row)
  const heldRow = detailSessionRow(heldModal)
  await expect(heldRow.locator('.todo-detail-plan-badge')).toHaveCount(1, { timeout: INSTANT_MS })
  await expect(heldRow.locator('.todo-detail-ws-pill')).not.toHaveText(/Bypass/, { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(0)

  // 3. Let the held PATCH land. The server's own snapshot must confirm the pick,
  //    not undo it — the overlay retires and the value stays put.
  await expect.poll(() => patchesAnswered, { timeout: HOLD_MS * 3 }).toBe(1)
  await page.waitForTimeout(1000)
  await expect(heldRow.locator('.todo-detail-plan-badge')).toHaveCount(1)
  await closeTaskDetail(page)
  await expect(pill).toHaveText(/Plan/)

  const server = await request.get(`/api/sessions/${SESSION_ID}`)
  const body = await server.json() as { session: { mode: string } }
  expect(body.session.mode).toBe('plan')

  // Leave the shared fixture where the other specs expect it.
  await request.patch(`/api/sessions/${SESSION_ID}`, { data: { mode: 'bypass' } })
})

test('the chat lane composer and the session column move together, both ways', async ({ page, request }) => {
  const reset = await request.patch(`/api/sessions/${SESSION_ID}`, { data: { mode: 'bypass' } })
  expect(reset.ok()).toBe(true)

  await pinLaneToFixtureSession(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const lanePill = modePill(page.locator('.main-page-chat'))
  // The lane composer needs config → conversations → lane resolve → record fetch
  // before it can render a pill; only the sub-second assertions below are tight.
  await expect(lanePill).toHaveText(/Bypass/, { timeout: 15_000 })

  const { panel } = await openHomepageSession(page)
  const panelPill = modePill(panel)
  await expect(panelPill).toHaveText(/Bypass/)

  let patchesAnswered = 0
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    patchesAnswered++
    await route.continue()
  })

  // Lane composer → session column. Before the shared store this direction had
  // no delivery path at all: LaneComposerControls patched a private record and
  // registered no listener, so the column stayed on Bypass indefinitely.
  await lanePill.click()
  await expect(lanePill).toHaveText(/Plan/, { timeout: INSTANT_MS })
  await expect(panelPill).toHaveText(/Plan/, { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(0)

  // Session column → lane composer (the cycle is Plan → Auto → Bypass).
  await panelPill.click()
  await expect(panelPill).toHaveText(/Auto/, { timeout: INSTANT_MS })
  await expect(lanePill).toHaveText(/Auto/, { timeout: INSTANT_MS })
  expect(patchesAnswered).toBe(0)

  // Both held PATCHes land in order; the last one is what the server keeps, and
  // both surfaces settle on it together.
  await expect.poll(() => patchesAnswered, { timeout: HOLD_MS * 3 }).toBe(2)
  await expect(panelPill).toHaveText(/Auto/, { timeout: 5000 })
  await expect(lanePill).toHaveText(/Auto/, { timeout: 5000 })

  const server = await request.get(`/api/sessions/${SESSION_ID}`)
  const body = await server.json() as { session: { mode: string } }
  expect(body.session.mode).toBe('auto')

  await request.patch(`/api/sessions/${SESSION_ID}`, { data: { mode: 'bypass' } })
})
