/**
 * The file page, "Document first" (2026-11-06).
 *
 * The user's words: "redesign file page, 10 design this looks so ugly, have a
 * really really good design", then picked design 2 (no toolbar, the page reads
 * like a document) with saving always live: no Save button, no Live switch.
 *
 * What these pin, each a way the redesign could ship and still be wrong:
 *   - the file has ONE quiet line, every control in it one height, nothing
 *     wrapping, and none of the old buttons (Save, Discard, Live, Copy Path,
 *     Download, Finder, Default app, Fullscreen) sitting in it;
 *   - typing reaches disk on its own, with no preference set anywhere, and the
 *     line reads Saving… then Saved;
 *   - every rare action is still one click away in ⋯, which is an overlay that
 *     moves nothing under it, and Fullscreen still enters and leaves;
 *   - the tree has a head with its folder, ↑, Refresh and hidden files;
 *   - nothing open reads "No file open" with the same line above it, and lists
 *     the files read last so one click goes back in;
 *   - the tree draws line icons, not emoji;
 *   - a change that cannot be merged stops saving for that file, says so, and
 *     offers both ways out: keep mine (it lands on disk) or use the disk version.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { isolateUiPrefs } from './todo-panel-helpers'

test.use({ viewport: { width: 1280, height: 820 } })

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SHOTS = process.env.FILE_DOC_BAR_SHOTS || '/tmp/walnut-files-panel/doc-bar'

async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  return (body?.session?.cwd ?? body?.cwd) as string
}

async function makeScratchFile(page: Page, name: string, body: string): Promise<string> {
  const abs = `${await fixtureCwd(page)}/${name}`
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

async function externalWrite(page: Page, abs: string, content: string): Promise<void> {
  const put = await page.request.put('/api/file-content', { data: { path: abs, content } })
  expect(put.ok(), await put.text()).toBe(true)
}

async function openFilesPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

/** After a reload or in a new tab the panel may come back on its own; opening
 *  it again would toggle it, so use it when it is there. */
