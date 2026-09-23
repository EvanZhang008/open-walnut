/**
 * One browser, one note.
 *
 * A vault note is editable from the /notes editor (PUT /api/notes-v2/content/*)
 * AND from the Files pane of the session column that /notes itself mounts (that
 * session's cwd IS the vault, so the same bytes have a second write path, PUT
 * /api/file-content). Neither told the other anything: the /notes editor kept
 * showing pre-edit text until something happened to re-read, and the first thing
 * its own next save learned was a 409 against the user's own change.
 *
 * Two channels close that, and this spec drives one in each direction:
 *  - /notes editor → Files pane: the browser-local doc-saved signal, which is
 *    synchronous and carries the bytes. Proven by holding every read of the file
 *    for HOLD_MS: the pane converges in well under a second while no read can
 *    possibly have answered.
 *  - Files pane → /notes editor: PUT /api/file-content announces the DOCUMENT it
 *    wrote (`notes:updated`, the same event and source name the notes API emits),
 *    which is the channel that also reaches other browsers.
 *
 * Why the note is typed BEFORE the Files pane exists: opening any session split
 * view promotes the panel to fullscreen (SessionPanel.toggleView), and exiting
 * fullscreen closes the split — so the two surfaces cannot both be *clickable* at
 * once, only both MOUNTED. The /notes PUT is therefore held at the network layer
 * until the Files pane is up, which is also what makes the save land while both
 * views are alive.
 *
 * The second test is the same "one browser, one document" rule applied to the
 * bookmark list: a Bookmarks row for a deleted note is not a cosmetic leftover,
 * it is a row whose first keystroke RE-CREATES the file.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const FOLDER = 'SyncSurfaces'
const NOTE = `${FOLDER}/Two Views.md`
const SEED = '# Two Views\n\nseed line\n'
/** Reads of the note are stalled this long, so nothing can converge by reading. */
const HOLD_MS = 3000
/** Budget for a same-browser signal. Far below HOLD_MS. */
const INSTANT_MS = 700
/** Budget for the server round trip (WS event → the other surface re-reads). */
const PROPAGATE_MS = 2500
const SCREENSHOT_DIR = '/tmp/walnut-notes-sync/cross-surface'

async function putNote(notePath: string, content: string) {
  const res = await fetch(`${API}/api/notes-v2/content/${notePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  expect(res.ok, `seed ${notePath}: ${res.status}`).toBe(true)
}

async function deleteNoteQuietly(notePath: string) {
  await fetch(`${API}/api/notes-v2/content/${notePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'DELETE',
  }).catch(() => {})
}

async function deleteFolderQuietly(folder: string) {
  await fetch(`${API}/api/notes-v2/folder/${encodeURIComponent(folder)}`, { method: 'DELETE' }).catch(() => {})
}

