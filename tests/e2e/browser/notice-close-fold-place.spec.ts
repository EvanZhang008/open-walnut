/**
 * A close that folds keeps its place (2026-11-27, a review of the one × on the user's data):
 *  1. A Threads card folded by its × while the pointer is on it becomes its one line in the same
 *     place: the list keeps no room at its top (folding the first card had left 728px of blank
 *     above the list) and the card below moves up under the line (useScrollAnchor followRedrawn).
 *  2. At a phone's size, Show on the strip's one line above a chat opens its card in the top's
 *     share of the chat: the question never leaves the page (the room's fit folded a lone strip
 *     away at "snug", so Show left the top empty), and the composer stays in sight.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { pinPageFlags } from './page-flags'
import { discoverBrowserFixture } from './codex-test-audit'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const made: string[] = []

test.setTimeout(240_000)
test.use({ viewport: { width: 1512, height: 920 } })

test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

async function call<T>(request: APIRequestContext, method: 'post' | 'patch' | 'put', url: string, data: unknown): Promise<T> {
  const res = await request[method](url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

/** A task with Threads on and a session (a mock CLI turn). */
async function threadsTask(request: APIRequestContext, title: string): Promise<{ taskId: string; sid: string }> {
  if (TEST_PORT === 3456) throw new Error('These checks write tasks: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const { task } = await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: title, source: 'local' })
  made.push(task.id)
  await call(request, 'patch', `/api/tasks/${task.id}`, { threads_on: true })
  await call(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: task.id })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${task.id}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  // Its turn done first: a turn ending later writes the task's report over one written before it.
  await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ role?: string }> }).messages?.some((m) => m.role === 'assistant') ?? false, { timeout: 90_000 }).toBe(true)
  await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).task?.user_status?.now ?? '', { timeout: 30_000 }).not.toBe('')
  return { taskId: task.id, sid }
}

const panelOf = (page: Page, sid: string) => page.locator(`.session-panel[data-session-id="${sid}"]`).first()

