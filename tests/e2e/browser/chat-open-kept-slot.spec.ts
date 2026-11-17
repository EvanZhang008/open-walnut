/**
 * A chat's first screen does not wait for the browser's other reads (api/client.ts
 * INTERACTIVE_RESERVED).
 *
 * 2026-11-16 22:06Z, Evan's Mac app: a chat opened beside the Org page took 3.8 s. Its first-screen
 * read spent 0.7 s on the server and about 1.25 s in the client's connection queue: all six
 * connections were held by draft saves of 3 to 12 s and remote reads of 4 to 9 s, ten more reads
 * waited ahead of it. Here forty slow reads hold every shared connection, then the chat opens: its
 * first-screen read goes out at once and its rows are drawn while the slow reads still hang. On the
 * old code the read waits behind them (25 s).
 *
 * The class is every read the open's first screen draws from, not only its rows: the session record
 * draws the header, the mode and model and the note band over them. 2026-11-17 (composer-in-flow,
 * WebKit): the rows took the kept slot and the record waited behind the boot's forty queued reads,
 * so the chat was drawn with no note band and the band popped in 0.7 s later. Both reads go out
 * within the same window here.
 */
import { expect, test } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { openBeside } from './org-view-helpers'

// The fixture's task with a session (test-server.ts); its history is served below.
const SID = 'pw-history-turns-session'
const TASK = 'pw-task-history-turns'

test('a chat opened while every shared connection is busy reads its first screen at once', async ({ page }) => {
  test.setTimeout(90_000)
  await page.route('**/api/held-read/**', async (route) => {
    await new Promise((r) => setTimeout(r, 25_000))
    await route.fulfill({ json: {} }).catch(() => undefined)
  })
  let firstScreenAt = 0
  // The record read the panel draws from goes through the app's request client, which marks every
  // request it sends as JSON; the stream's own raw read of the same URL (pending prompts,
  // useSessionStream) skips the client's queue and carries no such header, so it is not counted.
  let recordAt = 0
  await page.route(`**/api/sessions/${SID}`, async (route) => {
    if (!recordAt && route.request().headers()['content-type'] === 'application/json') recordAt = Date.now()
    await route.fallback()
  })
  await page.route(`**/api/sessions/${SID}/history**`, async (route) => {
    const streams = new URL(route.request().url()).searchParams.get('source') === 'streams'
    if (streams && !firstScreenAt) firstScreenAt = Date.now()
    const messages = [
      { role: 'user', text: 'Which build broke the tests?', timestamp: '2026-11-16T08:00:00Z', msgId: 'ks-u-0' },
      { role: 'assistant', text: 'The kept slot answer is here.', timestamp: '2026-11-16T08:00:05Z', msgId: 'ks-a-0' },
    ]
    await route.fulfill({ json: { messages, total: 2, ...(streams ? { firstPaintSource: 'snapshot' } : { cursor: 1 }) } })
  })
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  // A string, so the import reaches the browser as written: the app's own module instance (the
  // fixture serves the SPA through Vite in dev mode).
  const stats = await page.evaluate(`(async () => {
    const client = await import('/src/api/client.ts')
    for (let i = 0; i < 40; i++) client.apiGet('/api/held-read/' + i).catch(() => undefined)
    return { ...client.getFetchQueueStats(), shared: client.SHARED_FETCH_SLOTS }
  })()`) as { inFlight: number; queued: number; shared: number }
  expect(stats.inFlight, 'every shared connection is held').toBeGreaterThanOrEqual(stats.shared)
  expect(stats.queued, 'reads wait behind them').toBeGreaterThan(0)
  // Only the read the open makes counts (the Home page may have read this chat before).
  firstScreenAt = 0
  recordAt = 0
  const openedAt = Date.now()
  await openBeside(page, `task:${TASK}`)
  await expect(page.getByTestId('org-side').getByText('The kept slot answer is here.').first()).toBeVisible({ timeout: 10_000 })
  expect(firstScreenAt, 'the first-screen read went out').toBeGreaterThan(0)
  expect(firstScreenAt, 'the first-screen read went out after the open').toBeGreaterThanOrEqual(openedAt)
  expect(firstScreenAt - openedAt, 'the first-screen read did not wait for the slow reads').toBeLessThan(5_000)
  // The record the header and the note band draw from comes with those rows, not after the slow reads.
  await expect.poll(() => recordAt, { message: 'the session record read went out', timeout: 5_000 }).toBeGreaterThan(0)
  expect(recordAt, 'the record read went out after the open').toBeGreaterThanOrEqual(openedAt)
  expect(recordAt - openedAt, 'the record read did not wait for the slow reads').toBeLessThan(5_000)
})
