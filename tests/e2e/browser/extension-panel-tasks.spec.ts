/**
 * The side panel after the second review (web/src/popout/PopoutExtTasks.tsx, PopoutExtPanel.tsx,
 * packages/browser-extension/src/popup.ts in the Passwords view):
 *
 * - Tasks: a waiting approval leads Needs you with Approve and Deny; a row does not repeat its
 *   section; a task goes to Focus from its row or the opened task; a reply leaves the row in place
 *   with what was said; the save button is plainly off on a Walnut tab, with the reason.
 * - Ask: the brand colour on the person's bubble, no bare actions under a bubble, and the page
 *   quote of a new question on the composer.
 * - Passwords: one header (the panel's view bar with Back), no second Walnut brand bar.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { askView, backToAsk, openPanel, openView, selectText, startPanelLab, tasksView, type PanelLab } from './extension-panel-harness'
import { holdApprovalsLock } from './approvals-lock'

test.describe.configure({ mode: 'serial' })
// It makes and answers an approval on the shared fixture server, where another file clears them.
// Each test starts and ends with none waiting: the Ask view shows the oldest two, so ones another
// file left waiting (an agent's asks time out after 10 minutes) hid this test's own (2026-11-06).
holdApprovalsLock('file', { clear: true })

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
  // A selection on the page: the composer quotes it (with none, the page chip alone says what goes).
  await selectText(lab.doc, 'p1')
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

test('Ask: an approval waiting shows over the conversation with its buttons, and counts on the drawer\'s Tasks row (R2-5)', async () => {
  test.setTimeout(120_000)
  // A side panel's width (the harness's window opens at the browser's).
  await panel.setViewportSize({ width: 400, height: 760 })
  const v = askView(panel)
  await expect(v.getByTestId('ask-object-session')).toBeVisible({ timeout: 30_000 })
  // It arrives while the person is in Ask: the view shows it at once, no other view opened.
  const order = `Buy the dock ${Date.now().toString(36)}`
  const made = await lab.doc.request.post(`${lab.base}/api/v1/approvals`, { data: { what: `Click "${order}" on shop.example.test`, timeout_ms: 300_000 } })
  expect(made.ok(), await made.text()).toBe(true)
  const approvalId = String(((await made.json()) as { approval: { id: string } }).approval.id)
  const row = v.locator(`[data-testid="ext-ask-approval"][data-approval-id="${approvalId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText(order)
  await expect(row.getByRole('button', { name: 'Deny' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible()
  // Over the conversation, under the header, never over the composer.
  const head = (await v.getByTestId('ext-ask-head').boundingBox())!
  const box = (await row.boundingBox())!
  const composer = (await v.locator('.session-panel.is-plain-chat textarea').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
  expect(box.y + box.height).toBeLessThan(composer.y)
  // Its buttons fit the panel: the row is never wider than the view.
  const view = (await v.getByTestId('ext-panel').boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width + 0.5)
  await shot(panel, 'r2-ask-approval')
  // The drawer's Tasks row counts it with what needs the person.
  await v.getByTestId('ask-walnut-menu').click()
  await expect(v.getByTestId('ext-drawer-tasks-count')).toBeVisible()
  expect(Number(await v.getByTestId('ext-drawer-tasks-count').textContent())).toBeGreaterThanOrEqual(1)
  await panel.keyboard.press('Escape')
  await row.getByRole('button', { name: 'Approve' }).click()
  await expect(row).toHaveCount(0, { timeout: 15_000 })
  const back = await (await lab.doc.request.get(`${lab.base}/api/v1/approvals/${approvalId}`)).json() as { approval: { status: string } }
  expect(back.approval.status).toBe('approved')
})

test('Ask: an answer that fails says why in the strip, and the card\'s notes show as on Home (review round 2, finding 3)', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  // A Face ID ask on a server with no signing device is answered by tap, and the card says so.
  const what = `Publish build ${Date.now().toString(36)}`
  const made = await lab.doc.request.post(`${lab.base}/api/v1/approvals`, { data: { what, mode: 'biometric', timeout_ms: 300_000 } })
  expect(made.ok(), await made.text()).toBe(true)
  const a = ((await made.json()) as { approval: { id: string; downgraded?: string } }).approval
  const row = v.locator(`[data-testid="ext-ask-approval"][data-approval-id="${a.id}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  if (a.downgraded) await expect(row.locator('.approval-note').first()).toHaveText(a.downgraded)
  // The server refuses the answer: the strip says why, under buttons that came back.
  const answer = new RegExp(`/api/v1/approvals/${a.id}/answer`)
  const refusal = 'This request was already answered on another device.'
  await lab.ctx.route(answer, (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: refusal }) }))
  try {
    await row.getByRole('button', { name: 'Deny' }).click()
    await expect(row.getByTestId('ext-approval-error')).toHaveText(refusal, { timeout: 15_000 })
    await expect(row.getByTestId('ext-approval-error')).toHaveAttribute('role', 'alert')
    await expect(row.getByRole('button', { name: 'Deny' })).toBeEnabled()
    // The words stay inside the row, within the panel's width.
    const box = (await row.boundingBox())!
    const err = (await row.getByTestId('ext-approval-error').boundingBox())!
    expect(err.y + err.height).toBeLessThanOrEqual(box.y + box.height + 0.5)
    expect(err.x + err.width).toBeLessThanOrEqual(box.x + box.width + 0.5)
    await shot(panel, 'r2-ask-approval-error')
    // The Tasks view (a frame of its own) says it the same way when its answer fails.
    await openView(panel, 'tasks')
    const trow = tasksView(panel).locator(`[data-testid="approval-row"][data-approval-id="${a.id}"]`)
    await expect(trow).toBeVisible({ timeout: 20_000 })
    await trow.getByRole('button', { name: 'Deny' }).click()
    await expect(trow.getByTestId('ext-approval-error')).toHaveText(refusal, { timeout: 15_000 })
    await backToAsk(panel)
  } finally {
    await lab.ctx.unroute(answer)
  }
  // Answered for real, the error goes with it.
  await row.getByRole('button', { name: 'Deny' }).click()
  await expect(row).toHaveCount(0, { timeout: 15_000 })
})

test('Ask: an agent\'s browser step reads whole (what, the site, why it waits), and unlocking in place has no empty band (review round 3)', async () => {
  test.setTimeout(120_000)
  await panel.setViewportSize({ width: 400, height: 760 })
  const v = askView(panel)
  const now = Date.now()
  // What outward-asks.ts writes for a held "Place order" (a real one comes only from an agent's step).
  const what = 'Let a Walnut agent click button "Place order" on shop.lab.test:3650 ($42.10)? It buys or pays.'
  const approval = {
    id: `apr-r3-${now.toString(36)}`, what, digest: 'd', mode: 'tap', guard: 'person',
    requester: { host: '__local__', command: 'walnut browser click', local: true },
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(), status: 'pending',
  }
  const list = /\/api\/v1\/approvals(\?.*)?$/
  await lab.ctx.route(list, (route) => route.request().method() === 'GET' ? route.fulfill({ json: { approvals: [approval], keys: [] } }) : route.continue())
  try {
    // The view reads the list again on a reconnect or a key change; a reload is the plain way here.
    await panel.frames().find((f) => f.url().includes('view=ext-panel'))!.evaluate(() => location.reload())
    const row = v.locator(`[data-testid="ext-ask-approval"][data-approval-id="${approval.id}"]`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    const title = row.locator('.ext-ask-approval-what')
    await expect(title).toHaveText(what)
    // Whole: nothing cut, the site and the reason on screen.
    expect(await title.evaluate((e) => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1)).toBe(true)
    expect(await title.evaluate((e) => getComputedStyle(e).webkitLineClamp)).not.toBe('2')
    // Across the card's width, the buttons under it.
    const tb = (await title.boundingBox())!
    const rb = (await row.boundingBox())!
    expect(tb.width).toBeGreaterThan(rb.width * 0.8)
    await shot(panel, 'r3-ask-approval-whole')
    const unlock = row.getByTestId('approval-unlock-to-approve')
    if (await unlock.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await unlock.click()
      const label = row.locator('.approval-unlock-label')
      await expect(label).toBeVisible()
      const who = (await row.locator('.ext-ask-approval-who').boundingBox())!
      const lb = (await label.boundingBox())!
      // Right under who asks: the row's own gap, no band (it was about 24 px of nothing).
      expect(lb.y - (who.y + who.height)).toBeLessThanOrEqual(10)
      await shot(panel, 'r3-ask-approval-unlock')
      await row.getByRole('button', { name: 'Cancel' }).click()
    } else {
      test.info().annotations.push({ type: 'note', description: 'Passwords shared an unlock here: no unlock form to measure' })
    }
  } finally {
    await lab.ctx.unroute(list)
    // The made-up request leaves the view with the real list.
    await panel.frames().find((f) => f.url().includes('view=ext-panel'))?.evaluate(() => location.reload())
    await expect(v.getByTestId('ext-ask-head')).toBeVisible({ timeout: 30_000 })
  }
})

test('Tasks: an approval leads Needs you and is answered here; rows say no section twice', async () => {
  test.setTimeout(120_000)
  expect((await lab.doc.request.patch(`${lab.base}/api/v1/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  // Its own words: another file's approval may still wait on the shared fixture server.
  const order = `Place order ${Date.now().toString(36)}`
  const made = await lab.doc.request.post(`${lab.base}/api/v1/approvals`, { data: { what: `Click "${order}" on shop.example.test`, timeout_ms: 300_000 } })
  expect(made.ok(), await made.text()).toBe(true)
  const approvalId = String(((await made.json()) as { approval: { id: string } }).approval.id)

  await openView(panel, 'tasks')
  const t = tasksView(panel)
  const needs = t.getByTestId('ext-tasks-needs')
  const row = needs.locator('[data-testid="approval-row"]').filter({ hasText: order })
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
  // Added, it moves to Focus: the list, its count and the row agree (round 3: a row wore the
  // Focus mark under Needs you while the header said Focus 0).
  const focus = t.getByTestId('ext-tasks-focus')
  await expect(focus.locator(`[data-testid="ext-task"][data-task-id="${otherId}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(other).toHaveCount(0)
  await expect(t.getByTestId('ext-tasks-needs').getByTestId('ext-task-infocus')).toHaveCount(0)
  const focusRows = await focus.getByTestId('ext-task').count()
  await expect(focus.locator('.ext-tasks-count')).toHaveText(String(focusRows))
  await expect(focus.locator('.ext-tasks-empty')).toHaveCount(0)
  const task = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks/${otherId}`)).json() as Record<string, any>
  const tk = (task.task ?? task) as { pinned?: boolean; focus_tier?: string }
  expect(tk.pinned).toBe(true)
  expect(tk.focus_tier).toBe('focus')

  // A panel ask is a conversation, never pinned to Focus (review 2026-11-06): it needs the person,
  // so Needs you lists it, and Focus does not.
  const row = t.locator(`[data-testid="ext-tasks-needs"] [data-testid="ext-task"][data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(focus.locator(`[data-task-id="${taskId}"]`)).toHaveCount(0)

  // The hover band is the whole row, its Add to Focus included (R2-8).
  const needsRow = t.locator('[data-testid="ext-tasks-needs"] [data-testid="ext-task"]').filter({ has: t.getByTestId('ext-task-focus-row') }).first()
  await needsRow.locator('.ext-task-head').hover()
  const band = await needsRow.locator('.ext-task-headrow').evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, w: e.getBoundingClientRect().width, row: e.parentElement!.getBoundingClientRect().width }))
  expect(band.bg).not.toBe('rgba(0, 0, 0, 0)')
  expect(Math.abs(band.w - band.row)).toBeLessThan(1)
  const btn = (await needsRow.getByTestId('ext-task-focus-row').boundingBox())!
  const bandBox = (await needsRow.locator('.ext-task-headrow').boundingBox())!
  expect(btn.x + btn.width).toBeLessThanOrEqual(bandBox.x + bandBox.width + 0.5)

  await row.locator('.ext-task-head').click()
  const input = row.getByTestId('ext-task-input')
  // One frame around the reply: the answer box's, none on the field inside it (R2-8).
  expect(await input.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('none')
  await input.fill('Go with the first one')
  await row.getByTestId('ext-task-send').click()
  await expect(row.getByTestId('ext-task-replied')).toContainText('Go with the first one', { timeout: 20_000 })
  // Answered, the task works again and needs the person no more: its row stays, with its state now.
  await panel.waitForTimeout(3000)
  await expect(row).toBeVisible()
  await shot(panel, 'r2-tasks-replied')
  // Dark: the warm grey of Ask and of the extension's bar over it, never the app's pure black (R2-8).
  await panel.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => t.getByTestId('ext-tasks').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(31, 29, 27)')
  // Its buttons on the warm raised grey once their colour transition ends.
  await expect.poll(() => t.getByTestId('ext-tasks-save-page').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(42, 39, 36)')
  await shot(panel, 'r2-tasks-replied-dark')
  await panel.emulateMedia({ colorScheme: 'light' })
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
// here the view with no vault yet shows no second header either: its bar is the panel's, with Back.
test('Passwords: one header, the panel\'s view bar', async () => {
  test.setTimeout(60_000)
  await openView(panel, 'passwords')
  const pw = panel.frameLocator('iframe.panel-frame-passwords')
  await expect(pw.locator('body')).toBeVisible({ timeout: 20_000 })
  await panel.waitForTimeout(1500)
  await expect(pw.locator('.top:not(.top-sub) > h1')).toBeHidden()
  await expect(pw.locator('.top:not(.top-sub) > .logo')).toBeHidden()
  await shot(panel, 'r2-passwords')
  await panel.close()
})
