/**
 * Shared helpers for the draft session column ("+" → an empty column, zero network).
 *
 * The one verb "New" work rerouted every launcher entry point (todo toolbar "+",
 * project header "+", pin-tier header "+", the chat "+ Session" pill, `/session`,
 * ⌘⇧Enter) to a DRAFT column instead of the chat-anchored SessionPathSelector.
 * The picker itself is unchanged and still lives INSIDE each draft column, so a
 * spec that used to click the chat pill and drive `.sps-*` selectors only needs a
 * new route in — that is exactly what `openDraftOnCwd` provides.
 *
 * Driving idiom copied verbatim from tests/e2e/browser/session-path-selector.spec.ts
 * and codex-lifecycle.spec.ts: switch to the Local host tab when the fixture is in
 * multi-host mode, optionally flip the engine toggle, fill `.sps-search-input`
 * with the absolute path, then Shift+Enter to confirm. The only difference is
 * SCOPE — every locator is rooted at the draft panel, because several draft
 * columns (plus the chat-anchored picker) can be mounted at once and a bare
 * document-level `.sps-search-input` would grab whichever renders first.
 *
 * WHERE THE PILLS LIVE. The cwd/host + project pills left the composer's controls
 * row for a launch stack (`.draft-launch-bar`) that in the approved v4 layout sits
 * INSIDE `.session-panel-input`, directly above the composer — HOW a session
 * launches is a property of the column, not of the message, but it belongs next to
 * the verbs it configures rather than a panel-height away under the header (where
 * an earlier revision put it). Through BOTH moves the container kept its
 * `.draft-composer-bar` marker class on purpose, so every selector below (and in
 * the ~12 specs that reach the picker through a draft) is unchanged.
 *
 * The second half of this file is the home-strip fixture kit (panel count, seeded
 * columns, task probes) shared with tests/e2e/browser/draft-session-column.spec.ts.
 */

import { expect, type Locator, type Page } from '@playwright/test'

/**
 * A REAL session panel — neither the pending placeholder nor a draft.
 *
 * Load-bearing for every spec that resolves the panel right after the
 * quick-start response: the strip is wrapped in auto-animate (MainPage's
 * `useAutoAnimate`, duration 320ms), whose FLIP leave-animation keeps the
 * outgoing draft element in the DOM for one more paint AFTER React has dropped
 * it. Measured on the live fixture: at the instant the POST resolves both the
 * draft and the new real panel match `.session-panel:not(.pending-session-panel)`
 * (two elements → Playwright strict-mode violation); by +700ms only the real one
 * remains. Excluding the draft class asserts the same fact without racing an
 * animation — it is NOT a weaker check, since a draft that genuinely failed to
 * resolve is caught by the acceptance suite
 * (tests/e2e/browser/draft-session-column.spec.ts asserts
 * `.draft-session-panel` reaches count 0 after Start).
 */
export const REAL_PANEL = '.session-panel:not(.pending-session-panel):not(.draft-session-panel)'

/** The draft column's root. `.first()` = leftmost: drafts insert at the strip head. */
export function draftPanel(page: Page): Locator {
  return page.locator('.draft-session-panel').first()
}

/** The draft's composer textarea (NOT the main chat's — hence the panel scope). */
export function draftComposer(page: Page): Locator {
  return draftPanel(page).locator('.chat-input-textarea')
}

/**
 * The two launch pills, addressed POSITIONALLY inside the launch stack: cwd/host
 * first, project second. `.draft-composer-bar` is the container marker that
 * survived both moves (composer row → under the header → v4's stack above the
 * composer), so the index contract is the same one the older specs already rely
 * on. Nothing else in the row is a `.session-action-chip` — the v4 layout dropped
 * the repair readout that used to sit beside them — so the indices are stable.
 */
export function draftPills(panel: Locator): Locator {
  return panel.locator('.draft-composer-bar .session-action-chip')
}
export const draftCwdPill = (panel: Locator): Locator => draftPills(panel).first()
export const draftProjectPill = (panel: Locator): Locator => draftPills(panel).nth(1)

