/**
 * Home's taskbar (2026-11-06, the user: "like a taskbar in computer"): Minimize takes a
 * column off the strip and leaves it as a chip along the bottom of Home; a click on the
 * chip brings it back; × on a chip or on a column closes it to the background (the
 * session keeps running); the chips survive a reload. A chip's card shows the
 * session's last reply and a composer.
 */
import { test, expect, type Page } from '@playwright/test'

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

const chip = (page: Page) => page.locator(`.session-taskbar-chip[data-session-id="${SESSION_ID}"]`)

test('Minimize puts the column on the taskbar; its chip brings it back', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await panel.getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(panel).toHaveCount(0)
  await expect(chip(page)).toBeVisible()
  await expect(chip(page)).toContainText('Editor fixture task')

  await chip(page).locator('.session-taskbar-open').click()
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toBeVisible()
  await expect(chip(page)).toHaveCount(0)
  await expect(page.getByTestId('session-taskbar')).toHaveCount(0)
})

test('× on a column closes it to the background, never to a chip', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await panel.getByRole('button', { name: 'Close session panel' }).click()
  await expect(panel).toHaveCount(0)
  await expect(chip(page)).toHaveCount(0)
  await expect(page.getByTestId('session-taskbar')).toHaveCount(0)
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

  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(chip(page)).toBeVisible()

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
