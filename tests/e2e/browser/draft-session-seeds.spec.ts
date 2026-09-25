/**
 * Draft column ENTRY POINTS that pre-configure the column — the three design
 * revisions after the v4 layout landed:
 *
 *   R7  project group header "+"  → a draft in that project, with the project's
 *                                   declared folder (`default_cwd`) already on it
 *   R8  pin-tier header "+"       → a draft with that tier preset
 *   R9  typing in the composer    → a background parse back-fills project /
 *                                   folder, each ✦-badged, and a human's own pick
 *                                   is FINAL against every later parse
 *
 * 2026-09-24 (visible decisions): every task field the draft carries is a chip
 * above the pills. A tier SEED (R8) shows as a tier chip WITHOUT ✦ (the user's own
 * "+") and no parse may overwrite it; the parse (R9) now applies its tier too, with a
 * ✦ chip, because a tier the user can see and change no longer files the task
 * somewhere they are not looking. The outcome checks (which tier the created task
 * lands in, via the focus API) stay: a chip that lies is still a bug.
 *
 * Why a separate file from tests/e2e/browser/draft-session-column.spec.ts: that one
 * owns the column's LIFECYCLE (open → configure → Start / task / discard); this one
 * owns "who filled these pills in, and who is allowed to overwrite them". Both drive
 * the same panel through the same helpers (./draft-helpers) — the split is by
 * subject, so a lifecycle change and a seeding change don't collide in one file.
 *
 * Same house rules as its sibling: `page.goto('/')` is the initial load only (via
 * `loadHome`), every later step is a real click, and every "did a task appear"
 * assertion is scoped to a UNIQUE stamped title because the fixture server is
 * SHARED with every other spec file.
 *
 * PROJECT ISOLATION. These scenarios need projects that DECLARE a `default_cwd`, and
 * that mapping is global registry state. Each therefore uses its own project name
 * (`PlusSeedProj`, `AiPickProj`) instead of the fixture's shared 'Walnut' — pointing
 * Walnut at a folder would silently change where every other spec's Walnut launch
 * runs.
 */

import { test, expect } from '@playwright/test'
import {
  basenameOf, discoverFixtureRoot, draftComposer, draftCwdPill, draftDecisionChip, draftDecisionChips,
  draftPanel, draftPanels, draftProjectPill, loadHome, mockQuickParse, openDraft, openDraftOnCwd,
  patchClientConfig, pickDraftFolder, seedColumns, typeAndSettle, watchForbiddenRequests,
} from './draft-helpers'
import {
  armParse, createTaskForLater, expectSeededTierLands, expectTaskInTier, pickDraftProject,
} from './draft-outcome-helpers'
import { openSessionFromPlus, pinToTier, plusControl } from './draft-surface-helpers'
import { presetPanelView } from './todo-panel-helpers'

/** Artifacts of this run. Per-run overridable so a later revision's artifacts
 *  don't overwrite this one's (same convention as the sibling spec). */
const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-seeds'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

// A real CLI spawn (scenario 1's Start) plus round-trips that queue behind the
// fixture's session health monitor on its seeded 500-session dataset — the same
// budget the sibling spec runs on, for the same reasons.
test.setTimeout(180_000)

// Serial within the file: all three scenarios mount the pinned area / project
// groups of ONE shared fixture and seed registry rows, so running them
// concurrently would have each observing the others' half-applied state.
test.describe.configure({ mode: 'serial' })

// ── 1. Project header "+" → project AND its default folder, one click (R7) ───

