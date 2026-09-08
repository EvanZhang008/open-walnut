/**
 * The home page's chat slot IS an Ask Walnut session view (P1 of "remove the
 * main agent").
 *
 * What changed and therefore what this spec pins: the slot no longer renders a
 * hidden lane conversation. It derives its list from the task store (tasks born
 * as asks, `walnut_agent === true`, plus tasks filed under the Ask Walnut
 * project) and renders the REGULAR `SessionPanel` for the selected task — same
 * header, same chips, same composer, same ×/popout/fullscreen as a session
 * column. Its ONE addition is the ≡ button leading that header's title row,
 * which opens a drawer (the Claude app's sidebar shape): a search box that
 * filters the asks, the asks to switch between, "New chat" pinned to the
 * bottom. `New chat` is the Ask Walnut composer (`DraftSessionPanel` in walnut
 * mode) launching `quick-start { walnutAgent: true }` straight into the slot —
 * no session column is opened for a slot launch. Every conversation is born a
 * task, so the launch is also observable on the board (amber title).
 *
 * Deliberately NOT in the drawer (user, 2026-09-07): no "+ Task" / "+ Session"
 * launchers (the draft column is the one task-creation surface), no separate
 * session finder (the search box IS the search), no "hide" row (the panel's ×).
 *
 * Real UI only: one `page.goto('/')` per test to load the SPA (plus one
 * deliberate `page.reload()`, which is the persistence scenario), everything
 * else is clicks and typing. The mock CLI answers `I processed your message:
 * <prompt>`, so the reply assertion is a real streamed turn through the real
 * daemon, not a route stub.
 *
 * TWO fixture facts shape the assertions below:
 *
 *  1. The fixture server is SHARED and REUSED across runs
 *     (`reuseExistingServer`), and other specs launch Ask Walnut sessions too
 *     (tests/e2e/browser/draft-ask-walnut-launch-memory.spec.ts). A bare
 *     "exactly one row" would therefore race foreign walnut tasks. `hideForeignWalnutTasks`
 *     filters GET /api/tasks down to the tasks THIS FILE created (everything
 *     else passes through untouched), so drawer-row COUNTS are exact without
 *     asserting anything about global state. Each prompt also carries a per-run
 *     stamp, so leftovers from a previous run can never satisfy a text assertion.
 *  2. Background AI is off in the fixture (`WALNUT_DISABLE_BACKGROUND_AI=1`), so
 *     an Ask Walnut task keeps its placeholder title `Ask Walnut`
 *     (ASK_WALNUT_PLACEHOLDER_TITLE) forever. Rows are therefore addressed by
 *     `data-task-id`, never by their label — label text can't tell two rows apart.
 *
 * Runs on chromium AND webkit (the Mac app is a WKWebView), so nothing here uses
 * a chromium-only API: plain locators, `boundingBox()`, `route`/`routeWebSocket`.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DRAFT_PANEL, loadHome, openAskWalnutDrawer, openDraft } from './draft-helpers'

const SCREENSHOT_DIR = process.env.ASK_SLOT_SHOT_DIR ?? '/tmp/ask-walnut-slot'

/** Unique per run: the fixture server survives across runs, so every text
 *  assertion (and every "must NOT appear" assertion) needs its own needle. */
const STAMP = Date.now().toString(36)
const FIRST_PROMPT = `hello from the slot ${STAMP}`
const SECOND_PROMPT = `second question ${STAMP}`
const MOBILE_PROMPT = `mobile ask ${STAMP}`

/** The mock CLI's reply for a prompt (it appends run-dependent [cwd:…] suffixes). */
const replyTo = (prompt: string): string => `I processed your message: ${prompt}`

// State shared by the serial tests below (same worker, so module scope is the
// carrier). Test N+1 legitimately depends on the tasks test N launched.
const ourWalnutTaskIds = new Set<string>()
let firstTaskId = ''
let firstSessionId = ''
let secondTaskId = ''
let secondSessionId = ''

// Serial for the whole FILE: the tests share the fixture's task rows and the
// module state above, and `fullyParallel` would otherwise spread them over
// workers (separate module instances, interleaved launches).
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

// ── Slot locators (the DOM contract) ─────────────────────────────────────────

