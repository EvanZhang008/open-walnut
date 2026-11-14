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
import { closeSessionKebab, kebabRow, openSessionKebab } from './session-kebab-helpers'
import { pinTaskbarConfig } from './taskbar-settings-helpers'

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

/**
 * Make the fixture session name `taskId` as its task: its record and its status, both (the
 * status batch's taskId wins over the record's, so a late status alone would point it back).
 */
async function pointSessionAt(page: Page, sessionId: string, taskId: string) {
  await page.route((url) => url.pathname.endsWith(`/api/sessions/${sessionId}`), async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (body.session) body.session.taskId = taskId
    else body.taskId = taskId
    await route.fulfill({ response, json: body })
  })
  await page.route((url) => url.pathname.endsWith('/api/sessions/status'), async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { statuses?: Record<string, { taskId?: string }> }
    const snap = body.statuses?.[sessionId]
    if (snap) snap.taskId = taskId
    await route.fulfill({ response, json: body })
  })
}

/** A beat a person can follow, only while recording (PW_VIDEO, walnut-dev webkit --video). */
const beat = (page: Page) => (process.env.PW_VIDEO ? page.waitForTimeout(1200) : Promise.resolve())

const chip = (page: Page) => page.locator(`.session-taskbar-chip[data-session-id="${SESSION_ID}"]`)

test('every icon of the header\'s window buttons draws on the row\'s middle, Minimize included', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const controls = panel.locator('.session-panel-window-controls')
  await expect(controls.locator('[data-header-id="minimize"]')).toBeVisible()
  const inks = await iconInkOffsets(controls.locator('button'))
  expect(inks.map((i) => i.id)).toEqual(expect.arrayContaining(['minimize']))
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
  // Recent alone draws a bar only with that switch off (default on: session-taskbar-settings.spec.ts).
  await pinTaskbarConfig(page, { taskbar_hide_recent_only: false })
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
  // Recent alone draws a bar only with that switch off (default on: session-taskbar-settings.spec.ts).
  await pinTaskbarConfig(page, { taskbar_hide_recent_only: false })
  test.setTimeout(120_000)
  // The lock (holdPanelCountLock) puts the count back as it found it after the test.
  await setPanelMode(page, '1')
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
})

test('the bar is the same on every page: Minimize on the Org side panel shows there and on Home, and a chip opens it where you are', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // In-app navigation, the way a click on a task on the Org page opens its panel.
  await page.evaluate((sid) => { history.pushState({}, '', `/org?open=session:${sid}`); dispatchEvent(new PopStateEvent('popstate')) }, SESSION_ID)
  const side = page.locator(`[data-testid="org-side"][data-session-id="${SESSION_ID}"]`)
  await expect(side).toBeVisible({ timeout: 20_000 })
  await beat(page)
  await side.getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(side).toHaveCount(0)
  // The bar is on the Org page too.
  await expect(chip(page)).toBeVisible()
  await beat(page)
  // A chip on the Org page opens the session in its side panel, and leaves the bar.
  await chip(page).locator('.session-taskbar-open').click()
  await expect(side).toBeVisible({ timeout: 20_000 })
  await expect(chip(page)).toHaveCount(0)
  await beat(page)
  await side.getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(chip(page)).toBeVisible()
  await beat(page)
  await chip(page).getByRole('button', { name: /Close .* to the background/ }).click()
})