test('project header "+" opens a draft in one click with the project AND its default_cwd', async ({ page }) => {
  // The sibling spec's scenario 6 already proves the PILL reads the project and that
  // the seed reaches a "Create task for later". What R7 adds — and what only this
  // scenario checks — is the OTHER half of the seed: the project's declared folder
  // lands on the row too, so Start needs no folder pick. Plus the one-click contract
  // itself: no menu is allowed to appear between the "+" and the column (the "+"
  // used to be a two-item Add task / Add session menu, i.e. two clicks on both
  // branches).
  //
  // `PLUS_PROJECT` is its OWN project, not the shared 'Walnut': pointing Walnut at a
  // default_cwd would leak into every other spec that launches a Walnut task (the
  // fixture server is SHARED), and the folder here has to be one no other spec's
  // assertion depends on.
  const PLUS_PROJECT = 'PlusSeedProj'
  const seedCwd = `${fixtureRoot}/projects/zmarinax`
  const seed = await page.request.put(`/api/projects/${PLUS_PROJECT}/metadata`, {
    data: { default_cwd: seedCwd },
  })
  expect(seed.ok(), await seed.text()).toBe(true)
  // The group only renders with a task in it (an empty registry row is invisible in
  // the task list), and the task is what makes the header — and its "+" — reachable.
  const stamp = Date.now()
  const taskRes = await page.request.post('/api/tasks', {
    data: { title: `plus-seed anchor ${stamp}`, source: 'local', project: PLUS_PROJECT },
  })
  expect(taskRes.ok(), await taskRes.text()).toBe(true)

  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  const header = page.locator('.todo-group-project-header').filter({
    has: page.locator('.todo-group-project-name').filter({ hasText: new RegExp(`^${PLUS_PROJECT}$`) }),
  }).first()
  await expect(header).toBeVisible({ timeout: 25_000 })
  await header.hover()

  const plus = plusControl(header)
  // R9 put the choice back on this surface (task / task with session / separator),
  // so the "+" IS a menu trigger here — `aria-expanded` is the machine-readable
  // form of that, and its title names the scope rather than one verb.
  await expect(plus, 'a multi-verb "+" advertises the scope it adds to')
    .toHaveAttribute('title', `Add to ${PLUS_PROJECT}`)
  expect(await plus.getAttribute('aria-expanded'), 'a menu trigger carries an expanded state').toBe('false')

  await openSessionFromPlus(page, header)

  // The session branch still lands on the column, and the menu closes behind it —
  // a menu left open over the fresh draft was the old two-item shape's other sin.
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('plus-menu')).toHaveCount(0)

  // Half one of the seed — synchronous, from the click itself.
  await expect(draftProjectPill(panel)).toHaveText(PLUS_PROJECT)
  // Half two — the project's declared folder, patched in when the detail fetch
  // lands (the column opens FIRST on purpose, so this is polled, not awaited
  // before the assertion above).
  await expect(draftCwdPill(panel)).toHaveText(basenameOf(seedCwd), { timeout: 15_000 })
  await expect(draftCwdPill(panel)).toHaveAttribute('title', `Working folder: ${seedCwd}`)

  // The seeded folder is NOT ✦-badged: it came from the registry, not the AI.
  await expect(panel.locator('.draft-ai-badge')).toHaveCount(0)

  // Shot taken HERE, while the SEEDED draft is what's on screen — the Start below
  // morphs the column into a real session, and auto-animate leaves the outgoing
  // draft half-faded for a paint, so an end-of-test shot documents the wrong state
  // (the sibling spec's bound-draft scenario shoots before its Start for the same
  // reason).
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-project-plus-seeds-folder.png`, fullPage: false })

  // …and it is a real launch config, not just a label: Start sends that cwd with
  // no folder pick in between, which is the whole point of seeding it.
  const message = `plus-seed launch probe ${stamp}`
  await draftComposer(page).fill(message)
  const launch = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await panel.locator('.draft-start-btn').click()
  const payload = (await launch).postDataJSON() as { cwd?: string; taskMeta?: { project?: string } }
  expect(payload.cwd, 'the seeded default_cwd is what actually launches').toBe(seedCwd)
  // The launch column really became a session (a 4xx would leave a pending
  // placeholder holding an error instead) — so the cwd above wasn't merely sent.
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 15_000 })
})

// ── 2. Pin-tier header "+" → a draft with that tier preset (R8) ─────────────

test('pin-tier header "+" opens a draft whose task lands in that tier', async ({ page }) => {
  // The tier row's "+" is the tier twin of the project one. Two things make it a
  // separate scenario rather than a copy: the tier is applied to `meta.pinTier`
  // (which nothing in the column renders any more — so the proof is the tier the
  // created task lands in), and the sublabel it lives in is a click-to-collapse row
  // + a dnd-kit drag surface — a "+" that doesn't stop those events folds the
  // section instead of opening a draft.
  //
  // The tier picked is Backlog: it is NOT the launcher default (every draft opens on
  // Focus), so a task landing in Backlog can only mean the seed was applied.
  // A built-in tier header only renders while that tier holds a pinned task, so
  // an anchor is pinned INTO Backlog to make its header (and its "+") real.
  const stamp = Date.now()
  const taskRes = await page.request.post('/api/tasks', {
    data: { title: `tier-plus anchor ${stamp}`, source: 'local', project: 'Work' },
  })
  expect(taskRes.ok(), await taskRes.text()).toBe(true)
  const taskId = ((await taskRes.json()) as { task: { id: string } }).task.id
  // An EMPTY built-in tier draws no header (home navigation), so the anchor sits
  // in Backlog itself; the seed is still read off the NEW task's tier.
  await pinToTier(page, taskId, 'backlog')

  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  // Parse ON for this page, answering with a DIFFERENT tier than the seed.
  await patchClientConfig(page, { quickParse: true })
  const parse = await mockQuickParse(page, { pinTier: 'satellite' })
  await loadHome(page)

  const sublabel = page.locator('.todo-pinned-sublabel[data-navigation-id="backlog"]').first()
  await expect(sublabel).toBeVisible({ timeout: 25_000 })
  await sublabel.hover()
  const plus = plusControl(sublabel)
  await expect(plus).toBeVisible()

  // Armed BEFORE the click: a tier is a local value, so unlike the project "+"
  // (which fetches the project detail for its default_cwd) this route must touch
  // nothing server-side at all — opening the menu included.
  // The tier's fold state before the click (home navigation may start it folded).
  const zonesBefore = await page.locator('[data-drop-zone="backlog-drop-zone"]').count()
  const seen = watchForbiddenRequests(page)
  await openSessionFromPlus(page, sublabel)

  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  expect(seen, 'the tier "+" is a pure client-state route').toEqual([])
  // The click must NOT have reached the sublabel's own collapse handler — the tier's
  // task list is exactly as mounted as before (a fold toggle would flip its drop zone).
  await expect(page.locator('[data-drop-zone="backlog-drop-zone"]')).toHaveCount(zonesBefore)

  // C17: the seed shows as a tier chip, WITHOUT ✦ (the user clicked the "+"),
  // and the old tier row stays gone.
  await expect(panel.locator('.pin-tier-options')).toHaveCount(0)
  const tierChip = draftDecisionChip(panel, 'pinTier')
  await expect(tierChip).toHaveText(/Backlog/)
  await expect(tierChip.locator('.draft-ai-badge')).toHaveCount(0)
  await expect(tierChip).toHaveAttribute('title', 'Pinned tier: Backlog. From the + on the Backlog section. Click to change.')
  // The seed must NOT read as a user meta edit — `metaTouched` is also the
  // per-directory launch-memory switch, and latching it here would freeze the
  // model at whatever folder is picked first. Observable proxy: picking a folder
  // still refreshes the model select from that folder's memory. Nothing in the
  // fixture remembers a model, so assert the weaker invariant the DOM exposes —
  // the select stays on Auto rather than being pinned to a stale value.
  // (The control is a PILL opening the shared two-pane picker now — the chosen
  // model rides its data-model attribute, '' = Auto.)
  await expect(panel.locator('.draft-model-select')).toHaveAttribute('data-model', '')

  // A tier seed leaves everything else neutral (this is not a project route):
  // no folder, no project. Nothing pre-selects either on an unseeded/tier-only
  // draft (user rule, 2026-09-02).
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')
  await expect(draftProjectPill(panel)).toHaveText('Inbox')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-tier-plus-seeds-tier.png`, fullPage: false })

  // A parse that proposes another tier does not move the seed.
  await typeAndSettle(page, parse, `put this in satellite ${stamp}`)
  await expect(tierChip).toHaveText(/Backlog/)
  await expect(tierChip.locator('.draft-ai-badge')).toHaveCount(0)

  // THE assertion, read off the OUTCOME on the board: the task this draft creates
  // lands in Backlog, not in the Focus default.
  await expectSeededTierLands(page, panel, 'backlog', `backlog header seed probe ${stamp}`)
})

