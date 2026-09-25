/**
 * The draft composer's background AI parse is OPT-IN (`agent.quick_parse`, default
 * OFF) — asserted as ZERO `/api/tasks/quick-parse` requests through the real UI.
 *
 * Why this spec exists (2026-09-17, measured on the user's own client): typing one
 * sentence into the draft composer fired the parse on TWO schedules at once — an
 * EAGER call every 900ms while the keys were still moving, plus a TRAILING call
 * 350ms after each pause — and neither cancelled the previous one. On a
 * `claude_cli` fast_model every call spawns a whole `claude -p` process, so all 144
 * of them blew the route's 10s abort and returned nothing. Each is a POST, and
 * web/src/api/client.ts prioritises non-GETs, so those ten-second no-ops took all
 * SIX of the browser's connection slots: 65 calls in 135s, max concurrency exactly
 * 6, and `[api] fetch queue backing up` four times. The visible symptom was not
 * "suggestions are wrong" — it was the folder picker's own GETs
 * (`/api/sessions/working-dirs`, `/api/sessions/list-dirs`) starving behind them.
 *
 * So the claim under test is a NETWORK claim, not a rendering one, and the four
 * scenarios are the four ways the old code reached the wire:
 *   1. typing (both schedules — bursts separated by pauses long enough that the
 *      eager throttle AND the trailing debounce would each have fired);
 *   2. MOUNTING with text nobody just typed (the old comment claimed "text can only
 *      appear by typing"; the composer RESTORES a persisted draft, so a panel
 *      re-opening on left-over text fired it with zero keystrokes — "I didn't type");
 *   3. the picker, which is what the starvation actually broke: it must open and
 *      populate on its own, not behind ten-second POSTs;
 *   4. an EMPTY composer, which must cost nothing at all — not even the gate's own
 *      `/api/config` read (the gate is checked AFTER the empty check for exactly
 *      this reason).
 *
 * No WebKit pin, deliberately: every assertion here is about which HTTP requests
 * leave the page, which no engine difference can change. A pin would have to live at
 * this file's top level (the config's `projects`), and the file needs none — it was
 * run green under `PW_WEBKIT=1 … --project webkit` as well (5/5, 2026-09-17), which
 * is what the Mac app's WKWebView actually executes.
 *
 * Siblings: tests/e2e/browser/draft-quick-chips.spec.ts (the launch bar's chips),
 * tests/e2e/browser/quick-session-path-load.spec.ts (the picker's own health).
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  captureDraftRequests, discoverFixtureRoot, draftComposer, draftCwdPill, draftDecisionChip,
  draftDecisionChips, draftMoreButton, draftQuickChips, draftQuickKey, DRAFT_PANEL, isoDay, loadHome,
  mockQuickParse, nthRequest, openDraft, openDraftOnCwd, openDraftSettings, watchForbiddenRequests,
} from './draft-helpers'

/** Evidence lives outside test-results/ — concurrent Playwright runs wipe that dir. */
const SHOT_DIR = process.env.QUICK_PARSE_SHOT_DIR ?? '/tmp/quickparse-off'

/** Both edges of the same route: the console's `/api/tasks/quick-parse` and the
 *  frozen iOS contract's `/api/v1/tasks/quick-parse`. Either one leaving this page
 *  is the regression, so neither is spelled out twice. */
const QUICK_PARSE = /\/api\/(?:v1\/)?tasks\/quick-parse/

/**
 * A realistic first sentence, typed in three bursts.
 *
 * Length matters twice: over PARSE_MIN_CHARS (12) so the old EAGER path was allowed
 * to fire at all, and over 30 so it reads like something a person would actually
 * write. No `/` or `@`: those open the slash-command palette / the mention
 * autocomplete, which would make the typing assertion about a different feature.
 */
const BURSTS = [
  'Rewrite the daemon reconnect ',
  'handler so a dropped tunnel ',
  'keeps the session alive before Friday',
] as const
const SENTENCE = BURSTS.join('')

/**
 * Pause AFTER each burst, ms. Both must exceed PARSE_DEBOUNCE_MS (350) so the
 * TRAILING schedule would have fired in every gap, and the total typing time must
 * exceed PARSE_THROTTLE_MS (900) so the EAGER schedule would have fired more than
 * once. Deliberately not "one long pause at the end": a single gap would only prove
 * the trailing half is gated.
 */
const BURST_PAUSES = [1_200, 600] as const

