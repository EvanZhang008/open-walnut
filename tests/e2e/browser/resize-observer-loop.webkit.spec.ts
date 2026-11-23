/**
 * No ResizeObserver callback resizes a box outside the ones it was told about, on the pages the
 * user keeps open, in WebKit (the Mac app's engine).
 *
 * 2026-11-23: the Mac app logged "ResizeObserver loop completed with undelivered notifications"
 * 43 times in a day, nearly every time a message was sent from a session column on Home or a
 * node's chat on Org (Walnut Health: "Other in the unknown chunk"). The glass composer's height
 * observer (useHeightVar, experiment chat_glass_edges) wrote the panel's padding variable inside
 * its callback, so the transcript beside the composer changed size in the observer's own
 * delivery. Whether the browser then raises the error depends on how deep each box sits, which
 * differs between this fixture and the user's window, so this spec checks the cause
 * (resize-observer-culprits.ts) on every observer the pages make, not only the one reported:
 * with every experiment the user runs on, three columns (one streaming), a window resized from
 * wide to narrow, a long dictated message filled and sent in each column twice, and Org's nodes.
 */
import { devices, expect, test, type APIRequestContext } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { installResizeLoopProbe, resizeLoopReport } from './resize-observer-culprits'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent, viewport: { width: 1512, height: 900 } })

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const made: string[] = []
let flagsBefore: Record<string, boolean> | null = null

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.afterAll(async ({ request }) => {
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('sending from Home\'s columns and opening Org\'s nodes resizes no box outside an observer\'s own', async ({ page, request }) => {
  test.setTimeout(240_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  const cfg = (await (await request.get('/api/config')).json()) as { config: { experimental?: Record<string, boolean> } }
  flagsBefore = { ...(cfg.config.experimental ?? {}) }
  // The user's own setting: every experiment on, the glass chat among them.
  expect((await request.put('/api/config', { data: { experimental: { ...flagsBefore, every_experiment: true, chat_glass_edges: true } } })).ok()).toBe(true)

  const sids: string[] = []
  for (const msg of ['snapshot-long-turn:120000:dense', 'snapshot-clean-turn:Resize column two finished', 'snapshot-clean-turn:Resize column three finished']) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Resize observer column ${sids.length + 1}`, project: 'Work', source: 'local' })
    made.push(task.id)
    const { sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message: msg, taskId: task.id })
    sids.push(sessionId)
  }

  await installResizeLoopProbe(page)
  await page.goto(`/?s1=${sids[0]}&s2=${sids[1]}&s3=${sids[2]}`)
  const columns = page.locator('.main-page-session-column .session-panel.is-glass-chat')
  await expect(columns.first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(3000)

  for (const width of [1700, 1440, 1280, 1100, 980, 1512]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(500)
  }

  const composers = page.locator('.main-page-session-column .session-panel.is-glass-chat textarea')
  const count = await composers.count()
  expect(count, 'the columns have their composers').toBeGreaterThan(0)
  const dictated = Array.from({ length: 6 }, (_, k) => `snapshot-clean-turn:dictated line ${k} of a long spoken message that wraps across the column`).join('\n')
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < count; i++) {
      await composers.nth(i).fill(dictated)
      await page.waitForTimeout(300)
      // The padding under the glass follows the grown composer a frame later: a column that
      // followed its newest row still shows it, clear of the composer.
      if (round === 0 && i === 0) {
        const gap = await page.locator('.main-page-session-column .session-panel.is-glass-chat').nth(i).evaluate((panel) => {
          const history = panel.querySelector('.session-history') as HTMLElement | null
          const composer = panel.querySelector('.session-panel-input') as HTMLElement | null
          const rows = history?.querySelectorAll('.session-msg')
          const last = rows && rows.length ? rows[rows.length - 1] as HTMLElement : null
          if (!history || !composer || !last) return null
          return { follow: Math.round(history.scrollHeight - history.scrollTop - history.clientHeight), clear: Math.round(composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom) }
        })
        if (gap) {
          expect(gap.follow, 'the column still follows its newest row').toBeLessThan(8)
          expect(gap.clear, 'the newest row is clear of the grown composer').toBeGreaterThanOrEqual(-1)
        }
      }
      await composers.nth(i).press('Enter')
      await expect(composers.nth(i)).toHaveValue('', { timeout: 10_000 })
      await page.waitForTimeout(800)
    }
  }

  // Home's findings are read before Org's load starts the probe again.
  const home = await resizeLoopReport(page)
  await page.goto('/org')
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  const nodes = page.locator('[data-testid="org-channel"], [data-testid="org-channel-main"]')
  await expect(nodes.first()).toBeVisible({ timeout: 30_000 })
  const shown = Math.min(await nodes.count(), 3)
  for (let i = 0; i < shown; i++) { await nodes.nth(i).click(); await page.waitForTimeout(1200) }
  for (const width of [1300, 1000, 1512]) { await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(500) }
  const org = await resizeLoopReport(page)

  // The cause is asserted, not the browser's error: whether that fires depends on box depths.
  const named = [...home.culprits.map((c) => ['Home', c] as const), ...org.culprits.map((c) => ['Org', c] as const)]
    .map(([where, c]) => `${where}: ${c.count}x told about ${c.told.join(', ')}; resized ${c.changed.join(', ')}`)
  expect(named, `a ResizeObserver callback resized a box outside the ones it was told about (loop errors: Home ${home.loops}, Org ${org.loops}): write it on the next frame, as useHeightVar.ts does`).toEqual([])
})