/** The launch stack (quick chips → engine/pin row → pills), which in v4 lives
 *  INSIDE `.session-panel-input` above the composer. Scoped through that wrapper
 *  so the locator itself encodes the placement. */
export function draftLaunchBar(panel: Locator): Locator {
  return panel.locator('.session-panel-input > .draft-launch-bar')
}

/** Quick-access folder chips (label = folder BASENAME, title = full path). Up to
 *  FOUR in R6: top 2 by absolute use count + the 2 most recent (see
 *  `quickDirsFor` in web/src/components/sessions/draft-column.ts). */
export function draftQuickChips(panel: Locator): Locator {
  return draftLaunchBar(panel).locator('.draft-quick-chips .draft-quick-chip')
}

/** Full paths of the rendered chips, in row order — the chip row's `title` IS the
 *  addressable identity (the visible label is only the basename). */
export async function draftChipPaths(panel: Locator): Promise<string[]> {
  return draftQuickChips(panel)
    .evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
}

/** One row of GET /api/sessions/working-dirs — the ONLY input the chip row has. */
export interface WorkingDir {
  cwd: string
  host: string | null
  hostLabel?: string
  count: number
  lastUsed: string
}

/** A chip's `title`, exactly as DraftLaunchBar builds it. */
const chipTitle = (d: WorkingDir): string =>
  d.host ? `${d.cwd} (on ${d.hostLabel ?? d.host})` : d.cwd

/**
 * The R6 chip-selection rule, re-derived from the SAME payload the page cached:
 * top 2 by absolute `count` (ties → freshest first), then the 2 most recent of
 * the rest. Membership is a pure function of the payload — the draft's current
 * cwd is IN the row (rendered active), never excluded: exclusion made the row
 * reshuffle right after a pick, and a double-click re-picked the folder just left.
 *
 * Recomputing it rather than hardcoding fixture folder names is what makes the
 * assertion deterministic on a SHARED fixture server: `frequent-directories.json`
 * is live state every other spec's launch mutates (`recordDirectory` bumps a count
 * / appends a row), so any literal expectation would be a time bomb. The claim
 * under test is therefore "the UI ranked the bytes it was handed correctly" — and
 * the caller captures those bytes from the page's own warm response, not from a
 * second GET that could race a concurrent launch.
 */
export function expectedChips(dirs: readonly WorkingDir[]): string[] {
  const key = (d: WorkingDir) => `${d.host ?? '__local__'}::${d.cwd}`
  const seen = new Set<string>()
  const candidates: WorkingDir[] = []
  for (const d of dirs) {
    if (seen.has(key(d))) continue
    seen.add(key(d))
    candidates.push(d)
  }
  const ms = (d: WorkingDir) => {
    const t = Date.parse(d.lastUsed ?? '')
    return Number.isNaN(t) ? -Infinity : t
  }
  const byRecent = (a: WorkingDir, b: WorkingDir) => ms(b) - ms(a)
  const top = [...candidates].sort((a, b) => (b.count - a.count) || byRecent(a, b)).slice(0, 2)
  const taken = new Set(top.map(key))
  const recent = [...candidates].filter((d) => !taken.has(key(d))).sort(byRecent).slice(0, 2)
  return [...top, ...recent].map(chipTitle)
}

/** One pin-tier button in the draft's meta row. `tier` is the built-in name
 *  ('focus' | 'satellite' | 'backlog' | 'wait') — the class suffix the shared
 *  PinTierPicker emits. Active state is BOTH a class and aria-pressed. */
export function draftTierBtn(panel: Locator, tier: string): Locator {
  return draftLaunchBar(panel).locator(`.pin-tier-options .pin-tier-${tier}`)
}

/**
 * The meta row's single ✦ slot (R9).
 *
 * ALWAYS present, empty when no AI value is showing — the slot is an absolute
 * overlay on the row's right edge, out of the flex flow, so a landing suggestion
 * can't shift the controls (and the row's left edge stays aligned with the chips
 * and pills rows). So assert its TEXT ('✦' vs ''), never its presence.
 */