/** How long to keep watching after the last interaction. Longer than the trailing
 *  debounce (350ms) and the eager throttle window (900ms) combined, so "zero
 *  requests" means the schedules never fired rather than "we looked too early". */
const SETTLE_MS = 2_000

/** Every quick-parse request that STARTS after this call, as `METHOD url`.
 *  Arm before the interaction: a response to an already in-flight request never
 *  re-fires 'request', so the window is exactly the interaction under test. */
function watchQuickParse(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => {
    if (QUICK_PARSE.test(req.url())) seen.push(`${req.method()} ${req.url()}`)
  })
  return seen
}

/** The gate's own config read (`loadQuickParseEnabled` → `/api/config`), matched by
 *  exact pathname so the unrelated sub-routes (`/api/config/providers`, …) don't
 *  count.
 *
 *  One other caller shares that exact path: the stale-build watcher
 *  (web/src/utils/stale-assets.ts) polls it every 10 MINUTES and on WS reconnect. It
 *  is indistinguishable by URL, so if this ever flakes on a lone `/api/config`,
 *  suspect a reconnect during the window rather than the gate — the window here is a
 *  few seconds on a page that has just loaded, where the 10-minute timer cannot
 *  have armed. */
function watchConfigReads(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/config') seen.push(`${req.method()} ${req.url()}`)
  })
  return seen
}

/** Type `SENTENCE` the way a person does: bursts, with a real pause between them. */
async function typeInBursts(page: Page): Promise<void> {
  const composer = draftComposer(page)
  await composer.click()
  for (let i = 0; i < BURSTS.length; i++) {
    // pressSequentially, not fill(): `fill` sets the value in ONE event, which the
    // eager schedule (a per-keystroke effect) would never have seen. The reported
    // burst only exists because each character re-ran the effect.
    await composer.pressSequentially(BURSTS[i], { delay: 25 })
    const pause = BURST_PAUSES[i]
    if (pause) await page.waitForTimeout(pause)
  }
}

// Real page loads + real typing with deliberate pauses, on a fixture whose seeded
// dataset makes cold boot slow — the same budget the sibling draft specs use.
test.setTimeout(180_000)

// Serial: all four drive the shared fixture's draft strip, and scenario 2 installs a
// route override. Keeping them ordered also keeps this file from adding four
// browsers' worth of load to a machine-wide-serialized Playwright gate.
test.describe.configure({ mode: 'serial' })

/** Whether the server currently has the flag on. */
async function readQuickParse(page: Page): Promise<boolean> {
  const res = await page.request.get('/api/config')
  expect(res.ok(), await res.text()).toBe(true)
  const body = (await res.json()) as { config?: { agent?: { quick_parse?: boolean } } }
  return body.config?.agent?.quick_parse ?? false
}

/**
 * Write `agent.quick_parse`, KEEPING every sibling key.
 *
 * `PUT /api/config` replaces a whole top-level key, so sending `{ agent: { quick_parse } }`
 * on its own deletes the fixture's model, language and catalog — the same trap the
 * product's toggle has to avoid (tests/web/quick-parse-toggle.test.ts pins it there).
 * Asserted rather than best-effort: a restore that silently no-ops leaves the fixture
 * flipped, and every "zero requests" assertion in this file would then be inverted.
 */
async function writeQuickParse(page: Page, on: boolean): Promise<void> {
  const read = await page.request.get('/api/config')
  expect(read.ok(), await read.text()).toBe(true)
  const { config } = (await read.json()) as { config: { agent?: Record<string, unknown> } }
  const res = await page.request.put('/api/config', {
    data: { agent: { ...config.agent, quick_parse: on } },
  })
  expect(res.ok(), await res.text()).toBe(true)
}

/**
 * Put the flag back OFF between scenarios.
 *
 * In a hook, not in the scenario's own `finally`: an assertion that fails in a hook is
 * reported ALONGSIDE the test's failure, while one in a finally block replaces it —
 * and a restore failing is exactly the moment the real error matters most.
 */
test.afterEach(async ({ page }) => {
  if (await readQuickParse(page)) await writeQuickParse(page, false)
})

/**
 * The precondition every scenario below depends on. Without it the whole file is
 * vacuous: if the fixture ever ships `agent.quick_parse: true`, "zero requests"
 * would be asserting the opposite of the product's contract.
 */
test('the fixture leaves agent.quick_parse OFF — the default this file asserts', async ({ page }) => {
  await loadHome(page)
  expect(await readQuickParse(page),
    'default OFF — flip this fixture and every assertion below inverts').toBe(false)
})

