/**
 * The line under a passage whose question is being answered: while the answer
 * comes in, the mark's underline is a light band sweeping along the passage
 * (the working indicator's scan); when it ends, the plain mark is back.
 *
 * Covers, in Conversation Mode: a follow-up sent from an open card and a new
 * question sent from a draft card each give their passage a scanning line per
 * line of text, right where the underline was; the line moves (a running
 * animation, not a still gradient), stays on the text when the timeline scrolls
 * and when the card closes, holds still under reduced motion, and goes away with
 * the live mark paint once the answer lands; a reload mid-answer comes back
 * with the same passage scanning. In Tree Mode: a question answered while its parent page is on screen
 * scans in its own hue, and follows the text when the window narrows and it
 * rewraps. In the Files tab: the same line in
 * the markdown editor (an overlay re-placed on scroll, hidden under the toolbar
 * or out of sight) and inside the HTML preview's own document (a table cell on
 * a long page that scrolls).
 *
 * Chromium and WebKit. The tagged fixture session; the mock CLI answers a
 * message that starts with `slow:<ms>` after that delay.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage, sessionPanel,
} from './threads-helpers'
import { RELOAD_PASSAGE, RELOAD_SESSION, TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TEXT } from './threads-fixture'

const MD_FILE = 'cache-design.md'
const MD_PASSAGE_FULL = 'A late flush can hide an earlier update to the same slot'
const LONG_FILE = 'cache-handbook.html'
const LONG_PASSAGE = 'The tie rule reads slot numbers only'
const SLOW = 'slow:15000'
const RELOAD_TASK = 'pw-task-threads-reload'

interface Box { left: number; right: number; top: number; bottom: number }
interface TextRect { left: number; right: number; top: number; height: number }

async function shot(page: Page, name: string, around?: TextRect): Promise<void> {
  const dir = `/tmp/thread-live/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  const clip = around
    ? { x: Math.max(0, around.left - 40), y: Math.max(0, around.top - 60), width: 640, height: 160 }
    : undefined
  await page.screenshot({ path: `${dir}/${name}.png`, ...(clip ? { clip } : {}) })
}

async function boxes(lines: Locator, offset = { x: 0, y: 0 }): Promise<Box[]> {
  const raw = await lines.evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  }))
  return raw.map((b) => ({ left: b.left + offset.x, right: b.right + offset.x, top: b.top + offset.y, bottom: b.bottom + offset.y }))
}

/** Every line of the passage has a scanning line on its bottom edge, as wide as the text. */
function expectUnder(bars: Box[], rects: TextRect[]): void {
  for (const r of rects) {
    const bottom = r.top + r.height
    const bar = bars.find((b) => Math.abs((b.top + b.bottom) / 2 - bottom) <= 2.5 && b.left <= r.left + 4 && b.right >= r.right - 4)
    expect(bar, `a scanning line under the passage's line ending at y=${bottom.toFixed(1)} (bars: ${JSON.stringify(bars)})`).toBeTruthy()
    expect(bar!.bottom - bar!.top).toBeGreaterThanOrEqual(1.5)
    expect(bar!.bottom - bar!.top).toBeLessThanOrEqual(3)
  }
}

/** A running sweep: the band's position changes over time. */
async function expectScanning(line: Locator, name: RegExp): Promise<void> {
  expect(await line.evaluate((el) => getComputedStyle(el).animationName)).toMatch(name)
  const first = await line.evaluate((el) => getComputedStyle(el).backgroundPosition)
  await expect.poll(() => line.evaluate((el) => getComputedStyle(el).backgroundPosition), { timeout: 3_000 }).not.toBe(first)
}

const hasHighlight = (page: Page, name: string) => page.evaluate((n) => CSS.highlights?.has(n) ?? false, name)