test('a tier seed survives the folder picker (the pick a seeded draft must make before it can Start)', async ({ page }) => {
  // The full picker hands back its OWN meta on select, and the row takes it
  // wholesale. Until 2026-09-15 a seeded draft (metaTouched false) opened the
  // picker on the DEFAULTS, so the very folder pick every tier "+" draft needs
  // before Start silently put the task back in Focus — invisible now that the
  // column draws no tier. Same seed as above, plus the pick, same OUTCOME check.
  const stamp = Date.now()
  const taskRes = await page.request.post('/api/tasks', {
    data: { title: `tier-plus picker anchor ${stamp}`, source: 'local', project: 'Work' },
  })
  expect(taskRes.ok(), await taskRes.text()).toBe(true)
  const anchorId = ((await taskRes.json()) as { task: { id: string } }).task.id
  // An EMPTY built-in tier draws no header (home navigation), so the anchor sits
  // in Backlog itself; the seed is still read off the NEW task's tier.
  await pinToTier(page, anchorId, 'backlog')

  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  const sublabel = page.locator('.todo-pinned-sublabel[data-navigation-id="backlog"]').first()
  await expect(sublabel).toBeVisible({ timeout: 25_000 })
  await sublabel.hover()
  await openSessionFromPlus(page, sublabel)
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })

  // Through the REAL picker (not a quick chip — chips merge into the row's meta and
  // never had the bug): a folder the fixture owns no launch memory for, so the
  // picker's memory merge runs its "reset to Auto" branch against the seed.
  const cwd = `${fixtureRoot}/projects/mcps`
  await pickDraftFolder(page, panel, cwd)
  await expect(draftCwdPill(panel)).toContainText(basenameOf(cwd))

  await expectSeededTierLands(page, panel, 'backlog', `backlog seed after folder pick ${stamp}`)
})

