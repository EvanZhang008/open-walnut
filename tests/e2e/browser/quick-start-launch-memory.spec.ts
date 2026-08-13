/**
 * Per-directory launch memory in the Quick Start picker.
 *
 * working-dirs is mocked to carry `lastLaunch` for one dir; verifies:
 *  1. highlighting that dir previews its remembered model in the footer select
 *  2. highlighting a dir WITHOUT memory shows Auto (no leak between rows)
 *  3. confirming the remembered dir sends the model on /quick-start
 *  4. a user's explicit model pick beats the memory of a later-highlighted row
 *
 * The picker is now reached through a DRAFT session column ("+" grows the column,
 * its cwd pill opens this same popover — `.sps-*` markup unchanged). Two knock-on
 * differences from the old chat-pill route, both mechanical:
 *  - a confirmed pick lands on the DRAFT's cwd pill, not the chat `.quick-start-bar`
 *    (which that route no longer creates), and the remembered model shows in the
 *    picker's own footer select rather than the bar's `.qsb-model-chip`;
 *  - the launching composer is the draft column's, not the main chat's.
 */
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { openDraft } from './draft-helpers'

const rememberedCwd = '/Users/playwright/memory-fixture/projects/walnut'
const plainCwd = '/Users/playwright/memory-fixture/projects/scratch'
const rememberedModel = 'sonnet-1m' // legacy alias — present in the static SESSION_MODELS fallback
/** Human label the old collapsed bar showed for `rememberedModel` ("Sonnet 1M").
 *  A regex because the catalog row may append a description. */
const rememberedModelLabel = /Sonnet 1M/
const now = new Date().toISOString()
const LAST_PATH_KEY = 'open-walnut-launcher-last-path'

async function fulfillWorkingDirs(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      dirs: [
        { cwd: rememberedCwd, host: null, project: 'Work', count: 20, lastUsed: now, lastLaunch: { model: rememberedModel } },
        { cwd: plainCwd, host: null, project: 'Work', count: 10, lastUsed: now },
      ],
      hosts: [],
    }),
  })
}

/** The picker's outside-click listener attaches on a 100ms timer after open —
 *  elastic under parallel test load. Poll-click outside until it takes effect. */
async function clickOutsideUntilClosed(page: Page): Promise<void> {
  await expect(async () => {
    await page.locator('.main-page').click({ position: { x: 10, y: 10 } })
    await expect(page.locator('.session-path-selector')).toHaveCount(0, { timeout: 500 })
  }).toPass({ timeout: 10_000 })
}

async function openPicker(page: Page): Promise<Locator> {
  await page.route('**/api/sessions/working-dirs', fulfillWorkingDirs)
  // The fixture paths don't exist on the test machine's disk — mock the live
  // listing so pathValidity sees them as real (dismiss-confirm requires a
  // non-missing verdict; a missing path deliberately routes dismiss → close).
  await page.route('**/api/sessions/list-dirs**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dirs: [rememberedCwd, plainCwd],
        parent: '/Users/playwright/memory-fixture/projects/',
        exists: true,
      }),
    })
  })
  // A draft column seeds its cwd from the launch memory, and a seeded cwd opens
  // the picker straight into EDIT mode — the browse-mode ROW HIGHLIGHT is what
  // drives every model preview below, so this spec needs the never-launched
  // state. `removeItem` would be the wrong reset: the key is `open-walnut-`
  // prefixed, so ui-prefs-sync's boot merge adopts the SHARED fixture server's
  // copy whenever the local one is null, letting another spec's launch decide
  // what this one sees. Seed a value readLastLaunchPath rejects (empty cwd →
  // null) instead; a local value with no tracked timestamp always wins the merge.
  await page.addInitScript((key) => {
    try { localStorage.setItem(key as string, '{"cwd":"","host":null}') } catch { /* storage disabled */ }
  }, LAST_PATH_KEY)
  await page.goto('/')
  // "+" grows the draft column; its cwd pill (first chip — the project pill sits
  // after it) opens the picker.
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  await expect(panel.locator('.session-path-selector')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.sps-path-item')).toHaveCount(2, { timeout: 20_000 })
  return panel
}

