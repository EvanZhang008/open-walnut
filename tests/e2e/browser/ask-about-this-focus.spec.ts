/**
 * Playwright browser tests: clicking "Ask about this" must land the caret in the
 * session composer, so the user can start typing immediately.
 *
 * The 2026-08-13 report ("when I click this ask this, this doesn't auto put the
 * cursor to the input box… I want the cursor to change and I can directly start
 * typing") turned out to be TWO distinct failures, both reproduced here first:
 *
 *  1. CHAT COLUMN COLLAPSED — the composer is `display:none`, so ChatInput's
 *     focus() is silently swallowed by the browser, activeElement stays on
 *     <body>, and every keystroke after the click is LOST. Fix: handleSelectCode
 *     un-collapses the chat column, and ChatInput retries focus until the
 *     textarea is actually laid out (offsetParent non-null).
 *  2. FILE VIEW FULLSCREEN — focus/caret were technically correct, but the
 *     fullscreen shell is a fixed inset:0 overlay at z-index 10000 covering the
 *     composer, so the user saw an unchanged file and read it as "nothing
 *     happened". Fix: committing a selection leaves fullscreen.
 *
 * The assertion that matters in every case is the same one the user cares about:
 * type right after the click, and the characters land in the composer.
 *
 * Surface used: the Source tab (CodeMirror), which reports selections through
 * `onSelectText` → the shared SelectionAskPill. The markdown Preview tab is the
 * WYSIWYG editor and raises a bubble-menu "Ask" button instead of the pill, so
 * it is a different affordance and not what the report was about.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

/** Open the fixture session's panel from the homepage (real clicks, no page.goto). */
async function openSessionPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // Positional, not by label: the session row's text is derived from live state.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

async function openFiles(panel: Locator) {
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

/** Open incident-report.md on its Source tab (CodeMirror, which raises the pill). */
async function openReportSource(explorer: Locator) {
  await explorer.locator('.sfe-name', { hasText: 'incident-report.md' }).click()
  await expect(explorer.locator('.fv-html-toolbar')).toBeVisible({ timeout: 10_000 })
  await explorer.getByRole('button', { name: 'Source', exact: true }).click()
  const editor = explorer.locator('.cm-content')
  await expect(editor).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('.cm-line').first()).toContainText('Controller restart loop')
  return editor
}

/**
 * Drag-select a few lines inside `within` and click the pill.
 * A real mouse drag is required: the pill only appears on a genuine selection,
 * and its placement is derived from the pointer position at mouseup.
 */
async function selectAndAsk(page: Page, within: Locator) {
  const lines = within.locator('.cm-line')
  const first = await lines.nth(2).boundingBox()
  const last = await lines.nth(5).boundingBox()
  if (!first || !last) throw new Error('editor lines have no box')
  await page.mouse.move(first.x + 10, first.y + 4)
  await page.mouse.down()
  await page.mouse.move(last.x + 180, last.y + 6, { steps: 14 })
  await page.mouse.up()
  const pill = page.locator('.session-diff-ask-pill')
  await expect(pill).toBeVisible({ timeout: 5_000 })
  await pill.click()
}

/** The composer textarea of the given session panel. */
function composer(panel: Locator) {
  return panel.locator('textarea.chat-input-textarea')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('ask about this focuses the composer and typing lands in it', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const editor = await openReportSource(explorer)

  await selectAndAsk(page, editor)

  const input = composer(panel)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^About incident-report\.md/)

  // THE user-facing contract: start typing immediately, no extra click.
  await page.keyboard.type('why is this happening?')
  await expect(input).toHaveValue(/why is this happening\?$/)
})

test('a collapsed chat column re-opens so the caret is not lost', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  const editor = await openReportSource(explorer)

  // Collapse the chat column — this is what made focus() a no-op and swallowed
  // every keystroke (the composer was display:none).
  await panel.locator('.session-chat-collapse-btn').click()
  await expect(panel.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(1)

  await selectAndAsk(page, editor)

  // The panel must have re-opened the chat column on its own.
  await expect(panel.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(0)
  const input = composer(panel)
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()

  await page.keyboard.type('explain the restart loop')
  await expect(input).toHaveValue(/explain the restart loop$/)
})

test('fullscreen file view steps aside so the composer is visible', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const explorer = await openFiles(panel)
  await openReportSource(explorer)

  await explorer.getByRole('button', { name: /Fullscreen/ }).click()
  const fullscreenView = page.locator('.file-content-view.fv-fullscreen')
  await expect(fullscreenView).toHaveCount(1)

  await selectAndAsk(page, fullscreenView.locator('.cm-content'))

  // The overlay that covered the composer must be gone, not merely behind it.
  await expect(page.locator('.file-content-view.fv-fullscreen')).toHaveCount(0)
  const input = composer(panel)
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()

  await page.keyboard.type('summarize this section')
  await expect(input).toHaveValue(/summarize this section$/)
})