test.describe('The scanning line under a passage being answered', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
  })

  test('Conversation Mode: a follow-up and a new question each scan their passage until the answer lands', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.setViewportSize({ width: 1800, height: 800 })
    await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${TAGGED_SESSION}"]) {
      flex: 0 0 1100px !important; width: 1100px !important; min-width: 1100px !important; max-width: 1100px !important; }` })
    const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    const history = panel.locator('.session-history')
    const lines = history.locator('.thread-live-layer .thread-live-line')
    const card = panel.locator('.thread-card')
    await expect(lines).toHaveCount(0)

    // A follow-up from the question's own card (its mark opens it).
    await centreInHistory(page, panel, TAGGED_PASSAGE)
    const q1 = await passageRects(panel, TAGGED_PASSAGE)
    await page.mouse.click(q1[0].left + 8, q1[0].top + q1[0].height / 2)
    await expect(card).toBeVisible()
    const input = card.locator('.thread-card-input')
    await input.fill(`${SLOW} And after a restart?`)
    await input.press('Enter')
    await expect(card).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    await expect(lines.first()).toBeVisible({ timeout: 10_000 })
    expectUnder(await boxes(lines), await passageRects(panel, TAGGED_PASSAGE))
    expect(await hasHighlight(page, 'thread-mark-live-neutral'), 'the live mark drops its underline').toBe(true)
    await expectScanning(lines.first(), /^thread-live-scan$/)
    await shot(page, 'timeline-followup-a', (await passageRects(panel, TAGGED_PASSAGE))[0])
    await page.waitForTimeout(500)
    await shot(page, 'timeline-followup-b', (await passageRects(panel, TAGGED_PASSAGE))[0])

    // Reduced motion: a still line, no sweep.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await lines.first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    // The timeline scrolls: the line rides with the text.
    await history.evaluate((el) => el.scrollBy(0, -90))
    await page.waitForTimeout(150)
    expectUnder(await boxes(lines), await passageRects(panel, TAGGED_PASSAGE))
    // The card closes: the answer is still coming, the line stays.
    await input.press('Escape')
    await expect(card).toHaveCount(0)
    await expect(lines.first()).toBeVisible()
    expectUnder(await boxes(lines), await passageRects(panel, TAGGED_PASSAGE))

    // The answer lands: the plain mark is back.
    await expect(history).toContainText('processed your message: And after a restart?', { timeout: 60_000 })
    await expect(lines).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => hasHighlight(page, 'thread-mark-live-neutral')).toBe(false)
    expect(await hasHighlight(page, 'thread-mark-neutral')).toBe(true)

    // A new question from a draft card: the line appears once it is sent.
    await centreInHistory(page, panel, TAGGED_TEXT.aRoot)
    await selectPassage(page, panel, TAGGED_TEXT.aRoot)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card).toHaveAttribute('data-draft', 'true')
    await expect(lines, 'a draft is not being answered').toHaveCount(0)
    await card.locator('.thread-card-input').fill(`${SLOW} Which copy is that?`)
    await card.locator('.thread-card-input').press('Enter')
    await expect(card).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    await expect(lines.first()).toBeVisible({ timeout: 10_000 })
    expectUnder(await boxes(lines), await passageRects(panel, TAGGED_TEXT.aRoot))
    await shot(page, 'timeline-new-question', (await passageRects(panel, TAGGED_TEXT.aRoot))[0])
    await expect(history).toContainText('processed your message: Which copy is that?', { timeout: 60_000 })
    await expect(lines).toHaveCount(0, { timeout: 15_000 })
  })

  test('a reload while the answer is coming: the panel comes back with the same passage scanning', async ({ page, request }) => {
    // The session whose sends reach its transcript (the mock writes a slow
    // turn's user line when the turn starts, as the real CLI does).
    await resetThreadsFixture(request, RELOAD_SESSION)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.setViewportSize({ width: 1400, height: 820 })
    let panel = await openThreadsSession(page, RELOAD_SESSION, RELOAD_TASK, 'What does the reader do after a rotation?', { view: 'linear' })
    const phrase = RELOAD_PASSAGE.slice(0, 40)
    await centreInHistory(page, panel, phrase)
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    const card = panel.locator('.thread-card')
    await expect(card).toHaveAttribute('data-draft', 'true')
    await card.locator('.thread-card-input').fill('slow:40000 What drains first?')
    await card.locator('.thread-card-input').press('Enter')
    await expect(card).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    const linesOf = (p: Locator) => p.locator('.session-history .thread-live-layer .thread-live-line')
    await expect(linesOf(panel).first()).toBeVisible({ timeout: 10_000 })
    // The question is on the record before the reload (the send wrote its anchor).
    await expect.poll(async () => ((await readRecord(request, RELOAD_SESSION)).threadAnchors ?? []).length).toBe(1)

    await page.reload()
    await page.waitForLoadState('networkidle')
    // The reload brings the column back by itself (its id is in the URL).
    panel = sessionPanel(page, RELOAD_SESSION)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await centreInHistory(page, panel, phrase)
    await expect(linesOf(panel).first()).toBeVisible({ timeout: 20_000 })
    const bars = await boxes(linesOf(panel))
    const rects = await passageRects(panel, phrase)
    expectUnder(bars, rects)
    // Only that passage scans (the question kept its identity across the reload).
    for (const b of bars) {
      expect(rects.some((r) => Math.abs((b.top + b.bottom) / 2 - (r.top + r.height)) <= 2.5), `a line under something else: ${JSON.stringify(b)}`).toBe(true)
    }
    await shot(page, 'reload-mid-answer', rects[0])
    await expect(panel.locator('.session-history')).toContainText('processed your message: What drains first?', { timeout: 90_000 })
    await expect(linesOf(panel)).toHaveCount(0, { timeout: 15_000 })
  })

  test('Tree Mode: a question answered while its parent page is on screen scans in its own hue', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.setViewportSize({ width: 1400, height: 820 })
    const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'stack' })
    const history = panel.locator('.session-history')
    const depth = (n: number) => expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(n), { timeout: 15_000 })
    await centreInHistory(page, panel, TAGGED_PASSAGE)
    const q1 = await passageRects(panel, TAGGED_PASSAGE)
    await page.mouse.click(q1[0].left + 8, q1[0].top + q1[0].height / 2)
    await depth(1)
    const box = panel.locator('.chat-input-textarea').first()
    await box.click()
    await box.fill(`${SLOW} And on a cold start?`)
    await box.press('Enter')
    await expect(box).toHaveValue('')
    await expect(history).toContainText('And on a cold start?')
    // Back on the page the passage is on, while the answer is still coming.
    await page.keyboard.press('Escape')
    await depth(0)
    await centreInHistory(page, panel, TAGGED_PASSAGE)
    const lines = history.locator('.thread-live-layer .thread-live-line')
    await expect(lines.first()).toBeVisible({ timeout: 15_000 })
    const hue = await lines.first().getAttribute('data-hue')
    expect(hue, 'the line takes the question\'s hue').toMatch(/^\d+$/)
    expect(await hasHighlight(page, `thread-mark-live-${hue}`)).toBe(true)
    expectUnder(await boxes(lines), await passageRects(panel, TAGGED_PASSAGE))
    await expectScanning(lines.first(), /^thread-live-scan$/)
    await shot(page, 'tree-hue', (await passageRects(panel, TAGGED_PASSAGE))[0])
    // The window narrows: the text rewraps and the line follows it (no DOM change).
    const wide = await passageRects(panel, TAGGED_PASSAGE)
    await page.setViewportSize({ width: 1100, height: 820 })
    await expect.poll(async () => JSON.stringify(await passageRects(panel, TAGGED_PASSAGE)) !== JSON.stringify(wide), { timeout: 5_000 }).toBe(true)
    await expect(async () => {
      expectUnder(await boxes(lines), await passageRects(panel, TAGGED_PASSAGE))
    }).toPass({ timeout: 5_000 })
    await expect(lines).toHaveCount(0, { timeout: 60_000 })
    expect(await hasHighlight(page, `thread-mark-${hue}`)).toBe(true)
  })

  test('Files tab: the markdown editor and the HTML preview scan the asked passage', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.setViewportSize({ width: 1400, height: 820 })
    const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    await panel.getByRole('button', { name: 'Files' }).click()
    const explorer = panel.locator('.session-file-explorer')
    await expect(explorer).toBeVisible({ timeout: 10_000 })
    const openFile = async (name: string) => {
      await explorer.locator('.session-file-explorer-node', { hasText: name }).first().click()
      const view = explorer.locator('.file-content-view')
      await expect(view).toBeVisible({ timeout: 10_000 })
      return view
    }
    const textRects = (root: Locator, needle: string) => root.evaluate((el, phrase) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = (n as Text).data.indexOf(phrase)
        if (at === -1) continue
        const r = document.createRange()
        r.setStart(n, at)
        r.setEnd(n, at + phrase.length)
        return Array.from(r.getClientRects()).map((b) => ({ left: b.left, right: b.right, top: b.top, height: b.height }))
      }
      return []
    }, needle)
    const drag = async (rects: TextRect[]) => {
      const first = rects[0]
      const last = rects[rects.length - 1]
      await page.mouse.move(first.left + 1, first.top + first.height / 2)
      await page.mouse.down()
      await page.mouse.move((first.left + last.right) / 2, (first.top + last.top) / 2 + first.height / 2, { steps: 4 })
      await page.mouse.move(last.right - 1, last.top + last.height / 2, { steps: 4 })
      await page.mouse.up()
    }

    // ── Markdown (WYSIWYG): an overlay re-placed on scroll ──
    let view = await openFile(MD_FILE)
    const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await expect(editor).toContainText(MD_PASSAGE_FULL)
    await drag(await textRects(editor, MD_PASSAGE_FULL))
    await page.locator('[data-testid="bubble-ask-here"]').dispatchEvent('mousedown')
    let card = view.locator('.fv-thread-layer .thread-card')
    await expect(card).toHaveAttribute('data-draft', 'true')
    await card.locator('.thread-card-input').fill(`${SLOW} Why keep both versions?`)
    await card.locator('.thread-card-input').press('Enter')
    await expect(card).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    let lines = view.locator('.fv-live-lines .thread-live-line')
    await expect(lines.first()).toBeVisible({ timeout: 10_000 })
    expectUnder(await boxes(lines), await textRects(editor, MD_PASSAGE_FULL))
    await expectScanning(lines.first(), /^thread-live-scan$/)
    await shot(page, 'file-md', (await textRects(editor, MD_PASSAGE_FULL))[0])
    // The editor scrolls (its own scroller): the line follows the text.
    const scrolled = await editor.evaluate((el) => {
      let s: HTMLElement | null = el.parentElement
      while (s && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement
      if (!s) return false
      s.scrollBy(0, 60)
      return true
    })
    expect(scrolled, 'the markdown view has a scroller').toBe(true)
    await expect.poll(async () => {
      const bars = await boxes(lines)
      const rects = await textRects(editor, MD_PASSAGE_FULL)
      return rects.every((r) => bars.some((b) => Math.abs((b.top + b.bottom) / 2 - (r.top + r.height)) <= 2.5))
    }, { timeout: 3_000 }).toBe(true)
    // Scrolled up under the toolbar: no line drawn over it.
    const toolbar = (await view.locator('.fv-html-toolbar').first().boundingBox())!
    await editor.evaluate((el, toolbarBottom) => {
      let s: HTMLElement | null = el.parentElement
      while (s && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n as Text).data.includes('A late flush')) continue
        const r = (n.parentElement as HTMLElement).getBoundingClientRect()
        s!.scrollBy(0, r.bottom - toolbarBottom + 2)
        return
      }
    }, toolbar.y + toolbar.height)
    const under = await textRects(editor, MD_PASSAGE_FULL)
    expect(under.at(-1)!.top + under.at(-1)!.height, 'the passage went up under the toolbar').toBeLessThan(toolbar.y + toolbar.height)
    await expect(lines, 'no line drawn over the toolbar').toHaveCount(0, { timeout: 3_000 })
    await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    await expect(lines).toHaveCount(0, { timeout: 15_000 })

    // ── HTML preview: the lines live in the frame's own document ──
    await card.locator('.thread-card-input').press('Escape')
    view = await openFile(LONG_FILE)
    const frame = view.frameLocator('.fv-html-preview')
    await expect(frame.locator('body')).toContainText(LONG_PASSAGE, { timeout: 15_000 })
    await frame.locator('body').evaluate((el, phrase) => {
      Array.from(el.querySelectorAll('td')).find((t) => t.textContent === phrase)!.scrollIntoView({ block: 'center' })
    }, LONG_PASSAGE)
    await page.waitForTimeout(300)
    const frameOffset = async () => {
      const b = (await view.locator('.fv-html-preview').boundingBox())!
      return { x: b.x, y: b.y }
    }
    const frameRects = async () => {
      const o = await frameOffset()
      return (await textRects(frame.locator('body'), LONG_PASSAGE)).map((r) => ({ ...r, left: r.left + o.x, right: r.right + o.x, top: r.top + o.y }))
    }
    await drag(await frameRects())
    await page.locator('[data-testid="file-ask-here"]').click()
    card = view.locator('.fv-thread-layer .thread-card')
    await card.locator('.thread-card-input').fill(`${SLOW} Which slot wins?`)
    await card.locator('.thread-card-input').press('Enter')
    await expect(card).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    lines = frame.locator('#walnut-live-lines .thread-live-line')
    await expect(lines.first()).toBeVisible({ timeout: 10_000 })
    expectUnder(await boxes(lines, await frameOffset()), await frameRects())
    await expectScanning(lines.first(), /^walnut-live-scan$/)
    await shot(page, 'file-html-cell', (await frameRects())[0])
    // The page scrolls: the line rides with the cell.
    await frame.locator('body').evaluate(() => window.scrollBy(0, -120))
    await page.waitForTimeout(150)
    expectUnder(await boxes(lines, await frameOffset()), await frameRects())
    await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    await expect(frame.locator('#walnut-live-lines')).toHaveCount(0, { timeout: 15_000 })
    expect(await frame.locator('body').evaluate(() => (window as unknown as { CSS: { highlights?: Map<string, unknown> } }).CSS.highlights?.has('thread-mark-neutral') ?? false)).toBe(true)
  })
})