const slot = (page: Page): Locator => page.locator('[data-testid="ask-walnut-slot"]')
/** The ≡ button — rendered by whichever body is on screen (panel, draft, pending). */
const slotMenu = (page: Page): Locator => page.locator('[data-testid="ask-walnut-menu"]')
const drawer = (page: Page): Locator => page.locator('[data-testid="ask-walnut-drawer"]')
const drawerRows = (page: Page): Locator => page.locator('[data-testid="ask-walnut-drawer-item"]')
const drawerRow = (page: Page, taskId: string): Locator =>
  page.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${taskId}"]`)
const drawerNew = (page: Page): Locator => page.locator('[data-testid="ask-walnut-new"]')
const drawerFix = (page: Page): Locator => page.locator('[data-testid="ask-walnut-fix"]')
const drawerSearch = (page: Page): Locator => page.locator('[data-testid="ask-walnut-search"]')
const slotDraft = (page: Page): Locator => page.locator('[data-testid="ask-walnut-draft"]')
const slotPending = (page: Page): Locator => page.locator('[data-testid="ask-walnut-pending"]')
const slotSession = (page: Page): Locator => page.locator('[data-testid="ask-walnut-session"]')
/** The Ask Walnut composer INSIDE the slot (never the session panel's own one). */
const slotDraftComposer = (page: Page): Locator => slotDraft(page).locator('.chat-input-textarea')
/** The live session's composer inside the slot (the mobile reachability check). */
const slotSessionComposer = (page: Page): Locator => slotSession(page).locator('.chat-input-textarea')

/**
 * Width of the chat spot, 0 when the slot has yielded it.
 *
 * Mechanism-agnostic on purpose. Today "the draft borrows the chat spot" is
 * `.main-page-chat.collapsed` (flex 0 0 0px, opacity 0), and an unmounted panel
 * would be equally correct — both read as width 0 here, while a `toBeHidden()`
 * on the slot could false-fail on a clipped child that still reports a box.
 */
async function chatSpotWidth(page: Page): Promise<number> {
  const chat = page.locator('.main-page-chat')
  if ((await chat.count()) === 0) return 0
  return (await chat.first().boundingBox())?.width ?? 0
}

const expectChatSpotYielded = async (page: Page): Promise<void> => {
  await expect
    .poll(() => chatSpotWidth(page), { timeout: 10_000, message: 'the chat spot was never yielded' })
    .toBeLessThanOrEqual(1)
}

const expectChatSpotOpen = async (page: Page): Promise<void> => {
  await expect
    .poll(() => chatSpotWidth(page), { timeout: 10_000, message: 'the chat spot never came back' })
    .toBeGreaterThan(1)
}

// ── Fixture isolation ────────────────────────────────────────────────────────

/**
 * Hide FOREIGN Ask Walnut tasks from this page's task store.
 *
 * The slot's list is derived from the store, so filtering the ONE list endpoint
 * the home page reads (`GET /api/tasks`, `useTasks` → `fetchTasks({minimal:true})`)
 * makes the tab set exactly "the tasks this file launched". Everything else —
 * POST /api/tasks, /api/tasks/<id>, every non-walnut row — is passed through, so
 * the board, the tiers and the other specs' fixtures are untouched.
 *
 * `content-length` / `content-encoding` are dropped from the replayed headers:
 * the body is re-serialized here, so the upstream framing no longer describes it.
 */
async function hideForeignWalnutTasks(page: Page): Promise<void> {
  await page.route('**/api/tasks*', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET' || new URL(request.url()).pathname !== '/api/tasks') {
      await route.fallback()
      return
    }
    const response = await route.fetch()
    let body: { tasks?: Array<{ id?: string; walnut_agent?: boolean; project?: string }> }
    try {
      body = (await response.json()) as typeof body
    } catch {
      await route.fulfill({ response })
      return
    }
    if (!Array.isArray(body.tasks)) {
      await route.fulfill({ response })
      return
    }
    // Mirrors the slot's own predicate (walnut_agent OR the Ask Walnut project):
    // a foreign task admitted by either arm would become a drawer row here.
    const isAsk = (task: { walnut_agent?: boolean; project?: string }) =>
      task.walnut_agent === true || (task.project ?? '').trim().toLowerCase() === 'ask walnut'
    body.tasks = body.tasks.filter(
      (task) => !isAsk(task) || (task.id ? ourWalnutTaskIds.has(task.id) : false),
    )
    const headers = { ...response.headers() }
    delete headers['content-length']
    delete headers['content-encoding']
    await route.fulfill({
      status: response.status(),
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  })
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Let the drawer's 160ms slide/fade (or the panel's fullscreen enter) finish
 *  before a screenshot: an expect passes on the first painted frame, and a shot
 *  taken then shows the overlay half-transparent and a few px off — which reads
 *  as a see-through bug on review when it is only an in-flight frame. */
