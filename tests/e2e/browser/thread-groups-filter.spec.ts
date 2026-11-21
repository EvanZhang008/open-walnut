/**
 * A node's Threads in the user's own groups, each chip a filter (experiment brief_off,
 * web/src/components/org/OrgThreadsByState.tsx, ThreadsFilterBar.tsx, src/core/org/thread-groups.ts;
 * 2026-11-20, the user: "No Need you, Done, waiting / snoozed, Acknowlegde, closed, archived", after
 * a click on Done still listed the Needs you cards).
 *
 * A lead with a thread in every group: Needs you (its Board's choice), Done (a result on its card),
 * Working, Waiting / Snoozed (one pending, one snoozed), Acknowledged (he acknowledged it, the AI
 * has not placed it yet: experiment ack_means_known) and Closed; Archived holds none (a thread is
 * archived a day after it closed: tests/core/org/thread-groups.test.ts).
 *  1. The chips are All and the seven groups, each with its count; All counts every group but Archived.
 *  2. Each chip shows only its group's cards, every one of them, and nothing else; Closed shows only
 *     the closed one, reading Closed; an empty group says so.
 *  3. The pick is kept: the page loaded again opens on the chip he left.
 *  4. With ack_means_known off and nothing in Acknowledged, there is no Acknowledged chip.
 *  5. Each card's state word is the group it is drawn under (a pending one reads Waiting / Snoozed).
 *     A card snoozed with the keyboard leaves Done: a line stands in its place ("Moved to
 *     Waiting / Snoozed", Show) and takes the focus; Show picks that chip and marks the card, which
 *     says until when; its menu offers Unsnooze, which brings it back (another line, the other way).
 *     Reopen in Closed leaves a line too; each line fades by itself.
 *  6. In a long group the chips stay at the top of the pane while it scrolls (sticky).
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

test('each chip shows only its own group, every card of it, and the pick is kept', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const want: Record<string, string[]> = {
    needs: [ids.needs], read: [ids.read], working: [ids.working], waiting: [ids.waiting, ids.snoozed].sort(), known: [ids.known], done: [ids.closed], archived: [],
  }
  await expect.poll(async () => (await shownCards(page)).all.length, { timeout: 20_000 }).toBe(7)

  // 1. All and the seven groups, in his words, each counted; All counts every group but Archived.
  await expect(page.getByTestId('org-threads-chip')).toHaveText(['All 7', 'Needs you 1', 'Done 1', 'Working 1', 'Waiting / Snoozed 2', 'Acknowledged 1', 'Closed 1', 'Archived 0'])
  const all = await shownCards(page)
  expect(Object.fromEntries(Object.entries(all.byGroup).map(([g, xs]) => [g, [...xs].sort()]))).toEqual(
    Object.fromEntries(Object.entries(want).filter(([, xs]) => xs.length)))
  await shot(page, '0-all')

  // 2. Each chip: only its group's cards, all of them, under its own head; the empty one says so.
  for (const g of ['needs', 'read', 'working', 'waiting', 'known', 'done', 'archived', 'all']) {
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
    if (g === 'known') {
      await expect(page.locator(`[data-thread-id="${ids.known}"]`).getByTestId('org-thread-state')).toHaveText('Acknowledged')
      await expect(page.locator(`[data-thread-id="${ids.known}"]`).getByTestId('org-thread-ack-line')).toHaveText('AI is deciding where this goes.')
    }
  }

  // 3. The pick is kept: Closed, then the page loaded again opens on Closed.
  await chip(page, 'done').click()
  await loadHome(page)
  await openLead(page)
  await expect(chip(page, 'done')).toHaveAttribute('aria-pressed', 'true')
  expect((await shownCards(page)).all).toEqual([ids.closed])
  await chip(page, 'all').click()

  // 4. ack_means_known off with nothing left in Acknowledged: no Acknowledged chip (today's chips).
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.known}`, { place: 'waiting', place_why: 'waits on the apples to ripen' }, ids.leadSid)
  const off = await request.put('/api/config', { data: { experimental: { ack_means_known: false } } })
  expect(off.ok(), await off.text()).toBe(true)
  await loadHome(page)
  await openLead(page)
  await expect(page.getByTestId('org-threads-chip')).toHaveText(['All 7', 'Needs you 1', 'Done 1', 'Working 1', 'Waiting / Snoozed 3', 'Closed 1', 'Archived 0'])
  expect(pageErrors).toEqual([])
})

const note = (page: Page, id: string) => page.locator(`[data-testid="org-thread-move-note"][data-moved-id="${id}"]`)
const cardIn = (page: Page, g: string, id: string) => page.locator(`[data-testid="org-thread-group"][data-group="${g}"] [data-testid="org-thread"][data-thread-id="${id}"]`)
/** The test id of the element holding the focus, and the line it is in. */
const focusAt = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return { testId: el?.dataset.testid ?? el?.tagName ?? null, moved: el?.closest<HTMLElement>('[data-moved-id]')?.dataset.movedId ?? null }
})

