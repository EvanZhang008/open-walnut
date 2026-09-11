/**
 * Playwright browser tests for LIVE EDIT in the session Files panel.
 *
 * Live mode writes the buffer to disk shortly after the user stops typing, and
 * answers the one thing that makes auto-save dangerous in a directory an agent
 * is also editing: a 409 from the optimistic lock. Instead of a banner, it
 * re-reads disk and three-way-merges; only an overlapping edit stops it.
 *
 * What these pin, each a way the feature could ship and still lose work:
 *   - the auto-write really reaches disk and clears the dirty state,
 *   - a non-overlapping write from someone else is FOLDED IN, both edits land,
 *     and the user is told (a silent merge is indistinguishable from "nothing
 *     happened", which is how a user learns to distrust the mode),
 *   - an overlapping write PAUSES live mode for that file with the user's text
 *     still in the editor and the other writer's bytes still on disk — neither
 *     side is thrown away by a guess,
 *   - switching files lands the outgoing file's last burst under ITS path.
 *
 * The merge rule itself has 28 unit tests (tests/web/three-way-merge.test.ts);
 * these are the wiring tests through the real components.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'

test.use({ viewport: { width: 1200, height: 800 } })

type EventWindow = Window & {
  fileTestSocket?: WebSocket
  heldFileResponse?: { ready: boolean; release: () => void; checks: number[] }
}

async function emitEvent(page: Page, name: string, data: Record<string, unknown>) {
  await page.waitForFunction(() => (window as EventWindow).fileTestSocket?.readyState === 1, null, { timeout: 5000 })
  await page.evaluate(({ name, data }) => {
    const socket = (window as EventWindow).fileTestSocket
    if (!socket) throw new Error('Missing fixture socket')
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name, data }),
    }))
  }, { name, data })
}

async function emitTool(page: Page, toolName = 'Bash', input: Record<string, unknown> = { command: 'python update.py' }) {
  const data = { sessionId: SESSION_ID, toolUseId: `file-test-${Date.now()}`, toolName, input }
  await emitEvent(page, 'session:tool-use', data)
  await emitEvent(page, 'session:tool-result', data)
}

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
/** Not under test-results/: that dir is wiped by every concurrent run. */
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/live-edit'

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
  // Click the row's title: the task menu has no open-session row.
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

function editor(page: Page): Locator {
  return page.locator('.fv-source-editor .cm-content')
}

function liveToggle(page: Page): Locator {
  return page.locator('.fv-live-toggle')
}

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

/** Someone else (an agent, another tab) rewrites the file. No expectedHash: the
 *  other writer does not hold our lock, which is exactly what makes our next
 *  write 409. */
async function externalWrite(page: Page, abs: string, content: string): Promise<void> {
  const put = await page.request.put('/api/file-content', { data: { path: abs, content } })
  expect(put.ok(), await put.text()).toBe(true)
}

/** Place the caret at the START of a given 1-based line (click, then Home). */
async function caretToLineStart(page: Page, line: number): Promise<void> {
  await editor(page).locator('.cm-line').nth(line - 1).click()
  await page.keyboard.press('Home')
}

async function openFileLive(page: Page, explorer: Locator, name: string, expectText: string): Promise<void> {
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText(expectText)
  const toggle = liveToggle(page)
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveClass(/active/)
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

test('Bash disk writes update the Markdown preview without Refresh or write-back', async ({ page }) => {
  const name = `live-script-${Date.now()}.md`
  const abs = await makeScratchFile(page, name, '# Design\n\nOriginal disk version.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  const preview = page.locator('.fv-wysiwyg-editor .ProseMirror')
  await expect(preview).toContainText('Original disk version.')
  await liveToggle(page).click()
  await preview.evaluate(el => { (el as HTMLElement).dataset.liveStamp = 'original' })
  const writes: string[] = []
  page.on('request', req => { if (req.method() === 'PUT' && req.url().includes('/api/file-content')) writes.push(req.url()) })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/6-before-script.png` })

  const updated = '# Design\n\nUpdated directly on disk by a script.\n'
  await writeFile(abs, updated)
  await emitTool(page)
  await expect(preview).toContainText('Updated directly on disk by a script.', { timeout: 8000 })
  await expect(preview).toHaveAttribute('data-live-stamp', 'original')
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  expect(writes).toEqual([])
  expect(await onDisk(page, abs)).toBe(updated)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/7-after-script.png` })
})