export function draftMetaAiSlot(panel: Locator): Locator {
  return draftLaunchBar(panel).locator('.draft-meta-ai-slot')
}

/** Preset the launcher's STICKY pin tier before the first render, so a spec that
 *  asserts a tier change knows what it started from.
 *
 * Load-bearing for determinism, not tidiness: the key is mirrored to the server by
 * ui-prefs-sync, and the fixture server is SHARED — another spec's pick (e.g.
 * fix-walnut-launcher-parity's 'wait') is merged back into a later page's
 * localStorage at boot. A locally-written value with no sync timestamp WINS that
 * merge (see initUiPrefsSync), which is exactly why writing it here pins it.
 */
export async function presetStickyTier(page: Page, tier: string): Promise<void> {
  await page.addInitScript((t) => {
    try { localStorage.setItem('open-walnut-launcher-pin-tier', t as string) } catch { /* storage off */ }
  }, tier)
}

/** Top edge of an element, for the ordering assertions below. */
async function topOf(loc: Locator, what: string): Promise<number> {
  const box = await loc.boundingBox()
  if (!box) throw new Error(`${what} has no bounding box (not rendered?)`)
  return box.y
}

/**
 * Wait until nothing inside `panel` is still animating, so a geometry read
 * measures the SETTLED layout.
 *
 * Load-bearing, not defensive: the session strip is wrapped in auto-animate
 * (MainPage's `useAutoAnimate`, duration 320ms), whose FLIP slide starts the new
 * column at a fraction of its final width. Measured mid-animation the draft column
 * is ~53px wide, which wraps the two pills onto separate lines and puts the cwd
 * pill 15px off the row's left edge — a left-alignment assertion then fails
 * against a layout the user never sees. `getAnimations({ subtree: true })` covers
 * both the FLIP (Web Animations) and any CSS transition on the rows themselves.
 */
async function settleLayout(panel: Locator): Promise<void> {
  await expect.poll(
    () => panel.evaluate((el) => el.getAnimations({ subtree: true }).length),
    { timeout: 10_000, message: 'the draft column never stopped animating' },
  ).toBe(0)
}

/**
 * The approved v4 layout, asserted as GEOMETRY + DOM containment.
 *
 * Load-bearing distinction: a class-existence check ("`.draft-launch-bar` is
 * visible", "`.pin-tier-options` is visible") passed against the PREVIOUS shape
 * too — bar under the header, model select inside its meta row, chips in the body.
 * The v4 re-arrangement is entirely about placement, so each claim here is either
 * a containment check (the bar is a child of the composer wrapper, so it can never
 * drift back up under the header) or a top-edge comparison (rows in the approved
 * order). Nothing here asserts pixel values — only relative order, which is what
 * the mockup actually fixes.
 */
