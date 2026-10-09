/**
 * The question map (spec slice 1b): a session with questions always shows its
 * question tree in the timeline's top-left corner. A wide column reserves a
 * gutter for the labelled tree; a narrow one shows a rail of marks whose list
 * opens on hover, focus or a tap. Nobody has to know about the header pill or
 * the drawer's edge to find the questions.
 *
 * Covers C1 to C30 of demo/thread-designs/spec-slice1b-question-map.md on the
 * map fixture (8 questions over 3 levels, one hidden, CJK titles, 2 pins, a
 * table and a code block in the root answers), plus the dense fixture for a
 * long map and sessions without questions (none, and pins only) for
 * "unchanged". C20/C21 (unread, live status) ride the send spec, the only
 * fixture whose answers arrive live; C25 is session-thread-perf.spec.ts, whose
 * sessions now mount the map.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  AI_SESSION, centreInHistory, DENSE_SESSION, NO_THREAD_SESSION, noBannedGlyphs, openThreadsSession, passageRects, selectPassage, sessionPanel, modePill, openQuestionList, switchView,
} from './threads-helpers'
import {
  AI_PASSAGE, buildMapSession, MAP_PASSAGES, MAP_PIN_QUOTE_TEXT, MAP_SESSION, MAP_TITLES, PINS_ONLY_READY, PINS_ONLY_SESSION,
  PINS_ONLY_TASK,
} from './threads-fixture'

const MAP_TASK = 'pw-task-threads-map'
/** Row ids are derived from a fixed prefix, so any clock gives the same ones. */
const MAP_IDS = buildMapSession(Date.now()).ids
const MAP_READY = 'Summarize the open risks.'
const DENSE_TASK = 'pw-task-threads-dense'
const DENSE_READY = 'Walk me through part 6 of the storage notes.'
/** Session column widths: the labelled panel from 640px up, the rail below. */
const WIDE = 720
const NARROW = 480

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/thread-map/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

/** Pin one session's home column to `width` (a later call wins). */
async function pinWidth(page: Page, sessionId: string, width: number): Promise<void> {
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${sessionId}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
}

/** Open a fixture session in a column of `width` px, or fullscreen. */
async function openAt(
  page: Page, width: number | 'full', sessionId = MAP_SESSION, taskId = MAP_TASK, ready: string | undefined = MAP_READY,
  height = 900,
): Promise<Locator> {
  await page.setViewportSize({ width: 1600, height })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // The fixture server's background probes can raise an error toast over the
  // panel header; it is not what these tests look at, and it takes clicks.
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  if (width !== 'full') await pinWidth(page, sessionId, width)
  const panel = await openThreadsSession(page, sessionId, taskId, ready)
  if (width === 'full') {
    await panel.locator('button[title="Expand to full screen"]').click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  }
  // Geometry is read once the page stops moving: a rect taken inside the
  // fullscreen sheet's entrance (or a column's) is wherever the animation was.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => undefined))))
  return panel
}

/** scrollTop once it has held still for 300ms. */
async function settledScrollTop(page: Page, history: Locator): Promise<number> {
  let prev = await history.evaluate((el) => el.scrollTop)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300)
    const now = await history.evaluate((el) => el.scrollTop)
    if (now === prev) return now
    prev = now
  }
  return prev
}

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

const mapOf = (panel: Locator) => panel.locator('.thread-map')
const rowNamed = (scope: Locator, title: string | RegExp) => scope.locator('.thread-map-row', { hasText: title }).first()

type Rect = { left: number; right: number; top: number; bottom: number }
const rectOf = async (l: Locator): Promise<Rect> => {
  const b = (await l.boundingBox())!
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height }
}

/** The left edge of every visible text-bearing block in the timeline (rows,
 *  tables, code blocks), one read. */
async function contentLefts(panel: Locator): Promise<number[]> {
  return panel.locator('.session-history').evaluate((box) => {
    const b = box.getBoundingClientRect()
    const out: number[] = []
    for (const el of Array.from(box.querySelectorAll('[data-message-id] .session-msg-content, [data-message-id] table, [data-message-id] pre, .thread-quote-head'))) {
      const r = el.getBoundingClientRect()
      if (r.height === 0 || r.bottom < b.top || r.top > b.bottom) continue
      out.push(r.left)
    }
    return out
  })
}

/** Focus the tabbable element just before `target` in tab order (outside any
 *  map), so the next Tab is a real one that has to find the map. */
