/**
 * A decision letter waits on its sender's Threads, with the letter's buttons on the card
 * (experiment letters_as_threads, src/core/human-inbox/letter-threads.ts, web/src/components/org/
 * ThreadLetterAnswer.tsx; 2026-11-20, the user, on a decision letter he saw in his inbox and atop
 * his VP's chat but not in its Threads: "why it exist in both place? is it the same thing").
 *
 *  1. A lead's session sends a decision letter. On the lead's Threads (Org page) it is a thread
 *     waiting on him, with the letter's two option buttons.
 *  2. He clicks one: the card leaves his open threads, and the inbox reads the letter answered
 *     with that option (one decision, answered in one place).
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Letters ${STAMP}`
const SUBJECT = `Open the orchard to visitors this spring? ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', letter: '', thread: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function flag(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.put('/api/config', { data: { experimental: { letters_as_threads: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

const card = (page: Page) => page.locator(`[data-testid="org-thread-list"][data-show="open"] [data-testid="org-thread"][data-thread-id="${ids.thread}"]`)

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/letters-as-threads-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Prune the rows ${STAMP}`, `Paint the gate ${STAMP}`]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  await flag(request, true)
  // The lead's session asks him, as human_inbox_send does.
  ids.letter = (await post<{ id: string }>(request, '/api/v1/human-inbox', {
    subject: SUBJECT, type: 'action_required', markdown: 'The paths are dry now; the gate needs one more coat first.',
    actions: [{ id: 'open', label: 'Open it' }, { id: 'closed', label: 'Keep it closed' }],
    user_kind: 'user_own', user_kind_why: 'He asked to decide who visits the orchard',
  }, ids.leadSid)).id
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json() as { threads: Array<{ id: string; letter?: { id: string } }> }
    return (ids.thread = file.threads.find((t) => t.letter?.id === ids.letter)?.id ?? '')
  }, { timeout: 30_000 }).not.toBe('')
})

test.afterAll(async ({ request }) => {
  await flag(request, false)
  if (ids.letter) await request.post(`/api/v1/human-inbox/${ids.letter}/archive`, { data: { archived: true } }).catch(() => {})
  for (const id of made) await removeTask(request, id)
})

test('the letter waits on the lead\'s Threads with its buttons; a click answers it, and the inbox reads it answered', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)

  // 1. The thread card, waiting on him, with the letter's own two buttons.
  const thread = card(page)
  await expect(thread).toBeVisible({ timeout: 20_000 })
  await expect(thread).toHaveAttribute('data-state', 'needs')
  await expect(thread.getByTestId('org-thread-title')).toHaveText(SUBJECT)
  const answer = thread.getByTestId('org-thread-letter')
  await expect(answer).toHaveAttribute('data-letter-id', ids.letter)
  const options = answer.getByTestId('org-answer-option')
  await expect(options).toHaveText(['Open it', 'Keep it closed'], { timeout: 15_000 })
  // Answering is the letter's: no Acknowledge or Follow up that would leave the letter waiting.
  await expect(thread.getByTestId('org-thread-ack')).toHaveCount(0)
  await shot(page, '1-card')

  // 2. He picks one.
  await answer.locator('[data-testid="org-answer-option"][data-value="closed"]').click()
  await expect(card(page)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => ((await (await request.get(`/api/v1/human-inbox/${ids.letter}`)).json()) as { letter?: { answered?: { actionId: string } } }).letter?.answered?.actionId ?? '', { timeout: 15_000 }).toBe('closed')
  await shot(page, '2-answered')

  // The inbox shows the same decision, answered.
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  const row = panel.locator('.hib-row').filter({ hasText: SUBJECT })
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  await row.click()
  const reader = page.locator('.hib-view')
  await expect(reader).toBeVisible()
  await expect(reader.locator('.hib-answered')).toContainText('Answered: Keep it closed')
  await page.screenshot({ path: `${SHOTS}/letters-as-threads-3-inbox-${test.info().project.name}.png` })
  expect(pageErrors).toEqual([])
})
