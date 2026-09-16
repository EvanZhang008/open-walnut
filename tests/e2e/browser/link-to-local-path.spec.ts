/**
 * A markdown link to a local path renders as ONE clickable file link that shows
 * the model's label and opens the file at the linked line.
 *
 * Reported 2026-09-15 (rich mode, but the markdown path shares the bug): the
 * model wrote `[eventprocessor.go:58-75](/repo/…/eventprocessor.go#L58)` inside
 * CJK parentheses and the chat showed `[eventprocessor.go:58-75](` + a bare path
 * link + `#L58))`. The absolute-path pre-pass in web/src/utils/markdown.ts had
 * rewritten the destination before marked ever saw the link.
 *
 * Seed: the last turn of pw-vscode-session (test-server.ts) carries the exact
 * shape, pointing at the fixture's lazy-grammar.go with a `#L6` anchor.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SHOTS = '/tmp/walnut-link-to-local-path'

test.setTimeout(120_000)

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

test('a [label](/path#L6) link renders as the label alone and opens the file at line 6', async ({ page }) => {
  let loads = 0
  page.on('load', () => { loads++ })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const loadsAfterOpen = loads

  const panel = await openSessionPanel(page)
  const link = panel.locator('a.file-link', { hasText: 'entry point:6-8' })
  await expect(link).toBeVisible({ timeout: 20_000 })
  await expect(link).toHaveCount(1)

  // The label is the whole anchor text; the destination rides the attributes.
  await expect(link).toHaveText('entry point:6-8')
  await expect(link).toHaveAttribute('data-file-path', /\/lazy-grammar\.go$/)
  await expect(link).toHaveAttribute('data-file-line', '6')

  // Nothing of the link syntax leaks into the paragraph around it: no brackets,
  // no `](`, no `#L6`, and the path itself is not visible as text. The CJK
  // parentheses (U+FF08/U+FF09) hug the label directly.
  const paragraph = link.locator('..')
  const text = (await paragraph.textContent()) ?? ''
  expect(text).toContain('\uFF08entry point:6-8\uFF09')
  expect(text).not.toContain('](')
  expect(text).not.toContain('#L6')
  expect(text).not.toContain('lazy-grammar.go')

  await link.scrollIntoViewIfNeeded()
  await paragraph.screenshot({ path: `${SHOTS}/01-rendered-link.png` })

  // Click: the Files split opens on that file, at line 6 (`func main() {`),
  // which the editor flashes as its landing cue.
  await link.click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('LAZY_GRAMMAR_MARKER')).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.cm-jump-flash')).toContainText('func main', { timeout: 10_000 })

  // A plain `<a href="/…/lazy-grammar.go#L6">` would have navigated the SPA.
  expect(loads - loadsAfterOpen, 'the page navigated away under the click').toBe(0)

  await page.screenshot({ path: `${SHOTS}/02-file-opened-at-line-6.png` })
})
