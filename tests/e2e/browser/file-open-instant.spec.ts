/**
 * Re-opening a file paints IMMEDIATELY, from the bytes the browser already has,
 * and the network call behind it is a validity check rather than a transfer.
 *
 * The complaint: opening anything in the Files panel felt slow. Measured against
 * the live server, the tree itself was fine (it already paints from
 * cache/dirlist-idb), but every file click blanked the pane and waited for
 * `/api/file-content` to ship the whole file as JSON — for a remote session, over
 * the SSH tunnel, on every open, even for a file that had not changed since the
 * last look.
 *
 * Two halves, and this spec pins the observable behaviour of both:
 *   - a cached copy paints BEFORE the network answers (proved by holding the
 *     response open and asserting the text is on screen while it is still
 *     pending — a timing assertion made deterministic rather than flaky);
 *   - the answer is still authoritative: when the file changed on disk between
 *     the two opens, the pane corrects itself to the new bytes.
 *
 * Runs in Chromium (the caching path is engine-agnostic; the WKWebView-specific
 * image case is pinned separately in file-image-refresh.spec.ts).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/open-instant'

// Each test opens the panel, opens two files and screenshots; the default 30s is
// not enough for that on a machine that is also running other work.
test.setTimeout(120_000)

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
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

/** The editor's visible text, whichever surface rendered it. */
function bodyText(page: Page): Locator {
  return page.locator('.file-content-view .ProseMirror, .file-content-view .cm-content, .file-content-view pre').first()
}

