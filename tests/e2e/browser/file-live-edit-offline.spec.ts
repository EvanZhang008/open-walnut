/**
 * Live Edit when the server goes away mid-typing.
 *
 * 2026-09-24: a deploy restarted the server for about two seconds while a doc was
 * being typed into with Live on. The auto-write's fetch rejected, live mode paused
 * itself for that file, and the toolbar showed a red "Failed to fetch". Nothing
 * typed afterwards was written until the user noticed the pill.
 *
 * What these pin, through the real components against the real write route:
 *  - a refused connection is a STATUS strip ("Can't reach Walnut right now"), not a
 *    red error banner, and live mode stays on;
 *  - the text that could not be written goes out on its own once the server is
 *    back, and the toolbar says it did;
 *  - typing during the outage does not multiply notes or lose the newest text;
 *  - the explicit Save says what happened in plain words and works again after;
 *  - a full minute of outage DOES pause live mode for the file, with a message
 *    that names the cause and the way out, and the pill resumes it.
 *
 * Taking the server away = aborting PUT /api/file-content at the browser edge
 * with `connectionrefused`, which is exactly what a restarting server looks like
 * from a tab (Chromium words it "Failed to fetch", WebKit "Load failed"). Reads
 * are left alone so the panel around the editor keeps working, as it did in the
 * incident. The Playwright request context bypasses page routes, so `onDisk`
 * still sees the real file throughout.
 */
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

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
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

const editor = (page: Page) => page.locator('.fv-source-editor .cm-content')
const liveToggle = (page: Page) => page.locator('.fv-live-toggle')
const offlineNote = (page: Page) => page.locator('.fv-offline-banner')
const banner = (page: Page) => page.locator('.fv-save-error')
const dirtyDot = (page: Page) => page.locator('.fv-dirty-dot')
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })

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
  await expect(liveToggle(page)).toBeVisible()
}

async function turnLiveOn(page: Page): Promise<void> {
  const toggle = liveToggle(page)
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveClass(/active/)
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
      // Every test starts with live mode OFF and turns it on itself: the pref is
      // global, and a previous test leaving it on would hide a broken toggle.
      localStorage.setItem('open-walnut-live-edit', '0')
    } catch { /* off */ }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 15_000 })
})

test('a write refused by a restarting server is retried, not turned into a pause', async ({ page }) => {
  const name = `live-offline-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')
  await turnLiveOn(page)

  // Baseline: live mode writes on its own while the server is up.
  await caretToLineStart(page, 1)
  await page.keyboard.type('first-')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('first-top\nmiddle\nbottom\n')
  await expect(dirtyDot(page)).toHaveCount(0)

  const writes = recordWrites(page)
  const restore = await refuseWrites(page)
  await page.keyboard.type('second-')

  // The incident's moment. A status, not a banner; live mode still on.
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })
  await expect(offlineNote(page)).toContainText("Can't reach Walnut right now")
  await expect(banner(page)).toHaveCount(0)
  await expect(liveToggle(page)).toHaveClass(/active/)
  await expect(liveToggle(page)).not.toHaveClass(/fv-live-suspended/)
  await expect(liveToggle(page)).toHaveAttribute('aria-pressed', 'true')
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
  await expect(liveToggle(page)).toHaveClass(/active/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-recovered.png` })

  // And the mode is intact for the next burst.
  await page.keyboard.type('third-')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('first-second-third-top\nmiddle\nbottom\n')
})

