/**
 * Who owns each task field of a draft, end to end through the real UI.
 *
 * The draft's background parse decides tier, priority and dates and shows every
 * decision as a chip (`✦` = Walnut decided). Ownership is per FIELD: a human edit
 * (the More menu, the folder picker footer) or a tier "+" seed owns that one field
 * and the AI never writes it again, while the AI keeps deciding the rest. An AI
 * field a NEWER trailing parse no longer proposes goes back to its default and its
 * chip leaves, but only when the leg that owns the field answered `ok` (`legs`).
 * `metaTouched` is not part of any of this: it stays the per-folder launch-memory
 * switch, so neither an AI write nor a More edit may freeze the model pill.
 *
 * The parse is mocked (`mockQuickParse`): the fixture has no AI provider. Config is
 * patched page-locally (`patchClientConfig`) so this file never flips a flag
 * another spec file's worker is reading. Launch bodies are read off the wire with
 * the CLI spawn blocked where the launch itself is not the claim. Every locator is
 * scoped to the strip's draft column (DRAFT_PANEL).
 *
 * Checklist ids: C9 C10 C11 C12 C13 C14 C18 C18b C19 C24 C33 C37 C43 C50 C57 C59
 * C60 C67. C47 (a custom tier deleted elsewhere while the draft is open) has no
 * browser trigger: the tier registry is only re-read on a socket reconnect, and a
 * draft does not survive a reload, so it is pinned by the unit tests of
 * draftDecisionChips instead.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  LEGS_OK, basenameOf, bootDecisions, captureDraftRequests, chipLabel, dayWords, discoverFixtureRoot, draftComposer,
  draftCwdPill, draftDecisionChip, draftDecisionChips, draftModelPill, draftPanel, draftPanels,
  draftProjectPill, draftQuickChipFor, draftTaskMenu, isoDay, nthRequest,
  openDraft, openDraftOnCwd, openDraftSettings, rememberModelFor, typeAndSettle, type ParseSource,
} from './draft-helpers'
import { createTaskForLater } from './draft-outcome-helpers'
import { openSessionFromPlus, pinToTier } from './draft-surface-helpers'

const SHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-decisions/ownership'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })
test.setTimeout(180_000)
// test-results/ is shared and wiped by peer runs: keep a failure shot under /tmp.
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    const slug = info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
    await page.screenshot({ path: `/tmp/draft-decisions/fail/${info.project.name}-${slug}.png` }).catch(() => {})
  }
})

const AI = /draft-decision-chip-ai/

const boot = (page: Page, source: ParseSource, cfg?: { quickParse?: boolean; showPriority?: boolean }) =>
  bootDecisions(page, source, cfg)

/** A tier button inside the open settings popover. */
const tierRow = (menu: Locator, label: string): Locator =>
  menu.locator('.task-kebab-tier-btn').filter({ hasText: label })
/** A priority button inside the open settings popover (labelled `!! Immediate`). */
const priorityRow = (menu: Locator, label: string): Locator =>
  menu.locator('.task-kebab-priority-options button').filter({ hasText: label })

async function expectAiChip(panel: Locator, field: 'pinTier' | 'priority' | 'startDate' | 'dueDate', label: string | RegExp): Promise<void> {
  const chip = draftDecisionChip(panel, field)
  await expect(chip).toContainText(label)
  await expect(chip).toHaveClass(AI)
  await expect(chip.locator('.draft-ai-badge')).toHaveCount(1)
}
async function expectUserChip(panel: Locator, field: 'pinTier' | 'priority' | 'startDate' | 'dueDate' | 'unread', label: string | RegExp): Promise<void> {
  const chip = draftDecisionChip(panel, field)
  await expect(chip).toContainText(label)
  await expect(chip).not.toHaveClass(AI)
  await expect(chip.locator('.draft-ai-badge')).toHaveCount(0)
}

// ── C9 C10: a More edit owns ONE field; the AI keeps the others ───────────────