// ── 1. Typing fires nothing ──────────────────────────────────────────────────

test('typing a whole sentence into the draft composer fires zero quick-parse requests', async ({ page }) => {
  // The reported interaction, verbatim: open a draft, write the first sentence of a
  // briefing. In the old code this alone put several ten-second POSTs in the air.
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)

  // Armed BEFORE the "+" so the observation window covers the draft's whole life —
  // mount included, not just the keystrokes.
  const parses = watchQuickParse(page)
  const panel = await openDraft(page)
  await typeInBursts(page)
  await page.waitForTimeout(SETTLE_MS)

  expect(parses, 'agent.quick_parse is off, so typing must never reach the route').toEqual([])

  // The gate must not eat the input: a "fix" that swallowed keystrokes would also
  // show zero requests, so the text is half of this assertion.
  await expect(draftComposer(page)).toHaveValue(SENTENCE)
  expect(SENTENCE.length, 'a realistic sentence, not a 3-char probe').toBeGreaterThan(30)
  // X1: no decision was made for the user, so no chip and no ✦; the pills row is
  // folder, project, More.
  await expect(panel.locator('.draft-decision-chip, .draft-ai-badge, .draft-decisions-key')).toHaveCount(0)
  await expect(draftMoreButton(panel)).toBeVisible()

  await panel.screenshot({ path: `${SHOT_DIR}/01-typed-no-parse.png` })
})

// ── 2. Mounting on a RESTORED draft fires nothing ────────────────────────────

test('a draft panel that re-mounts on restored text fires zero quick-parse requests', async ({ page }) => {
  // The case the old code got wrong. Its comment argued the effect was safe because
  // "text can only appear by typing" — but ChatInput reads its persisted draft in a
  // useState initializer, so a panel MOUNTING on left-over text ran the effect with
  // no keystroke at all. That is the "I didn't type and it was still calling" report.
  //
  // The product's one genuine remount-with-text path is the "Create task for later"
  // failure recovery (MainPage: the optimistic close is undone by re-writing
  // `draft:new-session:<id>` and re-adding the column, precisely so ChatInput's
  // mount-time read restores the user's writing). Reached here by failing the CREATE
  // — a 400, so useTasks' withRetry does not retry it — and nothing about the parse
  // schedule is stubbed: the effect under test runs exactly as it ships.
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)

  const panel = await openDraft(page)
  const draftId = await panel.getAttribute('data-draft-id')
  expect(draftId, 'the draft column carries its id').toBeTruthy()
  await typeInBursts(page)

  // ChatInput persists on a debounce; the key is what the restore reads back, so
  // wait for the real thing rather than a fixed sleep.
  const key = `draft:new-session:${draftId}`
  await expect.poll(
    () => page.evaluate((k) => localStorage.getItem(k), key),
    { timeout: 10_000, message: 'the composer never persisted its draft' },
  ).toBe(SENTENCE)

  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"forced by draft-quick-parse-off spec"}' })
  })

  // Mark the node that is about to be thrown away, imperatively — React never
  // re-applies an attribute it doesn't own, so a panel WITHOUT this marker is
  // provably a different DOM node, i.e. a real unmount + re-mount. Element identity
  // is the only thing that separates "the text was restored on MOUNT" (the case
  // under test) from "the panel never went away and still had the text" (which
  // would make the zero below trivially true).
  //
  // A marker rather than an `isConnected` check on a handle: the session strip is
  // wrapped in auto-animate, whose FLIP leave-animation keeps the OUTGOING element
  // attached for one more paint after React has dropped it, so `isConnected` reads
  // true for a node React already unmounted.
  await panel.evaluate((el) => el.setAttribute('data-pw-doomed', '1'))

  // Armed before the click: the window has to include the unmount, the failed POST
  // and the re-mount.
  const parses = watchQuickParse(page)
  await panel.locator('.draft-later-btn').click()

  // The optimistic close really happened: the marked node left the DOM (polled, so
  // the FLIP ghost is allowed its one paint).
  await expect(page.locator(`${DRAFT_PANEL}[data-pw-doomed]`),
    'the optimistic close must actually unmount the column').toHaveCount(0, { timeout: 30_000 })

  // …and the recovery put a FRESH panel back, holding the text it read at MOUNT
  // time (no keystroke has happened since the click).
  const restored = page.locator(`${DRAFT_PANEL}:not([data-pw-doomed])`)
  await expect(restored).toBeVisible({ timeout: 30_000 })
  await expect(restored.locator('.chat-input-textarea')).toHaveValue(SENTENCE, { timeout: 30_000 })
  await page.waitForTimeout(SETTLE_MS)

  expect(parses, 'a restored draft must not parse itself on mount').toEqual([])
  await page.unroute('**/api/tasks')

  await restored.screenshot({ path: `${SHOT_DIR}/02-restored-draft-no-parse.png` })
})