test('focus checks use 304 for unchanged text and merge unsaved edits without writing', async ({ page }) => {
  const name = `live-focus-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('middle')
  await caretToLineStart(page, 1)
  await page.keyboard.type('ours-')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()

  const unchanged = page.waitForResponse(r => new URL(r.url()).pathname === '/api/file-content' && new URL(r.url()).searchParams.get('path') === abs)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  expect((await unchanged).status()).toBe(304)
  await expect(editor(page)).toContainText('ours-top')

  await writeFile(abs, 'top\nmiddle\nbottom-by-script\n')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(editor(page)).toContainText('bottom-by-script')
  await expect(editor(page)).toContainText('ours-top')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  expect(await onDisk(page, abs)).toBe('top\nmiddle\nbottom-by-script\n')
})

test('script conflict keeps the unsaved buffer and the external disk version separate', async ({ page }) => {
  const name = `live-pull-conflict-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('middle')
  await caretToLineStart(page, 1)
  await page.keyboard.type('ours-')
  await writeFile(abs, 'THEIRS\nmiddle\nbottom\n')
  await emitTool(page)
  await expect(page.locator('.fv-save-error')).toContainText('overlap yours')
  await expect(editor(page)).toContainText('ours-top')
  expect(await onDisk(page, abs)).toBe('THEIRS\nmiddle\nbottom\n')
})

test('a second disk update during a held pull is read after that pull settles', async ({ page }) => {
  const name = `live-pull-race-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'original\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('original')
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  let reads = 0
  let firstReady = false
  await page.route('**/api/file-content?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('path') !== abs || url.searchParams.get('track') !== 'agent') return route.fallback()
    reads++
    const response = await route.fetch()
    if (reads === 1) { firstReady = true; await held }
    await route.fulfill({ response })
  })
  try {
    await writeFile(abs, 'first script version\n')
    await emitTool(page)
    await expect.poll(() => firstReady).toBe(true)
    await writeFile(abs, 'final script version\n')
    await emitTool(page)
    await page.waitForTimeout(500)
    release()
    await expect(editor(page)).toContainText('final script version')
    expect(reads).toBe(2)
  } finally { release() }
})

test('a pull started before Save cannot replace the saved buffer', async ({ page }) => {
  const name = `live-save-race-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'original\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('original')
  await page.evaluate(abs => {
    const nativeFetch = window.fetch.bind(window)
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const state = { ready: false, release, checks: [] as number[] }
    ;(window as EventWindow).heldFileResponse = state
    let first = true
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
      if (url.pathname !== '/api/file-content' || url.searchParams.get('path') !== abs || url.searchParams.get('track') !== 'agent') {
        return nativeFetch(input, init)
      }
      const hold = first
      first = false
      const headers = new Headers(init?.headers)
      if (hold) headers.delete('If-None-Match')
      const response = await nativeFetch(input, { ...init, headers })
      state.checks.push(response.status)
      if (hold) {
        await response.clone().text()
        state.ready = true
        await held
      }
      return response
    }
  }, abs)
  try {
    await emitTool(page)
    await page.waitForFunction(() => (window as EventWindow).heldFileResponse?.ready)
    await caretToLineStart(page, 1)
    await page.keyboard.type('saved-')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
    expect(await readFile(abs, 'utf8')).toBe('saved-original\n')
    await page.evaluate(() => (window as EventWindow).heldFileResponse?.release())
    await page.waitForFunction(() => (window as EventWindow).heldFileResponse?.checks.length === 2)
    await expect(editor(page)).toContainText('saved-original')
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  } finally {
    await page.evaluate(() => (window as EventWindow).heldFileResponse?.release())
  }
})

test('a late pull for the previous file cannot change the current editor', async ({ page }) => {
  const stamp = Date.now()
  const nameA = `live-read-a-${stamp}.txt`
  const nameB = `live-read-b-${stamp}.txt`
  const absA = await makeScratchFile(page, nameA, 'file A\n')
  const absB = await makeScratchFile(page, nameB, 'file B\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, nameA).click()
  await expect(editor(page)).toContainText('file A')
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  let ready = false
  await page.route('**/api/file-content?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('path') !== absA || url.searchParams.get('track') !== 'agent') return route.fallback()
    const response = await route.fetch()
    ready = true
    await held
    await route.fulfill({ response })
  })
  try {
    await writeFile(absA, 'updated file A\n')
    await emitTool(page)
    await expect.poll(() => ready).toBe(true)
    await nodeByName(explorer, nameB).click()
    await expect(editor(page)).toContainText('file B')
    const settled = page.waitForResponse(r => r.url().includes('track=agent') && new URL(r.url()).searchParams.get('path') === absA)
    release()
    await settled
    await expect(editor(page)).toHaveText('file B')
    expect(await onDisk(page, absB)).toBe('file B\n')
    await nodeByName(explorer, nameA).click()
    await expect(editor(page)).toContainText('updated file A')
  } finally { release() }
})

