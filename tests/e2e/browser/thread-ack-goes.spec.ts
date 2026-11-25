/**
 * His Acknowledge takes the card away with no line where it stood (web/src/components/org/thread-moves.ts
 * ackedBetween; 2026-11-25, the user, of "Moved to Acknowledged ... Show" left under a card he had just
 * acknowledged: "直接消失就好了，不要再显示一个很烦"), while a move the node makes still leaves its line.
 *
 * A lead with his Threads flags (brief_off, ack_means_known), a long Done:
 *  1. A click on Acknowledge: the card leaves Done and no move line shows (watched for 2 s, past the
 *     read the server's answer brings); the card it went to (Acknowledged) is folded, counted.
 *  2. Acknowledge with the keyboard: the card goes, no line, and the focus goes to the card that took
 *     its place (its head), never to the page.
 *  3. His Acknowledge from another screen (the same write the phone makes, arriving over the event
 *     bus): the card goes, no line.
 *  4. With ack_means_known off his Acknowledge closes the card: it goes to Closed, no line.
 *  5. The node moves a Done card to Waiting: its line shows, as before.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Orchard ack ${STAMP}`
const FLAGS = ['brief_off', 'ack_means_known', 'threads_one_card', 'org_leaders'] as const
const made: string[] = []
const ids = { lead: '', leadSid: '' }
const done: string[] = []
let flagsWere: Record<string, boolean> = {}

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 900 } })

async function call<T>(request: APIRequestContext, method: 'post' | 'put' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function doneThread(request: APIRequestContext, k: number): Promise<string> {
  const title = `Shelf ${k} is sorted ${STAMP}`
  const { thread } = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title, text: `${title}: done.`, from: 'node', state: 'answered' }, ids.leadSid)
  await call(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${thread.id}`, { reply: `Shelf ${k}: the jars are labelled and the top row is dusted.`, state: 'answered' }, ids.leadSid)
  return thread.id
}

const group = (page: Page, g: string) => page.locator(`section[data-testid="org-thread-group"][data-group="${g}"]`)
const cardIn = (page: Page, g: string, id: string) => group(page, g).locator(`[data-testid="org-thread"][data-thread-id="${id}"]:not([data-copy])`)
const lines = (page: Page) => page.getByTestId('org-thread-move-note')
/** No move line shows for `ms` (a line comes a commit after the card goes, and the server's answer a read later). */
async function noLineFor(page: Page, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    expect(await lines(page).count(), 'no move line after his Acknowledge').toBe(0)
    await page.waitForTimeout(100)
  }
}
const focusAt = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return { testId: el?.dataset.testid ?? el?.tagName ?? null, card: el?.closest<HTMLElement>('[data-testid="org-thread"]')?.dataset.threadId ?? null }
})
/** The ids of Done's cards, in order. */
const doneIds = (page: Page) => group(page, 'read').locator('[data-testid="org-thread"]:not([data-copy])').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.threadId!))

async function openLead(page: Page): Promise<void> {
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.trim().toLowerCase()}"]`).click()
  await expect(page.getByTestId('org-thread-groups')).toBeVisible({ timeout: 20_000 })
  await expect(group(page, 'read').locator('[data-testid="org-thread"]')).toHaveCount(done.length, { timeout: 30_000 })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  flagsWere = Object.fromEntries(FLAGS.map((f) => [f, cfg.config?.experimental?.[f] === true]))
  const on = await request.put('/api/config', { data: { experimental: Object.fromEntries(FLAGS.map((f) => [f, true])) } })
  expect(on.ok(), await on.text()).toBe(true)
  // A project with two teams gets a lead.
  for (const title of [`Label the jars ${STAMP}`, `Sweep the cellar ${STAMP}`]) made.push((await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  ids.lead = (await call<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await call(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  for (let k = 1; k <= 7; k++) done.push(await doneThread(request, k))
})

test.afterAll(async ({ request }) => {
  await request.put('/api/config', { data: { experimental: flagsWere } })
  for (const id of [...made].reverse()) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

test('his Acknowledge takes the card away with no line; the node\'s move still leaves one', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await openLead(page)
  await video.caption('A lead\'s Threads: Done holds the results he has not acknowledged')
  await video.hold(1200)

  // 1. A click on Acknowledge.
  const order = await doneIds(page)
  const first = order[1]!
  const ackButton = cardIn(page, 'read', first).getByTestId('org-thread-ack')
  await ackButton.scrollIntoViewIfNeeded()
  await video.caption('He clicks Acknowledge on a Done card')
  await ackButton.click()
  await expect(cardIn(page, 'read', first)).toHaveCount(0, { timeout: 5_000 })
  await noLineFor(page, 2_000)
  await expect(group(page, 'known')).toHaveAttribute('data-open', 'false')
  await expect(group(page, 'known').getByTestId('org-thread-group-count')).toHaveText('1')
  await video.caption('The card just goes: no line is left where it stood')
  await video.hold(1500)

  // 2. With the keyboard: the focus goes to the card that took its place.
  const now = await doneIds(page)
  const second = now[1]!
  const next = now[2]!
  await cardIn(page, 'read', second).getByTestId('org-thread-ack').focus()
  await video.caption('Acknowledge with the keyboard: the focus moves to the next card')
  await page.keyboard.press('Enter')
  await expect(cardIn(page, 'read', second)).toHaveCount(0, { timeout: 5_000 })
  await expect.poll(() => focusAt(page)).toEqual({ testId: 'org-thread-head', card: next })
  await noLineFor(page, 2_000)
  expect(await focusAt(page)).toEqual({ testId: 'org-thread-head', card: next })
  await video.hold(1200)

  // 3. His Acknowledge from another screen (the phone's write): the card goes, no line.
  const third = (await doneIds(page))[0]!
  await call(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${third}`, { close: 'acked' })
  await expect(cardIn(page, 'read', third)).toHaveCount(0, { timeout: 15_000 })
  await noLineFor(page, 2_000)
  await video.caption('Acknowledged on his phone: the card goes here too, no line')
  await video.hold(1200)

  // 4. ack_means_known off: his Acknowledge closes the card.
  const off = await request.put('/api/config', { data: { experimental: { ack_means_known: false } } })
  expect(off.ok(), await off.text()).toBe(true)
  try {
    const fourth = (await doneIds(page))[0]!
    await cardIn(page, 'read', fourth).getByTestId('org-thread-ack').click()
    await expect(cardIn(page, 'read', fourth)).toHaveCount(0, { timeout: 5_000 })
    await noLineFor(page, 2_000)
    await expect.poll(async () => ((await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json()) as { threads: Array<{ id: string; closed?: { how: string; by: string } }> }).threads.find((t) => t.id === fourth)?.closed)
      .toMatchObject({ how: 'acked', by: 'human' })
  } finally {
    await request.put('/api/config', { data: { experimental: { ack_means_known: true } } })
  }

  // 5. The node moves a Done card on: its line shows.
  const moved = (await doneIds(page))[0]!
  await call(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${moved}`, { state: 'pending' }, ids.leadSid)
  const line = page.locator(`[data-testid="org-thread-move-note"][data-moved-id="${moved}"]`)
  await expect(line).toBeVisible({ timeout: 15_000 })
  await expect(line).toContainText('Moved to Waiting')
  await video.caption('A move the agent makes still leaves its line')
  await video.hold(2000)
  await video.stop('thread-ack-goes')
  expect(pageErrors).toEqual([])
})