test('typing through the outage keeps one note and lands the newest text', async ({ page }) => {
  const name = `live-offline-typing-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')
  await turnLiveOn(page)

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
  await expect(liveToggle(page)).not.toHaveClass(/fv-live-suspended/)
  await expect(editor(page)).toContainText('a-b-c-top')
  expect(await onDisk(page, abs)).toBe('top\nmiddle\nbottom\n')

  await restore()
  await expect.poll(() => onDisk(page, abs), { timeout: 25_000 }).toBe('a-b-c-top\nmiddle\nbottom\n')
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)
})

test('Save during an outage says so in plain words and works once the server is back', async ({ page }) => {
  const name = `save-offline-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')
  await expect(liveToggle(page)).toHaveAttribute('aria-pressed', 'false')

  await caretToLineStart(page, 1)
  await page.keyboard.type('x-')
  await expect(dirtyDot(page)).toBeVisible()
  const restore = await refuseWrites(page)
  await saveButton(page).click()
  await expect(banner(page)).toBeVisible()
  await expect(banner(page)).toContainText("Can't reach Walnut")
  await expect(banner(page)).toContainText('press Save again')
  await expect(banner(page)).not.toContainText(/Failed to fetch|Load failed|NetworkError/)
  await expect(editor(page)).toContainText('x-top')
  await expect(dirtyDot(page)).toBeVisible()
  expect(await onDisk(page, abs)).toBe('top\nmiddle\nbottom\n')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-save-unreachable.png` })

  await restore()
  await saveButton(page).click()
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('x-top\nmiddle\nbottom\n')
  await expect(banner(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)
})

test('a full minute without the server pauses live mode for the file and says why', async ({ page }) => {
  // Real time on purpose: the backoff and the give-up line are what is under
  // test, and a faked clock would also fake the WebSocket's own timers.
  test.slow()
  test.setTimeout(180_000)
  const name = `live-offline-giveup-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')
  await turnLiveOn(page)

  const writes = recordWrites(page)
  const restore = await refuseWrites(page)
  const startedAt = Date.now()
  await caretToLineStart(page, 1)
  await page.keyboard.type('y-')
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })

  await expect(liveToggle(page)).toHaveClass(/fv-live-suspended/, { timeout: 100_000 })
  const pausedAfterMs = Date.now() - startedAt
  // Not before the minute is up, and not long after it either.
  expect(pausedAfterMs).toBeGreaterThanOrEqual(60_000)
  expect(pausedAfterMs).toBeLessThan(95_000)
  // A minute of outage is a handful of requests, not a request per second.
  expect(writes.length).toBeLessThanOrEqual(9)
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(banner(page)).toContainText("Walnut couldn't be reached for a minute")
  await expect(banner(page)).toContainText('click Live to resume')
  await expect(liveToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(liveToggle(page)).toHaveAttribute('title', /couldn't be reached/)
  await expect(editor(page)).toContainText('y-top')
  await expect(dirtyDot(page)).toBeVisible()
  expect(await onDisk(page, abs)).toBe('top\nmiddle\nbottom\n')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-paused-after-a-minute.png` })

  // The server is back; the pill resumes the file and the next burst is written,
  // which also retires the banner.
  await restore()
  await liveToggle(page).click()
  await expect(liveToggle(page)).toHaveClass(/active/)
  await expect(liveToggle(page)).not.toHaveClass(/fv-live-suspended/)
  // The pill took focus; put the caret back in the editor before typing.
  await editor(page).locator('.cm-line').nth(0).click()
  await page.keyboard.press('End')
  await page.keyboard.type('-z')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('y-top-z\nmiddle\nbottom\n')
  await expect(banner(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toHaveCount(0)
})

test('an explicit Save or turning Live off during the outage retires the strip with the retry', async ({ page }) => {
  const name = `live-offline-handoff-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await openFile(page, explorer, name, 'middle')
  await turnLiveOn(page)

  const restore = await refuseWrites(page)
  await caretToLineStart(page, 1)
  await page.keyboard.type('s-')
  await expect(offlineNote(page)).toBeVisible({ timeout: 10_000 })

  // Save while the server is still away. The explicit Save takes over from the
  // retry, so the strip's promise of an automatic write is withdrawn and the
  // banner says what to do instead.
  await saveButton(page).click()
  await expect(banner(page)).toContainText("Can't reach Walnut")
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(liveToggle(page)).toHaveClass(/active/)
  await expect(liveToggle(page)).not.toHaveClass(/fv-live-suspended/)

  // Server back, Save again: banner, strip and dirty dot all go.
  await restore()
  await saveButton(page).click()
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
  await expect(liveToggle(page)).not.toHaveClass(/fv-live-suspended/)
  await expect(banner(page)).toHaveCount(0)

  // Turning Live off mid-outage: no automatic write is coming, so no strip.
  await liveToggle(page).click()
  await expect(liveToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(offlineNote(page)).toHaveCount(0)
  await expect(dirtyDot(page)).toBeVisible()
  await restore2()
  await page.waitForTimeout(2500)
  expect(await onDisk(page, abs)).toBe('s-top\nmiddle\nbottom\n')
  await saveButton(page).click()
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('s-top-t\nmiddle\nbottom\n')
  await expect(dirtyDot(page)).toHaveCount(0)
})
