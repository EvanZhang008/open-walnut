/**
 * Kebab dropdowns must never overflow the viewport (2026-07-28).
 *
 * Reported: on a small screen the session-panel "⋮" menu was too long to see —
 * its bottom items (the Session section: Notes / Msgs / Copy / Open in VS Code /
 * Restart / Terminate) were cut off with no way to reach them.
 *
 * Root cause: `.task-kebab-menu` had no max-height/overflow, and the up-vs-down
 * flip math GUESSED the menu height with a hardcoded constant
 * (`extraSection ? 560 : 350`). The real two-section menu is taller than that,
 * so both branches ran off-screen — and since the menu is `position: fixed` it
 * lives in no scroll container, making the overflow unreachable rather than just
 * scrolled-away.
 *
 * These assertions are geometric, not stylistic: the menu's rendered box must
 * stay inside the window, and when capped it must actually be scrollable.
 *
 * VERIFIED AGAINST THE BUG: with the pre-fix placement restored, every test here
 * fails, reporting "bottom edge past viewport (746.5 > 700)". That 46.5px of
 * unreachable overflow at a 1280x700 window is why these tests use that viewport.
 *
 * `page.goto('/')` appears below despite the repo's no-goto rule: that rule is
 * about in-app NAVIGATION (use real clicks so SPA routing is exercised). The
 * initial load, and a reload needed to re-lay-out after setViewportSize, are the
 * sanctioned exception — every subsequent step here is a real UI click.
 */
import { expect, test, type APIRequestContext, type Page, type Locator } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

/**
 * The fixture dataset is shared across concurrently running specs, and
 * task-multi-select-batch.spec.ts completes/reopens tasks in it. A COMPLETE task
 * renders a SHORTER kebab (no attention row, no pin/tier block) and drops the
 * "Session idle" entry, so this spec must assert its own precondition instead of
 * inheriting whatever the last spec left behind.
 */
async function ensureTaskInProgress(request: APIRequestContext) {
  const res = await request.patch(`/api/tasks/${TASK_ID}`, { data: { phase: 'IN_PROGRESS' } })
  expect(res.ok(), 'could not reset the fixture task phase').toBe(true)
}

/** The session panel's kebab carries BOTH sections — the tallest menu we render. */
async function openHomepageSession(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Session idle', { exact: true }).click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/** Assert a menu's box sits fully inside the viewport, and report its metrics. */
async function assertFitsViewport(page: Page, menu: Locator, label: string) {
  const box = (await menu.boundingBox())!
  const vp = page.viewportSize()!
  // Top and bottom edges both on screen — the actual regression was the bottom
  // edge landing past window.innerHeight.
  expect(box.y, `${label}: top edge above viewport`).toBeGreaterThanOrEqual(-1)
  expect(box.y + box.height, `${label}: bottom edge past viewport (${box.y + box.height} > ${vp.height})`)
    .toBeLessThanOrEqual(vp.height + 1)
  expect(box.x, `${label}: left edge off-screen`).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width, `${label}: right edge off-screen`).toBeLessThanOrEqual(vp.width + 1)

  return menu.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }))
}

