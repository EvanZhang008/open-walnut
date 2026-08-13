/**
 * Is there a route to a session from EVERY task surface — and can a user SEE it?
 *
 * The seeding spec (tests/e2e/browser/draft-session-seeds.spec.ts) proves that when
 * a "+" is clicked the draft comes up correctly configured. It says nothing about
 * whether that "+" EXISTS on the surface the user is looking at, and an adversarial
 * audit found four surfaces where it did not:
 *
 *   GAP-1  single-tier tabs (Satellite / Focus / Backlog / Wait / customs) had NO
 *          session "+" at all — the tier sublabels that carry one are gated on the
 *          stacked All view, so the tier tabs were the only region of the panel with
 *          no route to a session.
 *   GAP-2  a tier's "By project" folder label was a plain <div> with no action slot,
 *          so the by-project tier view had no project "+" (the All view's project
 *          header has had one since R7).
 *   GAP-3  the /tasks page's project group headers carried only the kebab.
 *   GAP-4  pinned tier CARDS rendered no ▶ Start, though the CSS already styled one —
 *          so the pinned area (the most-worked surface) was the one place a task row
 *          could not become a session in one click.
 *   GAP-5  the toolbar "+" still advertised "New session or task", naming a chooser
 *          that no longer exists (task creation moved INSIDE the draft).
 *   GAP-6  every "+" was `opacity: 0` until hover — a control nobody can see until
 *          they happen to hover the right row may as well not exist.
 *
 * Split from the seeding spec by SUBJECT (same convention as the other siblings, see
 * that file's header): this one owns REACHABILITY and DISCOVERABILITY — "the control
 * is on this surface, it is visible before you touch anything, and it does the same
 * thing here as everywhere else". Configuration semantics stay next door.
 *
 * House rules, inherited: `page.goto('/')` is the initial load only (via `loadHome`),
 * every later step is a real click, and anything that could race a concurrent spec on
 * the SHARED fixture server is scoped to a stamped title or a private project name.
 *
 * PROJECT / FOLDER ISOLATION. `SurfacePlusProj` declares `AcmeCapsDev` as its
 * `default_cwd`. Both names are private to this file: pointing the fixture's shared
 * 'Walnut' project at a folder would change where every other spec's Walnut launch
 * runs, and claiming a folder that renders as a quick-access CHIP would change what
 * tests/e2e/browser/draft-quick-chips.spec.ts sees as "unclaimed" (AcmeCapsDev has no
 * frequent-directories row, so it is never in the chip window).
 */

import { test, expect } from '@playwright/test'
import {
  basenameOf, discoverFixtureRoot, draftCwdPill, draftMetaAiSlot, draftPanel, draftProjectPill,
  draftTierBtn, loadHome, presetStickyTier, watchForbiddenRequests,
} from './draft-helpers'
import {
  navigateToTasksPage, pinToTier, presetTierViewModes, restVisibility, tasksPageGroupHeader,
  tierProjectLabel, tierViewBar,
} from './draft-surface-helpers'
import { presetPanelView } from './todo-panel-helpers'

/** Artifacts of this run. Per-run overridable, same convention as the siblings. */
const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-gap-fix'

/** The project both the tier-label and the /tasks scenarios seed from, and the
 *  folder it declares. FIXED (not stamped) so a retry re-PUTs the same registry row
 *  instead of adding a second project claiming the same folder. */
const SURFACE_PROJECT = 'SurfacePlusProj'
/** A second named project, needed only to make the by-project tier labels render at
 *  all: a tier with fewer than 2 DISTINCT projects deliberately shows no labels
 *  (a single label separates nothing). It claims no folder. */
const ALT_PROJECT = 'SurfaceAltProj'

let fixtureRoot = ''
let surfaceCwd = ''
test.beforeAll(async () => {
  fixtureRoot = await discoverFixtureRoot()
  surfaceCwd = `${fixtureRoot}/projects/AcmeCapsDev`
})

