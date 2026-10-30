/**
 * Per-directory launch memory, applied by the folder picker to a draft column.
 *
 * working-dirs is mocked to carry `lastLaunch` for one dir; verifies:
 *  1. picking that dir puts its remembered model on the draft's model pill, and
 *     picking a dir WITHOUT memory puts Auto back (no leak between folders)
 *  2. the memory follows the TYPED path when a row click drills into edit mode
 *  3. confirming the remembered dir sends the model on /quick-start
 *  4. a user's explicit model pick on the composer pill beats the folder's memory
 *
 * The folder picker only picks a folder and a host now: its task-meta footer
 * (and with it the live preview of the highlighted row's memory) is gone. The
 * model the draft carries is read where the user reads it, on the composer's
 * model pill (`data-model` = the alias the launch sends, its text the human
 * label), and the explicit pick is made there too: a pill pick sets the draft's
 * `metaTouched`, which locks the folder memory out (`lockLaunchMemory`).
 */
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { draftModelPicker, draftModelPill, openDraft } from './draft-helpers'

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
 *  elastic under parallel test load. Poll-click outside until it takes effect.
 *  Raw mouse click, not an element click: the popout panel floats over the
 *  page, so an element at (10,10) may be covered and fail Playwright's
 *  interception check — the raw click doesn't care, and any point outside the
 *  panel is exactly what the document-mousedown closer listens for. */
async function clickOutsideUntilClosed(page: Page): Promise<void> {
  await expect(async () => {
    await page.mouse.click(10, 10)
    await expect(page.locator('.session-path-selector')).toHaveCount(0, { timeout: 500 })
  }).toPass({ timeout: 10_000 })
}

/** Stub the folder lists, then "+" a fresh draft column (no folder picked). */
async function openStubbedDraft(page: Page): Promise<Locator> {
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
  // Shift+Enter confirms below, so this spec needs the never-launched state. `removeItem` would be the wrong reset: the key is `open-walnut-`
  // prefixed, so ui-prefs-sync's boot merge adopts the SHARED fixture server's
  // copy whenever the local one is null, letting another spec's launch decide
  // what this one sees. Seed a value readLastLaunchPath rejects (empty cwd →
  // null) instead; a local value with no tracked timestamp always wins the merge.
  await page.addInitScript((key) => {
    try { localStorage.setItem(key as string, '{"cwd":"","host":null}') } catch { /* storage disabled */ }
  }, LAST_PATH_KEY)
  await page.goto('/')
  return openDraft(page)
}

/** Open the draft's folder picker from its cwd pill (first chip — the project
 *  pill sits after it) and wait for the two stubbed history rows. */
