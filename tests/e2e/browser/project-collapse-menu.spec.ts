/**
 * Playwright browser tests: PROJECT rows are CLICKABLE and RIGHT-CLICKABLE.
 *
 * The project-level twin of folder-collapse-menu.spec.ts (folder rows), and it
 * reuses that file's idioms deliberately: same API fixtures, same
 * retry-the-whole-gesture helpers for a context menu that dismisses itself on
 * scroll. One test per user-visible behaviour:
 *
 *   1. Pinned tier ("By project" view): clicking the project label row anywhere
 *      folds that project's run. Its task cards AND its folder chips hide, the
 *      chevron un-rotates, and the rows stay in the DOM (hidden, never
 *      unmounted: their ids must stay in the tier's SortableContext or dnd-kit's
 *      indices shift under a live drag). "Anywhere" is measured, not claimed:
 *      the name, the kind tag, the count badge and the row's own slack strip.
 *   2. ONE collapse set, both surfaces: folding in the tier folds the same project
 *      in the main list, the fold survives a reload (`walnut-todo-collapsed-projs`),
 *      and unfolding from the MAIN LIST brings the tier's run back.
 *   3. Main list: clicking the header row BODY folds the group, while clicking the
 *      NAME still opens the project detail pane and folds nothing.
 *   4. Inbox (stored as '', which is FALSY) folds and unfolds on BOTH surfaces.
 *      Every gate in this feature had to be written around that empty string, so
 *      Inbox gets its own end-to-end fold test, not just a menu test.
 *   5. A tier with ONE project draws NO project label, and a fold that arrives
 *      from the main list must NOT hide its cards. That gate is a one-way door:
 *      a tier that hid rows with no label to unfold them could never be reopened.
 *   6. Right-click a named project row (main list) opens Walnut's own project menu
 *      with the registry actions; right-click INBOX opens the short menu, because
 *      Inbox is the absence of a project, so it has no row to rename, favorite or
 *      delete.
 *   7. The tier's project label carries the SAME menu (one definition, two hosts).
 *   8. "Add separator" is a TIER row only: the main list has no view mode, so a
 *      divider line there would have no defined position.
 *   9. Rename driven from the context menu really renames the project.
 *  10. Delete driven from the context menu (local claim): the confirm names the
 *      task count, the tasks land in the Inbox, and the group disappears.
 *  11. Renaming a folded project LOSES the fold rather than stranding it: the
 *      collapse key is the project NAME, and the prune effect drops the stale key
 *      when the tasks reload. Folding after a rename still works.
 *  12. Pressing "+" on a project row does NOT fold it (neither surface).
 *  13. A real pointer SLIP (press, move a few px, release) on the tier's "+" and on
 *      the main-list chevron and star still performs the control's own action and
 *      never turns into a project drag. A click at one coordinate cannot catch
 *      this: both surfaces disarm their drag handle on pointer ENTER / pointerdown.
 *  14. Dragging one project label onto another still REORDERS the tier's project
 *      runs, and the completed drag folds neither project.
 *  15. The same for the MAIN LIST's dnd-kit project reorder: a real drag reorders
 *      the groups and folds neither, even though that header's click handler is
 *      exactly the fold.
 *  16. A card drag while ANOTHER project's run is folded lands where it was
 *      dropped and never inside the folded run. Folded rows keep their sortable
 *      ids but are display:none, i.e. all-zero rects at the viewport origin, so
 *      they are excluded as DROP targets (`disabled.droppable`).
 *  17. While a pinned card drag is live the label refuses the fold (`inert`),
 *      because folding a run out from under a pointer that is dragging a card
 *      into it is how dnd-kit's indices shift.
 *
 * Case 1 asserts hidden-but-attached; case 3's main list is different ON PURPOSE
 * and not a bug: the main list unmounts a folded group's rows (it has no live
 * SortableContext to protect), so there the assertion is "detached".
 *
 * All data is unique per run (suffixes) and parallel-safe against the shared
 * fixture server. Everything created is registered in `litter` and removed in
 * afterEach, INCLUDING after a failed assertion: the Focus tier is shared state
 * whose geometry other specs' drag tests measure, and a leaked pin or a leaked
 * project group changes what they see.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { presetTierViewModes } from './draft-surface-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

// Round-trips queue behind the fixture's session health monitor on its seeded
// dataset, and the menu helpers below retry a whole gesture for up to 30s. With
// the config's 30s per-test budget a helper could never exhaust its own retry
// loop, so every real failure surfaced as "Test timeout of 30000ms exceeded"
// instead of the inner message that says what actually went wrong. Same budget
// the sibling surface specs run on (tier-separator.spec.ts).
test.setTimeout(180_000)

/**
 * Sequential inside this file, because the thing under test is ONE global value.
 *
 * The fold lives in `walnut-todo-collapsed-projs`, and that key starts with
 * `walnut-todo-`, so ui-prefs-sync mirrors it to the fixture SERVER and merges the
 * server copy back at boot, last-writer-wins per key. Two of these tests folding
 * different projects in parallel therefore overwrite each other's whole set, and
 * the test that reloads to prove the fold PERSISTED is the one that pays: it comes
 * back with the other test's set and reads as a product bug. Same reason
 * custom-focus-tiers.spec.ts serializes over the tier registry.
 *
 * `default` rather than `serial` on purpose: serial ABANDONS the rest of the file
 * after one failure, and 17 unrelated behaviours would then report as "did not
 * run". `default` is the same one-worker ordering without the skip cascade.
 */
test.describe.configure({ mode: 'default' })

/**
 * Everything this file creates, so afterEach can undo it even when an assertion
 * threw. Module scope is per WORKER, and beforeEach resets it, so a worker that
 * runs several of these tests in a row never inherits the previous one's list.
 */
const litter: { tasks: string[]; folders: string[]; projects: string[]; tiers: string[] } = {
  tasks: [], folders: [], projects: [], tiers: [],
}

/** Register a project name for cleanup (renames create a second one). */
function trackProject(name: string): void {
  if (name && !litter.projects.includes(name)) litter.projects.push(name)
}

test.beforeEach(() => {
  litter.tasks = []
  litter.folders = []
  litter.projects = []
  litter.tiers = []
})

/**
 * The fold sets are mirrored to the SHARED fixture server, and a fresh Playwright
 * context adopts whatever another spec FILE last wrote there (the note on
 * isolateUiPrefs has the mechanism). Serializing inside this file, as configured
 * above, does nothing about that: folder-collapse-menu.spec.ts drives the same two
 * keys and runs in PARALLEL with this file. Keep the fold local to each context.
 */
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  // Unpin BEFORE deleting: a pin row keyed on a deleted task is exactly the kind
  // of debris that shifts another spec's tier geometry.
  for (const id of litter.tasks) {
    await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const gid of litter.folders) {
    await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const tierId of litter.tiers) {
    await fetch(`${API}/api/focus/tiers/${tierId}`, { method: 'DELETE' }).catch(() => undefined)
  }
  // Registry rows last: deleting a project moves its remaining tasks to the Inbox,
  // so the task deletions above have to have happened first.
  for (const name of litter.projects) {
    await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
  }
})

async function createTaskViaApi(title: string, opts: Record<string, unknown> = {}): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  litter.tasks.push(body.task.id)
  if (typeof opts.project === 'string') trackProject(opts.project)
  return body.task
}

async function createFolderViaApi(taskIds: string[], label: string): Promise<string> {
  const res = await fetch(`${API}/api/tasks/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds, label }),
  })
  if (!res.ok) throw new Error(`folder create failed: ${res.status} ${await res.text()}`)
  const gid = ((await res.json()) as { group_id: string }).group_id
  litter.folders.push(gid)
  return gid
}

/** A tier NOBODY else pins into: the built-in tiers are shared fixture state, so
 *  "this tier holds exactly one project" is only true in a tier we own. */
async function createCustomTierViaApi(label: string): Promise<string> {
  const res = await fetch(`${API}/api/focus/tiers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error(`tier create failed: ${res.status} ${await res.text()}`)
  const id = ((await res.json()) as { tier: { id: string } }).tier.id
  litter.tiers.push(id)
  return id
}

async function pinToTierViaApi(taskId: string, tier: string): Promise<void> {
  const pin = await fetch(`${API}/api/focus/tasks/${taskId}`, { method: 'POST' })
  if (!pin.ok) throw new Error(`pin failed: ${pin.status} ${await pin.text()}`)
  const res = await fetch(`${API}/api/focus/tasks/${taskId}/tier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  })
  if (!res.ok) throw new Error(`tier failed: ${res.status} ${await res.text()}`)
}

async function pinToFocusViaApi(taskId: string): Promise<void> {
  await pinToTierViaApi(taskId, 'focus')
}

/** One task's server-side project ('' = Inbox): the truth behind a drop. */
async function taskProjectViaApi(taskId: string): Promise<string> {
  const res = await fetch(`${API}/api/tasks/${taskId}`)
  const body = (await res.json()) as { task: { project?: string } }
  return body.task.project ?? ''
}

/** The global pinned order, server side. */
async function serverPinnedOrder(): Promise<string[]> {
  const res = await fetch(`${API}/api/focus/tasks`)
  return ((await res.json()) as { pinned_tasks: string[] }).pinned_tasks
}

/**
 * Pin project GROUPING on before boot.
 *
 * Same ui-prefs-sync caveat every `walnut-todo-` key has: the value rides the
 * shared fixture server, so a spec that switched the list to flat mode would
 * follow this one and there would be no `.todo-group-project` bucket to assert on
 * (which reads as a product bug the next time someone runs this file alone).
 */
async function presetProjectGrouping(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ }
  })
}

/** A tier's drop zone, by tier id ('focus', or a custom `ct_…`). */
function tierZone(page: Page, tier = 'focus'): Locator {
  return page.locator(`[data-drop-zone="${tier}-drop-zone"]`)
}

/** One project label row inside a pinned tier ('' → the Inbox label). */
function tierLabel(page: Page, project: string, tier = 'focus'): Locator {
  return tierZone(page, tier).locator(`.tier-project-label[data-project="${project}"]`).first()
}

/** A pinned card in a tier. */
function tierCard(page: Page, taskId: string, tier = 'focus'): Locator {
  return tierZone(page, tier).locator(`[data-task-id="${taskId}"]`).first()
}

/** The tier's folder chip. */
function tierChip(page: Page, groupId: string, tier = 'focus'): Locator {
  return tierZone(page, tier).locator(`.task-group-chip[data-group-id="${groupId}"]`).first()
}

/** A tier's project runs, in render order ('' = Inbox). */
function tierProjectOrder(page: Page, tier = 'focus'): Promise<string[]> {
  return tierZone(page, tier).locator('.tier-project-label')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.project ?? ''))
}

/** One project's group in the main list, located by its header name. */
function projectBucket(page: Page, project: string): Locator {
  return page.locator('.todo-group-project').filter({
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${project}$`) }),
  }).first()
}