// Round-trips here queue behind the fixture's session health monitor on its seeded
// 500-session dataset (~20s event-loop blocks), and the /tasks scenario adds a real
// SPA navigation on top — the same budget the sibling specs run on, for the same
// reasons. No scenario in this file spawns a CLI.
test.setTimeout(180_000)

// Serial within the file: every scenario mounts the pinned area / project groups of
// ONE shared fixture and seeds registry rows + pins, so running them concurrently
// would have each observing the others' half-applied state.
test.describe.configure({ mode: 'serial' })

/** Create a task and return its id, failing loudly on a non-2xx (a silent create
 *  failure otherwise surfaces 25s later as a missing card). */
async function makeTask(
  page: import('@playwright/test').Page,
  data: Record<string, unknown>,
): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { source: 'local', ...data } })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { task: { id: string } }).task.id
}

/** Declare `default_cwd` on a project, creating the registry row if needed. */
async function claimFolder(
  page: import('@playwright/test').Page,
  project: string,
  cwd: string,
): Promise<void> {
  const res = await page.request.put(`/api/projects/${project}/metadata`, { data: { default_cwd: cwd } })
  expect(res.ok(), await res.text()).toBe(true)
}

// ── 1. A single-tier tab has its own session "+" (GAP-1) ────────────────────

test('the Satellite tab carries a tier "+" that opens a draft preset to Satellite', async ({ page }) => {
  // The tier TABS were the gap: in the stacked All view each tier owns a sublabel
  // row that carries a "+", but a solo tier tab renders no sublabel (the tab itself
  // names the tier), so there was no route to a session from the tab a user
  // actually works in. The control now lives in that tab's view-mode bar.
  //
  // The sticky default is preset to 'wait' — NOT the tier under test — so an active
  // Satellite button can only mean the seed was applied, never that it was already
  // there. (This is the same trick the sibling spec's Backlog scenario uses.)
  await presetStickyTier(page, 'wait')
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'satellite', project: '' })
  await loadHome(page)

  // The bar exists BECAUSE this is a single-tier tab (the All view has none), so
  // resolving the "+" through it is also the claim about WHERE the control lives.
  const bar = tierViewBar(page)
  await expect(bar).toBeVisible({ timeout: 25_000 })
  const plus = bar.getByRole('button', { name: 'New session in Satellite' })
  await expect(plus, 'the tier tab must offer a session route').toHaveCount(1)
  // A direct button, not a menu trigger: no aria-expanded is the machine-readable
  // form of "one click gets you the column".
  expect(await plus.getAttribute('aria-expanded'), 'a direct button has no expanded state').toBeNull()

  // Which view mode is active BEFORE the click, so the after-check below is a real
  // "unchanged", not a value that was never set.
  const modeBtn = bar.locator('.todo-minibar-btn', { hasText: 'By project' })
  const modeWasOn = await modeBtn.evaluate((el) => el.classList.contains('on'))

  // Armed BEFORE the click: a tier is a local value, so this route must touch
  // nothing server-side at all (contrast the project routes, which fetch a detail).
  const seen = watchForbiddenRequests(page)
  await plus.click()

  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  expect(seen, 'the tier "+" is a pure client-state route').toEqual([])
  // No menu was ever rendered between the click and the column.
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)

  // THE assertion, read off the control the user sees: Satellite is the active tier
  // in the draft's meta row, and the sticky default it replaced is not.
  await expect(draftTierBtn(panel, 'satellite')).toHaveAttribute('aria-pressed', 'true')
  await expect(draftTierBtn(panel, 'wait')).toHaveAttribute('aria-pressed', 'false')
  // Not ✦-badged: a "+" seed is the user asking, not an AI suggestion.
  await expect(draftMetaAiSlot(panel)).toHaveText('')
  // A tier seed leaves everything else neutral — this is not a project route.
  await expect(draftProjectPill(panel)).toHaveText('Inbox')

  // The "+" sits INSIDE the view-mode bar, so its click must not also hit the
  // mode buttons it shares that row with.
  expect(await modeBtn.evaluate((el) => el.classList.contains('on')),
    'the tier "+" must not flip the tier view mode').toBe(modeWasOn)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-01-tier-tab-plus.png`, fullPage: false })
})

test('every built-in tier tab exposes its own "+" with its own tier', async ({ page }) => {
  // GAP-1 was structural (the sublabels are gated on the All view), so fixing ONE
  // tab would look identical to fixing all of them from scenario 1's vantage point.
  // Walking the tabs by real clicks is what makes the claim "the tier tabs" rather
  // than "the Satellite tab".
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'focus', project: '' })
  await loadHome(page)

  for (const [section, label] of [
    ['focus', 'Focus'], ['satellite', 'Satellite'], ['backlog', 'Backlog'], ['wait', 'Wait'],
  ] as const) {
    const tab = page.locator('.todo-section-tabs [role="tab"]', { hasText: label }).first()
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    const plus = tierViewBar(page).getByRole('button', { name: `New session in ${label}` })
    await expect(plus, `the ${label} tab has no session "+"`).toHaveCount(1)
    // Rest-visible on every tab, not only the one scenario 6 measures.
    const { opacity, hovered } = await restVisibility(plus)
    expect(hovered, `the ${label} "+" was measured under the pointer`).toBe(false)
    expect(opacity, `the ${label} "+" is invisible at rest`).toBeGreaterThan(0.2)
    // `section` is the tier id the seed must carry — asserted through the label
    // above, which tierDisplayLabel derives from exactly that id.
    expect(label.toLowerCase()).toBe(section)
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-02-all-tier-tabs-plus.png`, fullPage: false })
})