async function filesPanelAgain(page: Page): Promise<Locator> {
  const restored = page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-file-explorer`)
  try {
    await restored.waitFor({ state: 'visible', timeout: 5_000 })
    return restored
  } catch {
    return openFilesPanel(page)
  }
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

const bar = (page: Page) => page.locator('.file-content-view .fv-doc-bar')
const state = (page: Page) => page.getByTestId('fv-save-state')
const source = (page: Page) => page.locator('.fv-source-editor .cm-content')

test.beforeAll(async () => { await mkdir(SHOTS, { recursive: true }) })

test.beforeEach(async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
      // An old browser's stored "Live off" must not matter any more.
      localStorage.setItem('open-walnut-live-edit', '0')
    } catch { /* storage blocked */ }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
})

test('one quiet line, no Save, and typing reaches disk on its own', async ({ page }) => {
  const name = `doc-bar-${Date.now()}.md`
  const abs = await makeScratchFile(page, name, '# Q4 roadmap\n\nThree goals for the quarter.\n\n- One toolbar for every file type\n')
  const explorer = await openFilesPanel(page)

  // Nothing open: the same line, and the empty state says what to do.
  await expect(explorer.locator('.sfe-preview-empty-title')).toHaveText('No file open')
  await expect(explorer.locator('.sfe-empty-bar .sfe-tree-toggle')).toBeVisible()
  await page.waitForTimeout(800) // the panel's fade-in, so the picture is the settled page
  await page.screenshot({ path: `${SHOTS}/1-nothing-open.png` })

  await nodeByName(explorer, name).click()
  const doc = page.locator('.fv-wysiwyg-editor .ProseMirror')
  await expect(doc).toContainText('Three goals for the quarter.')

  // One line, one height, nothing wrapped.
  await expect(bar(page)).toBeVisible()
  const barBox = (await bar(page).boundingBox())!
  expect(barBox.height).toBeLessThanOrEqual(48)
  for (const el of await bar(page).locator('button, [role="status"]').all()) {
    if (!(await el.isVisible())) continue
    const b = (await el.boundingBox())!
    expect(b.height, await el.evaluate((n) => n.outerHTML.slice(0, 80))).toBeLessThanOrEqual(30)
  }
  await expect(bar(page).getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
  await expect(bar(page).getByRole('button', { name: 'Source' })).toBeVisible()
  await expect(bar(page).getByRole('button', { name: 'Find in file' })).toBeVisible()
  await expect(bar(page).getByRole('button', { name: 'History' })).toBeVisible()
  await expect(bar(page).getByRole('button', { name: 'More file actions' })).toBeVisible()
  for (const gone of ['Save', 'Discard', 'Live', 'Copy Path', 'Download', 'Finder', 'Default app', 'Fullscreen', 'Open in Notes']) {
    await expect(bar(page).getByRole('button', { name: gone, exact: true })).toHaveCount(0)
  }
  await expect(page.locator('.fv-save-btn, .fv-live-toggle, .fv-cancel-edit-btn')).toHaveCount(0)
  // The lead is where the file is: its path, ending in its name.
  await expect(bar(page).locator('.sfe-crumb.is-last')).toHaveText(name)
  // At a 1280 window with the chat open the name is whole, not cut.
  const nameCut = await bar(page).locator('.sfe-crumb.is-last .sfe-crumb-text').evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  expect(nameCut, 'the file name is shown whole').toBe(false)
  await expect(state(page)).toHaveText('Saved')
  await page.screenshot({ path: `${SHOTS}/2-file-open.png` })

  // Type: Saving… shows at once, then Saved, and the disk has it. No preference
  // was turned on anywhere (the init script even stored the old "off").
  await doc.locator('li').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and every file kind')
  await expect(state(page)).toHaveAttribute('data-state', 'saving')
  await page.screenshot({ path: `${SHOTS}/3-saving.png` })
  await expect(state(page)).toHaveText('Saved', { timeout: 10_000 })
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('One toolbar for every file type and every file kind')
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(0)
})

test('⋯ holds every rare action as an overlay, and Fullscreen enters and leaves', async ({ page }) => {
  const name = `doc-bar-menu-${Date.now()}.md`
  await makeScratchFile(page, name, '# Menu\n\nBody text.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Body text.')

  const editorTop = (await page.locator('.fv-wysiwyg-editor').boundingBox())!.y
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  const menu = page.getByTestId('fv-more-menu')
  await expect(menu).toBeVisible()
  // The first row is where the file is: the start of the path gives way, the
  // file's own folder and its name stay whole (the whole path is the tooltip).
  const pathRow = menu.locator('.fv-more-path')
  await expect(pathRow).toHaveAttribute('title', new RegExp(`/${name.replace(/[.]/g, '\\.')}$`))
  await expect(pathRow.locator('.fv-more-path-folder')).toHaveText('editor-fixture/')
  await expect(pathRow.locator('.fv-more-path-name')).toHaveText(name)
  for (const part of ['.fv-more-path-folder', '.fv-more-path-name']) {
    expect(await pathRow.locator(part).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${part} is whole`).toBe(true)
  }
  // The folders before them go whole or not at all, never cut inside a name
  // ("itor-fixture/", 2026-11-07); a leading "…/" says some were left out.
  const head = await pathRow.evaluate((row) => {
    const box = row.querySelector('.fv-more-path-dir') as HTMLElement | null
    const cutMark = !!row.querySelector('.fv-more-path-cut')
    if (!box) return { cutMid: false, hidden: 0, cutMark }
    const b = box.getBoundingClientRect()
    const kids = Array.from(box.children) as HTMLElement[]
    const cutMid = kids.some((k) => { const r = k.getBoundingClientRect(); return r.left < b.left - 0.5 || r.right > b.right + 0.5 })
    const full = (row.getAttribute('title') ?? '').split('/').length - 2 // head folders, "/" included
    return { cutMid, hidden: Math.max(0, full - kids.length), cutMark }
  })
  expect(head.cutMid, 'no folder name is cut in the middle').toBe(false)
  expect(head.cutMark, 'a leading …/ shows exactly when folders were left out').toBe(head.hidden > 0)
  for (const item of ['Open in new tab', 'Fullscreen', 'Copy path', 'Download', 'Refresh', 'Close file']) {
    await expect(menu.getByRole('menuitem', { name: item })).toBeVisible()
  }
  // Solid, not the app's glass: nothing of the tree shows through it.
  const bg = await menu.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg, 'the menu background is opaque').not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)|transparent/)
  // An overlay: the page under it did not move.
  expect((await page.locator('.fv-wysiwyg-editor').boundingBox())!.y).toBe(editorTop)
  await page.screenshot({ path: `${SHOTS}/4-more-menu.png` })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Fullscreen' }).click()
  await expect(page.locator('.file-content-view.fv-fullscreen')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/5-fullscreen.png` })
  // Fullscreen is a sheet like every other full screen (gutters all round, over
  // a backdrop) holding the document alone: no tree toggle, no ‹ ›, the text
  // centred in it.
  await expect(page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: /file tree/ })).toBeHidden()
  const sheet = (await page.locator('.file-content-view.fv-fullscreen').boundingBox())!
  const vp = page.viewportSize()!
  expect(sheet.y).toBeGreaterThan(4)
  expect(sheet.x + sheet.width).toBeLessThan(vp.width - 4)
  expect(sheet.y + sheet.height).toBeLessThan(vp.height - 4)
  await expect(page.locator('.fv-fullscreen-backdrop')).toBeVisible()
  const fsDoc = (await page.locator('.fv-fullscreen .ProseMirror').boundingBox())!
  expect(Math.abs(fsDoc.x + fsDoc.width / 2 - (sheet.x + sheet.width / 2))).toBeLessThan(40)
  // The line above the text starts where the text starts.
  const fsName = (await page.locator('.fv-fullscreen .fv-doc-bar .sfe-crumbs').boundingBox())!
  expect(Math.abs(fsName.x - fsDoc.x), 'the bar lines up with the text').toBeLessThan(12)
  // ...and its tools end where the text ends; only Exit fullscreen keeps the corner.
  const fsMore = (await page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: 'More file actions' }).boundingBox())!
  expect(Math.abs(fsMore.x + fsMore.width - (fsDoc.x + fsDoc.width)), 'the tools end with the text').toBeLessThan(16)
  const fsExit = (await page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: 'Exit fullscreen' }).boundingBox())!
  expect(sheet.x + sheet.width - (fsExit.x + fsExit.width), 'Exit fullscreen sits at the corner').toBeLessThan(24)
  // A 1280 window's full screen is a full bar from its first frame.
  await expect(page.locator('.fv-fullscreen .fv-doc-bar')).toHaveAttribute('data-fit', 'full', { timeout: 300 })
  // Source runs edge to edge, and so does the line above it.
  await page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: 'Source', exact: true }).click()
  const fsSrc = (await page.locator('.fv-fullscreen .fv-source-editor').boundingBox())!
  const fsSrcName = (await page.locator('.fv-fullscreen .fv-doc-bar .sfe-crumbs').boundingBox())!
  expect(Math.abs(fsSrcName.x - fsSrc.x), 'in Source the bar starts at the edge').toBeLessThan(48)
  await page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: 'Preview', exact: true }).click()
  await page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: 'Exit fullscreen' }).click()
  await expect(page.locator('.file-content-view.fv-fullscreen')).toHaveCount(0)
  // A click on the backdrop leaves too.
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Fullscreen' }).click()
  await expect(page.locator('.file-content-view.fv-fullscreen')).toBeVisible()
  // (The sidebar stays usable beside a full screen, so the backdrop starts after
  // it: click the gutter on the right.)
  await page.mouse.click(page.viewportSize()!.width - 6, 400)
  await expect(page.locator('.file-content-view.fv-fullscreen')).toHaveCount(0)
})

test('nothing open lists the files read last; the tree has line icons', async ({ page }) => {
  // The files read last live in UI prefs, which the shared test server syncs
  // between workers: keep this test's own.
  await isolateUiPrefs(page)
  const name = `doc-bar-recent-${Date.now()}.md`
  await makeScratchFile(page, name, '# Recent\n\nBody.\n')
  const explorer = await openFilesPanel(page)
  await expect(explorer.locator('.sfe-icon').first().locator('svg')).toBeVisible()
  await expect(explorer.locator('.sfe-icon', { hasText: /[\u{1F4C1}\u{1F4C4}\u{1F3E0}\u{1F4E6}]/u })).toHaveCount(0)
  await nodeByName(explorer, name).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Body.')
  // Forget only which file was open (the history of files read stays), and come
  // back: nothing is open, and the file just read is one click away.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('open-walnut-file-explorer-selected')) localStorage.removeItem(k)
    }
  })
  await page.reload()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
  const again = await filesPanelAgain(page)
  await expect(again.locator('.sfe-preview-empty-title')).toHaveText('No file open', { timeout: 15_000 })
  const recent = again.getByTestId('sfe-recent')
  await expect(recent.getByRole('button', { name })).toBeVisible()
  // Each row says where the file is and when it was read.
  await expect(recent.getByRole('button', { name }).locator('.sfe-recent-dir')).toHaveText(/editor-fixture · (just now|\d+ min ago)$/)
  // The session itself has loaded (its folder is the tree's root) before the picture.
  await expect(again.locator('.sfe-root-header .sfe-name-base').first()).toHaveText('editor-fixture', { timeout: 15_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}/1b-nothing-open-recent.png` })
  await recent.getByRole('button', { name }).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Body.')
})