export async function expectV4Stack(panel: Locator): Promise<void> {
  // Geometry only means anything once the column has stopped sliding in.
  await settleLayout(panel)

  // 1. The empty body is ONE centered hint and nothing else. `>*` count, not a
  //    :not() filter: this is what forbids re-introducing chips/buttons there.
  const body = panel.locator('.draft-session-body')
  await expect(body.locator('> *')).toHaveCount(1)
  await expect(body.locator('.draft-quick-hint')).toBeVisible()

  // 2. The whole launch stack lives INSIDE the composer wrapper, above the
  //    composer card. `draftLaunchBar` is already scoped to
  //    `.session-panel-input >`, so a non-zero count IS the containment claim.
  const bar = draftLaunchBar(panel)
  await expect(bar).toBeVisible()
  const composer = panel.locator('.session-panel-input > .chat-input-container')
  await expect(composer).toBeVisible()

  // 3. Row order, top → bottom (R6): body hint · quick chips · meta row · pills ·
  //    composer. Read as top edges so the assertion survives restyling.
  //    The chips moved ABOVE the meta row in R6 — that row's CONTENT churns (top-2
  //    by use + 2 most recent), so it must not sit where the user aims for the
  //    fixed controls; the pills stay glued to the composer.
  const [hintY, chipsY, metaY, pillsY, composerY] = await Promise.all([
    topOf(body.locator('.draft-quick-hint'), 'the body hint'),
    topOf(bar.locator('.draft-quick-chips'), 'the quick-access chips row'),
    topOf(bar.locator('.sps-meta-footer .sps-meta-row').first(), 'the engine/pin row'),
    topOf(bar.locator('.draft-composer-bar'), 'the cwd/project pills row'),
    topOf(composer, 'the composer'),
  ])
  expect(hintY, 'the body hint sits above the launch stack').toBeLessThan(chipsY)
  expect(chipsY, 'quick-access chips are the TOP row of the stack').toBeLessThan(metaY)
  expect(metaY, 'the engine/pin row sits between the chips and the pills').toBeLessThan(pillsY)
  expect(pillsY, 'the pills are the LAST row before the composer').toBeLessThan(composerY)

  // 4. The pills are LEFT-ALIGNED as a pair (v4): the cwd pill starts at the row's
  //    left edge and the project pill follows it on the SAME line — they used to
  //    read as two opposite corners of the panel.
  const row = await bar.locator('.draft-composer-bar').boundingBox()
  const cwd = await draftCwdPill(panel).boundingBox()
  const project = await draftProjectPill(panel).boundingBox()
  if (!row || !cwd || !project) throw new Error('the pills row did not render')
  expect(Math.abs(cwd.x - row.x), 'the cwd pill starts at the row edge').toBeLessThan(6)
  expect(project.x, 'the project pill follows the cwd pill').toBeGreaterThan(cwd.x)
  expect(Math.abs(project.y - cwd.y), 'both pills share one line').toBeLessThan(4)

  // 4b. The three rows share ONE left edge — first chip, engine toggle, cwd pill.
  //     This is the regression the in-flow ✦ slot shipped (the meta row sat 11px
  //     right of its neighbours); the slot is an absolute overlay now, and this
  //     pins that. Compared as first-CONTROL edges, not container edges, because
  //     a container can be full-width regardless of where its content starts.
  const firstChip = await bar.locator('.draft-quick-chips .draft-quick-chip').first().boundingBox()
  const engine = await bar.locator('.sps-engine-toggle').boundingBox()
  if (!firstChip || !engine) throw new Error('the chips/meta rows did not render')
  expect(Math.abs(firstChip.x - cwd.x), 'the quick chips share the pills\' left edge').toBeLessThan(3)
  expect(Math.abs(engine.x - cwd.x), 'the engine toggle shares the pills\' left edge').toBeLessThan(3)

  // 5. The model select moved into the COMPOSER's controls row, leftmost — the
  //    same place a real session keeps its model pill. Containment through
  //    `.chat-input-controls` is the point: in the old shape it was in the bar.
  const modelSelect = composer.locator('.chat-input-controls .draft-actions-bar .draft-model-select')
  await expect(modelSelect).toBeVisible()
  const actions = await composer.locator('.draft-actions-bar').boundingBox()
  const model = await modelSelect.boundingBox()
  const start = await composer.locator('.draft-start-btn').boundingBox()
  if (!actions || !model || !start) throw new Error('the composer controls row did not render')
  expect(Math.abs(model.x - actions.x), 'the model select is leftmost in the controls row')
    .toBeLessThan(6)
  expect(model.x, 'the model select sits before "Start ↵"').toBeLessThan(start.x)
}

/**
 * Click the todo toolbar "+" and wait for the draft column to mount.
 *
 * Deliberately does NOT wait for network idle: the whole point of this entry
 * point is that it is synchronous and network-free, so anything that waits on a
 * request here would mask a regression rather than expose it.
 */
export async function openDraft(page: Page): Promise<Locator> {
  await page.locator('.new-launcher-btn').click()
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  return panel
}

/**
 * Open a draft column and point it at `cwd` through the real folder picker.
 *
 * Steps, all real UI: toolbar "+" → the cwd pill in the draft's launch stack →
 * (optional) engine toggle → type the path → Shift+Enter to confirm. Returns the
 * draft panel so callers can keep working inside it.
 *
 * `cwd` must be an ABSOLUTE path that exists on disk (specs derive it from the
 * fixture root via /api/sessions/working-dirs): a path the live listing calls
 * missing routes ⇧Enter to "create folder & start" instead of a plain confirm.
 */
