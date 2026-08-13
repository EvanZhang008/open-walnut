/**
 * The draft session column — one verb "New".
 *
 * Every "+" in the app (todo toolbar, project header, pin-tier header, the chat "+ Session" pill,
 * `/session`, ⌘⇧Enter) now grows an EMPTY session column instead of opening a
 * launcher popover. The column is pure client state until the user commits:
 * "Start ↵" morphs it `draft:` → `pending:` → a real session, "◌ Create task for
 * later" turns the composed text into a task, and closing it leaves NO trace anywhere.
 *
 * SHAPE (the approved v4 layout — everything stacked UP from the composer):
 *   header             title + Draft badge + (bound task) + ✕
 *   `.draft-session-body`   ONE centered muted line, nothing actionable
 *   `.session-panel-input`  the whole bottom stack:
 *     `.draft-launch-bar`   quick-access basename chips → engine/pin row →
 *                           cwd pill · project pill (left-aligned), with the
 *                           folder picker opening UPWARD from it
 *     the composer          whose controls row holds the model select + two verbs
 *
 * What moved in v4, and therefore what this file asserts POSITIONALLY rather than
 * by mere existence: the launch bar is no longer a strip under the HEADER (it now
 * lives inside `.session-panel-input`, directly above the composer), the model
 * select left the bar's meta row for the composer's controls row, and the body
 * lost its quick-action chips (and the "Fix Walnut" chip with them — the repair
 * entry point is the chat pill only). The pills kept their `.draft-composer-bar`
 * container marker through both moves, so the ~12 specs that reach the folder
 * picker through a draft are untouched.
 *
 * Nine scenarios, all about the column's LIFECYCLE — open → configure → Start /
 * task / discard. Each guards a hard requirement rather than a rendering detail;
 * the "why" for each lives at the test itself, not in a duplicated index here.
 *
 * Two sibling files share this one's helpers (./draft-helpers) and cover the rest of
 * the feature. Split by SUBJECT, not for length:
 *   tests/e2e/browser/draft-quick-chips.spec.ts   — the R6 quick-access chip row
 *     (its ranking mix, and one click setting folder + project)
 *   tests/e2e/browser/draft-session-seeds.spec.ts — the ENTRY POINTS that
 *     pre-configure a draft: R7 project header "+", R8 pin-tier "+", R9 the AI
 *     backfill while typing
 *
 * House rules: `page.goto('/')` is the initial load only; every later step is a
 * real click. Columns are seeded through sessionStorage (an init script) and the
 * panel count through the real Settings UI — both helpers live in ./draft-helpers.
 *
 * PARALLEL SAFETY. The fixture server is SHARED across spec files, so anything
 * that counts global rows would race a concurrent spec creating tasks. Every
 * "did/didn't a task appear" assertion here is therefore scoped to a UNIQUE
 * stamped title instead of a list length.
 */

import { test, expect } from '@playwright/test'
import {
  basenameOf, discoverFixtureRoot, draftComposer, draftCwdPill, draftLaunchBar, draftPanel,
  draftProjectPill, expectV4Stack, homeColumns, loadHome, lockLeftmostPanel, openDraft,
  openDraftOnCwd, seedColumns, setPanelMode, tasksTitled, watchForbiddenRequests,
} from './draft-helpers'
import { presetPanelView } from './todo-panel-helpers'

/** Artifacts of the v4-layout run (the re-arranged column). Per-run overridable
 *  so a later revision's artifacts don't overwrite this one's. */
const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-v4e'

/** Seeded, stopped sessions from test-server.ts — distinct ids, one column each. */
const SIDS = ['pw-normal-session', 'pw-plan-session-completed'] as const

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

// The panel-count steps wait on config round-trips that queue behind the
// fixture's session health monitor (~20s event-loop blocks on its seeded
// 500-session dataset), plus a real CLI spawn on the Start scenarios. 180s, not
// 120s: `setPanelMode` alone may spend up to 72s re-clicking through a starved
// config write (see draft-helpers), and the steps AFTER it still need room.
test.setTimeout(180_000)

// Serial within the file: two scenarios drive the app-wide `ui.session_panels`
// setting, and running them concurrently would have each observing the other's
// column budget.
test.describe.configure({ mode: 'serial' })