// ── 3. The picker opens and populates on its own ─────────────────────────────

test('the folder picker opens and populates, and the Quick folders row renders', async ({ page }) => {
  // The starvation's actual victim. `/api/sessions/working-dirs` and
  // `/api/sessions/list-dirs` are GETs, and client.ts puts non-GETs first, so six
  // ten-second parse POSTs held every connection slot and the picker sat on
  // "Loading paths..." until they timed out. This scenario asserts the picker
  // RENDERS and reports how long it took as evidence — no tight budget, because the
  // Mac is shared and this fixture carries a seeded 500-session dataset.
  await page.setViewportSize({ width: 1280, height: 900 })
  // The chips render from the working-dirs MODULE CACHE, read synchronously at open
  // time — nothing re-renders the panel when a later fetch lands, so the cache must
  // be warm before the "+" (same wait as draft-quick-chips.spec.ts).
  const warm = page.waitForResponse(
    (res) => res.url().includes('/api/sessions/working-dirs') && res.ok(),
    { timeout: 60_000 },
  )
  await loadHome(page)
  await warm

  const parses = watchQuickParse(page)
  const openedAt = Date.now()
  const panel = await openDraft(page)

  // The Quick folders row: its caption plus at least one chip. This is the draft
  // column's own row (it is what makes a folder one click away), so it must be
  // there before the picker is even needed.
  await expect(draftQuickKey(panel)).toHaveText('Quick folders', { timeout: 30_000 })
  await expect(draftQuickChips(panel).first()).toBeVisible({ timeout: 30_000 })
  const chipsMs = Date.now() - openedAt
  const chipCount = await draftQuickChips(panel).count()

  // …and now the picker itself, through the cwd pill (the route every draft spec
  // takes — see pickDraftFolder in ./draft-helpers).
  const pickerAt = Date.now()
  await draftCwdPill(panel).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 30_000 })
  const list = picker.locator('.sps-path-list')
  await expect(list).toBeVisible({ timeout: 30_000 })
  await expect(picker.locator('.sps-path-item').first()).toBeVisible({ timeout: 60_000 })
  const pickerMs = Date.now() - pickerAt

  // The incident's visible symptom must not render: a stale error beside a live
  // loading state (see quick-session-path-load.spec.ts, the 2026-07-19 repro).
  await expect(list.locator('.sps-empty', { hasText: 'Loading paths...' })).toHaveCount(0)
  await expect(list.locator('.sps-error')).toHaveCount(0)

  // Opening the picker is still not a reason to parse anything.
  expect(parses, 'opening the picker must not reach the parse route').toEqual([])

  const evidence = `Quick folders row: ${chipsMs}ms (${chipCount} chips) · picker populated: ${pickerMs}ms`
  test.info().annotations.push({ type: 'picker-timing', description: evidence })
  // Printed, not asserted: the number is evidence about a shared machine, and a
  // tight threshold here would fail on load rather than on the product.
  console.log(`[draft-quick-parse-off] ${evidence}`)

  await picker.screenshot({ path: `${SHOT_DIR}/03-picker-populated.png` })
})

// ── 4. An empty draft costs nothing, not even the gate's own config read ─────

