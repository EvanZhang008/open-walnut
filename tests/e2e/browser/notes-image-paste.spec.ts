/**
 * E2E: pasting an image into a VAULT note stores it in the vault
 * (`_attachment/` beside the note) and serializes as an Obsidian
 * `![[...]]` embed — NOT as `![](/api/images/…)` (the chat image store).
 *
 * Regression guards:
 *  - "paste goes to /api/images": the vault markdown must stay portable
 *    (attachment lives inside NOTES_DIR and syncs/exports with the vault).
 *  - "raw view missing the pasted embed": the raw buffer must seed from the
 *    LIVE editor doc, not the stale loaded-content prop.
 */
import { test, expect, type Page } from '@playwright/test'

const API = 'http://localhost:3457'

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// Per-test note paths — the two tests run in parallel workers against the
// same server; a shared note file would race (seed/save clobber each other).
function notePaths(slug: string) {
  const folder = `PasteTest-${slug}`
  return { folder, notePath: `${folder}/Image Note.md` }
}

async function seedNote(notePath: string) {
  await fetch(`${API}/api/notes-v2/content/${notePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'before paste\n' }),
  })
}

async function getNoteViaApi(notePath: string): Promise<string> {
  const res = await fetch(`${API}/api/notes-v2/content/${notePath}`)
  const body = (await res.json()) as { content: string }
  return body.content
}

/** Open /notes via real UI clicks (SPA nav) and select the seeded note. */
async function openSeededNote(page: Page, folder: string) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.sidebar-nav a[href="/notes"], a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')

  // Expand the folder, then click the note
  await page.locator('.notes-tree-folder', { hasText: folder }).click()
  await page.locator(`[data-drop-folder="${folder}"] .notes-tree-file`, { hasText: 'Image Note' }).click()

  const editor = page.locator('.notes-editor .tiptap').first()
  await expect(editor).toBeVisible({ timeout: 5000 })
  await expect(editor).toContainText('before paste')
  return editor
}

async function pasteImage(page: Page) {
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'pasted.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })
    document.querySelector('.notes-editor .tiptap')?.dispatchEvent(event)
  }, PNG_B64)
  await expect(page.locator('.notes-wikiembed-view img')).toBeVisible({ timeout: 10_000 })
}

test('pasting an image into a vault note → _attachment/ + ![[...]] embed (not /api/images)', async ({ page }) => {
  const { folder, notePath } = notePaths('store')
  await seedNote(notePath)
  const editor = await openSeededNote(page, folder)
  await editor.click()

  await pasteImage(page)

  // Rendered <img> is served from the vault attachment endpoint, not /api/images
  const src = await page.locator('.notes-wikiembed-view img').getAttribute('src')
  expect(src).toContain('/api/notes-v2/attachment')
  expect(src).not.toContain('/api/images')

  // Wait for the debounced save, then assert the on-disk markdown
  await page.waitForTimeout(2500)
  const saved = await getNoteViaApi(notePath)
  expect(saved).toMatch(new RegExp(`!\\[\\[${folder}/_attachment/pasted-image-\\d{14}-[0-9a-f]{6}\\.png\\]\\]`))
  expect(saved).not.toContain('/api/images')

  // The attachment actually exists in the vault (round-trip through the streamer)
  const m = saved.match(/!\[\[([^\]]+)\]\]/)
  expect(m).toBeTruthy()
  const res = await fetch(`${API}/api/notes-v2/attachment?path=${encodeURIComponent(m![1])}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('image/png')
})

test('after pasting an image, the raw view shows the ![[...]] embed (live-doc seed)', async ({ page }) => {
  const { folder, notePath } = notePaths('raw')
  await seedNote(notePath)
  const editor = await openSeededNote(page, folder)
  await editor.click()

  await pasteImage(page)

  // Toggle to raw IMMEDIATELY (before the 500ms debounced save could reload
  // anything) — regression: the raw buffer used to seed from the stale
  // `content` prop, so the just-pasted embed was missing from the source view
  // (and editing that stale source then wiped the embed from disk).
  await page.locator('.notes-raw-toggle-btn').click()
  const cm = page.locator('.notes-raw-view .cm-content')
  await expect(cm).toBeVisible({ timeout: 3000 })
  await expect(cm).toContainText(new RegExp(`!\\[\\[${folder}/_attachment/pasted-image-\\d{14}-[0-9a-f]{6}\\.png\\]\\]`), { timeout: 3000 })

  // Type in raw view (append a line), toggle back — the embed must survive
  // the raw→rendered flush, both in the editor and on disk.
  await cm.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('End')
  await page.keyboard.type('\nraw edit line')
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(page.locator('.notes-wikiembed-view img')).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(2500)
  const saved = await getNoteViaApi(notePath)
  expect(saved).toMatch(new RegExp(`!\\[\\[${folder}/_attachment/pasted-image-\\d{14}-[0-9a-f]{6}\\.png\\]\\]`))
  expect(saved).toContain('raw edit line')
})