// ── 2. A by-project tier label carries the project "+" (GAP-2) ──────────────

test('a tier "By project" label offers a project "+" that seeds project AND its folder', async ({ page }) => {
  // The by-project tier view clusters a tier into project runs with a folder label
  // above each. That label had no action slot, so the one surface that NAMES a
  // project inside a tier was the one place you could not start a session in it.
  //
  // Two tasks in two DIFFERENT projects: a tier with fewer than 2 distinct projects
  // deliberately renders no labels at all, so a single seeded project would prove
  // nothing (the assertion would fail for the wrong reason).
  await claimFolder(page, SURFACE_PROJECT, surfaceCwd)
  const stamp = Date.now()
  const mine = await makeTask(page, { title: `surface label anchor ${stamp}`, project: SURFACE_PROJECT })
  const other = await makeTask(page, { title: `surface label alt ${stamp}`, project: ALT_PROJECT })
  await pinToTier(page, mine, 'satellite')
  await pinToTier(page, other, 'satellite')

  await page.setViewportSize({ width: 2400, height: 1000 })
  // 'project' mode is the default, but the key rides ui-prefs-sync on a SHARED
  // server — another spec's flip to 'custom' would be merged back in at boot and
  // 'custom' renders NO labels. Pin it so this scenario can't be sabotaged.
  await presetTierViewModes(page, { satellite: 'project' })
  await presetPanelView(page, { section: 'satellite', project: '' })
  await loadHome(page)

  const label = tierProjectLabel(page, SURFACE_PROJECT)
  await expect(label).toBeVisible({ timeout: 25_000 })
  const plus = label.getByRole('button', { name: `New session in ${SURFACE_PROJECT}` })
  await expect(plus, 'the by-project tier label must carry a project "+"').toHaveCount(1)

  // The label is an HTML5 drag handle for project REORDERING, and it is also
  // `pointer-events: none` unless draggable — so the action slot has to re-enable
  // hit-testing without arming a drag. Proven by watching for the reorder WRITE
  // during the click window rather than diffing `/api/ordering` before/after: that
  // config key is global and another spec file (they run in parallel) could move it
  // between two reads, which would fail this for someone else's reason.
  const reorders: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname === '/api/ordering/projects') {
      reorders.push(req.url())
    }
  })
  await plus.click()

  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.task-kebab-menu'), 'one click, no menu').toHaveCount(0)

  // Half one of the seed — synchronous, from the click itself.
  await expect(draftProjectPill(panel)).toHaveText(SURFACE_PROJECT)
  // Half two — the project's declared folder, patched in when the detail fetch
  // lands. This is what proves the label's "+" routes through the SAME handler as
  // the All-view project header rather than merely setting a pill.
  await expect(draftCwdPill(panel)).toHaveText(basenameOf(surfaceCwd), { timeout: 15_000 })
  await expect(draftCwdPill(panel)).toHaveAttribute('title', `Working folder: ${surfaceCwd}`)
  // Registry-sourced, so NOT ✦-badged.
  await expect(panel.locator('.draft-ai-badge')).toHaveCount(0)

  // The press must not have armed the label's project reorder…
  expect(reorders, 'pressing the label "+" must not reorder projects').toEqual([])
  // …nor collapsed/unmounted the tier it sits in.
  await expect(tierProjectLabel(page, SURFACE_PROJECT)).toBeVisible()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-03-tier-label-plus.png`, fullPage: false })
})

// ── 3. /tasks group header "+" → a draft on the home columns (GAP-3) ────────

test('the /tasks group header "+" lands on home with a draft seeded from that project', async ({ page }) => {
  // Sessions live ONLY on the home columns, so /tasks cannot open one in place —
  // which is why its group headers had a kebab and nothing else. The fix rides the
  // existing `session-launcher:open` event (MainPage stays mounted behind every
  // route), so the CROSS-PAGE half is the part worth asserting: the draft has to be
  // open by the time home paints, and it has to carry the project's folder too —
  // proof it routed through the project handler rather than opening a bare draft.
  await claimFolder(page, SURFACE_PROJECT, surfaceCwd)
  const stamp = Date.now()
  await makeTask(page, { title: `tasks-page anchor ${stamp}`, project: SURFACE_PROJECT })

  await page.setViewportSize({ width: 2400, height: 1000 })
  await loadHome(page)
  // Real SPA navigation (never page.goto) — through the sidebar, as a user would.
  await navigateToTasksPage(page)

  const header = tasksPageGroupHeader(page, SURFACE_PROJECT)
  await expect(header).toBeVisible({ timeout: 25_000 })
  const plus = header.getByRole('button', { name: `New session in ${SURFACE_PROJECT}` })
  await expect(plus, 'the /tasks group header must offer a session route').toHaveCount(1)
  // The kebab is still there — the "+" was ADDED beside it, not swapped in.
  // Addressed by ATTRIBUTE, not getByRole: the kebab's wrapper is `display: none`
  // until the row is hovered, and a role locator resolves through the accessibility
  // tree, which excludes display:none subtrees entirely (count 0, not 1).
  await expect(header.locator(`[aria-label="Actions for ${SURFACE_PROJECT}"]`)).toHaveCount(1)

  await plus.click()

  // Navigated home, and the draft is already there.
  await expect.poll(() => new URL(page.url()).pathname,
    { timeout: 15_000, message: 'the "+" never navigated home' }).toBe('/')
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(draftProjectPill(panel)).toHaveText(SURFACE_PROJECT)
  // The folder half: only handleOpenLauncherForProject patches this in, so its
  // presence is what distinguishes the fix from a generic "open a draft" event.
  await expect(draftCwdPill(panel)).toHaveText(basenameOf(surfaceCwd), { timeout: 15_000 })
  // The header's click handler toggles the group's collapse — the "+" must not have
  // also folded it (checked after the navigation, so the state is the persisted one).
  const collapsed = await page.evaluate(() => {
    try { return localStorage.getItem('walnut-tasks-page-collapsed') ?? '[]' } catch { return '[]' }
  })
  expect(JSON.parse(collapsed) as string[],
    'the "+" must not toggle the group it sits in').not.toContain(SURFACE_PROJECT)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-04-tasks-page-plus.png`, fullPage: false })
})

