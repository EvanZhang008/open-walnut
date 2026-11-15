/**
 * A move another task asked for waits for the session's turn (task_move, state pending). Its
 * line says who asked and why, and changing the session's model, effort or mode in the composer
 * leaves it exactly as it was (2026-11-15: the user changed a task's model while a move the
 * Walnut VP queued waited, read "Moves to clouddev when this turn ends" as the result of their
 * own click, and cancelled it).
 *
 * The seed (test-server.ts, pw-task-pending-move-<browser>) holds the pending move; the fixture
 * server is ephemeral, so no watcher runs it. Every request is the real server's.
 * Run: walnut-dev webkit tests/e2e/browser/pending-move-settings.spec.ts (add --video for the MP4).
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { presetPanelView } from './todo-panel-helpers'
import { REAL_PANEL } from './draft-helpers'

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/pending-move-settings'
mkdirSync(SHOTS, { recursive: true })
test.describe.configure({ timeout: 120_000 })
// Set before the page opens, so a recorded video has the page's own size (no grey band).
test.use({ viewport: { width: 1280, height: 860 } })

function ids(browserName: string) {
  const b = browserName === 'webkit' ? 'webkit' : 'chromium'
  return { taskId: `pw-task-pending-move-${b}`, sessionId: `pw-pending-move-session-${b}`, title: `Pending move test task ${b}`, switchId: `es-pw-pending-move-${b}` }
}

async function openPanel(page: Page, title: string) {
  await presetPanelView(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const row = page.locator('.todo-panel-item', { hasText: title }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(page.locator(`${REAL_PANEL} .chat-input-textarea`)).toBeVisible({ timeout: 15_000 })
}

/** What the server holds for the task's switch now. */
async function serverSwitch(page: Page, taskId: string) {
  const r = await page.request.get(`/api/v1/tasks/${taskId}/sessions`)
  expect(r.ok()).toBe(true)
  return (await r.json()).engineSwitch as Record<string, unknown> | undefined
}

test('changing the model, effort and mode while a move waits leaves the move as it was', async ({ page, browserName }) => {
  const t = ids(browserName)
  // Every request that could touch a switch: none may be sent by a setting change.
  const touched: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (/\/switch-engine$|\/move$/.test(u.pathname) && u.pathname.includes(t.taskId)) touched.push(`${r.method()} ${u.pathname}`)
  })
  const before = await serverSwitch(page, t.taskId)
  expect(before).toMatchObject({ id: t.switchId, state: 'pending', move: true })

  await openPanel(page, t.title)
  const line = page.locator(`${REAL_PANEL} [data-testid="engine-switch-line"]`)
  await expect(line).toHaveAttribute('data-state', 'pending')
  // Who asked and why, never a bare "Moves to" that reads as the person's own doing.
  await expect(line).toHaveText(/Walnut VP is moving this task to clouddev to run browser tests\. It moves when this turn ends\./)
  await expect(line.getByRole('button')).toHaveText(['Cancel move'])
  await line.screenshot({ path: `${SHOTS}/line-before-${browserName}.png` })

  // The model: open the composer's pill, pick another row (the real POST /model).
  const pill = page.locator(`${REAL_PANEL} .composer-model-pill`).first()
  await pill.click()
  const picker = page.locator('body > .model-picker.model-picker-popout')
  await expect(picker).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(400)
  const [modelPost] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/sessions/${t.sessionId}/model`) && r.request().method() === 'POST'),
    picker.locator('.model-picker-col-models .model-picker-row', { hasText: /^Opus/ }).first().click(),
  ])
  expect(modelPost.ok()).toBe(true)
  await expect(picker).toBeHidden({ timeout: 5000 })
  await page.waitForTimeout(800)
  await expect(line).toHaveAttribute('data-state', 'pending')
  await expect(line).toContainText('Walnut VP is moving this task to clouddev')

  // The effort, from the same picker.
  await pill.click()
  await expect(picker).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(400)
  const effortRows = picker.locator('.model-picker-col-effort .model-picker-row')
  if (await effortRows.count()) {
    const [effortPost] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/sessions/${t.sessionId}/effort`) && r.request().method() === 'POST'),
      effortRows.first().click(),
    ])
    expect(effortPost.status()).toBeLessThan(500)
  } else {
    await page.keyboard.press('Escape')
  }
  await expect(picker).toBeHidden({ timeout: 5000 })
  await page.waitForTimeout(800)

  // The mode, from its menu (PATCH /api/sessions/:id).
  await page.locator(`${REAL_PANEL} .mode-toggle-pill`).first().click()
  const menu = page.locator('.permission-mode-menu')
  await expect(menu).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(400)
  const [modePatch] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/sessions/${t.sessionId}`) && r.request().method() === 'PATCH'),
    menu.locator('.model-picker-row', { hasText: 'Plan' }).first().click(),
  ])
  expect(modePatch.ok()).toBe(true)
  await page.waitForTimeout(800)

  // The move is exactly as it was: the same switch, pending, its asker and reason, on the server too.
  await expect(line).toHaveAttribute('data-state', 'pending')
  await expect(line).toHaveText(/Walnut VP is moving this task to clouddev to run browser tests\. It moves when this turn ends\./)
  await line.screenshot({ path: `${SHOTS}/line-after-${browserName}.png` })
  expect(touched).toEqual([])
  expect(await serverSwitch(page, t.taskId)).toEqual(before)

  // And after a reload: nothing the picker did was a move.
  await page.reload()
  await page.waitForLoadState('networkidle')
  const row = page.locator('.todo-panel-item', { hasText: t.title }).first()
  if (!(await page.locator(`${REAL_PANEL} [data-testid="engine-switch-line"]`).isVisible())) await row.click()
  await expect(page.locator(`${REAL_PANEL} [data-testid="engine-switch-line"]`)).toHaveAttribute('data-state', 'pending', { timeout: 15_000 })
  expect(touched).toEqual([])
})
