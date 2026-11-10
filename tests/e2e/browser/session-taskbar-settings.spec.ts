/**
 * The bottom bar's two switches (2026-11-10, the user: "this bar, if only has the recent don;t
 * sow", then "add a setting for this, also if we should have "recnet" side also have a setting to
 * contorl, liek before all the redne tor minized will all go to below, have 2 otpions"). By
 * default the bar is not drawn while it holds only Recent: it comes with a Minimize, Recent
 * beside the chip, and goes when the last chip is restored. Settings > General turns that off,
 * and sends a closed session to a chip instead of Recent, each applied at once (the bar is drawn
 * on the Settings page too) and kept across a reload. The config writes stay in this browser
 * (taskbar-settings-helpers.ts), so no other spec sees them.
 */
import { test, expect, type Page } from '@playwright/test'
import { pinTaskbarConfig } from './taskbar-settings-helpers'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const OTHER_TASK = 'pw-task-001'
const RECENT_KEY = 'open-walnut-layout:home-recent'
const CHIPS_KEY = 'open-walnut-layout:home-minimized'

/** A beat a person can follow, only while recording (PW_VIDEO, walnut-dev webkit --video). */
const beat = (page: Page) => (process.env.PW_VIDEO ? page.waitForTimeout(1200) : Promise.resolve())

const bar = (page: Page) => page.getByTestId('session-taskbar')
const column = (page: Page, sid: string) => page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
const recentPill = (page: Page, sid: string) => page.locator(`.session-taskbar-recent-pill[data-session-id="${sid}"]`)
const chip = (page: Page, sid: string) => page.locator(`.session-taskbar-chip[data-session-id="${sid}"]`)

async function home(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(({ r, c }) => { localStorage.setItem(c, JSON.stringify({ v: 1, value: [] })); localStorage.setItem(r, JSON.stringify({ v: 1, value: null })) }, { r: RECENT_KEY, c: CHIPS_KEY })
  await page.reload()
  await page.waitForLoadState('networkidle')
}

/** Open a task's session on Home's strip from the task list; returns its session id. */
async function openTask(page: Page, taskId: string, query: string): Promise<string> {
  const sids = () => page.locator('.main-page-session-column .session-panel').evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id') ?? ''))
  const before = new Set(await sids())
  await page.locator('.todo-search-input').fill(query)
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible()
  await row.locator('.todo-item-title').click()
  let sid = ''
  await expect.poll(async () => { sid = (await sids()).find((s) => s && !before.has(s) && !s.startsWith('draft')) ?? ''; return sid }, { timeout: 20_000 }).not.toBe('')
  await page.locator('.todo-search-input').fill('')
  await expect(column(page, sid)).toBeVisible()
  return sid
}

async function openSettings(page: Page) {
  await page.locator('.sidebar a[href^="/settings"]').click()
  await expect(page.getByTestId('settings-taskbar-hide-recent-only-row')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('settings-taskbar-hide-recent-only-row').scrollIntoViewIfNeeded()
}

async function goHome(page: Page) {
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 20_000 })
}