const settleMotion = (page: Page) => page.waitForTimeout(350)

/** Open the drawer and pick an ask by task id. The drawer closes on pick. */
async function pickAsk(page: Page, taskId: string): Promise<void> {
  await openAskWalnutDrawer(page)
  await drawerRow(page, taskId).click()
  await expect(drawer(page)).toHaveCount(0)
}

/** Open the drawer and click "New chat". */
async function clickNew(page: Page): Promise<void> {
  await openAskWalnutDrawer(page)
  await drawerNew(page).click()
  await expect(drawer(page)).toHaveCount(0)
}

interface SlotLaunch {
  taskId: string
  sessionId: string
  /** Resolves true if the pending state was actually observed (see below). */
  pendingSeen: Promise<boolean>
}

/**
 * Type into the slot's Ask Walnut composer and start.
 *
 * Enter is the start gesture: in walnut mode `DraftSessionPanel` renders NO
 * `.draft-start-btn` (the composer's send arrow is the single send affordance),
 * so Enter is both what a user does and what the panel itself would click.
 *
 * The pending watcher is armed BEFORE the send and awaited by the CALLER at the
 * end of its test: `ask-walnut-pending` can be a single frame wide (the response
 * carries taskId+sessionId), so a hard assertion on it would be a coin flip.
 */
async function launchFromSlot(page: Page, prompt: string): Promise<SlotLaunch> {
  const composer = slotDraftComposer(page)
  await expect(composer).toBeVisible({ timeout: 30_000 })
  // The placeholder is the proof this is the Ask Walnut composer and not a
  // folder draft that happens to be mounted in the slot.
  await expect(composer).toHaveAttribute('placeholder', /Ask Walnut anything/)

  const pendingSeen = slotPending(page)
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true, () => false)

  const quickStart = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start',
  )
  await composer.fill(prompt)
  await composer.press('Enter')

  const response = await quickStart
  expect(response.status(), await response.text()).toBe(200)
  const payload = (await response.json()) as { taskId?: string; sessionId?: string }
  expect(payload.taskId, 'the launch response carried no taskId').toBeTruthy()
  expect(payload.sessionId, 'the launch response carried no sessionId').toBeTruthy()
  ourWalnutTaskIds.add(payload.taskId!)

  // The slot itself becomes the session view, bound to the id the launch minted.
  await expect(slotSession(page)).toHaveAttribute('data-session-id', payload.sessionId!, {
    timeout: 60_000,
  })

  return { taskId: payload.taskId!, sessionId: payload.sessionId!, pendingSeen }
}

/** Note (never fail) a pending state that was too brief to catch. */
async function notePending(pendingSeen: Promise<boolean>, label: string): Promise<void> {
  if (await pendingSeen) return
  test.info().annotations.push({
    type: 'note',
    description: `${label}: ask-walnut-pending was never observed — it may be shorter than one frame, which is not a failure`,
  })
}

// ── Empty state ───────────────────────────────────────────────────────────

