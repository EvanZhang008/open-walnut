/**
 * Home's taskbar (2026-11-06, the user: "like a taskbar in computer"): Minimize takes a
 * column off the strip and leaves it as a chip along the bottom of Home; a click on the
 * chip brings it back; × on a chip or on a column closes it to the background (the
 * session keeps running); the chips survive a reload. A chip's card shows the
 * session's last reply and a composer.
 */
import { test, expect, type Page } from '@playwright/test'
import { iconInkOffsets, ICON_CENTER_TOLERANCE_PX } from './icon-ink'
import { setPanelMode } from './draft-helpers'
import { holdPanelCountLock } from './panel-count-lock'

// One test sets the fixture's panel count (a full strip pushes a column out).
holdPanelCountLock('test')

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

async function openSessionPanel(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/** A beat a person can follow, only while recording (PW_VIDEO, walnut-dev webkit --video). */
const beat = (page: Page) => (process.env.PW_VIDEO ? page.waitForTimeout(1200) : Promise.resolve())

const chip = (page: Page) => page.locator(`.session-taskbar-chip[data-session-id="${SESSION_ID}"]`)

test('every icon of the header\'s window buttons draws on the row\'s middle, Minimize included', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const controls = panel.locator('.session-panel-window-controls')
  await expect(controls.locator('[data-header-id="minimize"]')).toBeVisible()
  const inks = await iconInkOffsets(controls.locator('button'))
  expect(inks.map((i) => i.id)).toEqual(expect.arrayContaining(['minimize', 'watch']))
  for (const ink of inks) {
    expect(Math.abs(ink.dy), `${ink.id} icon is ${ink.dy.toFixed(2)}px off its button's middle`).toBeLessThan(ICON_CENTER_TOLERANCE_PX)
  }
})

test('Minimize puts the column on the taskbar; its chip brings it back', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await beat(page)
  await panel.getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(panel).toHaveCount(0)
  await expect(chip(page)).toBeVisible()
  await expect(chip(page)).toContainText('Editor fixture task')
  await beat(page)

  await chip(page).locator('.session-taskbar-open').click()
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toBeVisible()
  await expect(chip(page)).toHaveCount(0)
  await expect(page.getByTestId('session-taskbar')).toHaveCount(0)
})