// ── 3. AI backfill while typing (R9) ────────────────────────────────────────

/**
 * The parse endpoint, STUBBED.
 *
 * The fixture has no AI provider, so the real POST /api/tasks/quick-parse degrades
 * to a title-only 200 (`parseQuickTask` swallows the failure and returns
 * `{title}`) — a correct product behavior that asserts nothing about the backfill.
 * Stubbing is therefore not a shortcut around a broken feature: it is the only way
 * to pin the CONTRACT (this payload → these pills) instead of testing the model.
 * The rest of the chain — debounce, staleness guards, ownership rules, badges — is
 * the real code.
 */
async function stubParse(
  page: import('@playwright/test').Page,
  body: Record<string, unknown> | 'error',
): Promise<void> {
  // The parse is opt-in (`agent.quick_parse`, default off); switch it on for this
  // page only, so no other spec file's worker sees the flag move.
  await patchClientConfig(page, { quickParse: true })
  await mockQuickParse(page, body)
}

test('typing back-fills the project pill and the tier chip with a ✦ badge, and a user pick then wins', async ({ page }) => {
  // The project the stub "suggests" must EXIST in the registry with a declared
  // folder, because the backfill's cwd half is a registry lookup (no fetch) — a
  // name with no row would prove only half the rule.
  const AI_PROJECT = 'AiPickProj'
  const aiCwd = `${fixtureRoot}/projects/mcps`
  const seed = await page.request.put(`/api/projects/${AI_PROJECT}/metadata`, {
    data: { default_cwd: aiCwd },
  })
  expect(seed.ok(), await seed.text()).toBe(true)

  await page.setViewportSize({ width: 2400, height: 1000 })
  // The stub ALSO answers with a tier that is not the default. Since the visible
  // decisions slice it is applied AND shown as a ✦ tier chip the user can change.
  await stubParse(page, { title: 'ship the wallet flow', project: AI_PROJECT, pinTier: 'backlog' })
  await loadHome(page)

  const panel = await openDraft(page)
  // The starting state, so every flip below is a real change.
  await expect(draftProjectPill(panel)).toHaveText('Inbox')
  await expect(panel.locator('.draft-ai-badge')).toHaveCount(0)

  // Typing is the trigger — the draft OPEN path is contractually network-free, so
  // the parse can only be armed by text. `type` (not fill) so the 500ms debounce
  // sees a real keystroke burst.
  const parsed = armParse(page)
  await draftComposer(page).type('ship the wallet flow this sprint')
  await parsed()

  // THE assertion: the project pill follows the suggestion and says WHO chose (✦).
  await expect(draftProjectPill(panel)).toHaveText(`${AI_PROJECT}✦`, { timeout: 10_000 })
  await expect(draftProjectPill(panel)).toHaveClass(/session-action-chip-ai/)
  // The stub's Backlog is applied, shown, and badged as Walnut's decision.
  await expect(panel.locator('.pin-tier-options')).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Backlog/)
  await expect(draftDecisionChip(panel, 'pinTier').locator('.draft-ai-badge')).toHaveCount(1)
  // The AI project drags its folder along (one gesture configures both, same rule
  // the quick chips follow) — and that folder is ✦ too, since nobody picked it.
  await expect(draftCwdPill(panel)).toHaveText(`${basenameOf(aiCwd)}✦`)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/03a-ai-backfill.png`, fullPage: false })

  // ── The user takes over, and the AI must never take it back ──
  //
  // Pick a DIFFERENT project by hand through the real pill flyout. From here on the
  // row's `projectSource` is 'user', which is FINAL: the rule under test is not
  // "the last write wins" but "a human's pick outranks every later parse".
  // (The badge goes with the takeover: a ✦ on a value the user chose is a lie —
  // pickDraftProject asserts that too.)
  await pickDraftProject(page, panel, 'Inbox')

  // Type on — the stub still answers with AI_PROJECT, and it must be ignored. The
  // wait is "applied", not "received" (armParse), so the assertion cannot pass on
  // a parse that simply had not landed yet.
  const reparsed = armParse(page)
  await draftComposer(page).type(' and add the receipts screen')
  await reparsed()
  await expect(draftProjectPill(panel), 'a user-picked project is FINAL against the AI')
    .toHaveText('Inbox')
  await expect(draftProjectPill(panel)).not.toHaveClass(/session-action-chip-ai/)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/03b-user-pick-wins.png`, fullPage: false })

  // Commit, and read the two claims off what the commit carried: the ledger
  // records AI_PROJECT as proposed and the human's Inbox as what won (chosen
  // absent = Inbox), and the tier the user saw and kept is on record too.
  const feedback = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/tasks/suggest-feedback',
  { timeout: 20_000 })
  const taskId = await createTaskForLater(page, panel)
  const ledger = (await feedback).postDataJSON() as {
    entries?: Array<{ field: string; suggested?: string; chosen?: string }>
  }
  const byField = new Map((ledger.entries ?? []).map((e) => [e.field, e]))
  expect(byField.get('project'), 'the overridden project suggestion is on record')
    .toMatchObject({ suggested: AI_PROJECT })
  expect(byField.get('project')?.chosen, 'Inbox won').toBeUndefined()
  expect(byField.get('pinTier')).toMatchObject({ suggested: 'backlog', chosen: 'backlog' })
  // …and the task itself: the user's Inbox, and the tier the chip showed.
  const detail = (await (await page.request.get(`/api/tasks/${taskId}`)).json()) as
    { task?: { project?: string } }
  expect(detail.task?.project ?? '').toBe('')
  await expectTaskInTier(page, taskId, 'backlog')
})