test('with no Ask Walnut tasks the slot is the composer, and the drawer lists nothing', async ({ page }) => {
  // The socket is dead-ended for this test ONLY: `task:created` is a global
  // broadcast, so a parallel spec's Ask Walnut launch would be inserted straight
  // into this page's store and grow a row that the HTTP filter never saw. Same
  // reasoning as tests/e2e/browser/notification-bell-badge.spec.ts.
  await page.routeWebSocket('**/ws*', () => {})
  await hideForeignWalnutTasks(page)

  await loadHome(page)

  // The slot lives in the chat spot — asserted once, here, so every other
  // locator in this file can stay flat.
  await expect(page.locator('.main-page-chat [data-testid="ask-walnut-slot"]')).toHaveCount(1)
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })

  await expect(slotDraft(page)).toBeVisible({ timeout: 30_000 })
  await expect(slotDraftComposer(page)).toHaveAttribute('placeholder', /Ask Walnut anything/)
  // The composer is the REGULAR draft panel with the ≡ leading its title row —
  // the one thing the slot adds. No session view yet.
  await expect(slotDraft(page).locator('.session-panel-header-top [data-testid="ask-walnut-menu"]')).toBeVisible()
  await expect(slotSession(page)).toHaveCount(0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-empty-state.png` })

  // Nothing to switch between: the drawer opens, says so, and offers New chat.
  await openAskWalnutDrawer(page)
  await expect(slotMenu(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(drawerRows(page)).toHaveCount(0)
  await expect(drawer(page).getByText('No Ask Walnut sessions yet.')).toBeVisible()
  await expect(drawerNew(page)).toBeVisible()
  // The search box takes the keyboard on open, and none of the removed launchers
  // is there (a regression would bring one back as a titled button).
  await expect(drawerSearch(page)).toBeFocused()
  await expect(drawer(page).getByRole('button', { name: /^(\+ )?(Task|Session|Find sessions|Hide Ask Walnut)$/ })).toHaveCount(0)
  await settleMotion(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1b-empty-drawer.png` })
  // Escape closes it and the composer is back under the keyboard.
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(slotMenu(page)).toHaveAttribute('aria-expanded', 'false')
})

// ── First launch ──────────────────────────────────────────────────────────

test('a launch from the slot streams its reply in the slot, and files an amber task', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })

  const launch = await launchFromSlot(page, FIRST_PROMPT)
  firstTaskId = launch.taskId
  firstSessionId = launch.sessionId

  // The composer is gone: the slot IS the session now, a real SessionPanel with
  // the regular header (tool chips row + title row), the ≡ leading the TITLE
  // row, and the same window controls a column has — ×, popout, fullscreen.
  // Only lock is absent (there is no column rotation to pin within).
  await expect(slotDraft(page)).toHaveCount(0)
  const panel = slotSession(page).locator('.session-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-panel-header-top .session-panel-header-leading [data-testid="ask-walnut-menu"]'))
    .toBeVisible()
  await expect(panel.locator('.session-meta-row-2 .session-panel-header-leading')).toHaveCount(0)
  await expect(panel.locator('.session-meta-row-2').getByRole('button', { name: 'Files' })).toBeVisible()
  await expect(panel.locator('.session-panel-close')).toBeVisible()
  await expect(panel.locator('.session-panel-popout')).toBeVisible()
  await expect(panel.locator('.session-panel-expand')).toBeVisible()
  await expect(panel.getByRole('button', { name: /Lock session panel|Unlock session panel/ })).toHaveCount(0)

  // One conversation → exactly one row in the drawer, and it is the current one.
  await openAskWalnutDrawer(page)
  await expect(drawerRows(page)).toHaveCount(1)
  await expect(drawerRow(page, firstTaskId)).toHaveAttribute('aria-current', 'true')
  // Exactly ONE row is ever current — the claim that makes the switch test below
  // meaningful (two current rows would let both assertions there pass).
  await expect(page.locator('[data-testid="ask-walnut-drawer-item"][aria-current="true"]')).toHaveCount(1)
  await settleMotion(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2b-drawer-one-row.png` })
  // Clicking the scrim (the part of the slot the drawer does not cover) closes it.
  const scrim = page.locator('[data-testid="ask-walnut-scrim"]')
  const scrimBox = (await scrim.boundingBox())!
  await scrim.click({ position: { x: scrimBox.width - 8, y: scrimBox.height / 2 } })
  await expect(drawer(page)).toHaveCount(0)

  // THE ASSERTION THIS TEST EXISTS FOR: a real streamed turn lands INSIDE the
  // slot. The mock CLI echoes the prompt back, so a stray empty panel fails here.
  await expect(slotSession(page).getByText(replyTo(FIRST_PROMPT)).first())
    .toBeVisible({ timeout: 60_000 })

  // Born a task: the board shows it with the Ask Walnut (amber) title class.
  // Scoped by id, not by title — every Ask Walnut task is titled "Ask Walnut"
  // until an auto-title lands, and the fixture never runs that pass. Not scoped
  // to a single row shape either: a focus-pinned task renders as a pinned card
  // (`.todo-pinned-title`) rather than a list row (`.todo-item-title`).
  await expect(page.locator(`.todo-panel [data-task-id="${firstTaskId}"] .walnut-task-title`).first())
    .toBeVisible({ timeout: 30_000 })

  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-first-launch.png` })
  await notePending(launch.pendingSeen, 'first launch')
})