async function openFolderPicker(page: Page, panel: Locator): Promise<void> {
  await cwdPill(panel).click()
  await expect(page.locator('.session-path-selector')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.sps-path-item')).toHaveCount(2, { timeout: 20_000 })
}

async function openPicker(page: Page): Promise<Locator> {
  const panel = await openStubbedDraft(page)
  await openFolderPicker(page, panel)
  return panel
}

/** The draft's cwd pill — where a confirmed pick lands now. */
function cwdPill(panel: Locator): Locator {
  return panel.locator('.draft-composer-bar .session-action-chip').first()
}

/**
 * Assert the pill adopted `cwd` — the equivalent of the old `.qsb-path` check.
 * The title's first line is "Folder: <full path>"; the visible label is
 * "Folder/Host: <basename> · <host>", so that half is a containment check.
 */
async function expectPickedCwd(panel: Locator, cwd: string): Promise<void> {
  const pill = cwdPill(panel)
  await expect(pill).toHaveAttribute('title', new RegExp(`^Folder: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`))
  await expect(pill).toContainText(cwd.split('/').pop()!)
}

/**
 * The model the draft is CARRYING, read the way a user would: the composer's
 * model pill. Both halves of the old chip assertion are kept: the model survived
 * as an ID (`data-model`, what the launch sends), and the UI names it in human
 * words (the pill's text) instead of showing Auto.
 */
async function expectDraftModel(panel: Locator, value: string, label: RegExp): Promise<void> {
  await expect(draftModelPill(panel)).toHaveAttribute('data-model', value)
  await expect(draftModelPill(panel)).toHaveText(label)
}

/** Shift+Enter in the picker's own input (the draft column focuses its composer
 *  on mount, so page.keyboard is not unambiguously the picker's). */
async function confirmHighlighted(page: Page): Promise<void> {
  await page.locator('.sps-search-input').press('Shift+Enter')
  await expect(page.locator('.session-path-selector')).toBeHidden()
}

test('a picked folder brings its remembered model; a folder without memory puts Auto back', async ({ page }) => {
  const panel = await openPicker(page)
  const rows = page.locator('.sps-path-item')
  // Row 0 = remembered dir (highest count).
  await expect(rows.nth(0).locator('.sps-path-cwd')).toHaveAttribute('title', rememberedCwd)
  await expectDraftModel(panel, '', /Auto/)

  await confirmHighlighted(page)
  await expectPickedCwd(panel, rememberedCwd)
  await expectDraftModel(panel, rememberedModel, rememberedModelLabel)

  // The plain dir has no memory: the previous folder's model must not leak onto
  // it. The draft has a folder now, so the picker reopens in edit mode on it:
  // type the other path rather than moving a row highlight.
  await cwdPill(panel).click()
  await expect(page.locator('.session-path-selector')).toBeVisible({ timeout: 10_000 })
  await page.locator('.sps-search-input').fill(plainCwd)
  await confirmHighlighted(page)
  await expectPickedCwd(panel, plainCwd)
  await expectDraftModel(panel, '', /Auto/)

  await page.screenshot({ path: '/tmp/quick-start-launch-memory/memory-follows-folder.png' })
})

test('CLICKING the remembered dir (drill into edit mode) then confirming still applies its model', async ({ page }) => {
  // Regression: clicking a history row enters edit mode where the highlight
  // moves to live CHILD dirs — the memory must follow the TYPED path (the launch
  // target), not the highlighted child, else it resets to Auto and reads as "my
  // model wasn't remembered".
  const panel = await openPicker(page)

  await page.locator('.sps-path-item', {
    has: page.locator(`.sps-path-cwd[title="${rememberedCwd}"]`),
  }).first().click()

  // Now in edit mode with the path filled; confirm it.
  await expect(page.locator('.sps-search-input')).toHaveValue(new RegExp(`^${rememberedCwd}`))
  await confirmHighlighted(page)
  await expectPickedCwd(panel, rememberedCwd)
  await expectDraftModel(panel, rememberedModel, rememberedModelLabel)
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
  await confirmHighlighted(page)
  // The pick landed on THIS draft, carrying the remembered model (Sonnet 1M, not
  // Auto) — the draft's stored meta is what the launch below reads from.
  await expectPickedCwd(panel, rememberedCwd)
  await expectDraftModel(panel, rememberedModel, rememberedModelLabel)

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
  await expectDraftModel(panel, rememberedModel, rememberedModelLabel)
})

test('dismissing with no path picked still just closes (no path adopted)', async ({ page }) => {
  const panel = await openPicker(page)
  // Browse mode, nothing typed — outside click closes and adopts nothing, so the
  // draft's cwd pill still reads its unpicked placeholder (a fresh draft opens
  // with no folder pre-selected).
  await clickOutsideUntilClosed(page)
  await expect(page.locator('.session-path-selector')).toHaveCount(0)
  await expect(cwdPill(panel)).toHaveText('Choose folder and host…')
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
  // Sub-pixel tolerance: the popout placement path re-rasterizes the fixed
  // element, moving the height by ~2e-5 px. The claim is "no mode-change
  // shrink" (whole rows = ~28px), not bit-identical floats.
  expect(Math.abs(editBox!.height - browseBox!.height)).toBeLessThan(1)
})

test('explicit user pick on the model pill beats the remembered model', async ({ page }) => {
  const panel = await openStubbedDraft(page)
  const picker = draftModelPicker(page)
  const models = picker.getByRole('listbox', { name: 'Model', exact: true })

  // The user picks a model on the composer pill (the picker closes on a pick)…
  await draftModelPill(panel).click()
  await models.locator('[role="option"]:not([data-testid="picker-auto-row"]):not([disabled])').first().click()
  await expect(picker).toHaveCount(0)
  await expect(draftModelPill(panel)).not.toHaveAttribute('data-model', '')
  // …then explicitly resets to Auto. Both are the user's choices: the folder's
  // memory must NOT re-apply on the folder pick below.
  await draftModelPill(panel).click()
  await models.getByTestId('picker-auto-row').click()
  await expect(picker).toHaveCount(0)
  await expectDraftModel(panel, '', /Auto/)

  let sentBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async route => {
    sentBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'mem-task-2', task: { id: 'mem-task-2' } }),
    })
  })

  await openFolderPicker(page, panel)
  await confirmHighlighted(page)
  await expectPickedCwd(panel, rememberedCwd)
  // The explicit Auto survived onto the draft, not the directory's remembered
  // Sonnet 1M.
  await expectDraftModel(panel, '', /Auto/)

  await panel.locator('.chat-input-textarea').fill('explicit auto wins')
  await panel.locator('.chat-input-textarea').press('Enter')

  await expect.poll(() => sentBody).not.toBeNull()
  expect(sentBody!.model).toBeUndefined()
})
