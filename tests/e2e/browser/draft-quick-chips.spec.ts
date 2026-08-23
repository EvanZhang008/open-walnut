/**
 * The draft column's QUICK-ACCESS FOLDER CHIPS (R6) — the row that makes the common
 * folders one click away, and the one whose contents are a ranking DECISION rather
 * than a rendering detail.
 *
 * Four claims, none of which the sibling lifecycle spec can make:
 *   1. the row is the R6 MIX — top 2 by absolute use count, then the 2 most recent —
 *      in that order, and that this is a DIFFERENT answer from the server's single
 *      frecency order (scenario 1);
 *   2. one click sets BOTH halves of "where does this run" (folder + the project
 *      that declares it as its `default_cwd`), off the synchronous caches only;
 *   3. no `default_cwd` match leaves a SEEDED/user-picked project UNTOUCHED —
 *      never cleared;
 *   4. no match on an UNCLAIMED draft derives the project from the folder — the
 *      basename, badged "new" — and launching stamps the auto-created registry row
 *      with the folder as its `default_cwd`, so the next pick resolves via rule 2.
 *
 * Why the mix is asserted against a CAPTURED payload rather than fixture folder
 * names: `frequent-directories.json` is live state on a SHARED fixture server that
 * every other spec's launch mutates (`recordDirectory` bumps a count / appends a
 * row), so a literal expectation would be a time bomb. `expectedChips`
 * (./draft-helpers) re-derives the rule from the exact bytes the page cached, so the
 * claim is "the UI ranked what it was handed correctly".
 *
 * See tests/e2e/browser/draft-session-column.spec.ts for the column's lifecycle and
 * tests/e2e/browser/draft-session-seeds.spec.ts for the seeding entry points.
 */

import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  basenameOf, discoverFixtureRoot, draftChipPaths, draftComposer, draftCwdPill, draftPanel,
  draftProjectPill, draftQuickChips, expectedChips, loadHome, openDraft, openDraftOnCwd,
  watchForbiddenRequests, type WorkingDir,
} from './draft-helpers'
import { openSessionFromPlus } from './draft-surface-helpers'
import { presetPanelView } from './todo-panel-helpers'

/** Artifacts of this run, per-run overridable (same convention as the siblings). */
const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-chips'

/**
 * The project/folder pair scenarios 2 and 3 share: 2 claims the folder and asserts
 * one click sets BOTH pills; 3 needs a folder that is claimed so it can pick a
 * DIFFERENT (unclaimed) chip. Named here because both seed it — 3 no longer depends
 * on 2 having run, so `-g` on either alone still works.
 *
 * FIXED project name (not stamped): a retry re-PUTs the same row rather than adding
 * a second project claiming the same folder, where the registry's
 * first-writer-wins-by-name rule could resolve to the other one. The project stays
 * task-less, so it renders no todo group and no other spec sees it.
 *
 * `wallets` is the fixture's #2 dir by absolute COUNT (24, behind walnut's 25), and
 * R6's first chip group is exactly "top 2 by count" — so it is reliably inside the
 * chip window even on a shared store (a fresh launch enters at count 1 and can only
 * compete for the two RECENCY slots).
 */
const CHIP_PROJECT = 'ChipProj'
const CHIP_CWD = (root: string): string => `${root}/projects/wallets`

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

// Real CLI spawns (scenarios 1 and 4 both launch — one to age the store, one to
// prove the auto-create + stamp) plus round-trips that queue behind the fixture's
// session health monitor on its seeded 500-session dataset — same budget as the
// siblings, for the same reasons.
test.setTimeout(180_000)

// Serial: all three drive ONE shared working-dirs store and project registry.
test.describe.configure({ mode: 'serial' })

// ── 1. The R6 mix is a real ranking decision, not the server's order ─────────