// ── New + second launch ───────────────────────────────────────────────────

test('New chat reopens the composer and a second launch adds a second, current row', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)

  // A fresh browser context has no stored selection, so the slot opens on the
  // newest Ask Walnut task — the one test 2 created.
  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 60_000 })

  await clickNew(page)
  await expect(slotDraft(page)).toBeVisible({ timeout: 20_000 })
  // New composes; it does not throw the existing conversation away — and while
  // composing, no row is current (the composer is not a conversation).
  await openAskWalnutDrawer(page)
  await expect(drawerRow(page, firstTaskId)).toBeVisible()
  await expect(drawerRow(page, firstTaskId)).not.toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)

  const launch = await launchFromSlot(page, SECOND_PROMPT)
  secondTaskId = launch.taskId
  secondSessionId = launch.sessionId
  expect(secondTaskId, 'the second launch reused the first task').not.toBe(firstTaskId)
  expect(secondSessionId, 'the second launch reused the first session').not.toBe(firstSessionId)

  await expect(slotSession(page).getByText(replyTo(SECOND_PROMPT)).first())
    .toBeVisible({ timeout: 60_000 })
  await openAskWalnutDrawer(page)
  await expect(drawerRows(page)).toHaveCount(2)
  await expect(drawerRow(page, secondTaskId)).toHaveAttribute('aria-current', 'true')
  await expect(drawerRow(page, firstTaskId)).not.toHaveAttribute('aria-current', 'true')
  // Newest first: the second ask is the top row.
  await expect(drawerRows(page).first()).toHaveAttribute('data-task-id', secondTaskId)
  await settleMotion(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3b-drawer-two-rows.png` })
  await page.keyboard.press('Escape')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-second-launch.png` })
  await notePending(launch.pendingSeen, 'second launch')
})

// ── Tab switch ────────────────────────────────────────────────────────────

test('picking an ask in the drawer switches the slot to that task\'s session and history', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  // Both directions, and no assumption about which ask the page opened on: which
  // Ask Walnut task is "newest" can flip on any late task write (a session going
  // idle bumps updated_at), so a spec that only picks row 1 could be asserting a
  // switch that never happened.
  await pickAsk(page, secondTaskId)
  await expect(slotSession(page)).toHaveAttribute('data-session-id', secondSessionId, { timeout: 30_000 })
  // The REPLY, not the bare prompt, is the presence needle: it is an assistant
  // event (always in the persisted stream capture this rebuilt timeline reads)
  // and it quotes the prompt back, so it identifies the conversation just as well.
  await expect(slotSession(page).getByText(replyTo(SECOND_PROMPT)).first())
    .toBeVisible({ timeout: 30_000 })

  await pickAsk(page, firstTaskId)
  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 30_000 })
  await openAskWalnutDrawer(page)
  await expect(drawerRow(page, firstTaskId)).toHaveAttribute('aria-current', 'true')
  await expect(drawerRow(page, secondTaskId)).not.toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')

  // The timeline followed the pick: the first conversation's text is there and the
  // second's is nowhere. The absence check uses the BARE prompt, which matches the
  // user bubble too — a slot that keeps the old panel mounted (or renders both)
  // fails here, not above.
  await expect(slotSession(page).getByText(replyTo(FIRST_PROMPT)).first())
    .toBeVisible({ timeout: 30_000 })
  await expect(slotSession(page).getByText(SECOND_PROMPT)).toHaveCount(0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-tab-switch.png` })
})

// ── Persistence across a reload ──────────────────────────────────────────────

test('the selected ask survives a reload', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  // Select the FIRST conversation and then reload: with two asks and the newest
  // as the fallback, only a persisted selection can bring this one back. (The
  // second launch is normally the newest, but a late task write can reorder them,
  // so the test picks explicitly instead of relying on that.)
  await pickAsk(page, secondTaskId)
  await expect(slotSession(page)).toHaveAttribute('data-session-id', secondSessionId, { timeout: 30_000 })
  await pickAsk(page, firstTaskId)
  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 30_000 })
  // The contract's storage key. `toContain`, so a JSON-wrapped value still passes.
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('walnut:ask-slot:selected')), {
      timeout: 10_000,
      message: 'the slot never persisted its selection',
    })
    .toContain(firstTaskId)

  // A reload, NOT navigation: this is the scenario.
  await page.reload()
  await page.waitForLoadState('networkidle')

  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 60_000 })
  await openAskWalnutDrawer(page)
  await expect(drawerRow(page, firstTaskId)).toHaveAttribute('aria-current', 'true')
  await expect(drawerRows(page)).toHaveCount(2)
  await page.keyboard.press('Escape')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/5-selection-after-reload.png` })
})

