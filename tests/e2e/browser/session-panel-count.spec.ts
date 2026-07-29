/**
 * E2E: the session-panel count picker (1 / 2 / 3 / 4 / 5 / Auto).
 *
 * THE BUG this guards. Settings → General → Session Panels offered only
 * 1 / 2 / Auto, and the layout underneath could not have supported a third
 * column anyway: widths were ONE scalar (`colSplitPct`) where column 0 got
 * `pct`% and "the rest" got `100 - pct`% — read by EVERY non-first column. With
 * three columns that sums past 100% (50 → 50/50/50 = 150%), so the strip
 * overflows and the rightmost panel is pushed out of view. Adding buttons
 * without fixing the sizing model would have shipped a broken layout, so the
 * load-bearing assertions here are geometric, not just "the option exists":
 *
 *  1. The option renders and persists to config.
 *  2. Three session panels are simultaneously VISIBLE, laid out left-to-right,
 *     each with real width, and none overflowing the strip. This is the
 *     assertion the old scalar model fails.
 *  3. Dragging the middle divider trades width between ITS two neighbours only —
 *     the third column keeps its share (the scalar model moved two at once).
 *  4. Dropping back to 2 evicts down to 2 and restores a sane layout.
 *
 * COVERAGE (deliberately per-count, not spot-checked). Both remaining layout defects
 * scaled with the DIVIDER count, which is exactly how a per-count regression hides from
 * a test that only tries the extremes:
 *   - the drag floor was a fixed 20%, unsatisfiable from 5 columns up (5 × 20 = 100
 *     leaves nothing to trade), so every drag in a 5-panel layout silently no-op'd;
 *   - each divider's `border-left` consumed layout width, overflowing the strip by
 *     exactly the divider count (measured 4px at 5 columns) and clipping the last panel.
 * So: EVERY count 1-5 gets the same geometric invariant, EVERY divider at 4 and 5 gets
 * dragged individually, and Auto is checked at two viewports straddling a breakpoint.
 */
import { test, expect, type Page } from '@playwright/test'

const SCREENSHOT_DIR = '/tmp/session-panel-count'

// Seeded, stopped sessions from test-server.ts — distinct ids so each occupies its
// own column. Five of them: enough to fill the largest count the picker offers.
const ALL_SIDS = [
  'pw-normal-session',
  'pw-plan-session-completed',
  'pw-vscode-session',
  'pw-mode-test-session',
  'pw-exec-bug-session',
] as const
const SIDS = ALL_SIDS.slice(0, 3)

