/**
 * A Threads list holds still while he reads it (web/src/components/org/useThreadsHold.ts; 2026-11-23,
 * the user: "it should remain the exact ... keep this location from changing, or it keeps flashing,
 * some things removed, some added, I cannot tell which one changes").
 *
 * A task with Threads on and a dozen answered threads, its Threads view beside its chat, scrolled
 * so a card in the middle is at the top of the view:
 *  1. Cards come and go above it while the pointer is elsewhere (a new thread leads the list, one
 *     above is closed): the card stays where it was on screen.
 *  2. With the pointer over the list, a card below is written again (newest change first would
 *     lift it to the top) and a new thread arrives: every card keeps its place, the new one goes
 *     last. Once the pointer leaves, the order follows the list again.
 * Run in WebKit too (no CSS scroll anchoring there): `walnut-dev webkit tests/e2e/browser/threads-hold-still.spec.ts`.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Hold ${STAMP}`
const made: string[] = []
const ids = { task: '', sid: '', threads: [] as string[] }
let cwd = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 900 } })

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}
async function patch(request: APIRequestContext, url: string, data: unknown): Promise<void> {
  const res = await request.patch(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
}

/** A thread from his message, answered with a summary of a few lines. */
async function answeredThread(request: APIRequestContext, n: number): Promise<string> {
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.task}/threads`, { text: `How is bed ${n} of the garden doing ${STAMP}?` })
  const lines = Array.from({ length: 4 }, (_, i) => `Bed ${n}, check ${i + 1}: the soil is moist, the seedlings are up and the netting holds against the birds.`)
  await patch(request, `/api/v1/tasks/${ids.task}/threads/${thread.id}`, { title: `Garden bed ${n} ${STAMP}`, reply: lines.join('\n'), state: 'answered' })
  return thread.id
}

const paneOf = (page: Page) => page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.sid}"]`).getByTestId('session-threads-pane')
const cardIn = (pane: Locator, id: string) => pane.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
const order = (pane: Locator) => pane.locator('[data-testid="org-thread"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')))
const topOf = async (l: Locator) => (await l.boundingBox())!.y

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Garden ${STAMP}`, project: PROJECT, source: 'local' })
  made.push(task.id)
  ids.task = task.id
  await patch(request, `/api/tasks/${task.id}`, { threads_on: true })
  await post(request, '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: task.id })
  await expect.poll(async () => (ids.sid = (await (await request.get(`/api/tasks/${task.id}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  for (let n = 1; n <= 12; n++) ids.threads.push(await answeredThread(request, n))
})

test.afterAll(async ({ request }) => {
  for (const id of [...made].reverse()) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

test('the card he reads stays where it is while cards come, go and change around it', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await seedColumns(page, [ids.sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.sid}"]`)
  const chip = panel.getByTestId('session-threads-chip')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
  const pane = paneOf(page)
  await expect(pane.locator('[data-testid="org-thread"]')).toHaveCount(12, { timeout: 30_000 })
  const body = pane.locator('.session-threads-body')
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight * 2), 'the list scrolls').toBe(true)

  // Scroll so a card in the middle of the list sits near the top of the view.
  const first = await order(pane)
  const reading = cardIn(pane, first[5]!)
  await reading.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await body.evaluate((el) => { el.scrollTop -= 40 })
  await page.mouse.move(5, 5)
  await video.caption('Reading a card in the middle of the list')
  await video.hold(1500)
  const y0 = await topOf(reading)

  // 1. A new thread leads the list, then a card above is closed: the card stays on screen where it was.
  const fresh = await answeredThread(request, 13)
  await expect(cardIn(pane, fresh)).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => topOf(reading)).toBeCloseTo(y0, 0)
  await video.caption('A new thread arrived above: the card did not move')
  await video.hold(1500)
  await patch(request, `/api/v1/tasks/${ids.task}/threads/${first[1]}`, { close: 'acked' })
  await expect(cardIn(pane, first[1]!)).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => topOf(reading)).toBeCloseTo(y0, 0)
  await video.caption('A card above was closed: the card did not move')
  await video.hold(1500)

  // 2. Pointer over the list: a card below written again and a new thread keep every place.
  await reading.hover()
  const held = await order(pane)
  const y1 = await topOf(reading)
  const below = held[held.length - 2]!
  await patch(request, `/api/v1/tasks/${ids.task}/threads/${below}`, { reply: `Bed news ${STAMP}: the tomatoes are ripe.`, state: 'answered' })
  await expect(cardIn(pane, below).getByTestId('org-thread-reply')).toContainText('the tomatoes are ripe', { timeout: 15_000 })
  const another = await answeredThread(request, 14)
  await expect(cardIn(pane, another)).toHaveCount(1, { timeout: 15_000 })
  expect(await order(pane)).toEqual([...held, another])
  expect(Math.abs((await topOf(reading)) - y1)).toBeLessThan(1)
  await video.caption('Pointer on the list: a card changed and a new one came, nothing moved; the new one went last')
  await video.hold(2000)

  // The pointer leaves: newest change first again.
  await page.mouse.move(5, 5)
  await expect.poll(async () => (await order(pane)).slice(0, 2)).toEqual([another, below])
  await video.caption('Pointer away: the list follows its order again')
  await video.hold(1500)
  await video.stop('threads-hold-still')
  expect(pageErrors).toEqual([])
})