// ── Fix Walnut ───────────────────────────────────────────────────────────────

test('Fix Walnut still opens a pre-armed draft, and it borrows the chat spot', async ({ page }) => {
  await loadHome(page)

  // The repair target is server-authoritative (Walnut's own checkout), which is
  // also what the pre-armed draft must launch on.
  const config = (await (await page.request.get('/api/config')).json()) as { installDir?: string | null }
  const installDir = config.installDir ?? ''
  expect(installDir, 'the fixture server reports no source checkout, so Fix Walnut cannot arm').toBeTruthy()

  await openAskWalnutDrawer(page)
  await drawerFix(page).click()

  // The draft opens in the session strip and the slot yields the chat spot to it.
  // Scoped through `.main-page-session-column` deliberately: the slot can hold a
  // `.draft-session-panel` of its own (its New state), and it sits EARLIER in the
  // DOM, so an unscoped `.draft-session-panel` first() would grab the wrong one.
  const fixDraft = page.locator('.main-page-session-column .draft-session-panel').first()
  await expect(fixDraft).toBeVisible({ timeout: 20_000 })
  await expectChatSpotYielded(page)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/6-fix-walnut-draft.png` })

  // "Pre-armed" asserted where it is unambiguous: the launch this draft produces
  // carries the repair intent and the checkout dir. Chrome (a folder pill label,
  // an intent chip) can be restyled; this payload is the contract that makes the
  // server wrap the message in its repair briefing.
  const launch = page.waitForRequest(
    (request) => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/sessions/quick-start',
  )
  const report = `slot fix-walnut probe ${STAMP}`
  const composer = fixDraft.locator('.chat-input-textarea')
  await composer.fill(report)
  await composer.press('Enter')
  const payload = (await launch).postDataJSON() as { intent?: string; cwd?: string }
  expect(payload.intent).toBe('fix-walnut')
  expect(payload.cwd).toBe(installDir)
})

/**
 * The REUSE path: Fix Walnut lands on a pristine draft that is already open.
 *
 * `openDraftColumn` has an anti-spam valve — a seeded open re-uses the untouched
 * leftmost draft instead of stacking a second column. That branch used to apply
 * only project/tier/model/binding seeds, so a Fix Walnut click reused the draft and
 * left it a plain "New Session" pointing nowhere: no repair title, no checkout, no
 * `intent` on the launch (and the caller's engine/model reset then hit an ordinary
 * draft). Bringing the chat back through the Focus Dock is what makes the valve
 * reachable here — it cancels the draft's borrow of the chat spot, so the slot (and
 * its Fix Walnut chip) is on screen with the pristine draft still open beside it.
 */
test('Fix Walnut re-arms a pristine draft that is already open', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-focus-dock-visible', 'true')
  })
  await loadHome(page)

  const config = (await (await page.request.get('/api/config')).json()) as { installDir?: string | null }
  const installDir = config.installDir ?? ''
  expect(installDir, 'the fixture server reports no source checkout, so Fix Walnut cannot arm').toBeTruthy()

  // 1. A plain draft from the task toolbar's "New task" (the ONE task-creation
  //    surface) — it borrows the chat spot on the way in.
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
  await openDraft(page)
  const draft = page.locator(DRAFT_PANEL)
  await expect(draft).toHaveCount(1, { timeout: 20_000 })
  await expect(draft.locator('.session-panel-title')).toHaveText('New Session')
  await expectChatSpotYielded(page)

  // 2. Give the chat its spot back by hand (this cancels the borrow), so the slot's
  //    ≡ is clickable while the untouched draft stays open.
  const dockChat = page.locator('.dock-chat-item')
  await expect(dockChat).toBeVisible({ timeout: 20_000 })
  await dockChat.click()
  await expectChatSpotOpen(page)
  await expect(draft).toHaveCount(1)

  // 3. Fix Walnut (from the slot's ≡ drawer). The SAME column is re-armed (still
  //    one draft) and it now reads as the repair draft.
  await openAskWalnutDrawer(page)
  await drawerFix(page).click()
  await expect(draft).toHaveCount(1)
  await expect(draft.locator('.session-panel-title')).toHaveText('\u{1F527} Fix Walnut')

  // 4. And the launch it produces is a real repair launch — the payload is the
  //    contract that makes the server wrap the message in its repair briefing.
  const launch = page.waitForRequest(
    (request) => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/sessions/quick-start',
  )
  const composer = draft.locator('.chat-input-textarea')
  await composer.fill(`slot fix-walnut reuse probe ${STAMP}`)
  await composer.press('Enter')
  const payload = (await launch).postDataJSON() as { intent?: string; cwd?: string }
  expect(payload.intent).toBe('fix-walnut')
  expect(payload.cwd).toBe(installDir)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/9-fix-walnut-reuse.png` })
})