test('a tier picked in the menu is FINAL against later parses, while the AI keeps moving priority', async ({ page }) => {
  const due = isoDay(3)
  const mock = await boot(page, { pinTier: 'satellite', priority: 'immediate', due_date: due })
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)

  await typeAndSettle(page, mock, 'fix the flaky login test by friday, urgent')
  await expectAiChip(panel, 'pinTier', 'Satellite')
  await expectAiChip(panel, 'priority', 'Immediate')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(3)}`)

  // C9: the chip opens the menu; Focus is a human decision now (no ✦).
  const menu = await openDraftSettings(panel, 'pinTier')
  await tierRow(menu, 'Focus').click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expectUserChip(panel, 'pinTier', 'Focus')

  // The parse changes its mind about BOTH tier and priority.
  mock.set({ pinTier: 'backlog', priority: 'important', due_date: due })
  await typeAndSettle(page, mock, 'fix the flaky login test by friday, important')
  await expectUserChip(panel, 'pinTier', 'Focus')
  // C10: ownership is per field, so the priority still follows the text.
  await expectAiChip(panel, 'priority', 'Important')
  await page.screenshot({ path: `${SHOT_DIR}/c9-c10-tier-owned-priority-ai.png` })

  await panel.locator('.draft-start-btn').click()
  const body = await nthRequest(log, 'quickStart')
  expect(body.taskMeta?.pinTier).toBe('focus')
  expect(body.taskMeta?.priority).toBe('important')
  expect(body.taskMeta?.due_date).toBe(due)
})

// ── C13 C14: a newer trailing parse that drops a field reverts it ─────────────

test('a field the newer trailing parse no longer proposes goes back to its default and its chip leaves', async ({ page }) => {
  const due = isoDay(4)
  const mock = await boot(page, { pinTier: 'wait', due_date: due })
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)

  await typeAndSettle(page, mock, 'wait on the vendor reply by friday')
  await expectAiChip(panel, 'pinTier', 'Wait')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(4)}`)

  // Both legs answered ok and neither proposes anything: the AI withdrew both.
  mock.set({ legs: LEGS_OK })
  await typeAndSettle(page, mock, 'wait on the vendor reply')
  await expect(draftDecisionChip(panel, 'dueDate')).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveCount(0)
  await expect(draftDecisionChips(panel)).toHaveCount(0)

  await panel.locator('.draft-start-btn').click()
  const body = await nthRequest(log, 'quickStart')
  expect(body.taskMeta?.pinTier, 'the reverted tier is the launcher default').toBe('focus')
  expect(body.taskMeta?.due_date, 'a withdrawn due never rides the launch').toBeUndefined()
})

// ── C50: only a leg that answered ok may withdraw its fields ──────────────────

