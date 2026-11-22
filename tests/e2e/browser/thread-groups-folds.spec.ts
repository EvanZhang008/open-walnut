/**
 * A node's Threads as folded groups (experiment brief_off, web/src/components/org/OrgThreadsByState.tsx,
 * src/core/org/thread-groups.ts FOR_HIM_GROUPS / FOLDED_GROUPS; 2026-11-21, the user: "the default
 * is the view you need: Needs you first, then Done, and the rest auto collapsed", no row of tabs, and
 * an opened group folded again next time). The cause was a row of filter chips whose default, All,
 * drew every group's cards (commit 9f73d8e161).
 *
 * A lead with a thread in every group: Needs you (its Board's choice), Done (a result on its card),
 * Working, Waiting / Snoozed (one pending, one snoozed), Acknowledged (he acknowledged it, the AI
 * has not placed it yet: experiment ack_means_known) and Closed; Archived holds none.
 *  1. By default Needs you and Done show their cards, open, with no toggle; Working, Waiting /
 *     Snoozed, Acknowledged and Closed follow in that order, each one line with its count and no card;
 *     an empty group (Archived) draws nothing; there is no filter row.
 *  2. A click on a fold's head opens it (aria-expanded), its cards each reading the group's word; a
 *     second click folds it. Opened folds are not kept: leaving the Org page and coming back,
 *     another node and back, or a reload, shows them folded again.
 *  3. With ack_means_known off and nothing in Acknowledged, there is no Acknowledged group.
 *  4. His answer to the choice moves its card out of Needs you: a line stands in its place
 *     ("Moved to Closed", Show); Show opens Closed and brings the card's top into view, marked. A
 *     card snoozed with the keyboard leaves Done the same way, the line taking the focus; Enter on
 *     Show opens Waiting / Snoozed and hands the focus to its head. Each line fades by itself.
 *  5. A card that moved while the Threads were away leaves no line when they open again.
 *  6. A long group (25 cards) stays one line until opened.
 *  7. Under many long Done cards every folded head is in the pane on arrival, stacked along its
 *     bottom edge (sticky), and one click opens that group.
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
const ids = { lead: '', leadSid: '', worker: '', needs: '', read: '', working: '', waiting: '', snoozed: '', known: '', closed: '' }
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

const group = (page: Page, g: string) => page.locator(`section[data-testid="org-thread-group"][data-group="${g}"]`)
const head = (page: Page, g: string) => group(page, g).getByTestId('org-thread-group-head')
/** Opens a folded group; one already open stays open. */
async function openFold(page: Page, g: string): Promise<void> {
  await expect(group(page, g)).toBeVisible({ timeout: 15_000 })
  if ((await group(page, g).getAttribute('data-open')) !== 'true') await head(page, g).click()
  await expect(group(page, g)).toHaveAttribute('data-open', 'true')
}
/** The groups drawn, in order, each with whether it is open and the ids of the cards it shows. */
async function drawn(page: Page): Promise<Array<{ group: string; open: boolean; count: string; cards: string[]; toggle: boolean }>> {
  return page.getByTestId('org-thread-groups').evaluate((root) => [...root.querySelectorAll<HTMLElement>('section[data-testid="org-thread-group"]')].map((s) => ({
    group: s.dataset.group!,
    open: s.dataset.open === 'true',
    count: s.querySelector('[data-testid="org-thread-group-count"]')?.textContent ?? '',
    cards: [...s.querySelectorAll<HTMLElement>('[data-testid="org-thread"]')].map((c) => c.dataset.threadId!),
    toggle: !!s.querySelector('button[data-testid="org-thread-group-head"]'),
  })))
}
const shownIds = async (page: Page) => (await drawn(page)).flatMap((g) => g.cards)

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
  // His Acknowledge with ack_means_known on: Acknowledged while the AI decides.
  const ackOn = await request.put('/api/config', { data: { experimental: { ack_means_known: true } } })
  expect(ackOn.ok(), await ackOn.text()).toBe(true)
  ids.known = await nodeThread(request, `Pick the apples ${STAMP}`)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.known}`, { close: 'acked' })
  await send(request, 'put', `/api/v1/tasks/${ids.lead}/board`, {
    html: `<html><body><h1>Orchard</h1><walnut-choice id="net-when" title="Net the cherries now or in May? ${STAMP}" options="now:Now,may:In May" recommended="may" task="${ids.worker}"></walnut-choice></body></html>`,
  })
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json() as { threads: Array<{ id: string; choice?: { id: string } }> }
    return (ids.needs = file.threads.find((t) => t.choice?.id === 'net-when')?.id ?? '')
  }, { timeout: 30_000 }).not.toBe('')
})

test.afterAll(async ({ request }) => {
  await request.put('/api/config', { data: { experimental: { brief_off: false, ack_means_known: false } } })
  for (const id of made) await removeTask(request, id)
})

const labels: Record<string, string> = { needs: 'Needs you', read: 'Done', working: 'Working', waiting: 'Waiting / Snoozed', known: 'Acknowledged', done: 'Closed', archived: 'Archived' }

test('by default Needs you and Done show their cards and every other group is one folded line', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await expect.poll(async () => (await drawn(page)).length, { timeout: 20_000 }).toBe(6)

  // 1. Needs you and Done open with their cards and no toggle; the rest folded in order, counted, no card.
  expect(await drawn(page)).toEqual([
    { group: 'needs', open: true, count: '1', cards: [ids.needs], toggle: false },
    { group: 'read', open: true, count: '1', cards: [ids.read], toggle: false },
    { group: 'working', open: false, count: '1', cards: [], toggle: true },
    { group: 'waiting', open: false, count: '2', cards: [], toggle: true },
    { group: 'known', open: false, count: '1', cards: [], toggle: true },
    { group: 'done', open: false, count: '1', cards: [], toggle: true },
  ])
  for (const g of ['working', 'waiting', 'known', 'done']) {
    await expect(head(page, g)).toHaveAttribute('aria-expanded', 'false')
    await expect(head(page, g)).toContainText(labels[g])
  }
  await expect(head(page, 'needs')).toContainText('Needs you')
  await expect(head(page, 'read')).toContainText('Done')
  await expect(page.getByTestId('org-threads-filter')).toHaveCount(0)
  await expect(page.getByTestId('org-threads-chip')).toHaveCount(0)
  await expect(page.getByTestId('org-threads-empty')).toHaveCount(0)
  await shot(page, '0-default')
  // The folds under Done, each one line.
  await head(page, 'done').scrollIntoViewIfNeeded()
  await shot(page, '0-default-folds')

  // 2. A click opens a fold, its cards reading its word; a second click folds it.
  const want: Record<string, string[]> = { working: [ids.working], waiting: [ids.waiting, ids.snoozed].sort(), known: [ids.known], done: [ids.closed] }
  for (const g of ['working', 'waiting', 'known', 'done']) {
    await head(page, g).click()
    await expect(head(page, g)).toHaveAttribute('aria-expanded', 'true')
    const row = (await drawn(page)).find((x) => x.group === g)!
    expect([...row.cards].sort(), g).toEqual(want[g])
    for (const id of want[g]) await expect(group(page, g).locator(`[data-thread-id="${id}"]`).getByTestId('org-thread-state')).toHaveText(labels[g])
  }
  await expect(group(page, 'known').locator(`[data-thread-id="${ids.known}"]`).getByTestId('org-thread-ack-line')).toHaveText('AI is deciding where this goes.')
  await expect(group(page, 'waiting').locator(`[data-thread-id="${ids.snoozed}"]`).getByTestId('org-thread-snoozed-until')).toHaveText(/^Snoozed until \w/)
  await shot(page, '1-all-open')
  await head(page, 'known').click()
  await expect(group(page, 'known')).toHaveAttribute('data-open', 'false')
  await expect(group(page, 'known').getByTestId('org-thread')).toHaveCount(0)

  // Not kept: away from the Org page and back, every fold is folded again; a reload the same.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  await openLead(page)
  await expect.poll(async () => (await drawn(page)).map((g) => g.open), { timeout: 20_000 }).toEqual([true, true, false, false, false, false])
  expect((await shownIds(page)).sort()).toEqual([ids.needs, ids.read].sort())
  await head(page, 'working').click()
  await expect(group(page, 'working')).toHaveAttribute('data-open', 'true')
  // Another node on the Org page, then this one again: folded again.
  await page.locator(`[data-testid="org-channel"]:not([data-key="${rowKey(PROJECT)}"])`).first().click()
  await expect(page.getByTestId('org-detail')).not.toHaveAttribute('data-key', rowKey(PROJECT))
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect.poll(async () => (await drawn(page)).map((g) => g.open), { timeout: 20_000 }).toEqual([true, true, false, false, false, false])
  await head(page, 'working').click()
  await expect(group(page, 'working')).toHaveAttribute('data-open', 'true')
  await loadHome(page)
  await openLead(page)
  await expect.poll(async () => (await drawn(page)).map((g) => g.open), { timeout: 20_000 }).toEqual([true, true, false, false, false, false])

  // 3. ack_means_known off with nothing left in Acknowledged: no Acknowledged group.
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.known}`, { place: 'waiting', place_why: 'waits on the apples to ripen' }, ids.leadSid)
  const off = await request.put('/api/config', { data: { experimental: { ack_means_known: false } } })
  expect(off.ok(), await off.text()).toBe(true)
  await loadHome(page)
  await openLead(page)
  await expect.poll(async () => (await drawn(page)).map((g) => `${g.group} ${g.count}`), { timeout: 20_000 }).toEqual(['needs 1', 'read 1', 'working 1', 'waiting 3', 'done 1'])
  expect(pageErrors).toEqual([])
})