test('opening a draft with an empty composer fires no quick-parse and no config read', async ({ page }) => {
  // The draft-open path is contractually network-free, and the GATE must not be the
  // thing that breaks that. Two design choices keep it that way, and both are easy to
  // undo by accident: `useQuickParseEnabled()` only SUBSCRIBES (a composer that mounts
  // fetches nothing — the obvious shape, a load in the hook's effect, would put one
  // `/api/config` on every opened column), and `ensureQuickParseLoaded()` is called
  // only where the answer is needed: after the empty-text check in the parse effect,
  // and when the "+" menu that draws the switch opens. Neither happens here.
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  // networkidle inside loadHome already settled the page's own loads; anything
  // observed from here belongs to the "+".
  await page.waitForLoadState('networkidle')

  const parses = watchQuickParse(page)
  const configReads = watchConfigReads(page)
  // The repo's existing zero-network guard for this path (quick-start / task create /
  // working-dirs / list-dirs) — free to assert here, and it is the other half of
  // "opening a draft costs nothing".
  const forbidden = watchForbiddenRequests(page)

  const panel = await openDraft(page)
  await page.waitForTimeout(SETTLE_MS)

  await expect(draftComposer(page)).toHaveValue('')
  expect(parses, 'an empty composer has nothing to parse').toEqual([])
  expect(configReads, 'the gate must be read AFTER the empty check, never before it').toEqual([])
  expect(forbidden, 'the draft-open path stays network-free').toEqual([])

  await panel.screenshot({ path: `${SHOT_DIR}/04-empty-draft-no-network.png` })
})

// ── 5. The "+" menu offers the switch, and drawing it changes no geometry ─────

/** The composer's "+" menu, and the one toggle row in it. */
const plusMenu = (panel: Locator) => panel.locator('.chat-plus-menu')
const quickParseRow = (panel: Locator) => panel.locator('.chat-plus-menu-toggle[data-toggle-id="quick-parse"]')

/** Open the draft's "+" menu and return [menu, the toggle row]. */
async function openPlusMenu(panel: Locator): Promise<[Locator, Locator]> {
  await panel.locator('.chat-plus-btn').click()
  const menu = plusMenu(panel)
  await expect(menu).toBeVisible({ timeout: 15_000 })
  return [menu, quickParseRow(panel)]
}

test('the "+" menu carries an OFF switch for the parse, one line tall, and toggling it does not resize the menu', async ({ page }) => {
  // The switch is how this feature comes back for someone who wants it, so its own
  // state has to be honest: default OFF, which is `aria-checked=false` on a
  // `menuitemcheckbox` (a native checkbox is banned inside these menus — its macOS
  // popup swallows pointerup; see web/src/AGENTS.md → Menus & overlays).
  //
  // The geometry half is the menu rule those same notes encode: a menu must not grow
  // because the user interacted with it. Measured rather than eyeballed — the label
  // wrapping to a second line is invisible in a screenshot at a glance but changes the
  // row height, and the first draft of this row did exactly that.
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  const panel = await openDraft(page)

  const [menu, row] = await openPlusMenu(panel)
  await expect(row, 'default OFF').toHaveAttribute('aria-checked', 'false')
  await expect(row).toHaveText(/Auto-fill/)

  // One line: the label's own box, compared with the line height it renders at.
  const label = row.locator('span:not(.chat-plus-menu-switch)')
  const lines = await label.evaluate((el) => {
    const cs = getComputedStyle(el)
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
    return { h: el.getBoundingClientRect().height, lh }
  })
  expect(lines.h, `label ${lines.h}px vs line-height ${lines.lh}px — wrapped to 2 lines`)
    .toBeLessThan(lines.lh * 1.6)

  // Same height as an ordinary row, so the switch reads as part of the same menu.
  const plainRow = menu.locator('.chat-plus-menu-item:not(.chat-plus-menu-toggle)').first()
  const [rowBox, plainBox, before] = await Promise.all([
    row.boundingBox(), plainRow.boundingBox(), menu.boundingBox(),
  ])
  expect(Math.abs(rowBox!.height - plainBox!.height),
    `toggle ${rowBox!.height}px vs plain ${plainBox!.height}px`).toBeLessThan(1.5)

  await row.click()
  // Still open (a setting, not a command) and exactly the same size.
  await expect(menu).toBeVisible()
  await expect(row).toHaveAttribute('aria-checked', 'true')
  const after = await menu.boundingBox()
  expect(after!.width, `menu ${before!.width}→${after!.width}px`).toBeCloseTo(before!.width, 0)
  expect(after!.height, `menu ${before!.height}→${after!.height}px`).toBeCloseTo(before!.height, 0)

  await menu.screenshot({ path: `${SHOT_DIR}/05-plus-menu-toggle.png` })
  // afterEach puts the flag back — the scenarios above assert the default, and other
  // spec files share this server.
})

// ── 6. The switch is real: on → the parse runs, off → it stops ───────────────