/** Seed the home column queue so `sids` panels mount on load. */
async function openColumnsOnHome(page: Page, sids: readonly string[] = SIDS) {
  await page.addInitScript((ids) => {
    try {
      sessionStorage.setItem(
        'open-walnut-home-session-columns',
        JSON.stringify((ids as string[]).map((id) => ({ id, locked: false }))),
      )
    } catch { /* ignore */ }
  }, sids as unknown as string[])
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

const openThreeColumnsOnHome = (page: Page) => openColumnsOnHome(page, SIDS)

const panelPicker = (page: Page) =>
  page.locator('.form-group', { hasText: 'Session Panels' }).locator('.theme-picker')

/**
 * Measure the strip and its columns in ONE evaluate.
 *
 * Must be atomic: `.main-page-sessions-area` has `transition: width 0.25s`, so reading
 * the strip via one call and the columns via another can straddle a frame mid-animation
 * and report a column extending past a strip width that has already changed — a
 * measurement race that looks exactly like a real overflow bug.
 */
async function measureStrip(page: Page) {
  return page.evaluate(() => {
    const area = document.querySelector('.main-page-sessions-area') as HTMLElement
    const ar = area.getBoundingClientRect()
    const cols = Array.from(area.querySelectorAll(':scope > .main-page-session-column')) as HTMLElement[]
    return {
      strip: { x: ar.x, width: ar.width, right: ar.right },
      cols: cols.map((c) => {
        const r = c.getBoundingClientRect()
        return { x: r.x, width: r.width, right: r.right }
      }),
    }
  })
}

/** Every column has real width, sits inside the strip, and they run left-to-right. */
function assertColumnsFitStrip(m: Awaited<ReturnType<typeof measureStrip>>, minWidth: number) {
  for (const [i, b] of m.cols.entries()) {
    expect(b.width, `column ${i} has real width`).toBeGreaterThan(minWidth)
    // THE border-left regression: N-1 dividers × 1px pushed the last column past the
    // strip's right edge, clipping it. Tolerance is deliberately tight (2px).
    expect(b.right, `column ${i} stays inside the strip`).toBeLessThanOrEqual(m.strip.right + 2)
  }
  for (let i = 1; i < m.cols.length; i++) {
    expect(m.cols[i - 1].x, `column ${i - 1} is left of ${i}`).toBeLessThan(m.cols[i].x)
  }
  const total = m.cols.reduce((a, b) => a + b.width, 0)
  expect(Math.abs(total - m.strip.width), 'columns fill the strip').toBeLessThan(20)
}

/** One picker button. Labels are bare digits, so match EXACTLY — `hasText: '1'` is a
 *  substring match that would also hit nothing today but silently grab the wrong
 *  button the moment a two-digit count is added. */
const panelBtn = (page: Page, label: string) =>
  panelPicker(page).locator('.theme-picker-btn').filter({ hasText: new RegExp(`^${label}$`) })

/**
 * Pick a panel count through the real Settings UI (sidebar click, no /settings goto),
 * then WAIT for it to reach config.
 *
 * The wait is required, not defensive: the write is a read-modify-write (fetch config
 * → PUT a merged `ui`) behind a file lock and takes ~2s on the fixture's seeded
 * dataset. Callers seed session columns next, and column eviction is one-way —
 * seeding 5 columns while config still says "2" drops three of them for good, and
 * raising the count afterwards cannot bring them back.
 */
async function setPanelMode(page: Page, label: '1' | '2' | '3' | '4' | '5' | 'Auto') {
  // The sidebar only exists once the SPA is loaded. Tests that set the count BEFORE
  // seeding columns call this as their first action, so land on the app first.
  if (!page.url().startsWith('http')) {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  }
  const settingsLink = page.locator('.sidebar a[href="/settings"]')
  await expect(settingsLink).toBeVisible({ timeout: 30_000 })
  await settingsLink.click()
  await expect(panelPicker(page)).toBeVisible({ timeout: 10_000 })
  const btn = panelBtn(page, label)
  await btn.click()
  await expect(btn).toHaveClass(/active/)

  // Wait for the value to reach config. The write is a read-modify-write (fetch config →
  // PUT a merged `ui`) behind a file lock, and the fixture's session health monitor
  // periodically blocks the event loop for ~20s on its seeded 500-session dataset — so a
  // single request can simply be starved. Retrying the CLICK (not just polling harder) is
  // what makes this robust: a `fetchConfig` that lost the race never issues its PUT, and
  // no amount of extra polling will conjure one. Measured: the write normally lands in
  // ~2s, so a re-click after 15s is a stall, not impatience.
  const expected = label === 'Auto' ? 'auto' : label
  const readMode = async () => {
    const res = await page.request.get('/api/config')
    return (await res.json())?.config?.ui?.session_panels
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await expect.poll(readMode, { timeout: 15_000, intervals: [250, 500, 1000, 2000] }).toBe(expected)
      return
    } catch {
      if (attempt === 2) throw new Error(`session_panels never became ${expected} (last: ${await readMode()})`)
      await btn.click()
    }
  }
}

test.describe.configure({ mode: 'serial' })

// Above the 30s default: several steps wait on config round-trips that queue behind
// the fixture's session health monitor, which can block the event loop for ~20s on
// its seeded 500-session dataset.
test.setTimeout(120_000)