test('a failed leg never withdraws the chips it owns, and a reply without legs withdraws nothing', async ({ page }) => {
  const due = isoDay(2)
  const mock = await boot(page, { pinTier: 'satellite', priority: 'immediate', due_date: due })
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)

  await typeAndSettle(page, mock, 'ship the invoice export on tuesday, urgent')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(2)}`)

  // The LLM (dates) leg timed out: a 200 with no dates is not "Walnut changed its mind".
  mock.set({ pinTier: 'satellite', priority: 'immediate', legs: { classify: 'ok', dates: 'failed' } })
  await typeAndSettle(page, mock, 'ship the invoice export on tuesday, urgent!')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(2)}`)

  // The classifier failed: its tier and priority stay, the dates leg still works.
  mock.set({ due_date: due, legs: { classify: 'failed', dates: 'ok' } })
  await typeAndSettle(page, mock, 'ship the invoice export on tuesday, urgent!!')
  await expectAiChip(panel, 'pinTier', 'Satellite')
  await expectAiChip(panel, 'priority', 'Immediate')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(2)}`)

  // An old server (no `legs` at all) proposing nothing: nothing may disappear.
  mock.set({ body: {}, legs: null })
  await typeAndSettle(page, mock, 'ship the invoice export')
  await expect(draftDecisionChips(panel)).toHaveCount(3)

  await panel.locator('.draft-start-btn').click()
  const body = await nthRequest(log, 'quickStart')
  expect(body.taskMeta?.due_date).toBe(due)
  expect(body.taskMeta?.pinTier).toBe('satellite')
})

// ── C33: the CLI-only shape (no LLM leg, so no dates) ─────────────────────────

test('a CLI-only parse (dates leg skipped) shows tier, priority and project, and no date chip', async ({ page }) => {
  const PROJECT = `Marina${Date.now()}`
  expect((await page.request.put(`/api/projects/${PROJECT}/metadata`, { data: {} })).ok()).toBe(true)
  const mock = await boot(page, {
    project: PROJECT, pinTier: 'satellite', priority: 'immediate', legs: { classify: 'ok', dates: 'skipped' },
  })
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'fix the flaky login test by friday, urgent')
  await expectAiChip(panel, 'pinTier', 'Satellite')
  await expectAiChip(panel, 'priority', 'Immediate')
  await expect(draftProjectPill(panel)).toHaveText(`${PROJECT}✦`)
  await expect(draftDecisionChip(panel, 'dueDate')).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'startDate')).toHaveCount(0)
  await expect(draftDecisionChips(panel)).toHaveCount(2)
})

// ── C11 C12 C57: neither an AI write nor a More edit freezes launch memory ────

test('quick folders still apply their remembered model after AI writes and after a More edit', async ({ page }) => {
  const walnut = `${fixtureRoot}/projects/walnut`
  const mcps = `${fixtureRoot}/projects/mcps`
  await rememberModelFor(page, { [walnut]: 'sonnet-1m', [mcps]: 'haiku' })
  const due = isoDay(3)
  const mock = await boot(page, { pinTier: 'satellite', priority: 'immediate', due_date: due })
  const panel = await openDraft(page)
  await expect(draftModelPill(panel)).toHaveAttribute('data-model', '')

  await typeAndSettle(page, mock, 'fix the flaky login test by friday, urgent')
  await expectAiChip(panel, 'pinTier', 'Satellite')

  // C12: the AI wrote three task fields; the folder's memory still wins the model.
  await draftQuickChipFor(panel, walnut).click()
  await expect(draftCwdPill(panel)).toContainText(basenameOf(walnut))
  await expect(draftModelPill(panel)).toHaveAttribute('data-model', 'sonnet-1m')
  // C57: the quick folder took nothing from the AI (no rebase from a stale snapshot).
  await expectAiChip(panel, 'pinTier', 'Satellite')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(3)}`)
  mock.set({ pinTier: 'satellite', priority: 'immediate', due_date: isoDay(5) })
  await typeAndSettle(page, mock, 'fix the flaky login test by sunday, urgent')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(5)}`)

  // C11: a More edit of a task field is not a launch edit either.
  const menu = await openDraftSettings(panel, 'more')
  await tierRow(menu, 'Wait').click()
  await expectUserChip(panel, 'pinTier', 'Wait')
  await draftQuickChipFor(panel, mcps).click()
  await expect(draftCwdPill(panel)).toContainText(basenameOf(mcps))
  await expect(draftModelPill(panel)).toHaveAttribute('data-model', 'haiku')
  await expectUserChip(panel, 'pinTier', 'Wait')
})

// ── C18 C19 C18b: the folder picker footer rebases per field ──────────────────

/** Open the full picker from the cwd pill and wait for its rows. */
async function openPicker(page: Page, panel: Locator): Promise<Locator> {
  await draftCwdPill(panel).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker.locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  const localTab = picker.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()
  return picker
}
async function confirmPath(page: Page, picker: Locator, cwd: string): Promise<void> {
  const input = picker.locator('.sps-search-input')
  await input.fill(cwd)
  await input.press('Shift+Enter')
  await expect(picker).toBeHidden()
}

test('a footer tier edit owns the tier only; an AI due that landed while the picker was open survives', async ({ page }) => {
  const first = isoDay(3)
  const second = isoDay(5)
  const later = 'close the audit ticket by sunday'
  const mock = await boot(page, (call) => (call.text === later
    ? { body: { due_date: second }, delayMs: 2_500 }
    : { due_date: first }))
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'close the audit ticket by wednesday')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(3)}`)

  // C19: the next parse is slow and lands while the picker is open.
  const t0 = Date.now()
  await draftComposer(page).fill(later)
  const picker = await openPicker(page, panel)
  // C18: the footer's tier group, the one tier control the picker has.
  await picker.getByRole('group', { name: 'Pin new task to tier' }).getByRole('button', { name: 'Wait' }).click()
  await expect.poll(() => mock.calls.some((c) => c.text === later && c.at - t0 >= 300), { timeout: 15_000 }).toBe(true)
  await page.waitForTimeout(2_900)
  await confirmPath(page, picker, `${fixtureRoot}/projects/mcps`)

  await expectUserChip(panel, 'pinTier', 'Wait')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(5)}`)
  await page.screenshot({ path: `${SHOT_DIR}/c18-c19-footer-rebase.png` })
})

test('an End set in the footer takes over Start and End together, and a later parse keeps both', async ({ page }) => {
  const start = `${isoDay(2)}T15:00:00`
  const mock = await boot(page, { start_date: start })
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'pair on the release notes the day after tomorrow at 3pm')
  await expectAiChip(panel, 'startDate', /^Start /)

  const picker = await openPicker(page, panel)
  await picker.locator('.sps-meta-footer').getByRole('button', { name: /More/ }).click()
  const more = page.getByRole('dialog', { name: 'More task settings' })
  await expect(more).toBeVisible()
  // The dates trio is Start, End, Due; End is the second trigger.
  await more.locator('.sps-meta-dates .dp-trigger').nth(1).click()
  await page.locator(`.dp-popover .dp-pill[title="${isoDay(3)}"]`).click()
  await page.keyboard.press('Escape')
  await expect(more).toHaveCount(0)
  await confirmPath(page, picker, `${fixtureRoot}/projects/walnut`)

  // Start is the user's now (no ✦) and reads as a range because End is set.
  await expectUserChip(panel, 'startDate', / to /)
  await typeAndSettle(page, mock, 'pair on the release notes the day after tomorrow at 3pm sharp')
  await expectUserChip(panel, 'startDate', / to /)

  await panel.locator('.draft-start-btn').click()
  const body = await nthRequest(log, 'quickStart')
  expect(body.taskMeta?.start_date).toBe(start)
  expect(body.taskMeta?.end_date).toBe(isoDay(3))
})

// ── C24: the Ask Walnut tab drops AI task fields; Start Task brings them back ─

test('entering Ask Walnut resets AI task fields, and switching back re-parses them', async ({ page }) => {
  const due = isoDay(3)
  const mock = await boot(page, { pinTier: 'satellite', priority: 'immediate', due_date: due })
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'plan the marina offsite by friday, urgent')
  await expect(draftDecisionChips(panel)).toHaveCount(3)

  await panel.locator('.draft-intent-card-walnut').click()
  await expect(panel.locator('.draft-walnut-meta-row')).toBeVisible()
  await expect(panel.locator('.draft-ai-badge')).toHaveCount(0)
  await expect(draftDecisionChips(panel)).toHaveCount(0)

  const walnutCalls = mock.calls.length
  await draftComposer(page).fill('plan the marina offsite by friday, urgent!')
  await page.waitForTimeout(900)
  expect(mock.calls.length, 'the Ask Walnut tab never parses').toBe(walnutCalls)

  await panel.locator('.draft-intent-card').filter({ hasText: 'Start Task' }).click()
  await expectAiChip(panel, 'pinTier', 'Satellite')
  await expectAiChip(panel, 'dueDate', `Due ${dayWords(3)}`)

  // And the Ask launch itself carries none of them.
  await panel.locator('.draft-intent-card-walnut').click()
  await expect(draftDecisionChips(panel)).toHaveCount(0)
  // An unbound Ask has no Start button: the composer's send (Enter) is the launch.
  await draftComposer(page).press('Enter')
  const body = await nthRequest(log, 'quickStart')
  expect(body.walnutAgent).toBe(true)
  expect(body.taskMeta?.due_date).toBeUndefined()
  expect(body.taskMeta?.priority ?? 'none').toBe('none')
})

// ── C37: clearing the composer withdraws every AI decision, model untouched ───

async function aiProjectWithFolder(page: Page): Promise<{ name: string; cwd: string }> {
  const name = `Marina${Date.now()}`
  const cwd = `${fixtureRoot}/projects/mcps`
  const res = await page.request.put(`/api/projects/${name}/metadata`, { data: { default_cwd: cwd } })
  expect(res.ok(), await res.text()).toBe(true)
  return { name, cwd }
}

test('an emptied composer (after the debounce) withdraws AI tier, dates, project and folder, and never the model', async ({ page }) => {
  const project = await aiProjectWithFolder(page)
  const mock = await boot(page, { project: project.name, pinTier: 'backlog', due_date: isoDay(3) })
  const panel = await openDraft(page)
  const model = await draftModelPill(panel).getAttribute('data-model')
  await typeAndSettle(page, mock, 'tidy the marina backlog by friday')
  await expect(draftProjectPill(panel)).toHaveText(`${project.name}✦`)
  await expect(draftCwdPill(panel)).toHaveText(`${basenameOf(project.cwd)}✦`)
  await expect(draftDecisionChips(panel)).toHaveCount(2)
  await expect(panel.locator('.draft-decisions-key')).toHaveText('✦ = decided by Walnut')

  await draftComposer(page).fill('')
  await expect(draftDecisionChips(panel)).toHaveCount(0, { timeout: 5_000 })
  await expect(draftProjectPill(panel)).toHaveText('Inbox')
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')
  await expect(panel.locator('.draft-decisions-key')).toHaveCount(0)
  await expect(draftModelPill(panel)).toHaveAttribute('data-model', model ?? '')
})

// ── C43: Create task for later carries what the chips say, unread by PATCH ────

test('Create task for later sends the chips\' tier, priority and due, then PATCHes unread', async ({ page }) => {
  const due = isoDay(3)
  const mock = await boot(page, { pinTier: 'satellite', priority: 'immediate', due_date: due })
  const log = await captureDraftRequests(page)
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, `write the marina retro notes by friday, urgent ${Date.now()}`)
  const menu = await openDraftSettings(panel, 'more')
  await menu.getByRole('button', { name: /Start unread/ }).click()
  await expectUserChip(panel, 'unread', 'Starts unread')
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)

  const taskId = await createTaskForLater(page, panel)
  const create = await nthRequest(log, 'createTask')
  expect(create.focus_tier).toBe('satellite')
  expect(create.priority).toBe('immediate')
  expect(create.due_date).toBe(due)
  await expect.poll(() => log.patchTask.find((p) => p.id === taskId)?.body.unread, { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/${taskId}`)).json()) as
    { task?: { unread?: boolean } }).task?.unread, { timeout: 15_000 }).toBe(true)
  const feedback = await nthRequest(log, 'feedback')
  expect(feedback.surface).toBe('draft-task')
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 30_000 })
})

