/**
 * The suggested-vs-chosen ledger, end to end through the real UI.
 *
 * WHY IT EXISTS: the draft column's background parse fills the launch pills while
 * you type — the one part of a launch nobody audits, because a wrong guess is only
 * visible if you happen to look before committing. "The auto-suggestion feels
 * inaccurate" was therefore unfalsifiable in both directions. So every commit now
 * records what the parse proposed against what the launch actually carried, and
 * Settings → Diagnostics → Suggestion Accuracy shows the per-field tally.
 *
 * Two claims no unit test can make:
 *   1. an OVERRIDDEN suggestion is recorded, not silently dropped — the parse names
 *      one project (which drags its declared folder along), the user picks another
 *      project through the pill, and ONE record carries both a kept field (the
 *      folder) and a changed one (the project);
 *   2. the reader shows it: the Settings card reaches the same ledger through the
 *      HTTP route and renders the field, both values and the verdict.
 *
 * Since the visible-chips rules (2026-09-24) the parse's tier, priority and dates are
 * shown as chips and can be changed from them, so the ledger measures those too:
 * `pinTier`, `priority`, `startDate`, `dueDate` beside project and folder, every
 * record stamped `rules: 'visible-chips-v1'` so the older generation (tier never
 * applied, dates applied unseen) is counted apart. Priority is recorded only while
 * `ui.show_priority` is on: a hidden field is neither written nor measured.
 *
 * Committed through "◌ Create task for later" rather than Start: both exits record
 * (`surface` tells them apart), and the task exit needs no folder and spawns no CLI,
 * so the claim under test isn't wrapped in a session launch.
 *
 * The parse itself is STUBBED (`page.route`) for the same reason as
 * draft-session-seeds.spec.ts: the fixture has no AI provider, so the real route
 * degrades to a title-only 200 that would assert nothing. Everything after it —
 * debounce, ownership rules, the diff, the POST, the file, the route, the panel — is
 * the real code.
 */

import { test, expect, type Page } from '@playwright/test'
import {
  basenameOf, captureDraftRequests, discoverFixtureRoot, draftComposer, draftCwdPill, draftDecisionChip,
  draftPanels, draftProjectPill, isoDay, loadHome, mockQuickParse, nthRequest, openDraft, openDraftOnCwd,
  openDraftSettings, patchClientConfig, dayWords,
} from './draft-helpers'
import { armParse, createTaskForLater, pickDraftProject } from './draft-outcome-helpers'

const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-suggest-accuracy'

// Same budget as the sibling draft specs. The default 30s is not enough here: the
// fixture serves a seeded 500-session dataset behind its health monitor, and a
// per-character `type()` into the composer (each keystroke re-rendering the column)
// spent the whole default timeout mid-word on the first run of this file.
test.setTimeout(180_000)

// Serial within the file: both tests write the SAME ledger file and read it back
// through Settings, so running them concurrently would have each observing the
// other's records.
test.describe.configure({ mode: 'serial' })

/** Answer the background parse with a fixed suggestion (both legs ok), with the
 *  parse switched on and priority shown for this page only. */
async function stubParse(page: Page, body: Record<string, unknown>, showPriority = true): Promise<void> {
  await patchClientConfig(page, { quickParse: true, showPriority })
  await mockQuickParse(page, body)
}

/** GET /api/tasks/suggest-accuracy, the current-rules tally for one field. */
async function tally(page: Page, field: string): Promise<number> {
  const res = await page.request.get('/api/tasks/suggest-accuracy?limit=1')
  expect(res.ok(), await res.text()).toBe(true)
  const body = (await res.json()) as { fields?: Record<string, { total: number }> }
  return body.fields?.[field]?.total ?? 0
}

/** Real-UI walk to the accuracy card: sidebar → Settings → the section's nav item
 *  (which is what scrolls it into view, and the card only fetches once it is). */
