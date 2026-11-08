/**
 * Live Edit when the server goes away mid-typing.
 *
 * 2026-09-24: a deploy restarted the server for about two seconds while a doc was
 * being typed into with Live on. The auto-write's fetch rejected, live mode paused
 * itself for that file, and the toolbar showed a red "Failed to fetch". Nothing
 * typed afterwards was written until the user noticed the pill.
 *
 * Saving is always live now (no Save button, no Live switch); the document
 * bar's save chip (`fv-save-state`) reads "Waiting to save" while a write waits
 * for the server and "Not saved" while the file is paused.
 *
 * What these pin, through the real components against the real write route:
 *  - a refused connection is a STATUS strip ("Can't reach Walnut right now"), not a
 *    red error banner, and saving stays live;
 *  - the text that could not be written goes out on its own once the server is
 *    back, and the bar says it did;
 *  - typing during the outage does not multiply notes or lose the newest text;
 *  - the explicit save (⌘S) says what happened in plain words, and its banner's
 *    Try again works once the server is back;
 *  - a full minute of outage DOES pause saving for the file, with a message
 *    that names the cause and the way out, and Try again resumes it.
 *
 * Taking the server away = aborting PUT /api/file-content at the browser edge
 * with `connectionrefused`, which is exactly what a restarting server looks like
 * from a tab (Chromium words it "Failed to fetch", WebKit "Load failed"). Reads
 * are left alone so the panel around the editor keeps working, as it did in the
 * incident. The Playwright request context bypasses page routes, so `onDisk`
 * still sees the real file throughout.
 */
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { goToSessionFolder } from './todo-panel-helpers'

test.use({ viewport: { width: 1200, height: 800 } })

type EventWindow = Window & { fileTestSocket?: WebSocket }

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
/** Not under test-results/: that dir is wiped by every concurrent run. */
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/live-edit-offline'

async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  const cwd = body?.session?.cwd ?? body?.cwd
  expect(typeof cwd).toBe('string')
  return cwd as string
}

async function openFilesPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  await goToSessionFolder(explorer)
  return explorer
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

const editor = (page: Page) => page.locator('.fv-source-editor .cm-content')
const saveState = (page: Page) => page.getByTestId('fv-save-state')
const offlineNote = (page: Page) => page.locator('.fv-offline-banner')
const banner = (page: Page) => page.locator('.fv-save-error')
const dirtyDot = (page: Page) => page.locator('.fv-dirty-dot')
const tryAgain = (page: Page) => banner(page).getByRole('button', { name: 'Try again', exact: true })
/** ⌘S in the editor (focus is there after typing): the explicit save, at once. */
const pressSave = (page: Page) => page.keyboard.press('ControlOrMeta+s')

async function makeScratchFile(page: Page, name: string, body: string): Promise<string> {
  const cwd = await fixtureCwd(page)
  const abs = `${cwd}/${name}`
  const res = await page.request.post('/api/files/create', { data: { path: abs } })
  expect(res.status(), await res.text()).toBe(200)
  const put = await page.request.put('/api/file-content', { data: { path: abs, content: body } })
  expect(put.ok(), await put.text()).toBe(true)
  return abs
}

async function onDisk(page: Page, abs: string): Promise<string> {
  const res = await page.request.get(`/api/file-content?path=${encodeURIComponent(abs)}`, {
    headers: { 'cache-control': 'no-store' },
  })
  expect(res.ok()).toBe(true)
  return (await res.json()).content as string
}

/** Place the caret at the START of a given 1-based line (click, then Home). */
async function caretToLineStart(page: Page, line: number): Promise<void> {
  await editor(page).locator('.cm-line').nth(line - 1).click()
  await page.keyboard.press('Home')
}

async function openFile(page: Page, explorer: Locator, name: string, expectText: string): Promise<void> {
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText(expectText)
  // Nothing to turn on: saving is live for every editable file.
  await expect(saveState(page)).toHaveText('Saved')
}

/** Take the server away for writes only. Returns the function that brings it back. */
async function refuseWrites(page: Page): Promise<() => Promise<void>> {
  const handler = (route: Route) =>
    route.request().method() === 'PUT' ? route.abort('connectionrefused') : route.fallback()
  await page.route('**/api/file-content**', handler)
  return () => page.unroute('**/api/file-content**', handler)
}