// ── 4. A pinned tier card can start a session (GAP-4) ───────────────────────

test('▶ on a title-only pinned tier card opens a bound draft, exactly like a list row', async ({ page }) => {
  // The pinned area is the most-worked surface, and it was the one place a task
  // could not become a session in one click — the CSS already styled a ▶ on
  // `.todo-pinned-card`, so this was a missing render, not a missing design.
  //
  // Title-only ON PURPOSE: a bare title is not a brief, so ▶ must hand over a BOUND
  // draft instead of spending a launch (the same rule the list rows follow —
  // tests/e2e/browser/draft-session-column.spec.ts scenario 8). The task carries its
  // own cwd, so the bound draft needs no folder pick.
  const stamp = Date.now()
  const title = `pinned card start probe ${stamp}`
  const taskId = await makeTask(page, { title, project: SURFACE_PROJECT, cwd: surfaceCwd })
  await pinToTier(page, taskId, 'satellite')

  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'satellite', project: '' })
  await loadHome(page)

  const card = page.locator(`.todo-pinned-card[data-task-id="${taskId}"]`)
  await expect(card).toBeVisible({ timeout: 25_000 })
  await card.hover()
  const startBtn = card.locator('.task-start-btn')
  await expect(startBtn, 'a pinned tier card must offer ▶ Start').toHaveCount(1)
  await expect(startBtn).toBeVisible()
  // Same control as everywhere else, addressed by the shared aria-label rather than
  // the class — a second definition drifting under the same class is the regression
  // this guards.
  await expect(startBtn).toHaveAttribute('aria-label', 'Start a session for this task')

  const seen = watchForbiddenRequests(page)
  await startBtn.click()

  // A draft, NOT a launch: `launchQuickStart` fires its POST synchronously, so by
  // the time the panel is up a direct launch would already be in `seen`.
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  expect(seen, '▶ on a title-only task must not launch anything').toEqual([])
  await expect(page.locator('.pending-session-panel')).toHaveCount(0)

  // The binding is visible, and the task's own folder + project came along.
  await expect(panel.locator('.draft-bound-task')).toContainText(title)
  await expect(draftCwdPill(panel)).toContainText(basenameOf(surfaceCwd))
  await expect(draftProjectPill(panel)).toHaveText(SURFACE_PROJECT)
  // A bound draft already IS a task, so offering to create one could only duplicate.
  await expect(panel.locator('.draft-later-btn')).toHaveCount(0)
  // The press must not have leaked to the CARD's own click handler, which focuses
  // the row (`onFocusTask`) and paints it active. ▶ is a launch verb, not a
  // "select this row" verb, and the button's stopPropagation is the only thing
  // keeping the two apart.
  await expect(card, '▶ must not also focus the card').not.toHaveClass(/todo-pinned-card-active/)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-05-pinned-card-start.png`, fullPage: false })
})

// ── 5. The toolbar "+" advertises what it actually does (GAP-5) ─────────────

test('the toolbar "+" tooltip says "New session" — the task branch it promised is gone', async ({ page }) => {
  // The button used to open a Session|Task chooser popover, and its tooltip said so.
  // The popover is gone (task creation moved INSIDE the draft as "◌ Create task for
  // later"), so the old copy pointed at a chooser that no longer exists. Tooltip AND
  // aria-label, because the second is the only label a screen reader ever reads.
  await loadHome(page)

  const btn = page.locator('.new-launcher-btn')
  await expect(btn).toBeVisible({ timeout: 25_000 })
  await expect(btn).toHaveAttribute('title', 'New session')
  await expect(btn).toHaveAttribute('aria-label', 'New session')
  // Asserted as a pair with the behavior: a tooltip is only correct relative to what
  // the click does, so this also pins "one click → a draft column, no chooser".
  await btn.click()
  await expect(draftPanel(page)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.todo-launcher-popover')).toHaveCount(0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-06-toolbar-tooltip.png`, fullPage: false })
})

