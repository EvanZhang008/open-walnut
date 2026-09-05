/**
 * The home page's chat slot IS an Ask Walnut session view (P1 of "remove the
 * main agent").
 *
 * What changed and therefore what this spec pins: the slot no longer renders a
 * hidden lane conversation. It derives its list from the task store
 * (`walnut_agent === true`), renders a REAL `SessionPanel` for the selected
 * task, and its `New` action is the Ask Walnut composer (`DraftSessionPanel` in
 * walnut mode) launching `quick-start { walnutAgent: true }` straight into the
 * slot — no session column is opened for a slot launch. Every conversation is
 * born a task, so the launch is also observable on the board (amber title).
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
 *     "exactly one tab" would therefore race foreign walnut tasks. `hideForeignWalnutTasks`
 *     filters GET /api/tasks down to the tasks THIS FILE created (everything
 *     else passes through untouched), so tab COUNTS are exact without asserting
 *     anything about global state. Each prompt also carries a per-run stamp, so
 *     leftovers from a previous run can never satisfy a text assertion.
 *  2. Background AI is off in the fixture (`WALNUT_DISABLE_BACKGROUND_AI=1`), so
 *     an Ask Walnut task keeps its placeholder title `Ask Walnut`
 *     (ASK_WALNUT_PLACEHOLDER_TITLE) forever. Tabs are therefore addressed by
 *     `data-task-id`, never by their label — label text can't tell two tabs apart.
 *
 * Runs on chromium AND webkit (the Mac app is a WKWebView), so nothing here uses
 * a chromium-only API: plain locators, `boundingBox()`, `route`/`routeWebSocket`.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DRAFT_PANEL, loadHome } from './draft-helpers'

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
const slotTabs = (page: Page): Locator => page.locator('[data-testid="ask-walnut-tab"]')
const slotTab = (page: Page, taskId: string): Locator =>
  page.locator(`[data-testid="ask-walnut-tab"][data-task-id="${taskId}"]`)
const slotNew = (page: Page): Locator => page.locator('[data-testid="ask-walnut-new"]')
const slotFix = (page: Page): Locator => page.locator('[data-testid="ask-walnut-fix"]')
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
    let body: { tasks?: Array<{ id?: string; walnut_agent?: boolean }> }
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
    body.tasks = body.tasks.filter(
      (task) => task?.walnut_agent !== true || (task.id ? ourWalnutTaskIds.has(task.id) : false),
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

test('with no Ask Walnut tasks the slot is the composer, and there are no tabs', async ({ page }) => {
  // The socket is dead-ended for this test ONLY: `task:created` is a global
  // broadcast, so a parallel spec's Ask Walnut launch would be inserted straight
  // into this page's store and grow a tab that the HTTP filter never saw. Same
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
  // Nothing to switch between: no tab, and no session view.
  await expect(slotTabs(page)).toHaveCount(0)
  await expect(slotSession(page)).toHaveCount(0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-empty-state.png` })
})

// ── First launch ──────────────────────────────────────────────────────────

test('a launch from the slot streams its reply in the slot, and files an amber task', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })

  const launch = await launchFromSlot(page, FIRST_PROMPT)
  firstTaskId = launch.taskId
  firstSessionId = launch.sessionId

  // One conversation → exactly one tab, and it is the selected one.
  await expect(slotTabs(page)).toHaveCount(1)
  await expect(slotTab(page, firstTaskId)).toHaveAttribute('aria-selected', 'true')
  // Exactly ONE tab is ever selected — the claim that makes the switch test below
  // meaningful (two selected tabs would let both assertions there pass).
  await expect(page.locator('[data-testid="ask-walnut-tab"][aria-selected="true"]')).toHaveCount(1)

  // The composer is gone: the slot IS the session now, a real SessionPanel.
  await expect(slotDraft(page)).toHaveCount(0)
  await expect(slotSession(page).locator('.session-panel')).toBeVisible()

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

test('New reopens the composer and a second launch adds a second, selected tab', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)

  // A fresh browser context has no stored selection, so the slot opens on the
  // newest Ask Walnut task — the one test 2 created.
  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 60_000 })

  await slotNew(page).click()
  await expect(slotDraft(page)).toBeVisible({ timeout: 20_000 })
  // New composes; it does not throw the existing conversation away.
  await expect(slotTab(page, firstTaskId)).toBeVisible()

  const launch = await launchFromSlot(page, SECOND_PROMPT)
  secondTaskId = launch.taskId
  secondSessionId = launch.sessionId
  expect(secondTaskId, 'the second launch reused the first task').not.toBe(firstTaskId)
  expect(secondSessionId, 'the second launch reused the first session').not.toBe(firstSessionId)

  await expect(slotTabs(page)).toHaveCount(2)
  await expect(slotTab(page, secondTaskId)).toHaveAttribute('aria-selected', 'true')
  await expect(slotTab(page, firstTaskId)).not.toHaveAttribute('aria-selected', 'true')
  await expect(slotSession(page).getByText(replyTo(SECOND_PROMPT)).first())
    .toBeVisible({ timeout: 60_000 })

  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-second-launch.png` })
  await notePending(launch.pendingSeen, 'second launch')
})

// ── Tab switch ────────────────────────────────────────────────────────────

test('clicking a tab switches the slot to that task\'s session and history', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  // Both directions, and no assumption about which tab the page opened on: which
  // Ask Walnut task is "newest" can flip on any late task write (a session going
  // idle bumps updated_at), so a spec that only clicks tab 1 could be asserting a
  // switch that never happened.
  await slotTab(page, secondTaskId).click()
  await expect(slotTab(page, secondTaskId)).toHaveAttribute('aria-selected', 'true')
  await expect(slotSession(page)).toHaveAttribute('data-session-id', secondSessionId, { timeout: 30_000 })
  // The REPLY, not the bare prompt, is the presence needle: it is an assistant
  // event (always in the persisted stream capture this rebuilt timeline reads)
  // and it quotes the prompt back, so it identifies the conversation just as well.
  await expect(slotSession(page).getByText(replyTo(SECOND_PROMPT)).first())
    .toBeVisible({ timeout: 30_000 })

  await slotTab(page, firstTaskId).click()

  await expect(slotTab(page, firstTaskId)).toHaveAttribute('aria-selected', 'true')
  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 30_000 })

  // The timeline followed the tab: the first conversation's text is there and the
  // second's is nowhere. The absence check uses the BARE prompt, which matches the
  // user bubble too — a slot that keeps the old panel mounted (or renders both)
  // fails here, not above.
  await expect(slotSession(page).getByText(replyTo(FIRST_PROMPT)).first())
    .toBeVisible({ timeout: 30_000 })
  await expect(slotSession(page).getByText(SECOND_PROMPT)).toHaveCount(0)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-tab-switch.png` })
})

// ── Persistence across a reload ──────────────────────────────────────────────

test('the selected tab survives a reload', async ({ page }) => {
  await hideForeignWalnutTasks(page)
  await loadHome(page)
  await expect(slotSession(page)).toBeVisible({ timeout: 60_000 })

  // Select the FIRST conversation and then reload: with two tabs and the newest
  // as the fallback, only a persisted selection can bring this one back. (The
  // second launch is normally the newest, but a late task write can reorder them,
  // so the test picks explicitly instead of relying on that.)
  await slotTab(page, secondTaskId).click()
  await expect(slotSession(page)).toHaveAttribute('data-session-id', secondSessionId, { timeout: 30_000 })
  await slotTab(page, firstTaskId).click()
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

  await expect(slotTab(page, firstTaskId)).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 })
  await expect(slotSession(page)).toHaveAttribute('data-session-id', firstSessionId, { timeout: 60_000 })
  await expect(slotTabs(page)).toHaveCount(2)

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

  await expect(slotFix(page)).toBeVisible({ timeout: 30_000 })
  await slotFix(page).click()

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

  // 1. A plain "+ Session" draft — it borrows the chat spot on the way in.
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
  await page.getByTitle('Open a new coding session draft').click()
  const draft = page.locator(DRAFT_PANEL)
  await expect(draft).toHaveCount(1, { timeout: 20_000 })
  await expect(draft.locator('.session-panel-title')).toHaveText('New Session')
  await expectChatSpotYielded(page)

  // 2. Give the chat its spot back by hand (this cancels the borrow), so the slot
  //    header is clickable while the untouched draft stays open.
  const dockChat = page.locator('.dock-chat-item')
  await expect(dockChat).toBeVisible({ timeout: 20_000 })
  await dockChat.click()
  await expectChatSpotOpen(page)
  await expect(draft).toHaveCount(1)

  // 3. Fix Walnut. The SAME column is re-armed (still one draft) and it now reads
  //    as the repair draft.
  await expect(slotFix(page)).toBeVisible({ timeout: 20_000 })
  await slotFix(page).click()
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

// ── "+ Task" popover in a SHORT window ───────────────────────────────────────

test.describe('in a 600px-tall window', () => {
  test.use({ viewport: { width: 1100, height: 600 } })

  /**
   * The task composer is a MENU, so it obeys the menu rules (web/src/AGENTS.md):
   * portalled out of its clipping ancestor and placed by `useMenuPlacement`.
   *
   * It used to be a hand-placed `position: absolute; top: 100%` box inside the
   * slot header — and the slot is `overflow: hidden`, so in a short window the
   * form was CLIPPED at the slot's bottom edge with its Create row unreachable
   * (no scrollbar, no wheel target). 600px tall is where that showed.
   */
  test('the "+ Task" popover is placed, scrollable, and keeps its Create row on screen', async ({ page }) => {
    await loadHome(page)
    await expect(slot(page)).toBeVisible({ timeout: 30_000 })

    await page.getByTitle('Create a task without starting a session').click()
    const popover = page.locator('.ask-walnut-task-popover')
    await expect(popover).toBeVisible({ timeout: 20_000 })

    // Portalled: NOT a descendant of the overflow:hidden slot, and fixed-positioned.
    expect(await popover.evaluate((el) => !!el.closest('.ask-walnut-slot')),
      'the popover is still inside the clipping slot').toBe(false)
    expect(await popover.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
    // Capped and scrollable — the two halves of the useMenuPlacement contract.
    expect(await popover.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')

    const viewport = page.viewportSize()!
    const box = (await popover.boundingBox())!
    expect(box, 'the popover never rendered a box').not.toBeNull()
    expect(box.y, 'the popover starts above the viewport').toBeGreaterThanOrEqual(-1)
    expect(box.y + box.height, 'the popover overflows the bottom of the viewport')
      .toBeLessThanOrEqual(viewport.height + 1)

    // THE ASSERTION THIS TEST EXISTS FOR: the form's Create row is reachable.
    const create = popover.locator('.qtc-confirm-primary')
    await create.scrollIntoViewIfNeeded()
    const createBox = (await create.boundingBox())!
    expect(createBox, 'the Create button never rendered a box').not.toBeNull()
    expect(createBox.y, 'Create sits above the viewport').toBeGreaterThanOrEqual(-1)
    expect(createBox.y + createBox.height, 'Create sits below the fold')
      .toBeLessThanOrEqual(viewport.height + 1)
    await expect(create).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/10-task-popover-600px.png` })
  })
})

// ── Mobile (390px) ───────────────────────────────────────────────────────────

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the tab strip and the session composer stay inside a 390px viewport', async ({ page }) => {
    await hideForeignWalnutTasks(page)
    await loadHome(page)

    // A launch of its own, so the assertion is about a slot the user just used
    // rather than about whatever selection happened to be restored.
    await slotNew(page).click()
    const launch = await launchFromSlot(page, MOBILE_PROMPT)

    const tabs = page.locator('[data-testid="ask-walnut-tabs"]')
    await expect(tabs).toBeVisible()
    await expect(slotTab(page, launch.taskId)).toHaveAttribute('aria-selected', 'true')

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
