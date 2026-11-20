/**
 * A node's Threads in the user's own groups, each chip a filter (experiment brief_off,
 * web/src/components/org/OrgThreadsByState.tsx, ThreadsFilterBar.tsx, src/core/org/thread-groups.ts;
 * 2026-11-20, the user: "No Need you, Done, waiting / snoozed, Acknowlegde, closed, archived", after
 * a click on Done still listed the Needs you cards).
 *
 * A lead with a thread in every group: Needs you (its Board's choice), Done (a result on its card),
 * Working, Waiting / Snoozed (one pending, one snoozed) and Closed; Archived holds none (a thread
 * is archived a day after it closed: tests/core/org/thread-groups.test.ts).
 *  1. The chips are All and the six groups, each with its count; All counts every group but Archived.
 *  2. Each chip shows only its group's cards, every one of them, and nothing else; Closed shows only
 *     the closed one, reading Closed; an empty group says so.
 *  3. The pick is kept: the page loaded again opens on the chip he left.
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Orchard ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', worker: '', needs: '', read: '', working: '', waiting: '', snoozed: '', closed: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function send<T>(request: APIRequestContext, method: 'post' | 'put' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
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

/** The lead opens a thread for him (answered, its result on the card), then moves it to `state` as the node. */
async function nodeThread(request: APIRequestContext, title: string, state?: 'working' | 'pending'): Promise<string> {
  const opened = await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title, text: `${title}: here is where it stands.`, from: 'node', state: 'answered' }, ids.leadSid)
  if (state) await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${opened.thread.id}`, { state }, ids.leadSid)
  return opened.thread.id
}

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect(page.getByTestId('org-thread-groups')).toBeVisible({ timeout: 20_000 })
}

const chip = (page: Page, g: string) => page.locator(`[data-testid="org-threads-chip"][data-group="${g}"]`)
/** The ids of the cards the Threads show now, and of each group they are drawn under. */
async function shownCards(page: Page): Promise<{ all: string[]; byGroup: Record<string, string[]> }> {
  return page.getByTestId('org-thread-groups').evaluate((root) => {
    const byGroup: Record<string, string[]> = {}
    for (const s of root.querySelectorAll<HTMLElement>('section[data-testid="org-thread-group"]')) {
      byGroup[s.dataset.group!] = [...s.querySelectorAll<HTMLElement>('[data-testid="org-thread"]')].map((c) => c.dataset.threadId!)
    }
    return { all: [...root.querySelectorAll<HTMLElement>('[data-testid="org-thread"]')].map((c) => c.dataset.threadId!), byGroup }
  })
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/thread-groups-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  for (const title of [`Prune the pear trees ${STAMP}`, `Net the cherries ${STAMP}`]) {
    made.push((await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.worker = made[0]
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await send(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  const res = await request.put('/api/config', { data: { experimental: { brief_off: true } } })
  expect(res.ok(), await res.text()).toBe(true)
  ids.read = await nodeThread(request, `The pears are pruned ${STAMP}`)
  ids.working = await nodeThread(request, `Order the netting ${STAMP}`, 'working')
  ids.waiting = await nodeThread(request, `Wait for the frost ${STAMP}`, 'pending')
  ids.snoozed = await nodeThread(request, `Plan the cider press ${STAMP}`)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.snoozed}`, { snooze: new Date(Date.now() + 2 * 86_400_000).toISOString() })
  ids.closed = await nodeThread(request, `The ladder is fixed ${STAMP}`)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.closed}`, { close: 'acked' })
  await send(request, 'put', `/api/v1/tasks/${ids.lead}/board`, {
    html: `<html><body><h1>Orchard</h1><walnut-choice id="net-when" title="Net the cherries now or in May? ${STAMP}" options="now:Now,may:In May" recommended="may" task="${ids.worker}"></walnut-choice></body></html>`,
  })
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json() as { threads: Array<{ id: string; choice?: { id: string } }> }
    return (ids.needs = file.threads.find((t) => t.choice?.id === 'net-when')?.id ?? '')
  }, { timeout: 30_000 }).not.toBe('')
})

test.afterAll(async ({ request }) => {
  await request.put('/api/config', { data: { experimental: { brief_off: false } } })
  for (const id of made) await removeTask(request, id)
})

test('each chip shows only its own group, every card of it, and the pick is kept', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const want: Record<string, string[]> = {
    needs: [ids.needs], read: [ids.read], working: [ids.working], waiting: [ids.waiting, ids.snoozed].sort(), done: [ids.closed], archived: [],
  }
  await expect.poll(async () => (await shownCards(page)).all.length, { timeout: 20_000 }).toBe(6)

  // 1. All and the six groups, in his words, each counted; All counts every group but Archived.
  await expect(page.getByTestId('org-threads-chip')).toHaveText(['All 6', 'Needs you 1', 'Done 1', 'Working 1', 'Waiting / Snoozed 2', 'Closed 1', 'Archived 0'])
  const all = await shownCards(page)
  expect(Object.fromEntries(Object.entries(all.byGroup).map(([g, xs]) => [g, [...xs].sort()]))).toEqual(
    Object.fromEntries(Object.entries(want).filter(([, xs]) => xs.length)))
  await shot(page, '0-all')

  // 2. Each chip: only its group's cards, all of them, under its own head; the empty one says so.
  for (const g of ['needs', 'read', 'working', 'waiting', 'done', 'archived', 'all']) {
    await chip(page, g).click()
    await expect(chip(page, g)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('org-thread-groups')).toHaveAttribute('data-filter', g)
    const shown = await shownCards(page)
    if (g === 'all') { expect(shown.all.sort()).toEqual(Object.values(want).flat().sort()); continue }
    expect(shown.all.sort(), g).toEqual(want[g])
    expect(Object.keys(shown.byGroup), g).toEqual(want[g].length ? [g] : [])
    if (!want[g].length) await expect(page.locator(`[data-testid="org-thread-group-empty"][data-group="${g}"]`)).toHaveText('Nothing in Archived.')
    if (g === 'done') {
      await expect(page.locator(`[data-thread-id="${ids.closed}"]`).getByTestId('org-thread-state')).toHaveText('Closed')
      await expect(page.locator(`[data-thread-id="${ids.closed}"]`).getByTestId('org-thread-closed')).toContainText('Closed')
      await shot(page, '1-closed')
    }
    if (g === 'read') await expect(page.locator(`[data-thread-id="${ids.read}"]`).getByTestId('org-thread-state')).toHaveText('Done')
  }

  // 3. The pick is kept: Closed, then the page loaded again opens on Closed.
  await chip(page, 'done').click()
  await loadHome(page)
  await openLead(page)
  await expect(chip(page, 'done')).toHaveAttribute('aria-pressed', 'true')
  expect((await shownCards(page)).all).toEqual([ids.closed])
  await chip(page, 'all').click()
  expect(pageErrors).toEqual([])
})