// ── Focus Dock label + toggle ────────────────────────────────────────────────

test('the Focus Dock chat button is titled Ask Walnut and toggles the slot', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-focus-dock-visible', 'true')
  })
  await loadHome(page)

  const dockChat = page.locator('.dock-chat-item')
  await expect(dockChat).toBeVisible({ timeout: 30_000 })
  // The label the slot renamed: "Main Chat" is the thing P1 removed.
  await expect(dockChat).toHaveAttribute('title', 'Ask Walnut')

  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
  await expect(dockChat).toHaveClass(/dock-chat-active/)

  await dockChat.click()
  await expectChatSpotYielded(page)
  await expect(dockChat).not.toHaveClass(/dock-chat-active/)

  await dockChat.click()
  await expectChatSpotOpen(page)
  await expect(dockChat).toHaveClass(/dock-chat-active/)
  await expect(slot(page)).toBeVisible()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/7-dock-toggle.png` })
})

// ── The regular panel behaviours: ×, fullscreen, search ──────────────────────

test('the panel\'s × hides the slot, exactly as a column\'s × closes the column', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-focus-dock-visible', 'true')
  })
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  await slotSession(page).locator('.session-panel-close').click()
  await expectChatSpotYielded(page)
  const dockChat = page.locator('.dock-chat-item')
  await expect(dockChat).not.toHaveClass(/dock-chat-active/)
  // And the dock brings it back, on the same ask.
  await dockChat.click()
  await expectChatSpotOpen(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 30_000 })

  // The composer's × in New mode goes back to the conversation, not away.
  await clickNew(page)
  await expect(slotDraft(page)).toBeVisible({ timeout: 20_000 })
  await slotDraft(page).locator('.session-panel-close').click()
  await expect(slotSession(page)).toBeVisible({ timeout: 20_000 })
  await expectChatSpotOpen(page)
})

test('expand-to-fullscreen takes the whole page, not the slot', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  const slotBox = (await slot(page).boundingBox())!
  const viewport = page.viewportSize()!
  expect(slotBox.width, 'the slot already fills the page; this test needs a narrower slot')
    .toBeLessThan(viewport.width * 0.8)

  await slotSession(page).locator('.session-panel-expand').click()
  const full = page.locator('.open-walnut-fullscreen')
  await expect(full).toBeVisible()
  // THE ASSERTION THIS TEST EXISTS FOR: `contain: paint` on the slot's wrapper
  // once made it the containing block for the panel's position:fixed overlay,
  // so "expand" grew to the slot's own box (user: "it only expands in there").
  // 95vw, capped at 1400px by the panel's own rule — so the bound follows both.
  await expect
    .poll(async () => (await full.boundingBox())?.width ?? 0, { message: 'the fullscreen panel never left the slot' })
    .toBeGreaterThan(Math.min(viewport.width * 0.9, 1380))
  const fullBox = (await full.boundingBox())!
  expect(fullBox.x).toBeLessThan(slotBox.x + 1)
  // The ≡ is hidden in fullscreen (its drawer would land behind the overlay).
  await expect(full.locator('[data-testid="ask-walnut-menu"]')).toHaveCount(0)
  await settleMotion(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/10-fullscreen.png` })

  await page.keyboard.press('Escape')
  await expect(page.locator('.open-walnut-fullscreen')).toHaveCount(0)
  await expect(slotSession(page).locator('[data-testid="ask-walnut-menu"]')).toBeVisible()
})

