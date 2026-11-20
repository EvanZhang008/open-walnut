/**
 * A task's status in its session header follows the task store and never goes back to the old
 * status once it moved (2026-11-19: the header's kebab kept a private copy and took every task event
 * over the store's row; the write's own echo carries the status from before the server derived it
 * again, so the header read Needs you, then the old status for a moment, then Needs you).
 *
 * TaskQuickActions now draws the store's row whenever the store holds it, and its event handlers
 * only keep a private copy for a task the store does not hold (web/src/components/sessions/
 * TaskQuickActions.tsx `followsStore`).
 *
 * Scenario matrix (Home with the task's session column; its header's menu -> Status -> Needs you,
 * then the menu open again, its Status line read every frame):
 *  1. Set with the write held: the line reads Needs you inside INSTANT_MS with zero answers; from
 *     then to 2.5 s after the server answered (the write's echo, then the derived status), it
 *     reads Needs you in every frame.
 * The fixture is shared, so this file makes its own task and removes it.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const INSTANT_MS = 700
let id = ''
let sid = ''

test.setTimeout(150_000)

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const res = await request.post('/api/tasks', { data: { title: `Header status ${STAMP}`, project: `Header status ${STAMP}`, source: 'local' } })
  expect(res.ok(), await res.text()).toBe(true)
  id = ((await res.json()) as { task: { id: string } }).task.id
  const started = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: `snapshot-clean-turn:Header ready ${STAMP}`, taskId: id } })
  expect(started.ok(), await started.text()).toBe(true)
  sid = ((await started.json()) as { sessionId: string }).sessionId
  // Its turn is over: nothing running holds the status at Working.
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json()).session?.process_status ?? ''), { timeout: 90_000 }).not.toBe('running')
  // Back to Not started by hand, so Needs you is a move (a turn's end may have left it there).
  // The mock CLI's turn-end triage writes the summary (and may move the phase): after it.
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${id}`)).json()).task?.summary ?? ''), { timeout: 20_000 }).not.toBe('').catch(() => {})
  expect((await request.patch(`/api/tasks/${id}`, { data: { phase: 'TODO' } })).ok()).toBe(true)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status?.state ?? ''), { timeout: 30_000 }).toBe('waiting')
})

test.afterAll(async ({ request }) => {
  if (sid) await request.post(`/api/v1/sessions/${sid}/terminate`, { data: { force: true } }).catch(() => {})
  if (id) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

/** Every distinct label the header shows, in order, each frame from now on. */
async function watchLabel(page: Page, sel: string): Promise<() => Promise<string[]>> {
  await page.evaluate((s) => {
    const seen: string[] = []
    const w = window as unknown as { __headerSeen?: string[] }
    w.__headerSeen = seen
    const tick = () => {
      if (w.__headerSeen !== seen) return
      const now = document.querySelector(s)?.textContent ?? 'not drawn'
      if (seen[seen.length - 1] !== now) seen.push(now)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, sel)
  return () => page.evaluate(() => [...((window as unknown as { __headerSeen?: string[] }).__headerSeen ?? [])])
}

test('Needs you set from the header reads Needs you there and never the old status again', async ({ page }) => {
  await isolateUiPrefs(page)
  await seedColumns(page, [sid])
  await loadHome(page)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  // The header's own menu: its Status line reads the task's status (TaskQuickActions' copy).
  const kebab = panel.locator('.session-panel-header .task-kebab-btn').first()
  const valueSel = '.task-kebab-menu [data-testid="task-status-row"] .task-kebab-status-value b'
  const value = page.locator(valueSel).first()
  await kebab.click()
  await expect(value).toBeVisible({ timeout: 15_000 })
  const before = (await value.textContent()) ?? ''
  expect(before).not.toBe('Needs you')

  let sent = 0
  let answered = 0
  let open = false
  const held: Route[] = []
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    sent += 1
    if (open) { await route.continue(); answered += 1; return }
    held.push(route)
  })
  await page.getByTestId('task-status-toggle').click()
  await page.locator('.task-status-options [data-phase="NEED_ACTION"]').click()
  await expect.poll(() => sent, { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
  // The menu closed on the pick: open it again and keep it open through the server's answer.
  if (!(await value.isVisible())) await kebab.click()
  await expect(value).toHaveText('Needs you', { timeout: INSTANT_MS })
  expect(answered).toBe(0)
  const seen = await watchLabel(page, valueSel)

  await page.waitForTimeout(1_000)
  open = true
  for (const r of held.splice(0)) { await r.continue(); answered += 1 }
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/${id}`)).json()).task?.user_status?.state ?? ''), { timeout: 15_000 }).toBe('needs')
  await page.waitForTimeout(2_500)
  await expect(value).toHaveText('Needs you')
  expect(await seen(), 'the header went back to the old status after it moved').toEqual(['Needs you'])
})