test('the tree head holds the folder, ↑, Refresh and hidden files', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const head = explorer.locator('.sfe-tree-head')
  await expect(head).toBeVisible()
  await expect(head.locator('.sfe-tree-head-name')).not.toBeEmpty()
  await expect(head.getByRole('button', { name: 'Go to parent directory' })).toBeVisible()
  await expect(head.getByRole('button', { name: 'Refresh file panel' })).toBeVisible()
  const hidden = head.getByRole('button', { name: 'Show hidden files' })
  await expect(hidden).toHaveAttribute('aria-pressed', 'false')
  await hidden.click()
  await expect(hidden).toHaveAttribute('aria-pressed', 'true')
  await hidden.click()
  await expect(hidden).toHaveAttribute('aria-pressed', 'false')
  // Clicking the folder name types a path, as clicking the old path did.
  await head.locator('.sfe-tree-head-name').click()
  await expect(explorer.locator('.sfe-root-path-input')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('an overlapping change stops saving and offers keep mine or the disk version', async ({ page }) => {
  const stamp = Date.now()
  const name = `doc-bar-conflict-${stamp}.txt`
  const abs = await makeScratchFile(page, name, 'line one\nline two\nline three\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('line two')

  // Both sides rewrite line 1: no merge can decide this.
  await externalWrite(page, abs, 'THEIRS one\nline two\nline three\n')
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.type('ours-')

  const banner = page.locator('.fv-save-error')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(banner).toContainText('saving is paused for this file')
  await expect(state(page)).toHaveText('Not saved')
  await expect(banner.getByRole('button', { name: 'Keep my version' })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Use the version on disk' })).toBeVisible()
  expect(await onDisk(page, abs)).toBe('THEIRS one\nline two\nline three\n')
  await page.screenshot({ path: `${SHOTS}/6-conflict.png` })

  // Keep mine: it lands on disk, the banner goes, saving is live again.
  await banner.getByRole('button', { name: 'Keep my version' }).click()
  await expect(banner).toHaveCount(0)
  await expect(state(page)).toHaveText('Saved')
  expect(await onDisk(page, abs)).toBe('ours-line one\nline two\nline three\n')
  await page.keyboard.type('x')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('ours-xline one\nline two\nline three\n')

  // Again, and this time take the disk version.
  await externalWrite(page, abs, 'AGAIN one\nline two\nline three\n')
  await page.keyboard.type('y')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Use the version on disk' }).click()
  // The confirm is a solid card: nothing of the text under it shows through.
  const card = page.locator('.app-modal')
  await expect(card).toBeVisible()
  await page.waitForTimeout(400)
  const look = await card.evaluate((el) => {
    let o = 1
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity)
    return { opacity: o, bg: getComputedStyle(el).backgroundColor }
  })
  expect(look.opacity, 'the confirm card is fully opaque once shown').toBe(1)
  expect(look.bg).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)|transparent/)
  await page.screenshot({ path: `${SHOTS}/6b-confirm-disk.png` })
  await page.getByRole('button', { name: 'Use the version on disk' }).last().click()
  await expect(source(page)).toContainText('AGAIN one')
  await expect(banner).toHaveCount(0)
  await expect(state(page)).toHaveText('Saved')
  expect(await onDisk(page, abs)).toBe('AGAIN one\nline two\nline three\n')
})

test('a narrow pane keeps one line: the path gives way, the tools do not wrap', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 820 })
  const name = `doc-bar-narrow-with-a-long-file-name-${Date.now()}.md`
  await makeScratchFile(page, name, '# Narrow\n\nBody.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Body.')

  // Each width the pane can have: one line, the last control inside the bar,
  // the file's name still there and readable, the tree toggle and ‹ › intact.
  const fits = async (shot: string) => {
    const b = (await bar(page).boundingBox())!
    expect(b.height).toBeLessThanOrEqual(48)
    const more = (await bar(page).getByRole('button', { name: 'More file actions' }).boundingBox())!
    expect(more.x + more.width).toBeLessThanOrEqual(b.x + b.width + 1)
    const nameBox = (await bar(page).locator('.sfe-crumb.is-last').boundingBox())!
    expect(nameBox.width).toBeGreaterThan(36)
    expect(nameBox.x).toBeGreaterThanOrEqual(b.x)
    // A full bar never cuts the name: one that would has stepped down to compact.
    if ((await bar(page).getAttribute('data-fit')) === 'full') {
      const cut = await bar(page).locator('.sfe-crumb.is-last .sfe-crumb-text').evaluate((el) => el.scrollWidth > el.clientWidth + 1)
      expect(cut, `${shot}: a full bar shows the whole name`).toBe(false)
    }
    await expect(bar(page).getByRole('button', { name: /file tree/ })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/${shot}` })
  }
  await fits('7-medium.png')
  // Every desktop width in between, a step at a time: wherever the bar is full,
  // the name is whole.
  for (const w of [1280, 1120, 960, 900, 860, 1000]) {
    await page.setViewportSize({ width: w, height: 820 })
    await page.waitForTimeout(150)
    await fits(`9-width-${w}.png`)
  }
  // Compact: saved is the ✓ alone (the word is its tooltip), and the name has the room.
  if ((await bar(page).getAttribute('data-fit')) === 'compact') {
    await expect(state(page)).toHaveAttribute('data-state', 'saved')
    await expect(state(page).locator('.fv-save-state-word')).toBeHidden()
    expect((await bar(page).locator('.sfe-crumb.is-last').boundingBox())!.width).toBeGreaterThan(120)
  }

  // A narrow window: the pane is tight, so Find and History move into ⋯ and
  // Preview/Source become one switch; all of them still work from there.
  await page.setViewportSize({ width: 820, height: 820 })
  await expect(bar(page)).toHaveAttribute('data-fit', 'tight')
  await fits('8-tight.png')
  await bar(page).getByRole('button', { name: 'Show source' }).click()
  await expect(page.locator('.fv-source-editor')).toBeVisible()
  await bar(page).getByRole('button', { name: 'Show preview' }).click()
  await expect(page.locator('.fv-wysiwyg-editor')).toBeVisible()
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Find in file' }).click()
  await expect(page.locator('.fv-search-bar')).toBeVisible()
  await page.keyboard.press('Escape')

  // A phone-width window: the file has the whole width and the bar still names it.
  await page.setViewportSize({ width: 700, height: 820 })
  await expect(bar(page).locator('.sfe-crumb.is-last')).toHaveText(name)
  await fits('9-phone-width.png')
})

// ── What Walnut puts in the editor is saved like typing ─────────────────────
// Saving is always live and there is no Save button, so text the page itself
// puts in the editor (a restored version, a replayed draft) must go out on its
// own. It used to sit there as "Saving…" with nothing on its way.

async function restoreFirstVersion(page: Page) {
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const flyout = page.getByTestId('file-history-flyout')
  const rows = flyout.locator('.fh-row')
  await expect(rows).toHaveCount(2, { timeout: 10_000 })
  await rows.nth(1).click()
  await flyout.locator('.fh-diff').getByRole('button', { name: 'Restore this version' }).click()
}

for (const kind of ['txt', 'md'] as const) {
  test(`a restored version (${kind === 'txt' ? 'Source' : 'Preview'}) reaches disk with no keystroke`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    const name = `doc-bar-restore-${Date.now()}.${kind}`
    const abs = await makeScratchFile(page, name, kind === 'md' ? '# Title\n\nversion one\n' : 'version one\n')
    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, name).click()
    const surface = kind === 'md' ? page.locator('.fv-wysiwyg-editor .ProseMirror') : source(page)
    await expect(surface).toContainText('version one')
    if (kind === 'md') await surface.locator('p').last().click()
    else await surface.locator('.cm-line').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' plus two')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('version one plus two')

    await restoreFirstVersion(page)
    await expect(surface).not.toContainText('plus two')
    // Nothing typed, nothing pressed: it lands, and the line says so.
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).not.toContain('plus two')
    expect(await onDisk(page, abs)).toContain('version one')
    await expect(state(page)).toHaveText('Saved', { timeout: 10_000 })
  })
}

test('a draft replayed on open reaches disk on its own', async ({ page, context, baseURL }) => {
  const name = `doc-bar-replay-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'line one\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('line one')
  // Writes cannot land in this tab, so the text lives only in the draft store.
  await page.route('**/api/file-content**', (r) => (r.request().method() === 'PUT' ? r.abort() : r.continue()))
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' kept')
  await page.waitForTimeout(1500)
  expect(await onDisk(page, abs)).toBe('line one\n')

  // A fresh tab (no blocked route) opens the file, replays the draft, saves it.
  const next = await context.newPage()
  await page.close()
  await next.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await next.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(next.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
  const again = await filesPanelAgain(next)
  if (!(await next.locator('.fv-source-editor').isVisible().catch(() => false))) await nodeByName(again, name).click()
  await expect(next.locator('.fv-source-editor .cm-content')).toContainText('line one kept')
  await expect.poll(() => onDisk(next, abs), { timeout: 15_000 }).toBe('line one kept\n')
})