// ── C59: priority follows ui.show_priority, and a flip re-derives the chip ────

/** Real fixture write (merging the rest of `ui`), same as quick-start-footer-more-menu. */
async function setFixtureShowPriority(page: Page, on: boolean): Promise<void> {
  const body = (await (await page.request.get('/api/config')).json()) as { config?: { ui?: Record<string, unknown> } }
  const res = await page.request.put('/api/config', { data: { ui: { ...(body.config?.ui ?? {}), show_priority: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

test('with priority hidden an "urgent" parse writes no priority; turning the setting on shows the chip without typing', async ({ page }) => {
  await setFixtureShowPriority(page, false)
  try {
    // Only quick_parse is forced: show_priority must come from the REAL config so
    // the live flip below reaches the page through config:changed.
    const mock = await boot(page, { pinTier: 'satellite', priority: 'immediate' }, { quickParse: true })
    const log = await captureDraftRequests(page, { blockQuickStart: true })
    const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
    await typeAndSettle(page, mock, 'fix the flaky login test, urgent')
    await expectAiChip(panel, 'pinTier', 'Satellite')
    await expect(draftDecisionChip(panel, 'priority')).toHaveCount(0)
    await panel.locator('.draft-start-btn').click()
    const body = await nthRequest(log, 'quickStart')
    expect(body.taskMeta?.priority ?? 'none', 'a hidden AI priority never rides the launch').toBe('none')
    const ledger = await nthRequest(log, 'feedback')
    expect((ledger.entries ?? []).map((e: { field: string }) => e.field)).not.toContain('priority')

    const panel2 = await openDraft(page)
    await typeAndSettle(page, mock, 'fix the flaky signup test, urgent')
    await expect(draftDecisionChip(panel2, 'priority')).toHaveCount(0)
    await setFixtureShowPriority(page, true)
    await expectAiChip(panel2, 'priority', 'Immediate')
  } finally {
    await setFixtureShowPriority(page, false)
  }
})

// ── C60: a long custom tier label is cut on the chip, whole in the tooltip ────

test('a custom tier chip truncates a long label and keeps the full name in its title', async ({ page }) => {
  const LABEL = 'Marina quarterly planning board'
  await page.route('**/api/focus/tiers', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ json: { tiers: [{ id: 'ct_marina_board', label: LABEL }] } })
    : route.continue()))
  const mock = await boot(page, { pinTier: 'ct_marina_board' })
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'move the marina roadmap to the planning board')
  const chip = draftDecisionChip(panel, 'pinTier')
  await expect(chip).toHaveClass(AI)
  expect(await chip.getAttribute('title')).toContain(LABEL)
  const cut = await chip.evaluate((el) => {
    const text = el.textContent ?? ''
    const overflowing = Array.from(el.querySelectorAll('*')).concat([el])
      .some((n) => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1)
    return text.includes('…') || overflowing
  })
  expect(cut, 'the chip shows at most 18ch of a custom tier label').toBe(true)
  expect((await chip.boundingBox())?.width ?? 0).toBeLessThan(260)
})

// ── C67: a tier "+" reusing a just-cleared draft never inherits AI leftovers ──

test('a tier "+" that reuses a just-emptied draft lands on Inbox, no folder, and its own Backlog chip', async ({ page }) => {
  const project = await aiProjectWithFolder(page)
  // The Backlog header only mounts while Backlog holds a pinned task.
  const anchor = await page.request.post('/api/tasks', { data: { title: `decision anchor ${Date.now()}`, source: 'local', project: 'Work' } })
  const anchorId = ((await anchor.json()) as { task: { id: string } }).task.id
  await pinToTier(page, anchorId, 'backlog')
  const mock = await boot(page, { project: project.name, pinTier: 'satellite' })
  const panel = await openDraft(page)
  const model = await draftModelPill(panel).getAttribute('data-model')
  await typeAndSettle(page, mock, 'tidy the marina backlog')
  await expect(draftProjectPill(panel)).toHaveText(`${project.name}✦`)

  const sublabel = page.locator('.todo-pinned-sublabel[data-navigation-id="backlog"]').first()
  await expect(sublabel).toBeVisible({ timeout: 25_000 })
  // Clear, then open from "+" BEFORE the 350ms clear debounce can fire.
  await draftComposer(page).fill('')
  await sublabel.hover()
  await openSessionFromPlus(page, sublabel)

  await expect(draftPanels(page)).toHaveCount(1)
  const reused = draftPanel(page)
  await expect(draftProjectPill(reused)).toHaveText('Inbox')
  await expect(draftCwdPill(reused)).toHaveText('Choose folder…')
  await expectUserChip(reused, 'pinTier', 'Backlog')
  expect(await chipLabel(draftDecisionChip(reused, 'pinTier'))).toBe('Backlog')
  await expect(draftModelPill(reused)).toHaveAttribute('data-model', model ?? '')
})