async function focusBefore(page: Page, target: Locator): Promise<void> {
  const handle = await target.elementHandle()
  await page.evaluate((el) => {
    const tabbable = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]'))
      .filter((x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && x.getClientRects().length > 0
        && getComputedStyle(x).visibility !== 'hidden')
    const at = tabbable.indexOf(el as HTMLElement)
    const before = tabbable.slice(0, at).reverse().find((x) => !x.closest('.thread-map'))
    if (!before) throw new Error('nothing tabbable before the map')
    before.focus()
  }, handle)
}

/** Hover / click where the element is, with the mouse alone: a locator's own
 *  hover() and click() first scroll their target into view, a scroll no real
 *  pointer makes, and the reading-position checks must see only the app's own. */
async function mouseTo(page: Page, l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!
  const at = { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 20) }
  await page.mouse.move(at.x, at.y)
  return at
}
async function mouseClick(page: Page, l: Locator): Promise<void> {
  const at = await mouseTo(page, l)
  await page.mouse.click(at.x, at.y)
}

const inMap = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.thread-map'))
const focusedStop = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return { cls: el?.className ?? '', current: el?.getAttribute('aria-current') ?? '', text: el?.innerText ?? '' }
})

/** The first message row at the top of the box, and its top offset there. */
async function readingRow(panel: Locator): Promise<{ id: string; top: number }> {
  return panel.locator('.session-history').evaluate((box) => {
    const viewTop = box.getBoundingClientRect().top + parseFloat(getComputedStyle(box).paddingTop)
    for (const row of Array.from(box.querySelectorAll<HTMLElement>('[data-message-id]'))) {
      const r = row.getBoundingClientRect()
      if (r.bottom > viewTop) return { id: row.dataset.messageId ?? '', top: r.top }
    }
    return { id: '', top: 0 }
  })
}
async function rowTop(panel: Locator, id: string): Promise<number> {
  return panel.locator('.session-history').evaluate((box, rid) =>
    box.querySelector(`[data-message-id="${CSS.escape(rid)}"]`)!.getBoundingClientRect().top, id)
}

/** The rail's list once its fade-in is over: opaque, so the text under it never
 *  shows through (a shot taken inside the 100ms fade reads as a see-through list). */