test('a file you have opened before paints before the network answers, and still corrects itself', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const cwd = await fixtureCwd(page)
  const stamp = Date.now()
  const dir = path.join(cwd, `openperf-${stamp}`)
  const docName = `notes-${stamp}.md` // unique: `hasText` is a substring match
  const otherName = `other-${stamp}.md`
  const FIRST = `# Notes ${stamp}\n\nthe first version of this document\n`
  await fs.mkdir(dir, { recursive: true })

  try {
    const put = await page.request.put('/api/file-content', {
      data: { path: path.join(dir, docName), content: FIRST },
    })
    expect(put.ok(), await put.text()).toBe(true)
    const putOther = await page.request.put('/api/file-content', {
      data: { path: path.join(dir, otherName), content: `# Other ${stamp}\n\nsomewhere else to click\n` },
    })
    expect(putOther.ok(), await putOther.text()).toBe(true)

    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, `openperf-${stamp}`).click()
    const docRow = nodeByName(explorer, docName)
    await expect(docRow).toBeVisible({ timeout: 10_000 })

    // ── First open: nothing cached, so this is the cold path. ────────────────
    await docRow.click()
    await expect(bodyText(page)).toContainText('the first version', { timeout: 15_000 })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/1-first-open.png` })

    // Leave the file so the next click is a genuine re-open. It has to be another
    // FILE: clicking a directory row only folds it, and the pane keeps its file.
    await nodeByName(explorer, otherName).click()
    await expect(bodyText(page)).not.toContainText('the first version', { timeout: 15_000 })

    // ── Re-open with the response HELD ──────────────────────────────────────
    // Holding `/api/file-content` open makes the timing claim deterministic: any
    // text on screen while the request is still pending can only have come from
    // the browser's own copy. Without the cache the pane would be blank here.
    let release: (() => void) | null = null
    const held = new Promise<void>((r) => { release = r })
    let heldRequests = 0
    await page.route('**/api/file-content?**', async (route) => {
      if (route.request().method() !== 'GET') { await route.continue().catch(() => {}); return }
      heldRequests++
      await held
      await route.continue().catch(() => {})
    })

    await docRow.click()
    // The assertion that matters: content, while the read is still in flight.
    await expect(bodyText(page)).toContainText('the first version', { timeout: 10_000 })
    expect(heldRequests, 'the read really was in flight, so the paint came from cache').toBeGreaterThan(0)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/2-painted-while-pending.png` })

    // ── The held answer is still authoritative ──────────────────────────────
    // The file changed on disk between the two opens, so the cached paint above
    // was out of date and the pane must correct itself once the read lands.
    await fs.writeFile(path.join(dir, docName), `# Notes ${stamp}\n\nthe second version, written on disk\n`)
    release!()
    await expect(bodyText(page)).toContainText('the second version', { timeout: 15_000 })
    await expect(bodyText(page)).not.toContainText('the first version')
    await page.unroute('**/api/file-content?**')
    await page.screenshot({ path: `${SCREENSHOT_DIR}/3-corrected-to-disk.png` })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resting on a row reads the file ahead of the click, so even the FIRST open paints instantly', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const cwd = await fixtureCwd(page)
  const stamp = Date.now()
  const dir = path.join(cwd, `prefetch-${stamp}`)
  const docName = `hovered-${stamp}.md`
  const movieName = `clip-${stamp}.mp4` // a raw-bytes kind: must never be prefetched
  await fs.mkdir(dir, { recursive: true })

  try {
    const put = await page.request.put('/api/file-content', {
      data: { path: path.join(dir, docName), content: `# Hovered ${stamp}\n\nfetched before the click\n` },
    })
    expect(put.ok(), await put.text()).toBe(true)
    await fs.writeFile(path.join(dir, movieName), 'not really a movie, but the extension is what matters')

    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, `prefetch-${stamp}`).click()
    const docRow = nodeByName(explorer, docName)
    await expect(docRow).toBeVisible({ timeout: 10_000 })

    // Hovering the video row must produce NO content read at all: the pane renders
    // those from the raw-bytes URL, so a prefetch would be a whole-file read for
    // something nothing will ever use.
    let movieReads = 0
    let docReads = 0
    page.on('request', (req) => {
      const url = req.url()
      if (!url.includes('/api/file-content') || req.method() !== 'GET') return
      if (url.includes(encodeURIComponent(movieName))) movieReads++
      if (url.includes(encodeURIComponent(docName))) docReads++
    })

    await nodeByName(explorer, movieName).hover()
    await page.waitForTimeout(700)
    expect(movieReads, 'a raw-bytes kind is never prefetched').toBe(0)

    // Rest on the markdown row and let the prefetch land.
    await docRow.hover()
    await expect.poll(() => docReads, { timeout: 10_000 }).toBeGreaterThan(0)
    await page.waitForResponse(
      (r) => r.url().includes('/api/file-content') && r.url().includes(encodeURIComponent(docName)),
      { timeout: 10_000 },
    ).catch(() => { /* already settled */ })
    await page.waitForTimeout(300) // the cache write is a floating promise

    // Now hold every further read and click. This is the file's FIRST open in the
    // pane, and it must still paint from what the hover already fetched.
    let release: (() => void) | null = null
    const held = new Promise<void>((r) => { release = r })
    await page.route('**/api/file-content?**', async (route) => {
      if (route.request().method() !== 'GET') { await route.continue().catch(() => {}); return }
      await held
      // A route the page abandoned (unroute, navigation) is already handled —
      // continuing it then throws, and that is not what this test is about.
      await route.continue().catch(() => {})
    })
    await docRow.click()
    await expect(bodyText(page)).toContainText('fetched before the click', { timeout: 10_000 })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/4-prefetched-first-open.png` })
    release!()
    await page.unroute('**/api/file-content?**')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('an unchanged re-open asks with a validator and transfers no body', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const cwd = await fixtureCwd(page)
  const stamp = Date.now()
  const dir = path.join(cwd, `openperf2-${stamp}`)
  const docName = `spec-${stamp}.md`
  const otherName = `other-${stamp}.md`
  await fs.mkdir(dir, { recursive: true })

  try {
    const put = await page.request.put('/api/file-content', {
      data: { path: path.join(dir, docName), content: `# Spec ${stamp}\n\nunchanged between opens\n` },
    })
    expect(put.ok(), await put.text()).toBe(true)
    const putOther = await page.request.put('/api/file-content', {
      data: { path: path.join(dir, otherName), content: `# Other ${stamp}\n\nsomewhere else to click\n` },
    })
    expect(putOther.ok(), await putOther.text()).toBe(true)

    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, `openperf2-${stamp}`).click()
    const docRow = nodeByName(explorer, docName)
    await expect(docRow).toBeVisible({ timeout: 10_000 })

    await docRow.click()
    await expect(bodyText(page)).toContainText('unchanged between opens', { timeout: 15_000 })

    await nodeByName(explorer, otherName).click()
    await expect(bodyText(page)).not.toContainText('unchanged between opens', { timeout: 15_000 })

    // Watch the re-open's read.
    const reads: Array<{ conditional: boolean; status: number; bytes: number }> = []
    page.on('response', async (res) => {
      const url = res.url()
      if (!url.includes('/api/file-content') || res.request().method() !== 'GET') return
      if (!url.includes(encodeURIComponent(docName))) return
      let bytes = -1
      try { bytes = (await res.body()).length } catch { bytes = 0 }
      reads.push({
        conditional: !!res.request().headers()['if-none-match'],
        status: res.status(),
        bytes,
      })
    })

    await docRow.click()
    await expect(bodyText(page)).toContainText('unchanged between opens', { timeout: 15_000 })
    await expect.poll(() => reads.length, { timeout: 10_000 }).toBeGreaterThan(0)

    // The client's half of the contract: it says which bytes it already has.
    expect(reads[0].conditional, 'the re-open sent If-None-Match').toBe(true)
    // The server's half: an unchanged file answers 304 with no body. Asserted
    // together so a regression on either side fails here.
    expect(reads[0].status, 'an unchanged file answers 304').toBe(304)
    expect(reads[0].bytes, 'a 304 carries no body').toBe(0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