test('a refused write offers Try again, not a version choice', async ({ page }) => {
  const name = `doc-bar-refused-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'alpha\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('alpha')
  await page.route('**/api/file-content**', (r) => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Permission denied' }) })
    : r.continue()))
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' beta')
  const banner = page.locator('.fv-save-error')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(state(page)).toHaveText('Not saved')
  await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Keep my version' })).toHaveCount(0)
  await expect(banner.getByRole('button', { name: 'Use the version on disk' })).toHaveCount(0)
  expect(await onDisk(page, abs)).toBe('alpha\n')
  // The server lets it through again: Try again lands it and saving is live again.
  await page.unroute('**/api/file-content**')
  await banner.getByRole('button', { name: 'Try again' }).click()
  await expect(banner).toHaveCount(0)
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('alpha beta\n')
  // The keyboard is back in the text: the next keystroke lands there.
  await expect(source(page)).toBeFocused()
  await page.keyboard.type('!')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('alpha beta!\n')
})

test('a recent-folder suggestion under the path is visible and clickable', async ({ page }) => {
  const cwd = await fixtureCwd(page)
  await page.route('**/api/files/recent-dirs**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ dirs: [{ cwd: `${cwd}/deep`, host: null, count: 3 }] }),
  }))
  const name = `doc-bar-path-${Date.now()}.md`
  await makeScratchFile(page, name, '# Path\n\nBody.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await bar(page).locator('.sfe-crumbs').click()
  const input = page.locator('.sfe-root-path-input')
  await expect(input).toBeVisible()
  await input.fill('deep')
  const item = page.locator('.sfe-path-suggest-floating .sfe-path-suggest-item', { hasText: `${cwd}/deep` })
  await expect(item).toBeVisible()
  // Not clipped by the bar: it opens below the input, starting where it starts.
  const itemBox = (await item.boundingBox())!
  const inputBox = (await input.boundingBox())!
  expect(itemBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height - 1)
  expect(Math.abs(itemBox.x - inputBox.x)).toBeLessThan(8)
  await page.screenshot({ path: `${SHOTS}/10-path-suggest.png` })
  await item.click()
  await expect(explorer.locator('.sfe-root-header .sfe-name-base').first()).toHaveText('deep')
})

test('a tight pane keeps Back and Forward, in ⋯', async ({ page }) => {
  // The files read live in UI prefs, shared between workers: keep this test's own,
  // starting with none.
  await isolateUiPrefs(page)
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('open-walnut-file-explorer-history') || k.startsWith('open-walnut-file-explorer-selected')) localStorage.removeItem(k)
    }
  })
  const a = `doc-bar-a-${Date.now()}.md`
  const b = `doc-bar-b-${Date.now()}.md`
  await makeScratchFile(page, a, '# A\n\nFirst.\n')
  await makeScratchFile(page, b, '# B\n\nSecond.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, a).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('First.')
  await page.setViewportSize({ width: 820, height: 820 })
  await expect(bar(page)).toHaveAttribute('data-fit', 'tight')
  // One file read so far: no Back or Forward rows (the bar's ‹ › follow the same rule).
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  const menu = page.getByTestId('fv-more-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /^(Back|Forward)/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await nodeByName(explorer, b).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Second.')
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await expect(menu.getByRole('menuitem', { name: /^Forward/ })).toBeDisabled()
  // Where the file is heads the menu, with Back and Forward under it.
  const pathY = (await menu.locator('.fv-more-path').boundingBox())!.y
  expect((await menu.getByRole('menuitem', { name: `Back to ${a}` }).boundingBox())!.y).toBeGreaterThan(pathY)
  await page.screenshot({ path: `${SHOTS}/11-tight-back.png` })
  await menu.getByRole('menuitem', { name: `Back to ${a}` }).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('First.')
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: `Forward to ${b}` }).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Second.')
})

// ── Every way out of a pause, and the stale draft ───────────────────────────

const blockWrites = (page: Page) => page.route('**/api/file-content**', (r) => (r.request().method() === 'PUT' ? r.abort() : r.continue()))

test('a stale draft put back keeps its words and waits for a choice', async ({ page }) => {
  const name = `doc-bar-stale-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'alpha\nbeta\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('alpha')
  await blockWrites(page)
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' my draft')
  await page.waitForTimeout(1200)
  // Someone else changes the file; Refresh reads it, and the draft is now stale.
  await externalWrite(page, abs, 'NEW DISK\nbeta\n')
  await explorer.getByRole('button', { name: 'Refresh file panel' }).click()
  await page.getByRole('button', { name: 'Restore my changes' }).click()
  // Writes can land again from here: the test is that none is sent on its own.
  await page.unroute('**/api/file-content**')
  await expect(source(page)).toContainText('alpha my draft')
  const banner = page.locator('.fv-save-error')
  await expect(banner).toBeVisible()
  await expect(state(page)).toHaveText('Not saved')
  // A background look at the disk (window focus, the periodic check) finds the
  // newer file: it must not fold the draft into it, which would hand back the
  // disk bytes and drop the draft.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(2500)
  await expect(source(page)).toContainText('alpha my draft')
  await expect(banner.getByRole('button', { name: 'Keep my version' })).toBeVisible()
  // Nothing written on its own, even after the debounce and more typing.
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.waitForTimeout(1500)
  await page.keyboard.type('!')
  await page.waitForTimeout(1500)
  expect(await onDisk(page, abs)).toBe('NEW DISK\nbeta\n')
  await expect(source(page)).toContainText('my draft')
  await page.screenshot({ path: `${SHOTS}/12-stale-draft.png` })
  // Keep mine: the draft replaces the disk, and saving is live again.
  await banner.getByRole('button', { name: 'Keep my version' }).click()
  await expect(banner).toHaveCount(0)
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('my draft')
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('?')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('?')
})