/** That group's header row (the thing this spec clicks). */
function listHeader(page: Page, project: string): Locator {
  return projectBucket(page, project).locator('.todo-group-project-header').first()
}

/** One task's row inside one project's group in the main list. */
function listRow(page: Page, project: string, taskId: string): Locator {
  return projectBucket(page, project).locator(`.todo-panel-item[data-task-id="${taskId}"]`)
}

/** The main list's project groups, in render order (Inbox reads as "Inbox"). */
function listProjectOrder(page: Page): Promise<string[]> {
  return page.locator('.todo-group-project .todo-group-project-name')
    .evaluateAll((els) => els.map((el) => el.textContent ?? ''))
}

/**
 * Click the header row's BODY: the empty strip right of the name button.
 *
 * Two things this encodes. The measurement is a real assertion, not setup: that
 * empty strip IS the feature (the name button shrink-wraps so the row has a fold
 * target of its own), and a hardcoded offset would keep passing if the button went
 * back to filling the row, where this click would open the detail pane instead.
 * And the click is a RELATIVE position on the controls element rather than absolute
 * page coordinates: Playwright re-resolves the element (and scrolls it into view)
 * at click time, whereas absolute `page.mouse.click` coordinates measured a moment
 * earlier land somewhere else entirely once the list settle-scrolls or the detail
 * pane resizes the panel. That cost a debugging round.
 */
async function clickListHeaderBody(page: Page, project: string): Promise<void> {
  const header = listHeader(page, project)
  // The strip runs from the end of the NAME BUTTON (the "open the pane" target) to
  // the start of the right-hand cluster (the star when there is one, else the "+").
  // Everything in between (the kind tag, the count, the slack) belongs to the row.
  const fav = header.locator('.todo-group-fav-btn')
  const rightCluster = (await fav.count()) ? fav : header.locator('.todo-group-header-actions')
  const hbox = await header.boundingBox()
  const nbox = await header.locator('.todo-group-name-btn').boundingBox()
  const rbox = await rightCluster.boundingBox()
  if (!hbox || !nbox || !rbox) throw new Error('project header has no box')
  const stripStart = nbox.x + nbox.width - hbox.x
  const stripEnd = rbox.x - hbox.x
  expect(stripEnd - stripStart, 'the header row must keep a strip of its own to click').toBeGreaterThan(40)
  await header.click({ position: { x: (stripStart + stripEnd) / 2, y: hbox.height / 2 } })
}

/**
 * The absolute viewport point of that same slack strip, for the ONE case that
 * needs real coordinates: a press-move-release drag, which the mouse API only
 * speaks in page coordinates. Everything else clicks a relative position on the
 * element instead (see clickListHeaderBody for why).
 */
async function headerSlackPoint(page: Page, project: string): Promise<{ x: number; y: number }> {
  const header = listHeader(page, project)
  await scrollOnScreen(page, header, `the ${project || 'Inbox'} header`)
  const fav = header.locator('.todo-group-fav-btn')
  const rightCluster = (await fav.count()) ? fav : header.locator('.todo-group-header-actions')
  const hbox = await header.boundingBox()
  const nbox = await header.locator('.todo-group-name-btn').boundingBox()
  const rbox = await rightCluster.boundingBox()
  if (!hbox || !nbox || !rbox) throw new Error('project header has no box')
  const stripStart = nbox.x + nbox.width
  const stripEnd = rbox.x
  expect(stripEnd - stripStart, 'the header row must keep a strip of its own to grab').toBeGreaterThan(40)
  return { x: (stripStart + stripEnd) / 2, y: hbox.y + hbox.height / 2 }
}

/**
 * Click the tier label's own SLACK: the gap between the count badge and the "+".
 *
 * Same reasoning as clickListHeaderBody, and the same reason it is measured rather
 * than hardcoded: `.tier-project-label-actions` is pushed right by `margin-left:
 * auto`, and that gap existing is what makes "click anywhere on the row" true.
 */
async function clickTierLabelSlack(page: Page, project: string, tier = 'focus'): Promise<void> {
  const label = tierLabel(page, project, tier)
  const lbox = await label.boundingBox()
  const cbox = await label.locator('.tier-project-label-count').boundingBox()
  const abox = await label.locator('.tier-project-label-actions').boundingBox()
  if (!lbox || !cbox || !abox) throw new Error('tier project label has no box')
  const slackStart = cbox.x + cbox.width - lbox.x
  const slackEnd = abox.x - lbox.x
  expect(slackEnd - slackStart, 'the label row must keep a strip of its own to click').toBeGreaterThan(24)
  await label.click({ position: { x: (slackStart + slackEnd) / 2, y: lbox.height / 2 } })
}

/**
 * Scroll an element on screen and PROVE it got there, for the gestures that need
 * absolute page coordinates (`page.mouse.*` speaks viewport coordinates only).
 *
 * The trap this exists for: `boundingBox()` answers for an element that is scrolled
 * out of the task list just as happily as for one on screen, and a press dispatched
 * at a y below the viewport lands on nothing. The gesture then "does nothing",
 * which reads exactly like the control being broken (it cost a debugging round on
 * the main-list chevron, whose group sits far down the shared fixture's list).
 * Playwright's own `click()` scrolls first, which is why the click-based helpers
 * never hit this.
 */
async function scrollOnScreen(page: Page, target: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error(`${what} has no box`)
  const view = page.viewportSize()
  if (view) {
    expect(box.y, `${what} must be ON SCREEN for a coordinate gesture`).toBeGreaterThan(0)
    expect(box.y + box.height, `${what} must be ON SCREEN for a coordinate gesture`).toBeLessThan(view.height)
  }
  return box
}

/**
 * Wait until a sortable row VISIBLY yields to the live drag, which is the proof
 * that dnd-kit resolved the drop target to the row being aimed at.
 *
 * Every list here is a `verticalListSortingStrategy` context, so while the button
 * is still down the rows between the dragged item and the drop target slide aside
 * by its height, and `boundingBox()` reports that CSS transform. Asserting it
 * BEFORE the release is what turns "the order never changed" 15 seconds later
 * (which says nothing about which step went wrong) into "the aim was off".
 */
async function expectRowYielded(row: Locator, staticY: number, what: string): Promise<void> {
  await expect.poll(async () => {
    const box = await row.boundingBox()
    return box ? Math.abs(box.y - staticY) : 0
  }, {
    timeout: 5_000,
    message: `${what} never slid aside, so the live drop target is not the row this gesture aimed at`,
  }).toBeGreaterThan(4)
}

/**
 * A real pointer SLIP on a small control: press, drift a few px, release.
 *
 * `click()` presses and releases at ONE coordinate, which is why it kept passing
 * with the drag disarms deleted. A trackpad does not do that: the pointer drifts
 * between press and release, and 4px on each axis (5.7px of travel) is past BOTH
 * gesture thresholds these rows carry: dnd-kit's PointerSensor `distance: 5` on the
 * main-list header, and Chromium's native HTML5 drag threshold on the tier label.
 * Either one, once armed, EATS the click the user meant.
 */
async function slipClick(page: Page, target: Locator): Promise<void> {
  const box = await scrollOnScreen(page, target, 'the slip target')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  // move first: pointerenter is what disarms the tier label's draggable ancestor.
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 4, y + 4, { steps: 2 })
  await page.mouse.up()
}

/**
 * Right-click a project row and wait for the menu, RETRYING the gesture.
 *
 * ContextMenu dismisses itself on any scroll by design (a cursor anchor is a
 * frozen viewport point, so after a scroll it no longer describes its row). The
 * fixture's task list can still settle-scroll for a moment after load, which
 * closes a menu that did open. Retrying the gesture is the honest way to test the
 * menu without pinning the scroll behaviour we deliberately want.
 */
async function openProjectMenu(page: Page, row: Locator, anItem: string): Promise<Locator> {
  const menu = page.locator('[data-testid="project-ctx-menu"]')
  await expect(async () => {
    await row.click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: anItem, exact: true })).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  return menu
}

/** Right-click a project row and CLICK one of its menu items (whole gesture retried). */
async function clickProjectMenuItem(page: Page, row: Locator, item: string): Promise<void> {
  const menu = page.locator('[data-testid="project-ctx-menu"]')
  await expect(async () => {
    await row.click({ button: 'right' })
    const entry = menu.getByRole('menuitem', { name: item, exact: true })
    await expect(entry).toBeVisible({ timeout: 2_000 })
    await entry.click({ timeout: 2_000 })
    // The menu closes on select, which is the signal the click actually landed.
    await expect(menu).toHaveCount(0, { timeout: 2_000 })
  }).toPass({ timeout: 25_000 })
}

/** Two projects pinned into Focus: the minimum for the tier to draw labels at
 *  all (a single label separates nothing, so the panel suppresses it). */