test('a card says its group, and a card that moves leaves a line in its place with Show', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await chip(page, 'all').click()
  await expect.poll(async () => (await shownCards(page)).all.length, { timeout: 20_000 }).toBe(7)

  // 5a. Every card's word is the label of the group it is drawn under.
  const labels: Record<string, string> = { needs: 'Needs you', read: 'Done', working: 'Working', waiting: 'Waiting / Snoozed', known: 'Acknowledged', done: 'Closed', archived: 'Archived' }
  const words = await page.getByTestId('org-thread-groups').evaluate((root) => [...root.querySelectorAll<HTMLElement>('section[data-testid="org-thread-group"]')].flatMap((sec) =>
    [...sec.querySelectorAll<HTMLElement>('[data-testid="org-thread-state"]')].map((w) => ({ group: sec.dataset.group!, word: w.textContent?.trim() ?? '' }))))
  expect(words.length).toBeGreaterThanOrEqual(5)
  for (const w of words) expect(w.word, w.group).toBe(labels[w.group])
  await expect(cardIn(page, 'waiting', ids.waiting).getByTestId('org-thread-state')).toHaveText('Waiting / Snoozed')
  // The one snoozed before says until when; its button reads Snoozed.
  const snoozed = cardIn(page, 'waiting', ids.snoozed)
  await expect(snoozed.getByTestId('org-thread-snoozed-until')).toHaveText(/^Snoozed until \w/)
  await expect(snoozed.getByTestId('org-thread-snooze')).toHaveText(/^Snoozed/)

  // 5b. Done picked; the result is snoozed with the keyboard: Enter on Snooze, then on 2h.
  await chip(page, 'read').click()
  const read = cardIn(page, 'read', ids.read)
  await expect(read).toBeVisible()
  await read.getByTestId('org-thread-snooze').focus()
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('org-thread-snooze-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('org-thread-snooze-clear')).toHaveCount(0)
  await menu.getByRole('button', { name: '2h', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  // It left Done: a line in its place names where it went, and holds the focus (never the page).
  await expect(read).toHaveCount(0)
  await expect(note(page, ids.read)).toContainText('Moved to Waiting / Snoozed')
  await expect.poll(() => focusAt(page)).toEqual({ testId: 'org-thread-move-show', moved: ids.read })
  await shot(page, '5-moved-line')
  // Show picks Waiting / Snoozed and marks the card, which says until when.
  await page.keyboard.press('Enter')
  await expect(chip(page, 'waiting')).toHaveAttribute('aria-pressed', 'true')
  const back = cardIn(page, 'waiting', ids.read)
  await expect(back).toBeVisible()
  await expect(back).toHaveAttribute('data-focused', 'true')
  await expect(back.getByTestId('org-thread-state')).toHaveText('Waiting / Snoozed')
  await expect(back.getByTestId('org-thread-snoozed-until')).toHaveText(/^Snoozed until (today|tomorrow), /)
  await expect(back.getByTestId('org-thread-unsnooze')).toBeVisible()
  await shot(page, '5-snoozed-card')
  // Its menu opens on that time, with Unsnooze; a keyboard Unsnooze sends it back to Done.
  await back.getByTestId('org-thread-snooze').click()
  await expect(menu.getByTestId('org-thread-snooze-current')).toHaveText(/^Snoozed until (today|tomorrow), /)
  await shot(page, '5-snoozed-menu')
  await menu.getByTestId('org-thread-snooze-clear').focus()
  await page.keyboard.press('Enter')
  await expect(back).toHaveCount(0)
  await expect(note(page, ids.read)).toContainText('Moved to Done')
  await expect.poll(() => focusAt(page)).toEqual({ testId: 'org-thread-move-show', moved: ids.read })
  await expect.poll(async () => {
    const r = await page.request.get(`/api/v1/tasks/${ids.lead}/threads/${ids.read}`)
    return ((await r.json()) as { thread?: { snoozed?: unknown } }).thread?.snoozed ?? null
  }, { timeout: 15_000 }).toBeNull()

  // 5c. Reopen in Closed: the line says where it went, and Show finds it there.
  await chip(page, 'done').click()
  await expect(note(page, ids.read)).toHaveCount(0)
  await cardIn(page, 'done', ids.closed).getByTestId('org-thread-reopen').click()
  const line = note(page, ids.closed)
  await expect(line).toBeVisible()
  const to = (await line.getAttribute('data-to'))!
  expect(['read', 'working', 'waiting', 'needs']).toContain(to)
  await expect(line).toContainText(`Moved to ${labels[to]}`)
  await expect(page.locator('[data-testid="org-thread-group-empty"][data-group="done"]')).toHaveCount(0)
  await shot(page, '5-reopened-line')
  // Left alone, it fades and goes.
  await expect(line).toHaveCount(0, { timeout: 12_000 })
  await expect(page.locator('[data-testid="org-thread-group-empty"][data-group="done"]')).toHaveText('Nothing in Closed.')
  await chip(page, to).click()
  await expect(cardIn(page, to, ids.closed).getByTestId('org-thread-state')).toHaveText(labels[to])
  await chip(page, 'all').click()
  expect(pageErrors).toEqual([])
})

test('a card that moved while the Threads were away leaves no line when they open again; one that moves on screen does', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const away = await nodeThread(request, `Stack the crates ${STAMP}`, 'working')
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await chip(page, 'all').click()
  await expect(cardIn(page, 'working', away)).toBeVisible({ timeout: 20_000 })
  // He leaves the Org page; the card is snoozed while he is away (the node's own move). Nothing on
  // the page reads the lead's threads meanwhile (a surface still open, say its chat's top, would
  // keep the copy fresh), so the copy the pane opens on is the one from before.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  const reads = `**/api/v1/tasks/${ids.lead}/threads`
  await page.route(reads, (route) => (route.request().method() === 'GET' ? route.abort() : route.continue()))
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${away}`, { snooze: new Date(Date.now() + 86_400_000).toISOString() })
  await page.waitForTimeout(1_000)
  await page.unroute(reads)
  // Back: the pane opens on its old copy, its first read brings the move he never saw: no line.
  await openLead(page)
  await expect(cardIn(page, 'waiting', away)).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('org-thread-move-note')).toHaveCount(0)
  // The link drops while he looks (a laptop lid, a network change); the card goes back to Working
  // meanwhile. The read after the reconnect brings it: he never saw it move, so no line either.
  await page.context().setOffline(true)
  await page.waitForTimeout(1_500)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${away}`, { snooze: '' })
  await page.context().setOffline(false)
  await expect(cardIn(page, 'working', away)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('org-thread-move-note')).toHaveCount(0)
  // While he looks, the same card moves again (snoozed): that one leaves its line.
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${away}`, { snooze: new Date(Date.now() + 86_400_000).toISOString() })
  await expect(note(page, away)).toBeVisible({ timeout: 20_000 })
  await expect(note(page, away)).toContainText('Moved to Waiting / Snoozed')
  expect(pageErrors).toEqual([])
})

test('in a long group the chips stay at the top of the pane while it scrolls', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  for (let i = 0; i < 24; i++) await nodeThread(request, `Row ${i + 1} of the orchard ${STAMP}`, 'working')
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  await chip(page, 'working').click()
  await expect.poll(async () => (await shownCards(page)).all.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(25)
  const bar = page.getByTestId('org-threads-filter')
  const scrolled = await bar.evaluate((el) => {
    let s: HTMLElement | null = el.parentElement
    while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement
    if (!s) return null
    s.scrollTop += 1200
    return { top: s.getBoundingClientRect().top, scrollTop: s.scrollTop }
  })
  expect(scrolled, 'the Threads pane scrolls').not.toBeNull()
  expect(scrolled!.scrollTop).toBeGreaterThan(1000)
  await page.waitForTimeout(200)
  const box = (await bar.boundingBox())!
  expect(Math.abs(box.y - scrolled!.top)).toBeLessThanOrEqual(2)
  // Nothing covers it: the chip at its own place is the topmost element there.
  const hit = await chip(page, 'all').evaluate((el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-testid="org-threads-chip"]') === el })
  expect(hit).toBe(true)
  await shot(page, '6-sticky')
  // A chip picked from there works.
  await chip(page, 'needs').click()
  expect((await shownCards(page)).all).toEqual([ids.needs])
  await chip(page, 'all').click()
  expect(pageErrors).toEqual([])
})