test('a Threads card folded by its × becomes its one line in the same place, with no room left above the list', async ({ page, request }) => {
  const s = stamp()
  const { taskId, sid } = await threadsTask(request, `Fold place ${s}`)
  for (let n = 1; n <= 4; n++) {
    const { thread } = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${taskId}/threads`, { text: `How is bed ${n} doing ${s}?` })
    const reply = Array.from({ length: 6 }, (_, i) => `Bed ${n}, check ${i + 1}: the soil is moist and the netting holds against the birds.`).join('\n')
    await call(request, 'patch', `/api/v1/tasks/${taskId}/threads/${thread.id}`, { title: `Garden bed ${n} ${s}`, reply, state: 'answered' })
  }
  await isolateUiPrefs(page)
  await seedColumns(page, [sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  const chip = panel.getByTestId('session-threads-chip')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
  const pane = panel.getByTestId('session-threads-pane')
  const cards = pane.locator('[data-testid="org-thread"]')
  await expect(cards).toHaveCount(4, { timeout: 30_000 })
  const body = pane.locator('.session-threads-body')
  const pad = () => body.evaluate((el) => getComputedStyle(el).paddingTop)
  const padBefore = await pad()

  for (let round = 0; round < 2; round++) {
    const first = cards.first()
    const id = (await first.getAttribute('data-thread-id'))!
    const before = (await first.boundingBox())!
    // The pointer on the card he reads, as a person clicking its ×.
    await first.hover({ position: { x: 40, y: 20 } })
    await first.getByTestId('org-thread-close').click()
    const line = pane.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
    await expect(line.getByTestId('org-thread-show')).toBeVisible()
    await page.waitForTimeout(400)
    expect(Math.abs((await line.boundingBox())!.y - before.y), 'the folded line stands where the card stood').toBeLessThanOrEqual(2)
    expect(await pad(), 'no room is kept above the list').toBe(padBefore)
    // The card below comes up right under the line.
    const next = (await cards.nth(1).boundingBox())!
    const lineBox = (await line.boundingBox())!
    expect(next.y - (lineBox.y + lineBox.height)).toBeLessThan(24)
    // Show opens it in the same place again.
    await line.getByTestId('org-thread-show').click()
    await expect(line.getByTestId('org-thread-close')).toBeVisible()
    await page.waitForTimeout(400)
    expect(Math.abs((await line.boundingBox())!.y - before.y)).toBeLessThanOrEqual(2)
    expect(await pad()).toBe(padBefore)
  }
})

test('at a phone\'s size, Show on the strip\'s one line opens its card above the chat, and the composer stays in sight', async ({ page, request }) => {
  const s = stamp()
  const { taskId, sid } = await threadsTask(request, `Phone strip ${s}`)
  const ask = `Which camera design should the chat use, A, B, C or D, given everything above ${s}?`
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await call(request, 'put', `/api/v1/tasks/${taskId}/report`, {
    state: 'needs', ask, ask_kind: 'single',
    ask_options: ['A: the + menu opens the camera over the composer', 'B: a full-screen camera', 'C: a small window that stays open', 'D: the system camera only'].map((label, i) => ({ label, recommended: i === 0 })),
  })
  await expect.poll(async () => {
    const st = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status as { actions?: Array<{ kind: string; summary: string }> } | undefined
    return st?.actions?.find((a) => a.kind === 'ask')?.summary ?? ''
  }, { timeout: 60_000 }).toBe(ask)
  await page.setViewportSize({ width: 390, height: 844 })
  await isolateUiPrefs(page)
  await pinPageFlags(page, ['action_needed_everywhere', 'top_thread'])
  await seedColumns(page, [sid])
  await loadHome(page)
  const panel = panelOf(page, sid)
  if (!(await panel.isVisible().catch(() => false))) await page.getByText(`Phone strip ${s}`).first().click()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const top = panel.getByTestId('session-top')
  await expect(top).toBeVisible({ timeout: 30_000 })
  // Fold it first when it shows open, then open it from its line: the case the review found.
  const hide = top.getByTestId('action-strip-hide')
  if (await hide.isVisible().catch(() => false)) await hide.click()
  const show = top.getByTestId('action-strip-show')
  await expect(show).toBeVisible()
  await show.click()
  const card = panel.getByTestId('session-action-needed')
  await expect(card).toBeVisible()
  await expect(card.locator('[data-testid="action-item"][data-kind="ask"]')).toBeVisible()
  const box = (await top.boundingBox())!
  expect(box.height, 'the top holds the card').toBeGreaterThan(44)
  const input = panel.locator('.session-panel-input textarea').first()
  await expect(input).toBeVisible()
  const field = (await input.boundingBox())!
  expect(box.y + box.height, 'the card ends above the composer').toBeLessThanOrEqual(field.y)
  expect(field.y + field.height).toBeLessThanOrEqual(844)
  await page.screenshot({ path: test.info().outputPath('phone-strip-shown.png') })
  // Nothing spills out of the top over the chat's first line.
  const strip = (await card.boundingBox())!
  expect(strip.y + strip.height, 'the card ends inside the top').toBeLessThanOrEqual(box.y + box.height + 1)
  // The question's first line keeps clear of its × (a finger-sized one on the phone).
  const clear = await card.evaluate((el) => {
    const x = el.querySelector('.ask-card-close')!.getBoundingClientRect()
    const line = el.querySelector('.ask-card-close + :is(.ask-card-title, .ask-card-question)') as HTMLElement
    const r = line.getBoundingClientRect()
    return { textEnd: r.right - parseFloat(getComputedStyle(line).paddingRight), closeStart: x.left }
  })
  expect(clear.textEnd, 'the words end before the ×').toBeLessThanOrEqual(clear.closeStart + 1)
  // Its × folds it back to the line.
  await card.getByTestId('action-strip-hide').click()
  await expect(show).toBeVisible()
})