async function expectSettledOverlay(overlay: Locator): Promise<void> {
  await overlay.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  expect(await overlay.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  expect(await overlay.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(.*,\s*0\)$|transparent/)
}

/** Relative luminance of a computed `rgb(...)` colour, 0 (black) to 1 (white). */
function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test.describe('Question map', () => {
  test.setTimeout(180_000)

  test('a wide column: the labelled tree is always there, lists what the drawer lists, and no text runs under it', async ({ page }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    // C1: visible at once, no hover.
    await expect(map).toHaveAttribute('data-shape', 'panel')
    await expect(map.locator('.thread-map-head')).toContainText('Questions')
    await expect(map.locator('.thread-map-count')).toHaveText('5 open')
    await expect(rowNamed(map, 'Main conversation')).toHaveAttribute('aria-current', 'page')
    for (const t of [MAP_TITLES.Q1, MAP_TITLES.Q1a, MAP_TITLES.Q2, MAP_TITLES.Q4, MAP_TITLES.Q4a]) await expect(rowNamed(map, t)).toBeVisible()
    // Hidden questions never show; the done one folds into `1 archived`.
    await expect(rowNamed(map, MAP_TITLES.Q5)).toHaveCount(0)
    await expect(map.locator('.thread-map-row[data-kind="done-group"]')).toHaveText('1 archived')
    await expect(map.locator('.thread-map-row[data-kind="pin"]')).toHaveCount(2)
    await shot(page, 'wide-root')

    // C4: the same rows, in the same order, as the drawer's All view.
    const mapTitles = await map.locator('.thread-map-row .thread-map-label').allInnerTexts()
    const drawer = await openQuestionList(page, panel)
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await drawer.locator('.thread-drawer-chip', { hasText: 'All' }).click()
    const drawerTitles = await drawer.locator('.thread-tree-row .thread-tree-title').allInnerTexts()
    expect(mapTitles.map((t) => t.replace(/^“|”$/g, ''))).toEqual(drawerTitles)
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    // C22: a long title and the CJK ones stay on one line.
    const long = rowNamed(map, /What happens to the reader/)
    const fit = await long.evaluate((el) => {
      const label = el.querySelector('.thread-map-label') as HTMLElement
      return { clipped: label.scrollWidth > label.clientWidth, height: el.getBoundingClientRect().height }
    })
    expect(fit.clipped).toBe(true)
    expect(fit.height).toBeLessThanOrEqual(26)
    await expect(long).toHaveAttribute('title', MAP_TITLES.Q1b)
    for (const t of [MAP_TITLES.Q2, MAP_TITLES.Q4a]) {
      expect((await rectOf(rowNamed(map, t))).bottom - (await rectOf(rowNamed(map, t))).top).toBeLessThanOrEqual(26)
    }

    // C11: below the glass header, and it stays put while the transcript scrolls.
    const header = await rectOf(panel.locator('.session-panel-header').first())
    const at = await rectOf(map.locator('.thread-map-body'))
    expect(at.top).toBeGreaterThanOrEqual(header.bottom - 1)
    // C2: nothing in the text column starts left of the map's right edge, at the
    // bottom and scrolled up to the table and code block.
    const mapRight = at.right
    for (const left of await contentLefts(panel)) expect(left).toBeGreaterThanOrEqual(mapRight + 8)
    await centreInHistory(page, panel, panel.locator('.session-history table').first(), { at: 0.5, tolerance: 80, capRow: true })
    await expect(panel.locator('.session-history table').first()).toBeInViewport()
    const table = await rectOf(panel.locator('.session-history table').first())
    const code = await rectOf(panel.locator('.session-history pre').first())
    expect(table.left).toBeGreaterThanOrEqual(mapRight + 8)
    expect(code.left).toBeGreaterThanOrEqual(mapRight + 8)
    for (const left of await contentLefts(panel)) expect(left).toBeGreaterThanOrEqual(mapRight + 8)
    const moved = await rectOf(map.locator('.thread-map-body'))
    expect(Math.abs(moved.top - at.top)).toBeLessThanOrEqual(1)
    await shot(page, 'wide-scrolled-table')
    // C14.
    await noBannedGlyphs(page, map)
  })

  test('rows go to their page, the current row follows, Esc and Main come back (C5, C6)', async ({ page }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    await rowNamed(map, MAP_TITLES.Q1a).click()
    await expectDepth(panel, 2)
    await expect(rowNamed(map, MAP_TITLES.Q1a)).toHaveAttribute('aria-current', 'page')
    await expect(rowNamed(map, MAP_TITLES.Q1)).toHaveAttribute('data-on-path', 'true')
    await expect(rowNamed(map, 'Main conversation')).not.toHaveAttribute('aria-current', 'page')
    await expect(panel.locator('.thread-quote-head')).toBeVisible()
    await shot(page, 'wide-depth-2')
    // C12: map, sliver bars and text in that order, never overlapping.
    const body = await rectOf(map.locator('.thread-map-body'))
    const bars = panel.locator('.thread-sliver-bar')
    await expect(bars).toHaveCount(2)
    expect((await rectOf(bars.first())).left).toBeGreaterThanOrEqual(body.right + 4)
    for (const left of await contentLefts(panel)) expect(left).toBeGreaterThan((await rectOf(bars.last())).right)
    // Main from depth 2.
    await rowNamed(map, 'Main conversation').click()
    await expectDepth(panel, 0)
    await expect(rowNamed(map, 'Main conversation')).toHaveAttribute('aria-current', 'page')
    // Another branch, then Esc: the map follows the pop.
    await rowNamed(map, MAP_TITLES.Q4a).click()
    await expectDepth(panel, 2)
    const hb = (await panel.locator('.session-history').boundingBox())!
    await page.mouse.move(hb.x + hb.width * 0.7, hb.y + hb.height * 0.6)
    await page.keyboard.press('Escape')
    await expectDepth(panel, 1)
    await expect(rowNamed(map, MAP_TITLES.Q4)).toHaveAttribute('aria-current', 'page')
    // The done group opens in place and its question is a row like any other.
    await map.locator('.thread-map-row[data-kind="done-group"]').click()
    await expect(rowNamed(map, MAP_TITLES.Q3)).toBeVisible()
    await rowNamed(map, MAP_TITLES.Q3).click()
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-stack-header')).toContainText(MAP_TITLES.Q3)
    // C17: the group holding the current page stays open; its toggle is off.
    const group = map.locator('.thread-map-row[data-kind="done-group"]')
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect(group).toHaveAttribute('aria-disabled', 'true')
    // aria-disabled keeps Playwright's click waiting: send the click itself.
    await group.dispatchEvent('click')
    await expect(rowNamed(map, MAP_TITLES.Q3)).toHaveAttribute('aria-current', 'page')
    // Off that page, the group folds again when asked.
    await rowNamed(map, 'Main conversation').click()
    await expectDepth(panel, 0)
    await expect(group).not.toHaveAttribute('aria-disabled', 'true')
    await group.click()
    await expect(rowNamed(map, MAP_TITLES.Q3)).toHaveCount(0)
    await expect(group).toHaveAttribute('aria-expanded', 'false')
  })

  test('a pin row on another page lands on the pin; a pin on this page arms Back (C7, C24)', async ({ page }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    await map.locator('.thread-map-row[data-kind="pin"]', { hasText: MAP_PIN_QUOTE_TEXT.slice(0, 16) }).click()
    await expectDepth(panel, 2)
    await expect(panel.locator('.thread-stack-header')).toContainText(MAP_TITLES.Q1a)
    await expect.poll(async () => {
      const r = (await passageRects(panel, MAP_PIN_QUOTE_TEXT))[0]
      const box = (await panel.locator('.session-history').boundingBox())!
      return r.top > box.y + 40 && r.top < box.y + box.height - 40
    }, { timeout: 15_000 }).toBe(true)
    // A pop is not a jump: no Back.
    await expect(map.locator('.thread-map-back')).toHaveCount(0)
    // Root: the whole-message pin on the root page is a plain jump, and arms Back.
    await rowNamed(map, 'Main conversation').click()
    await expectDepth(panel, 0)
    const history = panel.locator('.session-history')
    // The pop's landing corrects once after the first frame: read the place it settled on.
    const before = await settledScrollTop(page, history)
    await map.locator('.thread-map-row[data-kind="pin"]', { hasText: 'Which copy to trust' }).click()
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).not.toBe(before)
    const back = map.locator('.thread-map-back')
    await expect(back).toBeVisible()
    await back.click()
    await expect.poll(() => history.evaluate((el, b) => Math.abs(el.scrollTop - b), before), { timeout: 10_000 }).toBeLessThanOrEqual(4)
    await expect(back).toHaveCount(0)
  })

  test('Conversation Mode keeps the map; a row makes that question the target and goes to its turn (C8)', async ({ page }) => {
    const panel = await openAt(page, WIDE)
    await switchView(panel, 'linear')
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'panel')
    // The composer's target starts on the main conversation.
    await expect(rowNamed(map, 'Main conversation')).toHaveAttribute('aria-current', 'page')
    // The turn rules of Conversation Mode run beside the text, clear of the map.
    const bar = panel.locator('.session-msg--threaded').first()
    await centreInHistory(page, panel, bar, { capRow: true })
    const body = await rectOf(map.locator('.thread-map-body'))
    expect((await rectOf(bar)).left).toBeGreaterThanOrEqual(body.right)
    await shot(page, 'wide-linear')
    await rowNamed(map, MAP_TITLES.Q4).click()
    // Still Conversation Mode: no question page opened, the row is the target.
    await expect(modePill(panel)).toHaveAttribute('data-view-mode', 'linear')
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
    await expect(rowNamed(map, MAP_TITLES.Q4)).toHaveAttribute('aria-current', 'page')
    await expect(panel.locator(`.session-msg--threaded[data-message-id="${MAP_IDS.Q4.u}"]`)).toHaveAttribute('data-thread-current', 'true')
    await expect(panel.locator('.thread-turn-label[data-current="true"]')).toContainText(MAP_TITLES.Q4)
  })

  test('Conversation Mode at 480px: a turn rule stands clear of the rail, and a press on it jumps without opening the list', async ({ page }) => {
    const panel = await openAt(page, NARROW)
    const map = mapOf(panel)
    const rail = map.locator('.thread-map-rail')
    await expect(map).toHaveAttribute('data-shape', 'rail')
    await switchView(panel, 'linear')
    // Q2's bar: its passage sits in the first answer, far above its own rows.
    const bar = panel.locator(`.session-msg--threaded[data-message-id="${MAP_IDS.Q2.u}"]`)
    await centreInHistory(page, panel, bar, { capRow: true })
    const railBox = await rectOf(rail)
    const barBox = await rectOf(bar)
    // The bar (and the press strip it starts) sits clear of the rail's marks.
    expect(barBox.left).toBeGreaterThanOrEqual(railBox.right + 6)
    await shot(page, 'narrow-linear-bar')
    const history = panel.locator('.session-history')
    const before = await history.evaluate((el) => el.scrollTop)
    // A real pointer, the way a user reaches for the bar: straight to its left edge.
    await page.mouse.move(barBox.left + 1, barBox.top + Math.min((barBox.bottom - barBox.top) / 2, 20))
    await page.waitForTimeout(250)
    await expect(map.locator('.thread-map-overlay')).toHaveCount(0)
    await page.mouse.down()
    await page.mouse.up()
    // The press went to the bar: the view goes back to the passage it was asked on.
    await expect.poll(() => page.evaluate(() => {
      const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('walnut-pin-flash')
      return Array.from(hl ?? []).map((r) => r.toString()).join(' | ')
    }), { timeout: 10_000 }).toContain(MAP_PASSAGES.Q2.slice(0, 12))
    // The flash lands with the press; the scroll to the passage follows it.
    await expect.poll(() => history.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeLessThan(before)
    await expect(map.locator('.thread-map-overlay')).toHaveCount(0)
    // The bar is the question, the same as its label: its card opens there.
    await expect(panel.locator('.thread-card')).toBeVisible()
    await expect(panel.locator('.thread-card .thread-card-title')).toHaveText(MAP_TITLES.Q2)
  })

  test('a narrow column: the rail is always there, clear of the text; hover, focus or a tap opens the list (C3, C18, C19)', async ({ page }) => {
    const panel = await openAt(page, NARROW)
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'rail')
    const rail = map.locator('.thread-map-rail')
    await expect(rail).toBeVisible()
    await expect(rail).toHaveAttribute('aria-label', 'Questions map: 7 questions')
    await expect(map.locator('.thread-map-mark')).toHaveCount(10)
    await expect(map.locator('.thread-map-mark[data-current="true"][data-kind="root"]')).toHaveCount(1)
    const railBox = await rectOf(rail)
    for (const left of await contentLefts(panel)) expect(left).toBeGreaterThanOrEqual(railBox.right + 6)
    await shot(page, 'narrow-rail')
    // Hover: the labelled list over the text; leaving closes it.
    await rail.hover()
    const overlay = map.locator('.thread-map-overlay')
    await expect(overlay).toBeVisible()
    await expect(rowNamed(overlay, MAP_TITLES.Q2)).toBeVisible()
    await expectSettledOverlay(overlay)
    await shot(page, 'narrow-rail-open')
    const hb = (await panel.locator('.session-history').boundingBox())!
    await page.mouse.move(hb.x + hb.width * 0.7, hb.y + hb.height * 0.6)
    await expect(overlay).toHaveCount(0)
    // A tap has no pointer to leave with: a press anywhere else closes the list.
    await rail.dispatchEvent('click')
    await expect(overlay).toBeVisible()
    await panel.locator('.session-history').dispatchEvent('pointerdown')
    await expect(overlay).toHaveCount(0)
    await page.mouse.move(hb.x + hb.width * 0.7, hb.y + hb.height * 0.6)
    // A row in the list goes there and closes the list.
    await rail.hover()
    await rowNamed(overlay, MAP_TITLES.Q4).click()
    await expectDepth(panel, 1)
    await expect(overlay).toHaveCount(0)
    // A mouse user is not handed focus: Space must keep scrolling the timeline.
    await expect(rail).not.toBeFocused()
    await expect(map.locator('.thread-map-mark[data-current="true"]')).toHaveCount(1)
    // C12 in the rail: the sliver sits right of the rail.
    const bar = panel.locator('.thread-sliver-bar').first()
    await expect(bar).toBeVisible()
    expect((await rectOf(bar)).left).toBeGreaterThanOrEqual((await rectOf(rail)).right + 4)
    // C18 keyboard, with real Tabs: the rail is the map's one tab stop and focus
    // opens its list; ArrowDown enters it on the current row, arrows move, Enter
    // opens and hands focus back to the rail (list closed), Esc closes only.
    await page.mouse.move(hb.x + hb.width * 0.7, hb.y + hb.height * 0.6)
    await focusBefore(page, rail)
    await page.keyboard.press('Tab')
    await expect(rail).toBeFocused()
    await expect(overlay).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await focusedStop(page)).current).toBe('page')
    await page.keyboard.press('ArrowDown')
    expect((await focusedStop(page)).text).toContain(MAP_TITLES.Q4a)
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle)
    expect(ring).not.toBe('none')
    await page.keyboard.press('Enter')
    await expectDepth(panel, 2)
    await expect(rail).toBeFocused()
    await expect(overlay).toHaveCount(0)
    // One stop: the next Tab leaves the map. Shift+Tab back is not asserted:
    // WebKit's Tab order skips bare buttons, and from where its Tab landed its
    // Shift+Tab did not come back to the rail. Re-enter the way a user does.
    await page.keyboard.press('Tab')
    expect(await inMap(page)).toBe(false)
    await focusBefore(page, rail)
    await page.keyboard.press('Tab')
    await expect(rail).toBeFocused()
    await expect(overlay).toBeVisible()
    // Esc from inside the list: closed, focus on the rail, same page.
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => inMap(page)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    await expect(rail).toBeFocused()
    await expectDepth(panel, 2)
    // A second Esc is the page's own: back one level.
    await page.keyboard.press('Escape')
    await expectDepth(panel, 1)
    await noBannedGlyphs(page, map)
  })

  test('keyboard in the labelled panel: one tab stop, arrows reach the head, hide and keep open keep focus (C18)', async ({ page }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'panel')
    const main = rowNamed(map, 'Main conversation')
    await focusBefore(page, main)
    await page.keyboard.press('Tab')
    await expect(main).toBeFocused()
    await page.keyboard.press('Tab')
    expect(await inMap(page)).toBe(false)
    await page.keyboard.press('Shift+Tab')
    await expect(main).toBeFocused()
    // Arrows down to a question, Enter: that page, and the tab stop follows the page.
    for (let i = 0; i < 12 && !(await focusedStop(page)).text.includes(MAP_TITLES.Q2); i++) await page.keyboard.press('ArrowDown')
    expect((await focusedStop(page)).text).toContain(MAP_TITLES.Q2)
    await page.keyboard.press('Enter')
    await expectDepth(panel, 1)
    const current = map.locator('.thread-map-row[aria-current="page"]')
    await expect(current).toContainText(MAP_TITLES.Q2)
    await expect(current).toHaveAttribute('tabindex', '0')
    await expect(map.locator('.thread-map-row[tabindex="0"]')).toHaveCount(1)
    // ArrowUp past the first row reaches the head: Hide, then the list button.
    await current.focus()
    await page.keyboard.press('Home')
    await expect(main).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(map.locator('.thread-map-hide')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(map).toHaveAttribute('data-shape', 'rail')
    // Hidden: focus sits on the rail, and that focus did not open the list.
    const rail = map.locator('.thread-map-rail')
    await expect(rail).toBeFocused()
    await expect(map.locator('.thread-map-overlay')).toHaveCount(0)
    // Enter opens it, and Keep the map open brings the panel back with focus on Hide.
    await page.keyboard.press('Enter')
    await expect(map.locator('.thread-map-overlay')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await focusedStop(page)).cls).toContain('thread-map-row')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowUp')
    await expect(map.locator('.thread-map-keep')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(map).toHaveAttribute('data-shape', 'panel')
    await expect(map.locator('.thread-map-hide')).toBeFocused()
  })

  test('hide the map and bring it back; the choice holds after a reload and in other sessions (C15, C26)', async ({ page }) => {
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    const rail = map.locator('.thread-map-rail')
    await expect(map).toHaveAttribute('data-shape', 'panel')
    const history = panel.locator('.session-history')
    const gap = () => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    const padWide = await history.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    // C26 at the bottom (where a session opens): hiding keeps you at the bottom.
    expect(await gap()).toBeLessThanOrEqual(4)
    await map.locator('.thread-map-hide').click()
    await expect(map).toHaveAttribute('data-shape', 'rail')
    const padRail = await history.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    expect(padRail).toBeLessThan(padWide - 100)
    await expect.poll(gap).toBeLessThanOrEqual(4)
    expect(await page.evaluate(() => localStorage.getItem('walnut:thread-map.v1'))).toBe('collapsed')
    // C26 mid-transcript: the passage you were reading stays where it was while
    // the text column widens and narrows under it.
    await rail.hover()
    await map.locator('.thread-map-keep').click()
    await expect(map).toHaveAttribute('data-shape', 'panel')
    await centreInHistory(page, panel, panel.locator('.session-history table').first(), { at: 0.5, tolerance: 80, capRow: true })
    const reading = await readingRow(panel)
    expect(reading.id).not.toBe('')
    await mouseClick(page, map.locator('.thread-map-hide'))
    await expect(map).toHaveAttribute('data-shape', 'rail')
    expect(Math.abs((await rowTop(panel, reading.id)) - reading.top), 'hide moved the reading position').toBeLessThanOrEqual(2)
    await mouseTo(page, rail)
    await expect(map.locator('.thread-map-overlay')).toBeVisible()
    await mouseClick(page, map.locator('.thread-map-keep'))
    await expect(map).toHaveAttribute('data-shape', 'panel')
    expect(Math.abs((await rowTop(panel, reading.id)) - reading.top), 'keep open moved the reading position').toBeLessThanOrEqual(2)
    await map.locator('.thread-map-hide').click()
    await expect(map).toHaveAttribute('data-shape', 'rail')
    // Reload: still hidden.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await pinWidth(page, MAP_SESSION, WIDE)
    const again = sessionPanel(page, MAP_SESSION)
    await expect(again).toBeVisible({ timeout: 20_000 })
    await expect(mapOf(again)).toHaveAttribute('data-shape', 'rail', { timeout: 20_000 })
    // Keep it open again from the rail's list.
    await mapOf(again).locator('.thread-map-rail').hover()
    await mapOf(again).locator('.thread-map-keep').click()
    await expect(mapOf(again)).toHaveAttribute('data-shape', 'panel')
    // C26: resize across the threshold flips the shape, no gutter left behind.
    await pinWidth(page, MAP_SESSION, NARROW)
    await expect(mapOf(again)).toHaveAttribute('data-shape', 'rail')
    const pad = await again.locator('.session-history').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    expect(pad).toBeLessThan(60)
    await pinWidth(page, MAP_SESSION, WIDE)
    await expect(mapOf(again)).toHaveAttribute('data-shape', 'panel')
  })

  test('Ask on a passage: New question shows in the map at once, Esc drops it, and the passage lands back (C9, C23)', async ({ page }) => {
    // A session without questions: the map (and its gutter) appears with the Ask.
    const panel = await openAt(page, WIDE, AI_SESSION, 'pw-task-threads-ai', 'How should the reader treat stale copies?')
    await expect(mapOf(panel)).toHaveCount(0)
    const phrase = AI_PASSAGE.slice(0, 40)
    await centreInHistory(page, panel, phrase, { tolerance: 20 })
    await selectPassage(page, panel, phrase)
    const top = async () => Math.round((await passageRects(panel, phrase))[0].top)
    const asked = await top()
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expectDepth(panel, 1)
    const map = mapOf(panel)
    await expect(map.locator('.thread-map-body')).toBeVisible()
    await expect(map.locator('.thread-map-row[data-kind="pending"]')).toHaveText('New question')
    await expect(map.locator('.thread-map-row[data-kind="pending"]')).toHaveAttribute('aria-current', 'page')
    await shot(page, 'ask-pending')
    const hb = (await panel.locator('.session-history').boundingBox())!
    await page.mouse.move(hb.x + hb.width * 0.7, hb.y + hb.height * 0.6)
    await page.keyboard.press('Escape')
    // Nothing was sent: the session has no question again, so no stack and no map.
    await expect(panel.locator('.thread-stack')).toHaveCount(0)
    await expect(mapOf(panel)).toHaveCount(0)
    await page.waitForTimeout(400)
    expect(Math.abs((await top()) - asked), 'landing drift after the map left').toBeLessThanOrEqual(8)
  })

  test('a long map scrolls inside itself and keeps the current row in view (C16)', async ({ page }) => {
    const panel = await openAt(page, WIDE, DENSE_SESSION, DENSE_TASK, DENSE_READY, 760)
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'panel')
    const rows = map.locator('.thread-map-rows')
    const size = await rows.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
    expect(size.sh).toBeGreaterThan(size.ch)
    const body = await rectOf(map.locator('.thread-map-body'))
    const box = (await panel.locator('.session-history').boundingBox())!
    expect(body.bottom).toBeLessThanOrEqual(box.y + box.height)
    // The last question in the tree, through the drawer: the map scrolls to it.
    const drawer = await openQuestionList(page, panel)
    await drawer.locator('.thread-drawer-chip', { hasText: 'All' }).click()
    const last = drawer.locator('.thread-tree-row[data-kind="thread"]').last()
    const title = (await last.locator('.thread-tree-title').innerText()).trim()
    await last.click()
    await expect(drawer).toBeHidden()
    const current = map.locator('.thread-map-row[aria-current="page"]')
    await expect(current).toContainText(title)
    const r = await rectOf(current)
    const view = await rectOf(rows)
    expect(r.top).toBeGreaterThanOrEqual(view.top - 1)
    expect(r.bottom).toBeLessThanOrEqual(view.bottom + 1)
    await shot(page, 'dense-scrolled-map')
  })

  test('fullscreen: the labelled map, clear of the text (C13)', async ({ page }) => {
    const panel = await openAt(page, 'full')
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'panel')
    const body = await rectOf(map.locator('.thread-map-body'))
    expect(body.right - body.left).toBeGreaterThanOrEqual(240)
    for (const left of await contentLefts(panel)) expect(left).toBeGreaterThanOrEqual(body.right + 8)
    await rowNamed(map, MAP_TITLES.Q4a).click()
    await expectDepth(panel, 2)
    await shot(page, 'full-depth-2')
  })

  test('a session without questions has no map, only the outline as before (C10)', async ({ page }) => {
    const panel = await openAt(page, WIDE, NO_THREAD_SESSION, 'pw-task-outline-window', '')
    await expect(panel.locator('.session-history')).toBeVisible()
    await page.waitForTimeout(600)
    await expect(mapOf(panel)).toHaveCount(0)
    await expect(panel.locator('.session-history')).not.toHaveAttribute('data-thread-map', /.+/)
  })

  test('a session with pins and no question keeps its outline, with no map (C10)', async ({ page }) => {
    const panel = await openAt(page, WIDE, PINS_ONLY_SESSION, PINS_ONLY_TASK, PINS_ONLY_READY)
    await expect(panel.locator('.session-toc')).toHaveCount(1)
    await expect(panel.locator('.session-toc-rail')).toBeVisible()
    await expect(mapOf(panel)).toHaveCount(0)
    await expect(panel.locator('.session-history')).not.toHaveAttribute('data-thread-map', /.+/)
    // No question: nothing says `Questions` anywhere in the timeline.
    await expect(panel.locator('.session-history')).not.toContainText('Questions map')
    await shot(page, 'pins-only-outline')
  })

  test('the Files split narrows the chat column: the map follows the column (C27)', async ({ page }) => {
    const panel = await openAt(page, 1100)
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'panel')
    const files = panel.locator('button.session-action-chip', { hasText: /^Files$/ })
    await files.click()
    await expect(panel.locator('.session-panel-split.is-changed-open')).toBeVisible({ timeout: 15_000 })
    // The chat column is narrower than the 1100px column was, and the shape is
    // the one its own width asks for.
    const width = () => panel.locator('.session-history').evaluate((el) => (el as HTMLElement).offsetWidth)
    await expect.poll(width).toBeLessThan(1000)
    await expect.poll(async () => (await map.getAttribute('data-shape')) === ((await width()) >= 640 ? 'panel' : 'rail')).toBe(true)
    for (const left of await contentLefts(panel)) expect(left).toBeGreaterThanOrEqual((await rectOf(map.locator('.thread-map-body'))).right + 6)
    await shot(page, 'files-split')
    await files.click()
    await expect(panel.locator('.session-panel-split.is-changed-open')).toHaveCount(0)
    await expect(map).toHaveAttribute('data-shape', 'panel')
  })

  test('the count is the pill\'s narrow form, the full text its tooltip; reduced motion has no animation (C28, C30)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const panel = await openAt(page, NARROW)
    const map = mapOf(panel)
    await map.locator('.thread-map-rail').hover()
    const overlay = map.locator('.thread-map-overlay')
    await expect(overlay).toBeVisible()
    expect(await overlay.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    const count = overlay.locator('.thread-map-count')
    // The fixture has 5 open and 1 to check: the narrow form drops the second.
    await expect(count).toHaveText('5 open')
    await expect(count).toHaveAttribute('title', '5 open \u00b7 1 to check')
    // The header carries no count any more: the pill alone, naming the other
    // view (icon only at this width, the label is its tooltip).
    await expect(modePill(panel)).toHaveAttribute('title', 'Switch to Conversation Mode')
    await expect(panel.locator('.session-panel-header')).not.toContainText('5 open')
  })

  test('dark theme: the map reads on the dark background (C13, C29)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    const panel = await openAt(page, WIDE)
    const map = mapOf(panel)
    await expect(map).toHaveAttribute('data-shape', 'panel')
    await rowNamed(map, MAP_TITLES.Q1a).click()
    await expectDepth(panel, 2)
    // Light text on a dark ground: the current row, a plain row, and the box behind them.
    const ground = await panel.locator('.session-history').evaluate((el) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
      }
      return getComputedStyle(document.body).backgroundColor
    })
    expect(luminance(ground)).toBeLessThan(0.1)
    const current = await rowNamed(map, MAP_TITLES.Q1a).evaluate((el) => getComputedStyle(el).color)
    const plain = await rowNamed(map, MAP_TITLES.Q2).evaluate((el) => getComputedStyle(el).color)
    expect(luminance(current)).toBeGreaterThan(0.5)
    expect(luminance(plain)).toBeGreaterThan(0.2)
    await shot(page, 'dark-wide-depth-2')
    await pinWidth(page, MAP_SESSION, NARROW)
    await expect(map).toHaveAttribute('data-shape', 'rail')
    await map.locator('.thread-map-rail').hover()
    const overlay = map.locator('.thread-map-overlay')
    await expect(overlay).toBeVisible()
    expect(luminance(await overlay.evaluate((el) => getComputedStyle(el).backgroundColor))).toBeLessThan(0.1)
    await expectSettledOverlay(overlay)
    await shot(page, 'dark-narrow-open')
  })
})