async function openAccuracyCard(page: Page) {
  const settingsLink = page.locator('.sidebar a[href^="/settings"]')
  await expect(settingsLink).toBeVisible({ timeout: 30_000 })
  await settingsLink.click()
  const nav = page.getByTestId('settings-nav-suggest-accuracy')
  await expect(nav).toBeVisible({ timeout: 20_000 })
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const table = page.locator('.suggest-accuracy-table')
  await expect(table, 'the accuracy card read the ledger').toBeVisible({ timeout: 20_000 })
  return table
}

test('an overridden suggestion is recorded, and Settings shows the diff', async ({ page }) => {
  // A project name unique to this run. The fixture's ledger is shared by every spec
  // in the run, so each assertion below finds ITS OWN record instead of counting
  // rows — a global count would race a concurrent draft spec.
  const stamp = Date.now()
  // The project the parse suggests DECLARES a folder, so the suggestion fills both
  // pills (project + cwd) — the folder is the field that stays "kept" below.
  const AI_PROJECT = `SuggestLedger${stamp}`
  const aiCwd = `${await discoverFixtureRoot()}/projects/mcps`
  const seeded = await page.request.put(`/api/projects/${AI_PROJECT}/metadata`, { data: { default_cwd: aiCwd } })
  expect(seeded.ok(), await seeded.text()).toBe(true)
  // The project the human picks INSTEAD. It has to exist in the registry to be
  // offered by the pill's flyout; an empty metadata PUT creates the row and
  // declares no folder, so the pick moves nothing but the project.
  const USER_PROJECT = `LedgerPick${stamp}`
  const registered = await page.request.put(`/api/projects/${USER_PROJECT}/metadata`, { data: {} })
  expect(registered.ok(), await registered.text()).toBe(true)

  await page.setViewportSize({ width: 2400, height: 1000 })
  // Tier, priority and due ride the stub too: each one is a visible chip now, so
  // each one gets a verdict (the tier is overridden below, the other two kept).
  const DUE = isoDay(3)
  await stubParse(page, {
    title: 'ship the ledger', project: AI_PROJECT, due_date: DUE, pinTier: 'backlog', priority: 'immediate',
  })
  await loadHome(page)
  const tierBefore = await tally(page, 'pinTier')

  const panel = await openDraft(page)
  // The starting state, so every flip below is a real change.
  await expect(draftProjectPill(panel)).toHaveText('Inbox')
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')

  // Typing is the only trigger (the draft OPEN path is contractually network-free).
  // `type`, not `fill`, so the 500ms debounce sees a real keystroke burst.
  const parsed = armParse(page)
  const text = `Ship the accuracy ledger ${stamp}`
  await draftComposer(page).type(text)
  await parsed()

  // Both suggestions landed, badged ✦: the project, and the folder it declares.
  await expect(draftProjectPill(panel)).toHaveText(`${AI_PROJECT}✦`, { timeout: 10_000 })
  await expect(draftProjectPill(panel)).toHaveClass(/session-action-chip-ai/)
  await expect(draftCwdPill(panel)).toHaveText(`${basenameOf(aiCwd)}✦`)
  // C7: the task decisions are chips, each badged.
  for (const [field, words] of [['pinTier', 'Backlog'], ['priority', 'Immediate'], ['dueDate', `Due ${dayWords(3)}`]] as const) {
    await expect(draftDecisionChip(panel, field)).toContainText(words)
    await expect(draftDecisionChip(panel, field).locator('.draft-ai-badge')).toHaveCount(1)
  }
  // The tier is overridden from its chip.
  const menu = await openDraftSettings(panel, 'pinTier')
  await menu.locator('.task-kebab-tier-btn').filter({ hasText: 'Satellite' }).click()
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Satellite/)

  // ── The override: the human disagrees about the project, keeps the folder ──
  // This is the case the whole feature exists to count, and one record carrying a
  // kept field beside a changed one is what makes the per-field table meaningful.
  await pickDraftProject(page, panel, USER_PROJECT)
  await expect(draftCwdPill(panel), 'the folder stays as the AI left it').toHaveText(`${basenameOf(aiCwd)}✦`)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-override-before-commit.png`, fullPage: false })

  const feedback = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/tasks/suggest-feedback',
  { timeout: 20_000 })
  await createTaskForLater(page, panel)

  // CLAIM 1 — the commit posts both sides of every field the parse proposed AND the
  // user could see; nothing else.
  const feedbackReq = await feedback
  const payload = feedbackReq.postDataJSON() as {
    surface?: string
    textLen?: number
    rules?: string
    entries?: Array<{ field: string; suggested?: string; chosen?: string; rules?: string }>
  }
  expect((await feedbackReq.response())?.status(), 'the ledger route accepts it').toBe(204)
  expect(payload.surface).toBe('draft-task')
  expect(payload.textLen, 'the LENGTH rides along, never the text').toBe(text.length)
  const byField = new Map((payload.entries ?? []).map((e) => [e.field, e]))
  expect(byField.get('project'), 'the project override is the record that matters')
    .toMatchObject({ suggested: AI_PROJECT, chosen: USER_PROJECT })
  expect(byField.get('cwd')).toMatchObject({ suggested: aiCwd, chosen: aiCwd })
  expect(byField.get('pinTier')).toMatchObject({ suggested: 'backlog', chosen: 'satellite' })
  expect(byField.get('priority')).toMatchObject({ suggested: 'immediate', chosen: 'immediate' })
  expect(byField.get('dueDate')).toMatchObject({ suggested: DUE, chosen: DUE })
  expect([...byField.keys()].sort(), 'every visible decision, and nothing else (no endDate)')
    .toEqual(['cwd', 'dueDate', 'pinTier', 'priority', 'project'])
  // C63: the record names its rules generation.
  expect(payload.rules ?? payload.entries?.[0]?.rules).toBe('visible-chips-v1')
  // C27: the current-rules tally counted this commit's tier.
  await expect.poll(() => tally(page, 'pinTier'), { timeout: 10_000 }).toBeGreaterThanOrEqual(tierBefore + 1)
  // The composer text must never ride along — only its length.
  expect(JSON.stringify(payload)).not.toContain('Ship the accuracy ledger')

  // The draft is gone (the task exit closes the column optimistically).
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 30_000 })

  // CLAIM 2 — the reader, reached the way a user reaches it.
  const table = await openAccuracyCard(page)
  await expect(table.locator('tbody tr', { hasText: 'Project' })).toBeVisible()
  await expect(table.locator('tbody tr', { hasText: 'Folder' })).toBeVisible()
  // The total row is always last, so a field row can't be mistaken for it.
  await expect(table.locator('tbody tr.suggest-accuracy-total')).toContainText('All fields')

  // …and THIS commit's raw diff is listed with its verdicts. Scoped by the stamped
  // project name, so another spec's records can't satisfy the assertion.
  const record = page.locator('.suggest-accuracy-record', { hasText: AI_PROJECT }).first()
  await expect(record).toBeVisible({ timeout: 20_000 })
  // Several fields per record now (folder, priority, due kept; project, tier
  // changed), so each verdict is found by its own words.
  await expect(record.locator('.suggest-accuracy-entry.verdict-kept', { hasText: aiCwd })).toBeVisible()
  await expect(record.locator('.suggest-accuracy-entry.verdict-changed', { hasText: `${AI_PROJECT} to ${USER_PROJECT}` }))
    .toBeVisible()
  await expect(record.locator('.suggest-accuracy-entry.verdict-changed', { hasText: 'backlog to satellite' })).toBeVisible()

  // Scroll the card fully into frame for the artifact — the assertions above are
  // done, and a screenshot of the section header proves nothing to a human reviewer.
  await record.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-accuracy-card.png`, fullPage: false })
})

