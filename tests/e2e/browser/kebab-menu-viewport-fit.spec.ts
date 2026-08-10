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

// Every test here pays a full page load plus a session-panel open. That is
// ~12-25s when other specs run in parallel on this machine (fixture cold boot
// alone is ~20s idle and far worse under load, per CLAUDE.md), so the default
// 30s budget leaves no headroom and these fail on timeout rather than on a real
// defect. The assertions are geometric and fast; the boot is the cost.
test.describe.configure({ timeout: 90_000 })

/**
 * The fixture dataset is shared across concurrently running specs, and
 * task-multi-select-batch.spec.ts completes/reopens tasks in it. A COMPLETE task
 * renders a SHORTER kebab (no attention row, no pin/tier block) and drops the
 * "Session idle" entry, so this spec must assert its own precondition instead of
 * inheriting whatever the last spec left behind.
 *
 * ⚠️ This writes to shared fixture data, so the hazard runs both ways. It is safe
 * only because IN_PROGRESS is `pw-task-vscode`'s seeded state and no other spec
 * asserts a different phase for THIS id (the batch spec seeds its own tasks). A
 * spec that starts depending on this task being complete would break; give it a
 * private task id rather than changing what this restores.
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
  // The kebab's session row is targeted POSITIONALLY (first item), not by label: its
  // text is derived from live state ("Session idle" / "AI is working…" / "Session
  // error" / "Unread — open to mark read"), so a label matcher flakes as soon as the
  // fixture session's state drifts.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/**
 * Assert the menu is the TOP element along its own box — i.e. actually visible,
 * not merely correctly sized underneath something else.
 *
 * Geometry alone can't catch this: the menu measured perfectly while the session
 * composer drew over its lower half. `position: fixed` escapes clipping ancestors
 * but NOT stacking contexts, and the menu's home was inside
 * .session-panel-header (z-index: 30) while the composer is .session-panel-input
 * (z-index: 40) — so its own z-index: 9999 only ordered it within the header.
 * Fixed by portalling to <body>; this hit-tests that it stayed fixed.
 */
async function assertMenuOnTop(page: Page, menu: Locator, label: string) {
  const covered = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect()
    // Sample down the menu's vertical centre line. The bug only showed at the
    // bottom, where the composer overlapped.
    const bad: { y: number; by: string }[] = []
    for (const frac of [0.1, 0.35, 0.6, 0.85, 0.97]) {
      const y = r.top + r.height * frac
      const top = document.elementFromPoint(r.left + r.width / 2, y)
      if (top && !el.contains(top) && top !== el) {
        bad.push({ y: Math.round(y), by: (top.className || top.tagName).toString().slice(0, 60) })
      }
    }
    return bad
  })
  expect(covered, `${label}: menu is covered by ${covered.map(c => `${c.by}@y=${c.y}`).join(', ')}`).toEqual([])
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
  // Sized right AND actually on top — the composer used to draw over its lower half.
  await assertMenuOnTop(page, menu, 'short window')

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
    await assertMenuOnTop(page, menu, `height=${height}`)

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

test('the kebab containing an inline calendar still fits the viewport', async ({ page, request }) => {
  // The inline DatePicker is what makes the kebab tall enough to overflow in the
  // first place (~200px of calendar), so assert it is actually present — a
  // shorter menu would let the viewport check pass for the wrong reason.
  //
  // DatePicker's POPOVER mode (`.dp-popover`, rendered in task detail panes) had
  // the same defect shape and is now placed by the same hook, but this fixture's
  // home panel renders only the inline mode, so there is no honest way to reach
  // the popover here. Its CSS/placement contract is covered by the unit tests
  // instead; a browser test for it needs a fixture that opens a detail pane.
  await ensureTaskInProgress(request)
  await page.setViewportSize({ width: 1280, height: 620 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'More actions' }).click()
  const kebab = page.locator('.task-kebab-menu:visible')
  await expect(kebab).toBeVisible()
  // Two inline calendars since start_date landed (2c4d557f): Start + Due.
  await expect(kebab.locator('.dp-content')).toHaveCount(2)
  const m = await assertFitsViewport(page, kebab, 'kebab with inline date picker')
  expect(m.overflowY).toBe('auto')
})

test('a menu whose trigger disappears closes instead of stranding off-screen', async ({ page, request }) => {
  // A trigger removed or display:none'd while its menu is open reports an
  // all-zero rect. Treating that as a position parked the menu at the top-left
  // corner — measured `right: 1280px` on a 1280px viewport, i.e. fully
  // off-screen left — and no scroll could recover it, because the components'
  // "did the trigger scroll away?" test is `r.bottom < 0 || r.top > innerHeight`,
  // which is false for all zeros. The hook now reports the anchor as lost.
  await ensureTaskInProgress(request)
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()

  // Hide the row the trigger lives in — what the live search filter does.
  await page.evaluate((taskId) => {
    const el = document.querySelector<HTMLElement>(`.todo-panel-item[data-task-id="${taskId}"]`)
    if (el) el.style.display = 'none'
  }, TASK_ID)

  await expect(menu).toHaveCount(0)
})
