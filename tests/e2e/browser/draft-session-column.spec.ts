/**
 * The draft session column — one verb "New".
 *
 * Every "+" in the app (todo toolbar, project header, pin-tier header, the Ask Walnut slot's "+ Session" chip,
 * `/session`, ⌘⇧Enter) now grows an EMPTY session column instead of opening a
 * launcher popover. The column is pure client state until the user commits:
 * "Start ↵" morphs it `draft:` → `pending:` → a real session, "◌ Create task for
 * later" turns the composed text into a task, and closing it leaves NO trace anywhere.
 *
 * SHAPE (the approved v4 layout — everything stacked UP from the composer):
 *   header             title + Draft badge + (bound task) + ✕
 *   `.draft-session-body`   ONE centered muted line, nothing actionable
 *   `.session-panel-input`  the whole bottom stack:
 *     `.draft-launch-bar`   "Quick folders" caption over up to 8 basename chips +
 *                           divider → cwd pill · project pill (no tier/More row
 *                           since 2026-09-15), every row on ONE left edge, with
 *                           the folder picker opening UPWARD from it
 *     the composer          whose controls row holds the model select + two verbs
 *
 * What moved in v4, and therefore what this file asserts POSITIONALLY rather than
 * by mere existence: the launch bar is no longer a strip under the HEADER (it now
 * lives inside `.session-panel-input`, directly above the composer), the model
 * select AND the Claude|Codex toggle left the bar's meta row for the composer's
 * model picker (one control, one question), and the body lost its quick-action chips (and the "Fix Walnut" chip with them — the repair
 * entry point is the Ask Walnut slot's header chip only). The pills kept their `.draft-composer-bar`
 * container marker through both moves, so the ~12 specs that reach the folder
 * picker through a draft are untouched.
 *
 * Ten scenarios: nine about the column's LIFECYCLE — open → configure → Start /
 * task / discard — and one fault injection on the create it commits. Each guards
 * a hard requirement rather than a rendering detail; the "why" for each lives at
 * the test itself, not in a duplicated index here.
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
  draftPanels,
  draftProjectPill, expectV4Stack, homeColumns, loadHome, lockLeftmostPanel, openDraft,
  openDraftOnCwd, seedColumns, setPanelMode, tasksTitled, watchForbiddenRequests,
} from './draft-helpers'
import { openSessionFromPlus } from './draft-surface-helpers'
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

  // Nothing is pre-selected. The working-dirs cache is WARM here (the fixture
  // seeds a history and loadHome primes it), so an empty pill proves the open
  // path chose not to fill it, not that it had nothing to fill it with. User
  // rule (2026-09-02): a fresh draft never pre-picks a folder or a project.
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')
  await expect(draftProjectPill(panel)).toHaveText('Inbox')

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

  // The launch bar carries NO task-meta controls: no pin-tier group, no More menu,
  // no model select, no engine toggle (2026-09-15: the tier · More row went, "too
  // complicated for people"; the model and the provider live in the composer's
  // model picker, see expectV4Stack). What the user can configure without the
  // folder picker is exactly the two pills above — folder and project.
  const bar = draftLaunchBar(panel)
  await expect(bar.locator('.sps-meta-footer')).toHaveCount(0)
  await expect(bar.locator('.pin-tier-options')).toHaveCount(0)
  await expect(bar.locator('.sps-meta-more-btn')).toHaveCount(0)
  await expect(bar.locator('.sps-meta-model-select')).toHaveCount(0)
  await expect(bar.locator('.sps-engine-toggle')).toHaveCount(0)

  // The caret is in THIS draft COLUMN's composer — a "+" you then have to click
  // into is not the "instant open" being shipped. Scoped through
  // `.main-page-session-column`: the Ask Walnut slot renders a draft panel of its
  // own (also autoFocus), so a bare `.draft-session-panel` closest() would accept
  // the caret sitting in the slot instead.
  const focusedInDraft = await page.evaluate(() => {
    const el = document.activeElement
    return !!el?.classList.contains('chat-input-textarea')
      && !!el.closest('.main-page-session-column .draft-session-panel')
  })
  expect(focusedInDraft, 'the draft composer holds the caret').toBe(true)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-instant-open.png`, fullPage: false })
})

test('Start with no folder picked says so and opens the picker — no request, text kept', async ({ page }) => {
  // With nothing pre-selected, "+ → type → Start" is the path that USED to be a
  // silent no-op (a picker opened, nothing said why). The notice is what makes
  // an empty default acceptable: the refusal is explained next to the pill that
  // resolves it, and the composer keeps the text.
  await loadHome(page)
  const panel = await openDraft(page)
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')

  const message = `no folder yet ${Date.now()}`
  await draftComposer(page).fill(message)

  const launches: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start') launches.push(req.url())
  })
  await panel.locator('.draft-start-btn').click()

  await expect(panel.getByTestId('draft-needs-folder')).toBeVisible()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  // Still a draft, text intact, nothing launched.
  await expect(draftComposer(page)).toHaveValue(message)
  await expect(panel).toBeVisible()
  expect(launches, 'Start on an empty folder must not launch').toEqual([])

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01b-start-needs-folder.png`, fullPage: false })
})

test('the /task slash command opens the same draft column (no launcher popover, no second surface)', async ({ page }) => {
  await loadHome(page)

  const seen = watchForbiddenRequests(page)

  // The old chat composer's "+ Task" / "+ Session" chips and the slot drawer's
  // rows are gone: the draft column is the ONE task-creation surface, and the
  // /task command (a `task-composer:open` event) routes into it as well.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('task-composer:open')))

  await expect(draftPanel(page)).toBeVisible({ timeout: 10_000 })
  // Neither the launcher popover nor the retired quick-task popover may open.
  await expect(page.locator('.session-path-selector')).toHaveCount(0)
  await expect(page.locator('.quick-task-composer')).toHaveCount(0)
  expect(seen, 'the open path must be network-free').toEqual([])
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
  await expect(draftPanels(page)).toHaveCount(0)
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
  await expect(draftPanels(page)).toHaveCount(0)

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
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 10_000 })

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
  // The "+" is a MENU on this surface (R9: task / task with session / separator),
  // so the session route is the button plus its named item.
  await openSessionFromPlus(page, header)

  // The draft opens with the project pill already reading 'Walnut'. Pill order in
  // the launch bar is cwd/host first, project second.
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(draftProjectPill(panel)).toHaveText('Walnut')

  const title = `project seeded capture ${Date.now()}`
  await draftComposer(page).fill(title)
  await panel.locator('.draft-later-btn').click()
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 10_000 })

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

  // Find the task in the real panel (the WS task:created event lands it live). A new
  // task is pinned, and the All view shows a pinned task as its tier card only.
  const row = page.locator(`#home-task-navigation [data-task-id="${taskId}"]`).first()
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

  // A new task is pinned, and the All view shows a pinned task as its tier card only.
  const row = page.locator(`#home-task-navigation [data-task-id="${taskId}"]`).first()
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

  await expect(draftPanels(page)).toHaveCount(0)
  await expect(page.locator(`.session-panel[data-session-id="${payload.sessionId}"]`))
    .toBeVisible({ timeout: 30_000 })

  // Still exactly one task with this stamp: neither the draft nor the launch
  // created a second row for the same work.
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`)).length,
    { timeout: 15_000, message: 'a bound draft must not mint a second task' }).toBe(1)
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`))[0]?.id, { timeout: 5_000 }).toBe(taskId)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/08b-bound-started.png`, fullPage: false })
})

// ── 9. Broadcast-before-response create (fault injection) ──────────────────
// LAST in this serial file on purpose: it holds a response open, so a flake here
// must not take later scenarios down with it.

test('a create whose task:created broadcast beats its HTTP response shows the task ONCE on the board', async ({ page }) => {
  // The route emits task:created BEFORE it writes the response, so the broadcast
  // routinely reaches the creating browser first. A client that only learns the
  // real id from the response cannot recognise that broadcast and inserts a
  // second row beside its optimistic one — on the pinned board both sat in Focus
  // for the width of the response (found by a strict locator resolving to two
  // cards). The create now carries a client_request_id the broadcast echoes, and
  // whichever arrives first reconciles. Fault injection: hold the response while
  // letting the server (and its broadcast) run at full speed.
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)
  const stamp = Date.now()
  const title = `broadcast-first create ${stamp}`

  let released: (() => void) | null = null
  let responseDelivered = false
  const held = new Promise<void>((resolve) => { released = resolve })
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const response = await route.fetch()
    const body = await response.text()
    // Held until the assertions below have run. The cap only guards a hang; the
    // 30s test timeout is the real budget, and a loaded box needs the headroom.
    await Promise.race([held, new Promise((r) => setTimeout(r, 25_000))])
    responseDelivered = true
    await route.fulfill({ response, body })
  })
  // A list refetch inside the window would ALSO leave one real row (the temp row
  // is never noteInserted, so the merge drops it) — with the bug still present.
  // Make that path a failure, not a false pass.
  let listRefetches = 0
  const onResponse = (res: import('@playwright/test').Response) => {
    const u = new URL(res.url())
    if (res.request().method() === 'GET' && u.pathname === '/api/tasks') listRefetches++
  }
  page.on('response', onResponse)

  const panel = await openDraft(page)
  await draftComposer(page).fill(title)
  await panel.locator('.draft-later-btn').click()

  // Two scopes. The Focus TIER's cards (`.todo-focus-card`, FocusSatelliteCards)
  // pin the tier; the tier-agnostic pair (`.todo-pinned-card` is every other
  // tier's card) pins the count even if a regression parked the duplicate in
  // Satellite. The Recent strip (`.todo-pinned-list-recent`, same card class) and
  // the project list render the task too, legitimately, so both are excluded.
  const focusCard = page.locator('.todo-focus-card', { hasText: title })
  const anyTierCard = page.locator(
    '.todo-pinned-list:not(.todo-pinned-list-recent) :is(.todo-focus-card, .todo-pinned-card)',
    { hasText: title },
  )
  const realCard = page.locator('.todo-focus-card[data-task-id]:not([data-task-id^="tmp-"])', { hasText: title })
  const tmpCard = page.locator('[data-task-id^="tmp-"]', { hasText: title })
  // The broadcast lands (server answered within milliseconds) while the response
  // is still held: the REAL card is on the board, in Focus...
  await expect(realCard).toHaveCount(1, { timeout: 5_000 })
  expect(responseDelivered, 'the assertions must run inside the held window').toBe(false)
  // ...and it REPLACED the optimistic row rather than joining it, in any tier.
  await expect(tmpCard).toHaveCount(0)
  await expect(anyTierCard).toHaveCount(1)
  await expect(focusCard).toHaveCount(1)
  await page.waitForTimeout(400)
  await expect(anyTierCard).toHaveCount(1)
  expect(responseDelivered, 'still inside the held window').toBe(false)
  expect(listRefetches, 'no list refetch may have reconciled the row for us').toBe(0)

  released?.()
  // After the response: still one card, still pinned in Focus server-side.
  await expect.poll(() => responseDelivered).toBe(true)
  await page.waitForTimeout(800)
  await expect(anyTierCard).toHaveCount(1)
  const id = await focusCard.getAttribute('data-task-id')
  const tiers = (await (await page.request.get('/api/focus/tasks')).json()) as { focus_tasks: string[] }
  expect(tiers.focus_tasks).toContain(id)
  page.off('response', onResponse)
  await page.unroute('**/api/tasks')
})
