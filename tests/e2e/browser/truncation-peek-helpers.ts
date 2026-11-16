import { expect, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import { withCssColor } from './css-color'

/** Old floating clones must never return. Kept as a negative assertion across surfaces. */
export const peekPill = (page: Page): Locator => page.getByTestId('truncation-peek')

type Box = { x: number; y: number; width: number; height: number }

/** The page margin a widened row keeps on each side (utils/truncation-peek-row.ts). */
export const PEEK_MARGIN = 8
/** Geometry that must not move: half a pixel covers subpixel rounding, never a real shift. */
const EXACT = 0.5

/** Whether the cut-off text `el` (or one inside it) is marked open by the peek right now. */
export const isOpen = (el: Locator): Promise<boolean> => el.evaluate((node) =>
  !!(node.closest('[data-peek-open]') ?? node.querySelector('[data-peek-open]')))

/**
 * Whether the cut-off text `el` (or one inside it) is open and shows whole on its one line: a
 * row widens sideways (utils/truncation-peek-row.ts), so a text shorter than the window is no
 * longer cut. A text longer than the window may still end in an ellipsis: use `isOpen` and
 * `expectWidensInPlace(..., { capped: true })` for that.
 */
export const openInRow = (el: Locator): Promise<boolean> => el.evaluate((node) => {
  const open = node.closest('[data-peek-open]') ?? node.querySelector('[data-peek-open]')
  return !!open && open.scrollWidth <= open.clientWidth + 1 && open.scrollHeight <= open.clientHeight + 4
})

/** What the page shows of an open (or closed) peek on `row`. */
export const peekState = (row: Locator) => row.evaluate(withCssColor((toRgba) => (el: Element) => {
  const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height })
  const r = el.getBoundingClientRect()
  const open = [...(el.matches('[data-peek-open]') ? [el] : []), ...Array.from(el.querySelectorAll('[data-peek-open]'))]
  const at = document.elementFromPoint(r.right - 3, r.top + r.height / 2)
  const bg = toRgba(getComputedStyle(el).backgroundColor)
  return {
    box: box(r),
    expanded: el.hasAttribute('data-peek-expanded'),
    topLayer: el.matches(':popover-open'),
    expandedCount: document.querySelectorAll('[data-peek-expanded]').length,
    placeholders: Array.from(document.querySelectorAll<HTMLElement>('[data-peek-placeholder]')).map((p) => ({
      box: box(p.getBoundingClientRect()), empty: p.childNodes.length === 0, inert: p.inert && p.getAttribute('aria-hidden') === 'true',
    })),
    openCount: open.length,
    nowrap: open.every((o) => getComputedStyle(o).whiteSpace === 'nowrap'),
    // The widened part covers what is beside it: the row is on top at its own right edge.
    onTop: !!at && el.contains(at),
    bgAlpha: bg[3],
    bgLuma: (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255,
    viewport: window.innerWidth,
  }
}))

const near = (a: number, b: number) => Math.abs(a - b) <= EXACT

/**
 * Where a widened row of width `width` sits (2026-11-15, the user picked design 01 with 02's
 * fallback): its left edge stays and it grows to the right; when the window has no room for that,
 * it grows to the left from its own right edge instead, and never past the window's left margin.
 */
export function expectedLeft(before: Box, width: number, viewport: number): number {
  const left = Math.max(before.x, PEEK_MARGIN)
  if (left + width <= viewport - PEEK_MARGIN + EXACT) return left
  return Math.max(PEEK_MARGIN, Math.min(before.x + before.width, viewport - PEEK_MARGIN) - width)
}

/**
 * The whole real row is open and wider, never taller (2026-11-15, the user: the whole card gets
 * wider, not taller): it sits in the top layer at its own top and height, an empty placeholder
 * holds `before` in the list (so no neighbour moves), every open text stays on one line, and its
 * left edge stays unless the window has no room on the right (`expectedLeft`). `capped`: the text
 * is longer than the window, so the row takes the whole width it may and its text may still end
 * in an ellipsis. `theme`: the opaque background matches it.
 */
