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
import { isolateUiPrefs } from './todo-panel-helpers'
import { serverFlags } from './server-flags'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent, viewport: { width: 1512, height: 900 } })

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const made: string[] = []
const flags = serverFlags()

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.afterAll(async ({ request }) => {
  await flags.restore(request)
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('sending from Home\'s columns and opening Org\'s nodes resizes no box outside an observer\'s own', async ({ page, request }) => {
  test.setTimeout(420_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  // The user's own setting: every experiment on, the glass chat among them.
  await flags.set(request, { every_experiment: true, chat_glass_edges: true })

  const sids: string[] = []
  for (const msg of ['snapshot-long-turn:120000:dense', 'snapshot-clean-turn:Resize column two finished', 'snapshot-clean-turn:Resize column three finished']) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Resize observer column ${sids.length + 1}`, project: 'Work', source: 'local' })
    made.push(task.id)
    const { sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message: msg, taskId: task.id })
    sids.push(sessionId)
  }

  // A list as long as the user's (1,200 open tasks on 2026-11-24): the two loops left after the
  // composer fix came as Home and Org loaded and their task list arrived.
  for (let i = 0; i < 150; i++) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Resize observer list row ${i + 1}`, project: 'Work', source: 'local' })
    made.push(task.id)
  }

  // The sidebar folds below: its open or shut pref stays in this page.
  await isolateUiPrefs(page)
  await installResizeLoopProbe(page)
  await page.goto(`/?s1=${sids[0]}&s2=${sids[1]}&s3=${sids[2]}`)
  const columns = page.locator('.main-page-session-column .session-panel.is-glass-chat')
  await expect(columns.first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(3000)
  const culprits: string[] = []
  const collect = async (where: string) => {
    const r = await resizeLoopReport(page)
    culprits.push(...r.culprits.map((c) => `${where} (loops ${r.loops}): ${c.count}x told about ${c.told.join(', ')}; resized ${c.changed.join(', ')}`))
  }
  await collect('Home load')
  // A reload is a load with the list already cached; each one starts the probe again.
  await page.reload()
  await expect(columns.first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(3000)
  await collect('Home reload')
  // The sidebar closing and opening again changes every column's width at once.
  const fold = page.locator('.sidebar-collapse-btn').first()
  if (await fold.isVisible()) {
    for (let i = 0; i < 2; i++) { await fold.click(); await page.waitForTimeout(800) }
  }

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
  await collect('Home')
  await page.goto('/org')
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  const nodes = page.locator('[data-testid="org-channel"], [data-testid="org-channel-main"]')
  await expect(nodes.first()).toBeVisible({ timeout: 30_000 })
  const shown = Math.min(await nodes.count(), 3)
  for (let i = 0; i < shown; i++) { await nodes.nth(i).click(); await page.waitForTimeout(1200) }
  for (const width of [1300, 1000, 1512]) { await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(500) }
  await collect('Org')
  await page.reload()
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(3000)
  await collect('Org reload')

  // The cause is asserted, not the browser's error: whether that fires depends on box depths.
  expect(culprits, 'a ResizeObserver callback resized a box outside the ones it was told about: write it on the next frame, as useHeightVar.ts does').toEqual([])
})