/** The draft's cwd pill — where a confirmed pick lands now. */
function cwdPill(panel: Locator): Locator {
  return panel.locator('.draft-composer-bar .session-action-chip').first()
}

/**
 * Assert the pill adopted `cwd` — the equivalent of the old `.qsb-path` check.
 * The title carries the FULL path (exact match); the visible label is the folder
 * basename, optionally suffixed with the host label ("walnut · Local"), so that
 * half is a containment check.
 */
async function expectPickedCwd(panel: Locator, cwd: string): Promise<void> {
  const pill = cwdPill(panel)
  await expect(pill).toHaveAttribute('title', `Working folder: ${cwd}`)
  await expect(pill).toContainText(cwd.split('/').pop()!)
}

/**
 * The model the draft is CARRYING after a confirm, read the way a user would:
 * re-open its picker, whose footer is seeded from the draft's stored meta
 * (`initialMeta`). This replaces the old `.qsb-model-chip` check — the chat
 * quick-start bar isn't part of this route — and is still a real-UI read rather
 * than a peek at state.
 *
 * Both halves of the old chip assertion are kept: the model survived as an ID
 * (`value`), and the UI names it in human words (`label`) instead of showing
 * Auto. The label is asserted on the option carrying that value, not on
 * `option:checked`, so the two claims can't collapse into one.
 */
async function expectDraftModel(page: Page, panel: Locator, value: string, label: RegExp): Promise<void> {
  await cwdPill(panel).click()
  const picker = panel.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  const select = picker.getByRole('combobox', { name: 'Session model' })
  await expect(select).toHaveValue(value)
  await expect(select.locator(`option[value="${value}"]`)).toHaveText(label)
  // Dismiss-confirm re-applies the SAME path + seeded meta, so this read-back
  // leaves the draft exactly as it found it.
  await clickOutsideUntilClosed(page)
}

test('highlighted dir previews its remembered model; plain dir shows Auto', async ({ page }) => {
  await openPicker(page)

  const modelSelect = page.getByRole('combobox', { name: 'Session model' })
  const rows = page.locator('.sps-path-item')
  // Keys go to the picker's own input rather than page.keyboard: the draft column
  // focuses its composer on mount, so "whatever has focus" is no longer
  // unambiguously the picker (it focuses this input on a 50ms timer after open).
  const search = page.locator('.sps-search-input')

  // Row 0 = remembered dir (highest count) — footer previews its model
  await expect(rows.nth(0).locator('.sps-path-cwd')).toHaveAttribute('title', rememberedCwd)
  await expect(modelSelect).toHaveValue(rememberedModel)

  // Move highlight to the plain dir → preview resets to Auto
  await search.press('ArrowDown')
  await expect(rows.nth(1)).toHaveClass(/active/)
  await expect(modelSelect).toHaveValue('')

  // Back to the remembered dir → preview returns
  await search.press('ArrowUp')
  await expect(modelSelect).toHaveValue(rememberedModel)

  await page.screenshot({ path: '/tmp/quick-start-launch-memory/preview.png' })
})

test('CLICKING the remembered dir (drill into edit mode) keeps the model preview', async ({ page }) => {
  // Regression: clicking a history row enters edit mode where the highlight
  // moves to live CHILD dirs — the preview must follow the TYPED path (the
  // launch target), not the highlighted child, else it resets to Auto and
  // reads as "my model wasn't remembered".
  await openPicker(page)

  const modelSelect = page.getByRole('combobox', { name: 'Session model' })
  await expect(modelSelect).toHaveValue(rememberedModel)

  await page.locator('.sps-path-item', {
    has: page.locator(`.sps-path-cwd[title="${rememberedCwd}"]`),
  }).first().click()

  // Now in edit mode with the path filled — preview must survive
  await expect(page.locator('.sps-search-input, .sps-path-input, input').first()).toBeVisible()
  await expect(modelSelect).toHaveValue(rememberedModel)
})

