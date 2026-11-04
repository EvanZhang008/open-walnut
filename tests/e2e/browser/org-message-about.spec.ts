/**
 * The tasks a reply in a VP's chat is about, under it as live pills (src/core/org/message-about.ts).
 * 2026-10-31, the user decided it: the node's session ends its message with a hidden
 * `<walnut-about tasks="…"/>` line; Walnut takes it off and draws the tasks under the message.
 *   - the reply's text never shows the line; the pills read as the tasks' live names
 *   - a click on a pill opens that task beside the page
 * The mock CLI echoes the message it was sent, so a message ending in the line gives a reply
 * ending in it. The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org about ${STAMP}`
const NODE = `project:${PROJECT.toLowerCase()}`
const made: string[] = []
const ids = { lead: '', move: '', boxes: '', leadSid: '' }
let cwd = ''

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  for (const [k, title] of [['move', `Book the movers ${STAMP}`], ['boxes', `Pack the boxes ${STAMP}`]] as const) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
    ids[k] = task.id
    made.push(task.id)
  }
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
  const message = `How is the move going ${STAMP}?\n<walnut-about tasks="${ids.move},${ids.boxes}"/>`
  ids.leadSid = (await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message, taskId: ids.lead })).sessionId
  // The reply is in the history, with its tasks on the row and the line off its text.
  await expect.poll(async () => {
    const body = await (await request.get(`/api/v1/sessions/${ids.leadSid}/history?tail=40`)).json() as { messages?: Array<{ role: string; text: string; about?: string[] }> }
    const reply = (body.messages ?? []).find((m) => m.role === 'assistant' && m.text.includes(STAMP))
    return reply ? { about: reply.about ?? [], tag: reply.text.includes('<walnut-about') } : null
  }, { timeout: 60_000 }).toEqual({ about: [ids.move, ids.boxes], tag: false })
})

test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`)
})

test('a VP\'s reply shows the tasks it is about as live pills, and the line never prints', async ({ page }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${NODE}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
  const chat = page.locator(`[data-testid="org-chat"] .session-panel[data-session-id="${ids.leadSid}"]`)
  await expect(chat).toBeVisible({ timeout: 30_000 })
  const about = chat.getByTestId('msg-about')
  await expect(about).toHaveCount(1, { timeout: 30_000 })
  await expect(about).toHaveAttribute('data-ids', `${ids.move},${ids.boxes}`)
  // The pills read as the tasks' names, not their ids.
  await expect(about).toContainText(`Book the movers ${STAMP}`, { timeout: 30_000 })
  await expect(about).toContainText(`Pack the boxes ${STAMP}`)
  // Each wears its task's live status dot, as every pill does.
  await expect(about.locator(`a.task-link[data-task-id="${ids.move}"]`)).toHaveAttribute('data-user-state', /\w/)
  // The reply's own words carry no line (the user's own message, echoed as typed, may).
  const reply = chat.locator('.session-msg').filter({ has: page.getByTestId('msg-about') })
  await expect(reply).not.toContainText('walnut-about')
  await about.screenshot({ path: `test-results/org-message-about-${test.info().project.name}.png` })
  // A pill opens its task beside the page. A real press and release, as a person clicks: the pill must still be there at the release.
  await about.locator(`a.task-link[data-task-id="${ids.move}"]`).click()
  await expect(page.getByTestId('org-side')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('org-side-title')).toHaveText(`Book the movers ${STAMP}`)
})
