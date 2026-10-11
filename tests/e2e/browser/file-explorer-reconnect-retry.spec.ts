/**
 * Playwright: the Files tree asks again while its host reconnects.
 *
 * Gate review (2026-10-03): with the cloud companion's link back, the tree
 * still said "Reconnecting to Cloud" 40s later and never asked again; only
 * Refresh brought the files back. A root listing answered 503
 * `host_reconnecting` is now retried on a clock until it lists. Any other
 * failure is not polled: retrying a refusal would ask the same thing forever.
 *
 * Gate review (2026-10-07): only the root asked again. A folder expanded and a
 * file opened while the link was down kept "Reconnecting to Cloud" once it was
 * back, until each was clicked. Every pane in that state now asks again: a
 * folder (alone or with cached rows under a refresh that did not get through)
 * in one list-many request per tick, and the open file's viewer.
 *
 * The fixture session's real listing is served by the fixture server; while a
 * test holds the "host" down, its answers are replaced with the server's
 * reconnecting shapes (503 host_reconnecting for one listing, `code` on a batch
 * listing and on the file payload).
 */
import { test, expect, type Page, type Route } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

async function openFilesPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  // The header row settles when the session record arrives: the Fork chip then
  // appears in front of Changed and Files and moves them right. A click in that
  // moment lands where Files was, on Changed (WebKit, main as well), so the
  // explorer never opens. Click once the row holds its last chip in front.
  await expect(panel.locator('[data-header-id="fork"] button')).toBeAttached()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

test.beforeEach(async ({ page }) => {
  // The open folders are a synced layout preference (ui-prefs-sync.ts) that every test
  // on the fixture server shares: a folder an earlier test left open is open here too,
  // and a click on it closes it. Each test here starts from no synced prefs and writes none.
  await page.route(/\/api\/ui-prefs(\?|$)/, (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { prefs: {} } })
    : route.fulfill({ json: { ok: true } }))
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
    ;(window as unknown as { __filesRetryMs?: number }).__filesRetryMs = 500
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('a root listing answered "Reconnecting": the tree asks again on its own and shows the files once the host is back', async ({ page }) => {
  let rootAsks = 0
  await page.route('**/api/files/list?**', async (route) => {
    rootAsks += 1
    // The host is back from the third ask on.
    if (rootAsks <= 2) {
      return route.fulfill({ status: 503, json: { error: 'Reconnecting to Cloud', code: 'host_reconnecting' } })
    }
    return route.fallback()
  })
  const explorer = await openFilesPanel(page)
  await expect(explorer.locator('.sfe-error')).toHaveText('Reconnecting to Cloud', { timeout: 10_000 })
  // No click: the retry brings the files, and the sentence goes.
  await expect(explorer.locator('.sfe-name', { hasText: 'refresh-target.txt' })).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('.sfe-error')).toHaveCount(0)
  expect(rootAsks).toBeGreaterThanOrEqual(3)
  // Listed: the clock stops.
  const settled = rootAsks
  await page.waitForTimeout(2_000)
  expect(rootAsks).toBe(settled)
})

test('any other root failure is not polled', async ({ page }) => {
  const asks: string[] = []
  await page.route('**/api/files/list?**', async (route) => {
    asks.push(new URL(route.request().url()).searchParams.get('path') ?? '')
    return route.fulfill({ status: 500, json: { error: 'EACCES: permission denied' } })
  })
  const explorer = await openFilesPanel(page)
  await expect(explorer.locator('.sfe-error')).toContainText('permission denied', { timeout: 10_000 })
  const seen = asks.length
  // Six periods of the test's 500ms clock. The panel may still make its own
  // second first load (one more ask, once); a clock would ask about six times.
  await page.waitForTimeout(3_000)
  expect(asks.length - seen, `asks: ${JSON.stringify(asks)}`).toBeLessThanOrEqual(1)
})

/**
 * A host held down by the test: while `down.on`, one listing answers 503
 * host_reconnecting, a batch answers each path with `code`, and a file opens to
 * the payload's `code`. Every ask is counted, down or not, so a test can tell
 * the clocks stopped.
 */
async function holdHost(page: Page, sentence: string) {
  const down = { on: false }
  const asks = { list: 0, many: 0, file: 0 }
  const reconnecting = { error: sentence, code: 'host_reconnecting' }
  await page.route('**/api/files/list?**', async (route: Route) => {
    asks.list += 1
    if (!down.on) return route.fallback()
    return route.fulfill({ status: 503, json: reconnecting })
  })
  await page.route('**/api/files/list-many', async (route: Route) => {
    asks.many += 1
    if (!down.on) return route.fallback()
    const { paths } = route.request().postDataJSON() as { paths: string[] }
    return route.fulfill({ json: { listings: paths.map((p) => ({ path: p, ...reconnecting })), truncated: false, timedOut: false } })
  })
  await page.route('**/api/file-content?**', async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('raw') || route.request().method() !== 'GET') return route.fallback()
    asks.file += 1
    if (!down.on) return route.fallback()
    return route.fulfill({ json: { content: null, size: 0, truncated: false, binary: false, extension: 'go', ...reconnecting } })
  })
  return { down, asks }
}