test('AI-suggested dates ride BOTH exits onto the task', async ({ page }) => {
  // The Quick Task form's date trio (start/end/due) exists on the draft too — the
  // parse fills meta.dueDate/startDate/endDate, and BOTH exits (Create task for
  // later, Start) write the dates onto the created task. The column shows them as
  // ✦ chips (Start, Due; this due is in the past, so it reads as overdue), and the
  // outcome is asserted against the API, which is also where end_date lives.
  const DUE = '2026-08-14T17:00:00'
  const START = '2026-08-14T15:00:00'
  await page.setViewportSize({ width: 2400, height: 1000 })
  await stubParse(page, { title: 'ship it', due_date: DUE, start_date: START })
  await loadHome(page)

  // ── Exit 1: "Create task for later" carries the dates ──
  const panel = await openDraft(page)
  const stamp = Date.now()
  // The parse has to have been APPLIED before the commit (armParse), or the exit
  // would carry no dates for reasons that have nothing to do with the contract
  // under test — no pill shows them, so the response is the only signal.
  const parsed = armParse(page)
  await draftComposer(page).type(`Ship the launch checklist ${stamp} by friday 3-5pm`)
  await parsed()
  // The old meta row stays gone; the dates are chips instead.
  await expect(panel.locator('.sps-meta-more-btn')).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'dueDate').locator('.draft-ai-badge')).toHaveCount(1)
  await expect(draftDecisionChip(panel, 'dueDate')).toHaveClass(/draft-decision-chip-overdue/)
  await expect(draftDecisionChip(panel, 'startDate')).toHaveText(/^Start /)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03d-ai-dates-as-chips.png`, fullPage: false })

  const taskId = await createTaskForLater(page, panel)
  const detail = (await (await page.request.get(`/api/tasks/${taskId}`)).json()) as
    { task?: { due_date?: string; start_date?: string } }
  expect(detail.task?.due_date, 'due_date must survive the task exit').toBe(DUE)
  expect(detail.task?.start_date, 'start_date must survive the task exit').toBe(START)

  // ── Exit 2: Start (quick-start) writes the same dates on ITS task ──
  const panel2 = await openDraftOnCwd(page, `${fixtureRoot}/projects/mcps`)
  const parsed2 = armParse(page)
  await draftComposer(page).type(`start the checklist ${stamp} friday`)
  await parsed2()
  await expect(panel2.locator('.sps-meta-more-btn')).toHaveCount(0)
  const launched = page.waitForResponse((res) =>
    res.request().method() === 'POST'
    && new URL(res.url()).pathname === '/api/sessions/quick-start' && res.ok())
    .then((res) => res.json() as Promise<{ taskId: string }>)
  await panel2.locator('.draft-start-btn').click()
  const { taskId: qsTaskId } = await launched
  await expect.poll(async () => {
    const body = (await (await page.request.get(`/api/tasks/${qsTaskId}`)).json()) as
      { task?: { due_date?: string; start_date?: string } }
    return [body.task?.due_date, body.task?.start_date]
  }, { timeout: 20_000, message: 'quick-start never wrote the dates' }).toEqual([DUE, START])

  await page.screenshot({ path: `${SCREENSHOT_DIR}/03e-ai-dates-both-exits.png`, fullPage: false })
})

// ── 4. Session "Fork" → a pre-bound fork DRAFT column (R10) ─────────────────

test('Fork opens a pre-bound draft: pinned folder/project, no chips/meta/task-exit, and Fork ↵ calls the fork API', async ({ page }) => {
  // The Fork button no longer opens its own popover form — it opens the SAME
  // draft column every "+" opens, pre-bound to the source session. What must
  // hold, per the fork contract (a fork resumes the source conversation in
  // place): folder + project arrive preselected and IMMUTABLE, the quick chips
  // and the tier/priority meta row are gone (the fork API takes only
  // message+model), "Create task for later" is gone (the fork route creates
  // the sibling task itself), and Start is relabelled Fork ↵ and calls
  // POST /api/sessions/<src>/fork — not quick-start.
  await page.setViewportSize({ width: 2400, height: 1000 })
  await seedColumns(page, ['pw-model-switch-session'])
  await loadHome(page)

  const sessionPanel = page.locator('.main-page-session-column .session-panel').first()
  await expect(sessionPanel).toBeVisible({ timeout: 20_000 })
  await sessionPanel.getByRole('button', { name: 'Fork session into a child task' }).click()

  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(panel.locator('.session-panel-title')).toHaveText('Fork Session')
  await expect(panel.locator('.draft-bound-task')).toContainText('fork of:')

  // The immutable seed: both pills render the SOURCE's facts, disabled.
  await expect(draftCwdPill(panel)).toBeDisabled()
  await expect(draftProjectPill(panel)).toBeDisabled()
  await expect(draftProjectPill(panel)).toHaveText('Walnut')
  // No folder chips, no tier/priority row, no task exit — only message + model.
  // C22: and no More and no decision chips either.
  await expect(panel.locator('.draft-quick-chips')).toHaveCount(0)
  await expect(panel.locator('.pin-tier-options, .sps-meta-more-btn')).toHaveCount(0)
  await expect(panel.locator('.draft-more-btn, .draft-decision-row')).toHaveCount(0)
  await expect(draftDecisionChips(panel)).toHaveCount(0)
  await expect(panel.locator('.draft-later-btn')).toHaveCount(0)
  await expect(panel.locator('.draft-model-select')).toBeVisible()
  await expect(panel.locator('.draft-start-btn')).toHaveText('Fork ↵')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05a-fork-draft.png`, fullPage: false })

  // Fork ↵ → POST /api/sessions/<source>/fork with the composed message.
  // Stubbed: the mock-CLI fixture can't execute a real --fork-session resume,
  // and the server-side fork contract has its own suite (session-controls).
  let forkBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/pw-model-switch-session/fork', (route) => {
    forkBody = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', sourceSessionId: 'pw-model-switch-session', sessionId: 'pw-forked-1', taskId: 'pw-task-fork-1' }),
    })
  })
  await draftComposer(page).type('take the other approach from here')
  await panel.locator('.draft-start-btn').click()
  await expect.poll(() => forkBody !== null, { timeout: 10_000, message: 'the fork API was never called' }).toBe(true)
  expect(forkBody!.message, 'the composed text rides as the fork message').toBe('take the other approach from here')
  expect(forkBody!.create_child_task, 'fork always creates the sibling task').toBe(true)
  expect(forkBody!.model, 'an untouched model select must NOT override the source').toBeUndefined()
  // The draft column is consumed by the morph (draft: → pending: → promoted).
  await expect(panel).toHaveCount(0, { timeout: 10_000 })
})

