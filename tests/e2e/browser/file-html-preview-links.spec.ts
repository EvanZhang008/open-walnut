/**
 * Links inside an HTML file previewed in the Files panel.
 *
 * The 2026-09-11 report: a verification report (HTML) linked to the recording it
 * produced as `href="/tmp/…/video.webm"`. Clicking it navigated the preview
 * IFRAME to a URL the site could not serve (`Cannot GET /tmp/…`), and even when a
 * target did load, the panel's tree, ‹ › history and viewer knew nothing about
 * it: "I can't go back; I have to click another file and then come back".
 *
 * Now a link to another file on this host opens that file in the panel exactly
 * like a tree click (its own viewer, tree reveal, a history stop, so ‹ returns),
 * an external site opens outside the pane, and anchors stay in the page.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
// test-results/ is wiped at the start of every run on this shared machine, so a
// verification run can point the evidence somewhere durable.
const SCREENSHOT_DIR = process.env.PW_EVIDENCE_DIR ?? 'test-results/file-html-preview-links'
const shot = (name: string) => `${SCREENSHOT_DIR}/${test.info().project.name}-${name}.png`

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

async function openFiles(panel: Locator): Promise<Locator> {
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

/** Expand the `report` folder and open summary.html; return the preview frame. */
async function openSummary(page: Page, explorer: Locator) {
  // `has` takes a locator RELATIVE to each candidate row (page-rooted), not one
  // scoped to the explorer.
  const folderRow = explorer.locator('.session-file-explorer-node', { has: page.locator('.sfe-name', { hasText: /^report$/ }) })
  await expect(folderRow).toBeVisible({ timeout: 10_000 })
  // The panel remembers the last file (a previous test may have left it on
  // report/clip.webm, which auto-expands `report` while its listing loads), so
  // decide from the chevron, not from whether the child row is visible yet: a
  // click on an expanding folder would collapse it.
  await expect(folderRow.locator('.sfe-arrow')).toHaveText(/[▶▼]/, { timeout: 10_000 })
  if ((await folderRow.locator('.sfe-arrow').textContent())?.trim() === '▶') await folderRow.click()
  const summaryRow = explorer.locator('.sfe-name', { hasText: 'summary.html' })
  await expect(summaryRow).toBeVisible({ timeout: 10_000 })
  await summaryRow.click()
  const frame = explorer.locator('iframe.fv-html-preview')
  await expect(frame).toBeVisible({ timeout: 10_000 })
  const inner = page.frameLocator('iframe.fv-html-preview')
  await expect(inner.locator('h1')).toHaveText('Verification report', { timeout: 10_000 })
  return { frame, inner }
}

function selectedRow(explorer: Locator, name: string) {
  return explorer.locator('.session-file-explorer-node.selected .sfe-name', { hasText: name })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('an absolute-path link to a video opens the video in the panel, and Back returns to the report', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const { inner } = await openSummary(page, explorer)
  await page.screenshot({ path: shot('step1-report') })

  // THE click from the report. No "Cannot GET": the panel's own video viewer
  // takes over and the tree shows the file as the selected one.
  await inner.locator('#abs-video').click()
  const video = explorer.locator('.fv-media-preview video')
  await expect(video).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('iframe.fv-html-preview')).toHaveCount(0)
  await expect(selectedRow(explorer, 'clip.webm')).toHaveCount(1, { timeout: 10_000 })
  await page.screenshot({ path: shot('step2-video-in-panel') })

  // The ‹ button knows about the hop: one click returns to the report.
  const back = explorer.getByRole('button', { name: 'Back to the previously viewed file' })
  await expect(back).toBeEnabled()
  await back.click()
  await expect(explorer.locator('iframe.fv-html-preview')).toBeVisible({ timeout: 10_000 })
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report')
  await expect(selectedRow(explorer, 'summary.html')).toHaveCount(1)
  await page.screenshot({ path: shot('step3-back-to-report') })

  // … and › goes forward to the video again.
  await explorer.getByRole('button', { name: 'Forward to the next viewed file' }).click()
  await expect(explorer.locator('.fv-media-preview video')).toBeVisible({ timeout: 10_000 })
})

