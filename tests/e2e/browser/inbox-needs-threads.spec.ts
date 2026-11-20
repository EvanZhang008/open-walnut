/**
 * The inbox leads with every thread that needs him, each the same card as in Threads (experiment
 * inbox_needs_threads, web/src/components/inbox/InboxNeedsThreads.tsx; the one card is
 * threads_one_card's, on for this spec).
 *
 *  1. A lead's session opens a thread waiting on him with two choices, the recommended one second.
 *  2. In the notification center's Inbox, the thread is a card above the letters, from that lead,
 *     with its choices as buttons (the recommended one first) and its reply box.
 *  0. With the experiment off the inbox is its letters only, as before.
 *  3. He clicks the recommended one: it is his answer, filed under the thread through the lead's
 *     chat, and the card leaves the inbox; on the lead's Threads (Org page) it is no longer open
 *     for him either.
 *  4. Split layout with many threads: the threads are a band of their own that the wheel scrolls to
 *     its last card, and the letters keep their room below it (2026-11-20: the band took the whole
 *     pane, which does not scroll, so the later cards and every letter were out of reach).
 * The fixture is shared: this file makes its own project and tasks, and puts the flags back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Needs inbox ${STAMP}`
const TITLE = `Open the orchard to visitors this spring? ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', thread: '' }
const was: Record<string, boolean> = {}
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const FLAGS = ['inbox_needs_threads', 'threads_one_card'] as const

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

interface Thread { id: string; state: string; messages: Array<{ text: string; via: string }> }

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function setFlags(request: APIRequestContext, values: Record<string, boolean>): Promise<void> {
  const res = await request.put('/api/config', { data: { experimental: values } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function leadThread(request: APIRequestContext): Promise<Thread | undefined> {
  const res = await request.get(`/api/v1/tasks/${ids.lead}/threads`)
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { threads: Thread[] }).threads.find((t) => t.id === ids.thread)
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

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/inbox-needs-threads-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  for (const f of FLAGS) was[f] = cfg.config?.experimental?.[f] === true
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Prune the rows ${STAMP}`, `Paint the gate ${STAMP}`]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  await setFlags(request, { inbox_needs_threads: true, threads_one_card: true })
  // The lead's session hands him a decision, as its thread_create op does: the recommended choice second.
  ids.thread = (await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads/open`, {
    title: TITLE, text: 'The paths are dry now; the gate needs one more coat first.', from: 'node',
    options: [{ id: 'closed', label: 'Keep it closed' }, { id: 'open', label: 'Open it', recommended: true }],
    user_kind: 'user_own', user_kind_why: 'He asked to decide who visits the orchard',
  }, ids.leadSid)).thread.id
})

test.afterAll(async ({ request }) => {
  await setFlags(request, Object.fromEntries(FLAGS.map((f) => [f, was[f] ?? false])))
  for (const id of made) await removeTask(request, id)
})

test('off: the inbox shows its letters only, as before, while the thread still waits on him', async ({ page, request }) => {
  await setFlags(request, { inbox_needs_threads: false })
  try {
    await isolateUiPrefs(page)
    await loadHome(page)
    await page.getByRole('button', { name: 'Notifications' }).click()
    const panel = page.locator('.notification-panel')
    await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
    await expect(panel.locator('.hib-inbox-columns')).toBeVisible()
    await expect(panel.getByTestId('inbox-needs')).toHaveCount(0)
    expect((await leadThread(request))?.state).toBe('needs')
  } finally {
    await setFlags(request, { inbox_needs_threads: true })
  }
})

test('the inbox leads with the thread that needs him; the recommended choice answers it, and it leaves the inbox and the lead\'s Threads', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)

  // 1. The Inbox: the thread is a card above the letters, from the lead.
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  const section = panel.getByTestId('inbox-needs')
  const item = section.locator(`[data-testid="inbox-needs-item"][data-thread-id="${ids.thread}"]`)
  await expect(item).toBeVisible({ timeout: 30_000 })
  await expect(item).toHaveAttribute('data-node', ids.lead)
  // The needs section comes before the letters.
  expect(await panel.locator('[data-testid="inbox-needs"] ~ .hib-inbox-columns').count()).toBe(1)
  const card = item.getByTestId('org-thread')
  await expect(card).toHaveAttribute('data-state', 'needs')
  await expect(card.getByTestId('org-thread-title')).toHaveText(TITLE)
  // 2. Its choices, the recommended one first, and the reply box that is always there; no Acknowledge.
  const options = card.getByTestId('org-answer-option')
  await expect(options).toHaveText(['Open it', 'Keep it closed'], { timeout: 15_000 })
  await expect(options.first()).toHaveAttribute('data-recommended', 'true')
  await expect(card.getByTestId('org-thread-ack')).toHaveCount(0)
  await expect(card.locator('textarea')).toHaveCount(1)
  fs.mkdirSync(SHOTS, { recursive: true })
  await item.screenshot({ path: `${SHOTS}/inbox-needs-threads-1-card-${test.info().project.name}.png` })
  await shot(page, '1-inbox')

  // The Inbox rail and the bell count it (each thing once).
  const inboxBtn = panel.locator('.nfc-rail-btn', { hasText: 'Inbox' })
  const badge = inboxBtn.locator('.nfc-rail-badge')
  const railCount = async () => ((await badge.count()) ? Number(await badge.textContent()) : 0)
  const before = await railCount()
  expect(before).toBeGreaterThanOrEqual(1)

  // 3. He clicks the recommended one: filed under the thread as his reply, through the lead's chat.
  await options.first().click()
  await expect(item).toHaveCount(0, { timeout: 30_000 })
  // Its count goes with it at once, not at the list's next read.
  await expect.poll(railCount, { timeout: 5_000 }).toBe(before - 1)
  await expect.poll(async () => (await leadThread(request))?.messages.map((m) => m.text) ?? [], { timeout: 15_000 }).toContain('Open it')
  expect((await leadThread(request))?.state).not.toBe('needs')
  await shot(page, '2-answered')

  // The lead's Threads (Org page): no longer open for him.
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect(detail.getByTestId('org-threads')).toBeVisible()
  await expect(detail.locator(`[data-testid="org-thread-list"][data-show="open"] [data-testid="org-thread"][data-thread-id="${ids.thread}"]`)).toHaveCount(0)
  await shot(page, '3-lead-threads')
  expect(pageErrors).toEqual([])
})

test('split layout with many threads: the wheel reaches the last card, and the letters keep their room', async ({ page, request }) => {
  const extra: string[] = []
  for (let i = 0; i < 9; i++) {
    extra.push((await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads/open`, {
      title: `Row ${i + 1} of the orchard: prune now or after the frost? ${STAMP}`, text: 'Either is fine for the trees; the frost date decides it.', from: 'node',
      options: [{ id: 'now', label: 'Prune now', recommended: true }, { id: 'later', label: 'After the frost' }],
      user_kind: 'user_own', user_kind_why: 'He asked to decide the pruning',
    }, ids.leadSid)).thread.id)
  }
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  await panel.getByRole('button', { name: 'Split' }).click()
  const pane = panel.locator('.hib-inbox-pane')
  await expect(pane).toHaveAttribute('data-layout', 'split')
  const band = pane.getByTestId('inbox-needs')
  // The last card in the band's own order (most urgent first, then the longest waiting).
  const last = band.getByTestId('inbox-needs-item').last()
  await expect(band.getByTestId('inbox-needs-item')).toHaveCount(extra.length, { timeout: 30_000 })
  // The letters and the reader keep their room under the band.
  const columns = await pane.locator('.hib-inbox-columns').boundingBox()
  const paneBox = await pane.boundingBox()
  expect(columns!.height).toBeGreaterThanOrEqual(150)
  expect(columns!.y + columns!.height).toBeLessThanOrEqual(paneBox!.y + paneBox!.height + 1)
  // A real wheel over the band scrolls it until its last card shows (no programmatic scroll).
  const box = (await band.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120))
  for (let i = 0; i < 40 && !(await last.evaluate((el) => {
    const r = el.getBoundingClientRect(); const b = el.closest('[data-testid="inbox-needs"]')!.getBoundingClientRect()
    return r.top >= b.top && r.top < b.bottom
  })); i++) await page.mouse.wheel(0, 400)
  expect(await band.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await last.evaluate((el) => {
    const r = el.getBoundingClientRect(); const b = el.closest('[data-testid="inbox-needs"]')!.getBoundingClientRect()
    return r.top >= b.top && r.top < b.bottom
  })).toBe(true)
  await shot(page, '4-split-scrolled')
})