// ── 5. "/" opens the slash-command palette, like a real session composer ─────

test('"/" in the draft composer opens the command palette — mid-text too, and after a folder pick', async ({ page }) => {
  // The draft composer is a session composer that hasn't launched yet, so "/"
  // must offer the same discovery a real session's input does. The fixture is a
  // real server: the LOCAL list always contains the built-ins (compact/context/
  // cost/files), so the assertions pin those rather than any machine-specific
  // skill. Three claims:
  //   1. no folder picked yet → "/" still opens (the LOCAL list);
  //   2. "/" works MID-TEXT (after typed words), not only on an empty composer;
  //   3. after picking a folder the palette still opens (list keyed to that cwd).
  await page.setViewportSize({ width: 2400, height: 1000 })
  await loadHome(page)

  const panel = await openDraft(page)
  const palette = panel.locator('.command-palette-wrap')

  // 1. Fresh draft, no cwd — "/" opens the palette with the built-ins.
  await draftComposer(page).type('/co')
  await expect(palette).toBeVisible({ timeout: 15_000 })
  await expect(palette.locator('.command-palette-name', { hasText: '/compact' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04a-slash-palette-no-cwd.png`, fullPage: false })
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  // 2. Mid-text: words first, then "/" after whitespace — still opens.
  await draftComposer(page).fill('')
  await draftComposer(page).type('review the retry logic ')
  await draftComposer(page).type('/con')
  await expect(palette).toBeVisible({ timeout: 15_000 })
  await expect(palette.locator('.command-palette-name', { hasText: '/context' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04b-slash-palette-mid-text.png`, fullPage: false })
  // Select with Enter: the command splices over the "/query" span, keeping the text.
  await page.keyboard.press('Enter')
  await expect(draftComposer(page)).toHaveValue('review the retry logic /context ')
  await expect(palette).toHaveCount(0)

  // 3. A folder picked → the palette still opens (now keyed to that cwd).
  await draftComposer(page).fill('')
  const panel2 = await openDraftOnCwd(page, `${fixtureRoot}/projects/wallets`)
  await draftComposer(page).type('/cos')
  await expect(panel2.locator('.command-palette-wrap .command-palette-name', { hasText: '/cost' }))
    .toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04c-slash-palette-with-cwd.png`, fullPage: false })
  await page.keyboard.press('Escape')
})

test('a failing quick-parse is a silent no-op — no toast, no pill change, no crash', async ({ page }) => {
  // Every backfill failure mode (no provider configured → 500, offline, a 400 on
  // over-long text) has to leave the draft EXACTLY as the user left it. This is the
  // one that ships: a fresh install has no fast model, so the 500 path is the
  // DEFAULT experience — a toast or a cleared pill there would be a visible bug in
  // a feature the user never asked for.
  await page.setViewportSize({ width: 2400, height: 1000 })
  await stubParse(page, 'error')
  await loadHome(page)

  const panel = await openDraft(page)
  // The pills BEFORE typing: a fresh draft opens with nothing pre-selected.
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')
  await expect(draftProjectPill(panel)).toHaveText('Inbox')
  const failed = armParse(page, 500)
  await draftComposer(page).type('this sentence will never be understood')
  await failed()

  // The pills stay untouched, nothing is badged, and no error surfaces. Asserted
  // AFTER the 500 landed, so this is the post-failure state, not a race.
  await expect(draftProjectPill(panel)).toHaveText('Inbox')
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')
  await expect(panel.locator('.draft-ai-badge')).toHaveCount(0)
  await expect(page.locator('.notification-toast--error')).toHaveCount(0)
  await expect(page.locator('.notification-toast--warning')).toHaveCount(0)
  // The column is still fully alive (a crashed panel would take the composer with
  // it), and the text the user typed is untouched.
  await expect(draftComposer(page)).toHaveValue('this sentence will never be understood')
  await expect(panel.locator('.draft-start-btn')).toBeVisible()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/03c-parse-error-silent.png`, fullPage: false })
})
