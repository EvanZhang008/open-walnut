/**
 * Tree drawer (spec 6): opening, geometry, the pointer-geometry peek close, rows,
 * search, filters, the Hidden group, contrast and timing. Runs on the dense
 * fixture (30 questions over 5 levels, 10 pins), reset before every test, in
 * Chromium and WebKit (the Mac app is WKWebView).
 *
 * Checklist: C7, C27, C28, C29, C31, C32, C37, C38, C45, C56, C63, C67, C75 (C48, the header count bump, left with the count pill).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  DENSE_SESSION, REWRITTEN_SESSION, openThreadsSession, readRecord, resetThreadsFixture, noBannedGlyphs, modePill, openQuestionList,
} from './threads-helpers'
import { DENSE_EXPECTED_COUNTS } from './threads-fixture'

const TASK = 'pw-task-threads-dense'

async function pinPanelWidth(page: Page, sessionId: string, width: number): Promise<void> {
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${sessionId}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
}

async function openDense(page: Page, opts: { width?: number; sessionId?: string; taskId?: string } = {}): Promise<Locator> {
  const sessionId = opts.sessionId ?? DENSE_SESSION
  await page.goto('/')
  if (opts.width) await pinPanelWidth(page, sessionId, opts.width)
  const panel = await openThreadsSession(page, sessionId, opts.taskId ?? TASK)
  await expect(modePill(panel)).toBeVisible({ timeout: 30_000 })
  await settled(panel)
  return panel
}

/** Opening a column scrolls the Homepage smoothly: measure only once it rests. */
async function settled(panel: Locator): Promise<void> {
  let last = ''
  await expect.poll(async () => {
    const now = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return `${r.x},${r.y},${r.width}`
    })
    const same = now === last
    last = now
    return same
  }, { intervals: [150], timeout: 15_000 }).toBe(true)
}

const drawerOf = (panel: Locator) => panel.locator('.thread-drawer')
const rowTitled = (panel: Locator, title: string) =>
  panel.locator('.thread-tree-row').filter({ has: panel.page().locator('.thread-tree-title', { hasText: title }) })

async function openDrawer(panel: Locator): Promise<Locator> {
  const drawer = await openQuestionList(panel.page(), panel)
  await expect(drawer).toHaveAttribute('data-mode', 'open')
  // Geometry is measured after the 160ms slide-in, never mid-animation.
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  return drawer
}

async function chip(drawer: Locator, name: 'All' | 'Open' | 'Pinned'): Promise<Locator> {
  return drawer.locator('.thread-drawer-chip', { hasText: new RegExp(`^${name}\\b`) })
}

const box = (loc: Locator) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, padLeft: cs.paddingLeft }
})