test('the picker offers 1-5 plus Auto, and a choice persists to config', async ({ page }) => {
  // A wide viewport: the point is the explicit counts, not the auto breakpoint.
  await page.setViewportSize({ width: 2400, height: 1000 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(panelPicker(page)).toBeVisible({ timeout: 20_000 })

  // Exactly the six options, in order — a missing or extra button is a real defect.
  await expect(panelPicker(page).locator('.theme-picker-btn')).toHaveText(['1', '2', '3', '4', '5', 'Auto'])

  // setPanelMode asserts the value reached config (the setting is config, not just
  // component state).
  await setPanelMode(page, '3')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-picker-1-to-5.png`, fullPage: false })

  // Navigate away and back — the choice must survive, not reset to the '2' default.
  await page.locator('.sidebar a[href="/"]').first().click()
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(panelBtn(page, '3')).toHaveClass(/active/)
  // Exactly one option reads as selected.
  await expect(panelPicker(page).locator('.theme-picker-btn.active')).toHaveCount(1)
})

test('three session panels render side by side without overflowing the strip', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await page.request.put('/api/config', { data: { ui: { session_panels: '3' } } })

  await openThreeColumnsOnHome(page)

  // All three panels mounted and visible at once.
  for (const sid of SIDS) {
    await expect(
      page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`),
    ).toBeVisible({ timeout: 15_000 })
  }
  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(3)

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-three-columns.png`, fullPage: false })

  // Geometry — THE assertion the old scalar model fails (50/50/50 = 150% overflow).
  await page.waitForTimeout(400)
  const m = await measureStrip(page)
  expect(m.cols).toHaveLength(3)
  assertColumnsFitStrip(m, 80)
})

test('dragging the middle divider trades width between its two neighbours only', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await page.request.put('/api/config', { data: { ui: { session_panels: '3' } } })
  await openThreeColumnsOnHome(page)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(3)
  const widthsOf = () => columns.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
  const before = await widthsOf()

  // Second divider = the one between column 1 and column 2.
  const handle = page.locator('.main-page-sessions-area .session-col-resize-handle').nth(1)
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  // Move in steps: the gesture coalesces to rAF, so a single jump can land as
  // one frame and under-exercise the handler.
  for (const step of [40, 80, 120, 160]) {
    await page.mouse.move(hb.x + hb.width / 2 + step, hb.y + hb.height / 2)
  }
  await page.mouse.up()
  await page.waitForTimeout(300)

  const after = await widthsOf()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-after-drag.png`, fullPage: false })

  // Column 0 is NOT a neighbour of this divider — the old single-scalar model
  // would have moved it too.
  expect(Math.abs(after[0] - before[0])).toBeLessThan(6)
  expect(after[1]).toBeGreaterThan(before[1] + 20)   // grew
  expect(after[2]).toBeLessThan(before[2] - 20)      // shrank by the same trade
  // Total conserved: a drag redistributes, it never changes the strip's width.
  const sum = (w: number[]) => w.reduce((a, b) => a + b, 0)
  expect(Math.abs(sum(after) - sum(before))).toBeLessThan(12)

  // Persisted on release (not per frame) and restored on reload.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(columns).toHaveCount(3)
  const restored = await widthsOf()
  expect(Math.abs(restored[1] - after[1])).toBeLessThan(12)
})