/** Every write the page attempted, in order, so a test can prove the retries happened. */
function recordWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().includes('/api/file-content')) writes.push(req.url())
  })
  return writes
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') {
          (window as EventWindow).fileTestSocket = this
        }
      }
    }
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
      Object.defineProperty(window.WebSocket, key, { value: NativeWebSocket[key] })
    }
    try {
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
      // An old browser's stored "Live off": ignored, saving is always live.
      localStorage.setItem('open-walnut-live-edit', '0')
    } catch { /* off */ }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  // A cold fixture server's first page load can take longer than 15 s.
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
})

test('a write refused by a restarting server is retried, not turned into a pause', async ({ page }) => {
  const name = `live-offline-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')

  // Baseline: saving happens on its own while the server is up.
  await caretToLineStart(page, 1)
  await page.keyboard.type('first-')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('first-top\nmiddle\nbottom\n')
  await expect(dirtyDot(page)).toHaveCount(0)

  const writes = recordWrites(page)
  const restore = await refuseWrites(page)
  await page.keyboard.type('second-')

  // The incident's moment. A status, not a banner; saving is waiting, not paused.
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })
  await expect(offlineNote(page)).toContainText("Can't reach Walnut right now")
  await expect(banner(page)).toHaveCount(0)
  await expect(saveState(page)).toHaveAttribute('data-state', 'waiting')
  await expect(saveState(page)).toHaveText('Waiting to save')
  await expect(dirtyDot(page)).toBeVisible()
  await expect(editor(page)).toContainText('first-second-top')
  expect(await onDisk(page, abs)).toBe('first-top\nmiddle\nbottom\n')
  // It keeps trying while the server is away, not just once.
  await expect.poll(() => writes.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-unreachable.png` })

  // The server comes back. Nothing is pressed; the waiting text lands by itself.
  await restore()
  await expect.poll(() => onDisk(page, abs), { timeout: 25_000 }).toBe('first-second-top\nmiddle\nbottom\n')
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(page.locator('.fv-live-receipt')).toHaveText('Saved after reconnecting')
  await expect(dirtyDot(page)).toHaveCount(0)
  await expect(banner(page)).toHaveCount(0)
  await expect(saveState(page)).toHaveText('Saved')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-recovered.png` })

  // And saving is intact for the next burst.
  await page.keyboard.type('third-')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('first-second-third-top\nmiddle\nbottom\n')
})

test('typing through the outage keeps one note and lands the newest text', async ({ page }) => {
  const name = `live-offline-typing-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')

  const restore = await refuseWrites(page)
  await caretToLineStart(page, 1)
  await page.keyboard.type('a-')
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })
  await page.keyboard.type('b-')
  await page.waitForTimeout(1500)
  await page.keyboard.type('c-')
  await page.waitForTimeout(1500)
  await expect(offlineNote(page)).toHaveCount(1)
  await expect(banner(page)).toHaveCount(0)
  await expect(saveState(page)).toHaveAttribute('data-state', 'waiting')
  await expect(editor(page)).toContainText('a-b-c-top')
  expect(await onDisk(page, abs)).toBe('top\nmiddle\nbottom\n')

  await restore()
  await expect.poll(() => onDisk(page, abs), { timeout: 25_000 }).toBe('a-b-c-top\nmiddle\nbottom\n')
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)
})

test('⌘S during an outage says so in plain words, and Try again works once the server is back', async ({ page }) => {
  const name = `save-offline-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')

  // The server goes away first: saving is live, so text typed while it is up
  // would simply be on disk.
  const restore = await refuseWrites(page)
  await caretToLineStart(page, 1)
  await page.keyboard.type('x-')
  await expect(dirtyDot(page)).toBeVisible()
  await pressSave(page)
  await expect(banner(page)).toBeVisible()
  await expect(banner(page)).toContainText("Can't reach Walnut")
  await expect(banner(page)).toContainText('press Try again once Walnut is running')
  await expect(banner(page)).not.toContainText(/Failed to fetch|Load failed|NetworkError/)
  await expect(tryAgain(page)).toBeVisible()
  await expect(saveState(page)).toHaveText('Not saved')
  await expect(editor(page)).toContainText('x-top')
  await expect(dirtyDot(page)).toBeVisible()
  expect(await onDisk(page, abs)).toBe('top\nmiddle\nbottom\n')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-save-unreachable.png` })

  await restore()
  await tryAgain(page).click()
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('x-top\nmiddle\nbottom\n')
  await expect(banner(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)
  await expect(saveState(page)).toHaveText('Saved')
})

