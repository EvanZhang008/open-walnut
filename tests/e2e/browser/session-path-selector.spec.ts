/**
 * Playwright specs for the reworked session path selector.
 *
 * Fixtures: test-server.ts creates a real on-disk tree under WALNUT_HOME
 * (ps-fixture/projects/{walnut,wallets,zmarinax,.hiddenproj}) and seeds
 * frequent-directories.json with ps-fixture/projects/walnut (high frecency)
 * + ps-fixture/other (stale). The fixture root is discovered through the
 * working-dirs API because the tmpdir name is dynamic.
 *
 * All interactions are real UI clicks/keys — page.goto('/') only for load.
 */
import { test, expect, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

let fixtureRoot = '' // .../ps-fixture (parent of 'projects')

test.beforeAll(async () => {
  const res = await fetch(`${API}/api/sessions/working-dirs`)
  const body = (await res.json()) as { dirs: Array<{ cwd: string }> }
  // Match the walnut seed specifically — other ps-fixture history entries exist
  // (e.g. monorepo-context-proj) and one may sort ahead of it, so `.includes`
  // alone would grab the wrong row and derive a bogus fixtureRoot.
  const walnut = body.dirs.find(d => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))
  if (!walnut) throw new Error('ps-fixture/projects/walnut seed missing from working-dirs')
  // .../ps-fixture/projects/walnut → .../ps-fixture
  fixtureRoot = walnut.cwd.replace(/\/projects\/walnut$/, '')
})

/** Open the picker fresh and wait for history to load. */
async function openPicker(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.quick-access-pill', { hasText: 'Quick session' }).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
}

const input = (page: Page) => page.locator('.sps-search-input')

test('open → frecency list with section label; frequent dir ranks first', async ({ page }) => {
  await openPicker(page)

  // Section label present (browse mode → history section)
  await expect(page.locator('.sps-section-label').first()).toBeVisible()

  // The high-frecency walnut fixture outranks the stale 'other' entry
  const items = page.locator('.sps-path-item')
  const firstText = await items.first().textContent()
  expect(firstText).toContain('ps-fixture/projects/walnut')
})

test('typing a dir path with trailing slash lists live children; history child is marked', async ({ page }) => {
  await openPicker(page)
  await input(page).fill(`${fixtureRoot}/projects/`)

  // Live children appear (walnut, wallets, zmarinax — hidden dir must NOT show)
  const list = page.locator('.sps-path-list')
  await expect(list.locator('.sps-path-item', { hasText: 'wallets' })).toBeVisible()
  await expect(list.locator('.sps-path-item', { hasText: 'zmarinax' })).toBeVisible()
  await expect(list.locator('.sps-path-item', { hasText: '.hiddenproj' })).not.toBeVisible()

  // walnut is in history → history marker + ranked first
  const walnutItem = list.locator('.sps-path-item', { hasText: 'walnut' }).first()
  await expect(walnutItem.locator('.sps-hist-marker')).toBeVisible()
  const firstItem = list.locator('.sps-path-item').first()
  await expect(firstItem).toContainText('walnut')
})

test('segment fuzzy: prefix hit beats substring hit; ghost text; ArrowRight accepts', async ({ page }) => {
  await openPicker(page)
  // 'wal' → prefix-hits walnut+wallets ('wal' is not a substring of zmarinax).
  await input(page).fill(`${fixtureRoot}/projects/wal`)

  const items = page.locator('.sps-path-list .sps-path-item')
  await expect(items.first()).toContainText('walnut') // history hit on top

  // Ghost text renders the completion of the top candidate
  await expect(page.locator('.sps-ghost-text')).toHaveText('nut')

  // ArrowRight at end-of-input accepts the ghost and descends (trailing slash —
  // same one-segment complete as Tab, ready to keep typing the next level)
  await input(page).press('ArrowRight')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/walnut/`)
})

test('exact leaf-prefix hit ranks first, above a high-frecency history subsequence match', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // 'mcp' leaf-prefix-hits 'mcps'; it only subsequence-hits the high-frecency
  // history dir 'monorepo-context-proj' (m…c…p). Relevance must beat frecency:
  // the FIRST row is 'mcps', and the ghost predicts its completion ('s').
  await input(page).fill(`${fixtureRoot}/projects/mcp`)
  const items = page.locator('.sps-path-list .sps-path-item')
  await expect(items.first()).toContainText('projects/mcps')
  await expect(page.locator('.sps-ghost-text')).toHaveText('s')

  // Tab lands on the exact-match dir, not the frequent unrelated one.
  await input(page).press('Tab')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/mcps/`)
})