const rowIn = (explorer: ReturnType<Page['locator']>) => (name: string) =>
  explorer.locator('.sfe-name').filter({ hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }).first()
const viewer = (page: Page) => page.locator('.file-content-view').first()
const MARKER = 'registerResources wires the informers'

/** The host's two sentences: a dial under way, and a pool that fails fast (gate L1, L6). */
for (const sentence of ['Reconnecting to Cloud', "Can't reach Cloud right now."]) {
  test(`a folder and a file opened while the host is down ("${sentence}") show on their own once it is back`, async ({ page }) => {
    const { down, asks } = await holdHost(page, sentence)
    const explorer = await openFilesPanel(page)
    const row = rowIn(explorer)
    await expect(row('refresh-target.txt')).toBeVisible({ timeout: 15_000 })

    // The host goes down. A folder is expanded and a file opened.
    down.on = true
    await row('report').click()
    await expect(explorer.locator('.sfe-error')).toHaveText(sentence, { timeout: 10_000 })
    await row('sync-controller.go').click()
    await expect(page.locator('.file-viewer-error').first()).toHaveText(sentence, { timeout: 10_000 })
    // Every "Reloading…" badge the page draws from here on is counted, however
    // briefly it shows (a retry's answer comes back in milliseconds here).
    await page.evaluate(() => {
      const w = window as unknown as { __reloadingBadges: number }
      w.__reloadingBadges = 0
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n instanceof Element && (n.matches('.fv-reloading-badge') || n.querySelector('.fv-reloading-badge'))) w.__reloadingBadges += 1
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    })
    // Both keep asking while it is down (the test clock is 500ms): the folder in a batch.
    const atDown = { ...asks }
    await expect.poll(() => asks.many - atDown.many, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    await expect.poll(() => asks.file - atDown.file, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    // Asking again is quiet: the sentence stays, and no retry drew "Reloading…" over it.
    await expect(page.locator('.fv-reloading-badge')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __reloadingBadges: number }).__reloadingBadges)).toBe(0)

    // Back, with no click: the folder lists, the file shows, the sentence goes.
    down.on = false
    await expect(row('summary.html')).toBeVisible({ timeout: 10_000 })
    await expect(viewer(page)).toContainText(MARKER, { timeout: 10_000 })
    await expect(explorer.locator('.sfe-error')).toHaveCount(0)
    await expect(page.locator('.file-viewer-error')).toHaveCount(0)
    await expect(explorer).not.toContainText(sentence)
    // Listed and shown: the clocks stop.
    await page.waitForTimeout(1_000)
    const settled = { many: asks.many, file: asks.file }
    await page.waitForTimeout(2_000)
    expect({ many: asks.many, file: asks.file }).toEqual(settled)
  })
}

test('a Refresh that did not get through while the host was down: every folder asks again and its sentence goes once it is back', async ({ page }) => {
  const sentence = "Can't reach Cloud right now."
  const { down } = await holdHost(page, sentence)
  const explorer = await openFilesPanel(page)
  const row = rowIn(explorer)
  await expect(row('refresh-target.txt')).toBeVisible({ timeout: 15_000 })
  await row('report').click()
  await expect(row('summary.html')).toBeVisible({ timeout: 10_000 })

  down.on = true
  await explorer.getByRole('button', { name: 'Refresh file panel' }).click()
  // The rows stay; what did not refresh says so.
  await expect(explorer).toContainText(sentence, { timeout: 10_000 })
  await expect(row('summary.html')).toBeVisible()

  down.on = false
  await expect(explorer).not.toContainText(sentence, { timeout: 10_000 })
  await expect(row('summary.html')).toBeVisible()
  await expect(explorer.locator('.sfe-error')).toHaveCount(0)
})

test('a tree reopened from its cache while the host is down: the folders\' "last known contents" notes go on their own once it is back', async ({ page }) => {
  const { down } = await holdHost(page, 'Reconnecting to Cloud')
  const explorer = await openFilesPanel(page)
  const row = rowIn(explorer)
  await expect(row('refresh-target.txt')).toBeVisible({ timeout: 15_000 })
  // Open a folder: it is remembered as open and its rows are cached.
  await row('report').click()
  await expect(row('summary.html')).toBeVisible({ timeout: 10_000 })
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await panel.getByRole('button', { name: 'Files' }).click()
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)

  // Reopened while the host is down: the cached rows paint, each folder notes it.
  down.on = true
  await panel.getByRole('button', { name: 'Files' }).click()
  const reopened = panel.locator('.session-file-explorer')
  await expect(rowIn(reopened)('summary.html')).toBeVisible({ timeout: 10_000 })
  const notes = reopened.locator('.sfe-notice').filter({ hasText: 'Showing the last known contents' })
  await expect(notes).toHaveCount(2, { timeout: 10_000 })

  down.on = false
  await expect(notes).toHaveCount(0, { timeout: 10_000 })
  await expect(rowIn(reopened)('summary.html')).toBeVisible()
  await expect(reopened.locator('.sfe-error')).toHaveCount(0)
})
