/**
 * Question stack, core (spec slice 1, section 5.1 and 5.4): a question page is the
 * SAME timeline scroll box filtered to one question, with a sliver of ancestor bars
 * on the content column's left edge.
 *
 * Covers C1, C2 (Ask opens a pending page at once, Esc before sending writes
 * nothing), C5 and C79 (sliver bars, shades, gaps, geometry, drag vs click), C6
 * (one scroll box at every depth), C8 and C83 (no arrows, dashes or the old word),
 * C9 and C10 (a session without questions renders as before, the old UI is gone),
 * C18 (Esc layering), C61 (the slash palette and the model picker keep their Esc)
 * and C50 (fullscreen: pops first, then it exits). Landing, send and view specs
 * live beside this file.
 *
 * The dense fixture (threads-fixture.ts) is read only here: pushes and pops live
 * in sessionStorage, never on the server, so no reset is needed between tests.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, AI_SESSION, DENSE_SESSION, NO_THREAD_SESSION, findBannedGlyphs, openThreadsSession, passageRects,
  readRecord, resetThreadsFixture, selectPassage,
} from './threads-helpers'
import { AI_PASSAGE } from './threads-fixture'

const DENSE_TASK = 'pw-task-threads-dense'
const AI_TASK = 'pw-task-threads-ai'
const NO_THREAD_TASK = 'pw-task-outline-window'
/** The last root turn of the dense fixture: its root page has loaded. */
const DENSE_READY = 'Walk me through part 6 of the storage notes.'
/** The fixture's own titles say "Threads ... fixture": data, not UI text. */
const FIXTURE_TITLE = /fixture (session|task)/i
/** The question UI inside a panel: stack row, sliver, quote head, Asked-from rows,
 *  linear banner, drawer and its toggle, resolved strip, rail, queued note. */
const NEW_UI = [
  '.thread-stack-header', '.thread-sliver', '.thread-quote-head-wrap', '.thread-asked-from', '.thread-linear-banner',
  '.thread-drawer', '.thread-drawer-toggle', '.thread-strip', '.session-toc', '.thread-queue-note', '.thread-stack-more',
].join(', ')

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/threads-p3/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function boot(page: Page): Promise<void> {
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message, (e.stack ?? '').slice(0, 1500)))
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLEERR', m.text().slice(0, 1500)) })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

function frame(panel: Locator): Locator {
  return panel.locator('.thread-stack')
}

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(frame(panel)).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

/** Scroll the timeline with REAL wheel steps until `target` sits mid-box (a
 *  programmatic scrollTop write can be snapped back by bottom follow). */
async function centre(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target, { tolerance: 60, capRow: true })
}

/** Open an "Asked from this answer" row by its text (the real click path). */
async function openAsked(page: Page, panel: Locator, text: string | RegExp, depth: number): Promise<void> {
  const row = panel.locator('.thread-asked-row', { hasText: text }).first()
  await expect(row).toBeVisible()
  await centre(page, panel, row)
  await row.click()
  await expectDepth(panel, depth)
}