export async function openDraftOnCwd(
  page: Page,
  cwd: string,
  opts: { engine?: 'Codex' } = {},
): Promise<Locator> {
  const panel = await openDraft(page)

  // The cwd/host pill. Label is the folder basename once a path is set, and
  // "Choose folder…" on a fresh browser with no launch memory — match either,
  // and take the FIRST chip (the project pill sits right after it).
  await draftCwdPill(panel).click()

  // PAGE-scoped: the picker pops out (portalled to <body>, anchored to the
  // pill) — it is no longer a DOM descendant of the draft panel. Only one
  // picker can be open at a time, so the page-level locator is unambiguous.
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })

  // Wait for the history fetch to land FIRST: the host tabs render in the same
  // commit as the path list, so gating on a row makes the tab check below
  // deterministic. A bare isVisible() raced the fetch under load — the Local
  // pin was silently skipped, the All tab stayed active, and typing then fanned
  // the live listing out to the dead fixture SSH host (400 → console.error →
  // the codex audit fails the test).
  await expect(picker.locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })

  // Multi-host fixtures render host tabs; pin to Local so a slow/dead SSH host
  // can't leave path validity 'unknown'. Single-host mode renders no tabs.
  const localTab = picker.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  if (opts.engine === 'Codex') {
    await picker.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()
  }

  const input = picker.locator('.sps-search-input')
  await input.fill(cwd)
  await input.press('Shift+Enter')

  // Confirming closes the popover and writes the path onto the draft row — the
  // pill relabels to the folder basename, which is the observable proof the pick
  // landed on THIS draft (a stale pill means onPathChange never fired).
  await expect(picker).toBeHidden()
  await expect(draftCwdPill(panel)).toContainText(basenameOf(cwd))

  return panel
}

/** Folder basename — the cwd pill's label, and (in v4) the WHOLE label of a
 *  quick-access chip (the old "Start in <dir>" prefix is gone). */
export function basenameOf(cwd: string): string {
  return cwd.replace(/\/+$/, '').split('/').pop() || '/'
}

// ── Home-strip fixture kit (shared with draft-session-column.spec.ts) ─────────

/** Every home session column, in strip order. */
export const homeColumns = (page: Page): Locator =>
  page.locator('.main-page-sessions-area > .main-page-session-column')

/** Land on the app and wait for the task panel (every scenario needs a "+"). */
export async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
}

/** Seed the home column queue so `sids` panels mount on load. Call BEFORE goto. */
export async function seedColumns(page: Page, sids: readonly string[]): Promise<void> {
  await page.addInitScript((ids) => {
    try {
      sessionStorage.setItem(
        'open-walnut-home-session-columns',
        JSON.stringify((ids as string[]).map((id) => ({ id, locked: false }))),
      )
    } catch { /* ignore */ }
  }, sids as unknown as string[])
}

const panelPicker = (page: Page) =>
  page.locator('.form-group', { hasText: 'Session Panels' }).locator('.theme-picker')

/** One picker button, matched EXACTLY (labels are bare digits). */
const panelBtn = (page: Page, label: string) =>
  panelPicker(page).locator('.theme-picker-btn').filter({ hasText: new RegExp(`^${label}$`) })

/**
 * Pick a panel count through the real Settings UI, then WAIT for it to reach
 * config. Adapted from session-panel-count.spec.ts, and the wait is load-bearing
 * for the same reason: the write is a read-modify-write behind a file lock (~2s),
 * and column eviction is one-way — seeding columns while config still says "2"
 * drops the extras for good.
 */
