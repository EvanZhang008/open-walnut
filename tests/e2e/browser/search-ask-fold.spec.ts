/**
 * A search hit's ask, folded (web/src/components/tasks/SearchAskLine.tsx; 2026-11-21 UI audit, and
 * the 2026-11-22 review of it):
 *   - folded, the line shows the question in full (a title, never cut) beside an Answer button, a
 *     real <button> with the shared tool look, and no card;
 *   - opened, the card shows the question itself, so the line no longer repeats it;
 *   - what the user did in the card and has not sent (a multiple choice's ticks) survives a fold and
 *     a reopen: the card stays mounted and is only hidden.
 * Real: the fixture server, the mock CLI's session, the task report route that shapes the ask.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Search ask fold ${STAMP}`
const made: string[] = []
let taskId = ''
let sessionId = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ viewport: { width: 1280, height: 900 } })

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function historyText(request: APIRequestContext, sid: string): Promise<string> {
  const res = await request.get(`/api/v1/sessions/${sid}/history?tail=80`)
  if (!res.ok()) return ''
  const body = (await res.json()) as { messages?: Array<{ text?: string }> }
  return (body.messages ?? []).map((m) => m.text ?? '').join('\n')
}

test.beforeAll(async ({ request }) => {
  if (TEST_PORT === 3456) throw new Error('This spec writes a task: run it on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Rollout hosts ${STAMP}`, project: PROJECT, source: 'local' })
  taskId = task.id
  made.push(taskId)
  ;({ sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Hosts ready ${STAMP}`, taskId }))
  await expect.poll(() => historyText(request, sessionId), { timeout: 60_000 }).toContain(`I processed your message: Hosts ready ${STAMP}`)
  const res = await request.put(`/api/v1/tasks/${taskId}/report`, {
    data: { state: 'needs', ask: `Which hosts get it first ${STAMP}?`, ask_kind: 'multi', ask_options: [{ id: 'mac', label: 'Mac' }, { id: 'dev', label: 'Dev box' }, { id: 'cloud', label: 'Cloud companion' }] },
  })
  expect(res.ok(), await res.text()).toBe(true)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status?.actions ?? []).length, { timeout: 30_000 }).toBeGreaterThan(0)
})

test.afterAll(async ({ request }) => {
  if (sessionId) await request.post(`/api/v1/sessions/${sessionId}/terminate`, { data: { force: true } })
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('a folded ask shows its whole question beside a real button, and a tick survives a fold and a reopen', async ({ page }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  const panel = page.locator('.todo-panel')
  const search = panel.locator('.todo-search-input')
  await search.click()
  await search.pressSequentially(STAMP, { delay: 30 })
  const line = panel.locator(`[data-asks-for="${taskId}"] [data-testid="search-ask-line"]`)
  await expect(line).toBeVisible({ timeout: 30_000 })

  // Folded: the question in full, as a title, beside a real button; no card yet.
  const summary = line.getByTestId('search-ask-summary')
  const toggle = line.getByTestId('search-ask-toggle')
  await expect(summary).toContainText(`Which hosts get it first ${STAMP}?`)
  await expect(summary).toHaveClass(/\bwn-title\b/)
  expect(await summary.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the question is never cut').toBe(true)
  expect(await toggle.evaluate((el) => el.tagName)).toBe('BUTTON')
  await expect(toggle).toHaveClass(/\bbtn\b.*\bbtn-ghost\b/)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(line.locator('[role="button"]')).toHaveCount(0)
  await expect(line.getByTestId('org-answer-check')).toHaveCount(0)

  // Opened: the card, and the line no longer repeats the question.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(summary).toHaveCount(0)
  const mac = line.locator('[data-testid="org-answer-check"][data-value="mac"]')
  await expect(mac).toBeVisible()
  await mac.click()
  await expect(mac).toHaveClass(/\bis-on\b/)
  await expect(line.getByTestId('org-answer-send-picked')).toHaveText('Send 1')
  await page.screenshot({ path: `test-results/search-ask-fold-open-${test.info().project.name}.png` })

  // Folded again: the card is hidden, not gone; the question is back.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(mac).toBeHidden()
  await expect(summary).toBeVisible()

  // Reopened: the tick is still there.
  await toggle.click()
  await expect(mac).toBeVisible()
  await expect(mac).toHaveClass(/\bis-on\b/)
  await expect(line.getByTestId('org-answer-send-picked')).toHaveText('Send 1')
})