// ── 1. "+" opens instantly, with zero network ───────────────────────────────

test('"+" opens a focused draft column with no network in the open path', async ({ page }) => {
  await loadHome(page)

  const seen = watchForbiddenRequests(page)

  await page.locator('.new-launcher-btn').click()

  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  // Nothing runs server-side yet, and the header says so in the user's words.
  await expect(panel.locator('.session-panel-title')).toHaveText('New Session')
  await expect(panel.locator('.session-panel-badge').first()).toHaveText('Draft')

  // THE requirement: not one request between the click and the visible column.
  expect(seen, 'the open path must be network-free').toEqual([])

  // ── The v4 layout, asserted as GEOMETRY, not as "these classes exist" ──
  //
  // The whole point of the re-arrangement is WHERE things are: the launch config
  // is stacked immediately above the composer (a normal chat has no
  // folder/project controls inside it, so they live just outside), the body is
  // one muted line, and the model sits with the message. A class-existence check
  // would have passed against the OLD shape (bar under the header, model in the
  // bar), so every claim below is either a DOM-containment or a top-edge
  // ordering check. Details of each row live in `expectV4Stack`.
  await expectV4Stack(panel)

  // The launch meta the user can see WITHOUT opening the folder picker: engine +
  // pin tier in the bar's row (the model moved to the composer — see
  // expectV4Stack). Before the earlier revision these were reachable only by
  // opening the picker, so a draft's actual launch config was invisible.
  const meta = draftLaunchBar(panel).locator('.sps-meta-footer')
  await expect(meta.locator('.pin-tier-options')).toBeVisible()
  await expect(meta.locator('.sps-engine-toggle')).toBeVisible()
  // …and the model select is NOT in that row any more. Asserted here (not only as
  // "it is in the composer") because leaving a second copy behind would give the
  // column two competing model controls.
  await expect(meta.locator('.sps-meta-model-select')).toHaveCount(0)

  // The caret is in THIS draft's composer, not the main chat's — a "+" you then
  // have to click into is not the "instant open" being shipped.
  const focusedInDraft = await page.evaluate(() => {
    const el = document.activeElement
    return !!el?.classList.contains('chat-input-textarea') && !!el.closest('.draft-session-panel')
  })
  expect(focusedInDraft, 'the draft composer holds the caret').toBe(true)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-instant-open.png`, fullPage: false })
})

test('the chat "+ Session" pill opens the same draft column (no launcher popover)', async ({ page }) => {
  await loadHome(page)

  const seen = watchForbiddenRequests(page)

  // Disambiguate by the pill's own title — the todo toolbar has a "+" too.
  await page.getByTitle(/start a Claude Code session there directly/).click()

  await expect(draftPanel(page)).toBeVisible({ timeout: 10_000 })
  // The chat-anchored picker must NOT open: this pill was the last entry point
  // still routing through it. (The component stays mounted for fix-walnut and the
  // model chip — what changed is only the route in.)
  await expect(page.locator('.chat-composer-overlay .session-path-selector')).toHaveCount(0)
  expect(seen, 'the pill open path must be network-free').toEqual([])
})

// ── 2. Locked + at max: "+" still adds ──────────────────────────────────────

test('two LOCKED columns at max=2 → "+" still adds a third, with no locked toast', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  // Set the count BEFORE seeding columns (eviction is one-way).
  await setPanelMode(page, '2')
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 25_000 })

  // Lock BOTH panels through their real header controls. This is the state that
  // used to make a launch vanish.
  await lockLeftmostPanel(page)
  await expect(page.locator('.session-panel-lock.is-locked')).toHaveCount(1, { timeout: 10_000 })
  await lockLeftmostPanel(page)
  await expect(page.locator('.session-panel-lock.is-locked')).toHaveCount(2, { timeout: 10_000 })

  await page.locator('.new-launcher-btn').click()

  // A third column, overflowing the user's max ON PURPOSE (the overflow license).
  await expect(draftPanel(page)).toBeVisible({ timeout: 10_000 })
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  // Neither locked session was evicted to make room: the eviction effect skips
  // the RISING edge of the placeholder count precisely so asking for a column
  // can't close a live one.
  await expect(page.locator('.session-panel-lock.is-locked')).toHaveCount(2)
  // ...and no rejection toast, because there is no rejection path left.
  await expect(page.getByText('All session panels are locked', { exact: false })).toHaveCount(0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-locked-override.png`, fullPage: false })
})