test('turning the switch ON makes typing parse, and turning it OFF stops it again', async ({ page }) => {
  // Without this, everything above is satisfied by a feature that no longer works at
  // all — "zero requests" is also what a deleted feature looks like. Deliberately
  // LAST in a serial file: it is the only scenario that writes config, so the default
  // the others depend on is still untouched when they run.
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  const panel = await openDraft(page)

  // The agent keys the fixture has BEFORE the click — compared after, so this holds
  // whatever the fixture ships rather than naming a key that might not be there.
  const agentKeysBefore = await page.request.get('/api/config')
    .then(async (r) => Object.keys(((await r.json()) as { config?: { agent?: object } }).config?.agent ?? {}))
  expect(agentKeysBefore.length, 'the fixture must have an agent block for this to prove anything')
    .toBeGreaterThan(0)

  const [, row] = await openPlusMenu(panel)
  await row.click()
  await expect(row).toHaveAttribute('aria-checked', 'true')
  // The write landed server-side, not just in the optimistic echo…
  await expect.poll(() => readQuickParse(page),
    { timeout: 15_000, message: 'the toggle never persisted' }).toBe(true)
  // …and it did not eat the rest of the agent block on the way (the one-click data
  // loss the read-then-spread exists to prevent).
  const afterWrite = await page.request.get('/api/config')
  const cfg = (await afterWrite.json()) as { config?: { agent?: Record<string, unknown> } }
  const agentKeysAfter = Object.keys(cfg.config?.agent ?? {})
  for (const key of agentKeysBefore) {
    expect(agentKeysAfter, `turning the switch on deleted agent.${key}`).toContain(key)
  }
  await page.keyboard.press('Escape')

  const parses = watchQuickParse(page)
  await typeInBursts(page)
  // Only that it REACHED the route: whether a parse comes back depends on the
  // fixture's model, which this file is not about.
  await expect.poll(() => parses.length,
    { timeout: 15_000, message: 'the switch is on but typing never parsed' }).toBeGreaterThan(0)

  // …and off again, with the same sentence still in the composer.
  const [, row2] = await openPlusMenu(panel)
  await row2.click()
  await expect(row2).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')

  parses.length = 0
  await draftComposer(page).pressSequentially(' and land it', { delay: 25 })
  await page.waitForTimeout(SETTLE_MS)
  expect(parses, 'switched off mid-sentence, so nothing more may leave').toEqual([])
})

test('turning the switch OFF mid-draft drops the AI chips at once, keeps a More-set chip, and Start sends no AI value', async ({ page }) => {
  // Also LAST-group: it writes config through the real switch (afterEach restores).
  // The parse is mocked so the ON half has chips to take away.
  await page.setViewportSize({ width: 1280, height: 900 })
  const parse = await mockQuickParse(page, { pinTier: 'satellite', due_date: isoDay(3) })
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  await loadHome(page)
  const panel = await openDraftOnCwd(page, `${await discoverFixtureRoot()}/projects/walnut`)

  // OFF (the default): More still works, and its value is a chip without ✦.
  const menu = await openDraftSettings(panel, 'more')
  await menu.getByRole('button', { name: /Start unread/ }).click()
  await expect(draftDecisionChip(panel, 'unread')).toHaveText(/Starts unread/)
  await page.keyboard.press('Escape')
  await draftComposer(page).fill('pair on the marina release notes by friday')
  await page.waitForTimeout(900)
  expect(parse.calls, 'off: nothing parsed').toHaveLength(0)
  await expect(panel.locator('.draft-ai-badge')).toHaveCount(0)

  // ON: the sentence already in the composer is parsed right away.
  const [, on] = await openPlusMenu(panel)
  await on.click()
  await expect(on).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Satellite/, { timeout: 15_000 })
  await expect(draftDecisionChip(panel, 'dueDate').locator('.draft-ai-badge')).toHaveCount(1)
  await panel.screenshot({ path: `${SHOT_DIR}/06-on-ai-chips.png` })

  // OFF again: "don't decide for me" takes the earlier decisions with it.
  const [, off] = await openPlusMenu(panel)
  await off.click()
  await expect(off).toHaveAttribute('aria-checked', 'false')
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'dueDate')).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'unread')).toHaveText(/Starts unread/)
  await expect(draftDecisionChips(panel)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await panel.screenshot({ path: `${SHOT_DIR}/07-off-ai-chips-gone.png` })

  await panel.locator('.draft-start-btn').click()
  const body = await nthRequest(log, 'quickStart')
  expect(body.taskMeta?.pinTier).toBe('focus')
  expect(body.taskMeta?.due_date).toBeUndefined()
  expect(body.taskMeta?.unread).toBe(true)
})