test('switching back to 2 evicts the third column and lays out cleanly', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await page.request.put('/api/config', { data: { ui: { session_panels: '3' } } })
  await openThreeColumnsOnHome(page)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  // Generous: the mode change reaches the (always-mounted) home page via the
  // `config:changed` WS event, so the socket must be connected before we flip the
  // setting — otherwise the event is missed and this asserts against a stale budget.
  await expect(columns).toHaveCount(3, { timeout: 20_000 })
  await expect(page.locator('.main-page')).toBeVisible()

  await setPanelMode(page, '2')
  await page.locator('.sidebar a[href="/"]').first().click()
  await page.waitForLoadState('networkidle')

  // Unlocked columns are evicted from the right down to the new max.
  await expect(columns).toHaveCount(2, { timeout: 20_000 })
  // Let the strip's width transition settle before measuring geometry.
  await page.waitForTimeout(400)
  assertColumnsFitStrip(await measureStrip(page), 80)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-back-to-two.png`, fullPage: false })
})

/**
 * EVERY count the picker offers, same treatment each. Parameterized deliberately: the
 * two layout defects both scaled with the DIVIDER count (the fixed 20% drag floor went
 * unsatisfiable at 5; each divider's `border-left` overflowed the strip by 1px apiece),
 * so a spot-check of one or two counts is exactly how a per-count regression hides.
 * Every count therefore gets the identical geometric invariant, not just the extremes.
 */
for (const count of [1, 2, 3, 4, 5] as const) {
  test(`a count of ${count} lays out ${count} readable column(s) inside the strip`, async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1200 })

    // Set the count BEFORE seeding the columns. Column eviction is deliberately
    // one-way (trimUnlockedToMax), so seeding 5 columns while the count is still 2
    // drops three of them for good — raising the count afterwards cannot bring them
    // back. That ordering is the product working as designed, not a bug to test around.
    await setPanelMode(page, String(count) as '1' | '2' | '3' | '4' | '5')
    await openColumnsOnHome(page, ALL_SIDS)

    const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
    await expect(columns).toHaveCount(count, { timeout: 25_000 })

    await page.waitForTimeout(400)
    const m = await measureStrip(page)
    expect(m.cols).toHaveLength(count)
    // Min column width scales down with the count — at 5 the strip is split 5 ways.
    assertColumnsFitStrip(m, count >= 4 ? 40 : 80)

    // Exactly count-1 dividers: one too many (or a stray one at count 1) is the
    // shape of an off-by-one in the divider's `needsDivider` condition.
    await expect(
      page.locator('.main-page-sessions-area .session-col-resize-handle'),
    ).toHaveCount(count - 1)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/count-${count}.png`, fullPage: false })
  })
}

/**
 * Dragging at the higher counts, EVERY divider.
 *
 * REGRESSION: the drag floor was a fixed 20%, unsatisfiable from 5 columns up
 * (5 × 20 = 100 leaves nothing to trade) — so every drag in a 5-panel layout silently
 * did nothing. Each divider is exercised separately because they are not
 * interchangeable: the handler resolves which boundary it owns from its own index, so
 * an off-by-one would move the wrong pair and only show up on a specific divider.
 */
for (const count of [4, 5] as const) {
  test(`every divider drags correctly at ${count} columns`, async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1200 })
    await page.request.put('/api/config', { data: { ui: { session_panels: String(count) } } })
    await openColumnsOnHome(page, ALL_SIDS)

    const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
    await expect(columns).toHaveCount(count, { timeout: 25_000 })
    const widthsOf = () => columns.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
    const sum = (w: number[]) => w.reduce((a, b) => a + b, 0)

    for (let boundary = 0; boundary < count - 1; boundary++) {
      const before = await widthsOf()
      const handle = page.locator('.main-page-sessions-area .session-col-resize-handle').nth(boundary)
      const hb = (await handle.boundingBox())!
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      // Step the move: the gesture coalesces to rAF, so one jump can land as a single
      // frame and under-exercise the handler.
      for (const step of [30, 60, 90]) await page.mouse.move(hb.x + hb.width / 2 + step, hb.y + hb.height / 2)
      await page.mouse.up()
      await page.waitForTimeout(250)
      const after = await widthsOf()

      const label = `${count} cols, divider ${boundary}`
      // The two neighbours trade: left grows, right shrinks.
      expect(after[boundary], `${label}: left neighbour grew`).toBeGreaterThan(before[boundary] + 15)
      expect(after[boundary + 1], `${label}: right neighbour shrank`).toBeLessThan(before[boundary + 1] - 15)
      // EVERY other column keeps its exact share — the old scalar model moved them all.
      for (let i = 0; i < count; i++) {
        if (i === boundary || i === boundary + 1) continue
        expect(Math.abs(after[i] - before[i]), `${label}: column ${i} untouched`).toBeLessThan(6)
      }
      // A drag redistributes; it never changes the strip's total width.
      expect(Math.abs(sum(after) - sum(before)), `${label}: total conserved`).toBeLessThan(20)
      // ...and nothing spilled outside the strip as a result of the drag.
      assertColumnsFitStrip(await measureStrip(page), 20)
    }
  })
}