// ── 6. Every "+" is visible BEFORE you hover it (GAP-6) ────────────────────

test('the session "+" is legible at rest on every surface, while the kebab stays hover-only', async ({ page }) => {
  // A control that only exists on hover is a control nobody finds: you have to
  // already know it is there to hover the right row. All four "+" surfaces are now
  // muted-but-visible at rest and go full on hover — the KEBAB deliberately did not
  // change, and that contrast is asserted too, so "make it discoverable" can't
  // quietly become "reveal every action all the time".
  //
  // Measured as EFFECTIVE opacity (the element's own, multiplied through every
  // ancestor): a button at .45 inside a wrapper at 0 is invisible, and reading only
  // its own value would call that discoverable. Every reading also asserts the
  // pointer was NOT over the element, so these are true rest states.
  await claimFolder(page, SURFACE_PROJECT, surfaceCwd)
  const stamp = Date.now()
  const mine = await makeTask(page, { title: `rest visibility anchor ${stamp}`, project: SURFACE_PROJECT })
  const other = await makeTask(page, { title: `rest visibility alt ${stamp}`, project: ALT_PROJECT })
  await pinToTier(page, mine, 'satellite')
  await pinToTier(page, other, 'satellite')

  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetTierViewModes(page, { satellite: 'project' })
  await presetPanelView(page, { section: 'satellite', project: '' })
  await loadHome(page)

  // Surface A — the tier tab's view-mode bar (GAP-1's control).
  const tierPlus = tierViewBar(page).getByRole('button', { name: 'New session in Satellite' })
  await expect(tierPlus).toHaveCount(1, { timeout: 25_000 })
  const tierRest = await restVisibility(tierPlus)
  expect(tierRest.hovered, 'the tier "+" was measured under the pointer').toBe(false)
  expect(tierRest.opacity, 'the tier tab "+" is invisible at rest').toBeGreaterThan(0.2)

  // Surface B — the by-project tier label (GAP-2's control).
  const labelPlus = tierProjectLabel(page, SURFACE_PROJECT)
    .getByRole('button', { name: `New session in ${SURFACE_PROJECT}` })
  await expect(labelPlus).toHaveCount(1, { timeout: 25_000 })
  const labelRest = await restVisibility(labelPlus)
  expect(labelRest.hovered, 'the label "+" was measured under the pointer').toBe(false)
  expect(labelRest.opacity, 'the tier project label "+" is invisible at rest').toBeGreaterThan(0.2)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-07-rest-visible-home.png`, fullPage: false })

  // Surface C — the /tasks group header, reached by real SPA navigation. Its "+"
  // and its kebab share one row, which is what makes the contrast measurable side
  // by side rather than across two different designs.
  await navigateToTasksPage(page)
  const header = tasksPageGroupHeader(page, SURFACE_PROJECT)
  await expect(header).toBeVisible({ timeout: 25_000 })

  const pagePlus = header.getByRole('button', { name: `New session in ${SURFACE_PROJECT}` })
  const pageRest = await restVisibility(pagePlus)
  expect(pageRest.hovered, 'the /tasks "+" was measured under the pointer').toBe(false)
  expect(pageRest.opacity, 'the /tasks group header "+" is invisible at rest').toBeGreaterThan(0.2)

  // The kebab on that SAME header is still hover-only — the change was targeted at
  // the primary verb. Addressed by ATTRIBUTE because its wrapper is `display: none`
  // at rest, which puts it outside the accessibility tree a role locator searches.
  const kebab = header.locator(`[aria-label="Actions for ${SURFACE_PROJECT}"]`)
  const kebabRest = await restVisibility(kebab)
  expect(kebabRest.opacity, 'the kebab must stay hover-only').toBe(0)
  // …and it DOES appear on hover, so the line above is "hidden at rest", not "broken".
  await header.hover()
  await expect(kebab).toBeVisible()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/spec-08-rest-visible-tasks-page.png`, fullPage: false })
})