test('exact typed segment + deep highlighted row: Tab descends ONE level, never the full path', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // 'walnut' typed exactly — no ghost (nothing left to complete). The fixture's
  // deep history row (…/projects/walnut, whose subdir web/ exists) may be
  // highlighted; Tab must produce '…/projects/walnut/' and stay in the picker,
  // NOT jump to any deeper row's full path.
  await input(page).fill(`${fixtureRoot}/projects/walnut`)
  await expect(page.locator('.sps-path-list .sps-path-item').first()).toBeVisible()
  await input(page).press('Tab')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/walnut/`)
  // Now browsing walnut/'s children — its real subdir shows
  await expect(page.locator('.sps-path-list .sps-path-item', { hasText: 'walnut/web' })).toBeVisible()
})

test('Tab case-corrects: lowercase typed segment completes to the REAL-cased dir', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // Fixture has 'AcmeCapsDev/'. Type it all-lowercase; ghost shows the remainder;
  // Tab must produce the REAL casing (…/AcmeCapsDev/), never 'acmec' + suffix —
  // that fabricated path doesn't exist on case-sensitive hosts and used to flip
  // the picker into a bogus "create folder" prompt.
  await input(page).fill(`${fixtureRoot}/projects/acmec`)
  await expect(page.locator('.sps-ghost-text')).toHaveText('apsDev')
  await input(page).press('Tab')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/AcmeCapsDev/`)
  // We're now correctly inside it — its real child lists
  await expect(page.locator('.sps-path-list .sps-path-item', { hasText: 'AcmeCapsDev/src' })).toBeVisible()

  // Backspacing after the completion must not teleport the caret / rewrite the
  // input: delete one char → exactly one char shorter, caret stays put.
  await input(page).press('Backspace')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/AcmeCapsDev`)
})

test('Tab completes to the SAME candidate the ghost predicts (not the highlighted history row)', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // 'wallet' prefix-extends only 'wallets' (a live sibling), NOT the high-frecency
  // history entry 'walnut' — yet unified ranking floats history to the top, so the
  // highlighted row (walnut) and the ghost prediction (wallets) diverge. Regression:
  // Tab used to complete the highlighted row, contradicting the grey prediction.
  await input(page).fill(`${fixtureRoot}/projects/wallet`)
  await expect(page.locator('.sps-ghost-text')).toHaveText('s')

  await input(page).press('Tab')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/wallets/`)
})

test('Enter also drills into the ghost candidate, matching the prediction', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  await input(page).fill(`${fixtureRoot}/projects/wallet`)
  await expect(page.locator('.sps-ghost-text')).toHaveText('s')

  await input(page).press('Enter')
  await expect(input(page)).toHaveValue(new RegExp('projects/wallets/?$'))
})