test('a count set outside the UI is honoured, and a junk one falls back', async ({ page }) => {
  // The value also arrives from config.yaml / other clients, so the client parses it
  // rather than trusting it. A legal count must be obeyed...
  await page.setViewportSize({ width: 2560, height: 1200 })
  await page.request.put('/api/config', { data: { ui: { session_panels: '4' } } })
  await openColumnsOnHome(page, ALL_SIDS)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(4, { timeout: 25_000 })
  await expect(panelBtn(page, '4')).toHaveCount(0)  // we're on home, not settings

  // ...and the picker shows it as selected when you go look.
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(panelBtn(page, '4')).toHaveClass(/active/, { timeout: 20_000 })
  await expect(panelPicker(page).locator('.theme-picker-btn.active')).toHaveCount(1)
  await page.locator('.form-group', { hasText: 'Session Panels' })
    .screenshot({ path: `${SCREENSHOT_DIR}/06-four-selected.png` })

  // A nonsense count must NOT be obeyed — no 99-sliver strip, and no zero-column one
  // either. It degrades to the width-driven fallback (auto). Note the breakpoints are
  // measured on `.main-page-content-row`, NOT the viewport: at a 2560px window the row
  // is ~1878px (sidebar + todo panel take the rest), which is ≥1400 but <2100, so auto
  // budgets 2. Seeding fresh columns proves this is the live budget rather than a
  // leftover — an evicted column can never come back, so re-reading the old strip
  // could only ever show a shrunken count.
  await page.request.put('/api/config', { data: { ui: { session_panels: '99' } } })
  await openColumnsOnHome(page, ALL_SIDS)
  await expect(columns).toHaveCount(2, { timeout: 25_000 })
  assertColumnsFitStrip(await measureStrip(page), 80)

  // The picker shows the '2' DEFAULT for a rejected value — never '99' (there is no
  // such button) and never a blank strip with nothing selected. Exactly one lit button
  // is the invariant: the user always sees a real, actionable state.
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(panelPicker(page)).toBeVisible({ timeout: 20_000 })
  await expect(panelPicker(page).locator('.theme-picker-btn.active')).toHaveText(['2'])
})

/**
 * The Auto button — the only option whose column budget is DERIVED rather than stated,
 * so it is the one that can silently disagree with the picker.
 *
 * Breakpoints are measured on `.main-page-content-row`, NOT the viewport: the sidebar
 * and todo panel take a share, so a 2560px window leaves the row ~1878px. Measured
 * mapping (row width → budget): <1400 → 1, ≥1400 → 2, ≥2100 → 3. Auto stops at 3 by
 * design — 4 and 5 are explicit choices, never sprung on someone for having a wide
 * monitor. The two viewports below straddle the 1400 boundary from either side.
 */
