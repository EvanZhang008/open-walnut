/**
 * Watching in a node's grouped Threads (experiment brief_off, the view the user runs;
 * web/src/components/org/OrgThreadsWatching.tsx, src/core/org/thread-view.ts watchingOf). 2026-11-23,
 * the user, translated: "turn the pin into a watch ... its own category ... of course it is still in
 * working or whatever, but at the same time it is in Watching ... the same idea as our tasks".
 *  1. A thread pinned by the build before (`pinned` in its file) opens on Watching: the old pin is a watch.
 *  2. Watch on a Done card: Watching (first, open) lists it, and Done still holds it, wearing the eye;
 *     the Done count and the tab's count do not move. In Watching each card is one line (state,
 *     title, time) that opens in place, so a few watched threads never push Needs you down.
 *  3. The node watches a Working one: it is in Watching while Working stays folded with it inside.
 *  4. A drag by the grip reorders Watching, kept by the server and after a reload.
 *  5. Watching folds and opens from its head.
 *  6. Stop watching from the Watching card: it leaves Watching, its Done card loses the eye; the
 *     last one gone, there is no Watching group.
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Watchtower ${STAMP}`
const made: string[] = []
const ids = { lead: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const T = { old: 'th-00000000f001', done: 'th-00000000f002', working: 'th-00000000f003', waiting: 'th-00000000f004' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ viewport: { width: 1280, height: 860 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function send<T>(request: APIRequestContext, method: 'post' | 'put' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

interface Stored { id: string; watched?: { at: string; by: string } }
async function stored(request: APIRequestContext): Promise<Stored[]> {
  return ((await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json()) as { threads: Stored[] }).threads
}

const group = (page: Page, g: string) => page.locator(`section[data-testid="org-thread-group"][data-group="${g}"]`)
const cardsIn = (page: Page, g: string) => group(page, g).locator('[data-testid="org-thread"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')))

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  if ((await detail.getByTestId('org-top').getAttribute('data-view')) !== 'threads') await detail.getByTestId('org-top-threads').click()
  await expect(page.getByTestId('org-thread-groups')).toBeVisible({ timeout: 20_000 })
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/thread-watching-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  for (const title of [`Climb the tower ${STAMP}`, `Light the lamp ${STAMP}`]) {
    made.push((await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const t0 = Date.now() - 60 * 60_000
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString()
  const thread = (id: string, title: string, state: string, min: number, extra: Record<string, unknown> = {}) => ({
    id, title, titled: true, state, reply: `${title}: where it stands.`, createdAt: at(0), updatedAt: at(min),
    messages: [{ id: id.replace('th-', 'tm-'), at: at(min - 1), text: `${title}?`, via: 'chat', ...(state === 'answered' ? { answer: { at: at(min), text: `${title}: the answer.` } } : {}) }],
    ...extra,
  })
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${ids.lead}.json`, JSON.stringify({ version: 1, taskId: ids.lead, threads: [
    // Pinned by the build before the watch: it opens on Watching.
    thread(T.old, 'Giant list lost its context', 'answered', 20, { pinned: { at: at(21), by: 'human' } }),
    thread(T.done, 'Rename the phone tab', 'answered', 30),
    thread(T.working, 'Fix the mail digest', 'working', 25),
    thread(T.waiting, 'Wait for the review', 'pending', 15),
  ] }))
  const res = await request.put('/api/config', { data: { experimental: { brief_off: true } } })
  expect(res.ok(), await res.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  await request.put('/api/config', { data: { experimental: { brief_off: false } } })
  for (const id of made) await removeTask(request, id)
})

test('a watched thread is in Watching and in its own group; drag orders Watching; stop watching takes it off', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)

  // 1. The old pin is a watch: Watching comes first, and the thread is in Done too.
  const order = () => page.getByTestId('org-thread-groups').evaluate((root) => [...root.querySelectorAll<HTMLElement>('section[data-testid="org-thread-group"]')].map((s) => s.dataset.group))
  await expect.poll(order).toEqual(['watching', 'read', 'working', 'waiting'])
  await expect.poll(() => cardsIn(page, 'watching')).toEqual([T.old])
  await expect.poll(() => cardsIn(page, 'read')).toEqual([T.done, T.old])
  const doneCount = await group(page, 'read').getByTestId('org-thread-group-count').textContent()
  const tabCount = await page.getByTestId('org-top-threads').textContent()

  // 2. Watch the Done card: Watching lists it last; Done keeps both, the new one with the eye.
  const doneCard = group(page, 'read').locator(`[data-thread-id="${T.done}"]`)
  await expect(doneCard.getByTestId('org-thread-watched')).toHaveCount(0)
  await doneCard.getByTestId('org-thread-watch').click()
  await expect.poll(() => cardsIn(page, 'watching')).toEqual([T.old, T.done])
  await expect(doneCard.getByTestId('org-thread-watched')).toHaveText(/^Watching/)
  await expect(doneCard.getByTestId('org-thread-watch')).toHaveAttribute('aria-pressed', 'true')
  await expect(group(page, 'watching').getByTestId('org-thread-group-count')).toHaveText('2')
  await expect(group(page, 'read').getByTestId('org-thread-group-count')).toHaveText(doneCount ?? '')
  await expect(page.getByTestId('org-top-threads')).toHaveText(tabCount ?? '')
  await expect.poll(async () => (await stored(request)).find((t) => t.id === T.done)?.watched?.by, { timeout: 15_000 }).toBe('human')
  const row = group(page, 'watching').locator(`[data-thread-id="${T.done}"]`)
  await expect(row).toHaveAttribute('data-folded', 'true')
  await expect(row.getByTestId('org-thread-watch')).toHaveCount(0)
  await row.getByTestId('org-thread-head').click()
  await expect(row).not.toHaveAttribute('data-folded', 'true')
  await expect(row.getByTestId('org-thread-watch')).toHaveAttribute('aria-pressed', 'true')
  await row.getByTestId('org-thread-head').click()
  await expect(row).toHaveAttribute('data-folded', 'true')

  // 3. The node watches the Working one: in Watching, while Working stays folded with it inside.
  // A session's write (a caller id Walnut cannot place reads as an agent, never as him).
  const otherSid = `watch-agent-${STAMP}`
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${T.working}`, { watch: true }, otherSid)
  await expect.poll(() => cardsIn(page, 'watching'), { timeout: 15_000 }).toEqual([T.old, T.done, T.working])
  await expect(group(page, 'working')).toHaveAttribute('data-open', 'false')
  await expect(group(page, 'working').getByTestId('org-thread-group-count')).toHaveText('1')
  await expect(group(page, 'watching').locator(`[data-thread-id="${T.working}"] [data-testid="org-thread-state"]`)).toContainText('Working')
  await shot(page, 'three')

  // 4. Drag the last one (Working) to the top by its grip.
  const grip = group(page, 'watching').locator(`[data-thread-id="${T.working}"]`).getByTestId('org-thread-watch-grip')
  const first = group(page, 'watching').locator(`[data-thread-id="${T.old}"]`)
  await first.scrollIntoViewIfNeeded()
  await expect(grip).toBeInViewport()
  const from = (await grip.boundingBox())!
  const to = (await first.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, from.y - 10, { steps: 4 })
  await page.mouse.move(to.x + 30, to.y + 4, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => cardsIn(page, 'watching')).toEqual([T.working, T.old, T.done])
  const byPlace = async () => (await stored(request)).filter((t) => t.watched).sort((a, b) => a.watched!.at.localeCompare(b.watched!.at)).map((t) => t.id)
  await expect.poll(byPlace, { timeout: 15_000 }).toEqual([T.working, T.old, T.done])
  await page.reload()
  await openLead(page)
  await expect.poll(() => cardsIn(page, 'watching')).toEqual([T.working, T.old, T.done])

  // 5. Watching folds and opens from its head.
  const head = group(page, 'watching').getByTestId('org-thread-group-head')
  await head.click()
  await expect(group(page, 'watching')).toHaveAttribute('data-open', 'false')
  await expect.poll(() => cardsIn(page, 'watching')).toEqual([])
  await head.click()
  await expect.poll(() => cardsIn(page, 'watching')).toEqual([T.working, T.old, T.done])

  // 6. Stop watching from the Watching card: it leaves Watching, its Done card loses the eye.
  const off = async (id: string) => {
    const r = group(page, 'watching').locator(`[data-thread-id="${id}"]`)
    await r.getByTestId('org-thread-head').click()
    await r.getByTestId('org-thread-watch').click()
  }
  await off(T.done)
  await expect.poll(() => cardsIn(page, 'watching')).toEqual([T.working, T.old])
  await expect(group(page, 'read').locator(`[data-thread-id="${T.done}"]`).getByTestId('org-thread-watched')).toHaveCount(0)
  await off(T.working)
  await off(T.old)
  await expect(group(page, 'watching')).toHaveCount(0)
  await expect.poll(async () => (await stored(request)).filter((t) => t.watched).length, { timeout: 15_000 }).toBe(0)
  expect(pageErrors).toEqual([])
})