async function bookmark(notePath: string) {
  const res = await fetch(`${API}/api/favorites/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: notePath }),
  })
  expect(res.ok, `bookmark ${notePath}: ${res.status}`).toBe(true)
}

async function unbookmarkQuietly(notePath: string) {
  await fetch(`${API}/api/favorites/notes?path=${encodeURIComponent(notePath)}`, { method: 'DELETE' })
    .catch(() => {})
}

async function favoriteNotes(): Promise<string[]> {
  const res = await fetch(`${API}/api/favorites`)
  if (!res.ok) return []
  return ((await res.json()) as { notes?: string[] }).notes ?? []
}

/** A memory document's raw bytes, straight off the server. */
async function readMemory(memPath: string): Promise<string> {
  const res = await fetch(`${API}/api/memory/${memPath}`)
  expect(res.ok, `GET /api/memory/${memPath}: ${res.status}`).toBe(true)
  return ((await res.json()) as { memory: { content: string } }).memory.content
}

/** Write a memory document as ANOTHER surface would (no lock token: last write). */
async function putMemory(memPath: string, content: string) {
  const res = await fetch(`${API}/api/memory/${memPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  expect(res.ok, `PUT /api/memory/${memPath}: ${res.status}`).toBe(true)
}

async function gotoNotes(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')
}

/** The tree's real file rows — never the Bookmarks / Recent path-only rows. */
function treeFile(page: Page, name: string): Locator {
  return page.locator('.notes-tree-file:not(.notes-bookmark-row)', { hasText: name })
}

/** Reveal a note in the tree. Folder expansion is server-synced, so a blind
 *  click can COLLAPSE an already-open folder — retry until the file shows. */
async function revealInTree(page: Page, folder: string, name: string): Promise<Locator> {
  const folderRow = page.locator('.notes-tree-folder', { hasText: folder })
  const file = treeFile(page, name)
  for (let i = 0; i < 5 && !(await file.isVisible().catch(() => false)); i++) {
    await folderRow.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  await expect(file).toBeVisible()
  return file
}

/** The /notes editor body (TipTap). Scoped to the editor pane: the Files pane's
 *  markdown editor is the same component. */
function notesEditor(page: Page): Locator {
  return page.locator('.notes-editor-pane .notes-editor-content .tiptap')
}

test.describe('the /notes editor and the session Files pane on one note', () => {
  test.afterAll(async () => {
    await deleteFolderQuietly(FOLDER)
  })

  test('a save in either surface reaches the other, with no conflict banner', async ({ page }) => {
    await putNote(NOTE, SEED)

    await page.addInitScript(() => {
      try {
        localStorage.setItem('open-walnut-live-edit', '0')
        localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
        localStorage.removeItem('open-walnut-notes-cc-session')
        localStorage.removeItem('open-walnut-notes-chat-mode')
      } catch { /* private mode */ }
    })
    await gotoNotes(page)

    // ── Surface 1: the note in the /notes editor. ──
    const file = await revealInTree(page, FOLDER, 'Two Views')
    await file.click()
    await expect(notesEditor(page)).toContainText('seed line', { timeout: 15_000 })

    // Hold the note's PUT so the save lands only once BOTH surfaces are mounted.
    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    let putsSent = 0
    await page.route('**/api/notes-v2/content/**', async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return }
      putsSent++
      await putGate
      await route.continue()
    })

    // Type in the /notes editor while it is the visible surface. Its debounced
    // save fires immediately and then waits on the gate above.
    const fromNotes = `FROM_NOTES_EDITOR_${Date.now()}`
    await notesEditor(page).locator('p', { hasText: 'seed line' }).first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${fromNotes}`)
    await expect.poll(() => putsSent, { timeout: 10_000 }).toBeGreaterThan(0)

    // ── Surface 2: the same note in the Files pane of a session rooted at the
    //    vault (the session column /notes mounts). ──
    await file.click({ button: 'right' })
    await page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' }).click()
    const panel = page.locator('.notes-chat-pane .session-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await panel.getByRole('button', { name: 'Files' }).click()
    const explorer = panel.locator('.session-file-explorer')
    await expect(explorer).toBeVisible({ timeout: 15_000 })

    const fsNode = (name: string) => explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..').first()
    const noteNode = fsNode('Two Views.md')
    for (let i = 0; i < 5 && !(await noteNode.isVisible().catch(() => false)); i++) {
      await fsNode(FOLDER).click().catch(() => {})
      await page.waitForTimeout(300)
    }
    await noteNode.click()
    // The raw-bytes tab: a markdown file opens in the WYSIWYG editor, and this
    // test is about the bytes both surfaces agree on.
    await panel.locator('.fv-html-tab', { hasText: 'Source' }).click()
    const fileEditor = panel.locator('.fv-source-editor .cm-content')
    // The held PUT means this pane is looking at the PRE-edit bytes.
    await expect(fileEditor).toContainText('seed line', { timeout: 15_000 })
    await expect(fileEditor).not.toContainText(fromNotes)
    // "Open in Notes" appears only once the async vault check resolved, which is
    // also when this pane started listening for the note (not just the file).
    await expect(panel.locator('.fv-notes-btn')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/1-both-surfaces.png` })

    // ── /notes editor → Files pane (the browser-local doc-saved signal). ──
    // From here every READ of this file is stalled, so a pane that converged by
    // re-reading could not make the sub-second budget.
    await page.route('**/api/file-content**', async (route) => {
      if (route.request().method() !== 'GET') { await route.continue(); return }
      await new Promise((r) => setTimeout(r, HOLD_MS))
      await route.continue()
    })
    releasePut()

    await expect(fileEditor).toContainText(fromNotes, { timeout: INSTANT_MS })
    await expect(panel.locator('.fv-dirty-dot')).toHaveCount(0)
    await expect(panel.locator('.fv-save-error')).toHaveCount(0)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/2-files-pane-converged.png` })

    // ── Files pane → /notes editor (the server's notes:updated). ──
    await page.unroute('**/api/file-content**')
    const fromFiles = `FROM_FILES_PANE_${Date.now()}`
    await fileEditor.locator('.cm-line').filter({ hasText: 'seed line' }).first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${fromFiles}`)
    await panel.locator('.fv-save-btn').click()

    await expect(notesEditor(page)).toContainText(fromFiles, { timeout: PROPAGATE_MS })
    // A clean editor converges silently. The banner (and above all its .conflict
    // variant, the 409) means the surfaces fought instead of agreeing.
    await expect(page.locator('.notes-reload-banner')).toHaveCount(0)
    await expect(panel.locator('.fv-save-error')).toHaveCount(0)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/3-notes-editor-converged.png` })

    // Disk is the arbiter: one note, both edits.
    const res = await page.request.get(
      `/api/notes-v2/content/${FOLDER}/${encodeURIComponent('Two Views.md')}`,
    )
    expect(res.ok(), await res.text()).toBe(true)
    const onDisk = ((await res.json()) as { content: string }).content
    expect(onDisk).toContain(fromNotes)
    expect(onDisk).toContain(fromFiles)
  })
})

test.describe('note bookmarks follow the vault', () => {
  const BM_FOLDER = 'BookmarkSync'
  const DOOMED = `${BM_FOLDER}/Doomed.md`
  const KEPT = `${BM_FOLDER}/Kept.md`

  test.afterAll(async () => {
    await unbookmarkQuietly(DOOMED)
    await unbookmarkQuietly(KEPT)
    await deleteNoteQuietly(KEPT)
    await deleteFolderQuietly(BM_FOLDER)
  })

  test('deleting a bookmarked note removes its Bookmarks row', async ({ page }) => {
    await putNote(DOOMED, '# Doomed\n\nthis note is about to go\n')
    await putNote(KEPT, '# Kept\n\nthis one stays\n')
    await bookmark(DOOMED)
    await bookmark(KEPT)

    await gotoNotes(page)

    // The real Bookmarks group, not the Recent group (same row class).
    const bookmarks = page.locator('.notes-bookmarks-group:not(.notes-recent-group)')
    const doomedRow = bookmarks.locator('.notes-bookmark-row', { hasText: 'Doomed' })
    const keptRow = bookmarks.locator('.notes-bookmark-row', { hasText: 'Kept' })
    await expect(doomedRow).toBeVisible({ timeout: 10_000 })
    await expect(keptRow).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOT_DIR}/4-bookmarked.png` })

    // Delete the note from the tree.
    const file = await revealInTree(page, BM_FOLDER, 'Doomed')
    await file.click({ button: 'right' })
    await page.locator('.notes-context-menu button.danger', { hasText: 'Delete' }).click()
    await page.locator('.app-modal .app-modal-btn.primary.danger').click()

    // The row is gone — not merely stale-looking. A row that survives is a live
    // opener for a file that no longer exists.
    await expect(doomedRow).toHaveCount(0, { timeout: 10_000 })
    await expect(keptRow).toBeVisible()
    await expect(treeFile(page, 'Doomed')).toHaveCount(0)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/5-bookmark-pruned.png` })

    // Server-side too: the bookmark list is config, and a UI-only prune would
    // come back on the next load.
    const notes = await favoriteNotes()
    expect(notes).not.toContain(DOOMED)
    expect(notes).toContain(KEPT)
  })
})

/**
 * The same rule for a MEMORY document. `~/.open-walnut/memory/**` is edited by the
 * /memory page (PUT /api/memory/*) and, because the Files panel can be rooted at the
 * data dir, by PUT /api/file-content as well: two write paths, last write wins, and
 * neither used to say anything. The page's 15s poll only refreshed the metadata TREE,
 * so the open editor kept showing pre-edit text and its next autosave wrote that
 * stale text back over the other surface's change.
 */