test('the drawer\'s search filters the asks by title', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  // Both asks carry the placeholder title, so give one a name to search for.
  const needle = `renamed ask ${STAMP}`
  const patch = await page.request.patch(`/api/tasks/${firstTaskId}`, { data: { title: needle } })
  expect(patch.status(), await patch.text()).toBeLessThan(300)

  await openAskWalnutDrawer(page)
  await expect(drawerRow(page, firstTaskId)).toContainText(needle, { timeout: 20_000 })
  await expect(drawerRows(page)).toHaveCount(2)

  // Typing filters: word order and case do not matter.
  await drawerSearch(page).fill(`ASK ${STAMP}`)
  await expect(drawerRows(page)).toHaveCount(1)
  await expect(drawerRows(page).first()).toHaveAttribute('data-task-id', firstTaskId)
  await settleMotion(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/11-drawer-search.png` })

  await drawerSearch(page).fill('no such ask zzz')
  await expect(drawerRows(page)).toHaveCount(0)
  await expect(page.locator('[data-testid="ask-walnut-search-empty"]')).toBeVisible()

  // Escape clears the query first, then closes.
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(1)
  await expect(drawerRows(page)).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)

  // Picking the found row still switches the slot.
  await openAskWalnutDrawer(page)
  await drawerSearch(page).fill(needle)
  await drawerRows(page).first().click()
  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 30_000 })
})

// ── Mobile (390px) ───────────────────────────────────────────────────────────

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the drawer and the session composer stay inside a 390px viewport', async ({ page }) => {
    await hideForeignWalnutTasks(page)
    await loadHome(page)

    // A launch of its own, so the assertion is about a slot the user just used
    // rather than about whatever selection happened to be restored.
    await clickNew(page)
    const launch = await launchFromSlot(page, MOBILE_PROMPT)

    // The drawer fits the phone: inside the viewport, and the current row is
    // reachable in it.
    await openAskWalnutDrawer(page)
    // Polled: the drawer slides in (a 160ms transform), so a single early read
    // sees it a few px left of its resting place.
    await expect
      .poll(async () => (await drawer(page).boundingBox())?.x ?? -999, { message: 'the drawer never settled inside the viewport' })
      .toBeGreaterThanOrEqual(-1)
    const drawerBox = (await drawer(page).boundingBox())!
    expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(390 + 1)
    await expect(drawerRow(page, launch.taskId)).toHaveAttribute('aria-current', 'true')
    await settleMotion(page)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/8b-mobile-drawer.png` })
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    // Reachable, not merely mounted: the composer must be ON the phone screen.
    // A slot laid out for a desktop column typically pushes it off to the right,
    // which is exactly the failure this measures.
    const composer = slotSessionComposer(page)
    await expect(composer).toBeVisible({ timeout: 60_000 })
    const box = await composer.boundingBox()
    expect(box, 'the session composer never rendered a box').not.toBeNull()
    const viewport = page.viewportSize()!
    expect(box!.x, 'the composer starts left of the viewport').toBeGreaterThanOrEqual(-1)
    expect(box!.x + box!.width, 'the composer overflows the viewport width')
      .toBeLessThanOrEqual(viewport.width + 1)
    expect(box!.width, 'the composer collapsed to nothing').toBeGreaterThan(80)
    expect(box!.y, 'the composer sits below the fold').toBeLessThan(viewport.height)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/8-mobile-390.png` })
    await notePending(launch.pendingSeen, 'mobile launch')
  })
})