test('a ⌘S that lands after a refusal makes saving live again', async ({ page }) => {
  const name = `doc-bar-cmds-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'alpha\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('alpha')
  await page.route('**/api/file-content**', (r) => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Permission denied' }) })
    : r.continue()))
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' one')
  await expect(state(page)).toHaveText('Not saved', { timeout: 10_000 })
  await page.unroute('**/api/file-content**')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('alpha one\n')
  await expect(page.locator('.fv-save-error')).toHaveCount(0)
  await page.keyboard.type(' two')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('alpha one two\n')
  await expect(state(page)).toHaveText('Saved')
})

test('"Use the version on disk" after a ⌘S conflict shows what is on disk now', async ({ page }) => {
  const name = `doc-bar-usedisk-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'alpha\nbeta\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('alpha')
  await externalWrite(page, abs, 'LATEST DISK\nbeta\n')
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.type('mine ')
  await page.keyboard.press('ControlOrMeta+s')
  const banner = page.locator('.fv-save-error')
  await expect(banner.getByRole('button', { name: 'Use the version on disk' })).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Use the version on disk' }).click()
  await page.getByRole('button', { name: 'Use the version on disk' }).last().click()
  await expect(source(page)).toContainText('LATEST DISK')
  await expect(source(page)).not.toContainText('mine ')
  await expect(state(page)).toHaveText('Saved')
  expect(await onDisk(page, abs)).toBe('LATEST DISK\nbeta\n')
})

test('in full screen, Escape closes the menu first, then the full screen', async ({ page }) => {
  const name = `doc-bar-esc-${Date.now()}.md`
  await makeScratchFile(page, name, '# Esc\n\nBody.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Body.')
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Fullscreen' }).click()
  await expect(page.locator('.file-content-view.fv-fullscreen')).toBeVisible()
  await page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: 'More file actions' }).click()
  const menu = page.getByTestId('fv-more-menu')
  await expect(menu).toBeVisible()
  // The menu is on top of the sheet: a real click reaches its items.
  const item = menu.getByRole('menuitem', { name: 'Copy path' })
  const box = (await item.boundingBox())!
  const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.wn-context-menu'), [box.x + box.width / 2, box.y + box.height / 2])
  expect(hit, 'the menu item is the topmost thing at its own point').toBe(true)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.file-content-view.fv-fullscreen')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-content-view.fv-fullscreen')).toHaveCount(0)
})

test('a tight pane keeps both conflict choices inside it', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 820 })
  const name = `doc-bar-tightconf-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'line one\nline two\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('line two')
  await externalWrite(page, abs, 'THEIRS one\nline two\n')
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.type('ours-')
  const banner = page.locator('.fv-save-error')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(state(page)).toContainText('Not saved')
  const pane = (await page.locator('.file-content-view').boundingBox())!
  for (const label of ['Keep my version', 'Use the version on disk']) {
    const b = (await banner.getByRole('button', { name: label }).boundingBox())!
    expect(b.x, label).toBeGreaterThanOrEqual(pane.x - 1)
    expect(b.x + b.width, label).toBeLessThanOrEqual(pane.x + pane.width + 1)
  }
  await page.screenshot({ path: `${SHOTS}/13-tight-conflict.png` })
})

test('typing while the write that ends a pause is on its way still reaches disk', async ({ page }) => {
  const name = `doc-bar-inflight-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'alpha\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('alpha')
  await page.route('**/api/file-content**', (r) => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Permission denied' }) })
    : r.continue()))
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' ONE')
  const banner = page.locator('.fv-save-error')
  await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 10_000 })
  // The server takes writes again, slowly: type while Try again's write is out.
  await page.unroute('**/api/file-content**')
  let release!: () => void
  const held = new Promise<void>((res) => { release = res })
  let first = true
  await page.route('**/api/file-content**', async (r) => {
    if (r.request().method() === 'PUT' && first) { first = false; await held }
    await r.continue()
  })
  await banner.getByRole('button', { name: 'Try again' }).click()
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' TWO')
  release()
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('alpha ONE TWO\n')
  await expect(state(page)).toHaveText('Saved', { timeout: 10_000 })
})