test.describe('one memory document, two write paths', () => {
  // A fixture-seeded topic file. Restored verbatim afterwards: it is shared state.
  const TOPIC = 'topics/search-architecture.md'
  let original = ''

  test.beforeAll(async () => {
    original = await readMemory(TOPIC)
  })

  test.afterAll(async () => {
    if (original) await putMemory(TOPIC, original).catch(() => {})
  })

  test('an outside write reaches the open memory editor, and is not written back over', async ({ page }) => {
    // Settings → Memory is the real route in (the page has no sidebar entry).
    await page.goto('/settings')
    await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-testid="settings-nav-memory"]').click()

    const tree = page.locator('.memory-tree-panel')
    await expect(tree).toBeVisible({ timeout: 15_000 })
    const item = tree.locator('.memory-tree-item', { hasText: 'search-architecture' })
    await expect(item).toBeVisible({ timeout: 10_000 })
    await item.click()

    const editor = page.locator('.memory-detail-pane .notes-editor .tiptap')
    await expect(editor).toBeVisible({ timeout: 15_000 })
    await expect(editor).toContainText('BM25', { timeout: 10_000 })

    // Another surface writes the file. No click, no re-select, no poll window.
    const external = `FROM_OTHER_SURFACE_${Date.now()}`
    await putMemory(TOPIC, `${original.trimEnd()}\n\n${external}\n`)
    await expect(editor).toContainText(external, { timeout: PROPAGATE_MS })

    // Converging on screen is only half of it: the editor must have ADOPTED those
    // bytes, so its own next autosave keeps them instead of reverting them.
    const typed = `TYPED_HERE_${Date.now()}`
    await editor.locator('p', { hasText: external }).first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${typed}`)
    await expect.poll(() => readMemory(TOPIC), { timeout: 15_000 }).toContain(typed)
    expect(await readMemory(TOPIC)).toContain(external)
  })
})