test('the chip row is top-2-by-use then 2-most-recent — a different answer from the server order', async ({ page }) => {
  // The discriminating case, and the reason R6 exists: a folder touched MOMENTS ago
  // but barely used must not displace the workhorses. `/api/sessions/working-dirs`
  // returns ONE frecency score weighted toward recency (0.7 recency / 0.3 count), so
  // a just-used dir climbs that list — while R6 must place it in the RECENCY slots,
  // behind the three most-used.
  //
  // On the PRISTINE fixture both rules happen to produce the same order, so an
  // order assertion alone would pass against a UI that had merely echoed the server.
  // A real launch into a low-count folder is what makes the claim falsifiable —
  // there is no "record a directory" API (`recordDirectory` only runs at spawn), so
  // the launch IS the seeding.
  const freshCwd = `${fixtureRoot}/projects/mcps`
  await page.setViewportSize({ width: 2400, height: 1000 })
  await loadHome(page)
  const seedPanel = await openDraftOnCwd(page, freshCwd)
  await draftComposer(page).fill(`chip-order store seeding ${Date.now()}`)
  const launch = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await seedPanel.locator('.draft-start-btn').click()
  await launch
  // The spawn is what records the directory, so wait for the column to really become
  // a session before reading the store back.
  await expect(page.locator('.draft-session-panel')).toHaveCount(0, { timeout: 30_000 })

  // Reload so the module cache is refilled from a FRESH response that includes the
  // launch (the cache is invalidated + re-warmed in-page too, but a reload makes the
  // captured payload unambiguous).
  // Captured via a ROUTE INTERCEPT, not waitForResponse().json(): the waiter could
  // match the PRE-reload document's re-warm request, whose body the reload's
  // navigation frees before .json() reaches it ("No resource with given identifier
  // found" — even with the read chained immediately). route.fetch() reads the body
  // on the Playwright side and hands the page the same bytes, so the test owns the
  // payload and no navigation can drop it.
  let warmDirs: { dirs: WorkingDir[] } | null = null
  await page.route('**/api/sessions/working-dirs*', async (route) => {
    const response = await route.fetch()
    const json = (await response.json()) as { dirs: WorkingDir[] }
    warmDirs = json   // the post-reload warm — the payload the module cache keeps
    await route.fulfill({ response, json })
  })
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => warmDirs !== null, { timeout: 30_000, message: 'the working-dirs warm never fired' }).toBe(true)
  await page.unroute('**/api/sessions/working-dirs*')
  // `?? []` only for TS (its flow analysis can't see the closure assignment);
  // the poll above guarantees the capture happened.
  const dirs = (warmDirs ?? { dirs: [] as WorkingDir[] }).dirs

  const panel = await openDraft(page)
  const paths = await draftChipPaths(panel)

  // THE assertion: the R6 mix, in order, over the bytes the page was handed.
  expect(paths, 'chips are the 2 most-used folders then the 2 most recent, in that order')
    .toEqual(expectedChips(dirs))
  expect(paths.length, 'at most four chips').toBeLessThanOrEqual(4)
  expect(new Set(paths).size, 'no folder appears twice').toBe(paths.length)

  // …and the row's first two ARE the two highest counts — derived here
  // independently of `expectedChips`, so a bug shared by helper and product still
  // trips something.
  const byCount = [...dirs].sort((a, b) => b.count - a.count)
  const title = (d: WorkingDir) => (d.host ? `${d.cwd} (on ${d.hostLabel ?? d.host})` : d.cwd)
  expect(paths.slice(0, 2), 'the count group leads the row')
    .toEqual(byCount.slice(0, 2).map(title))

  // The TEETH: with the freshly-launched folder in the store the two orders must
  // disagree, so "the UI echoed the server" is now a failing hypothesis. Conditional
  // on the payload genuinely disagreeing — the fixture store is shared and its
  // counts drift, and a run where the two rules coincide should report that rather
  // than fail — but the annotation makes a silently non-discriminating run visible.
  const serverOrder = dirs.slice(0, 4).map(title)
  const discriminates = JSON.stringify(expectedChips(dirs)) !== JSON.stringify(serverOrder)
  test.info().annotations.push({
    type: 'chip-order',
    description: discriminates
      ? 'R6 order differs from the server frecency order — the assertion discriminates'
      : `NOT discriminating this run: the store's two orders coincide (${serverOrder.length} dirs)`,
  })
  if (discriminates) {
    expect(paths, 'the UI must rank by the R6 split, not echo the server order')
      .not.toEqual(serverOrder)
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-chip-order.png`, fullPage: false })
})

// ── 2. One click sets folder AND the project that claims it ─────────────────

test('a quick-access chip is a bare basename and sets cwd AND project in one offline click', async ({ page }) => {
  // The chip whose folder a project CLAIMS as its `default_cwd`: one click has to
  // configure both halves of "where does this run", which is the whole reason the
  // row exists. Seeded BEFORE the first load — useProjectRegistry fetches once on
  // mount, so the mapping has to exist by then. PUT /metadata creates the row.
  const cwd = CHIP_CWD(fixtureRoot)
  const seed = await page.request.put(`/api/projects/${CHIP_PROJECT}/metadata`, {
    data: { default_cwd: cwd },
  })
  expect(seed.ok(), await seed.text()).toBe(true)

  // Wide enough that the draft column renders fully beside the chat (the same
  // reason scenarios 3/8 set it) — the chip row is what this artifact documents.
  await page.setViewportSize({ width: 2400, height: 1000 })
  // The chips render from the working-dirs MODULE CACHE, read synchronously at
  // open time — nothing re-renders the panel when a later fetch lands, so the
  // cache has to be warm BEFORE the "+". MainPage warms it on mount; this waits
  // for that exact response (armed before the navigation) instead of hoping.
  const warm = page.waitForResponse(
    (res) => res.url().includes('/api/sessions/working-dirs') && res.ok(),
    { timeout: 30_000 },
  )
  await loadHome(page)
  // The EXACT bytes the module cache now holds — the chip row's only input, so the
  // R6 mix below is checked against the same ranking data the UI saw (see
  // `expectedChips`). Reading /api/sessions/working-dirs again would race another
  // spec's launch bumping a count between the two calls.
  const warmed = (await (await warm).json()) as { dirs: WorkingDir[] }

  const panel = await openDraft(page)

  // The chips live in the launch STACK above the composer, not in the body: the
  // v4 body is one muted hint and nothing clickable.
  const chips = draftQuickChips(panel)
  await expect(chips.first()).toBeVisible({ timeout: 10_000 })
  await expect(panel.locator('.draft-session-body .draft-quick-chip')).toHaveCount(0)

  // ── The R6 mix: top-2-by-use + 2-most-recent, in that ORDER (4 max) ──
  //
  // Not just "≤4, no dupes": the whole reason the row stopped using the server's
  // single frecency order is that a folder touched twice this morning outranked one
  // used 300 times, so the row churned. That is only observable as ORDER, and only
  // against the ranking data the page actually cached — hence `expectedChips` over
  // the captured payload rather than hardcoded fixture folder names (the store is
  // SHARED and every other spec's launch reorders it).
  const paths = await draftChipPaths(panel)
  expect(paths, 'chips are the 2 most-used folders then the 2 most recent, in that order')
    .toEqual(expectedChips(warmed.dirs))
  expect(paths.length, 'at most four quick-access chips').toBeLessThanOrEqual(4)
  expect(new Set(paths).size, 'no folder appears twice in the row').toBe(paths.length)

  // Label = the BASENAME, exactly. The old chips read "Start in <dir>", which
  // repeated the same three words four times down the column; the full path is
  // still there as the title (and is what makes a chip addressable).
  const dirChip = draftQuickChips(panel).and(page.locator(`[title="${cwd}"]`))
  await expect(dirChip, `no chip for ${cwd} — frecency ranking moved it out of the chip window`)
    .toHaveCount(1)
  await expect(dirChip).toHaveText(basenameOf(cwd))
  // Every chip, not just the target: a stray prefix on any of them is the
  // regression this guards.
  for (const label of await chips.allInnerTexts()) {
    expect(label, 'chip labels are bare basenames').not.toMatch(/Start in|\//)
  }

  // The starting point for both pills, so the flip below is a real change rather
  // than a value that was already there.
  await expect(draftCwdPill(panel)).toHaveText('Choose folder…')
  await expect(draftProjectPill(panel)).toHaveText('Inbox')

  const seen = watchForbiddenRequests(page)
  await dirChip.click()

  // BOTH pills relabel off ONE click: the cwd (the same assertion openDraftOnCwd
  // makes after driving the real picker) and the project that declares this folder
  // as its default_cwd. A chip that only set the folder would leave the task
  // filed in the Inbox while the session ran in a project's checkout.
  await expect(draftCwdPill(panel)).toContainText(basenameOf(cwd))
  await expect(draftProjectPill(panel)).toHaveText(CHIP_PROJECT)
  // …and the row does NOT reshuffle: the clicked chip stays, at the same slot,
  // now active and inert. (Retiring it re-ranked every chip 21ms after the pick,
  // so a double-click landed back on the folder just left.)
  await expect(dirChip).toHaveCount(1)
  await expect(dirChip).toHaveClass(/draft-quick-chip-active/)
  expect(await draftChipPaths(panel), 'a pick must not reorder the chip row').toEqual(paths)
  // The picker never opened, either: a chip is a shortcut PAST it.
  await expect(page.locator('.session-path-selector')).toHaveCount(0)
  // The whole interaction ran off the synchronous caches (working-dirs module
  // cache + the already-loaded registry) — a draft path is contractually
  // network-free, and "resolve the project for this folder" must not become a fetch.
  expect(seen, 'quick actions must run off the synchronous caches').toEqual([])

  // No repair entry point inside a draft: the 🔧 chip and the launch-bar intent
  // readout were both removed in v4 (the chat pill is the only Fix Walnut route,
  // and it is unchanged — see fix-walnut-launcher-parity.spec.ts). Asserted as
  // absence AND by copy, so re-adding it under a new class still trips this.
  await expect(panel.locator('.draft-quick-chip-fix')).toHaveCount(0)
  await expect(panel.locator('.draft-intent-chip')).toHaveCount(0)
  // Case-insensitive: the chat pill spells it "fix walnut" and the removed
  // readout spelled it "🔧 Fix Walnut", so a casing change must not evade this.
  // Scoped to the panel, so the (legitimate) chat pill can't satisfy it either —
  // and a chip whose folder basename is literally "walnut" does not match.
  await expect(panel.getByText(/fix\s+walnut/i)).toHaveCount(0)
  // The composer keeps its own placeholder too (the repair copy belonged to the
  // removed chip).
  await expect(draftComposer(page)).toHaveAttribute('placeholder', 'What should this session do?')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-quick-actions.png`, fullPage: false })
})

