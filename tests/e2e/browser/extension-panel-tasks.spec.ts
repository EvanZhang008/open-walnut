/**
 * The side panel after the second review (web/src/popout/PopoutExtTasks.tsx, PopoutExtPanel.tsx,
 * packages/browser-extension/src/popup.ts in the Passwords tab):
 *
 * - Tasks: a waiting approval leads Needs you with Approve and Deny; a row does not repeat its
 *   section; a task goes to Focus from its row or the opened task; a reply leaves the row in place
 *   with what was said; the save button is plainly off on a Walnut tab, with the reason.
 * - Ask: the brand colour on the person's bubble, no bare actions under a bubble, and the page
 *   quote of a new question on the composer.
 * - Passwords: one header (the panel's tabs), no second Walnut brand bar.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { askView, openPanel, startPanelLab, tasksView, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

let lab: PanelLab
let panel: Page
let taskId = ''
const SHOTS = process.env.PANEL_SHOTS_DIR ?? ''
const shot = async (p: Page, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'tasks2')
})
test.afterAll(async () => { await lab?.close() })

test('Ask: the brand colour, no bare actions under a bubble, the page quote on the composer', async () => {
  test.setTimeout(120_000)
  ;({ panel } = await openPanel(lab, 'ask'))
  const v = askView(panel)
  const quote = v.getByTestId('ask-object-quote')
  const composer = v.locator('[data-testid="ask-object-compose"] textarea')
  await expect(quote).toBeVisible({ timeout: 60_000 })
  // The quote of what goes with the question sits just above the composer, not mid-panel.
  const q = (await quote.boundingBox())!
  const c = (await v.locator('[data-testid="ask-object-compose"] .chat-input-box, [data-testid="ask-object-compose"] textarea').first().boundingBox())!
  expect(c.y - (q.y + q.height)).toBeLessThan(48)
  expect(Math.abs(q.x - c.x)).toBeLessThan(24)
  await shot(panel, 'r2-ask-compose')

  await composer.fill('What changed in this release?')
  await composer.press('Enter')
  await expect(v.getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 60_000 })
  const bubble = v.locator('.session-msg-user').first()
  expect(await bubble.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(138, 90, 43)')
  // A bubble's actions are not drawn until it is hovered (this headless page reports no hover).
  const actions = bubble.locator('.session-msg-actions')
  if (await actions.count()) expect(await actions.first().evaluate((e) => getComputedStyle(e).opacity)).toBe('0')
  await shot(panel, 'r2-ask-reply')
  const sid = await v.getByTestId('ask-object-session').getAttribute('data-session-id')
  const rec = await (await lab.doc.request.get(`${lab.base}/api/v1/sessions/${sid}`)).json() as Record<string, any>
  taskId = String(rec.taskId ?? rec.session?.taskId ?? '')
  expect(taskId).not.toBe('')
})

test('Tasks: an approval leads Needs you and is answered here; rows say no section twice', async () => {
  test.setTimeout(120_000)
  expect((await lab.doc.request.patch(`${lab.base}/api/v1/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  const made = await lab.doc.request.post(`${lab.base}/api/v1/approvals`, { data: { what: 'Click "Place order" on shop.example.test', timeout_ms: 300_000 } })
  expect(made.ok(), await made.text()).toBe(true)
  const approvalId = String(((await made.json()) as { approval: { id: string } }).approval.id)

  await panel.getByTestId('panel-tab-tasks').click()
  const t = tasksView(panel)
  const needs = t.getByTestId('ext-tasks-needs')
  const row = needs.locator('[data-testid="approval-row"]').filter({ hasText: 'Place order' })
  await expect(row).toBeVisible({ timeout: 30_000 })
  // Above every task of the section.
  const first = await needs.locator('[data-testid="approval-row"], [data-testid="ext-task"]').first().getAttribute('data-testid')
  expect(first).toBe('approval-row')
  // A row under Needs you does not start with "Needs you" again.
  const line = needs.locator(`[data-testid="ext-task"][data-task-id="${taskId}"] [data-testid="ext-task-line"]`)
  if (await line.count()) await expect(line).not.toHaveText(/^Needs you/)
  await shot(panel, 'r2-tasks-approval')
  await row.getByRole('button', { name: 'Deny' }).click()
  await expect(row).toHaveCount(0, { timeout: 15_000 })
  const back = await (await lab.doc.request.get(`${lab.base}/api/v1/approvals/${approvalId}`)).json() as { approval: { status: string } }
  expect(back.approval.status).toBe('denied')
})

test('Tasks: Add to Focus from the row; a reply leaves the row in place with what was said', async () => {
  test.setTimeout(120_000)
  const t = tasksView(panel)
  // A task that needs the person and is not in Focus yet.
  const made = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data: { title: `Panel needs ${Date.now().toString(36)}` } })
  expect(made.ok(), await made.text()).toBe(true)
  const madeJson = await made.json() as Record<string, any>
  const otherId = String(madeJson.task?.id ?? madeJson.id)
  expect((await lab.doc.request.patch(`${lab.base}/api/v1/tasks/${otherId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  const other = t.locator(`[data-testid="ext-tasks-needs"] [data-testid="ext-task"][data-task-id="${otherId}"]`)
  await expect(other).toBeVisible({ timeout: 30_000 })
  await other.locator('.ext-task-head').hover()
  await other.getByTestId('ext-task-focus-row').click()
  await expect(other.getByTestId('ext-task-infocus')).toBeVisible({ timeout: 15_000 })
  const task = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks/${otherId}`)).json() as Record<string, any>
  const tk = (task.task ?? task) as { pinned?: boolean; focus_tier?: string }
  expect(tk.pinned).toBe(true)
  expect(tk.focus_tier).toBe('focus')

  const row = t.locator(`[data-testid="ext-tasks-needs"] [data-testid="ext-task"][data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })

  await row.locator('.ext-task-head').click()
  const input = row.getByTestId('ext-task-input')
  await input.fill('Go with the first one')
  await row.getByTestId('ext-task-send').click()
  await expect(row.getByTestId('ext-task-replied')).toContainText('Go with the first one', { timeout: 20_000 })
  // Answered, the task works again and needs the person no more: its row stays, with its state now.
  await panel.waitForTimeout(3000)
  await expect(row).toBeVisible()
  await shot(panel, 'r2-tasks-replied')
})

test('Tasks: on a Walnut tab the save button is plainly off and says why', async () => {
  test.setTimeout(90_000)
  await lab.doc.goto(`${lab.base}/`)
  const t = tasksView(panel)
  const save = t.getByTestId('ext-tasks-save-page')
  await expect(save).toBeDisabled({ timeout: 20_000 })
  await expect(t.getByTestId('ext-tasks-save-why')).toHaveText('Open a web page to save it as a task.')
  expect(Number(await save.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.6)
  await shot(panel, 'r2-tasks-save-off')
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  await expect(save).toBeEnabled({ timeout: 20_000 })
  await expect(t.getByTestId('ext-tasks-save-why')).toHaveCount(0)
})

// The list with its tools, unlocked, is checked in extension-sidepanel.spec.ts (it has a vault);
// here the tab with no vault yet shows no second header either.
test('Passwords: one header, the panel\'s tabs', async () => {
  test.setTimeout(60_000)
  await panel.getByTestId('panel-tab-passwords').click()
  const pw = panel.frameLocator('iframe.panel-frame-passwords')
  await expect(pw.locator('body')).toBeVisible({ timeout: 20_000 })
  await panel.waitForTimeout(1500)
  await expect(pw.locator('.top:not(.top-sub) > h1')).toBeHidden()
  await expect(pw.locator('.top:not(.top-sub) > .logo')).toBeHidden()
  await shot(panel, 'r2-passwords')
  await panel.close()
})