test('a confirm opened from a full screen is on top of it', async ({ page }) => {
  const name = `doc-bar-fsconfirm-${Date.now()}.md`
  const abs = await makeScratchFile(page, name, 'line one\n\nline two\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('line two')
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Fullscreen' }).click()
  await expect(page.locator('.file-content-view.fv-fullscreen')).toBeVisible()
  await page.locator('.fv-fullscreen .fv-doc-bar').getByRole('button', { name: 'Source', exact: true }).click()
  await expect(source(page)).toContainText('line two')
  await externalWrite(page, abs, 'THEIRS one\n\nline two\n')
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.type('ours-')
  const banner = page.locator('.fv-save-error')
  await expect(banner.getByRole('button', { name: 'Use the version on disk' })).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Use the version on disk' }).click()
  const confirmBtn = page.locator('.app-modal').getByRole('button', { name: 'Use the version on disk' })
  await expect(confirmBtn).toBeVisible()
  const b = (await confirmBtn.boundingBox())!
  const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.app-modal'), [b.x + b.width / 2, b.y + b.height / 2])
  expect(hit, 'the confirm is the topmost thing at its button').toBe(true)
  await page.screenshot({ path: `${SHOTS}/14-fullscreen-confirm.png` })
  // Escape closes the dialog, not the full screen under it.
  await page.keyboard.press('Escape')
  await expect(page.locator('.app-modal')).toHaveCount(0)
  await expect(page.locator('.file-content-view.fv-fullscreen')).toBeVisible()
})

test('an open comparison in History stays open while the file saves', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const name = `doc-bar-hcmp-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'one\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('one')
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' two')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('one two\n')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const flyout = page.getByTestId('file-history-flyout')
  await expect(flyout.locator('.fh-row')).toHaveCount(2, { timeout: 10_000 })
  await flyout.locator('.fh-row').nth(1).click()
  await expect(flyout.locator('.fh-diff')).toBeVisible()
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' three')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('one two three\n')
  await page.waitForTimeout(2500) // past the panel's refetch after a live write
  await expect(flyout.locator('.fh-diff')).toBeVisible()
  await expect(flyout.locator('.fh-diff').getByRole('button', { name: 'Restore this version' })).toBeVisible()
  // ...and it compares with the file as it is now, the last words included.
  await expect(flyout.locator('.fh-diff')).toContainText('three')
})

test('a tight pane shows a media file by name, its controls in ⋯', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 820 })
  const name = `doc-bar-clip-${Date.now()}.mp4`
  await makeScratchFile(page, name, 'not really a video')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(bar(page)).toHaveAttribute('data-fit', 'tight')
  const crumb = bar(page).locator('.sfe-crumb.is-last')
  await expect(crumb).toBeVisible()
  expect((await crumb.boundingBox())!.width).toBeGreaterThan(40)
  await expect(bar(page).locator('.fv-skip-btn')).toHaveCount(0)
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await expect(page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Back 3 seconds' })).toBeVisible()
})

test('a JSON file is saved only when it parses', async ({ page }) => {
  // A config file is often loaded the moment it changes: a half-typed one must
  // not reach disk. The text waits ("Saving when valid") and lands once it parses.
  const name = `doc-bar-config-${Date.now()}.json`
  const abs = await makeScratchFile(page, name, '{\n  "enabled": true\n}\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('"enabled": true')
  await source(page).locator('.cm-line', { hasText: '"enabled"' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(',')
  await expect(state(page)).toHaveAttribute('data-state', 'waiting', { timeout: 5_000 })
  await expect(state(page)).toContainText('Saving when valid')
  // Nothing is being written: a still ring, not the spinner.
  await expect(state(page).locator('.fv-save-state-ring')).toBeVisible()
  await expect(state(page).locator('.fv-save-state-spin')).toHaveCount(0)
  await page.waitForTimeout(1_500)
  expect(await onDisk(page, abs), 'invalid JSON stayed off disk').toBe('{\n  "enabled": true\n}\n')
  await page.screenshot({ path: `${SHOTS}/16-json-waits.png` })
  await page.keyboard.type('\n  "debug": false')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('"debug": false')
  await expect(state(page)).toHaveAttribute('data-state', 'saved')
  JSON.parse(await onDisk(page, abs))

  // A file that never parsed as plain JSON (comments, like a tsconfig) is not
  // held: it saves as it always did.
  const loose = `doc-bar-loose-${Date.now()}.json`
  const looseAbs = await makeScratchFile(page, loose, '{\n  // a comment\n  "a": 1\n}\n')
  await nodeByName(explorer, loose).click()
  await expect(source(page)).toContainText('a comment')
  await source(page).locator('.cm-line', { hasText: 'a comment' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' more')
  await expect.poll(() => onDisk(page, looseAbs), { timeout: 10_000 }).toContain('a comment more')
})

// ── A preview that renders and does not edit (HTML, HTM, MDX) ───────────────
// There is no editor on screen in such a preview, and the text being saved must
// not depend on one: a write armed before the switch still lands every word, a
// Try again pressed there still writes. (Markdown's preview is an editor itself.)

async function showSourceTab(page: Page) {
  const toggle = bar(page).getByRole('button', { name: 'Show source', exact: true })
  if (await toggle.count()) await toggle.click()
  else await bar(page).getByRole('button', { name: 'Source', exact: true }).click()
  await expect(source(page)).toBeVisible()
}
async function showPreviewTab(page: Page) {
  const toggle = bar(page).getByRole('button', { name: 'Show preview', exact: true })
  if (await toggle.count()) await toggle.click()
  else await bar(page).getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(source(page)).toHaveCount(0)
}

for (const ext of ['html', 'htm', 'mdx'] as const) {
  const body = ext === 'mdx' ? '# alpha\n' : '<h1>alpha</h1>\n'

  test(`${ext}: words typed while a write is on its way survive a switch to the preview`, async ({ page }) => {
    const name = `doc-bar-pv-inflight-${Date.now()}.${ext}`
    const abs = await makeScratchFile(page, name, body)
    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, name).click()
    await showSourceTab(page)
    await expect(source(page)).toContainText('alpha')
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>((r) => { release = r })
    const seen = new Promise<void>((r) => { started = r })
    let first = true
    await page.route('**/api/file-content**', async (r) => {
      if (r.request().method() === 'PUT' && first) { first = false; started(); await held }
      await r.continue()
    })
    await source(page).locator('.cm-line').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.type('ONE-')
    await seen
    await page.keyboard.type('TWO-')
    await expect(source(page)).toContainText('ONE-TWO-')
    await showPreviewTab(page)
    release()
    // Both halves reach disk with no editor on screen...
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe(`ONE-TWO-${body}`)
    // ...the editor comes back with them, saved, and the next word saves too.
    await showSourceTab(page)
    await expect(source(page)).toContainText('ONE-TWO-')
    await expect(state(page)).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
    await source(page).locator('.cm-line').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.type('THREE-')
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe(`THREE-ONE-TWO-${body}`)
  })

  test(`${ext}: Try again pressed in the preview writes the text`, async ({ page }) => {
    const name = `doc-bar-pv-retry-${Date.now()}.${ext}`
    const abs = await makeScratchFile(page, name, body)
    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, name).click()
    await showSourceTab(page)
    await expect(source(page)).toContainText('alpha')
    await page.route('**/api/file-content**', (r) => (r.request().method() === 'PUT'
      ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Permission denied' }) })
      : r.continue()))
    await source(page).locator('.cm-line').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.type('OURS-')
    const banner = page.locator('.fv-save-error')
    await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 10_000 })
    await showPreviewTab(page)
    await page.unroute('**/api/file-content**')
    await banner.getByRole('button', { name: 'Try again' }).click()
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe(`OURS-${body}`)
    await expect(banner).toHaveCount(0)
    await expect(state(page)).toHaveAttribute('data-state', 'saved')
    // Saving is live again: the next word from the editor lands on its own.
    await showSourceTab(page)
    await source(page).locator('.cm-line').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.type('NEXT-')
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe(`NEXT-OURS-${body}`)
  })
}

test('a half-typed config value never reaches disk, even one that parses', async ({ page }) => {
  // `enabled: f` is valid YAML (a string), and a config file is often applied the
  // moment it changes: a config-like file waits for a real pause before it is written.
  const name = `doc-bar-flag-${Date.now()}.yaml`
  const abs = await makeScratchFile(page, name, 'enabled: true\n')
  const bodies: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/file-content')) bodies.push(r.postData() ?? '')
  })
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('enabled: true')
  await source(page).locator('.cm-line', { hasText: 'enabled' }).click()
  await page.keyboard.press('End')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type('f')
  await page.waitForTimeout(1_200) // a pause mid-word, longer than a prose file waits
  await page.keyboard.type('alse')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('enabled: false\n')
  for (const b of bodies) {
    const content = (JSON.parse(b) as { content?: string }).content ?? ''
    expect(content, 'no half-typed value was written').not.toMatch(/enabled: (f|fa|fal|fals)?\n/)
  }
})

// ── What a reload, a preview and History show is the latest text ────────────

async function storedDraft(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('walnut-file-drafts', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return new Promise<string | null>((resolve, reject) => {
      const req = db.transaction('drafts', 'readonly').objectStore('drafts').get(`local ${p}`)
      req.onsuccess = () => { resolve(req.result?.text ?? null); db.close() }
      req.onerror = () => reject(req.error)
    })
  }, path)
}

for (const [ext, early] of [['txt', false], ['html', false], ['txt', true]] as const) {
  // `early`: the write lands before the newer words were recorded at all (the
  // stored draft is then exactly the written text, and the newer words exist
  // only in the editor until the page records them).
  test(`${ext}${early ? ' (write lands first)' : ''}: an older write landing keeps the newer draft, and a reload brings it back`, async ({ page }) => {
    const body = ext === 'html' ? '<h1>alpha</h1>\n' : 'alpha\n'
    const name = `doc-bar-newer-draft-${Date.now()}.${ext}`
    const abs = await makeScratchFile(page, name, body)
    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, name).click()
    if (ext === 'html') await showSourceTab(page)
    await expect(source(page)).toContainText('alpha')
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>((r) => { release = r })
    const seen = new Promise<void>((r) => { started = r })
    let puts = 0
    await page.route('**/api/file-content**', async (r) => {
      if (r.request().method() !== 'PUT') { await r.continue(); return }
      puts++
      if (puts === 1) { started(); await held; await r.continue() }
      else await r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Permission denied' }) })
    })
    await source(page).locator('.cm-line').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.type('ONE-')
    await seen
    if (early) {
      await expect.poll(() => storedDraft(page, abs), { timeout: 10_000 }).toBe(`ONE-${body}`)
      await page.keyboard.type('TWO-')
      release()
    } else {
      await page.keyboard.type('TWO-')
      await expect.poll(() => storedDraft(page, abs), { timeout: 10_000 }).toContain('ONE-TWO-')
      if (ext === 'html') await showPreviewTab(page)
      release()
    }
    // The first write lands; the next one is refused.
    await expect(page.locator('.fv-save-error').getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 15_000 })
    expect(await onDisk(page, abs)).toBe(`ONE-${body}`)
    // The newer words are still kept where a reload finds them...
    expect(await storedDraft(page, abs)).toContain('ONE-TWO-')
    await page.unroute('**/api/file-content**')
    page.on('dialog', (d) => d.accept())
    await page.reload()
    await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
    const again = await filesPanelAgain(page)
    await expect(again).toBeVisible()
    if (ext === 'html') await showSourceTab(page)
    // ...and come back, and reach disk.
    await expect(source(page)).toContainText('ONE-TWO-', { timeout: 15_000 })
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe(`ONE-TWO-${body}`)
  })
}

test('html: a write that lands while the preview shows reloads the preview', async ({ page }) => {
  const name = `doc-bar-pv-render-${Date.now()}.html`
  const abs = await makeScratchFile(page, name, '<h1>alpha</h1>\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await showSourceTab(page)
  await expect(source(page)).toContainText('alpha')
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((r) => { release = r })
  const seen = new Promise<void>((r) => { started = r })
  await page.route('**/api/file-content**', async (r) => {
    if (r.request().method() === 'PUT') { started(); await held }
    await r.continue()
  })
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.type('beta')
  await seen
  await showPreviewTab(page)
  const frame = page.frameLocator('.fv-html-preview')
  await expect(frame.locator('h1')).toHaveText('alpha')
  release()
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('<h1>beta</h1>\n')
  await expect(state(page)).toHaveAttribute('data-state', 'saved')
  await expect(frame.locator('h1')).toHaveText('beta', { timeout: 10_000 })
})

test('History compares with the text in the editor, saved or not', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const name = `doc-bar-hnow-${Date.now()}.json`
  const abs = await makeScratchFile(page, name, '{"one": 1}\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(source(page)).toContainText('"one": 1')
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Delete')
  await page.keyboard.type('{"two": 2, ')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('"two": 2')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const flyout = page.getByTestId('file-history-flyout')
  await expect(flyout.locator('.fh-row')).toHaveCount(2, { timeout: 10_000 })
  await flyout.locator('.fh-row').nth(1).click()
  await expect(flyout.locator('.fh-diff')).toContainText('"two": 2')
  // Text that cannot be saved yet (it does not parse) is still what a restore
  // would replace: the comparison shows it.
  await source(page).locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('THREE')
  await expect(state(page)).toContainText('Saving when valid', { timeout: 10_000 })
  await expect(flyout.locator('.fh-diff')).toContainText('THREE', { timeout: 5_000 })
})

for (const ext of ['html', 'htm', 'mdx'] as const) {
  test(`${ext}: Keep my version pressed in the preview writes the text`, async ({ page }) => {
    const name = `doc-bar-pv-keep-${Date.now()}.${ext}`
    const abs = await makeScratchFile(page, name, 'alpha\n')
    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, name).click()
    await showSourceTab(page)
    await expect(source(page)).toContainText('alpha')
    await externalWrite(page, abs, 'THEIRS\n')
    await source(page).locator('.cm-line').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.type('OURS-')
    const banner = page.locator('.fv-save-error')
    await expect(banner.getByRole('button', { name: 'Keep my version' })).toBeVisible({ timeout: 10_000 })
    await showPreviewTab(page)
    await banner.getByRole('button', { name: 'Keep my version' }).click()
    await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe('OURS-alpha\n')
    await expect(banner).toHaveCount(0)
    await expect(state(page)).toHaveAttribute('data-state', 'saved')
  })
}

test('a write receipt for a file left behind cannot erase a newer draft put meanwhile', async ({ page }) => {
  // The file was left with a write on its way, reopened and typed into: the
  // receipt of that old write must not delete the new words' draft, whatever
  // lands while it decides. Real IndexedDB, the receipt's transaction held open
  // at its end while the newer draft is put.
  const result = await page.evaluate(async () => {
    const drafts = await import('/src/utils/file-drafts.ts')
    const path = `/repo/receipt-race-${Date.now()}.txt`
    await drafts.saveFileDraft(null, path, { text: 'ONE-alpha', baseHash: 'old' })
    let seen!: () => void
    let release!: () => void
    const reached = new Promise<void>((r) => { seen = r })
    const gate = new Promise<void>((r) => { release = r })
    let armed = true
    const original = IDBDatabase.prototype.transaction
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      const tx = original.apply(this, args)
      if (armed && this.name === 'walnut-file-drafts') {
        armed = false
        Object.defineProperty(tx, 'oncomplete', {
          configurable: true,
          set(handler) {
            complete.set!.call(tx, function (this: IDBTransaction, event: Event) {
              seen()
              void gate.then(() => handler.call(tx, event))
            })
          },
          get() { return complete.get!.call(tx) },
        })
      }
      return tx
    } as typeof original
    const receipt = drafts.deleteFileDraftIfText(null, path, 'ONE-alpha')
    await reached
    await drafts.saveFileDraft(null, path, { text: 'ONE-TWO-alpha', baseHash: 'new' })
    release()
    await receipt
    IDBDatabase.prototype.transaction = original
    return (await drafts.loadFileDraft(null, path))?.text ?? null
  })
  expect(result, 'the newer draft survives the old receipt').toBe('ONE-TWO-alpha')
})

// ── Round 7 (real use, 2026-11-07) ──────────────────────────────────────────

// Every spelling the WYSIWYG serializer rewrites, once each: a `#` and a `~` it
// escapes, a `|---|` rule it pads, a short table row it fills, a double blank line
// it drops, frontmatter, and the final newline. A new rewrite the editor learns
// shows up here as a changed line.
// End moves the caret in CodeMirror on every OS, but in the rich editor on macOS
// it only scrolls: the caret stays where the click put it.
const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'

const RICH_NOTE = [
  '---', 'id: n_fixture', '---', '# Stability ledger', '',
  'Owner: task x ("ledger"). Stability first since 2026-10-28; new features wait.', '',
  'Rule: a row is **Proven** only when it names a commit.', '',
  '| # | Problem | Status |', '|---|---|---|', '| 1 | `~/.codex/config` drift, ~400px wide | Proven |', '| 2 | short row |', '',
  '## Open', '', '',
  '- first item', '- second item', '',
  'Path ~/notes, 5 * 3 and snake_case_name.', '',
  // Inline code that ends in a space: the serializer writes `x = `matched (the
  // space after it lost), so the editor's own spelling is not the same text.
  'The sed was greedy (`.*sec = ` matched `usec = `), so the time was wrong.', '',
  '| when | what |', '|---|---|', '| 11-03 | `a = ` then b |', '',
].join('\n')

test('typing one sentence into a rich note writes that sentence and nothing else', async ({ page }) => {
  const name = `doc-bar-rich-${Date.now()}.md`
  const abs = await makeScratchFile(page, name, RICH_NOTE)
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  const doc = page.locator('.fv-wysiwyg-editor .ProseMirror')
  await expect(doc).toContainText('only when it names a commit')
  await doc.locator('p', { hasText: 'Rule: a row is' }).click()
  await page.waitForTimeout(200) // the caret from the click settles before the key moves it
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' Checked by hand.')
  const want = RICH_NOTE.replace('names a commit.', 'names a commit. Checked by hand.')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('Checked by hand.')
  await expect(state(page)).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  expect(await onDisk(page, abs), 'every other line keeps its own bytes').toBe(want)
  // A second edit is kept against what is on disk now, not the serializer's spelling.
  await doc.locator('li', { hasText: 'second item' }).click()
  await page.waitForTimeout(200)
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' again')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toBe(want.replace('- second item', '- second item again'))
  // Typed in the middle of a line, right after a space: the line now holds two
  // spaces in a row, which loading collapses (2026-11-07, the live walk). Every
  // other line still keeps its own bytes.
  const before = await onDisk(page, abs)
  await doc.locator('p', { hasText: 'Path ~/notes' }).click()
  await page.waitForTimeout(200)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.type(' mid')
  await expect.poll(() => onDisk(page, abs), { timeout: 10_000 }).toContain('mid')
  await expect(state(page)).toHaveAttribute('data-state', 'saved', { timeout: 10_000 })
  const others = (t: string) => t.split('\n').filter((l) => !l.startsWith('Path '))
  expect(others(await onDisk(page, abs)), 'every other line keeps its own bytes').toEqual(others(before))
})

