/**
 * The served build retries a failed read quietly; a test browser does not, unless a spec asks.
 *
 * Test browsers start with the web client's quiet retry off (pw-quiet-retry.ts), so a spec
 * that fails a request once sees that failure. This spec proves both sides on the AI search
 * lane (a GET): off, one 502 shows the error and its Retry; on (`quietRetriesOn`, as in a
 * person's browser), the same 502 is sent again and the answer shows with no error.
 */
import { expect, test, type Page } from '@playwright/test'
import { quietRetriesOn } from './pw-quiet-retry'

const TASK_ID = 'pw-task-001'
const QUERY = 'which task adds docx support'
const PAYLOAD = {
  summary: 'One task.',
  results: [{ taskId: TASK_ID, title: 'Playwright test task', phase: 'TODO', project: 'pw-fixtures', evidence: 'docx preview', confidence: 'high' }],
  model: 'haiku', tookMs: 10, cached: false,
}

test.describe.configure({ mode: 'serial' })

/** The AI lane fails its first call with a 502, then answers; the instant lane returns nothing. */
async function failFirstAgentSearch(page: Page): Promise<{ calls: number }> {
  const stub = { calls: 0 }
  await page.route('**/api/search?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) }))
  await page.route('**/api/search/agent**', async (route) => {
    stub.calls++
    if (stub.calls === 1) await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'agent failed', code: 'agent_failed' }) })
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAYLOAD) })
  })
  return stub
}

async function search(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible()
  await page.evaluate(() => localStorage.setItem('open-walnut-agent-search', '1'))
  await page.locator('.todo-search-input').fill(QUERY)
}

test('a test browser sends a failed read once: the error and its Retry show', async ({ page }) => {
  const stub = await failFirstAgentSearch(page)
  await search(page)
  const panel = page.getByTestId('agent-search-panel')
  await expect(panel.getByTestId('agent-search-error')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(3_000) // past both retry waits: nothing was sent again
  expect(stub.calls).toBe(1)
})

test('with the retry on, as in a person\'s browser, the same 502 is retried and the answer shows', async ({ page }) => {
  await quietRetriesOn(page)
  const stub = await failFirstAgentSearch(page)
  await search(page)
  const panel = page.getByTestId('agent-search-panel')
  await expect(panel.locator(`.agent-search-row[data-task-id="${TASK_ID}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByTestId('agent-search-error')).toHaveCount(0)
  expect(stub.calls).toBe(2)
})