for (const [viewport, expected] of [[1200, 1], [2560, 2]] as const) {
  test(`Auto budgets ${expected} column(s) at a ${viewport}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 1000 })
    await setPanelMode(page, 'Auto')
    await openColumnsOnHome(page, ALL_SIDS)

    const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
    await expect(columns).toHaveCount(expected, { timeout: 25_000 })
    await page.waitForTimeout(400)
    assertColumnsFitStrip(await measureStrip(page), 40)

    // Sanity-check the derivation against the actual measured row width, so a future
    // layout change that moves the row width shows up here as a clear mismatch rather
    // than a bare "expected 2, got 1".
    const rowWidth = await page.locator('.main-page-content-row').evaluate((el) => el.getBoundingClientRect().width)
    const predicted = rowWidth >= 2100 ? 3 : rowWidth >= 1400 ? 2 : 1
    expect(predicted, `row width ${Math.round(rowWidth)}px should budget ${expected}`).toBe(expected)

    // Auto must read as selected — not the count it happens to have resolved to.
    await page.locator('.sidebar a[href="/settings"]').click()
    await expect(panelBtn(page, 'Auto')).toHaveClass(/active/, { timeout: 20_000 })
    await expect(panelPicker(page).locator('.theme-picker-btn.active')).toHaveText(['Auto'])
  })
}

/**
 * The composer survives the narrowest column the picker can produce.
 *
 * A SEPARATE, PRE-EXISTING defect that the 4/5 options make easy to reach: the composer's
 * `.session-mode-bar` (mode + btw + Note + model pills) had `min-width: 0` with the
 * default `flex-wrap: nowrap`, so once squeezed it did not shrink — its pills spilled OUT
 * of the bar (measured 300px of content in a 123px box), landing on top of the mic/send
 * cluster and, in the worst column, 19px past the panel's own right edge. Width-driven,
 * not count-driven: it reproduced at 2 panels in a 1100px window (274px columns), so it
 * long predates this feature. Fixed by letting the bar wrap, like its container already does.
 *
 * Guarded geometrically at BOTH ends — 5 columns on a big screen, and 2 columns in a small
 * window — because those are the two ways to arrive at a ~270px column.
 */
for (const [label, count, viewport, expectCols] of [
  ['5 panels on a wide screen', '5', 2560, 5],
  ['2 panels in a small window', '2', 1100, 2],
] as const) {
  test(`composer pills stay inside their column: ${label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 1000 })
    await page.request.put('/api/config', { data: { ui: { session_panels: count } } })
    await openColumnsOnHome(page, ALL_SIDS)

    const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
    await expect(columns).toHaveCount(expectCols, { timeout: 25_000 })
    // The pills mount with the session panel's composer; give it a beat to settle.
    await page.waitForTimeout(2000)

    const report = await page.evaluate(() => {
      const cols = Array.from(
        document.querySelectorAll('.main-page-sessions-area > .main-page-session-column'),
      ) as HTMLElement[]
      return cols.map((c, i) => {
        const colR = c.getBoundingClientRect()
        const bar = c.querySelector('.session-mode-bar') as HTMLElement | null
        const send = c.querySelector('.chat-send-btn, button[class*="send"]') as HTMLElement | null
        const pills = Array.from(c.querySelectorAll('[class*="pill"]')) as HTMLElement[]
        const outside = pills
          .filter((p) => {
            const r = p.getBoundingClientRect()
            return r.width > 0 && (r.right > colR.right + 1 || r.left < colR.left - 1)
          })
          .map((p) => `${p.className.slice(0, 32)}@${Math.round(p.getBoundingClientRect().right)}`)
        const overlappingSend = send
          ? pills
              .filter((p) => {
                const r = p.getBoundingClientRect()
                const s = send.getBoundingClientRect()
                if (r.width === 0 || p.contains(send) || send.contains(p)) return false
                return r.right > s.left + 1 && r.left < s.right - 1 && r.bottom > s.top + 1 && r.top < s.bottom - 1
              })
              .map((p) => (p.textContent || '').trim().slice(0, 20))
          : []
        return {
          i,
          // scrollWidth > clientWidth is the direct signature of the nowrap overflow.
          barOverflows: bar ? bar.scrollWidth > bar.clientWidth + 1 : false,
          outside,
          overlappingSend,
        }
      })
    })

    for (const c of report) {
      expect(c.barOverflows, `column ${c.i}: mode bar overflows its own box`).toBe(false)
      expect(c.outside, `column ${c.i}: pills escaped the column`).toEqual([])
      expect(c.overlappingSend, `column ${c.i}: pills cover the send button`).toEqual([])
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/composer-${expectCols}col-${viewport}.png`, fullPage: false })
  })
}

/**
 * The SECOND surface: the same setting inside each session's kebab (⋮) menu.
 *
 * It is a "change it constantly while working" control, so Settings-only was the wrong
 * home for it. Two things have to hold that a Settings-only test cannot cover:
 *   1. Changing it from a session menu re-lays out the columns IMMEDIATELY. The hook is
 *      mounted per component, so the menu's instance and MainPage's (which owns the
 *      column budget) are different objects; without an in-tab fan-out MainPage would
 *      only learn via the `config:changed` WS echo — measured ~2s behind a
 *      read-modify-write under a file lock, which reads as a dead button.
 *   2. Both surfaces stay in agreement — it is ONE app-wide setting, not a per-session
 *      one, so Settings must show what the session menu just picked.
 */
async function openSessionKebab(page: Page) {
  // The session panel's own kebab (its header), not a todo row's.
  const kebab = page
    .locator('.main-page-session-column .session-panel')
    .first()
    .getByRole('button', { name: 'More actions' })
  await expect(kebab).toBeVisible({ timeout: 20_000 })
  await kebab.click()
  const menu = page.locator('.task-kebab-menu:visible').first()
  await expect(menu).toBeVisible()
  return menu
}

const panelsRow = (menu: ReturnType<Page['locator']>) =>
  menu.locator('.task-kebab-tier').filter({ has: menu.page().getByText('Panels', { exact: true }) })

test('the session kebab exposes the panel count and applies it immediately', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1200 })
  await setPanelMode(page, '5')
  await openColumnsOnHome(page, ALL_SIDS)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(5, { timeout: 25_000 })

  const menu = await openSessionKebab(page)
  const row = panelsRow(menu)
  await expect(row).toBeVisible()
  // Same options as Settings, plus Auto — one control, one vocabulary.
  await expect(row.locator('.task-kebab-tier-btn')).toHaveText(['1', '2', '3', '4', '5', 'Auto'])
  // It reflects the CURRENT value, so the menu is a readout as well as a control.
  await expect(row.locator('.task-kebab-tier-btn.active')).toHaveText(['5'])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/kebab-panels-row.png`, fullPage: false })

  // Pick 2 from the session menu → the strip must react WITHOUT waiting on config.
  // A 3s budget is far below the ~2s+ WS/file-lock round-trip plus render, so this
  // fails if the in-tab fan-out regresses to relying on the echo.
  await row.locator('.task-kebab-tier-btn').filter({ hasText: /^2$/ }).click()
  await expect(columns).toHaveCount(2, { timeout: 3000 })
  assertColumnsFitStrip(await measureStrip(page), 80)

  // ...and it still persists, so it survives a reload like any other setting.
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/config')
      return (await res.json())?.config?.ui?.session_panels
    }, { timeout: 45_000, intervals: [500, 1000, 2000] })
    .toBe('2')

  // Both surfaces agree: Settings shows what the session menu picked.
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(panelBtn(page, '2')).toHaveClass(/active/, { timeout: 20_000 })
  await expect(panelPicker(page).locator('.theme-picker-btn.active')).toHaveText(['2'])
})