test('ArrowDown overrides the ghost highlight — explicit navigation wins for Tab', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  await input(page).fill(`${fixtureRoot}/projects/wal`)
  await expect(page.locator('.sps-ghost-text')).toHaveText('nut') // ghost = walnut (first row)

  // Manually move down to the next candidate (wallets). Once the user drives the
  // cursor, Tab must honor the highlighted row, not snap back to the ghost.
  await input(page).press('ArrowDown')
  await input(page).press('Tab')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/wallets/`)
})

test('fuzzy (non-prefix) match still finds substring candidates', async ({ page }) => {
  await openPicker(page)
  // 'marina' is a substring of 'zmarinax' — prefix-only matching would find nothing
  await input(page).fill(`${fixtureRoot}/projects/marina`)
  await expect(page.locator('.sps-path-list .sps-path-item', { hasText: 'zmarinax' })).toBeVisible()
})

test('Cmd+Backspace deletes the last path segment', async ({ page }) => {
  await openPicker(page)
  await input(page).fill(`${fixtureRoot}/projects/walnut`)
  await input(page).press('Meta+Backspace')
  await expect(input(page)).toHaveValue(`${fixtureRoot}/projects/`)
})

test('hidden dirs appear only when the typed segment starts with a dot', async ({ page }) => {
  await openPicker(page)
  await input(page).fill(`${fixtureRoot}/projects/.`)
  await expect(page.locator('.sps-path-list .sps-path-item', { hasText: '.hiddenproj' })).toBeVisible()
})

test('nonexistent leaf → create & start row; confirming sends createCwd:true', async ({ page }) => {
  await openPicker(page)
  // Single-host mode required for the create row — switch to Local tab if present
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  const newDir = `${fixtureRoot}/projects/brand-new-dir`
  await input(page).fill(newDir)

  const createRow = page.locator('.sps-create-row')
  await expect(createRow).toBeVisible()
  await expect(createRow).toContainText('brand-new-dir')
  // Wording must make the object explicit — "create folder", not a bare "create"
  // (users read bare "Create …" as "create session").
  await expect(createRow).toContainText('Create folder')
  await expect(createRow).toContainText('start session in it')

  // Capture the quick-start request body
  let capturedBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async (route) => {
    capturedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'pw-fake-task', task: { id: 'pw-fake-task' } }),
    })
  })

  await createRow.click()
  // Quick-start bar confirmed — now send a message to trigger the POST
  const chatInput = page.locator('.chat-input-textarea')
  await chatInput.fill('bootstrap this new project')
  await chatInput.press('Enter')

  await expect.poll(() => capturedBody, { timeout: 5000 }).not.toBeNull()
  expect(capturedBody!.createCwd).toBe(true)
  expect(capturedBody!.cwd).toBe(newDir)
})

test('explicit empty state when the typed directory does not exist', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  await input(page).fill(`${fixtureRoot}/nope/deeper/`)
  // Explicit "does not exist" note — history must not impersonate live results
  await expect(page.locator('.sps-live-note')).toContainText('does not exist')
})

test('keyboard matrix: Enter drills into a live dir, Esc backs out, ⇧Enter confirms', async ({ page }) => {
  await openPicker(page)
  await input(page).fill(`${fixtureRoot}/projects/`)
  const list = page.locator('.sps-path-list')
  await expect(list.locator('.sps-path-item').first()).toBeVisible()

  // Enter on the selected (first) item — walnut (live+history) → drills to walnut/
  await input(page).press('Enter')
  await expect(input(page)).toHaveValue(new RegExp('projects/walnut/?$'))

  // Esc exits edit mode back to browse
  await input(page).press('Escape')
  await expect(input(page)).toHaveValue('')

  // Type a path again and confirm with Shift+Enter → picker closes (quick-start bar path)
  await input(page).fill(`${fixtureRoot}/projects/walnut`)
  await input(page).press('Shift+Enter')
  await expect(page.locator('.session-path-selector')).not.toBeVisible()
})

test('status button stays clickable while ghost text is visible', async ({ page }) => {
  await openPicker(page)
  // In multi-host mode, pin to Local so a slow/dead SSH host cannot keep validity
  // unknown. Single-host mode is already local and intentionally renders no tabs.
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) {
    await localTab.click()
    await expect(localTab).toHaveClass(/active/)
  }

  // 'wal' has sibling completions (walnut/wallets) so the ghost overlay renders,
  // which flips the input to has-ghost mode (transparent bg + z-index lift).
  await input(page).fill(`${fixtureRoot}/projects/wal`)
  await expect(page.locator('.sps-ghost-text')).toBeVisible()
  // Button must have settled to a clickable (non-disabled) verdict on Local.
  await expect(page.locator('.sps-status-btn')).toBeEnabled()

  // The status button must still receive the click (regression: the z-index-
  // lifted transparent input painted over it, swallowing every click).
  await page.locator('.sps-status-btn').click({ timeout: 3000 })
  await expect(page.locator('.session-path-selector')).not.toBeVisible()
})

test('status button shows existence verdict: green ✓ for real dir, amber "+ folder" for missing', async ({ page }) => {
  await openPicker(page)
  // Local tab: 'missing' requires EVERY host to settle — on All, one slow/dead
  // SSH host pins validity at 'unknown' (↵) forever and the assertion flakes.
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // Existing dir → valid (green ✓)
  await input(page).fill(`${fixtureRoot}/projects/walnut`)
  await expect(page.locator('.sps-status-btn.sps-status-valid')).toBeVisible()
  await expect(page.locator('.sps-status-btn')).toHaveText('✓')

  // Missing dir → amber "+ folder" (create folder & start), never a silent plain
  // start. Label must name the object — "+ new" alone read as "new session".
  await input(page).fill(`${fixtureRoot}/projects/no-such-dir`)
  await expect(page.locator('.sps-status-btn.sps-status-missing')).toBeVisible()
  await expect(page.locator('.sps-status-btn')).toHaveText('+ folder')
})

test('⇧Enter on a missing path routes to create & start (createCwd:true), not a plain start', async ({ page }) => {
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  const newDir = `${fixtureRoot}/projects/created-via-shift-enter`
  await input(page).fill(newDir)
  await expect(page.locator('.sps-status-btn.sps-status-missing')).toBeVisible()

  let capturedBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async (route) => {
    capturedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'pw-fake-task-2', task: { id: 'pw-fake-task-2' } }),
    })
  })

  await input(page).press('Shift+Enter')
  const chatInput = page.locator('.chat-input-textarea')
  await chatInput.fill('kick off in the new folder')
  await chatInput.press('Enter')

  await expect.poll(() => capturedBody, { timeout: 5000 }).not.toBeNull()
  expect(capturedBody!.createCwd).toBe(true)
  expect(capturedBody!.cwd).toBe(newDir)
})

test('ghost text is baseline-aligned with the typed text', async ({ page }) => {
  await openPicker(page)
  await input(page).fill(`${fixtureRoot}/projects/wal`)
  await expect(page.locator('.sps-ghost-text')).toBeVisible()

  // The overlay's line-height must equal the input's (body 1.5 → 19.5px);
  // 'normal' floats the ghost ~2px above the typed text.
  const { inputLh, overlayLh } = await page.evaluate(() => ({
    inputLh: getComputedStyle(document.querySelector('.sps-search-input')!).lineHeight,
    overlayLh: getComputedStyle(document.querySelector('.sps-ghost-overlay')!).lineHeight,
  }))
  expect(overlayLh).toBe(inputLh)
})

test('panel height cap raised beyond the old 420px', async ({ page }) => {
  await openPicker(page)
  // The panel is content-sized; the CAP is what changed. min(72vh, 720px)
  // with the default 720px-tall viewport resolves to 518.4px (was 420px).
  const maxH = await page.locator('.session-path-selector')
    .evaluate(el => parseFloat(getComputedStyle(el).maxHeight))
  expect(maxH).toBeGreaterThan(430)
})
