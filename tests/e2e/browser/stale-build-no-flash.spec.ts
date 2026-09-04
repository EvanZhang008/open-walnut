/**
 * Clicking a file path opens it and NEVER navigates the page.
 *
 * Reported 2026-09-03 from the Mac app: "I click a path, the whole page flashes,
 * nothing opens. After it settles I click again and the Files panel appears."
 * Only on the Mac, because the Mac app's window is the only one that stays open
 * across every deploy (its own page-process recycle deliberately waits for the
 * user to go idle, so it sits on a replaced build while being used).
 *
 * The chain, from the production log: a deploy replaced the build the window ran
 * (desktop watchdog: `bundle BSvVdhMS` vs `servedBundle PNFB9VA4`) → the user
 * clicked a `.go` path → the panel opened and `/api/file-content` answered 200 →
 * CodeMirror asked for the Go grammar, a code-split chunk the deploy had deleted
 * → 404 → `vite:preloadError` → `location.reload()` ~300ms after the click. The
 * reload WAS the flash, and it discarded the panel that had just opened.
 *
 * What this tier can prove: the click opens the file, the LAZY grammar module
 * really loads (Go tokens get highlighted — the fetch that used to fail), and the
 * main frame never navigates. The hashed-asset half of the fix cannot live here:
 * this fixture serves the SPA through Vite in DEV mode, so there are no hashed
 * chunks to lose. That half is pinned against a real production-mode server in
 * `tests/web/static-mirror-previous-build.test.ts`, and the reload rule itself in
 * `tests/web/stale-build-upgrade.test.ts`.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SHOTS = '/tmp/walnut-stale-build'

test.setTimeout(120_000)

/** Survives everything except a page load — the reload detector. */
const MARKER = '__pwNoFlashMarker'

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

test('clicking a .go path opens it, loads its lazy grammar, and never reloads', async ({ page }) => {
  // Document loads only. `framenavigated` is the wrong signal here: opening a
  // session column pushes `?s1=…` through the router, which is a same-document
  // navigation and fires it. `load` fires once per real page load.
  let loads = 0
  page.on('load', () => { loads++ })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const loadsAfterOpen = loads
  await page.evaluate((k) => { (window as unknown as Record<string, unknown>)[k] = 'alive' }, MARKER)

  const panel = await openSessionPanel(page)
  const link = panel.locator('a.file-link', { hasText: 'lazy-grammar.go' }).first()
  await expect(link).toBeVisible({ timeout: 20_000 })
  await link.click()

  // The panel opened on the file the click named…
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('LAZY_GRAMMAR_MARKER')).toBeVisible({ timeout: 20_000 })

  // …and the LAZY grammar module arrived: CodeMirror only emits keyword spans
  // once `LanguageDescription.load()` (a dynamic import) resolves, so this is
  // the in-browser proof that the fetch which used to 404 completed. Plain text
  // renders the same characters with no token classes at all.
  await expect(
    panel.locator('.cm-editor .ͼ1, .cm-editor [class*="ͼ"]').first(),
    'no syntax tokens — the lazily-loaded grammar never arrived',
  ).toBeVisible({ timeout: 20_000 })

  // The reported symptom. The reload landed ~300ms after the click, so settle
  // past that window before judging, then check both signals: the page never
  // loaded again, and the state a reload would have destroyed is still here.
  await page.waitForTimeout(3_000)
  expect(loads - loadsAfterOpen, 'the page reloaded under the click — the reported flash').toBe(0)
  expect(
    await page.evaluate((k) => (window as unknown as Record<string, unknown>)[k] === 'alive', MARKER),
    'window state was lost, so the document was replaced',
  ).toBe(true)
  await expect(panel.getByText('LAZY_GRAMMAR_MARKER'), 'the opened file must survive the click').toBeVisible()

  await page.screenshot({ path: `${SHOTS}/01-go-file-opened-no-flash.png` })
})