test('a change made in Settings shows up in the session kebab', async ({ page }) => {
  // The reverse direction — the menu must be a live readout, not a stale snapshot
  // captured when the session panel first mounted.
  await page.setViewportSize({ width: 2560, height: 1200 })
  await setPanelMode(page, '3')
  await openColumnsOnHome(page, ALL_SIDS)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(3, { timeout: 25_000 })

  // Change it in Settings, come back, and read the menu.
  await setPanelMode(page, '1')
  await page.locator('.sidebar a[href="/"]').first().click()
  await expect(columns).toHaveCount(1, { timeout: 25_000 })

  const row = panelsRow(await openSessionKebab(page))
  await expect(row.locator('.task-kebab-tier-btn.active')).toHaveText(['1'])
})

/**
 * EVICTION ORDER on a shrink — only the RIGHTMOST UNLOCKED column may go, and every
 * survivor must stay exactly where it was.
 *
 * Reported as "when I change 3→2 a random window hides". Root cause was
 * `trimUnlockedToMax` rebuilding the strip from its lock-partitioned halves
 * (`[...unlocked.slice(0, keep), ...locked]`), which did two unrequested things:
 *   - a locked column sitting LEFT of the survivors was moved to the right, so a
 *     pinned panel visibly jumped across the strip during an unrelated count change;
 *   - the slice counted within the unlocked run rather than along the visual row, so
 *     with the rightmost column locked it dropped the MIDDLE one.
 * Asserted through the real UI (not just the pure helper) because the visual row order
 * is what the complaint is about.
 */