test('text typed and reloaded at once comes back and saves itself', async ({ page }) => {
  const name = `doc-bar-reload-now-${Date.now()}.md`
  const abs = await makeScratchFile(page, name, '# Reload\n\nFirst line.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  const doc = page.locator('.fv-wysiwyg-editor .ProseMirror')
  await expect(doc).toContainText('First line.')
  await doc.locator('p', { hasText: 'First line.' }).click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' Typed just before the reload.')
  // No wait at all: the draft timer and the write are both still pending.
  page.on('dialog', (d) => { void d.accept() })
  await page.reload()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
  const again = await filesPanelAgain(page)
  if (!(await page.locator('.fv-wysiwyg-editor .ProseMirror').isVisible().catch(() => false))) {
    await nodeByName(again, name).click()
  }
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Typed just before the reload.', { timeout: 15_000 })
  await expect.poll(() => onDisk(page, abs), { timeout: 15_000 }).toContain('Typed just before the reload.')
})

test('Close file in ⋯ goes back to No file open, with the file first in Recent', async ({ page }) => {
  await isolateUiPrefs(page)
  const name = `doc-bar-close-${Date.now()}.md`
  await makeScratchFile(page, name, '# Close\n\nBody.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Body.')
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Close file' }).click()
  await expect(explorer.locator('.sfe-preview-empty-title')).toHaveText('No file open')
  const recent = explorer.getByTestId('sfe-recent')
  await expect(recent.getByRole('button').first()).toContainText(name)
  await recent.getByRole('button', { name }).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('Body.')
})