async function pinnedTwoProjectFixture(page: Page, stamp: string) {
  const projA = `PcolA${stamp}`
  const projB = `PcolB${stamp}`
  const a1 = await createTaskViaApi('Project fold member A1', { project: projA })
  const a2 = await createTaskViaApi('Project fold member A2', { project: projA })
  const b1 = await createTaskViaApi('Project fold member B1', { project: projB })
  // The folder lives inside projA, so folding projA must hide its chip too.
  const groupId = await createFolderViaApi([a1.id, a2.id], `PfoldFolder ${stamp}`)
  await pinToFocusViaApi(a1.id)
  await pinToFocusViaApi(a2.id)
  await pinToFocusViaApi(b1.id)

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await presetTierViewModes(page, { focus: 'project' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  return { projA, projB, a1, a2, b1, groupId }
}

test('pinned tier: clicking the project label folds its run — cards and folder chips hide, still mounted', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  const label = tierLabel(page, f.projA)
  await expect(label).toBeVisible({ timeout: 15_000 })
  await expect(label.locator('.collapse-chevron')).toHaveClass(/expanded/)
  // Visible rows this project contributes to THIS tier.
  await expect(label.locator('.tier-project-label-count')).toHaveText('2')
  await expect(tierCard(page, f.a1.id)).toBeVisible()
  await expect(tierChip(page, f.groupId)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/tier-project-expanded.png' })

  // Click the row BODY (the name text), not the chevron and not the "+".
  await label.locator('.tier-project-label-name').click()

  await expect(tierCard(page, f.a1.id)).toBeHidden()
  await expect(tierCard(page, f.a2.id)).toBeHidden()
  await expect(tierChip(page, f.groupId)).toBeHidden()
  // HIDDEN, not unmounted: the ids stay in the tier's SortableContext.
  await expect(tierCard(page, f.a1.id)).toBeAttached()
  await expect(tierChip(page, f.groupId)).toBeAttached()
  // The label row itself stays: it is what you click to unfold.
  await expect(label).toBeVisible()
  await expect(label.locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  // The OTHER project's run is untouched.
  await expect(tierCard(page, f.b1.id)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/tier-project-collapsed.png' })

  // "Anywhere on the row" is a claim about FOUR targets, so all four get used:
  // the name above, then the count badge, the kind tag, and the slack strip
  // between the count and the "+". Each one toggles, so each assertion below is
  // the inverse of the one before it.
  await label.locator('.tier-project-label-count').click()
  await expect(tierCard(page, f.a1.id)).toBeVisible()
  await label.locator('.project-kind-tag').click()
  await expect(tierCard(page, f.a1.id)).toBeHidden()
  await clickTierLabelSlack(page, f.projA)
  await expect(tierCard(page, f.a1.id)).toBeVisible()

  // And the chevron, which is the one target that is a real button.
  await label.locator('.collapse-chevron').click()
  await expect(tierCard(page, f.a1.id)).toBeHidden()
  await label.locator('.collapse-chevron').click()
  await expect(tierCard(page, f.a1.id)).toBeVisible()
})

test('one collapse set: folding in the tier folds the main list, survives a reload, and unfolds from either side', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  await expect(tierLabel(page, f.projA)).toBeVisible({ timeout: 15_000 })
  const row = listRow(page, f.projA, f.a1.id)
  await expect(row).toBeVisible()

  await tierLabel(page, f.projA).locator('.tier-project-label-name').click()

  // Same project, other surface: the main list group folded with it. The main
  // list UNMOUNTS a folded group's rows (no live SortableContext to protect),
  // hence toHaveCount(0) here and toBeHidden() in the tier.
  await expect(row).toHaveCount(0)
  await expect(listHeader(page, f.projA).locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/project-collapse/shared-fold-main-list.png' })

  // Persisted: a reload comes back folded on BOTH surfaces.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(tierLabel(page, f.projA)).toBeVisible({ timeout: 15_000 })
  await expect(tierCard(page, f.a1.id)).toBeHidden()
  await expect(listRow(page, f.projA, f.a1.id)).toHaveCount(0)

  // ...and vice versa: unfolding from the MAIN LIST body brings the tier run back.
  await clickListHeaderBody(page, f.projA)
  await expect(tierCard(page, f.a1.id)).toBeVisible({ timeout: 10_000 })
  await expect(tierLabel(page, f.projA).locator('.collapse-chevron')).toHaveClass(/expanded/)
})

test('main list: the header body folds the group, the NAME still opens the project pane', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const project = `PheadProj${stamp}`
  const task = await createTaskViaApi('Header fold member', { project })

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const header = listHeader(page, project)
  const row = listRow(page, project, task.id)
  await expect(header).toBeVisible({ timeout: 15_000 })
  await expect(row).toBeVisible()
  await expect(header.locator('.collapse-chevron')).toHaveClass(/expanded/)

  // The NAME is not the row: it opens the detail pane and folds nothing.
  await header.locator('.todo-group-name-btn').click()
  const pane = page.locator('.project-detail-pane')
  await expect(pane).toBeVisible({ timeout: 10_000 })
  await expect(pane.locator('.todo-detail-project')).toHaveText(project)
  await expect(header.locator('.collapse-chevron')).toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/project-collapse/main-list-name-opens-pane.png' })
  await pane.locator('.todo-detail-close').click()
  await expect(pane).toHaveCount(0)

  // The row BODY folds.
  await clickListHeaderBody(page, project)
  await expect(row).toHaveCount(0)
  await expect(header.locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/project-collapse/main-list-header-collapsed.png' })

  // And unfolds: the header row is the way back.
  await clickListHeaderBody(page, project)
  await expect(listRow(page, project, task.id)).toBeVisible()
})

test('Inbox (the falsy empty-string project) folds and unfolds on BOTH surfaces', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  // Inbox is stored as '', which is FALSY: every gate in this feature (the label
  // row, the collapse key, the drag participant, the menu's registry rows) had to
  // be written against the empty string rather than truthiness, and only an
  // end-to-end fold proves all of them at once.
  const inboxTask = await createTaskViaApi('Inbox fold member', {})
  const neighbour = `PinbNb${stamp}`
  const other = await createTaskViaApi('Inbox fold neighbour', { project: neighbour })
  await pinToFocusViaApi(inboxTask.id)
  await pinToFocusViaApi(other.id)

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await presetTierViewModes(page, { focus: 'project' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // The tier draws a label for '' and it reads "Inbox" while the DATA stays ''.
  const label = tierLabel(page, '')
  await expect(label).toBeVisible({ timeout: 15_000 })
  await expect(label.locator('.tier-project-label-name')).toHaveText('Inbox')
  await expect(label.locator('.collapse-chevron')).toHaveClass(/expanded/)
  const header = listHeader(page, 'Inbox')
  await expect(header).toBeVisible()
  await expect(header.locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(tierCard(page, inboxTask.id)).toBeVisible()
  await expect(listRow(page, 'Inbox', inboxTask.id)).toBeVisible()

  // Fold from the TIER row body.
  await label.locator('.tier-project-label-name').click()
  await expect(tierCard(page, inboxTask.id)).toBeHidden()
  await expect(tierCard(page, inboxTask.id)).toBeAttached()
  await expect(label.locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  // ONE collapse set, and '' is a legal key in it: the main list folded too.
  await expect(listRow(page, 'Inbox', inboxTask.id)).toHaveCount(0)
  await expect(listHeader(page, 'Inbox').locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  // The named neighbour is untouched, so this really was Inbox's own run.
  await expect(tierCard(page, other.id)).toBeVisible()
  await expect(listRow(page, neighbour, other.id)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/inbox-folded-both-surfaces.png' })

  // Unfold from the MAIN LIST body: the other direction, same '' key.
  await clickListHeaderBody(page, 'Inbox')
  await expect(tierCard(page, inboxTask.id)).toBeVisible({ timeout: 10_000 })
  await expect(listRow(page, 'Inbox', inboxTask.id)).toBeVisible()
  await expect(tierLabel(page, '').locator('.collapse-chevron')).toHaveClass(/expanded/)
})

test('a tier with ONE project draws no label, and a fold from the main list cannot hide its cards', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  // A CUSTOM tier, because "this tier holds exactly one project" is only true in a
  // tier nobody else pins into. The built-in tiers are shared fixture state: one
  // concurrent spec pinning a second project into Focus would make the label
  // appear and turn this into a test of something else.
  const tierId = await createCustomTierViaApi(`Pone${stamp}`)
  const project = `PoneProj${stamp}`
  const t1 = await createTaskViaApi('Single project member 1', { project })
  const t2 = await createTaskViaApi('Single project member 2', { project })
  await pinToTierViaApi(t1.id, tierId)
  await pinToTierViaApi(t2.id, tierId)

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await presetTierViewModes(page, { [tierId]: 'project' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const zone = tierZone(page, tierId)
  await expect(zone).toBeVisible({ timeout: 20_000 })
  await expect(tierCard(page, t1.id, tierId)).toBeVisible()
  await expect(tierCard(page, t2.id, tierId)).toBeVisible()
  // We own this tier, so this is a real premise assertion, not a guess: two cards,
  // one project, therefore no label (a single label separates nothing).
  await expect(zone.locator('[data-task-id]')).toHaveCount(2)
  await expect(zone.locator('.tier-project-label')).toHaveCount(0)

  // Now fold that project from the MAIN LIST, the surface that DOES draw a header.
  await clickListHeaderBody(page, project)
  await expect(listRow(page, project, t1.id)).toHaveCount(0)
  await expect(listHeader(page, project).locator('.collapse-chevron')).not.toHaveClass(/expanded/)

  // THE assertion, and the reason `runHidden` is gated on `showFolders`: the
  // collapse set is shared, so the fold DID reach this tier's state, but a tier
  // that draws no label has no way back. Hiding the cards here would be a one-way
  // door, so it must not happen.
  await expect(tierCard(page, t1.id, tierId)).toBeVisible()
  await expect(tierCard(page, t2.id, tierId)).toBeVisible()
  await expect(tierCard(page, t1.id, tierId)).not.toHaveClass(/tier-project-collapsed/)
  await expect(zone.locator('.tier-project-label')).toHaveCount(0)
  await expect(zone.locator('.tier-project-collapsed')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/project-collapse/single-project-tier-keeps-cards.png' })

  // Leave the shared collapse set as we found it.
  await clickListHeaderBody(page, project)
  await expect(listRow(page, project, t1.id)).toBeVisible()
})

test('right-click a project header opens the project menu; Inbox gets the short one', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const project = `PmenuProj${stamp}`
  await createTaskViaApi('Project menu member', { project })
  // A task with NO project, so the Inbox group is definitely rendered.
  await createTaskViaApi('Project menu inbox member', {})

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const header = listHeader(page, project)
  await expect(header).toBeVisible({ timeout: 15_000 })

  const menu = await openProjectMenu(page, header, 'Rename project')
  for (const item of ['Collapse project', 'New task', 'New folder', 'New task with session', 'Rename project', 'Favorite project', 'View project details', 'Delete project']) {
    await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible()
  }
  await page.screenshot({ path: '/tmp/project-collapse/project-context-menu.png' })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Inbox is the ABSENCE of a project: no registry row, so no rename / favorite /
  // details / delete. It still folds and still takes new tasks and folders.
  const inbox = listHeader(page, 'Inbox')
  await expect(inbox).toBeVisible()
  const inboxMenu = await openProjectMenu(page, inbox, 'Collapse project')
  await expect(inboxMenu.getByRole('menuitem', { name: 'New task', exact: true })).toBeVisible()
  await expect(inboxMenu.getByRole('menuitem', { name: 'New folder', exact: true })).toBeVisible()
  await expect(inboxMenu.getByRole('menuitem', { name: 'Rename project', exact: true })).toHaveCount(0)
  await expect(inboxMenu.getByRole('menuitem', { name: 'Delete project', exact: true })).toHaveCount(0)
  await expect(inboxMenu.getByRole('menuitem', { name: 'View project details', exact: true })).toHaveCount(0)
  await expect(inboxMenu.getByRole('menuitem', { name: 'New task with session', exact: true })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/project-collapse/inbox-context-menu.png' })
  await page.keyboard.press('Escape')
})

test('the tier project label carries the same menu (one definition, two surfaces)', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  const label = tierLabel(page, f.projA)
  await expect(label).toBeVisible({ timeout: 15_000 })
  const menu = await openProjectMenu(page, label, 'Rename project')
  for (const item of ['Collapse project', 'New task', 'New folder', 'Rename project', 'Delete project']) {
    await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible()
  }
  await page.screenshot({ path: '/tmp/project-collapse/tier-project-context-menu.png' })

  // Collapse driven from the menu folds the same run a row click does.
  await clickProjectMenuItem(page, label, 'Collapse project')
  await expect(tierCard(page, f.a1.id)).toBeHidden()
  // Re-opened on a folded row, the menu offers the inverse.
  await openProjectMenu(page, tierLabel(page, f.projA), 'Expand project')
  await clickProjectMenuItem(page, tierLabel(page, f.projA), 'Expand project')
  await expect(tierCard(page, f.a1.id)).toBeVisible()
})

test('"Add separator" is a TIER row only, never a main-list one', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  // The tier owns divider lines, so its label offers the same verb its "+" does.
  const label = tierLabel(page, f.projA)
  await expect(label).toBeVisible({ timeout: 15_000 })
  const tierMenu = await openProjectMenu(page, label, 'Rename project')
  await expect(tierMenu.getByRole('menuitem', { name: 'Add separator', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tierMenu).toHaveCount(0)

  // The main list has no view mode, so a line there would have no defined
  // position. The row is absent, and the menu around it is demonstrably the real
  // one (openProjectMenu already waited for Rename), so this is an absence, not a
  // menu that failed to open.
  const listMenu = await openProjectMenu(page, listHeader(page, f.projA), 'Rename project')
  await expect(listMenu.getByRole('menuitem', { name: 'New folder', exact: true })).toBeVisible()
  await expect(listMenu.getByRole('menuitem', { name: 'Add separator', exact: true })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/project-collapse/main-list-menu-no-separator.png' })
  await page.keyboard.press('Escape')
})

test('Rename driven from the project context menu really renames', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const project = `PrenFrom${stamp}`
  const renamed = `PrenTo${stamp}`
  const task = await createTaskViaApi('Rename member', { project })

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(listHeader(page, project)).toBeVisible({ timeout: 15_000 })
  await clickProjectMenuItem(page, listHeader(page, project), 'Rename project')

  // The app's own prompt modal, never window.prompt.
  const modal = page.locator('.app-modal')
  await expect(modal).toBeVisible()
  await modal.locator('input').fill(renamed)
  trackProject(renamed)
  await modal.getByRole('button', { name: 'Rename' }).click()

  await expect(projectBucket(page, renamed)).toBeVisible({ timeout: 15_000 })
  await expect(listRow(page, renamed, task.id)).toBeVisible()
  await expect(projectBucket(page, project)).toHaveCount(0)
  await page.screenshot({ path: '/tmp/project-collapse/project-renamed-from-menu.png' })

  // Server truth, not just the optimistic view.
  expect(await taskProjectViaApi(task.id)).toBe(renamed)
})

test('Delete driven from the project context menu: the confirm names the count, the tasks land in the Inbox', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const project = `PdelProj${stamp}`
  const t1 = await createTaskViaApi('Delete member one', { project })
  const t2 = await createTaskViaApi('Delete member two', { project })

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(listHeader(page, project)).toBeVisible({ timeout: 15_000 })
  await clickProjectMenuItem(page, listHeader(page, project), 'Delete project')

  // A LOCAL project deletes only the registry row, so the confirm has to say what
  // happens to the tasks, with the real number: useProjectActions fetches the
  // project detail first precisely so this copy can never be a guess.
  const modal = page.locator('.app-modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText(`Delete project “${project}”?`)
  await expect(modal).toContainText('Its 2 tasks move to the Inbox')
  await page.screenshot({ path: '/tmp/project-collapse/project-delete-confirm.png' })
  await modal.getByRole('button', { name: 'Delete project' }).click()

  // The group is gone from the panel and the tasks are in the Inbox, on both the
  // screen and the server (a registry row that vanished while its tasks kept
  // pointing at it is the failure this pins).
  await expect(projectBucket(page, project)).toHaveCount(0, { timeout: 15_000 })
  await expect(listRow(page, 'Inbox', t1.id)).toBeVisible({ timeout: 15_000 })
  await expect(listRow(page, 'Inbox', t2.id)).toBeVisible()
  expect(await taskProjectViaApi(t1.id)).toBe('')
  expect(await taskProjectViaApi(t2.id)).toBe('')
  await page.screenshot({ path: '/tmp/project-collapse/project-deleted-from-menu.png' })
})

test('renaming a folded project loses the fold rather than stranding it, and the new name folds normally', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const before = `PfoldRenA${stamp}`
  const after = `PfoldRenB${stamp}`
  const task = await createTaskViaApi('Fold rename member', { project: before })

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const collapsedKeys = () => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('walnut-todo-collapsed-projs') ?? '[]') as string[] } catch { return [] }
  })

  await expect(listHeader(page, before)).toBeVisible({ timeout: 15_000 })
  await clickListHeaderBody(page, before)
  await expect(listRow(page, before, task.id)).toHaveCount(0)
  expect(await collapsedKeys()).toContain(before)

  // FOLD then RENAME. The collapse key IS the project name and is deliberately
  // not migrated: the prune effect drops a key no live group answers to, so the
  // fold is LOST (the group comes back open) instead of stranded on a name that
  // no longer renders a header to unfold.
  await clickProjectMenuItem(page, listHeader(page, before), 'Rename project')
  const modal = page.locator('.app-modal')
  await expect(modal).toBeVisible()
  await modal.locator('input').fill(after)
  trackProject(after)
  await modal.getByRole('button', { name: 'Rename' }).click()

  await expect(projectBucket(page, after)).toBeVisible({ timeout: 15_000 })
  await expect(listRow(page, after, task.id)).toBeVisible()
  await expect(listHeader(page, after).locator('.collapse-chevron')).toHaveClass(/expanded/)
  // The stale key is pruned, and the new name was never added: nothing is left
  // behind to fold a future project that happens to reuse the old name.
  await expect.poll(collapsedKeys, { timeout: 10_000 }).not.toContain(before)
  expect(await collapsedKeys()).not.toContain(after)
  await page.screenshot({ path: '/tmp/project-collapse/renamed-project-unfolded.png' })

  // RENAME then FOLD: the new name is a first-class collapse key.
  await clickListHeaderBody(page, after)
  await expect(listRow(page, after, task.id)).toHaveCount(0)
  await expect(listHeader(page, after).locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  expect(await collapsedKeys()).toContain(after)

  // Leave the shared collapse set as we found it.
  await clickListHeaderBody(page, after)
  await expect(listRow(page, after, task.id)).toBeVisible()
})

test('pressing "+" on a project row never folds it (tier label and main list header)', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  const label = tierLabel(page, f.projA)
  await expect(label).toBeVisible({ timeout: 15_000 })
  await label.locator('[data-testid="plus-menu-trigger"]').click()
  await expect(page.getByTestId('plus-menu')).toBeVisible()
  // The whole point: the press reached the "+", not the row underneath it.
  await expect(label.locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(tierCard(page, f.a1.id)).toBeVisible()
  await page.keyboard.press('Escape')

  const header = listHeader(page, f.projA)
  await header.locator('[data-testid="plus-menu-trigger"]').click()
  await expect(page.getByTestId('plus-menu')).toBeVisible()
  await expect(header.locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(listRow(page, f.projA, f.a1.id)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: '/tmp/project-collapse/plus-does-not-fold.png' })
})

test('a pointer SLIP on the "+", the chevron and the star still does what the user pressed', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  const label = tierLabel(page, f.projA)
  await expect(label).toBeVisible({ timeout: 15_000 })
  // OUR two projects only: another spec is free to pin a third project into the
  // shared Focus tier mid-test, and that is not this test's business.
  const mine = (all: string[]) => all.filter((p) => p === f.projA || p === f.projB)
  const tierOrderBefore = mine(await tierProjectOrder(page))
  const listOrderBefore = mine(await listProjectOrder(page))

  // TIER "+": the label is an HTML5 drag handle, so a slip past Chromium's native
  // threshold would start a project reorder and swallow this click. The disarm
  // (pointerenter → draggable = false on the row) is what keeps it a press.
  await slipClick(page, label.locator('[data-testid="plus-menu-trigger"]'))
  await expect(page.getByTestId('plus-menu')).toBeVisible()
  await expect(label.locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(tierCard(page, f.a1.id)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('plus-menu')).toHaveCount(0)
  expect(mine(await tierProjectOrder(page)), 'the slip reordered the tier runs').toEqual(tierOrderBefore)

  // MAIN-LIST chevron: 4px on each axis is 5.7px of travel, past dnd-kit's
  // `distance: 5`, so without the pointerdown guard the header's activator arms
  // and dnd-kit eats the click: the user asked to fold and got nothing.
  const header = listHeader(page, f.projA)
  await slipClick(page, header.locator('.collapse-chevron'))
  await expect(listRow(page, f.projA, f.a1.id)).toHaveCount(0)
  await expect(listHeader(page, f.projA).locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await listHeader(page, f.projA).locator('.collapse-chevron').click()
  await expect(listRow(page, f.projA, f.a1.id)).toBeVisible()

  // MAIN-LIST star: same guard, and a favorite is the one action here with no
  // second surface to check it on, so the glyph is the assertion.
  const star = listHeader(page, f.projA).locator('.todo-group-fav-btn')
  await expect(star).toHaveText('☆')
  await slipClick(page, star)
  await expect(listHeader(page, f.projA).locator('.todo-group-fav-btn')).toHaveText('★', { timeout: 10_000 })
  await expect(listHeader(page, f.projA).locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(listRow(page, f.projA, f.a1.id)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/slip-still-presses-controls.png' })
  // Favorites are shared server state: put it back.
  await slipClick(page, listHeader(page, f.projA).locator('.todo-group-fav-btn'))
  await expect(listHeader(page, f.projA).locator('.todo-group-fav-btn')).toHaveText('☆', { timeout: 10_000 })

  expect(mine(await listProjectOrder(page)), 'a slip reordered the main list groups').toEqual(listOrderBefore)
})

test('dragging one project label onto another still reorders the runs, and folds neither', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  const labelA = tierLabel(page, f.projA)
  const labelB = tierLabel(page, f.projB)
  await expect(labelA).toBeVisible({ timeout: 15_000 })
  await expect(labelB).toBeVisible()

  const before = await tierProjectOrder(page)
  // Which of the two comes first is NOT ours to assume: `ordering.projects` is
  // global, persisted, shared-fixture state, and other specs' projects sit between
  // these two. Read the order, then assert the drag INVERTED it.
  expect(before).toContain(f.projA)
  expect(before).toContain(f.projB)
  const [first, second] = before.indexOf(f.projA) < before.indexOf(f.projB)
    ? [f.projA, f.projB]
    : [f.projB, f.projA]

  // The row is an HTML5 drag handle (native DnD, outside dnd-kit): dragging the
  // earlier label onto the later one splices it into that slot.
  await tierLabel(page, first).dragTo(tierLabel(page, second), { targetPosition: { x: 30, y: 6 } })

  await expect.poll(async () => {
    const now = await tierProjectOrder(page)
    return now.indexOf(first) > now.indexOf(second)
  }, { timeout: 10_000, message: 'the dragged project never landed after its target' }).toBe(true)

  // The drag must not ALSO fold either project: Chromium fires no click after a
  // completed native drag, and this is the test that keeps it that way.
  await expect(tierLabel(page, f.projA).locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(tierLabel(page, f.projB).locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(tierCard(page, f.a1.id)).toBeVisible()
  await expect(tierCard(page, f.b1.id)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/label-drag-reorder.png' })
})

test('a real dnd-kit reorder of MAIN-LIST project groups folds neither group', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  // Adjacent names, so the two headers render next to each other whatever else the
  // shared dataset holds (unlisted projects sort alphabetically).
  const projA = `PdrgA${stamp}`
  const projB = `PdrgB${stamp}`
  const a = await createTaskViaApi('List drag member A', { project: projA })
  const b = await createTaskViaApi('List drag member B', { project: projB })

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  const headerA = listHeader(page, projA)
  const headerB = listHeader(page, projB)
  await expect(headerA).toBeVisible({ timeout: 15_000 })
  await expect(headerB).toBeVisible()
  // Adjacency is what makes the gesture below reachable without scrolling mid-drag,
  // so it is asserted rather than hoped for.
  const before = await listProjectOrder(page)
  expect(before.indexOf(projA), 'the two fresh projects should sort next to each other')
    .toBe(before.indexOf(projB) - 1)
  // BOTH rows have to be on screen at once: a press dispatched at a y below the
  // viewport hits nothing, and with A immediately above B one scroll settles both.
  // headerSlackPoint re-checks that per row (scrollOnScreen), so the two measured
  // points cannot come from different scroll positions.
  await headerA.scrollIntoViewIfNeeded()
  await headerB.scrollIntoViewIfNeeded()
  const to = await headerSlackPoint(page, projB)
  const from = await headerSlackPoint(page, projA)
  const targetStaticY = (await headerB.boundingBox())!.y

  // The header row is BOTH the fold target and the dnd-kit activator, and nothing
  // pinned that combination on this surface: the click is swallowed only because
  // the PointerSensor's 5px activation fired, so a drag that stopped short (or a
  // guard that stopped the wrong event) would fold a group the user was moving.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, from.y + 10)
  await page.mouse.move(to.x, to.y, { steps: 12 })
  // Aiming at the target header's slack puts the DRAGGED GROUP's rect centre on the
  // target group's centre (equal-height groups, one task each), which is what
  // closestCenter awards the drop to. The yield below is the proof it did.
  await expectRowYielded(headerB, targetStaticY, 'the target project group')
  await page.mouse.up()

  await expect.poll(async () => {
    const now = await listProjectOrder(page)
    return now.indexOf(projA) > now.indexOf(projB)
  }, { timeout: 15_000, message: 'the dragged project group never landed after its target' }).toBe(true)

  // Neither group folded, on the row that was dragged or the one it landed on.
  await expect(listHeader(page, projA).locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(listHeader(page, projB).locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(listRow(page, projA, a.id)).toBeVisible()
  await expect(listRow(page, projB, b.id)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/main-list-group-drag-reorder.png' })
  expect(errors).toEqual([])
})

test('a card drag while another project run is folded lands where it was dropped, never inside the fold', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const projA = `PdndA${stamp}`
  const projB = `PdndB${stamp}`
  const a1 = await createTaskViaApi('Folded run member 1', { project: projA })
  const a2 = await createTaskViaApi('Folded run member 2', { project: projA })
  const b1 = await createTaskViaApi('Visible run member 1', { project: projB })
  const b2 = await createTaskViaApi('Visible run member 2', { project: projB })
  for (const t of [a1, a2, b1, b2]) await pinToFocusViaApi(t.id)

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await presetTierViewModes(page, { focus: 'project' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  const own = [a1.id, a2.id, b1.id, b2.id]
  const ownOrder = async () => (await serverPinnedOrder()).filter((id) => own.includes(id))

  await expect(tierLabel(page, projA)).toBeVisible({ timeout: 15_000 })
  await expect(tierCard(page, b2.id)).toBeVisible()

  // Fold projA's run. Its cards stay in the tier's SortableContext (that is what
  // keeps dnd-kit's indices stable) but they are display:none, so they measure as
  // 0x0 rects at the VIEWPORT ORIGIN.
  await tierLabel(page, projA).locator('.tier-project-label-name').click()
  await expect(tierCard(page, a1.id)).toBeHidden()
  await expect(tierCard(page, a1.id)).toBeAttached()
  await expect(tierCard(page, a2.id)).toBeHidden()

  // ── Gesture 1: an ordinary reorder inside the VISIBLE run.
  const b1Box = await tierCard(page, b1.id).boundingBox()
  const b2Box = await tierCard(page, b2.id).boundingBox()
  if (!b1Box || !b2Box) throw new Error('pinned card has no box')
  // Grab the row at the SAME relative point it is released on, because the two
  // decisions this drop rides on read different things. `over` comes from the
  // dragged rect's CENTRE (its start rect plus the pointer delta, closestCenter),
  // while join-vs-reorder reads the LIVE POINTER against the over card's rect. Press
  // b2's top edge and release on b1's top edge: the delta is then exactly one row
  // pitch, so the dragged centre lands ON b1's centre (over = b1) while the pointer
  // sits in b1's top quarter, the band that means "insert between rows" rather than
  // "join this card's group".
  // Measured, on the 30px cards this panel draws: releasing with the pointer on b1's
  // CENTRE also gives over = b1 but lights the join frame, so the drop would build a
  // folder; and moving the dragged centre anywhere else (b1's top edge, or 10px left
  // of the card) hands `over` to the tier's own drop zone, whose branch has no
  // sortable index to move and quietly does nothing.
  const grabY = b2Box.y + 4
  const dropY = b1Box.y + 4
  const columnX = b1Box.x + b1Box.width / 2
  await page.mouse.move(columnX, grabY)
  await page.mouse.down()
  await page.mouse.move(columnX, grabY + 8)
  await page.mouse.move(columnX, dropY, { steps: 12 })
  // Two proofs before the release: b1 slid aside (so the drop target IS b1), and no
  // join frame is lit (so this release reorders instead of making a folder).
  await expectRowYielded(tierCard(page, b1.id), b1Box.y, 'the target card')
  await expect(tierZone(page).locator('.todo-panel-item-group-target')).toHaveCount(0)
  await page.mouse.up()

  await expect.poll(async () => {
    const order = await ownOrder()
    const at1 = order.indexOf(b1.id)
    const at2 = order.indexOf(b2.id)
    // Both still pinned: a card released over the unpin strip would leave the order
    // with a -1 in it, which "b2 before b1" would otherwise read as success.
    return at1 >= 0 && at2 >= 0 && at2 < at1
  }, { timeout: 15_000, message: 'the dragged card never took the slot it was dropped on' }).toBe(true)
  // It landed in its OWN run: a drop inside the visible run must not reproject.
  expect(await taskProjectViaApi(b2.id)).toBe(projB)
  // And the folded run is still folded, with both members still hidden.
  await expect(tierCard(page, a1.id)).toBeHidden()
  await expect(tierLabel(page, projA).locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/project-collapse/drag-with-folded-run.png' })

  // ── Gesture 2: drag toward the VIEWPORT ORIGIN, which is where the folded run's
  // zero-size rects sit. This is the exact gesture the `disabled.droppable` fix was
  // written for: while those rows were measured, the nearest drop target near the
  // top-left corner was a card inside the folded project, and the drop reprojected
  // the dragged card into a run the user cannot see.
  const cardBox = await tierCard(page, b2.id).boundingBox()
  if (!cardBox) throw new Error('pinned card has no box')
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(cardBox.x + cardBox.width / 2 - 8, cardBox.y + cardBox.height / 2 - 8)
  await page.mouse.move(3, 3, { steps: 16 })
  await page.waitForTimeout(200)
  await page.mouse.up()
  await page.waitForTimeout(1_000)

  // The card must NOT have joined the folded project, and must still be on screen.
  // (Which visible run it ends up in is not this test's business: the Focus tier is
  // shared state, so another spec's card can legitimately be the nearest target.)
  expect(await taskProjectViaApi(b2.id), 'the drop landed inside the FOLDED run').not.toBe(projA)
  await expect(tierCard(page, b2.id)).toBeVisible()
  await expect(tierCard(page, b2.id)).not.toHaveClass(/tier-project-collapsed/)
  // The fold itself survived the drag untouched: still shut, still two members.
  await expect(tierLabel(page, projA).locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await expect(tierLabel(page, projA).locator('.tier-project-label-count')).toHaveText('2')
  await expect(tierCard(page, a1.id)).toBeHidden()
  await expect(tierCard(page, a2.id)).toBeHidden()
  await page.screenshot({ path: '/tmp/project-collapse/drag-to-origin-not-into-fold.png' })
  expect(errors).toEqual([])

  // Leave the shared collapse set as we found it.
  await tierLabel(page, projA).locator('.collapse-chevron').click()
  await expect(tierCard(page, a1.id)).toBeVisible()
})

test('while a pinned card drag is live, the project label refuses to fold', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const f = await pinnedTwoProjectFixture(page, stamp)

  const label = tierLabel(page, f.projA)
  await expect(label).toBeVisible({ timeout: 15_000 })

  // A SECOND card in projB's run, and the drag below uses it rather than b1, so
  // that the release is a genuine no-op. A release where the press started makes
  // dnd-kit report `over` as the dragged card ITSELF, and that branch of
  // handlePinnedDragEnd infers the landing run from the card's NEIGHBOURS
  // (inferTierDropProject, prev wins). For the FIRST card of a run the neighbour
  // above belongs to the previous run, so the no-op release reprojects it into
  // projA: run B disappears, the tier drops to one project, and the label this test
  // is about stops being drawn at all. Dragging the run's second card keeps the
  // inference inside projB and the gesture inert-only.
  // (That reprojection WAS a real bug, and it is now fixed: the over===active branch
  // only infers a landing run when the card actually changed tier, i.e.
  // maybeMoveProject(..., allowInference = origTier !== currentTier) in TodoPanel.tsx.
  // Dragging the run's SECOND card is therefore belt-and-braces here rather than
  // load-bearing, and it stays that way on purpose: this test is about the inert
  // label, so it should not also be the thing that notices inference regressing.
  // The ratchet for the fix itself lives in the two tests at the end of this file.)
  const b2 = await createTaskViaApi('Project fold member B2', { project: f.projB })
  await pinToFocusViaApi(b2.id)
  const card = tierCard(page, b2.id)
  await expect(card).toBeVisible({ timeout: 15_000 })
  const box = await card.boundingBox()
  if (!box) throw new Error('pinned card has no box')

  // Arm a real dnd-kit card drag and keep it live.
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY + 12, { steps: 4 })

  // Mid-drag the label STAYS (hiding the labels collapsed the tier into a flat
  // list, 2026-08-13) and goes inert: the class switches the row off in CSS.
  await expect(label).toBeVisible()
  await expect(label).toHaveClass(/tier-project-label-inert/)
  await expect(label).toHaveCSS('pointer-events', 'none')

  // Then try to fold anyway, and assert the OUTCOME rather than a mechanism.
  // dispatchEvent, not click(): pointer-events none makes a real click impossible,
  // and there is only one mouse, which this drag is holding. What that synthetic
  // click proves is "no fold happened", not WHICH layer refused, and the difference
  // matters enough to write down: while a dnd-kit drag is live the library holds a
  // capture-phase `click` listener on the DOCUMENT that stops propagation
  // (AbstractPointerSensor.handleStart), so the event never reaches React's root
  // delegation and the row's own `!inert` gate is never consulted. Measured with a
  // capture+bubble recorder: the capture listener sees the click, the bubble one
  // never does. Both layers are wanted (the gate covers a programmatic caller), so
  // the assertion here is the user-visible promise: the run stays open.
  await label.dispatchEvent('click')
  await expect(tierCard(page, f.a1.id)).toBeVisible()
  await expect(label.locator('.collapse-chevron')).toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/project-collapse/inert-label-refuses-fold.png' })

  // Release where it started, so the drop is a no-op reorder.
  await page.mouse.move(startX, startY, { steps: 4 })
  await page.mouse.up()
  // And it really was one: both runs are still there, so the label below is the
  // same row this test has been asserting on all along.
  expect(await taskProjectViaApi(b2.id), 'the no-op release moved the card to another project').toBe(f.projB)

  // The refusal was scoped to the drag, not a dead row: it folds again now.
  await expect(tierLabel(page, f.projA)).not.toHaveClass(/tier-project-label-inert/)
  // The same document-level click suppressor outlives the drop by design: dnd-kit
  // tears its document listeners down on `setTimeout(…, 50)` so the mouseup's own
  // click cannot leak into the app. A fold click fired inside that window is eaten
  // in the capture phase and nothing happens, which cost a debugging round here.
  // No user can click 50ms after releasing a drag; a test can, so it waits.
  await page.waitForTimeout(250)
  await tierLabel(page, f.projA).locator('.tier-project-label-name').click()
  await expect(tierCard(page, f.a1.id)).toBeHidden()
  await tierLabel(page, f.projA).locator('.collapse-chevron').click()
  await expect(tierCard(page, f.a1.id)).toBeVisible()
})

/**
 * A tier's rows in DOM ORDER, labels included, as `label:<project>` /
 * `card:<taskId>` entries.
 *
 * The two drop tests below need one fact the locators above cannot express: which
 * run a given card OPENS. Project labels are plain DOM rather than sortable items,
 * so "this card is the first of its run" is only readable as "a label sits
 * immediately before it", and `querySelectorAll` is what guarantees document order
 * across the label rows and the cards regardless of how they nest. It lives down
 * here with its only two callers rather than up with the general helpers.
 */
function tierRunSequence(page: Page, tier = 'focus'): Promise<string[]> {
  return tierZone(page, tier).evaluate((zone) =>
    Array.from(zone.querySelectorAll('.tier-project-label, [data-task-id]')).map((el) => {
      const node = el as HTMLElement
      return node.classList.contains('tier-project-label')
        ? `label:${node.dataset.project ?? ''}`
        : `card:${node.dataset.taskId ?? ''}`
    })
  )
}

/**
 * A pinned card located by the pinned AREA rather than by a tier drop zone.
 *
 * Satellite is the one tier that draws NO `TierDropZone` in the stacked view (it
 * only renders at all when it holds something, so the zone would be dead weight),
 * which means `tierCard(page, id, 'satellite')` finds nothing there. Scoping to the
 * pinned section keeps this off the main list's row for the same task, and `.first()`
 * covers a card that is both born pinned and still in the list.
 */
function pinnedAreaCard(page: Page, taskId: string): Locator {
  return page.locator('.todo-pinned-section:not(.todo-pinned-section-recent)')
    .locator(`[data-task-id="${taskId}"]`).first()
}

/** Which pinned tier holds a task, server side ('' when it is not pinned). */
async function pinnedTierOf(taskId: string): Promise<string> {
  const res = await fetch(`${API}/api/focus/tasks`)
  const body = (await res.json()) as {
    focus_tasks: string[]; satellite_tasks: string[]; backlog_tasks: string[]
    wait_tasks: string[]; custom_tier_tasks: Record<string, string[]>
  }
  const buckets: Record<string, string[]> = {
    focus: body.focus_tasks, satellite: body.satellite_tasks,
    backlog: body.backlog_tasks, wait: body.wait_tasks, ...body.custom_tier_tasks,
  }
  for (const [tier, ids] of Object.entries(buckets)) if (ids.includes(taskId)) return tier
  return ''
}

/** That same sequence folded into runs, so a test can name "the second run". */
async function tierRuns(page: Page, tier = 'focus'): Promise<{ project: string; cards: string[] }[]> {
  const runs: { project: string; cards: string[] }[] = []
  for (const entry of await tierRunSequence(page, tier)) {
    if (entry.startsWith('label:')) {
      runs.push({ project: entry.slice('label:'.length), cards: [] })
      continue
    }
    // A card before the first label belongs to no drawn run (a tier with a single
    // project draws none at all), which the callers below assert away.
    if (runs.length) runs[runs.length - 1].cards.push(entry.slice('card:'.length))
  }
  return runs
}

/**
 * A 12px twitch on the FIRST card of a project run must not file it under the run
 * ABOVE it (ratchet for a silent data-corruption bug).
 *
 * Press a card, move 12px, release where the press started: a no-op to the user,
 * but dnd-kit still reports a drop, and `over` is the DRAGGED CARD ITSELF (its
 * centre is back on its own centre, so closestCenter picks it). That self-drop
 * branch of handlePinnedDragEnd used to infer the landing run from the card's
 * NEIGHBOURS. A same-tier drag deliberately never mutates the tier array during
 * dragOver (mutating SortableContext items mid-drag is the React #185 loop), so
 * those neighbours were the AT-REST ones, and `prev` wins in inferTierDropProject:
 * for the first card of a run the card above belongs to the PREVIOUS run, so the
 * twitch moved the task into it. No visible drag, no confirm for a local move, a
 * changed project. The fix confines the inference to drops that really changed
 * tier, where dragOver did splice the card into the destination array and the
 * neighbours are genuine evidence (the test after this one pins that half).
 *
 * The project is read back from the SERVER on purpose: the move is applied
 * optimistically to local state first, so the DOM alone cannot tell a persisted
 * reprojection from a rejected one. The request observer is the other half: it
 * turns "the project is still projB" into "nothing even tried to change it",
 * which is the difference between catching this regression and catching it late.
 */
test('a twitch on the first card of a project run never moves it to the run above', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  // A tier NOBODY else pins into, for the same reason the single-project case above
  // uses one: this test is about a run BOUNDARY, so it has to own the run layout.
  // In the shared Focus tier a concurrent spec's pin can land between the two runs,
  // and in the folder fixture above the folder cluster sinks BELOW the loose cards
  // (clusterForTier), so "the second run" is not the test's to choose there. Two
  // loose cards, one project each, is the entire shape this needs.
  const tierId = await createCustomTierViaApi(`Ptwitch${stamp}`)
  const projTop = `PtwTop${stamp}`
  const projLow = `PtwLow${stamp}`
  const top = await createTaskViaApi('Twitch run above', { project: projTop })
  const low = await createTaskViaApi('Twitch run below', { project: projLow })
  await pinToTierViaApi(top.id, tierId)
  await pinToTierViaApi(low.id, tierId)

  await presetPanelView(page, { section: 'all', project: '' })
  await presetTierViewModes(page, { [tierId]: 'project' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  const zone = tierZone(page, tierId)
  await expect(zone).toBeVisible({ timeout: 20_000 })
  await expect(zone.locator('[data-task-id]')).toHaveCount(2)

  // Premise, ASSERTED rather than assumed, because the gesture only means something
  // when the pressed card OPENS a run that has another run above it: that run above
  // is where the wrong answer comes from. A card in the MIDDLE of a run would pass
  // this test with the bug in place, its neighbour above being its own project.
  const runs = await tierRuns(page, tierId)
  expect(runs.map((r) => r.cards.length), 'the tier must draw two runs of one card each')
    .toEqual([1, 1])
  const [above, target] = runs
  const targetCard = target.cards[0]
  expect(await taskProjectViaApi(targetCard), 'the label and the card disagree about the run')
    .toBe(target.project)
  expect(above.project, 'the run above must be a DIFFERENT project').not.toBe(target.project)

  // Every project PATCH aimed at this card, observed rather than intercepted (a mock
  // would change what the drop is able to do). This is what makes a failure say a
  // layer TRIED to move the task, instead of only "the project changed somehow".
  const projectPatches: Record<string, unknown>[] = []
  page.on('request', (req) => {
    if (req.method() !== 'PATCH') return
    if (!req.url().includes(`/api/tasks/${targetCard}`)) return
    try {
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      if ('project' in body) projectPatches.push(body)
    } catch { /* not JSON: not the request this test is about */ }
  })

  const card = tierCard(page, targetCard, tierId)
  const box = await scrollOnScreen(page, card, 'the first card of the second run')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 12, { steps: 4 })
  // The drag really armed (12px is past the PointerSensor's `distance: 5`): the
  // labels go inert for the duration of a live pinned drag, which is the panel's own
  // signal. Without this the test could "pass" on a gesture dnd-kit never saw, and
  // then there is no drop for anything to get wrong.
  await expect(tierLabel(page, above.project, tierId)).toHaveClass(/tier-project-label-inert/)
  // Back to the press point, so the release is the no-op the user meant.
  await page.mouse.move(x, y, { steps: 4 })
  await page.mouse.up()

  // Give a stray PATCH time to appear before declaring there was none (the same way
  // the folder specs prove an absence).
  await page.waitForTimeout(1_500)
  expect(projectPatches, 'the twitch fired a project move').toEqual([])
  expect(await taskProjectViaApi(targetCard), 'the twitch reprojected the card server-side')
    .toBe(target.project)

  // And the tier still draws BOTH runs, in the same order. Not a restatement of the
  // line above: the pressed card is its run's only member, so a reprojection takes
  // the whole run with it and the label the user navigates by simply disappears.
  expect(await tierProjectOrder(page, tierId)).toEqual([above.project, target.project])
  await expect(tierLabel(page, above.project, tierId).locator('.tier-project-label-count'))
    .toHaveText('1')
  await expect(tierLabel(page, target.project, tierId).locator('.tier-project-label-count'))
    .toHaveText('1')
  await expect(tierCard(page, targetCard, tierId)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/twitch-keeps-project.png' })
  expect(errors).toEqual([])
})

/**
 * The other half of the same rule: a CROSS-TIER drop into another tier's project
 * run must still reproject the card.
 *
 * This is the behaviour the fix above deliberately KEEPS, and the reason the
 * inference is gated on "the tier changed" rather than deleted outright. Here
 * dragOver really does splice the dragged card into the destination tier's array,
 * at the over-card's index, so the landing slot describes where the card went
 * instead of where it already was.
 *
 * What the assertion says, and what it deliberately does not: the card must come out
 * of the drop owning one of the DESTINATION tier's run projects, rather than keeping
 * the one it arrived with. Which of them it adopts is left open on purpose, because
 * the panel has two legitimate answers for the same gesture and picks by geometry:
 * a release that still reports a destination row as `over` reads that row's project,
 * and a release that reports the dragged card ITSELF (common after a cross-tier
 * relocation, since the dragged centre follows the pointer) walks its new
 * neighbours. Pinning one of the two would pin dnd-kit's collision arithmetic, which
 * is not the contract. Keeping the arriving project is the regression this catches.
 *
 * The drop must land on a ROW and not on the tier's own drop zone: a drop zone names
 * a TIER, not a slot inside it, so the panel retiers and deliberately leaves the
 * project alone. The mid-drag preview check below is what proves the aim: dragOver
 * splices the card at the over-row's index but APPENDS it when the target is the
 * zone, so "some card still follows it" is the difference between the two, read off
 * the DOM while the button is down.
 *
 * Two things about the GEOMETRY, both learned by watching this test fail, and both
 * the reason the gesture goes UPWARD from Satellite into Focus rather than down into
 * a custom tier at the far end of the pinned area:
 *
 *  - The pinned area is a scroll container, and dnd-kit AUTO-SCROLLS it while the
 *    pointer sits near an edge. Dragging DOWN toward its bottom edge therefore keeps
 *    moving the rows out from under the pointer after the last re-measure, and the
 *    release landed on the unpin strip that covers the wrapper's bottom 46px: the
 *    card left the pinned area altogether instead of changing tier. Dragging UP with
 *    the wrapper already at scroll top is stable, because there is nothing to scroll.
 *  - Both ends have to be on screen AT ONCE, and at the default 720px the pinned
 *    area shows about eight rows. Below that, scrollIntoViewIfNeeded brings one end
 *    into view by scrolling the other out, the press lands on whatever slid
 *    underneath, and no drag arms at all. Hence the taller viewport, scoped to this
 *    one case by a nested describe so the other cases here keep the geometry they
 *    were measured at.
 */
test.describe('cross-tier project drop', () => {
  test.use({ viewport: { width: 1280, height: 1040 } })

  test('a card dragged from another tier into a project run still joins that project', async ({ page }) => {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    // Destination: FOCUS, because it is the tier at the TOP of the pinned scroller
    // (see the geometry note above). Two projects, because a tier drawing one run
    // suppresses its label and the panel then treats the drop as a plain reorder.
    const projA = `PxtA${stamp}`
    const projB = `PxtB${stamp}`
    const projFar = `PxtFar${stamp}`
    // Four rows, two per run: the aim needs a row BELOW it to survive the one-row
    // shift the cross-tier hand-off causes, and a row above it so the release cannot
    // fall off the top of the tier onto the drop zone.
    const a1 = await createTaskViaApi('Cross tier anchor A1', { project: projA })
    const a2 = await createTaskViaApi('Cross tier anchor A2', { project: projA })
    const b1 = await createTaskViaApi('Cross tier anchor B1', { project: projB })
    const b2 = await createTaskViaApi('Cross tier anchor B2', { project: projB })
    for (const t of [a1, a2, b1, b2]) await pinToFocusViaApi(t.id)
    // The traveller starts in SATELLITE, which renders directly BELOW Focus.
    const mover = await createTaskViaApi('Cross tier mover', { project: projFar })
    await pinToTierViaApi(mover.id, 'satellite')

    await presetPanelView(page, { section: 'all', project: '' })
    await presetTierViewModes(page, { focus: 'project' })
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

    const zone = tierZone(page)
    await expect(zone).toBeVisible({ timeout: 20_000 })
    await expect(tierCard(page, a1.id)).toBeVisible({ timeout: 15_000 })
    await expect(tierCard(page, b1.id)).toBeVisible()
    await expect(pinnedAreaCard(page, mover.id)).toBeVisible({ timeout: 15_000 })

    // Premises: Focus draws at least two runs (the gate that makes a project drop
    // mean anything at all), and the traveller starts OUTSIDE it, which is a fact
    // only the server has. "At least" rather than "exactly": Focus is shared fixture
    // state, and a concurrent spec's pin adds a run without changing what this
    // gesture does, since the assertion below accepts any of the tier's own runs.
    const runs = await tierRuns(page)
    expect(runs.length, 'Focus must draw at least two project runs').toBeGreaterThan(1)
    const runProjects = runs.map((r) => r.project)
    expect(runProjects, 'the destination runs must not already include the traveller')
      .not.toContain(projFar)
    expect(await pinnedTierOf(mover.id), 'the traveller did not start in Satellite')
      .toBe('satellite')

    // Aim at the SECOND row of the tier, not the first or the last: the hand-off
    // shifts every row below the insertion point down by one, and a target with a
    // neighbour on each side stays a row under the pointer either way. First or last
    // would let the release slide off the ends of the list onto the drop zone.
    const rows = runs.flatMap((r) => r.cards)
    expect(rows.length, 'the destination needs rows to aim between').toBeGreaterThan(2)
    const aimAt = rows[1]
    const src = await scrollOnScreen(page, pinnedAreaCard(page, mover.id), 'the travelling card')
    const dst = await scrollOnScreen(page, tierCard(page, aimAt), 'the aim row')
    // Press and release 4px below a row's TOP edge, which is the band that means
    // "insert between rows"; the middle band would light the join frame and build a
    // folder instead. A one-row shift keeps the pointer in a band of the same kind,
    // because every row has an edge band at both ends.
    // The press uses the SOURCE card's own column: a Focus card and a Satellite card
    // are different components (`todo-focus-card` vs `todo-pinned-card`) and need not
    // share an x span, so pressing at the aim row's column can miss the source row
    // entirely and arm no drag at all.
    const grabX = src.x + src.width / 2
    const columnX = dst.x + dst.width / 2
    await page.mouse.move(grabX, src.y + 4)
    await page.mouse.down()
    await page.mouse.move(grabX, src.y + 12, { steps: 2 })
    await page.mouse.move(columnX, dst.y + 4, { steps: 12 })
    await page.waitForTimeout(250)
    // Mid-drag proofs, and the LAST pointer event before the release on purpose: a
    // re-aim after this measurement is what handed the drop to the tier's drop zone
    // the first time this test was written, and the zone deliberately reprojects
    // nothing. First proof: the live preview already renders the traveller inside
    // this tier. Second: a card still FOLLOWS it there, which only happens when
    // dragOver spliced it at a row's index; a drop-zone target appends it to the end.
    await expect(zone.locator(`[data-task-id="${mover.id}"]`)).toHaveCount(1, { timeout: 5_000 })
    const preview = await tierRunSequence(page)
    const atMover = preview.indexOf(`card:${mover.id}`)
    expect(preview.slice(atMover + 1).some((e) => e.startsWith('card:')),
      `the drop target is the tier, not a row: preview was ${preview.join(' | ')}`).toBe(true)
    // No join frame is lit, so this release reorders instead of building a folder.
    await expect(zone.locator('.todo-panel-item-group-target')).toHaveCount(0)
    await page.mouse.up()

    // Server truth, both halves of the drop: the card changed TIER and PROJECT.
    await expect.poll(() => pinnedTierOf(mover.id), {
      timeout: 15_000,
      message: 'the cross-tier drop never moved the card into the destination tier',
    }).toBe('focus')
    await expect.poll(() => taskProjectViaApi(mover.id), {
      timeout: 15_000,
      message: 'a cross-tier drop into a project run no longer reprojects the card',
    }).not.toBe(projFar)
    // And what it adopted is one of the DESTINATION tier's runs, not some third
    // project: the drop followed the slot it landed in (see the note above for why
    // this stops short of naming which run).
    expect(runProjects, 'the card landed in a project the destination tier does not draw')
      .toContain(await taskProjectViaApi(mover.id))
    await page.screenshot({ path: '/tmp/project-collapse/cross-tier-drop-reprojects.png' })
    expect(errors).toEqual([])
  })
})

/**
 * A tier of one card per project run, in a tier NOBODY else pins into, plus the
 * observers the two drop ratchets below share.
 *
 * Same shape and the same reasons as the twitch test's fixture: the gesture only
 * means something when the pressed card OPENS a run that has another run above it,
 * and the built-in tiers are shared fixture state where a concurrent spec's pin can
 * land between the runs. Project view also SINKS folder clusters below loose cards,
 * so loose cards are the only shape where "the second run" is this test's to choose.
 */
async function seedRunsInOwnTier(page: Page, prefix: string, runs: number): Promise<{
  tierId: string
  projects: string[]
  cards: string[]
}> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const tierId = await createCustomTierViaApi(`${prefix}${stamp}`)
  const projects: string[] = []
  const cards: string[] = []
  for (let i = 0; i < runs; i++) {
    const project = `${prefix}${i}${stamp}`
    const task = await createTaskViaApi(`${prefix} run ${i}`, { project })
    await pinToTierViaApi(task.id, tierId)
    projects.push(project)
    cards.push(task.id)
  }
  await presetPanelView(page, { section: 'all', project: '' })
  await presetTierViewModes(page, { [tierId]: 'project' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const zone = tierZone(page, tierId)
  await expect(zone).toBeVisible({ timeout: 20_000 })
  await expect(zone.locator('[data-task-id]')).toHaveCount(runs)
  return { tierId, projects, cards }
}

/** Every project PATCH aimed at one card, observed rather than intercepted (a mock
 *  would change what the drop is able to do). Turns "the project is unchanged" into
 *  "nothing even TRIED to change it", which is the difference between catching a
 *  regression and catching it late. Same observer the twitch test above installs. */
function watchProjectPatches(page: Page, taskId: string): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = []
  page.on('request', (req) => {
    if (req.method() !== 'PATCH') return
    if (!req.url().includes(`/api/tasks/${taskId}`)) return
    try {
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      if ('project' in body) seen.push(body)
    } catch { /* not JSON: not the request this test is about */ }
  })
  return seen
}

/**
 * A SIDEWAYS slip on the first card of a project run must not file it under the run
 * ABOVE it either (the half of that bug the twitch ratchet above cannot see).
 *
 * The twitch is caught by a displacement guard: press, move, come back, and the
 * dragged node's net translation is zero, so nothing is inferred. That guard reads
 * `Math.hypot(delta.x, delta.y)`, and HORIZONTAL travel satisfies it just as well as
 * vertical travel does — while telling you nothing whatsoever about which project RUN
 * the card is in, runs being stacked vertically. So: press the first card of the lower
 * run, slide 40px sideways, release. dnd-kit still reports the dragged card itself as
 * `over` (the pointer never left that card, so closestCenter keeps picking it), the
 * guard passes on 40px of pure x, and the neighbour walk then answered "the run
 * ABOVE you" and silently reprojected the task.
 *
 * The measured numbers this gesture is built on (probe, solo-Focus geometry, 30px
 * rows): the release pointer stays inside the dragged card's own rect and EVERY row's
 * transform is still the identity matrix, i.e. dnd-kit's preview shows no pending
 * reorder at all. There is nothing about the release that names another run, which is
 * exactly why the answer has to be "no information", not "your neighbour".
 */
test('a sideways slip on the first card of a project run never moves it to the run above', async ({ page }) => {
  const { tierId, cards } = await seedRunsInOwnTier(page, 'Pslip', 2)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  // Premise, ASSERTED rather than assumed (same reason the twitch test asserts it):
  // the gesture only means something when the pressed card opens a run with another
  // run above it. A card in the MIDDLE of a run would pass with the bug in place,
  // its neighbour above being its own project.
  const runs = await tierRuns(page, tierId)
  expect(runs.map((r) => r.cards.length), 'the tier must draw two runs of one card each')
    .toEqual([1, 1])
  const [above, target] = runs
  const targetCard = target.cards[0]
  expect(cards, 'the run this test presses is not one it seeded').toContain(targetCard)
  expect(above.project, 'the run above must be a DIFFERENT project').not.toBe(target.project)
  expect(await taskProjectViaApi(targetCard), 'the label and the card disagree about the run')
    .toBe(target.project)

  const projectPatches = watchProjectPatches(page, targetCard)

  const card = tierCard(page, targetCard, tierId)
  const box = await scrollOnScreen(page, card, 'the first card of the second run')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  // Purely horizontal, and far enough to clear half a row: this is the displacement
  // the old guard measured. Staying on the card's own row is the point — the pointer
  // never enters another run, so no layer may claim it did.
  await page.mouse.move(x + 40, y, { steps: 6 })
  // The drag really armed (40px is past the PointerSensor's `distance: 5`): the labels
  // go inert for the duration of a live pinned drag, which is the panel's own signal.
  // Without this the test could "pass" on a gesture dnd-kit never saw, and then there
  // is no drop for anything to get wrong.
  await expect(tierLabel(page, above.project, tierId)).toHaveClass(/tier-project-label-inert/)
  await page.mouse.up()

  // Give a stray PATCH time to appear before declaring there was none (the same way
  // the folder specs prove an absence).
  await page.waitForTimeout(1_500)
  expect(projectPatches, 'the sideways slip fired a project move').toEqual([])
  expect(await taskProjectViaApi(targetCard), 'the sideways slip reprojected the card server-side')
    .toBe(target.project)
  // And the tier still draws BOTH runs, in the same order: the pressed card is its
  // run's only member, so a reprojection takes the whole run with it and the label the
  // user navigates by simply disappears.
  expect(await tierProjectOrder(page, tierId)).toEqual([above.project, target.project])
  await expect(tierCard(page, targetCard, tierId)).toBeVisible()
  await page.screenshot({ path: '/tmp/project-collapse/slip-keeps-project.png' })
  expect(errors).toEqual([])
})

/**
 * Aim at another project's run, change your mind, come back, release: nothing moves.
 *
 * Not a bug ratchet but a DESIGN one, and the reason the displacement guard survives
 * next to the aim record. When `over` collapses back onto the dragged card the panel
 * falls back to the last row dnd-kit NAMED while the user was aiming, which is real
 * evidence of intent — but it is a record of the whole gesture, so on its own it would
 * still move a card whose owner dragged it over a neighbouring run and then put it
 * back exactly where it started. The net translation is what says "this gesture ended
 * where it began", and it has to keep vetoing the aim record. Delete the guard and
 * this test is what fails.
 */
test('a drag that visits another run and returns to the press point changes nothing', async ({ page }) => {
  const { tierId, cards } = await seedRunsInOwnTier(page, 'Pback', 3)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  const runs = await tierRuns(page, tierId)
  expect(runs.map((r) => r.cards.length), 'the tier must draw three runs of one card each')
    .toEqual([1, 1, 1])
  // Press the MIDDLE run's card and visit the LAST run: a run below, so the visit is
  // a real aim at a different project rather than a slide off the top of the tier.
  const target = runs[1]
  const visited = runs[2]
  const targetCard = target.cards[0]
  expect(cards, 'the run this test presses is not one it seeded').toContain(targetCard)
  expect(visited.project, 'the visited run must be a DIFFERENT project').not.toBe(target.project)

  const projectPatches = watchProjectPatches(page, targetCard)

  const card = tierCard(page, targetCard, tierId)
  const box = await scrollOnScreen(page, card, 'the middle run\'s card')
  const away = await scrollOnScreen(page, tierCard(page, visited.cards[0], tierId), 'the visited run\'s card')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 10, { steps: 3 })
  // Visit the other run's row, long enough for dnd-kit to name it as `over` (that is
  // what puts it in the aim record this test is about).
  await page.mouse.move(x, away.y + away.height / 2, { steps: 10 })
  await page.waitForTimeout(300)
  await expect(tierLabel(page, visited.project, tierId)).toHaveClass(/tier-project-label-inert/)
  // Change of mind: all the way back to the press point.
  await page.mouse.move(x, y, { steps: 10 })
  await page.waitForTimeout(200)
  await page.mouse.up()

  await page.waitForTimeout(1_500)
  expect(projectPatches, 'a drag that ended where it began fired a project move').toEqual([])
  expect(await taskProjectViaApi(targetCard), 'a drag that ended where it began reprojected the card')
    .toBe(target.project)
  expect(await tierProjectOrder(page, tierId))
    .toEqual([runs[0].project, target.project, visited.project])
  await page.screenshot({ path: '/tmp/project-collapse/aim-and-return-keeps-project.png' })
  expect(errors).toEqual([])
})