export async function expectWidensInPlace(row: Locator, before: Box, opts: { label?: string; capped?: boolean; theme?: 'light' | 'dark' } = {}): Promise<Box> {
  const label = opts.label ?? 'row'
  await expect.poll(async () => (await peekState(row)).topLayer, `${label}: the real row opens in the top layer`).toBe(true)
  // The reveal clips the row open for a moment; once it ends the row is hit at its new right edge.
  await expect.poll(async () => (await peekState(row)).onTop, `${label}: the widened part covers what is beside it`).toBe(true)
  const s = await peekState(row)
  const b = s.box
  expect(s.expanded, `${label}: marked expanded`).toBe(true)
  expect(s.expandedCount, `${label}: one open row at a time`).toBe(1)
  expect(s.openCount, `${label}: its cut-off texts are open`).toBeGreaterThan(0)
  expect(s.nowrap, `${label}: every open text stays on one line`).toBe(true)
  expect(b.width, `${label}: wider than it was`).toBeGreaterThan(before.width + 1)
  expect(near(b.y, before.y), `${label}: same top (${b.y} vs ${before.y})`).toBe(true)
  expect(near(b.height, before.height), `${label}: same height (${b.height} vs ${before.height})`).toBe(true)
  expect(b.width, `${label}: at most the window less its margins`).toBeLessThanOrEqual(s.viewport - 2 * PEEK_MARGIN + EXACT)
  const left = expectedLeft(before, b.width, s.viewport)
  expect(near(b.x, left), `${label}: left edge ${b.x}, expected ${left} (grows right, or left when the window has no room)`).toBe(true)
  expect(b.x + b.width, `${label}: inside the window's right margin`).toBeLessThanOrEqual(s.viewport - PEEK_MARGIN + EXACT)
  if (opts.capped) expect(b.width, `${label}: a line longer than the window takes all of it`).toBeGreaterThan(s.viewport - 2 * PEEK_MARGIN - 2)
  expect(s.placeholders.length, `${label}: one placeholder holds its place`).toBe(1)
  const p = s.placeholders[0]
  expect(p.empty && p.inert, `${label}: the placeholder is an empty, inert, hidden shell (no copied text)`).toBe(true)
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(near(p.box[k], before[k]), `${label}: placeholder ${k} ${p.box[k]} vs ${before[k]}`).toBe(true)
  expect(s.bgAlpha, `${label}: an opaque background, so nothing under it shows through`).toBeGreaterThan(0.95)
  if (opts.theme === 'dark') expect(s.bgLuma, `${label}: a dark background in the dark theme`).toBeLessThan(0.5)
  if (opts.theme === 'light') expect(s.bgLuma, `${label}: a light background in the light theme`).toBeGreaterThan(0.5)
  await expect(peekPill(row.page()), `${label}: no floating text pill`).toHaveCount(0)
  return b
}

/** The row is back where and as it was: out of the top layer, no marks, no placeholder. */
export async function expectRestored(row: Locator, before: Box, label = 'row'): Promise<void> {
  await expect.poll(async () => (await peekState(row)).topLayer, `${label}: out of the top layer`).toBe(false)
  const s = await peekState(row)
  expect(s.expanded, `${label}: unmarked`).toBe(false)
  expect(s.openCount, `${label}: no open text left`).toBe(0)
  // Another row may already be open. Only this row's empty shell must be gone.
  expect(await row.evaluate(el => el.previousElementSibling?.hasAttribute('data-peek-placeholder') ?? false), `${label}: its placeholder removed`).toBe(false)
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(near(s.box[k], before[k]), `${label}: ${k} ${s.box[k]} vs ${before[k]}`).toBe(true)
}

/** The tops of `others`, to compare after a peek: none of them may move. */
export const topsOf = (others: Locator[]): Promise<number[]> => Promise.all(others.map(async (o) => (await o.boundingBox())!.y))
export async function expectStill(others: Locator[], tops: number[], label = 'neighbour'): Promise<void> {
  const now = await topsOf(others)
  now.forEach((y, i) => expect(near(y, tops[i]), `${label} ${i}: did not move (${y} vs ${tops[i]})`).toBe(true))
}

/**
 * Cut-off text shows its whole text in place on hover, never in a native tooltip (2026-11-12,
 * the user: "make the full line expanded like what we did for side bar"; 2026-11-15: the whole
 * row widens, never grows taller): the element carries no title of its own, hovering it opens
 * its row wider at the placeholder's exact top and height with `text` whole on its line, and
 * leaving ends that. The element is scrolled into view first and hovered again until it shows:
 * a scroll ends a peek (truncation-peek.ts), and the one Playwright's hover makes can land after it.
 */