test("Escape on the tree's right-click menu closes the menu, not the Files panel", async ({ page }) => {
  const name = `doc-bar-tree-esc-${Date.now()}.md`
  await makeScratchFile(page, name, '# Esc\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click({ button: 'right' })
  const menu = page.getByTestId('file-ctx-menu')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.waitForTimeout(400)
  await expect(explorer, 'the Files panel is still open').toBeVisible()
})

test('Escape on History closes History, not the Files panel or full screen', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const name = `doc-bar-hist-esc-${Date.now()}.md`
  await makeScratchFile(page, name, '# Esc\n\nOne line.\n')
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(page.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText('One line.')
  const flyout = page.getByTestId('file-history-flyout')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(flyout).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)
  await page.waitForTimeout(400)
  await expect(explorer, 'the Files panel is still open').toBeVisible()
  // In full screen: the first Escape closes History, the second leaves full screen.
  await bar(page).getByRole('button', { name: 'More file actions' }).click()
  await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Fullscreen' }).click()
  await expect(page.locator('.file-content-view.fv-fullscreen')).toBeVisible()
  await page.locator('.fv-fullscreen').getByRole('button', { name: 'History', exact: true }).click()
  await expect(flyout).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)
  await expect(page.locator('.file-content-view.fv-fullscreen'), 'still full screen').toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-content-view.fv-fullscreen')).toHaveCount(0)
  await expect(explorer).toBeVisible()
})

test('on a wide screen prose stops at a reading width while a wide table keeps the pane', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1380 })
  const name = `doc-bar-measure-${Date.now()}.md`
  const long = 'A long paragraph that keeps going. '.repeat(40)
  const row = `| ${'wide cell text '.repeat(12)} | ${'more wide text '.repeat(12)} |`
  await makeScratchFile(page, name, `# Measure\n\n${long}\n\n| a | b |\n|---|---|\n${row}\n`)
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  const pm = page.locator('.fv-wysiwyg-editor .ProseMirror')
  await expect(pm).toContainText('A long paragraph')
  const paneW = (await pm.boundingBox())!.width
  expect(paneW, 'the text pane is wider than the reading width here').toBeGreaterThan(1000)
  const pW = (await pm.locator('p').first().boundingBox())!.width
  expect(pW).toBeLessThanOrEqual(880)
  const tableW = (await pm.locator('.tableWrapper, table').first().boundingBox())!.width
  expect(tableW, 'the table is not held to the prose width').toBeGreaterThan(900)
  // Left-aligned in the pane like the line above it, not centred away from it.
  const pmX = (await pm.boundingBox())!.x
  expect(Math.abs((await pm.locator('p').first().boundingBox())!.x - pmX)).toBeLessThan(4)
  await page.screenshot({ path: `${SHOTS}/r8-reading-width.png` })
})