async function visibleSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('.main-page-sessions-area > .main-page-session-column .session-panel'),
    ).map((el) => el.getAttribute('data-session-id') || '?'),
  )
}

test('3→2 evicts the rightmost column and leaves the others in place', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1200 })
  await setPanelMode(page, '3')
  await openColumnsOnHome(page, ALL_SIDS)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(3, { timeout: 25_000 })
  const before = await visibleSessionIds(page)

  await setPanelMode(page, '2')
  await page.locator('.sidebar a[href="/"]').first().click()
  await expect(columns).toHaveCount(2, { timeout: 25_000 })

  // Exactly the last one went, and the first two kept both their identity AND order.
  expect(await visibleSessionIds(page)).toEqual(before.slice(0, 2))
})

test('a locked column on the left is never shuffled to the right by a shrink', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1200 })
  await setPanelMode(page, '3')
  await openColumnsOnHome(page, ALL_SIDS)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(3, { timeout: 25_000 })

  // Lock the leftmost panel via its real header control. Locking itself REORDERS
  // (locked slots own the right end of the strip, by design), so the assertion below
  // is about a later shrink not moving it again — read the settled order rather than
  // assuming the locked panel is still where it was clicked.
  const lockedId = (await visibleSessionIds(page))[0]
  await columns.first().getByRole('button', { name: /Lock session panel/ }).click()
  await expect(columns.locator('.session-panel-lock.is-locked')).toHaveCount(1, { timeout: 10_000 })
  const before = await visibleSessionIds(page)
  const lockedIdx = before.indexOf(lockedId)
  expect(lockedIdx, 'the locked panel is still on the strip').toBeGreaterThanOrEqual(0)

  await setPanelMode(page, '2')
  await page.locator('.sidebar a[href="/"]').first().click()
  await expect(columns).toHaveCount(2, { timeout: 25_000 })

  const after = await visibleSessionIds(page)
  // THE REGRESSION: a shrink must not re-sort by lock state. The locked panel keeps the
  // index it settled at, and the survivors keep their relative order — the old code
  // rebuilt the row as [unlocked…, locked…], teleporting a left-side pin to the right.
  expect(after).toContain(lockedId)
  expect(after).toEqual(before.filter((id) => after.includes(id)))
  // Exactly one column went, and it was an UNLOCKED one (the pin is exempt).
  expect(after).toHaveLength(2)
  const dropped = before.filter((id) => !after.includes(id))
  expect(dropped).toHaveLength(1)
  expect(dropped[0]).not.toBe(lockedId)
})

test('with the rightmost column locked, the rightmost UNLOCKED one is dropped', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1200 })
  await setPanelMode(page, '3')
  await openColumnsOnHome(page, ALL_SIDS)

  const columns = page.locator('.main-page-sessions-area > .main-page-session-column')
  await expect(columns).toHaveCount(3, { timeout: 25_000 })

  // Lock the RIGHTMOST panel. Locking moves it within the locked region but it is the
  // only lock, so it stays rightmost — re-read the order rather than assuming it.
  const last = columns.last()
  await last.getByRole('button', { name: /Lock session panel/ }).click()
  await expect(columns.locator('.session-panel-lock.is-locked')).toHaveCount(1, { timeout: 10_000 })
  const before = await visibleSessionIds(page)
  const lockedId = await columns
    .filter({ has: page.locator('.session-panel-lock.is-locked') })
    .locator('.session-panel')
    .getAttribute('data-session-id')

  await setPanelMode(page, '2')
  await page.locator('.sidebar a[href="/"]').first().click()
  await expect(columns).toHaveCount(2, { timeout: 25_000 })

  const after = await visibleSessionIds(page)
  // The pinned column survives...
  expect(after).toContain(lockedId!)
  // ...and what went is the rightmost UNLOCKED slot, not simply the last element.
  const droppedExpected = before.filter((id) => id !== lockedId).pop()
  expect(after).not.toContain(droppedExpected)
  // Survivors keep their relative order.
  expect(after).toEqual(before.filter((id) => after.includes(id)))
})