test('confirming the remembered dir sends its model on quick-start', async ({ page }) => {
  const panel = await openPicker(page)

  let sentBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async route => {
    sentBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'mem-task-1', task: { id: 'mem-task-1' } }),
    })
  })

  // Shift+Enter on the highlighted remembered row = select directly
  await page.locator('.sps-search-input').press('Shift+Enter')
  await expect(panel.locator('.session-path-selector')).toBeHidden()
  // The pick landed on THIS draft, carrying the remembered model (Sonnet 1M, not
  // Auto) — the draft's stored meta is what the launch below reads from.
  await expectPickedCwd(panel, rememberedCwd)
  await expectDraftModel(page, panel, rememberedModel, rememberedModelLabel)

  await panel.locator('.chat-input-textarea').fill('hello from memory test')
  await panel.locator('.chat-input-textarea').press('Enter')

  await expect.poll(() => sentBody).not.toBeNull()
  expect(sentBody!.cwd).toBe(rememberedCwd)
  expect(sentBody!.model).toBe(rememberedModel)
})

test('dismissing (outside click) after picking a path confirms it as the launch target', async ({ page }) => {
  const panel = await openPicker(page)

  // Click a history row → edit mode with the path filled
  await page.locator('.sps-path-item', {
    has: page.locator(`.sps-path-cwd[title="${rememberedCwd}"]`),
  }).first().click()

  // Click outside the popover — the pick must become the draft's launch target
  // (no ✓/⇧Enter needed), carrying the remembered model. The outside-click
  // listener attaches on a 100ms timer (elastic under parallel load), so
  // poll-click until the popover actually closes.
  await clickOutsideUntilClosed(page)
  await expectPickedCwd(panel, rememberedCwd)
  await expectDraftModel(page, panel, rememberedModel, rememberedModelLabel)
})

test('dismissing with no path picked still just closes (no path adopted)', async ({ page }) => {
  const panel = await openPicker(page)
  // Browse mode, nothing typed — outside click closes and adopts nothing, so the
  // draft's cwd pill still reads its unpicked placeholder.
  await clickOutsideUntilClosed(page)
  await expect(page.locator('.session-path-selector')).toHaveCount(0)
  await expect(cwdPill(panel)).toHaveText('Choose folder…')
})

test('panel height is fixed — drilling into a dir with few children must not shrink it', async ({ page }) => {
  await openPicker(page)
  const popover = page.locator('.session-path-selector')
  const browseBox = await popover.boundingBox()

  // Drill into a dir (edit mode; live listing likely empty in fixture) — height stays
  await page.locator('.sps-path-item', {
    has: page.locator(`.sps-path-cwd[title="${rememberedCwd}"]`),
  }).first().click()
  await page.waitForTimeout(500)
  const editBox = await popover.boundingBox()
  expect(editBox!.height).toBe(browseBox!.height)
})

test('explicit user pick beats the remembered model', async ({ page }) => {
  const panel = await openPicker(page)

  const modelSelect = page.getByRole('combobox', { name: 'Session model' })
  await expect(modelSelect).toHaveValue(rememberedModel)

  // User explicitly resets to Auto — memory must NOT re-apply on highlight moves.
  // Arrow keys go to the picker's input, not page.keyboard: selectOption left
  // focus on the <select>, where ArrowDown would change the model instead of the
  // highlighted row (and silently make this assertion vacuous).
  const search = page.locator('.sps-search-input')
  await modelSelect.selectOption('')
  await search.press('ArrowDown')
  await search.press('ArrowUp')
  await expect(modelSelect).toHaveValue('')

  let sentBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async route => {
    sentBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'mem-task-2', task: { id: 'mem-task-2' } }),
    })
  })

  await search.press('Shift+Enter')
  await expect(panel.locator('.session-path-selector')).toBeHidden()
  await expectPickedCwd(panel, rememberedCwd)
  // The explicit Auto survived onto the draft: re-opening its picker shows Auto,
  // not the directory's remembered Sonnet 1M.
  await expectDraftModel(page, panel, '', /Auto/)

  await panel.locator('.chat-input-textarea').fill('explicit auto wins')
  await panel.locator('.chat-input-textarea').press('Enter')

  await expect.poll(() => sentBody).not.toBeNull()
  expect(sentBody!.model).toBeUndefined()
})
