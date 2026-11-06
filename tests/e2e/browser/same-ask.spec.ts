/**
 * One decision shows once on Home (src/core/same-ask.ts; 2026-11-04: a lead and its subtask both sat
 * in Needs you asking whether to create three alpha test accounts). A lead and its subtask ask the
 * user the same: Needs you lists the subtask only, and the lead waits under Waiting / snoozed naming
 * it. Answering the subtask settles both: neither is in Needs you after. Records a video of it
 * (SAME_ASK_VIDEO_DIR) for the hand-off.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { endRunningTurn, interruptTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn, statusSectionRows } from './status-section-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const VIDEO_DIR = process.env.SAME_ASK_VIDEO_DIR
const SHOTS = process.env.SAME_ASK_SHOT_DIR ?? '/tmp/same-ask'
const made: string[] = []
const sessions: string[] = []

test.setTimeout(150_000)

test.afterEach(async ({ request }) => {
  for (const sid of sessions.splice(0)) await endRunningTurn(request, sid)
  for (const id of made.splice(0).reverse()) await request.delete(`${API}/api/tasks/${id}?force=true`).catch(() => {})
})

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function statusOf(id: string): Promise<any> {
  return (await api('GET', `/api/tasks/${id}`))?.task?.user_status ?? (await api('GET', `/api/tasks/${id}`))?.user_status
}

test('a lead and its subtask asking the same decision show one Needs you row; answering it settles both', async ({ browser, request }, info) => {
  const stamp = Date.now()
  const project = `Alpha${stamp}`
  const lead = (await api('POST', '/api/tasks', { title: `Platform lead ${stamp}`, source: 'local', project })).task.id as string
  made.push(lead)
  const child = (await api('POST', '/api/tasks', { title: `Alpha stages ${stamp}`, source: 'local', project })).task.id as string
  made.push(child)
  await api('PATCH', `/api/v1/tasks/${child}`, { parent_task_id: lead })
  // The subtask has a session (the fixture's mock CLI), idle after a short turn: the user answers it there.
  const childSid = await startRunningTurn(request, child, 2_000)
  sessions.push(childSid)
  await interruptTurn(request, childSid)
  // Each task's own line, as its turn-end report would say it (set here as a person: never refused).
  await api('PUT', `/api/v1/tasks/${lead}/report`, { state: 'needs', ask: 'Should we create three alpha test accounts?' })
  await api('PUT', `/api/v1/tasks/${child}/report`, { state: 'needs', ask: 'Create the three alpha test accounts?' })
  await expect.poll(async () => (await statusOf(lead))?.sameAsk?.id, { timeout: 30_000 }).toBe(child)
  expect((await statusOf(child))?.state).toBe('needs')

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(VIDEO_DIR ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } } } : {}),
  })
  const page = await context.newPage()
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await page.addInitScript(() => localStorage.setItem('open-walnut-view:tasks.statusLines', 'true'))
  await page.goto('/')
  await selectSection(page, 'All')
  const panel = page.locator('.todo-panel').first()
  const needsRows = statusSectionRows(panel, 'needs')

  // One row: the subtask's, with its own ask; the lead is not in Needs you.
  await expect(needsRows.locator(`[data-task-id="${child}"]`)).toBeVisible({ timeout: 20_000 })
  await expect(needsRows.locator(`[data-task-id="${lead}"]`)).toHaveCount(0)
  await page.waitForTimeout(1200)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-1-one-row.png` }).catch(() => {})
  // The lead waits under Waiting / snoozed, naming the subtask that asks.
  await setStatusSectionOpen(panel, 'waiting', true)
  const leadCard = await showSectionCard(panel, 'waiting', lead)
  await leadCard.scrollIntoViewIfNeeded()
  await expect(leadCard).toContainText(`Alpha stages ${stamp}`)
  await page.waitForTimeout(1500)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-2-lead-waits.png` }).catch(() => {})

  // The user answers the subtask in its session; its next turn works on it. Neither asks him any more.
  await api('POST', `/api/v1/sessions/${childSid}/messages`, { text: 'Yes, create the three accounts.' })
  await api('PUT', `/api/v1/tasks/${child}/report`, { state: 'working', next: 'Creating the three accounts' })
  await expect.poll(async () => (await statusOf(child))?.state, { timeout: 30_000 }).not.toBe('needs')
  await expect(needsRows.locator(`[data-task-id="${child}"]`)).toHaveCount(0, { timeout: 20_000 })
  await expect(needsRows.locator(`[data-task-id="${lead}"]`)).toHaveCount(0)
  // The lead re-derives one sync pass after its subtask (a leader reads its subtasks' stored statuses).
  await expect.poll(async () => (await statusOf(lead))?.sameAsk?.answered, { timeout: 30_000 }).toBe(true)
  expect((await statusOf(lead))?.sameAsk?.id).toBe(child)
  await expect((await showSectionCard(panel, 'waiting', lead))).toContainText(`Answered in "Alpha stages ${stamp}`)
  await page.waitForTimeout(1500)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-3-settled.png` }).catch(() => {})
  await context.close()
  if (VIDEO_DIR) await fs.readdir(VIDEO_DIR).then((f) => console.log(`[same-ask] video: ${VIDEO_DIR}/${f.join(', ')}`))
})

test('two sibling tasks asking the same show one row; their leader answering it for the user clears both', async ({ browser, request }, info) => {
  const stamp = Date.now()
  const project = `Orchard${stamp}`
  const lead = (await api('POST', '/api/tasks', { title: `Orchard lead ${stamp}`, source: 'local', project })).task.id as string
  made.push(lead)
  const a = (await api('POST', '/api/tasks', { title: `Plugin rollout ${stamp}`, source: 'local', project })).task.id as string
  made.push(a)
  const b = (await api('POST', '/api/tasks', { title: `CR reviews ${stamp}`, source: 'local', project })).task.id as string
  made.push(b)
  for (const id of [a, b]) await api('PATCH', `/api/v1/tasks/${id}`, { parent_task_id: lead })
  const leadSid = await startRunningTurn(request, lead, 2_000)
  sessions.push(leadSid)
  await interruptTurn(request, leadSid)
  const aSid = await startRunningTurn(request, a, 2_000)
  sessions.push(aSid)
  await interruptTurn(request, aSid)
  await api('PUT', `/api/v1/tasks/${a}/report`, { state: 'needs', ask: 'Should the deploy handler wait for the plugin rollout?' })
  await expect.poll(async () => (await statusOf(a))?.state, { timeout: 30_000 }).toBe('needs')
  await api('PUT', `/api/v1/tasks/${b}/report`, { state: 'needs', ask: 'Should the deploy handler wait for the plugin rollout' })
  await expect.poll(async () => (await statusOf(b))?.sameAsk?.id, { timeout: 30_000 }).toBe(a)

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(VIDEO_DIR ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } } } : {}),
  })
  const page = await context.newPage()
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await page.addInitScript(() => localStorage.setItem('open-walnut-view:tasks.statusLines', 'true'))
  await page.goto('/')
  await selectSection(page, 'All')
  const panel = page.locator('.todo-panel').first()
  const needsRows = statusSectionRows(panel, 'needs')
  await expect(needsRows.locator(`[data-task-id="${a}"]`)).toBeVisible({ timeout: 20_000 })
  await expect(needsRows.locator(`[data-task-id="${b}"]`)).toHaveCount(0)
  await setStatusSectionOpen(panel, 'waiting', true)
  const bCard = await showSectionCard(panel, 'waiting', b)
  await bCard.scrollIntoViewIfNeeded()
  // A few words on the row, the task that holds it first; the whole sentence (its ask) on hover.
  await expect(bCard.getByTestId('status-card-reason')).toHaveText(`Same decision in "Plugin rollout ${stamp}"`)
  await expect(bCard.getByTestId('status-card-reason')).toHaveAttribute('title', new RegExp(`the same decision in "Plugin rollout ${stamp}", beside it in its team: Should the deploy handler wait`))
  await page.waitForTimeout(1500)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-4-siblings-one-row.png` }).catch(() => {})

  // The leader decides it for the user: answers_ask on its message to the asking task.
  const res = await fetch(`${API}/api/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': leadSid },
    body: JSON.stringify({ to: a, title: 'Decided: wait', text: 'Wait up to ten minutes, roll back on timeout.', answers_ask: true, expect_reply: false }),
  })
  expect(res.status, await res.clone().text()).toBe(202)
  await expect(needsRows.locator(`[data-task-id="${a}"]`)).toHaveCount(0, { timeout: 30_000 })
  await expect(needsRows.locator(`[data-task-id="${b}"]`)).toHaveCount(0)
  // Its next turn repeats the ask: it still reads answered, off the user's list.
  await api('PUT', `/api/v1/tasks/${a}/report`, { state: 'needs', ask: 'Should the deploy handler wait for the plugin rollout?' })
  await expect.poll(async () => (await statusOf(a))?.answeredFor?.by, { timeout: 30_000 }).toBe(lead)
  const aCard = await showSectionCard(panel, 'waiting', a)
  await aCard.scrollIntoViewIfNeeded()
  await expect(aCard.getByTestId('status-card-reason')).toHaveText(`Answered by Orchard lead ${stamp}: Wait up to ten minutes, roll back on timeout.`)
  await expect(aCard.getByTestId('status-card-reason')).toHaveAttribute('title', new RegExp(`its next step, answered by Orchard lead ${stamp} for you: Wait up to ten minutes`))
  await expect(needsRows.locator(`[data-task-id="${a}"]`)).toHaveCount(0)
  // Its teammate folded under it reads answered there, by name.
  await expect.poll(async () => (await statusOf(b))?.sameAsk?.answered, { timeout: 30_000 }).toBe(true)
  await expect((await showSectionCard(panel, 'waiting', b)).getByTestId('status-card-reason')).toHaveText(`Answered in "Plugin rollout ${stamp}"`)
  await page.waitForTimeout(1500)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-5-answered-above.png` }).catch(() => {})
  await context.close()
  if (VIDEO_DIR) await fs.readdir(VIDEO_DIR).then((f) => console.log(`[same-ask] video: ${VIDEO_DIR}/${f.join(', ')}`))
})