export async function setPanelMode(page: Page, label: '1' | '2' | '3' | '4' | '5' | 'Auto'): Promise<void> {
  if (!page.url().startsWith('http')) {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  }
  const settingsLink = page.locator('.sidebar a[href="/settings"]')
  await expect(settingsLink).toBeVisible({ timeout: 30_000 })
  await settingsLink.click()
  await expect(panelPicker(page)).toBeVisible({ timeout: 20_000 })
  const btn = panelBtn(page, label)
  await btn.click()
  await expect(btn).toHaveClass(/active/)

  const expected = label === 'Auto' ? 'auto' : label
  const readMode = async () => {
    const res = await page.request.get('/api/config')
    return (await res.json())?.config?.ui?.session_panels
  }
  // Re-CLICK between rounds rather than polling harder: a fetchConfig that lost
  // the read-modify-write race never issues its PUT, and no amount of extra
  // polling conjures one. FOUR rounds × 18s (was 3 × 15s), because the round-trip
  // queues behind the fixture's session health monitor AND behind whatever else is
  // loading this Mac — measured at load ~110 (concurrent agent sessions) the old
  // budget expired while the write was merely slow, i.e. a starvation artifact
  // reported as a product failure. 72s worst case still leaves room inside the
  // callers' per-test timeout for the steps that follow.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await expect.poll(readMode, { timeout: 18_000, intervals: [250, 500, 1000, 2000] }).toBe(expected)
      return
    } catch {
      if (attempt === 3) throw new Error(`session_panels never became ${expected} (last: ${await readMode()})`)
      await btn.click()
    }
  }
}

/** Tasks whose title contains `needle` — the parallel-safe existence probe (the
 *  fixture server is SHARED, so a global row COUNT would race other specs). */
export async function tasksTitled(
  page: Page,
  needle: string,
): Promise<Array<{ id: string; title: string; project?: string }>> {
  // No ?limit: the route now VALIDATES limit (1-200 → 400 above that), and this
  // probe must see every row regardless of fixture size — unbounded is the
  // pre-validation behavior.
  const res = await page.request.get('/api/tasks')
  const body = (await res.json()) as { tasks?: Array<{ id: string; title: string; project?: string }> }
  return (body.tasks ?? []).filter((t) => t.title.includes(needle))
}

/** Click the leftmost still-unlocked panel's lock control. Selected by the exact
 *  aria-label so it can never match the locked twin ("Unlock session panel"). */
export async function lockLeftmostPanel(page: Page): Promise<void> {
  await page
    .locator('.main-page-session-column button[aria-label="Lock session panel to the right"]')
    .first()
    .click()
}

/**
 * Requests that must NOT fire while a draft is merely being opened or
 * reconfigured from the client-side caches.
 *
 * `\/api\/tasks$` is anchored on purpose: it matches the CREATE (POST with no
 * query) while the harmless list refetch (`?fields=list`) is not a violation.
 */
const OPEN_PATH_FORBIDDEN = /\/api\/sessions\/quick-start|\/api\/tasks$|working-dirs|list-dirs/

/**
 * Collect every forbidden request from NOW on — the zero-network guard.
 *
 * Only requests STARTED after this call can land in the returned array (a
 * response to an earlier in-flight request never re-fires 'request'), so the
 * observation window is exactly the interaction under test. Arm it BEFORE the
 * click and assert `toEqual([])` right after the resulting UI appears.
 */
export function watchForbiddenRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => { if (OPEN_PATH_FORBIDDEN.test(req.url())) seen.push(req.url()) })
  return seen
}

/**
 * The fixture's on-disk path-selector root (`…/ps-fixture`).
 *
 * The tmpdir name is minted per run, so it has to be discovered rather than
 * hardcoded — read from the seeded working-dirs history, the same discovery
 * session-path-selector.spec.ts uses.
 */
export async function discoverFixtureRoot(): Promise<string> {
  const port = Number(process.env.PW_TEST_PORT ?? 3457)
  const res = await fetch(`http://localhost:${port}/api/sessions/working-dirs`)
  const body = (await res.json()) as { dirs: Array<{ cwd: string }> }
  const walnut = body.dirs.find((d) => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))
  if (!walnut) throw new Error('ps-fixture/projects/walnut seed missing from working-dirs')
  return walnut.cwd.replace(/\/projects\/walnut$/, '')
}