test('a taskbar an older Walnut saved (pushed-out sessions mixed in) opens with no chips, its sessions under Recent', async ({ page }) => {
  // Recent alone draws a bar only with that switch off (default on: session-taskbar-settings.spec.ts).
  await pinTaskbarConfig(page, { taskbar_hide_recent_only: false })
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
  await pointSessionAt(page, SESSION_ID, ARCHIVED)
  await page.addInitScript((id) => {
    localStorage.setItem('open-walnut-layout:home-columns', JSON.stringify({ v: 1, value: [{ id, locked: false }] }))
  }, SESSION_ID)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const watching = page.getByRole('region', { name: 'Watching' })
  await expect(watching.getByText('Archived migration plan')).toHaveCount(0)
  // Watch is the ⋮ menu's task row: a click closes the menu, the next open reads the new state.
  let watch = await kebabRow(panel, 'task-kebab-watch')
  await expect(watch).toHaveText('Watch')
  await watch.click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect(watching.getByText('Archived migration plan', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  watch = await kebabRow(panel, 'task-kebab-watch')
  await expect(watch).toHaveText('Stop watching')
  await watch.click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect(watching.getByText('Archived migration plan')).toHaveCount(0)
})

test('Watch clicked while its write is still on its way reads Stop watching when the menu opens again', async ({ page }) => {
  const ARCHIVED = 'mpwold01-aa11'
  await pointSessionAt(page, SESSION_ID, ARCHIVED)
  // A slow network: the first write takes 2 s, the second 6 s, so the first one's echo comes back
  // while the second click's write is still out. The menu row unmounts long before either.
  const writes: string[] = []
  await page.route(`**/api/tasks/${ARCHIVED}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    writes.push(String((route.request().postDataJSON() as { watched_at?: string }).watched_at ?? ''))
    await new Promise((r) => setTimeout(r, writes.length === 1 ? 2000 : 6000))
    await route.fallback()
  })
  await page.addInitScript((id) => {
    localStorage.setItem('open-walnut-layout:home-columns', JSON.stringify({ v: 1, value: [{ id, locked: false }] }))
  }, SESSION_ID)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await (await kebabRow(panel, 'task-kebab-watch')).click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  // Opened again at once: the click, not the stale task.
  const watch = await kebabRow(panel, 'task-kebab-watch')
  await expect(watch).toHaveText('Stop watching')
  await watch.click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[0]).not.toBe('')
  expect(writes[1]).toBe('')
  // The first write's echo lands (the task reads watched) while the second is still out: the menu
  // keeps the latest click.
  await page.waitForTimeout(3000)
  await expect((await kebabRow(panel, 'task-kebab-watch'))).toHaveText('Watch')
  await closeSessionKebab(panel)
  await page.waitForTimeout(5000)
  await expect((await kebabRow(panel, 'task-kebab-watch'))).toHaveText('Watch', { timeout: 15_000 })
  await closeSessionKebab(panel)
})

test('two Watch clicks while the first write is out reach the server in order: the last click is what is stored', async ({ page }) => {
  const ARCHIVED = 'mpwold01-aa11'
  await pointSessionAt(page, SESSION_ID, ARCHIVED)
  // Each write is held until the test lets it go.
  const writes: string[] = []
  const releases: Array<() => void> = []
  await page.route(`**/api/tasks/${ARCHIVED}`, async (route) => {
    const body = route.request().postDataJSON() as { watched_at?: string } | null
    if (route.request().method() !== 'PATCH' || !body || !('watched_at' in body)) return route.fallback()
    writes.push(String(body.watched_at ?? ''))
    await new Promise<void>((resolve) => releases.push(resolve))
    await route.fallback()
  })
  await page.addInitScript((id) => {
    localStorage.setItem('open-walnut-layout:home-columns', JSON.stringify({ v: 1, value: [{ id, locked: false }] }))
  }, SESSION_ID)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  try {
    await (await kebabRow(panel, 'task-kebab-watch')).click()
    await expect.poll(() => writes.length).toBe(1)
    const watch = await kebabRow(panel, 'task-kebab-watch')
    await expect(watch).toHaveText('Stop watching')
    await watch.click()
    // The second click waits for the first write: one request out at a time.
    await page.waitForTimeout(500)
    expect(writes).toHaveLength(1)
    await expect((await kebabRow(panel, 'task-kebab-watch'))).toHaveText('Watch')
    await closeSessionKebab(panel)
    releases[0]!()
    await expect.poll(() => writes.length).toBe(2)
    expect(writes[1]).toBe('')
    releases[1]!()
    await expect.poll(async () => {
      const stored = await (await page.request.get(`/api/tasks/${ARCHIVED}`)).json() as { task?: { watched_at?: string | null } }
      return stored.task?.watched_at ?? ''
    }, { timeout: 15_000 }).toBe('')
    await expect((await kebabRow(panel, 'task-kebab-watch'))).toHaveText('Watch')
    await closeSessionKebab(panel)
    await expect(page.getByRole('region', { name: 'Watching' }).getByText('Archived migration plan')).toHaveCount(0)
  } finally {
    releases.forEach((release) => release())
  }
})

test('Esc on a worker picker opened from the session menu closes the picker only, then the menu', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const menu = await openSessionKebab(panel)
  await menu.getByTestId('kebab-team-toggle').click()
  await menu.getByTestId('kebab-adopt-worker').click()
  await expect(page.getByTestId('adopt-worker-flyout')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('adopt-worker-flyout')).toHaveCount(0)
  await expect(page.locator('.task-kebab-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
})

test('Esc on the session menu closes the menu only: full screen stays, and the next Esc leaves it', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await panel.locator('.session-panel-expand').click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await openSessionKebab(panel)
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.open-walnut-fullscreen')).toHaveCount(0)
})

test('Watch in the session menu keeps the task on the Watching list, and reads Stop watching while on', async ({ page }) => {
  const panel = await openSessionPanel(page)
  // The search that found the task hides the Watching section: clear it.
  await page.locator('.todo-search-input').fill('')
  const watching = page.getByRole('region', { name: 'Watching' })
  let watch = await kebabRow(panel, 'task-kebab-watch')
  await expect(watch).toHaveText('Watch')
  await beat(page)
  await watch.click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  // By id: another spec may rename the shared fixture task.
  const watchedRow = watching.locator(`[data-task-id="${TASK_ID}"]`)
  await expect(watchedRow.first()).toBeVisible({ timeout: 15_000 })
  watch = await kebabRow(panel, 'task-kebab-watch')
  await expect(watch).toHaveText('Stop watching')
  await beat(page)
  await watch.click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect(watchedRow).toHaveCount(0)
  await expect((await kebabRow(panel, 'task-kebab-watch'))).toHaveText('Watch')
  await closeSessionKebab(panel)
})

test('Locate and Watch are rows of the session menu, not buttons of the header row', async ({ page }) => {
  const panel = await openSessionPanel(page)
  // The header is drawn once the record is here (its kebab with it).
  const menu = await openSessionKebab(panel)
  await expect(panel.locator('.session-panel-header [data-header-id="watch"], .session-panel-header [data-header-id="locate"]')).toHaveCount(0)
  await expect(panel.getByTestId('session-panel-watch')).toHaveCount(0)
  await expect(panel.getByTestId('session-panel-locate')).toHaveCount(0)
  await expect(menu.getByTestId('session-menu-locate')).toHaveText('Locate task', { timeout: 30_000 })
  await expect(menu.getByTestId('task-kebab-watch')).toHaveText(/^(Watch|Stop watching)$/, { timeout: 30_000 })
  await closeSessionKebab(panel)
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
