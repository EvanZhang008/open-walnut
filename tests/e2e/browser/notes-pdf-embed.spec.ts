/**
 * E2E: `![[foo.pdf]]` embeds in a vault note must respect the browser's PDF
 * viewer setting.
 *
 * Regression guard (user-reported): with the browser set to download PDFs
 * instead of rendering them (Firefox "Save File" / "Open in Preview…", Chrome
 * "Download PDFs" / AlwaysOpenPdfExternally policy), every <iframe src=…pdf>
 * fires a download + external-app launch the moment the note opens — a note
 * with 3 embedded PDFs popped 3 Preview windows and littered ~/Downloads on
 * every open. The embed view (WikiEmbedView) and the tree attachment preview
 * (AttachmentPreview) now check navigator.pdfViewerEnabled and fall back to
 * the click-to-open card when inline rendering isn't available.
 */
import { test, expect, type Page } from '@playwright/test'

const API = 'http://localhost:3457'

const FOLDER = 'PdfEmbedTest'
const NOTE_PATH = `${FOLDER}/Pdf Note.md`

async function seedNote() {
  await fetch(`${API}/api/notes-v2/content/${NOTE_PATH}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'lease docs\n\n![[agreement.pdf]]\n\n![[form-k.pdf]]\n',
    }),
  })
}

/** Open /notes via real UI clicks (SPA nav) and select the seeded note. */
async function openSeededNote(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('.sidebar-nav a[href="/notes"], a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')

  await page.locator('.notes-tree-folder', { hasText: FOLDER }).click()
  await page.locator(`[data-drop-folder="${FOLDER}"] .notes-tree-file`, { hasText: 'Pdf Note' }).click()

  const editor = page.locator('.notes-editor .tiptap').first()
  await expect(editor).toBeVisible({ timeout: 5000 })
  await expect(editor).toContainText('lease docs')
  return editor
}

test('PDF viewer available → embeds render as inline iframes', async ({ page }) => {
  await seedNote()

  // Headless Chromium has NO built-in PDF viewer (pdfViewerEnabled=false —
  // exactly the download-mode this fix guards against), so simulate a normal
  // headed browser where the viewer is on.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
      get: () => true,
      configurable: true,
    })
  })

  await openSeededNote(page)

  await expect(page.locator('.notes-wikiembed-pdf-frame')).toHaveCount(2)
  await expect(page.locator('.notes-wikiembed-card')).toHaveCount(0)
})

test('PDF viewer disabled (download mode) → click-to-open cards, no iframe, no downloads', async ({ page }) => {
  await seedNote()

  // Simulate Firefox "Save File" / Chrome "Download PDFs": the standard signal
  // both expose is navigator.pdfViewerEnabled === false.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
      get: () => false,
      configurable: true,
    })
  })

  const downloads: string[] = []
  page.on('download', (d) => downloads.push(d.suggestedFilename()))

  await openSeededNote(page)

  // Both embeds degrade to the click-to-open card — no iframe means nothing
  // for the browser's download flow to trigger on note open.
  await expect(page.locator('.notes-wikiembed-card')).toHaveCount(2)
  await expect(page.locator('.notes-wikiembed-pdf-frame')).toHaveCount(0)
  await expect(page.locator('.notes-wikiembed-card-name').first()).toHaveText('agreement.pdf')

  // Give any stray iframe-triggered download a beat to fire, then assert none.
  await page.waitForTimeout(1000)
  expect(downloads).toEqual([])
})