export async function expectPeeksInPlace(el: Locator, text: string, label: string): Promise<void> {
  const page = el.page()
  expect.soft(await el.getAttribute('title'), `${label}: no native title of its own`).toBeNull()
  await el.scrollIntoViewIfNeeded()
  await expect(async () => {
    await page.mouse.move(1, 1)
    await el.hover()
    await expect.poll(() => openInRow(el), { timeout: 2_000 }).toBe(true)
    await expect(peekPill(page)).toHaveCount(0)
  }, `${label}: hovering it shows the whole text in place`).toPass({ timeout: 15_000 })
  await expect(el).toContainText(text)
  // Its row is wider at the place it held, as tall as it was.
  const held = await el.evaluate((node) => {
    const row = node.closest('[data-peek-expanded]')
    const spot = document.querySelector('[data-peek-placeholder]')
    if (!row || !spot) return null
    const r = row.getBoundingClientRect()
    const p = spot.getBoundingClientRect()
    return { dy: r.top - p.top, dh: r.height - p.height, dw: r.width - p.width }
  })
  expect.soft(held, `${label}: its row is open over a placeholder`).not.toBeNull()
  if (held) {
    expect.soft(Math.abs(held.dy), `${label}: same top`).toBeLessThanOrEqual(EXACT)
    expect.soft(Math.abs(held.dh), `${label}: same height`).toBeLessThanOrEqual(EXACT)
    expect.soft(held.dw, `${label}: wider`).toBeGreaterThan(0)
  }
  await page.mouse.move(1, 1)
  await expect.soft(peekPill(page).filter({ hasText: text }), `${label}: the peek closes when the pointer leaves`).toHaveCount(0)
  let closed = false
  for (let i = 0; i < 20 && !closed; i++) { closed = !(await isOpen(el)); if (!closed) await page.waitForTimeout(100) }
  expect.soft(closed, `${label}: the row closes when the pointer leaves`).toBe(true)
  await expect.soft(page.locator('[data-peek-placeholder]'), `${label}: its placeholder goes with it`).toHaveCount(0)
}

/** Whether `el` itself shows its whole text on its line (open or never cut). */
export const fits = (el: Locator): Promise<boolean> => el.evaluate((n) => n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1)

/** Marks the element after `row` so a test can measure it while `row` is open (the placeholder goes before the row). */
export async function followingOf(row: Locator, tag: string): Promise<Locator | null> {
  const marked = await row.evaluate((el, t) => {
    const n = el.nextElementSibling
    if (!n || n.getClientRects().length === 0) return false
    n.setAttribute('data-test-following', t)
    return true
  }, tag)
  return marked ? row.page().locator(`[data-test-following="${tag}"]`) : null
}

/**
 * A dense inbox card widens as a whole and keeps its actions (shared by the fixture spec and the
 * real-letter walk-through): the pointer on blank card padding opens it at its own top and height,
 * its subject shows whole, its long preview stays one line (it is longer than the window, so it
 * may still end in an ellipsis), the neighbouring cards never move, and leaving restores it, three
 * times over. Its real buttons work while it is open, and it opens again after the window narrows.
 */