test('a full minute without the server pauses saving for the file and says why', async ({ page }) => {
  // Real time on purpose: the backoff and the give-up line are what is under
  // test, and a faked clock would also fake the WebSocket's own timers.
  test.slow()
  test.setTimeout(180_000)
  const name = `live-offline-giveup-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')

  const writes = recordWrites(page)
  const restore = await refuseWrites(page)
  const startedAt = Date.now()
  await caretToLineStart(page, 1)
  await page.keyboard.type('y-')
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })

  await expect(saveState(page)).toHaveAttribute('data-state', 'held', { timeout: 100_000 })
  const pausedAfterMs = Date.now() - startedAt
  // Not before the minute is up, and not long after it either.
  expect(pausedAfterMs).toBeGreaterThanOrEqual(60_000)
  expect(pausedAfterMs).toBeLessThan(95_000)
  // A minute of outage is a handful of requests, not a request per second.
  expect(writes.length).toBeLessThanOrEqual(9)
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(banner(page)).toContainText('Saving is paused for this file')
  await expect(banner(page)).toContainText("Walnut couldn't be reached for a minute")
  await expect(banner(page)).toContainText('Press Try again once Walnut is back')
  await expect(tryAgain(page)).toBeVisible()
  await expect(saveState(page)).toHaveText('Not saved')
  await expect(editor(page)).toContainText('y-top')
  await expect(dirtyDot(page)).toBeVisible()
  expect(await onDisk(page, abs)).toBe('top\nmiddle\nbottom\n')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-paused-after-a-minute.png` })

  // The server is back; Try again writes the waiting text and resumes the file,
  // which also retires the banner, and the next burst is written on its own.
  await restore()
  await tryAgain(page).click()
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('y-top\nmiddle\nbottom\n')
  await expect(banner(page)).toHaveCount(0)
  await expect(saveState(page)).toHaveText('Saved')
  // The button took focus; put the caret back in the editor before typing.
  await editor(page).locator('.cm-line').nth(0).click()
  await page.keyboard.press('End')
  await page.keyboard.type('-z')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('y-top-z\nmiddle\nbottom\n')
  await expect(banner(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)
})

test('an explicit ⌘S during the outage retires the strip with the retry', async ({ page }) => {
  const name = `live-offline-handoff-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')

  const restore = await refuseWrites(page)
  await caretToLineStart(page, 1)
  await page.keyboard.type('s-')
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })

  // ⌘S while the server is still away. The explicit save takes over from the
  // retry, so the strip's promise of an automatic write is withdrawn and the
  // banner says what to do instead.
  await pressSave(page)
  await expect(banner(page)).toContainText("Can't reach Walnut")
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(saveState(page)).toHaveText('Not saved')

  // Server back, ⌘S again: banner, strip and dirty dot all go.
  await restore()
  await pressSave(page)
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('s-top\nmiddle\nbottom\n')
  await expect(banner(page)).toHaveCount(0)
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)

  // A second outage minutes later must start its own clock: had the first one's
  // bookkeeping survived the Save, this first failure would already count as
  // "a minute unreachable" and pause the file instead of showing the strip.
  const restore2 = await refuseWrites(page)
  await editor(page).locator('.cm-line').nth(0).click()
  await page.keyboard.press('End')
  await page.keyboard.type('-t')
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })
  await expect(saveState(page)).toHaveAttribute('data-state', 'waiting')
  await expect(banner(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toBeVisible()
  expect(await onDisk(page, abs)).toBe('s-top\nmiddle\nbottom\n')

  // Nothing took over this time, so the retry is still owed: it lands by itself.
  await restore2()
  await expect.poll(() => onDisk(page, abs), { timeout: 25_000 }).toBe('s-top-t\nmiddle\nbottom\n')
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)
  await expect(saveState(page)).toHaveText('Saved')
})
