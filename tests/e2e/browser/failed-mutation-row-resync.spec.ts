/**
 * A mutation the server refuses undoes its own row and nothing else.
 *
 * Before: every failed request made the home board refetch the WHOLE list
 * (`GET /api/tasks?fields=list`, ~6.5k rows on a real board, a 5MB response
 * parsed on the browser's main thread), so a request that kept failing kept the
 * server serializing the board and the browser re-rendering it: eight full
 * fetches in 30s from two windows during the 2026-09-28 dictation incident.
 *
 * Now the board re-reads the touched rows only (`GET /api/tasks?fields=list&ids=…`),
 * the optimistic change is reverted from that answer, and the "Action failed"
 * toast still tells the user. Pinned through the real UI in both engines: the
 * complete toggle is the most common one-click mutation.
 */
import { test, expect, type Page } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/failed-mutation-row-resync'

async function createTaskViaApi(title: string): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local' }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { task: { id: string; title: string } }).task
}

/** Count list-shaped GETs: the whole list vs the ids-only re-read. */
function watchListRequests(page: Page): { whole: () => number; byIds: () => string[] } {
  let whole = 0
  const byIds: string[] = []
  page.on('request', (req) => {
    if (req.method() !== 'GET') return
    const url = new URL(req.url())
    if (url.pathname !== '/api/tasks') return
    if (url.searchParams.has('ids')) byIds.push(url.searchParams.get('ids') ?? '')
    else whole += 1
  })
  return { whole: () => whole, byIds: () => byIds }
}

test('a refused complete toggle re-reads that row only and reverts it', async ({ page }) => {
  const task = await createTaskViaApi('Refused toggle')

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  // The fixture files a new task where its board rules put it (a pinned tier
  // card or a list row); both carry the same complete toggle.
  const row = page.locator('.todo-panel-item, .todo-pinned-card, .todo-focus-card', { hasText: task.title }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })

  // The server refuses the toggle. A 4xx is not retried by the client.
  await page.route(`**/api/tasks/${task.id}/toggle*`, (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused by test' }) }))
  await page.route(`**/api/tasks/${task.id}`, (route) => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused by test' }) })
    }
    return route.continue()
  })

  const requests = watchListRequests(page)
  await row.getByRole('button', { name: 'Mark complete' }).click()

  // The toast says so, the row comes back as To Do, and the only list-shaped
  // request was the ids re-read for this one task.
  await expect(page.locator('.notification-toast--error', { hasText: 'Action failed' })).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => requests.byIds(), { timeout: 10_000 }).toContain(task.id)
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).not.toHaveClass(/-done\b/)
  await expect(row.getByRole('button', { name: 'Mark complete' })).toBeVisible()
  expect(requests.whole()).toBe(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/reverted-row-${test.info().project.name}.png` })

  // Server truth agrees: still open.
  const res = await fetch(`${API}/api/tasks/${task.id}`)
  const body = (await res.json()) as { task: { status: string } }
  expect(body.task.status).not.toBe('done')
})

test('the ids re-read answers the same rows the list would', async () => {
  const a = await createTaskViaApi('Ids read a')
  const b = await createTaskViaApi('Ids read b')
  const res = await fetch(`${API}/api/tasks?fields=list&ids=${a.id},${b.id},no-such-id`)
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { tasks: Array<{ id: string; title: string; has_note?: boolean; note?: string }> }
  expect(body.tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
  // Minimal projection: presence flags, no bodies.
  expect(body.tasks.every((t) => typeof t.has_note === 'boolean' && !('note' in t))).toBe(true)
})