export async function expectInboxCardWidens(page: Page, card: Locator, neighbours: Locator[], info: TestInfo): Promise<void> {
  await card.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  const before = (await card.boundingBox())!
  const tops = await topsOf(neighbours)
  expect(await fits(card.locator('.hib-subject')), 'the subject is cut before the hover').toBe(false)
  await page.screenshot({ path: info.outputPath('before.png') })
  for (let round = 0; round < 3; round++) {
    // Blank card padding is enough, not only the text itself.
    await card.hover({ position: { x: before.width - 6, y: 6 } })
    await expectWidensInPlace(card, before, { label: `card round ${round}`, capped: true })
    await expect.poll(() => fits(card.locator('.hib-subject'))).toBe(true)
    expect(await isOpen(card.locator('.hib-preview'))).toBe(true)
    await expectStill(neighbours, tops, 'card')
    await expect(card.locator('.hib-card-toggle')).toHaveAttribute('aria-expanded', 'false')
    if (round === 0) await page.screenshot({ path: info.outputPath('whole-card.png') })
    await page.mouse.move(1, 1)
    await expectRestored(card, before, `card round ${round}`)
  }
  // The open card is the real one: its buttons get the press, and nothing else opens.
  await card.hover({ position: { x: before.width - 6, y: 6 } })
  await expectWidensInPlace(card, before, { label: 'card before Pin', capped: true })
  await card.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible()
  await expect(page.locator('.hib-reader')).toHaveCount(0)
  await card.getByRole('button', { name: 'Read letter', exact: true }).click()
  await expect(card.locator('.hib-card-toggle')).toHaveAttribute('aria-expanded', 'true')
  await page.mouse.move(1, 1)
  await expect(card.locator('.hib-card-expand')).toHaveClass(/is-expanded/)
  await card.getByRole('button', { name: 'Collapse', exact: true }).click()
  await page.mouse.move(1, 1)
  // A narrow window: it still opens sideways inside the window.
  await page.setViewportSize({ width: 720, height: 800 })
  await card.scrollIntoViewIfNeeded()
  const narrow = (await card.boundingBox())!
  await card.hover({ position: { x: 5, y: 5 } })
  await expectWidensInPlace(card, narrow, { label: 'card at 720px', capped: true })
  // This subject itself may exceed a narrow viewport. It stays one line at the width cap.
  expect(await card.locator('.hib-subject').evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap')
  await page.mouse.move(1, 1)
  await expectRestored(card, narrow, 'card at 720px')
  await card.locator('.hib-subject').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.hib-reader')).toBeVisible()
}

/**
 * A task row whose worker chip names a long lead (shared by the fixture spec and the real-task
 * walk-through): at a wide and a cramped panel, in both themes, the whole row widens with the
 * chip and the title whole on their own lines, the metadata line stays one line above the title,
 * the chip stays beside its Worker label, the row below never moves, and leaving restores it.
 */
export async function expectWorkerRowWidens(page: Page, request: APIRequestContext, titles: { project: string; lead: string; worker: string }, info: TestInfo): Promise<void> {
  const { presetPanelDesign, setStatusSectionOpen } = await import('./status-section-helpers')
  const { showAllSections } = await import('./todo-panel-helpers')
  const { home } = await import('./inbox-items-helpers')
  const made: string[] = []
  const create = async (title: string, extra: { parent_task_id?: string; phase?: string } = {}) => {
    const res = await request.post('/api/tasks', { data: { title, project: titles.project, source: 'local', ...extra } })
    expect(res.status()).toBe(201)
    const id = (await res.json()).task.id as string
    made.push(id)
    if (extra.phase) expect((await request.patch(`/api/tasks/${id}`, { data: { phase: extra.phase } })).ok()).toBe(true)
    return id
  }
  try {
    const lead = await create(titles.lead)
    const worker = await create(titles.worker, { parent_task_id: lead, phase: 'NEED_ACTION' })
    await create('Next garden task below the worker', { phase: 'NEED_ACTION' })
    await presetPanelDesign(page, 'status')
    await home(page)
    await showAllSections(page)
    await setStatusSectionOpen(page.locator('.todo-panel').first(), 'needs', true)
    const row = page.locator(`.status-section-card[data-task-id="${worker}"]`).first()
    await expect(row).toBeVisible()
    await row.scrollIntoViewIfNeeded()
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      for (const width of [640, 300]) {
        await page.mouse.move(1, 1)
        // Change the real panel width, not the font or the chip, so this tests the cramped layout.
        await row.evaluate((el, w) => { const panel = el.closest<HTMLElement>('#home-task-navigation')!; panel.style.width = `${w}px`; panel.style.minWidth = `${w}px`; panel.style.maxWidth = `${w}px`; }, width)
        await row.scrollIntoViewIfNeeded()
        const label = `worker ${theme} ${width}`
        const before = (await row.boundingBox())!
        const chipBefore = (await row.locator('.task-worker-parent').boundingBox())!
        const metaBefore = (await row.locator('.status-card-meta').boundingBox())!
        const following = await followingOf(row, `worker-${theme}-${width}`)
        const tops = following ? await topsOf([following]) : []
        await row.locator('.todo-pinned-title').hover({ position: { x: 12, y: 6 } })
        const after = await expectWidensInPlace(row, before, { label, theme })
        await expect.poll(() => openInRow(row.locator('.task-worker-parent'))).toBe(true)
        // The title shows whole too, whether the wide panel cut it or not.
        await expect.poll(() => fits(row.locator('.todo-pinned-title'))).toBe(true)
        const meta = (await row.locator('.status-card-meta').boundingBox())!
        const title = (await row.locator('.todo-pinned-title').boundingBox())!
        const chip = (await row.locator('.task-worker-parent').boundingBox())!
        const workerLabel = (await row.locator('.task-pill-long').boundingBox())!
        expect(chip.width, `${label}: the chip shows the whole lead`).toBeGreaterThan(chipBefore.width + 40)
        expect(Math.abs(meta.height - metaBefore.height), `${label}: the metadata stays one line`).toBeLessThanOrEqual(EXACT)
        expect(meta.y + meta.height, `${label}: the metadata stays above the title`).toBeLessThanOrEqual(title.y + 1)
        // The compact panel abbreviates Worker to W in a pseudo-element.
        if (workerLabel) expect(chip.y, `${label}: the chip stays beside its label`).toBeCloseTo(workerLabel.y, 0)
        expect(title.x + title.width, `${label}: the title ends inside the row`).toBeLessThanOrEqual(after.x + after.width + 1)
        const time = await row.locator('.todo-recent-ago').boundingBox()
        if (time) expect(time.x + time.width, `${label}: the time stays inside the row`).toBeLessThanOrEqual(after.x + after.width + 1)
        if (following) await expectStill([following], tops, `${label}: the row below`)
        await page.screenshot({ path: info.outputPath(`worker-${theme}-${width}.png`) })
        await page.mouse.move(1, 1)
        await expectRestored(row, before, label)
      }
    }
  } finally {
    for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`)
  }
}
