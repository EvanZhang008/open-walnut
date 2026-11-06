/**
 * Acceptance recording for the file page redesign (2026-11-06): the same walk
 * through the Files panel, recorded on the build before the change and on the
 * build after it, in macOS WebKit (the Mac app's engine). Run with
 * `walnut-dev webkit tests/e2e/browser/file-doc-bar-demo.spec.ts`; the video
 * lands in the run's test-results.
 *
 * It asserts only what both builds have (the panel opens, the note renders), so
 * one file records both; the new page's own behaviour is pinned by
 * file-doc-bar.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test'

test.use({ viewport: { width: 1280, height: 800 }, video: { mode: 'on', size: { width: 1280, height: 800 } } })

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

const NOTE = `# Q4 roadmap

Walnut core, updated Nov 4.

Three goals for the quarter: every page feels fast, files become a real place to work, and the iOS app reaches TestFlight.

## Now

- File explorer opens in under 200 ms on a cold cache
- Live edit merges another writer's changes
- One toolbar for every file type

## Later

Offline drafts on the phone, shared folders between hosts, and a faster search index for large vaults.
`

async function scratch(page: Page, name: string, body: string): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  const json = await res.json()
  const abs = `${json?.session?.cwd ?? json?.cwd}/${name}`
  await page.request.post('/api/files/create', { data: { path: abs } })
  await page.request.put('/api/file-content', { data: { path: abs, content: body } })
  return abs
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms)

test('file page walk-through', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* blocked */ }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
  const name = `Q4 roadmap ${Date.now()}.md`
  await scratch(page, name, NOTE)

  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  await pause(page, 1500)

  await explorer.locator('.sfe-name', { hasText: name }).first().click()
  const doc = page.locator('.fv-wysiwyg-editor .ProseMirror')
  await expect(doc).toContainText('Three goals for the quarter')
  await pause(page, 2500)

  const redesigned = (await page.locator('.fv-doc-bar').count()) > 0
  if (redesigned) {
    // Type: the state reads Saving…, then Saved. Nothing to press.
    await doc.locator('li').nth(2).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' and every file kind', { delay: 60 })
    await pause(page, 2500)
    // Everything rarer is behind ⋯.
    await page.locator('.file-content-view .fv-more-btn').click()
    await pause(page, 2500)
    await page.keyboard.press('Escape')
    await pause(page, 800)
    // Fullscreen from ⋯ and back.
    await page.locator('.file-content-view .fv-more-btn').click()
    await page.getByTestId('fv-more-menu').getByRole('menuitem', { name: 'Fullscreen' }).click()
    await pause(page, 2000)
    await page.locator('.fv-fullscreen .fv-fullscreen-btn').click()
    await pause(page, 1200)
  }
  // A narrower window: the old toolbar wraps and cuts off; the new line fits.
  await page.setViewportSize({ width: 1000, height: 800 })
  await pause(page, 2500)
  await page.setViewportSize({ width: 820, height: 800 })
  await pause(page, 2500)
  await page.setViewportSize({ width: 1280, height: 800 })
  await pause(page, 1500)
})