// ── 3. Type → pick cwd → Start ──────────────────────────────────────────────

test('Start launches with the picked cwd and NO taskId, becomes a real panel, and the strip trims back', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await setPanelMode(page, '2')
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 25_000 })

  const cwd = `${fixtureRoot}/projects/walnut`
  const panel = await openDraftOnCwd(page, cwd)
  // Three columns while the draft is open — the license is active.
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })

  const message = `draft start probe ${Date.now()}`
  await draftComposer(page).fill(message)

  const launch = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await panel.locator('.draft-start-btn').click()

  const payload = (await launch).postDataJSON() as {
    cwd?: string; message?: string; taskId?: string; sessionId?: string
  }
  expect(payload.cwd).toBe(cwd)
  expect(payload.message).toBe(message)
  // A draft owns no task — the server mints one. A taskId here would mean the
  // draft path leaked the ▶-Start (task-reuse) branch.
  expect(payload.taskId).toBeUndefined()
  // Native launches carry a CLIENT-owned session id, which is what lets this
  // spec name the resulting panel instead of guessing at counts.
  expect(payload.sessionId, 'native quick-start sends a client session id').toBeTruthy()

  // The column morphs IN PLACE: no draft panel left anywhere, and the new id is
  // mounted as a real SessionPanel (`data-session-id` exists only there — the
  // draft carries `data-draft-id` and the pending placeholder carries neither).
  await expect(page.locator('.draft-session-panel')).toHaveCount(0)
  const newPanel = page.locator(`.session-panel[data-session-id="${payload.sessionId}"]`)
  await expect(newPanel).toBeVisible({ timeout: 30_000 })

  // The overflow license EXPIRES with the placeholder: once the column holds a
  // real session it is evictable again, the trim re-runs, and the strip returns
  // to the user's max. The draft was inserted LEFTMOST and the morph preserves
  // its index, so the eviction takes a seeded column from the right — the panel
  // the user just started must still be there.
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 20_000 })
  await expect(newPanel).toBeVisible()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-started.png`, fullPage: false })
})

// ── 4. Close leaves no trace ────────────────────────────────────────────────

test('closing a draft leaves no trace: no task, no persisted column, no draft key', async ({ page }) => {
  await loadHome(page)

  const stamp = `discarded draft ${Date.now()}`
  const panel = await openDraft(page)
  // Type something, so the close discards REAL content rather than a blank.
  await draftComposer(page).fill(`${stamp}\nthis text must not be persisted anywhere`)
  await panel.locator('.session-panel-close').click()
  await expect(page.locator('.draft-session-panel')).toHaveCount(0)

  // No task was created — a draft is 0 bytes server-side until it is committed.
  // Scoped to the stamp so a concurrent spec's task can't fail this.
  expect(await tasksTitled(page, stamp)).toEqual([])

  // No `draft:` id in the persisted column queue (a placeholder resolves to
  // nothing after a reload, so persisting one would mount a broken column), and
  // the composer's localStorage key is swept too.
  const residue = await page.evaluate(() => {
    const cols = sessionStorage.getItem('open-walnut-home-session-columns') ?? ''
    const draftKeys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('draft:new-session:')) draftKeys.push(k)
    }
    return { cols, draftKeys }
  })
  expect(residue.cols).not.toContain('draft:')
  expect(residue.draftKeys, 'the draft composer key is cleared on close').toEqual([])
})

// ── 5. "Create task for later" — one click, first line is the title ─────────

test('Create task for later turns the draft into a task: first line = title, rest = description', async ({ page }) => {
  await loadHome(page)
  const stamp = Date.now()
  const title = `Fix the login bug ${stamp}`
  const description = 'repro: click X twice'

  const panel = await openDraft(page)
  await draftComposer(page).fill(`${title}\n\n${description}`)
  // The label is the whole affordance: it has to promise a TASK and deny a
  // session in the words the user chose ("Save for later" read like a draft
  // autosave), so it is asserted, not just clicked.
  const later = panel.locator('.draft-later-btn')
  await expect(later).toContainText('Create task for later')
  // ONE click, no dialog — that is the whole point of this control.
  await later.click()

  // The column goes immediately (the close is optimistic, ahead of the POST).
  await expect(page.locator('.draft-session-panel')).toHaveCount(0, { timeout: 10_000 })

  // Toast FIRST, and as ONE locator: the 'sort' kind auto-dismisses after 3s, so
  // the API round-trips below would outlive it, and two sequential expects could
  // straddle the dismissal. Undo is what makes a no-dialog capture safe to
  // mis-click, so it is part of the thing being waited for, not a follow-up.
  const toast = page
    .locator('.notification-toast--success', { hasText: 'Task created' })
    .filter({ has: page.locator('.notification-toast-action', { hasText: 'Undo' }) })
  await expect(toast).toBeVisible({ timeout: 20_000 })

  // The task exists with the split applied: the first line became the title (not
  // the whole blob), and the remainder became the description.
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`)).map((t) => t.title),
    { timeout: 20_000, message: 'the saved task never appeared' }).toEqual([title])
  const created = (await tasksTitled(page, `${stamp}`))[0]

  // description rides the create (POST /api/tasks passes it to addTask). The list
  // payload drops it, so read the task's own endpoint.
  const detail = await page.request.get(`/api/tasks/${created.id}`)
  const detailBody = (await detail.json()) as { task?: { description?: string } }
  expect(detailBody.task?.description ?? '').toContain('repro:')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-save-for-later.png`, fullPage: false })
})

// ── 6. Project header "+" seeds the project (R7: one click, no menu) ────────

test('project header "+" pre-fills the project pill, and Create task for later files the task there', async ({ page }) => {
  // Both panel axes open (stacked sections + the All project chip) so the project
  // group headers — and their "+" — render.
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  const header = page.locator('.todo-group-project-header').filter({
    has: page.locator('.todo-group-project-name').filter({ hasText: /^Walnut$/ }),
  }).first()
  await expect(header).toBeVisible({ timeout: 25_000 })
  // The header actions are hover-revealed (opacity 0 in a resting list).
  await header.hover()
  // ONE click (R7): the "+" is a direct button now, not a two-item menu.
  await header.getByRole('button', { name: 'New session in Walnut' }).click()

  // The draft opens with the project pill already reading 'Walnut'. Pill order in
  // the launch bar is cwd/host first, project second.
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(draftProjectPill(panel)).toHaveText('Walnut')

  const title = `project seeded capture ${Date.now()}`
  await draftComposer(page).fill(title)
  await panel.locator('.draft-later-btn').click()
  await expect(page.locator('.draft-session-panel')).toHaveCount(0, { timeout: 10_000 })

  // The seed reached the CREATE, not just the pill: the task lands in Walnut,
  // never the Inbox.
  await expect.poll(async () => (await tasksTitled(page, title))[0]?.project ?? null,
    { timeout: 20_000, message: 'the project-seeded task never appeared' }).toBe('Walnut')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-project-seed.png`, fullPage: false })
})