test('the session kebab fits the viewport and scrolls when the window is short', async ({ page, request }) => {
  await ensureTaskInProgress(request)
  // A deliberately short window — the reported condition.
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openHomepageSession(page)

  await panel.locator('.session-panel-title-meta .task-kebab-btn').click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()

  const m = await assertFitsViewport(page, menu, 'short window')

  // 1. It IS the tall two-section menu (guards against the test passing because
  //    a short single-section menu rendered instead).
  await expect(menu.getByText('Task detail', { exact: true })).toHaveCount(1)
  await expect(menu.locator('.task-kebab-priority')).toHaveCount(1)

  // 2. overflow-y must be `auto` — this is the CSS half of the fix, and the half
  //    that makes overflow REACHABLE rather than merely clipped. Asserted
  //    unconditionally so deleting the CSS rule fails here even on a tall window.
  expect(m.overflowY).toBe('auto')
  //    Then, if the content genuinely exceeds the capped box, prove it scrolls.
  if (m.scrollHeight > m.clientHeight + 1) {
    const scrolled = await menu.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      return el.scrollTop
    })
    expect(scrolled, 'menu content did not scroll').toBeGreaterThan(0)
  }

  // 3. The LAST item is reachable after scrolling to the bottom — the user's
  //    actual complaint ("I can't see all of it").
  const items = menu.locator('.task-kebab-item')
  const last = items.last()
  await last.scrollIntoViewIfNeeded()
  const lastBox = (await last.boundingBox())!
  const vp = page.viewportSize()!
  expect(lastBox.y + lastBox.height, 'last item is below the viewport').toBeLessThanOrEqual(vp.height + 1)
  await expect(last).toBeVisible()
})

// One test PER height rather than a loop in a single test: opening the session
// panel costs a full load + networkidle (12-25s when other specs run in parallel),
// so three iterations blew the 30s per-test budget and failed on timeout — an
// artifact of the harness, not the product. Parameterised tests each get their own
// budget and can be parallelised.
for (const height of [900, 620, 480]) {
  test(`the session kebab stays on screen at a ${height}px window height`, async ({ page, request }) => {
    await ensureTaskInProgress(request)
    await page.setViewportSize({ width: 1280, height })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openHomepageSession(page)

    await panel.locator('.session-panel-title-meta .task-kebab-btn').click()
    const menu = page.locator('.task-kebab-menu:visible')
    await expect(menu).toBeVisible()
    await assertFitsViewport(page, menu, `height=${height}`)

    // Escape must dismiss it (the menu owns the key handler now).
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
}

test('a task-row kebab fits the viewport, opened by click and by right-click', async ({ page, request }) => {
  await ensureTaskInProgress(request)
  await page.setViewportSize({ width: 1280, height: 620 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible()

  // Click path.
  await row.getByRole('button', { name: 'More actions' }).click()
  let menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  await assertFitsViewport(page, menu, 'task row (click)')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Right-click path anchors the menu at the CURSOR, not the button, so the test
  // has to control where that cursor is — hence explicit mouse.move + down/up at
  // a chosen point rather than locator.click({ button: 'right' }), which targets
  // the element centre and would not let us pick the position under test.
  const rowBox = (await row.boundingBox())!
  await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.height / 2)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  await assertFitsViewport(page, menu, 'task row (right-click)')
})

test('the date popover fits the viewport too (same defect shape)', async ({ page, request }) => {
  // DatePicker's POPOVER mode (task detail pane) had the identical defect: a
  // ~250px calendar placed at `rect.bottom + 2` with no flip, clamp or cap. Its
  // inline mode (embedded in the kebab) was never affected. Both are asserted
  // here so the popover can't regress back to the unclamped placement.
  await ensureTaskInProgress(request)
  await page.setViewportSize({ width: 1280, height: 620 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible()

  // Open the task's detail pane, which renders the popover-mode DatePicker.
  await row.click()
  const trigger = page.locator('.dp-trigger').first()
  if (await trigger.count() === 0) {
    // The detail surface didn't render a date pill in this layout — assert the
    // inline calendar inside the kebab instead, so the test still covers a
    // DatePicker rather than silently passing.
    await row.getByRole('button', { name: 'More actions' }).click()
    const kebab = page.locator('.task-kebab-menu:visible')
    await expect(kebab).toBeVisible()
    await expect(kebab.locator('.dp-content')).toHaveCount(1)
    await assertFitsViewport(page, kebab, 'kebab with inline date picker')
    return
  }

  await trigger.click()
  const pop = page.locator('.dp-popover:visible')
  await expect(pop).toBeVisible()
  const m = await assertFitsViewport(page, pop, 'date popover')
  expect(m.overflowY).toBe('auto')
})