test('visible idle checks recover writes without tool events and hidden views stay quiet', async ({ page }) => {
  test.setTimeout(60_000)
  const name = `live-idle-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'original\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('original')
  await editor(page).hover()
  const focused = page.waitForResponse(r => new URL(r.url()).pathname === '/api/file-content' && new URL(r.url()).searchParams.get('path') === abs)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await focused
  let reads = 0
  page.on('request', r => { if (new URL(r.url()).pathname === '/api/file-content' && new URL(r.url()).searchParams.get('path') === abs) reads++ })
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }))
  await writeFile(abs, 'external terminal version\n')
  await emitTool(page)
  await page.waitForTimeout(600)
  expect(reads).toBe(0)
  await page.evaluate(() => { delete (document as unknown as Record<string, unknown>).hidden })
  await expect(editor(page)).toContainText('external terminal version', { timeout: 35_000 })
})

test('reconnect recovers a missed write even with Live auto-save off', async ({ page }) => {
  const name = `live-reconnect-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'original\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('original')
  await writeFile(abs, 'written while disconnected\n')
  await emitEvent(page, '_ws:reconnected', {})
  await expect(editor(page)).toContainText('written while disconnected')
  await expect(liveToggle(page)).toHaveAttribute('aria-pressed', 'false')
})

test('live mode writes the buffer to disk after typing stops, and remembers being on', async ({ page }) => {
  const name = `live-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'first line\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, name, 'first line')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-live-on.png` })

  const typed = `typed-live-${Date.now()}`
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(typed)

  // No Save click. The bytes must reach disk on their own, and the dirty state
  // must clear — a dirty dot that stays lit after an auto-write would teach the
  // user to press Save anyway, which defeats the mode.
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain(typed)
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-auto-written.png` })

  // The preference is global and survives the page: stored, not just in state.
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-live-edit'))).toBe('1')
})

test('a non-overlapping change from disk is merged into the live buffer and written back', async ({ page }) => {
  const name = `live-merge-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'top\nmiddle\nbottom\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, name, 'middle')

  // Another writer changes the LAST line while we hold the lock on the old bytes.
  await externalWrite(page, abs, 'top\nmiddle\nbottom-by-agent\n')

  // We edit the FIRST line. The auto-write 409s, live mode re-reads disk, and the
  // two edits touch different lines → both survive.
  await caretToLineStart(page, 1)
  await page.keyboard.type('ours-')

  const receipt = page.locator('.fv-live-receipt')
  await expect(receipt).toBeVisible({ timeout: 10_000 })
  await expect(receipt).toContainText(/^Merged/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-merged-receipt.png` })

  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('ours-top\nmiddle\nbottom-by-agent\n')
  // The editor shows the merged text too — the other writer's line arrived in
  // place, without a remount (the buffer still has our edit).
  await expect(editor(page)).toContainText('ours-top')
  await expect(editor(page)).toContainText('bottom-by-agent')
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await expect(liveToggle(page)).toHaveClass(/active/)
})

test('an overlapping change pauses live mode for the file and keeps both versions', async ({ page }) => {
  const name = `live-conflict-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'line one\nline two\nline three\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, name, 'line two')

  // Both sides rewrite line 1 — no merge can decide this.
  await externalWrite(page, abs, 'THEIRS one\nline two\nline three\n')
  await caretToLineStart(page, 1)
  await page.keyboard.type('ours-')

  // Live mode pauses for THIS file (the pill is no longer active) and says why.
  const toggle = liveToggle(page)
  await expect(toggle).toHaveClass(/fv-live-suspended/, { timeout: 10_000 })
  await expect(toggle).not.toHaveClass(/active/)
  const notice = page.locator('.fv-save-error')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Live edit is paused for this file')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-conflict-paused.png` })

  // Neither side was thrown away: our text is still in the editor (dirty), and
  // the other writer's bytes are still what is on disk.
  await expect(editor(page)).toContainText('ours-line one')
  await expect(page.locator('.fv-dirty-dot')).toBeVisible()
  expect(await onDisk(page, abs)).toBe('THEIRS one\nline two\nline three\n')

  // Clicking the pill on a paused file resumes it (it does not flip the global
  // preference off, which is what a naive toggle would do here).
  await toggle.click()
  await expect(toggle).toHaveClass(/active/)
  await expect(toggle).not.toHaveClass(/fv-live-suspended/)
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-live-edit'))).toBe('1')
})

test('switching files lands the outgoing file\'s last burst under its own path', async ({ page }) => {
  const stamp = Date.now()
  const nameA = `live-a-${stamp}.txt`
  const nameB = `live-b-${stamp}.txt`
  const absA = await makeScratchFile(page, nameA, 'file A\n')
  const absB = await makeScratchFile(page, nameB, 'file B\n')

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, nameA, 'file A')

  // Line 1 explicitly: a click on the editor body lands on the empty line the
  // trailing newline leaves, and End there would type a new line, not an edit.
  await editor(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' plus-a-edit')
  // Switch BEFORE the 600ms debounce would have fired.
  await nodeByName(explorer, nameB).click()
  await expect(editor(page)).toContainText('file B')

  // A's bytes land on A's path; B is untouched — a stale closure here would
  // write A's text under B's path, the one failure this record-per-write design
  // exists to make impossible.
  await expect.poll(() => onDisk(page, absA), { timeout: 10_000 }).toBe('file A plus-a-edit\n')
  expect(await onDisk(page, absB)).toBe('file B\n')
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/5-switch-landed.png` })
})