test('with only Recent the bar is not drawn; a Minimize brings it with Recent beside the chip; restoring the chip hides it again', async ({ page }) => {
  await pinTaskbarConfig(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await home(page)
  await openTask(page, TASK_ID, SESSION_ID)
  await beat(page)
  // × sends it to Recent, and Recent alone draws no bar.
  await column(page, SESSION_ID).getByRole('button', { name: 'Close session panel' }).click()
  await expect(column(page, SESSION_ID)).toHaveCount(0)
  await expect(bar(page)).toHaveCount(0)
  await beat(page)

  // A Minimize brings the bar, its chip first and Recent (kept all along) at the right end.
  const other = await openTask(page, OTHER_TASK, OTHER_TASK)
  await beat(page)
  await column(page, other).getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(bar(page)).toBeVisible()
  await expect(chip(page, other)).toBeVisible()
  await expect(recentPill(page, SESSION_ID)).toBeVisible()
  await beat(page)
  // Restoring the only chip leaves Recent alone again: no bar.
  await chip(page, other).locator('.session-taskbar-open').click()
  await expect(column(page, other)).toBeVisible()
  await expect(bar(page)).toHaveCount(0)
  await beat(page)
  // A reload keeps that: no bar, Recent still kept for the next Minimize.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(column(page, other)).toBeVisible()
  await expect(bar(page)).toHaveCount(0)
  await column(page, other).getByRole('button', { name: 'Minimize session to the taskbar' }).click()
  await expect(recentPill(page, SESSION_ID)).toBeVisible()
  await chip(page, other).getByRole('button', { name: /Close .* to the background/ }).click()
  await expect(bar(page)).toHaveCount(0)
})

test('Settings > General: "Hide the bottom bar when it has only Recent" flips the bar at once and is kept', async ({ page }) => {
  const cfg = await pinTaskbarConfig(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await home(page)
  await openTask(page, TASK_ID, SESSION_ID)
  await column(page, SESSION_ID).getByRole('button', { name: 'Close session panel' }).click()
  await expect(bar(page)).toHaveCount(0)

  await openSettings(page)
  const toggle = page.locator('#settings-taskbar-hide-recent-only')
  await expect(toggle).toBeChecked()
  // The bar is drawn on every page: turning the switch off shows it here, at once.
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(recentPill(page, SESSION_ID)).toBeVisible()
  await expect.poll(() => cfg.now().taskbar_hide_recent_only).toBe(false)
  await beat(page)
  await goHome(page)
  await expect(recentPill(page, SESSION_ID)).toBeVisible()
  // Kept: a reload reads it back from the config.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(recentPill(page, SESSION_ID)).toBeVisible()
  await beat(page)
  // On again: the bar goes at once.
  await openSettings(page)
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(bar(page)).toHaveCount(0)
  await expect.poll(() => cfg.now().taskbar_hide_recent_only).toBe(true)
  await beat(page)
  expect(cfg.writes.every((w) => w.taskbar_leaving === 'recent'), 'the other switch is written unchanged').toBe(true)
})

test('Settings > General: "Closed sessions go to: Bar chips" makes a closed session a chip, as before; Recent sends it back to Recent', async ({ page }) => {
  const cfg = await pinTaskbarConfig(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await home(page)
  await openSettings(page)
  const chips = page.getByTestId('settings-taskbar-leaving-chips')
  const recent = page.getByTestId('settings-taskbar-leaving-recent')
  await expect(recent).toHaveAttribute('aria-checked', 'true')
  await chips.click()
  await expect(chips).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => cfg.now().taskbar_leaving).toBe('chips')
  await beat(page)

  await goHome(page)
  await openTask(page, TASK_ID, SESSION_ID)
  await beat(page)
  await column(page, SESSION_ID).getByRole('button', { name: 'Close session panel' }).click()
  await expect(column(page, SESSION_ID)).toHaveCount(0)
  await expect(chip(page, SESSION_ID)).toBeVisible()
  await expect(page.getByTestId('session-taskbar-recent')).toHaveCount(0)
  await beat(page)
  // The chip opens it again, and the bar goes with it.
  await chip(page, SESSION_ID).locator('.session-taskbar-open').click()
  await expect(column(page, SESSION_ID)).toBeVisible()
  await expect(bar(page)).toHaveCount(0)

  // Back to Recent: a close goes to Recent, and with only Recent there is no bar.
  await openSettings(page)
  await recent.click()
  await expect(recent).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => cfg.now().taskbar_leaving).toBe('recent')
  await goHome(page)
  await column(page, SESSION_ID).getByRole('button', { name: 'Close session panel' }).click()
  await expect(column(page, SESSION_ID)).toHaveCount(0)
  await expect(chip(page, SESSION_ID)).toHaveCount(0)
  await expect(bar(page)).toHaveCount(0)
  await beat(page)
  await page.evaluate(({ r }) => localStorage.setItem(r, JSON.stringify({ v: 1, value: null })), { r: RECENT_KEY })
})