test('× on a column never makes a chip: the session goes to Recent at the right end, which opens it again', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await beat(page)
  await panel.getByRole('button', { name: 'Close session panel' }).click()
  await expect(panel).toHaveCount(0)
  await expect(chip(page)).toHaveCount(0)
  await beat(page)
  const recent = page.getByTestId('session-taskbar-recent')
  const pill = recent.locator(`.session-taskbar-recent-pill[data-session-id="${SESSION_ID}"]`)
  await expect(pill).toBeVisible()
  await expect(pill).toContainText('Editor fixture task')
  // Recent sits at the bar's right end, past every chip.
  const bar = await page.getByTestId('session-taskbar').boundingBox()
  const box = await recent.boundingBox()
  expect(bar!.x + bar!.width - (box!.x + box!.width)).toBeLessThan(16)

  await pill.locator('.session-taskbar-open').click()
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toBeVisible()
  await expect(pill).toHaveCount(0)
  await beat(page)

  // × on a Recent pill only takes it off the list.
  await page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`).getByRole('button', { name: 'Close session panel' }).click()
  await expect(pill).toBeVisible()
  await pill.getByRole('button', { name: /Remove .* from Recent/ }).click()
  await expect(page.getByTestId('session-taskbar')).toHaveCount(0)
})

test('a column pushed out by a full strip never makes a chip: it goes to Recent', async ({ page }) => {
  test.setTimeout(120_000)
  await setPanelMode(page, '1')
  try {
    await openSessionPanel(page)
    await beat(page)
    // Opening another task's session on a one-panel strip pushes this column out.
    await page.locator('.todo-search-input').fill('')
    const other = page.locator('.todo-panel-item[data-task-id="pw-task-001"]')
    await page.locator('.todo-search-input').fill('pw-task-001')
    await expect(other).toBeVisible()
    await other.locator('.todo-item-title').click()
    await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toHaveCount(0)
    await expect(page.locator('.main-page-session-column .session-panel')).toHaveCount(1)
    await expect(chip(page)).toHaveCount(0)
    await expect(page.locator(`.session-taskbar-recent-pill[data-session-id="${SESSION_ID}"]`)).toBeVisible()
    await beat(page)
    await page.locator(`.session-taskbar-recent-pill[data-session-id="${SESSION_ID}"]`).getByRole('button', { name: /Remove .* from Recent/ }).click()
  } finally {
    await setPanelMode(page, 'Auto')
  }
})

test('Minimize on the Org side panel puts the session on Home\'s chips', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // In-app navigation, the way a click on a task on the Org page opens its panel.
  await page.evaluate((sid) => { history.pushState({}, '', `/org?open=session:${sid}`); dispatchEvent(new PopStateEvent('popstate')) }, SESSION_ID)
  const side = page.locator(`[data-testid="org-side"][data-session-id="${SESSION_ID}"]`)
  await expect(side).toBeVisible({ timeout: 20_000 })
  await beat(page)
  await side.getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(side).toHaveCount(0)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(chip(page)).toBeVisible()
  await beat(page)
  await chip(page).getByRole('button', { name: /Close .* to the background/ }).click()
})

test('a taskbar an older Walnut saved (pushed-out sessions mixed in) opens with no chips, its sessions under Recent', async ({ page }) => {
  await page.addInitScript((id) => {
    if (sessionStorage.getItem('pw-legacy-seeded')) return
    sessionStorage.setItem('pw-legacy-seeded', '1')
    localStorage.setItem('open-walnut-layout:home-taskbar', JSON.stringify({ v: 1, value: [id] }))
    localStorage.removeItem('open-walnut-layout:home-minimized')
  }, SESSION_ID)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator(`.session-taskbar-recent-pill[data-session-id="${SESSION_ID}"]`)).toBeVisible()
  await expect(chip(page)).toHaveCount(0)
  await beat(page)
  // Read once: a reload keeps it under Recent, never back on the chips.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator(`.session-taskbar-recent-pill[data-session-id="${SESSION_ID}"]`)).toBeVisible()
  await expect(chip(page)).toHaveCount(0)
  await page.getByRole('button', { name: /Remove .* from Recent/ }).click()
})

test('Watch on a task the board does not hold (an archived one) brings it onto the Watching list', async ({ page }) => {
  const ARCHIVED = 'mpwold01-aa11'
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (body.session) body.session.taskId = ARCHIVED
    else body.taskId = ARCHIVED
    await route.fulfill({ response, json: body })
  })
  await page.addInitScript((id) => {
    localStorage.setItem('open-walnut-layout:home-columns', JSON.stringify({ v: 1, value: [{ id, locked: false }] }))
  }, SESSION_ID)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  const watch = panel.getByTestId('session-panel-watch')
  await expect(watch).toBeEnabled({ timeout: 30_000 })
  const watching = page.getByRole('region', { name: 'Watching' })
  await expect(watching.getByText('Archived migration plan')).toHaveCount(0)
  await watch.click()
  await expect(watch).toHaveAttribute('aria-pressed', 'true')
  await expect(watching.getByText('Archived migration plan', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await watch.click()
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
  await expect(watching.getByText('Archived migration plan')).toHaveCount(0)
})

test('Watch in the header row keeps the task on the Watching list, and lights while on', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const watch = panel.getByTestId('session-panel-watch')
  await expect(watch).toBeEnabled()
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
  await beat(page)
  await watch.click()
  await expect(watch).toHaveAttribute('aria-pressed', 'true')
  await expect(watch).toHaveAccessibleName('Stop watching')
  await beat(page)
  await watch.click()
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
})

test('× on a chip closes it to the background', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await panel.getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(chip(page)).toBeVisible()
  await chip(page).getByRole('button', { name: /Close .* to the background/ }).click()
  await expect(chip(page)).toHaveCount(0)
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toHaveCount(0)
})

test('the chips survive a reload, and a chip opens a card with the last reply', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await panel.getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(chip(page)).toBeVisible()
  // Home writes the strip into the URL on a 300 ms debounce; a reload before it would
  // bring the column back from the URL.
  await expect.poll(() => page.url()).not.toContain(SESSION_ID)

  await beat(page)
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(chip(page)).toBeVisible()
  await beat(page)

  await chip(page).getByRole('button', { name: /Peek at/ }).click()
  const card = page.getByTestId('session-taskbar-card')
  await expect(card).toBeVisible()
  // Opened with ^, the card stays put: only a hover-opened card closes when the pointer leaves.
  await page.waitForTimeout(1_000)
  await expect(card).toBeVisible()
  const reply = card.getByTestId('session-taskbar-card-reply')
  await expect(reply).not.toHaveText(/Loading/, { timeout: 15_000 })
  await expect(reply).not.toHaveText('No reply yet.')
  await expect(card.getByTestId('session-taskbar-card-input')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await chip(page).getByRole('button', { name: /Close .* to the background/ }).click()
})