// ── 3. A chip whose folder no project claims leaves the project alone ──────

test('a quick-access chip for an unclaimed folder sets the cwd and keeps the seeded project', async ({ page }) => {
  // The other half of the one-click rule: no `default_cwd` match must leave the
  // project UNTOUCHED, never cleared. A seeded project (project header "+ → Add
  // session") that a later folder pick silently reset to Inbox would file the work
  // in the wrong place — and the pill would look right until you read it.
  // Wide, like the other scenarios that need the draft column to render fully
  // beside the chat: at the default 1280 the column is clipped, which makes the
  // artifact unreadable even though the DOM-level assertions still hold.
  await page.setViewportSize({ width: 2400, height: 1000 })
  // Re-seed 9's claim rather than inheriting it: the file is serial so 9 has
  // already run in a full pass, but `-g` on THIS scenario alone must still find a
  // claimed folder to exclude. PUT is idempotent, so this is a no-op after 9.
  const seed = await page.request.put(`/api/projects/${CHIP_PROJECT}/metadata`, {
    data: { default_cwd: CHIP_CWD(fixtureRoot) },
  })
  expect(seed.ok(), await seed.text()).toBe(true)
  const warm = page.waitForResponse(
    (res) => res.url().includes('/api/sessions/working-dirs') && res.ok(),
    { timeout: 30_000 },
  )
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)
  await warm

  // Seed the project through the real UI (the project header's "+"), the same
  // route scenario 6 uses.
  const header = page.locator('.todo-group-project-header').filter({
    has: page.locator('.todo-group-project-name').filter({ hasText: /^Walnut$/ }),
  }).first()
  await expect(header).toBeVisible({ timeout: 25_000 })
  await header.hover()
  await openSessionFromPlus(page, header)

  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(draftProjectPill(panel)).toHaveText('Walnut')

  // Pick a chip NO project declares — the exclusion set is read from the LIVE
  // registry rather than being a hardcoded folder name, because the chips that
  // render are frecency-ranked over a store every other spec's launch reorders.
  // Deriving it means a future spec that points a project at another fixture
  // folder can't silently turn this scenario into a copy of scenario 9.
  const projectsRes = await page.request.get('/api/projects')
  const claimed = new Set(
    ((await projectsRes.json()) as { projects?: Array<{ metadata?: { default_cwd?: string } }> })
      .projects?.map((p) => (p.metadata?.default_cwd ?? '').replace(/\/+$/, '')).filter(Boolean) ?? [],
  )
  // The seed above must be visible here — otherwise "unclaimed" below could pick
  // the very folder a project owns and the scenario would assert nothing.
  expect([...claimed], 'the claimed-folder seed reached the registry').toContain(CHIP_CWD(fixtureRoot))

  const chips = draftQuickChips(panel)
  await expect(chips.first()).toBeVisible({ timeout: 10_000 })
  const titles = await chips.evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
  // Local entries only: a remote chip's title is "<path> (on <host>)" and its pill
  // reads "dir · host", which is a different formatting question.
  const unclaimed = titles.find((t) => t.startsWith('/') && !t.includes(' (on ') && !claimed.has(t))
  expect(unclaimed, `no unclaimed local chip among ${JSON.stringify(titles)} (claimed: ${JSON.stringify([...claimed])})`)
    .toBeTruthy()

  const seen = watchForbiddenRequests(page)
  await chips.and(page.locator(`[title="${unclaimed!}"]`)).click()

  await expect(draftCwdPill(panel)).toContainText(basenameOf(unclaimed!))
  // THE assertion: the seeded project survived the folder pick.
  await expect(draftProjectPill(panel)).toHaveText('Walnut')
  expect(seen, 'the chip must not fetch to decide there is no project').toEqual([])

  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-chip-keeps-project.png`, fullPage: false })
})

// ── 4. An unclaimed folder on an UNCLAIMED draft derives the project from it ─

test('an unclaimed folder defaults the project to its basename, badged new, and launching stamps default_cwd', async ({ page }) => {
  // "A folder is a project": with nobody having picked/seeded a project, choosing a
  // folder no registry project declares must fill the project pill with the
  // folder's BASENAME (the project the launch will auto-create) instead of leaving
  // the task in the Inbox — the two-step "pick folder, then also create a project
  // for it" chore this feature removes. The launch then stamps the auto-created
  // row's default_cwd, which is what makes the mapping stick for the NEXT pick
  // (scenario 2's one-click rule).
  //
  // A FRESH directory rather than a fixture chip: the fixture folders' basenames
  // (walnut/wallets/mcps) are all registered project names on the seeded server,
  // where the pill legitimately resolves to the EXISTING project and no "new"
  // badge shows — the full claim (derive + badge + auto-create + stamp) needs a
  // name the registry has never seen. mkdir on the test side is fine: the fixture
  // root is a local temp tree, and the user story starts at "I made a folder".
  const projectName = `driftwood-${Date.now().toString(36)}`
  const cwd = `${fixtureRoot}/projects/${projectName}`
  fs.mkdirSync(cwd, { recursive: true })

  await page.setViewportSize({ width: 2400, height: 1000 })
  await loadHome(page)
  // The REAL picker (type path + Shift+Enter), not a chip — a brand-new folder is
  // never in the frecency row, so this is exactly the route a user takes.
  const panel = await openDraftOnCwd(page, cwd)

  // The pick fills the project pill with the folder's basename, badged "new"
  // (same badge + meaning as Quick Task's confirm panel): this project doesn't
  // exist yet, starting will create it.
  await expect(draftProjectPill(panel)).toContainText(projectName)
  await expect(draftProjectPill(panel).locator('.qtc-confirm-new')).toHaveText('new')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-folder-derived-project.png`, fullPage: false })

  // Launch for real: the task files under the derived project, and the registry
  // row the launch auto-created now DECLARES this folder (default_cwd stamped
  // server-side), closing the loop — the next pick of this folder is scenario 2.
  await draftComposer(page).fill(`folder-derived project launch ${Date.now()}`)
  const launched = page.waitForResponse((res) =>
    res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/sessions/quick-start' && res.ok())
  await panel.locator('.draft-start-btn').click()
  const body = (await (await launched).json()) as { taskId?: string }
  expect(body.taskId, 'quick-start returned a task id').toBeTruthy()

  const { task } = (await (await page.request.get(`/api/tasks/${body.taskId}`)).json()) as { task?: { project?: string } }
  expect(task?.project, 'the task filed under the folder-derived project').toBe(projectName)

  await expect.poll(async () => {
    const res = (await (await page.request.get('/api/projects')).json()) as {
      projects?: Array<{ name: string; source: string; metadata?: { default_cwd?: string } }>
    }
    const row = res.projects?.find((p) => p.name.toLowerCase() === projectName.toLowerCase())
    return row ? { source: row.source, default_cwd: row.metadata?.default_cwd } : null
  }, { timeout: 15_000, message: 'the auto-created project row carries the launch folder' })
    .toEqual({ source: 'local', default_cwd: cwd })

  // Clean the claim up: on a REUSED local fixture server every run of this
  // scenario would otherwise leave one more project claiming a folder, slowly
  // shrinking the unclaimed pool scenario 3 draws from. (The task it filed moves
  // to the Inbox — fine, the shared fixture accretes tasks from every spec.)
  const del = await page.request.delete(`/api/projects/${encodeURIComponent(projectName)}`)
  expect(del.ok(), await del.text()).toBe(true)
})