test.describe('tree drawer', () => {
  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, DENSE_SESSION)
    await resetThreadsFixture(request, REWRITTEN_SESSION)
  })

  for (const width of [480, 1400]) {
    test(`opening the drawer never changes the transcript box at ${width}px (C7, C27)`, async ({ page }) => {
      const panel = await openDense(page, { width })
      const pill = modePill(panel)
      const c = DENSE_EXPECTED_COUNTS
      // The header holds the mode pill alone; the counts live in the map. The
      // map's count keeps the word and drops the second number (N28: `9 · 4` said nothing).
      // These specs open in Tree Mode, so the pill offers Conversation Mode.
      await expect(pill).toHaveText(width < 560 ? '' : 'Conversation Mode')
      await expect(pill).toHaveAttribute('title', 'Switch to Conversation Mode')
      const map = panel.locator('.thread-map')
      if (width >= 640) await expect(map.locator('.thread-map-count')).toHaveText(`${c.open} open`)
      const history = panel.locator('.session-history').first()
      // A 1400px panel is wider than the viewport: Playwright's click scrolls the
      // columns to reach the map's list button (top left of the timeline), so
      // bring that into view before measuring.
      if (width >= 640) await map.locator('.thread-map-icon[aria-label="Open the question list"]').scrollIntoViewIfNeeded()
      else await pill.scrollIntoViewIfNeeded()
      await settled(panel)
      // The box's place INSIDE its panel: the columns strip may scroll sideways
      // to reach a control of a panel wider than the viewport, which moves both.
      const before = { ...(await box(history)), px: (await box(panel)).x }
      const drawer = await openDrawer(panel)
      const after = { ...(await box(history)), px: (await box(panel)).x }
      // Float noise below a layout unit (1/64 px) is not a change; anything real is.
      expect(Math.abs(after.width - before.width)).toBeLessThan(0.01)
      expect(Math.abs((after.x - after.px) - (before.x - before.px))).toBeLessThan(0.01)
      expect(after.padLeft).toBe(before.padLeft)
      const d = await box(drawer)
      const pb = await box(panel)
      expect(d.x).toBeGreaterThanOrEqual(pb.x)
      expect(d.right).toBeLessThanOrEqual(pb.right)
      const expectW = pb.width < 420 ? pb.width - 24 : Math.min(300, pb.width - 56)
      expect(Math.abs(d.width - expectW)).toBeLessThanOrEqual(1)
      await noBannedGlyphs(page, drawer)
    })
  }

  test('the shortcut opens the drawer and focuses the current row (C27)', async ({ page }) => {
    const panel = await openDense(page)
    // Focus inside the panel (the router picks the focused panel first).
    await panel.locator('textarea').first().click()
    // The chord follows the PAGE's platform (the Desktop Chrome device reports
    // Windows even on a Mac host), the way usePanelKeyRouter reads it.
    const mac = await page.evaluate(() => /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent))
    const chord = mac ? 'Meta+Shift+E' : 'Control+Shift+E'
    await page.keyboard.press(chord)
    const drawer = drawerOf(panel)
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    const focused = drawer.locator('.thread-tree-row:focus')
    await expect(focused).toHaveAttribute('aria-selected', 'true')
    await expect(focused).toHaveAttribute('data-kind', 'root')
    await page.keyboard.press(chord)
    await expect(drawer).toHaveCount(0)
  })

  test('the left edge peeks only on an entry from inside the panel content (C63, C28)', async ({ page }) => {
    const panel = await openDense(page, { width: 700 })
    const pb = await box(panel)
    const y = pb.y + pb.height / 2
    // From outside the panel (a neighbour, the sidebar): never arms.
    await page.mouse.move(Math.max(1, pb.x - 30), y)
    await page.mouse.move(pb.x + 3, y, { steps: 2 })
    await page.waitForTimeout(1000)
    await expect(drawerOf(panel)).toHaveCount(0)
    // Leave the band, then come in from the content: peeks after the dwell.
    await page.mouse.move(pb.x + 200, y, { steps: 4 })
    await page.mouse.move(pb.x + 3, y, { steps: 6 })
    await expect(drawerOf(panel)).toHaveAttribute('data-mode', 'peek', { timeout: 2000 })
    // Moving over rows (they re-render under the pointer) does not close it.
    const d = await box(drawerOf(panel))
    for (let i = 0; i < 6; i++) await page.mouse.move(d.x + 40 + i * 20, d.y + 120 + i * 30, { steps: 3 })
    await page.waitForTimeout(600)
    await expect(drawerOf(panel)).toHaveAttribute('data-mode', 'peek')
    // Out of the extended rect: closes after ~260ms.
    await page.mouse.move(pb.right - 60, y + 40, { steps: 6 })
    await expect(drawerOf(panel)).toHaveCount(0, { timeout: 2000 })
    // Peek again; a focused search blocks the close.
    await page.mouse.move(pb.x + 200, y, { steps: 6 })
    await page.mouse.move(pb.x + 3, y, { steps: 6 })
    await expect(drawerOf(panel)).toHaveAttribute('data-mode', 'peek', { timeout: 2000 })
    await drawerOf(panel).locator('.thread-drawer-search-input').evaluate((el) => (el as HTMLInputElement).focus())
    await page.mouse.move(pb.right - 60, y + 40, { steps: 6 })
    await page.waitForTimeout(800)
    await expect(drawerOf(panel)).toHaveAttribute('data-mode', 'peek')
  })

  test('rows: disclosure only with children, pins under their question, current row selected (C29)', async ({ page }) => {
    const panel = await openDense(page)
    let drawer = await openDrawer(panel)
    await (await chip(drawer, 'All')).click()
    const first = drawer.locator('.thread-tree-row').first()
    await expect(first).toHaveAttribute('data-kind', 'root')
    await expect(first.locator('.thread-tree-title')).toHaveText('Main conversation')
    await expect(drawer.locator('[role="tree"][aria-label="All questions"]')).toBeVisible()
    const q1 = rowTitled(drawer, 'Buffer flush order')
    await expect(q1).toHaveAttribute('aria-level', '2')
    await expect(q1.locator('.thread-tree-guide')).toHaveCount(1)
    await expect(q1).toHaveAttribute('aria-expanded', 'true')
    const pinRow = drawer.locator('.thread-tree-row[data-kind="pin"]').first()
    await expect(pinRow).toHaveAttribute('data-lines', '1')
    expect(Math.round((await box(pinRow)).height)).toBe(30)
    await expect(pinRow.locator('svg[data-thread-icon="pin"]')).toHaveCount(1)
    expect(Math.round((await box(q1)).height)).toBe(44)
    const leaves = drawer.locator('.thread-tree-row[data-kind="thread"]:not([aria-expanded])')
    expect(await leaves.count()).toBeGreaterThan(0)
    await expect(leaves.first().locator('.thread-tree-disclosure svg')).toHaveCount(0)
    // Jump into Q1, reopen: its row is selected and in view.
    await q1.click()
    await expect(drawer).toHaveCount(0)
    drawer = await openDrawer(panel)
    const selected = drawer.locator('.thread-tree-row[aria-selected="true"]')
    await expect(selected).toHaveCount(1)
    await expect(selected.locator('.thread-tree-title')).toHaveText('Buffer flush order')
    await expect(selected).toBeInViewport()
  })

  test('search: matches with faded ancestors, bold hits, no results and Show all (C31)', async ({ page }) => {
    const panel = await openDense(page)
    const drawer = await openDrawer(panel)
    const search = drawer.locator('.thread-drawer-search-input')
    await expect(search).toHaveAttribute('placeholder', 'Search questions and pins')
    await search.fill('flush order')
    const hit = drawer.locator('.thread-tree-hit').first()
    await expect(hit).toHaveText(/flush order/i)
    expect(await hit.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('650')
    expect(await hit.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    await search.fill('point 26 change')
    const q26 = drawer.locator('.thread-tree-row[data-kind="thread"]:not([data-ancestor-only])')
    await expect(q26).toHaveCount(1)
    // Polled: the list follows the search through a deferred value, so the ONE
    // matched row of the previous query ('flush order') can satisfy the count
    // above for a frame before this query's rows land.
    await expect.poll(() => drawer.locator('.thread-tree-row[data-ancestor-only="true"]').count()).toBeGreaterThanOrEqual(3)
    expect(await drawer.locator('.thread-tree-row[data-ancestor-only="true"]').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('0.55')
    await search.fill('zebra crossing')
    await expect(drawer.locator('.thread-tree-empty')).toContainText('No questions match “zebra crossing”.')
    await drawer.getByRole('button', { name: 'Show all' }).click()
    await expect(search).toHaveValue('')
    await expect(await chip(drawer, 'All')).toHaveAttribute('aria-pressed', 'true')
    await expect(drawer.getByRole('button', { name: 'Clear search' })).toHaveCount(0)
  })

  test('filters: Open lists open questions, Pinned lists pins; chip counts ignore the search (C32)', async ({ page }) => {
    const panel = await openDense(page)
    const drawer = await openDrawer(panel)
    const c = DENSE_EXPECTED_COUNTS
    await expect(await chip(drawer, 'All')).toHaveText(`All ${c.all}`)
    // N43: `Open` counts what the summary calls open; the filter also lists the
    // ones that to check, and the chip's tooltip says so.
    await expect(await chip(drawer, 'Open')).toHaveText(`Open ${c.open}`)
    await expect(await chip(drawer, 'Open')).toHaveAttribute('title', `${c.open} open, ${c.suggested} to check`)
    await expect(await chip(drawer, 'Pinned')).toHaveText(`Pinned ${c.pinned}`)
    await (await chip(drawer, 'Open')).click()
    const matched = drawer.locator('.thread-tree-row[data-kind="thread"]:not([data-ancestor-only])')
    await expect(matched).toHaveCount(c.open + c.suggested)
    for (const s of await matched.evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))) {
      expect(['open', 'suggested', 'queued', 'answering', 'failed']).toContain(s)
    }
    await expect(drawer.locator('.thread-tree-row[data-kind="pin"]')).toHaveCount(0)
    await (await chip(drawer, 'Pinned')).click()
    await expect(drawer.locator('.thread-tree-row[data-kind="pin"]')).toHaveCount(c.pinned)
    await expect(drawer.locator('.thread-tree-row[data-kind="thread"]:not([data-ancestor-only])')).toHaveCount(0)
    await drawer.locator('.thread-drawer-search-input').fill('point')
    await expect(await chip(drawer, 'Pinned')).toHaveText(`Pinned ${c.pinned}`)
    await expect(await chip(drawer, 'All')).toHaveText(`All ${c.all}`)
    await expect(drawer.locator('.thread-drawer-summary')).toHaveText(`${c.open} open · ${c.suggested} to check · ${c.done} done · ${c.pinned} pinned`)
  })

  test('first open lands on Open, the choice is remembered, done rows fold per parent (C67)', async ({ page }) => {
    const panel = await openDense(page)
    let drawer = await openDrawer(panel)
    await expect(await chip(drawer, 'Open')).toHaveAttribute('aria-pressed', 'true')
    await (await chip(drawer, 'All')).click()
    await drawer.getByRole('button', { name: 'Close (Esc)' }).click()
    await expect(drawer).toHaveCount(0)
    drawer = await openDrawer(panel)
    await expect(await chip(drawer, 'All')).toHaveAttribute('aria-pressed', 'true')
    const group = drawer.locator('.thread-tree-row[data-kind="done-group"]', { hasText: '3 done' })
    await expect(group).toHaveCount(1)
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    await expect(rowTitled(drawer, 'Checksum per page')).toHaveCount(0)
    await group.click()
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect(rowTitled(drawer, 'Checksum per page')).toHaveCount(1)
    await group.click()
    await expect(rowTitled(drawer, 'Checksum per page')).toHaveCount(0)
  })

  test('Show hidden questions opens the Hidden group and Restore brings one back (C45)', async ({ page, request }) => {
    const panel = await openDense(page)
    // The offer lives in the drawer, under All (the root More menu is gone).
    const drawer = await openDrawer(panel)
    await (await chip(drawer, 'All')).click()
    await drawer.getByRole('button', { name: 'Show hidden questions (3)' }).click()
    await expect(drawer.locator('.thread-tree-group-label')).toHaveText('Hidden')
    const hidden = drawer.locator('.thread-tree-row[data-kind="hidden"]')
    await expect(hidden).toHaveCount(3)
    const before = (await readRecord(request, DENSE_SESSION)).threadMeta!.filter((m) => m.hidden === true).length
    await hidden.first().getByRole('button', { name: 'Restore' }).click()
    await expect(hidden).toHaveCount(2)
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!.filter((m) => m.hidden === true).length)
      .toBe(before - 1)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`titles keep >= 4.5:1 over the dense transcript in ${theme} (C37)`, async ({ page }) => {
      const panel = await openDense(page)
      await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
      const drawer = await openDrawer(panel)
      await (await chip(drawer, 'All')).click()
      const ratios = await drawer.evaluate((root) => {
        const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }
        const body = root.querySelector('.thread-drawer-body')!
        const bg = parse(getComputedStyle(body).backgroundColor)
        const titles = Array.from(root.querySelectorAll('.thread-tree-row:not([data-ancestor-only]):not([data-settled]) .thread-tree-title')).slice(0, 8)
        return { alpha: bg[3] ?? 1, ratios: titles.map((t) => {
          const fg = parse(getComputedStyle(t).color)
          const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
          return (a + 0.05) / (b + 0.05)
        }) }
      })
      expect(ratios.alpha).toBeGreaterThanOrEqual(0.94)
      expect(ratios.ratios.length).toBeGreaterThanOrEqual(5)
      for (const r of ratios.ratios) expect(r).toBeGreaterThanOrEqual(4.5)
    })
  }

  test('opens under 100ms and each search key is handled within a frame (C38)', async ({ page }) => {
    const panel = await openDense(page, { width: 900 })
    // Warm the drawer once (module code, first layout), then time a real open.
    await openDrawer(panel)
    await page.keyboard.press('Escape')
    await expect(drawerOf(panel)).toHaveCount(0)
    // The map's list button (the panel shape shows it outright).
    await expect(panel.locator('.thread-map')).toHaveAttribute('data-shape', 'panel')
    const openMs = await panel.evaluate(async (root) => {
      const btn = root.querySelector<HTMLButtonElement>('.thread-map-icon[aria-label="Open the question list"]')!
      const t0 = performance.now()
      btn.click()
      while (!root.querySelector('.thread-drawer .thread-tree-row')) await new Promise((r) => requestAnimationFrame(r))
      return performance.now() - t0
    })
    expect(openMs).toBeLessThan(100)
    const perKey = await panel.evaluate(async (root) => {
      const input = root.querySelector<HTMLInputElement>('.thread-drawer-search-input')!
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const times: number[] = []
      let text = ''
      for (const ch of 'point 2') {
        text += ch
        const t0 = performance.now()
        setter.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        times.push(performance.now() - t0)
        await new Promise((r) => requestAnimationFrame(r))
      }
      return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]
    })
    expect(perKey).toBeLessThan(16)
  })

  test('older questions: not counted open, lazily named, `Mark older questions done` with Undo (C56)', async ({ page, request }) => {
    const inFlight = { now: 0, max: 0 }
    const metaWrites: Array<Array<Record<string, unknown>>> = []
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || !r.url().includes(`/api/sessions/${DENSE_SESSION}`)) return
      const body = r.postDataJSON() as { thread_meta?: Array<Record<string, unknown>> } | null
      if (!body?.thread_meta?.every((e) => e.titleState === 'pending')) return
      metaWrites.push(body.thread_meta)
      inFlight.now += 1
      inFlight.max = Math.max(inFlight.max, inFlight.now)
    })
    page.on('requestfinished', (r) => { if (r.method() === 'PATCH' && r.url().includes(DENSE_SESSION) && inFlight.now > 0) inFlight.now -= 1 })
    const panel = await openDense(page, { width: 900 })
    const c = DENSE_EXPECTED_COUNTS
    await expect(panel.locator('.thread-map .thread-map-count')).toHaveText(new RegExp(`^${c.open} `))
    const drawer = await openDrawer(panel)
    await (await chip(drawer, 'All')).click()
    await expect(drawer.locator('.thread-tree-row[data-status="older"]').first()).toBeVisible()
    await page.waitForTimeout(800)
    expect(inFlight.max).toBeLessThanOrEqual(2)
    expect(metaWrites.flat().length).toBeLessThanOrEqual(10)
    for (const e of metaWrites.flat()) expect(e.status).toBe('older')
    await expect(drawer.locator('.thread-drawer-older')).toContainText(`${c.older} older questions`)
    await drawer.getByRole('button', { name: 'Mark older questions done' }).click()
    const toast = panel.page().locator('.thread-toast')
    await expect(toast).toContainText(`Marked ${c.older} older questions done`)
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!.filter((m) => m.status === 'older').length).toBe(0)
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!.filter((m) => m.status === 'older').length)
      .toBeGreaterThanOrEqual(1)
  })

  test('`1 open` to `All done` moves nothing in the header (C75)', async ({ page }) => {
    const panel = await openDense(page, { sessionId: REWRITTEN_SESSION, taskId: 'pw-task-threads-rewritten', width: 900 })
    const pill = modePill(panel)
    const count = panel.locator('.thread-map .thread-map-count')
    await expect(count).toHaveText('1 open')
    const header = panel.locator('.session-panel-header')
    const xs = () => header.evaluate((el) => Array.from(el.querySelectorAll('button')).map((b) => Math.round(b.getBoundingClientRect().right)))
    const before = { pill: await box(pill), xs: await xs() }
    const drawer = await openDrawer(panel)
    const row = rowTitled(drawer, 'Cache expiry claim')
    await row.hover()
    await row.getByRole('button', { name: 'Mark done' }).click()
    // The count changes in the map; the header keeps every button where it was.
    await expect(count).toHaveText('All done')
    await expect(count).toHaveAttribute('data-all-done', 'true')
    expect((await box(pill)).width).toBe(before.pill.width)
    expect(await xs()).toEqual(before.xs)
  })
})

