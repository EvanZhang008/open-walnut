/**
 * His next chat message on another subject keeps the card he just read (src/core/org/threads-model.ts
 * fileMessage, thread-view.ts uncheckedJoin; 2026-11-23, the user: "本来是 need you，然后我随便一聊，
 * 它就直接就消失，直接就消失了").
 *
 * A task with Threads on, one answered thread from his question a moment ago, its Threads view
 * beside its chat. He types a chat message on another subject within the join window: Walnut files
 * it into that thread for its timing (marked for the node's check), and the card stays where it was,
 * answered, with its summary and its message count, until the node's status answer checks it.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Join ${STAMP}`
const made: string[] = []
const ids = { task: '', sid: '', thread: '' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 900 } })

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Error chart ${STAMP}`, project: PROJECT, source: 'local' })
  made.push(task.id)
  ids.task = task.id
  const res = await request.patch(`/api/tasks/${task.id}`, { data: { threads_on: true } })
  expect(res.ok()).toBe(true)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: task.id })
  await expect.poll(async () => (ids.sid = (await (await request.get(`/api/tasks/${task.id}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
})

test.afterAll(async ({ request }) => {
  for (const id of [...made].reverse()) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

test('a chat message on another subject, right after his last one, leaves the card he read in place', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await seedColumns(page, [ids.sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.sid}"]`)
  const chip = panel.getByTestId('session-threads-chip')
  await expect(chip).toBeVisible({ timeout: 30_000 })

  // His question, answered on its card a moment ago (the window starts at his message).
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.task}/threads`, { text: `Can the error chart tell us when it is not normal ${STAMP}?` })
  ids.thread = thread.id
  const patched = await request.patch(`/api/v1/tasks/${ids.task}/threads/${thread.id}`, { data: { title: `Error chart: is it normal ${STAMP}`, reply: 'Yes: the weekly report compares the chart with its last 3 weeks; this week is inside the normal range.', state: 'answered' } })
  expect(patched.ok(), await patched.text()).toBe(true)

  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
  const pane = panel.getByTestId('session-threads-pane')
  const card = pane.locator(`[data-testid="org-thread"][data-thread-id="${thread.id}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveAttribute('data-state', 'answered')
  const countBefore = await card.getByTestId('org-thread-count').textContent()
  await video.caption('His question is answered: the card is on show')
  await video.hold(1500)

  // His next chat message, on another subject, inside the join window.
  await panel.locator('.session-panel-input .chat-input-textarea').first().click()
  await page.keyboard.type(`snapshot-clean-turn:Answered. Unrelated: what is a subscription exception ${STAMP}?`)
  await page.keyboard.press('Enter')
  await video.caption('He sends a chat message on another subject')

  // Walnut filed it into that thread for its timing, marked for the node's check.
  await expect.poll(async () => {
    const t = (await (await request.get(`/api/v1/tasks/${ids.task}/threads/${thread.id}`)).json()).thread as { messages?: Array<{ text: string; joined?: string }> } | undefined
    return t?.messages?.find((m) => m.text.includes('subscription exception'))?.joined ?? 'missing'
  }, { timeout: 30_000 }).toBe('recent')

  // The card stays: answered, the same summary and message count, not moved to the work in progress.
  await page.waitForTimeout(1500)
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-state', 'answered')
  await expect(card.getByTestId('org-thread-reply')).toContainText('inside the normal range')
  await expect(card.getByTestId('org-thread-count')).toHaveText(countBefore ?? '')
  await video.caption('The card he read stays as it was until the node checks the message')
  await video.hold(2500)
  await video.stop('thread-join-keeps-card')
  expect(pageErrors).toEqual([])
})