// ── 7. ▶ Start on a DESCRIBED task row launches straight away ───────────────

test('task row ▶ Start reuses the task (taskId in the payload) and creates no duplicate', async ({ page }) => {
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  // A task carrying its own cwd AND a description: ▶ must launch in the task's
  // folder and build the first message from title + description.
  const stamp = Date.now()
  const title = `start me from a row ${stamp}`
  const description = 'the body that must ride along as context'
  const cwd = `${fixtureRoot}/projects/walnut`
  const createRes = await page.request.post('/api/tasks', {
    data: { title, source: 'local', project: 'Walnut', cwd, description },
  })
  expect(createRes.ok(), await createRes.text()).toBe(true)
  const taskId = ((await createRes.json()) as { task: { id: string } }).task.id

  // Find the row in the real list (the WS task:created event lands it live).
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 25_000 })

  // Hover reveals ▶ (opacity 0 until then — a dense list stays quiet).
  await row.hover()
  const startBtn = row.locator('.task-start-btn')
  await expect(startBtn).toBeVisible()

  const launch = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await startBtn.click()

  const payload = (await launch).postDataJSON() as {
    taskId?: string; message?: string; cwd?: string; sessionId?: string
  }
  // THE assertion: the existing task is REUSED, never duplicated.
  expect(payload.taskId).toBe(taskId)
  expect(payload.cwd).toBe(cwd)
  expect(payload.message).toContain(title)
  // The list payload (`fields=list`) drops description, so ▶ has to lazily fetch
  // the full task — a missing body here means that fetch regressed.
  expect(payload.message).toContain(description)

  // The launch lands as a real session column (named by the client-owned id)...
  await expect(page.locator(`.session-panel[data-session-id="${payload.sessionId}"]`))
    .toBeVisible({ timeout: 30_000 })

  // ...and there is still exactly ONE task with this stamp. Polled, because the
  // quick-start response and its TASK_UPDATED echo both land after the request
  // above — a duplicate would show up in that window.
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`)).length,
    { timeout: 15_000, message: '▶ Start must not mint a second task' }).toBe(1)
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`))[0]?.id, { timeout: 5_000 }).toBe(taskId)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/07-task-row-start.png`, fullPage: false })
})

// ── 8. ▶ Start on a TITLE-ONLY task row opens a BOUND draft ─────────────────

test('title-only task ▶ Start opens a bound draft (no launch), and its Start reuses that task', async ({ page }) => {
  // Wide enough that the draft column renders fully beside the chat — at the
  // default 1280 the column is clipped, which makes the artifact unreadable even
  // though the assertions (DOM-level) still hold.
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  // Title-only: no description at all. A bare title is not a brief, so spending a
  // session on it immediately (scenario 7's path) wastes the launch — the user
  // gets a composer pre-pointed at the task instead.
  const stamp = Date.now()
  const title = `write the brief yourself ${stamp}`
  const cwd = `${fixtureRoot}/projects/walnut`
  const createRes = await page.request.post('/api/tasks', {
    data: { title, source: 'local', project: 'Walnut', cwd },
  })
  expect(createRes.ok(), await createRes.text()).toBe(true)
  const taskId = ((await createRes.json()) as { task: { id: string } }).task.id

  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.hover()

  const seen = watchForbiddenRequests(page)
  await row.locator('.task-start-btn').click()

  // A draft, NOT a launch. `launchQuickStart` fires its POST synchronously, so by
  // the time the panel is up a direct launch would already be in `seen` — and it
  // would have rendered a pending placeholder rather than a draft.
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  expect(seen, '▶ on a title-only task must not launch anything').toEqual([])
  await expect(page.locator('.pending-session-panel')).toHaveCount(0)

  // The binding is visible: the header names the task this column will attach to…
  await expect(panel.locator('.draft-bound-task')).toContainText(title)
  // …the task's own folder came along as a pin (so Start needs no picker)…
  await expect(draftCwdPill(panel)).toContainText(basenameOf(cwd))
  await expect(draftProjectPill(panel)).toHaveText('Walnut')
  // …and "Create task for later" is GONE: this draft already IS a task, so
  // offering to create one could only mint a duplicate.
  await expect(panel.locator('.draft-later-btn')).toHaveCount(0)

  // Shot taken HERE, while the bound draft is still on screen: after the Start
  // below the column is a real session panel, and a shot at the end of the test
  // would document the wrong state.
  await page.screenshot({ path: `${SCREENSHOT_DIR}/08-bound-draft.png`, fullPage: false })

  // The instruction the user came to write is what gets sent — the title fallback
  // is for an EMPTY composer only.
  const message = `bound draft instruction ${stamp}`
  await draftComposer(page).fill(message)

  const launch = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await panel.locator('.draft-start-btn').click()

  const payload = (await launch).postDataJSON() as {
    taskId?: string; message?: string; cwd?: string; sessionId?: string
  }
  // THE assertion: the bound draft reuses the row's task instead of minting one.
  expect(payload.taskId).toBe(taskId)
  expect(payload.message).toBe(message)
  expect(payload.cwd).toBe(cwd)

  await expect(page.locator('.draft-session-panel')).toHaveCount(0)
  await expect(page.locator(`.session-panel[data-session-id="${payload.sessionId}"]`))
    .toBeVisible({ timeout: 30_000 })

  // Still exactly one task with this stamp: neither the draft nor the launch
  // created a second row for the same work.
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`)).length,
    { timeout: 15_000, message: 'a bound draft must not mint a second task' }).toBe(1)
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`))[0]?.id, { timeout: 5_000 }).toBe(taskId)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/08b-bound-started.png`, fullPage: false })
})