test('a commit the parse had no opinion about records nothing', async ({ page }) => {
  // The common case by far. An empty record per commit would bury the real signal
  // in noise — and this also proves the POST isn't fired unconditionally from the
  // commit handler.
  await page.setViewportSize({ width: 2400, height: 1000 })
  await stubParse(page, { title: 'no opinions here' })
  await loadHome(page)

  const panel = await openDraft(page)
  let posted = false
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/tasks/suggest-feedback') posted = true
  })

  // Wait for the parse to be APPLIED (armParse), so the client has actually
  // handled a proposal-free parse before the commit. There is nothing observable
  // to wait for beyond that — a parse that proposes nothing changes no pill, which
  // is exactly the state under test — so the pill is asserted unchanged as a
  // sanity check rather than as the arrival signal.
  const parsed = armParse(page)
  await draftComposer(page).type(`Run the build ${Date.now()}`)
  await parsed()
  await expect(draftProjectPill(panel)).toHaveText('Inbox')

  await createTaskForLater(page, panel)
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 30_000 })
  expect(posted, 'nothing suggested → nothing recorded').toBe(false)
})

test('Start carries the chips\' tier, priority and due, and the ledger records each one', async ({ page }) => {
  // C7 + C8 + C27 through the Start exit (a real launch on the fixture's mock CLI).
  const DUE = isoDay(3)
  await page.setViewportSize({ width: 2400, height: 1000 })
  await stubParse(page, { pinTier: 'satellite', priority: 'immediate', due_date: DUE })
  const log = await captureDraftRequests(page)
  await loadHome(page)
  const panel = await openDraftOnCwd(page, `${await discoverFixtureRoot()}/projects/walnut`)
  const parsed = armParse(page)
  await draftComposer(page).type(`fix the flaky login test by friday, urgent ${Date.now()}`)
  await parsed()
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Satellite/, { timeout: 10_000 })
  await expect(draftDecisionChip(panel, 'priority')).toHaveText(/Immediate/)
  await expect(draftDecisionChip(panel, 'dueDate')).toHaveText(new RegExp(`Due ${dayWords(3)}`))
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-chips-before-start.png`, fullPage: false })

  await panel.locator('.draft-start-btn').click()
  const body = await nthRequest(log, 'quickStart')
  expect(body.taskMeta).toMatchObject({ pinTier: 'satellite', priority: 'immediate', due_date: DUE })
  const ledger = await nthRequest(log, 'feedback')
  expect(ledger.surface).toBe('draft-session')
  const byField = new Map(((ledger.entries ?? []) as Array<{ field: string }>).map((e) => [e.field, e]))
  expect(byField.get('pinTier')).toMatchObject({ suggested: 'satellite', chosen: 'satellite' })
  expect(byField.get('priority')).toMatchObject({ suggested: 'immediate', chosen: 'immediate' })
  expect(byField.get('dueDate')).toMatchObject({ suggested: DUE, chosen: DUE })
})

test('with priority hidden an AI priority is neither shown, launched nor recorded', async ({ page }) => {
  // C32: the default install (ui.show_priority off).
  await page.setViewportSize({ width: 2400, height: 1000 })
  await stubParse(page, { pinTier: 'satellite', priority: 'immediate' }, false)
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  await loadHome(page)
  const panel = await openDraftOnCwd(page, `${await discoverFixtureRoot()}/projects/walnut`)
  const parsed = armParse(page)
  await draftComposer(page).type('fix the flaky login test, urgent')
  await parsed()
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Satellite/, { timeout: 10_000 })
  await expect(draftDecisionChip(panel, 'priority')).toHaveCount(0)
  await panel.locator('.draft-start-btn').click()
  const body = await nthRequest(log, 'quickStart')
  expect(body.taskMeta?.priority ?? 'none').toBe('none')
  const ledger = await nthRequest(log, 'feedback')
  expect(((ledger.entries ?? []) as Array<{ field: string }>).map((e) => e.field)).not.toContain('priority')
})