test.describe('Question stack', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, DENSE_SESSION)
    await resetThreadsFixture(request, AI_SESSION)
  })

  test('a session without questions renders exactly as before; the old question UI is gone', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, NO_THREAD_SESSION, NO_THREAD_TASK, 'outline filler reply 230')
    // C10: no drawer button, no sliver, no edge hot zone, no question menu, and the
    // frame adds nothing (display: contents), so the box is the one it always was.
    await expect(panel.locator('.thread-drawer-toggle')).toHaveCount(0)
    await expect(panel.locator('.thread-sliver')).toHaveCount(0)
    await expect(panel.locator('.thread-drawer-edge, .thread-drawer')).toHaveCount(0)
    await expect(panel.locator('.thread-stack-more')).toHaveCount(0)
    await expect(frame(panel)).toHaveCount(0)
    const off = panel.locator('.thread-stack-off')
    await expect(off).toHaveCount(1)
    expect(await off.evaluate((el) => getComputedStyle(el).display)).toBe('contents')
    const history = panel.locator('.session-history')
    await expect(history).toHaveAttribute('data-view-mode', 'linear')
    const pad = await history.evaluate((el) => getComputedStyle(el).paddingLeft)
    expect(parseFloat(pad)).toBeLessThanOrEqual(40)
    // C9: the map, the chip, the Linear/Tree toggle and the reply-arrow tags are gone.
    await expect(page.locator('.session-view-toggle, .thread-map, [data-testid="thread-anchor-chip"]')).toHaveCount(0)
    await expect(page.locator('.session-msg-thread-tag, .thread-breadcrumb, .thread-child-card')).toHaveCount(0)
    const mapRule = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try { rules = sheet.cssRules } catch { continue }
        for (const r of Array.from(rules)) {
          if (r.cssText.includes('data-thread-map') || r.cssText.includes('176px + 24px')) return r.cssText
        }
      }
      return null
    })
    expect(mapRule, 'the map gutter rule is deleted').toBeNull()
    // Pixel check against the DOM the old build rendered (no wrapper at all): lift
    // the wrapper's children into its parent and shoot again. Same pixels = the
    // wrapper adds nothing. Last step of the test (React never sees this DOM again).
    const dir = `/tmp/threads-p3/e2e/${test.info().project.name}`
    await fs.mkdir(dir, { recursive: true })
    // Both shots with transitions off: a moved node restarts its fades (the row
    // actions' hover fade), which is timing, not layout.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
    await page.mouse.move(2, 2)
    await page.waitForTimeout(1000)
    const withFrame = await panel.screenshot({ path: `${dir}/c10-no-questions.png`, animations: 'disabled', mask: [panel.locator('.session-msg-actions')] })
    await off.evaluate((el) => {
      // Moving a node resets its scroll offset: carry every offset across.
      const scrolled = Array.from(el.querySelectorAll<HTMLElement>('*')).filter((n) => n.scrollTop > 0)
        .map((n) => [n, n.scrollTop] as const)
      const parent = el.parentElement!
      while (el.firstChild) parent.insertBefore(el.firstChild, el)
      el.remove()
      for (const [n, top] of scrolled) n.scrollTop = top
    })
    // Each row's action strip (copy, pin, relative time) is masked in both shots:
    // its fade follows hover and the clock, which a moved node re-evaluates. Moved nodes restart their transitions (the hover fade of a row's actions):
    // let them settle before the second shot.
    await page.waitForTimeout(1000)
    const unwrapped = await panel.screenshot({ path: `${dir}/c10-no-questions-unwrapped.png`, animations: 'disabled', mask: [panel.locator('.session-msg-actions')] })
    expect(withFrame.equals(unwrapped), 'the panel is pixel-identical without the wrapper').toBe(true)
  })

  test('Ask opens a question page in the same frame; Esc before sending writes nothing', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, AI_SESSION, AI_TASK, 'How should the reader treat stale copies?')
    const passage = AI_PASSAGE.slice(0, 44)
    await centre(page, panel, panel.locator('.session-msg-content', { hasText: passage }).first())
    await passageRects(panel, passage)
    await selectPassage(page, panel, passage)
    const ask = page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]')
    await expect(ask).toBeVisible()
    // Sample the DOM one animation frame after the click that asks.
    await page.evaluate(() => {
      const w = window as unknown as { __askFrame?: string | null }
      w.__askFrame = null
      document.addEventListener('click', (e) => {
        if (!(e.target as Element).closest?.('[data-testid="quote-ask-btn"]')) return
        requestAnimationFrame(() => {
          const f = document.querySelector('.thread-stack')
          w.__askFrame = `${f?.getAttribute('data-thread-depth') ?? 'none'}:${f?.querySelectorAll('.thread-quote-head').length ?? 0}`
        })
      }, { capture: true, once: true })
    })
    await ask.click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __askFrame?: string | null }).__askFrame)).toBe('1:1')
    // C1: a depth-1 page, the passage in its quote head, the composer focused and
    // empty, no chip anywhere.
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-quote-head')).toContainText(passage)
    const textarea = panel.locator('.chat-input-textarea').first()
    await expect(textarea).toBeFocused()
    await expect(textarea).toHaveValue('')
    await expect(textarea).toHaveAttribute('placeholder', 'Ask about this passage…')
    await expect(page.locator('[data-testid="thread-anchor-chip"], .thread-anchor-chip')).toHaveCount(0)
    // The stack row names the page without repeating the quote head below it (N17).
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText('New question')
    await shot(page, 'c1-pending-page')
    // C2: Esc on the unsent page returns to root and writes nothing.
    await page.keyboard.press('Escape')
    await expect(frame(panel)).toHaveCount(0)
    await expect(panel.locator('.thread-quote-head')).toHaveCount(0)
    const record = await readRecord(request, AI_SESSION)
    expect(record.threadAnchors ?? []).toHaveLength(0)
    expect(record.threadMeta ?? []).toHaveLength(0)
  })

  test('the sliver: one bar per ancestor, distinct shades, 1px gaps; the outermost bar pops to root', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    const history = panel.locator('.session-history')
    // C6: tag the scroll box; every depth must render into this same element.
    await history.evaluate((el) => { (el as unknown as { __probe: number }).__probe = 7 })
    const bars = panel.locator('.thread-sliver-bar')
    await openAsked(page, panel, 'Late flush risk', 1)
    await expect(bars).toHaveCount(1)
    await openAsked(page, panel, 'Reader skip cost', 2)
    await expect(bars).toHaveCount(2)
    expect(await panel.locator('.session-history').count(), 'one timeline scroll box').toBe(1)
    expect(await history.evaluate((el) => (el as unknown as { __probe?: number }).__probe)).toBe(7)
    await openAsked(page, panel, /point 24/i, 3)
    await openAsked(page, panel, /point 28/i, 4)
    await expect(bars).toHaveCount(4)
    expect(await history.evaluate((el) => (el as unknown as { __probe?: number }).__probe)).toBe(7)
    await expect(bars.first()).toHaveAttribute('data-root', '')

    const geometry = () => bars.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, width: r.width, color: getComputedStyle(el).backgroundColor }
    }))
    const light = await geometry()
    // C5: each level its own shade, a 1px transparent gap between bars.
    expect(new Set(light.map((b) => b.color)).size, JSON.stringify(light)).toBe(4)
    for (let i = 1; i < light.length; i++) expect(Math.round(light[i].left - light[i - 1].right)).toBe(1)
    for (const b of light) expect([8, 10]).toContain(Math.round(b.width))
    await shot(page, 'c5-sliver-light')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    const dark = await geometry()
    expect(new Set(dark.map((b) => b.color)).size, JSON.stringify(dark)).toBe(4)
    expect(dark.map((b) => b.color)).not.toEqual(light.map((b) => b.color))
    await shot(page, 'c5-sliver-dark')
    await page.evaluate(() => { delete document.documentElement.dataset.theme })

    // The outermost bar pops straight to root and flashes ONE landing.
    await page.evaluate(() => {
      const w = window as unknown as { __flashes: string[] }
      w.__flashes = []
      const tick = () => {
        const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('walnut-pin-flash')
        for (const r of hl ?? []) if (!w.__flashes.includes(r.toString())) w.__flashes.push(r.toString())
        if (w.__flashes.length < 5) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await bars.first().click()
    await expectDepth(panel, 0)
    await expect(bars).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __flashes: string[] }).__flashes.length)).toBeGreaterThan(0)
    await page.waitForTimeout(900)
    const flashes = await page.evaluate(() => (window as unknown as { __flashes: string[] }).__flashes)
    expect(flashes, 'only the final landing flashes').toHaveLength(1)
    expect(flashes[0]).toContain('Point 6:')
  })

  test('sliver geometry: beside the content column; a drag does not pop; hover names the level', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await openAsked(page, panel, 'Late flush risk', 1)
    await openAsked(page, panel, 'Reader skip cost', 2)
    const bars = panel.locator('.thread-sliver-bar')
    await expect(bars).toHaveCount(2)
    // C79: the last bar's right edge is within 12px of the content column (read
    // once the push slide, a translateX on the scroll box, has finished).
    await expect.poll(() => panel.locator('.session-history').evaluate((el) => el.getAnimations().length)).toBe(0)
    const gap = await panel.evaluate((root) => {
      const bar = Array.from(root.querySelectorAll('.thread-sliver-bar')).pop()!.getBoundingClientRect()
      const row = root.querySelector('.session-history .thread-quote-head')!
      return row.getBoundingClientRect().left - bar.right
    })
    expect(gap).toBeGreaterThanOrEqual(0)
    expect(gap).toBeLessThanOrEqual(12)
    // Rail and sliver never overlap.
    const overlap = await panel.evaluate((root) => {
      const rail = root.querySelector('.session-toc-rail')?.getBoundingClientRect()
      const first = root.querySelector('.thread-sliver-bar')!.getBoundingClientRect()
      return rail ? rail.right > first.left && rail.left < first.right + 20 && rail.width > 0 : false
    })
    expect(overlap).toBe(false)
    // A 10px drag that starts on a bar is not a click.
    const box = (await bars.last().boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + 200, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    await expectDepth(panel, 2)
    // Hover: the hit zone is 16px wide and the tooltip names the level.
    const zone = await bars.last().evaluate((el) => {
      const s = getComputedStyle(el, '::before')
      return el.getBoundingClientRect().width - parseFloat(s.left) - parseFloat(s.right)
    })
    expect(Math.round(zone)).toBe(Math.round(box.width) + 6)
    expect(Math.round(zone)).toBeGreaterThanOrEqual(14)
    await page.mouse.move(box.x + box.width / 2, box.y + 240)
    await page.mouse.move(box.x + box.width / 2, box.y + 246)
    const tip = page.locator('.thread-hover-tip')
    await expect(tip).toHaveText('Back to Late flush risk')
    await expect(bars.last()).toHaveCSS('cursor', 'pointer')
    await shot(page, 'c79-sliver-hover')
    // A still click pops exactly one level.
    await page.mouse.click(box.x + box.width / 2, box.y + 246)
    await expectDepth(panel, 1)
  })

  test('no reply arrows, dashes, hamburger or check glyphs, and never the old word, in the question UI', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    const scan = async (where: string) => {
      // Every surface this slice adds (the rest of the panel is older UI).
      const scopes = [
        panel.locator(NEW_UI), page.locator('.thread-menu'), page.locator('.thread-hover-tip'), page.locator('.thread-toast'),
      ]
      for (const scope of scopes) {
        if (await scope.count() === 0) continue
        for (let i = 0; i < await scope.count(); i++) {
          const hits = (await findBannedGlyphs(page, scope.nth(i))).filter((h) => !FIXTURE_TITLE.test(h.value))
          expect(hits, `${where}: ${JSON.stringify(hits)}`).toEqual([])
          const glyphs = await scope.nth(i).evaluate((el) => {
            const out: string[] = []
            const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
            for (let n = w.nextNode(); n; n = w.nextNode()) {
              if (n.parentElement?.closest('.session-msg-content')) continue
              if (/[☰✓✔]/.test(n.textContent ?? '')) out.push((n.textContent ?? '').trim())
            }
            return out
          })
          expect(glyphs, `${where}: hamburger / check glyphs`).toEqual([])
        }
      }
    }
    await scan('root page')
    await openAsked(page, panel, 'Late flush risk', 1)
    await openAsked(page, panel, 'Reader skip cost', 2)
    await scan('depth 2')
    await panel.locator('.thread-stack-header .thread-stack-more').click()
    await expect(page.locator('.thread-menu')).toBeVisible()
    await scan('page menu')
    await page.keyboard.press('Escape')
    await panel.locator('.thread-drawer-toggle').click()
    await expect(panel.locator('.thread-drawer')).toBeVisible()
    await scan('drawer open')
    await shot(page, 'c8-drawer-depth2')
  })

  test('Esc is layered: menu, then drawer; typed text and IME composition never pop', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await openAsked(page, panel, 'Late flush risk', 1)
    // A menu open: Esc closes only the menu.
    await panel.locator('.thread-stack-header .thread-stack-more').click()
    await expect(page.locator('.thread-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.thread-menu')).toHaveCount(0)
    await expectDepth(panel, 1)
    // The drawer open: Esc closes only the drawer.
    await panel.locator('.thread-drawer-toggle').click()
    const drawer = panel.locator('.thread-drawer')
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expectDepth(panel, 1)
    // Text in the composer: Esc keeps the page.
    const textarea = panel.locator('.chat-input-textarea').first()
    await textarea.click()
    await textarea.fill('half a follow up')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await expectDepth(panel, 1)
    await expect(textarea).toHaveValue('half a follow up')
    // IME composition: an Esc that ends composing is not a pop.
    await textarea.fill('')
    await textarea.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(300)
    await expectDepth(panel, 1)
    // Empty composer, nothing open: Esc pops.
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
  })

  test('the composer overlays and fullscreen keep their Esc; the page pops only between them', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await openAsked(page, panel, 'Late flush risk', 1)
    await openAsked(page, panel, 'Reader skip cost', 2)
    const textarea = panel.locator('.chat-input-textarea').first()
    // C61: the slash palette takes its Esc; the page stays.
    await textarea.click()
    await textarea.fill('/')
    const palette = panel.locator('.command-palette')
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await expectDepth(panel, 2)
    await textarea.fill('')
    // The model picker takes its Esc too.
    const pill = panel.locator('.composer-controls-bar [data-control-id="model"] button').first()
    if (await pill.isVisible()) await pill.click()
    else {
      await panel.getByTestId('composer-overflow-btn').click()
      await page.getByTestId('composer-overflow-item-model').click()
    }
    const picker = page.locator('.model-picker').first()
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('.model-picker')).toHaveCount(0)
    await expectDepth(panel, 2)

    // C50: fullscreen at depth 2: two Esc pop, only the third leaves fullscreen.
    await panel.locator('button[title="Expand to full screen"]').click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await textarea.click()
    await page.keyboard.press('Escape')
    await expectDepth(panel, 1)
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await page.waitForTimeout(300)
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await shot(page, 'c50-fullscreen-root')
    await page.keyboard.press('Escape')
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
  })
})
