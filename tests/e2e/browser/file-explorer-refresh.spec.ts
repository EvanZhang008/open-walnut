/**
 * Playwright browser tests for the Files panel Refresh button.
 *
 * Regression: the button existed but rendered as a bare "⟳" glyph on a
 * borderless near-white chip — effectively invisible, so users reported the
 * panel had no refresh at all. And even when found, it only re-listed folders:
 * the open file in the preview pane kept showing pre-edit bytes.
 *
 * These tests assert the button is discoverable (accessible name + visible
 * label + real icon) AND that clicking it picks up on-disk changes to both the
 * directory listing and the currently-previewed file.
 */
import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = 'test-results/file-explorer-refresh'

/** Resolve the fixture session's cwd from the API (it lives under an isolated tmp base). */
async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  const cwd = body?.session?.cwd ?? body?.cwd
  expect(typeof cwd).toBe('string')
  return cwd as string
}

/** Open the fixture session's panel from the homepage and switch to the Files tab. */
async function openFilesPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // The kebab's session row is targeted POSITIONALLY (first item), not by label: its
  // text is derived from live state ("Session idle" / "AI is working…" / "Session
  // error" / "Unread — open to mark read"), so a label matcher flakes as soon as the
  // fixture session's state drifts.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  return explorer
}

test.beforeEach(async ({ page }) => {
  // Pin the Files tree EXPANDED before first render: the collapse pref key
  // syncs to the SHARED fixture server (ui-prefs), so a parallel run of
  // file-explorer-tree-collapse.spec.ts would otherwise boot this page with
  // no tree at all. A locally-written value wins the boot merge.
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('Refresh button is discoverable: accessible name, visible label, real icon', async ({ page }) => {
  const explorer = await openFilesPanel(page)

  const refresh = explorer.getByRole('button', { name: 'Refresh file panel' })
  await expect(refresh).toBeVisible()

  // A written label, not a lone glyph — that's what made it invisible before.
  await expect(refresh.locator('.sfe-btn-label')).toHaveText('Refresh')
  // An SVG icon (currentColor) rather than a text codepoint at the mercy of font fallback.
  await expect(refresh.locator('svg')).toHaveCount(1)

  // Actually visible against the toolbar: it must carry a border, and be big
  // enough to hit. (The old chip was borderless --bg-tertiary on near-white.)
  const box = await refresh.boundingBox()
  expect(box!.width).toBeGreaterThan(50)
  expect(box!.height).toBeGreaterThanOrEqual(18)
  const borderWidth = await refresh.evaluate((el) =>
    parseFloat(getComputedStyle(el).borderTopWidth))
  expect(borderWidth).toBeGreaterThan(0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/step1-button-visible.png` })
})

test('Refresh re-lists the directory, surfacing a file created after load', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const cwd = await fixtureCwd(page)

  // Baseline: the seeded file is listed, the not-yet-created one is not.
  await expect(explorer.locator('.sfe-name', { hasText: 'refresh-target.txt' })).toBeVisible({ timeout: 10_000 })
  await expect(explorer.locator('.sfe-name', { hasText: 'appeared-later.txt' })).toHaveCount(0)

  const created = path.join(cwd, 'appeared-later.txt')
  await fs.writeFile(created, 'NEW FILE\n')
  try {
    // Still absent until the user asks — the tree does not poll.
    await expect(explorer.locator('.sfe-name', { hasText: 'appeared-later.txt' })).toHaveCount(0)

    await explorer.getByRole('button', { name: 'Refresh file panel' }).click()
    await expect(explorer.locator('.sfe-name', { hasText: 'appeared-later.txt' })).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step2-new-file-listed.png` })
  } finally {
    await fs.rm(created, { force: true })
  }
})

test('markdown preview renders nested fences as code, not literal <a> tags', async ({ page }) => {
  const explorer = await openFilesPanel(page)

  // The .mdx twin, NOT nested-fence.md: plain markdown's Preview tab became the
  // WYSIWYG editor (e46b8f00), which never runs the linkifier — asserting on it
  // made this regression test vacuous. MDX is excluded from WYSIWYG, so it still
  // renders through the read-only markdown pipeline where the bug lived.
  await explorer.locator('.sfe-name', { hasText: 'nested-fence.mdx' }).click()
  const preview = explorer.locator('.fv-md-preview')
  await expect(preview).toBeVisible({ timeout: 10_000 })

  // THE regression: a 4-backtick fence used to be treated as closed by its first
  // inner ```, so paths in the rest of the block were linkified in the markdown
  // SOURCE and marked escaped the anchor into visible markup.
  await expect(preview).not.toContainText('<a class=')
  await expect(preview).not.toContainText('data-rel-path=')

  // The whole outer block still renders as ONE code block (inner fences included).
  const preText = await preview.locator('pre').first().innerText()
  expect(preText).toContain('tool.py get --path acme/docs/README')
  expect(preText).toContain('then read pkg/sub/module.ts for the impl')

  // Paths inside the code block are still clickable — linkified post-parse.
  await expect(preview.locator('a.file-link', { hasText: 'pkg/sub/module.ts' })).toHaveCount(1)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/step4-nested-fence-md.png` })
})

test('Refresh reloads the file open in the preview pane', async ({ page }) => {
  const explorer = await openFilesPanel(page)
  const cwd = await fixtureCwd(page)
  const target = path.join(cwd, 'refresh-target.txt')
  await fs.writeFile(target, 'ORIGINAL_CONTENT\n')

  await explorer.locator('.sfe-name', { hasText: 'refresh-target.txt' }).click()
  const preview = explorer.locator('.session-file-explorer-preview')
  await expect(preview).toContainText('ORIGINAL_CONTENT', { timeout: 10_000 })

  await fs.writeFile(target, 'EDITED_BY_AGENT\n')
  try {
    // The preview is not live — the stale bytes stay until Refresh.
    await expect(preview).toContainText('ORIGINAL_CONTENT')

    await explorer.getByRole('button', { name: 'Refresh file panel' }).click()
    // THE regression this fixes: previously Refresh only touched the tree, so
    // the preview kept the pre-edit content forever.
    await expect(preview).toContainText('EDITED_BY_AGENT', { timeout: 10_000 })
    await expect(preview).not.toContainText('ORIGINAL_CONTENT')
    await page.screenshot({ path: `${SCREENSHOT_DIR}/step3-preview-reloaded.png` })
  } finally {
    await fs.writeFile(target, 'ORIGINAL_CONTENT\n')
  }
})