const note = (page: Page, id: string) => page.locator(`[data-testid="org-thread-move-note"][data-moved-id="${id}"]`)
const cardIn = (page: Page, g: string, id: string) => page.locator(`[data-testid="org-thread-group"][data-group="${g}"] [data-testid="org-thread"][data-thread-id="${id}"]`)
/** The test id of the element holding the focus, the line it is in, and the group whose head it is. */
const focusAt = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return {
    testId: el?.dataset.testid ?? el?.tagName ?? null,
    moved: el?.closest<HTMLElement>('[data-moved-id]')?.dataset.movedId ?? null,
    group: el?.dataset.testid === 'org-thread-group-head' ? el.closest<HTMLElement>('[data-group]')?.dataset.group ?? null : null,
  }
})
/** How far a card's top sits under the top of the pane that scrolls it (negative: above it). */
const gapUnderTop = (card: ReturnType<Page['locator']>) => card.evaluate((el) => {
  let s: HTMLElement | null = el.parentElement
  while (s && !(s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement
  return Math.round(el.getBoundingClientRect().top - (s ? s.getBoundingClientRect().top : 0))
})

test('a card that leaves Needs you or Done for a fold leaves a line; Show opens that group with the card in view', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  // Done long enough that Closed, below it, starts out of view.
  for (let i = 1; i <= 8; i++) await nodeThread(request, `Shelf ${i} is sorted ${STAMP}`)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const choice = cardIn(page, 'needs', ids.needs)
  await expect(choice).toBeVisible({ timeout: 20_000 })
  await expect(group(page, 'done')).toHaveAttribute('data-open', 'false')

  // 4a. His answer to the choice: the card leaves Needs you for Closed (folded), a line in its place.
  const answer = choice.getByTestId('org-thread-choice')
  await expect(answer.getByTestId('org-answer-option')).toHaveCount(2, { timeout: 15_000 })
  await answer.locator('[data-testid="org-answer-option"][data-value="may"]').click()
  const line = note(page, ids.needs)
  await expect(line).toBeVisible({ timeout: 20_000 })
  await expect(line).toHaveAttribute('data-to', 'done')
  await expect(line).toContainText('Moved to Closed')
  await expect(group(page, 'needs').getByTestId('org-thread-move-note')).toHaveCount(1)
  await expect(group(page, 'done')).toHaveAttribute('data-open', 'false')
  await shot(page, '4-moved-line')
  // Show: Closed opens, the card's top comes into view, marked.
  await line.getByTestId('org-thread-move-show').click()
  await expect(group(page, 'done')).toHaveAttribute('data-open', 'true')
  await expect(head(page, 'done')).toHaveAttribute('aria-expanded', 'true')
  const closedCard = cardIn(page, 'done', ids.needs)
  await expect(closedCard).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
  await expect(closedCard.getByTestId('org-thread-state')).toHaveText('Closed')
  await expect.poll(() => gapUnderTop(closedCard), { timeout: 5_000 }).toBeGreaterThanOrEqual(0)
  await expect(closedCard.getByTestId('org-thread-head')).toBeInViewport()
  await expect(line).toHaveCount(0)
  await shot(page, '4-shown')

  // 4b. The Done card snoozed with the keyboard: Enter on Snooze, then on 2h.
  const read = cardIn(page, 'read', ids.read)
  await read.getByTestId('org-thread-snooze').focus()
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('org-thread-snooze-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: '2h', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(read).toHaveCount(0)
  await expect(note(page, ids.read)).toContainText('Moved to Waiting / Snoozed')
  await expect.poll(() => focusAt(page)).toEqual({ testId: 'org-thread-move-show', moved: ids.read, group: null })
  // Enter on Show: Waiting / Snoozed opens, the card marked, the focus on that group's head.
  await page.keyboard.press('Enter')
  await expect(group(page, 'waiting')).toHaveAttribute('data-open', 'true')
  const back = cardIn(page, 'waiting', ids.read)
  await expect(back).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
  await expect(back.getByTestId('org-thread-snoozed-until')).toHaveText(/^Snoozed until (today|tomorrow), /)
  await expect.poll(() => focusAt(page)).toEqual({ testId: 'org-thread-group-head', moved: null, group: 'waiting' })
  // Unsnooze: back to Done, a line in Waiting (open) saying so.
  await back.getByTestId('org-thread-snooze').click()
  await menu.getByTestId('org-thread-snooze-clear').click()
  await expect(back).toHaveCount(0)
  await expect(note(page, ids.read)).toContainText('Moved to Done')
  await expect(cardIn(page, 'read', ids.read)).toBeVisible()
  // Left alone, the line fades and goes.
  await expect(note(page, ids.read)).toHaveCount(0, { timeout: 12_000 })
  expect(pageErrors).toEqual([])
})

test('a card that moved while the Threads were away leaves no line when they open again; one that moves on screen does', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const away = await nodeThread(request, `Stack the crates ${STAMP}`, 'working')
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await openFold(page, 'working')
  await expect(cardIn(page, 'working', away)).toBeVisible({ timeout: 20_000 })
  // He leaves the Org page; the card is snoozed while he is away (the node's own move). Nothing on
  // the page reads the lead's threads meanwhile, so the copy the pane opens on is the one from before.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  const reads = `**/api/v1/tasks/${ids.lead}/threads`
  await page.route(reads, (route) => (route.request().method() === 'GET' ? route.abort() : route.continue()))
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${away}`, { snooze: new Date(Date.now() + 86_400_000).toISOString() })
  await page.waitForTimeout(1_000)
  await page.unroute(reads)
  // Back: the folds start folded; opened, the move he never saw leaves no line.
  await openLead(page)
  await openFold(page, 'waiting')
  await openFold(page, 'working')
  await expect(cardIn(page, 'waiting', away)).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('org-thread-move-note')).toHaveCount(0)
  // The link drops while he looks; the card goes back to Working meanwhile: no line either.
  await page.context().setOffline(true)
  await page.waitForTimeout(1_500)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${away}`, { snooze: '' })
  await page.context().setOffline(false)
  await expect(cardIn(page, 'working', away)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('org-thread-move-note')).toHaveCount(0)
  // While he looks, the same card moves again (snoozed) out of the open Working: its line shows.
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${away}`, { snooze: new Date(Date.now() + 86_400_000).toISOString() })
  await expect(note(page, away)).toBeVisible({ timeout: 20_000 })
  await expect(note(page, away)).toContainText('Moved to Waiting / Snoozed')
  expect(pageErrors).toEqual([])
})

/** Where each folded head sits in the viewport, from the top of the pane that scrolls the Threads. */
const foldHeads = (page: Page) => page.getByTestId('org-thread-groups').evaluate((root) => {
  let s: HTMLElement | null = root.parentElement
  while (s && !/auto|scroll/.test(getComputedStyle(s).overflowY)) s = s.parentElement
  const port = s!.getBoundingClientRect()
  return [...root.querySelectorAll<HTMLElement>('section[data-testid="org-thread-group"][data-open="false"]')].map((sec) => {
    const r = sec.getBoundingClientRect()
    return { group: sec.dataset.group!, top: Math.round(r.top), bottom: Math.round(r.bottom), inPane: r.top >= port.top - 1 && r.bottom <= port.bottom + 1, portBottom: Math.round(port.bottom), scrolls: s!.scrollHeight > s!.clientHeight + 1 }
  })
})

test('with many long Done cards, every folded head is in view on arrival, stacked at the pane bottom, and a click opens it', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  // Done long enough to fill several screens: twelve cards, each a long summary.
  const long = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}: the rows were checked one by one, the broken stakes replaced, the ties loosened where the bark had grown over them.`).join('\n\n')
  for (let i = 1; i <= 12; i++) {
    const opened = await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title: `Bed ${i} is weeded ${STAMP}`, text: long, from: 'node', state: 'answered' }, ids.leadSid)
    expect(opened.thread.id).toBeTruthy()
  }
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await expect.poll(async () => (await drawn(page)).find((g) => g.group === 'read')?.cards.length ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(12)
  const folded = (await drawn(page)).filter((g) => !g.open).map((g) => g.group)
  expect(folded.length).toBeGreaterThanOrEqual(2)
  // On arrival (no scroll): the pane scrolls, yet every folded head is inside it, in order, stacked
  // with no gap at its bottom edge (the last folded group lowest).
  const heads = await foldHeads(page)
  expect(heads.map((h) => h.group)).toEqual(folded)
  expect(heads[0].scrolls, 'the Done cards overflow the pane').toBe(true)
  for (const h of heads) expect(h.inPane, `${h.group} head in the pane: ${JSON.stringify(h)}`).toBe(true)
  for (let i = 1; i < heads.length; i++) expect(Math.abs(heads[i].top - heads[i - 1].bottom), `${heads[i].group} sits right under ${heads[i - 1].group}`).toBeLessThanOrEqual(1)
  expect(heads.at(-1)!.portBottom - heads.at(-1)!.bottom).toBeLessThanOrEqual(1)
  for (const g of folded) await expect(head(page, g)).toBeInViewport()
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/thread-groups-7-stacked-folds-${test.info().project.name}.png` })
  // One click on a stacked head opens its group; its head goes to the top, its cards under it.
  const first = folded[0]
  await head(page, first).click()
  await expect(group(page, first)).toHaveAttribute('data-open', 'true')
  await expect(head(page, first)).toHaveAttribute('aria-expanded', 'true')
  await expect(group(page, first).getByTestId('org-thread').first()).toBeInViewport({ timeout: 5_000 })
  // An opened group scrolls with the list; the folds still folded keep their place at the bottom.
  await expect(group(page, first)).not.toHaveClass(/is-folded/)
  for (const h of await foldHeads(page)) expect(h.inPane, `${h.group} still in the pane`).toBe(true)
  await head(page, first).click()
  await expect(group(page, first)).toHaveAttribute('data-open', 'false')
  expect(pageErrors).toEqual([])
})

test('a long group stays one line until opened', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  for (let i = 0; i < 24; i++) await nodeThread(request, `Row ${i + 1} of the orchard ${STAMP}`, 'working')
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const working = group(page, 'working')
  await expect.poll(async () => Number(await working.getByTestId('org-thread-group-count').textContent()), { timeout: 20_000 }).toBeGreaterThanOrEqual(25)
  await expect(working.getByTestId('org-thread')).toHaveCount(0)
  // The open groups (Needs you and Done, whichever holds cards) lead the pane, the folds under them, in order.
  const order = ['needs', 'read', 'working', 'waiting', 'known', 'done', 'archived']
  const rows = await drawn(page)
  expect(rows.map((g) => g.group)).toEqual(order.filter((g) => rows.some((x) => x.group === g)))
  for (const g of rows) expect(g.open, g.group).toBe(g.group === 'needs' || g.group === 'read')
  await shot(page, '6-dense-default')
  await head(page, 'working').click()
  await expect.poll(async () => working.getByTestId('org-thread').count()).toBeGreaterThanOrEqual(25)
  await head(page, 'working').click()
  await expect(working.getByTestId('org-thread')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
