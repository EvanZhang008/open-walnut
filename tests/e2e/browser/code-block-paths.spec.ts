/**
 * A path inside a code block is a link, a line range is linked whole, and a
 * click lands the Files view on every line of the range.
 *
 * Reported 2026-10-27: a reply's Go block opened with
 * `// /workplace/<user>/remotessh/<repo>/…/pkg/remote/object.go:31-34` and the
 * user's message quoting it (``` opened mid-line, closed on the last line)
 * rendered the path wrong; in prose `…/objectmeta_validation.go:237-239` linked
 * only up to `:237`. Rule and unit matrix: tests/web/markdown/code-block-paths.test.ts.
 *
 * Seed: pw-codepath-session (test-server.ts), neutral paths, every file line
 * carrying a `LINE_<n>_MARKER`.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-codepath-session'
const TASK_ID = 'pw-task-codepath'
const SHOTS = '/tmp/walnut-code-block-paths'

test.setTimeout(120_000)

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

/** The flashed lines' markers, in order, once the landing flash is on screen. */
async function flashedMarkers(panel: Locator): Promise<string[]> {
  const flash = panel.locator('.cm-jump-flash')
  await expect(flash.first()).toBeVisible({ timeout: 15_000 })
  const texts = await flash.allTextContents()
  return texts.join('\n').match(/LINE_\d+_MARKER/g) ?? []
}

test('a path comment in a Go code block opens the file on lines 31-34', async ({ page }) => {
  let loads = 0
  page.on('load', () => { loads++ })
  const panel = await openSessionPanel(page)
  const loadsAfterOpen = loads

  const block = panel.locator('pre code.language-go')
  await expect(block).toBeVisible({ timeout: 20_000 })
  const link = block.locator('a.file-link')
  await expect(link).toHaveCount(1)
  await expect(link).toHaveText(/\/remotessh\/acme\/src\/marina\/pkg\/remote\/object\.go:31-34$/)
  await expect(link).toHaveAttribute('data-file-line', '31')
  await expect(link).toHaveAttribute('data-file-end-line', '34')
  // The block's text is still exactly the code (what select-and-copy yields).
  await expect(block).toContainText('// /')
  await expect(block).toContainText('func (o *Object) Key() string {')
  await block.scrollIntoViewIfNeeded()
  await block.locator('..').screenshot({ path: `${SHOTS}/01-code-block-link.png` })

  // The user's message: ``` opened mid-line and closed on the last line is a
  // code span to marked. Its path is one link, and no escaped markup shows.
  const userRow = panel.locator('.markdown-body', { hasText: 'did u find it?' })
  await expect(userRow).toBeVisible()
  await expect(userRow.locator('code a.file-link')).toHaveCount(1)
  await expect(userRow.locator('code a.file-link')).toHaveAttribute('data-file-end-line', '34')
  expect(await userRow.textContent()).not.toContain('<a')
  expect(await userRow.textContent()).not.toContain('class=')
  await userRow.screenshot({ path: `${SHOTS}/02-user-message.png` })

  await link.click()
  await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('LINE_31_MARKER')).toBeVisible({ timeout: 20_000 })
  expect(await flashedMarkers(panel)).toEqual(['LINE_31_MARKER', 'LINE_32_MARKER', 'LINE_33_MARKER', 'LINE_34_MARKER'])
  await page.screenshot({ path: `${SHOTS}/03-opened-at-31-34.png` })

  expect(loads - loadsAfterOpen, 'the page navigated away under the click').toBe(0)
})

test('a prose path with :237-239 is linked whole and opens on lines 237-239', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const link = panel.locator('a.file-link', { hasText: 'objectmeta_validation.go:237-239' })
  await expect(link).toHaveCount(1)
  await expect(link).toHaveText(/objectmeta_validation\.go:237-239$/)
  await expect(link).toHaveAttribute('data-file-line', '237')
  await expect(link).toHaveAttribute('data-file-end-line', '239')
  // Nothing of the range is left outside the anchor.
  const paragraph = link.locator('..')
  expect(await paragraph.textContent()).toMatch(/:237-239 in the copy\.$/)
  await paragraph.screenshot({ path: `${SHOTS}/04-prose-range.png` })

  await link.click()
  await expect(panel.getByText('LINE_237_MARKER')).toBeVisible({ timeout: 20_000 })
  expect(await flashedMarkers(panel)).toEqual(['LINE_237_MARKER', 'LINE_238_MARKER', 'LINE_239_MARKER'])
  await page.screenshot({ path: `${SHOTS}/05-opened-at-237-239.png` })
})