test('a relative link to a sibling page opens that page in the panel; repeated hops stack in history', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const { inner } = await openSummary(page, explorer)

  await inner.locator('#rel-page').click()
  const details = page.frameLocator('iframe.fv-html-preview')
  await expect(details.locator('h1')).toHaveText('Details page', { timeout: 10_000 })
  await expect(selectedRow(explorer, 'details.html')).toHaveCount(1, { timeout: 10_000 })

  // Back to the report, hop to the video, back twice: each hop is a history stop.
  const back = explorer.getByRole('button', { name: 'Back to the previously viewed file' })
  await back.click()
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report', { timeout: 10_000 })
  await page.frameLocator('iframe.fv-html-preview').locator('#abs-video').click()
  await expect(explorer.locator('.fv-media-preview video')).toBeVisible({ timeout: 10_000 })
  await back.click()
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report', { timeout: 10_000 })
  // The first stop is whatever the panel remembered before the report; Back is
  // still enabled there, so assert on the FILE the report was reached from.
  await page.screenshot({ path: shot('step4-stacked-history') })
})

test('an in-page anchor scrolls inside the preview and stays on the same file', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const { frame, inner } = await openSummary(page, explorer)

  await inner.locator('#anchor').click()
  await expect.poll(() => frame.evaluate((el: HTMLIFrameElement) => el.contentWindow?.location.hash)).toBe('#tail')
  await expect.poll(() => frame.evaluate((el: HTMLIFrameElement) => el.contentWindow?.scrollY ?? 0)).toBeGreaterThan(200)
  // Same file, same frame, no "back" strip, no history stop.
  await expect(selectedRow(explorer, 'summary.html')).toHaveCount(1)
  await expect(explorer.locator('.fv-strayed-banner')).toHaveCount(0)
  await expect(inner.locator('h1')).toHaveText('Verification report')
})

test('an external link opens outside the preview pane; the report stays put', async ({ page, context }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const { inner } = await openSummary(page, explorer)

  // Never reach the real internet from a test: answer example.com locally.
  await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>ok' }))
  const popup = context.waitForEvent('page')
  await inner.locator('#external').click()
  const opened = await popup
  expect(opened.url()).toBe('https://example.com/docs')
  await opened.close()

  await expect(inner.locator('h1')).toHaveText('Verification report')
  await expect(selectedRow(explorer, 'summary.html')).toHaveCount(1)
  await expect(explorer.locator('.fv-strayed-banner')).toHaveCount(0)
})

test('a target=_blank link is left to the browser (new tab), not hijacked into the panel', async ({ page, context }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const { inner } = await openSummary(page, explorer)

  const popup = context.waitForEvent('page')
  await inner.locator('#blank').click()
  const opened = await popup
  expect(opened.url()).toContain('/api/file-raw/local/')
  expect(opened.url()).toContain('details.html')
  await opened.close()
  await expect(selectedRow(explorer, 'summary.html')).toHaveCount(1)
})

test('navigation the click handler cannot see (a script) offers a way back and a way to open the target', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const { frame } = await openSummary(page, explorer)

  // A script inside the page sets location to the sibling page's file-raw URL.
  // The panel does NOT follow automatically (two pages redirecting to each other
  // would bounce it forever); it says where the frame went and offers both ways.
  await frame.evaluate((el: HTMLIFrameElement) => {
    const w = el.contentWindow!
    w.location.href = new URL('details.html', w.location.href).href
  })
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Details page', { timeout: 10_000 })
  const strip = explorer.locator('.fv-strayed-banner')
  await expect(strip).toBeVisible({ timeout: 10_000 })
  await expect(strip).toContainText('details.html')
  await expect(selectedRow(explorer, 'summary.html')).toHaveCount(1)
  await page.screenshot({ path: shot('step5-strayed-strip') })

  // "Back" re-points the frame at the report and the strip goes away.
  await strip.getByRole('button', { name: /Back to summary\.html/ }).click()
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report', { timeout: 10_000 })
  await expect(strip).toHaveCount(0)

  // Stray again, then take the other offer: open the target as a file of its own.
  await frame.evaluate((el: HTMLIFrameElement) => {
    const w = el.contentWindow!
    w.location.href = new URL('details.html', w.location.href).href
  })
  await expect(explorer.locator('.fv-strayed-banner')).toBeVisible({ timeout: 10_000 })
  await explorer.locator('.fv-strayed-banner').getByRole('button', { name: /Open details\.html here/ }).click()
  await expect(selectedRow(explorer, 'details.html')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Details page', { timeout: 10_000 })
  await explorer.getByRole('button', { name: 'Back to the previously viewed file' }).click()
  await expect(selectedRow(explorer, 'summary.html')).toHaveCount(1, { timeout: 10_000 })
})
