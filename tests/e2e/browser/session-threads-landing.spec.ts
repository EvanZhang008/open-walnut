/**
 * Question stack, landing (spec slice 1, section 5.5 and 5.11): a pop lands on the
 * sentence the question was asked about, exactly where it was, and never arms the
 * outline's Back; a reload restores the page; a pin elsewhere navigates first.
 *
 * Covers C4 and C51 (four pops, each within 8px, one flash, no smooth scroll, no
 * Back), C26 (a mark push), C40 (a rewritten passage lands on its answer with a
 * toast), C69 (reload restores the page, the scroll and `t<n>`; a broken path falls
 * back to root without a toast), C64 (page pins plus `<n> more`, a pin on another
 * page navigates and flashes), C44 (reduced motion: opacity only), and C19, C62,
 * C65 (three columns: one key, one panel; the toast stays in its column).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, DENSE_SESSION, FAILED_SESSION, REWRITTEN_SESSION, openThreadsSession, passageRects, resetThreadsFixture, sessionPanel,
} from './threads-helpers'
import { seedColumns, setPanelMode } from './draft-helpers'
import { buildDenseSession, densePassage, seededThreadState } from './threads-fixture'

const DENSE_TASK = 'pw-task-threads-dense'
const REWRITTEN_TASK = 'pw-task-threads-rewritten'
const DENSE_READY = 'Walk me through part 6 of the storage notes.'
const IDS = buildDenseSession(0).ids
const PASSAGE_GONE = "Couldn't find the exact passage. Showing the answer it came from."

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/threads-p3/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

/** Wheel the timeline until `target` sits near 40% of the box. */
async function centre(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target, { at: 0.4, tolerance: 60, capRow: true })
}

/** The passage's top inside the scroll box, in px from the box's top edge. */
async function passageTop(panel: Locator, phrase: string): Promise<number> {
  const rects = await passageRects(panel, phrase)
  const box = (await panel.locator('.session-history').boundingBox())!
  return rects[0].top - box.y
}

/** Put the passage mid-box with a wheel, then click it: the mark pushes. Returns
 *  where it sat at that moment. */
async function clickMark(page: Page, panel: Locator, phrase: string, depth: number): Promise<number> {
  const row = panel.locator('.session-history [data-message-id] .session-msg-content', { hasText: phrase }).first()
  await expect(row).toBeVisible()
  const historyBox = async () => (await panel.locator('.session-history').boundingBox())!
  let box = await historyBox()
  const hover = panel.locator('[data-thread-mark-hover]')
  // Wheel the passage to 40% of the box, let it settle, hover it. Under load a
  // late layout pass (a history backfill, a WebKit wheel that lands late) can
  // move it again, so the whole step retries until the pointer is on a mark.
  let r = (await passageRects(panel, phrase))[0]
  for (let attempt = 0; attempt < 4 && await hover.count() === 0; attempt++) {
    for (let i = 0; i < 40; i++) {
      // Re-measured every step: the column can still be settling its width.
      box = await historyBox()
      r = (await passageRects(panel, phrase))[0]
      const delta = r.top - (box.y + box.height * 0.4)
      if (Math.abs(delta) < 40) break
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, Math.max(-700, Math.min(700, Math.round(delta))))
      await page.waitForTimeout(160)
    }
    await page.waitForTimeout(400)
    box = await historyBox()
    r = (await passageRects(panel, phrase))[0]
    if (r.top < box.y || r.top + r.height > box.y + box.height) {
      // The wheel did not get it there (seen in WebKit under load: the box took
      // no wheel for a while). Put the row in view directly, then nudge with a
      // real wheel so the timeline counts it as the reader's own scroll.
      await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -2)
      await page.waitForTimeout(300)
      continue
    }
    await page.mouse.move(r.left + 12 + attempt, r.top + r.height / 2, { steps: 3 })
    await page.waitForTimeout(250)
  }
  if (await hover.count() === 0) {
    // Diagnose a miss before failing: what the caret and the painted marks say.
    const seen = await page.evaluate(({ x, y, needle }) => {
      const d = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      const c = d.caretRangeFromPoint?.(x, y)
      const names: string[] = []
      const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
      for (const [n, set] of hl ?? []) for (const rg of set) if (rg.toString().includes(needle.slice(0, 20))) names.push(`${n}:${rg.startContainer.isConnected}`)
      const el = document.elementFromPoint(x, y)
      const h = document.querySelector('.session-history') as HTMLElement | null
      const scroll = h ? { top: h.scrollTop, height: h.scrollHeight, client: h.clientHeight, overflow: getComputedStyle(h).overflowY } : null
      return { caret: c ? `${(c.startContainer.textContent ?? '').slice(0, 30)}@${c.startOffset}` : null, names, el: el ? `${el.tagName}.${String(el.className).slice(0, 60)}` : null, scroll }
    }, { x: r.left + 12, y: r.top + r.height / 2, needle: phrase })
    console.log('mark miss', JSON.stringify({ r, box, seen }))
  }
  await expect(hover).toHaveCount(1)
  const at = r.top - box.y
  await page.mouse.click(r.left + 12, r.top + r.height / 2)
  await expectDepth(panel, depth)
  return at
}

/** Record scrollTop on every frame after the next Esc. */
async function sampleScrollAfterEsc(page: Page, panel: Locator): Promise<number[]> {
  await panel.locator('.session-history').evaluate((el) => {
    const w = window as unknown as { __tops: number[] }
    w.__tops = []
    const tick = () => { w.__tops.push(el.scrollTop); if (w.__tops.length < 24) requestAnimationFrame(tick) }
    window.addEventListener('keydown', () => requestAnimationFrame(tick), { capture: true, once: true })
  })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tops: number[] }).__tops.length)).toBe(24)
  return page.evaluate(() => (window as unknown as { __tops: number[] }).__tops)
}

async function flashText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('walnut-pin-flash')
    return Array.from(hl ?? []).map((r) => r.toString()).join(' | ')
  })
}

test.describe('Question stack landing', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, DENSE_SESSION)
    await resetThreadsFixture(request, REWRITTEN_SESSION)
  })

  test('four marks deep, four Esc back: each pop lands on its sentence, flashes it, never arms Back', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    const chain = ['Q6', 'Q17', 'Q24', 'Q28']
    const asked: number[] = []
    for (let i = 0; i < chain.length; i++) {
      asked.push(await clickMark(page, panel, densePassage(chain[i]), i + 1))
      await expect(panel.locator('.thread-quote-head')).toContainText(densePassage(chain[i]).slice(0, 30))
    }
    await shot(page, 'c4-depth-4')
    for (let i = chain.length - 1; i >= 0; i--) {
      const tops = await sampleScrollAfterEsc(page, panel)
      await expectDepth(panel, i)
      // No smooth scroll: from the second frame after the pop, scrollTop is still.
      const settled = tops.slice(2)
      expect(new Set(settled).size, `scrollTop per frame: ${tops.join(',')}`).toBe(1)
      const phrase = densePassage(chain[i])
      const top = await passageTop(panel, phrase)
      expect(Math.abs(top - asked[i]), `landing drift for ${chain[i]}`).toBeLessThanOrEqual(8)
      await expect.poll(() => flashText(page)).toContain(phrase.slice(0, 20))
      // The question map (always open in this session) never offers Back for a pop.
      await expect(panel.locator('.thread-map .thread-map-body')).toBeVisible()
      await expect(panel.locator('.thread-map-back, .session-toc-back')).toHaveCount(0)
    }
    await shot(page, 'c4-back-at-root')
    await expect(panel.locator('.thread-sliver')).toHaveCount(0)
  })

  test('a passage the answer no longer contains lands on the answer, flashes it and says why', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, REWRITTEN_SESSION, REWRITTEN_TASK, 'Describe the cache expiry rules.')
    const row = panel.locator('.thread-asked-row', { hasText: 'Cache expiry claim' })
    await expect(row).toBeVisible()
    await centre(page, panel, row)
    await row.click()
    await expectDepth(panel, 1)
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await expect(panel.locator('.thread-toast')).toContainText(PASSAGE_GONE)
    const answer = panel.locator('.session-history [data-message-id="0199f401-2222-4aaa-8bbb-000000000001"]')
    await expect(answer).toHaveClass(/user-messages-highlight/)
    // The root page runs under the glass header (as a session without questions
    // does): the answer lands just below the header, never under it.
    const { top, headerBottom } = await answer.evaluate((el) => {
      const header = el.closest('.session-panel')!.querySelector('.session-panel-header')!
      return { top: el.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom }
    })
    expect(top - headerBottom, `answer top ${top}, header bottom ${headerBottom}`).toBeGreaterThanOrEqual(-1)
    expect(top - headerBottom, `answer top ${top}, header bottom ${headerBottom}`).toBeLessThanOrEqual(16)
    await shot(page, 'c40-passage-gone')
  })

  test('reduced motion: a push is a short opacity fade, never a slide', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    const row = panel.locator('.thread-asked-row', { hasText: 'Late flush risk' })
    await centre(page, panel, row)
    await panel.locator('.session-history').evaluate((el) => {
      const w = window as unknown as { __anims: Array<{ duration: number; transform: boolean }> }
      w.__anims = []
      const grab = () => {
        for (const a of el.getAnimations()) {
          const effect = a.effect as KeyframeEffect | null
          const frames = effect?.getKeyframes() ?? []
          w.__anims.push({ duration: Number(effect?.getTiming().duration ?? 0), transform: frames.some((f) => !!f.transform && f.transform !== 'none') })
        }
      }
      new MutationObserver(grab).observe(el, { childList: true, subtree: true })
      document.addEventListener('click', () => requestAnimationFrame(grab), { capture: true })
    })
    await row.click()
    await expectDepth(panel, 1)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __anims: unknown[] }).__anims.length)).toBeGreaterThan(0)
    const anims = await page.evaluate(() => (window as unknown as { __anims: Array<{ duration: number; transform: boolean }> }).__anims)
    for (const a of anims) {
      expect(a.transform, JSON.stringify(anims)).toBe(false)
      expect(a.duration).toBeLessThanOrEqual(120)
    }
    // No breathing dots either.
    const breathing = await page.evaluate(() => Array.from(document.querySelectorAll('.thread-status-dot'))
      .filter((d) => getComputedStyle(d).animationName !== 'none').length)
    expect(breathing).toBe(0)
  })

  test('a reload lands on the same page and scroll, with t<n> in the URL; a broken path falls back to root', async ({ page, request }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    let panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await clickMark(page, panel, densePassage('Q6'), 1)
    await clickMark(page, panel, densePassage('Q17'), 2)
    await clickMark(page, panel, densePassage('Q24'), 3)
    // Scroll the page a little, let the scroll memory settle (300ms), then reload.
    const box = (await panel.locator('.session-history').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(900)
    const before = await panel.locator('.session-history').evaluate((el) => el.scrollTop)
    await expect.poll(() => new URL(page.url()).search).toContain(`=${IDS.head.Q24}`)
    const search = new URLSearchParams(new URL(page.url()).search)
    const column = Array.from(search.entries()).find(([k, v]) => /^s\d+$/.test(k) && v === DENSE_SESSION)
    expect(column, `session column in ${page.url()}`).toBeTruthy()
    expect(search.get(`t${column![0].slice(1)}`)).toBe(IDS.head.Q24)

    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK)
    await expectDepth(panel, 3)
    await expect(panel.locator('.thread-quote-head')).toContainText(densePassage('Q24').slice(0, 30))
    await expect.poll(() => panel.locator('.session-history').evaluate((el) => el.scrollTop)).toBeGreaterThan(before - 9)
    const after = await panel.locator('.session-history').evaluate((el) => el.scrollTop)
    expect(Math.abs(after - before)).toBeLessThanOrEqual(8)
    await shot(page, 'c69-reloaded-depth-3')

    // Remove one anchor on the path (Q17's head) while the app is away (the tab
    // left for a blank page, so no live update re-derives the path first): the
    // next load of the same URL is the root, quietly. (Removed while he watches,
    // the open page keeps its place instead: its own question still exists.)
    const url = page.url()
    await page.goto('about:blank')
    const seed = seededThreadState(DENSE_SESSION, Date.now())!
    const res = await request.patch(`/api/sessions/${DENSE_SESSION}`, {
      data: { thread_anchors: seed.threadAnchors.filter((a) => a.msgId !== IDS.head.Q17) },
    })
    expect(res.ok()).toBe(true)
    await page.goto(url)
    await page.waitForLoadState('networkidle')
    panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await expectDepth(panel, 0)
    await page.waitForTimeout(800)
    await expect(panel.locator('.thread-toast')).toHaveCount(0)
  })

  test('the question map lists every pin under its page; a pin on another page navigates, lands and flashes', async ({ page }) => {
    const lines: string[] = []
    page.on('console', (m) => lines.push(m.text()))
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    // Root to Q1 through the drawer (R0 is above the loaded window), then Q11.
    await panel.locator('.thread-drawer-toggle').click()
    const drawer = panel.locator('.thread-drawer')
    await expect(drawer).toBeVisible()
    await drawer.locator('.thread-tree-row[data-kind="thread"]', { hasText: 'Buffer flush order' }).first().click()
    await expectDepth(panel, 1)
    await expect(drawer).toBeHidden()
    const q11 = panel.locator('.thread-asked-row', { hasText: /point 11/i })
    await centre(page, panel, q11)
    await q11.click()
    await expectDepth(panel, 2)
    // C64 (slice 1b): in a session with questions the map replaces the outline
    // rail and lists the pins under their own pages (this page's and the
    // others'), so no "<n> more" row is needed. A narrow column shows the
    // map's rail: its list opens on hover.
    await expect(panel.locator('.session-toc')).toHaveCount(0)
    const map = panel.locator('.thread-map')
    await expect(map.locator('.thread-map-body')).toBeVisible()
    if (await map.getAttribute('data-shape') === 'rail') await map.locator('.thread-map-rail').hover()
    const pinRows = map.locator('.thread-map-row[data-kind="pin"]')
    await expect(pinRows.filter({ hasText: densePassage('Q21').slice(0, 20) })).toHaveCount(1)
    expect(await pinRows.count()).toBeGreaterThan(1)
    await shot(page, 'c64-map-lists-pins')
    const tb = (await panel.locator('.session-history').boundingBox())!
    await page.mouse.move(tb.x + tb.width * 0.7, tb.y + tb.height * 0.6)
    await expect(map.locator('.thread-map-overlay')).toHaveCount(0)

    // From root, a quote pin that lives on Q21's page (three levels down).
    await panel.locator('.thread-sliver-bar').first().click()
    await expectDepth(panel, 0)
    await panel.locator('.thread-drawer-toggle').click()
    await drawer.locator('.thread-drawer-chip', { hasText: 'Pinned' }).click()
    const pinRow = drawer.locator('.thread-tree-row[data-kind="pin"]', { hasText: densePassage('Q26').slice(0, 24) })
    await expect(pinRow).toBeVisible()
    await pinRow.click()
    await expectDepth(panel, 3)
    await expect.poll(() => flashText(page), { timeout: 15_000 }).toContain(densePassage('Q26').slice(0, 20))
    const top = await passageTop(panel, densePassage('Q26'))
    const height = (await panel.locator('.session-history').boundingBox())!.height
    expect(top).toBeGreaterThan(0)
    expect(top).toBeLessThan(height)
    expect(lines.filter((l) => l.includes('target row did not render'))).toEqual([])
    await shot(page, 'c64-pin-on-another-page')
  })

  test('three columns: Esc and the drawer chord answer in exactly one column; a toast stays in its column', async ({ page }) => {
    const routed: string[] = []
    page.on('console', (m) => {
      if (m.text().includes('key routed')) routed.push(m.text())
    })
    await page.setViewportSize({ width: 3400, height: 1000 })
    await resetThreadsFixture(page.request, FAILED_SESSION)
    await seedColumns(page, [DENSE_SESSION, FAILED_SESSION, REWRITTEN_SESSION])
    // Three columns explicitly (Auto's breakpoints measure the strip beside the
    // chat slot); set back to Auto at the end.
    await setPanelMode(page, '3')
    await boot(page)
    const ids = [DENSE_SESSION, FAILED_SESSION, REWRITTEN_SESSION]
    const panels = ids.map((id) => sessionPanel(page, id))
    for (const p of panels) await expect(p).toBeVisible({ timeout: 30_000 })
    const xs = await Promise.all(panels.map(async (p) => (await p.boundingBox())!.x))
    expect([...xs].sort((a, b) => a - b), 'three columns side by side').toEqual(xs)
    for (const p of panels) {
      const row = p.locator('.thread-asked-row:not(.is-draft)').first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await centre(page, p, row)
      await row.click()
      await expectDepth(p, 1)
    }
    const depths = () => Promise.all(panels.map((p) => p.locator('.thread-stack').getAttribute('data-thread-depth')))
    const drawers = () => Promise.all(panels.map((p) => p.locator('.thread-drawer').isVisible()))
    const pressOnce = async (key: string) => {
      const before = routed.length
      await page.keyboard.press(key)
      await expect.poll(() => routed.length - before, { message: `${key} answered by one panel` }).toBe(1)
      await page.waitForTimeout(250)
      expect(routed.length - before).toBe(1)
    }
    // The chord follows the page's platform (the Desktop Chrome device reports
    // Windows even on a Mac host); the toggle's tooltip names the same one.
    const title = await panels[0].locator('.thread-drawer-toggle').getAttribute('title')
    const CHORD = title?.includes('Cmd') ? 'Meta+Shift+E' : 'Control+Shift+E'
    // C19: keys typed in column 2 move column 2 only.
    await panels[1].locator('.chat-input-textarea').first().click()
    await pressOnce('Escape')
    await expect.poll(depths).toEqual(['1', '0', '1'])
    await pressOnce(CHORD)
    await expect.poll(drawers).toEqual([false, true, false])
    await pressOnce(CHORD)
    await expect.poll(drawers).toEqual([false, false, false])
    // C62: the focus wins over the pointer; with no focus, the pointer's column.
    await panels[0].locator('.chat-input-textarea').first().click()
    const b3 = (await panels[2].locator('.session-history').boundingBox())!
    await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2)
    await pressOnce('Escape')
    await expect.poll(depths).toEqual(['0', '0', '1'])
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2 + 4)
    await pressOnce(CHORD)
    await expect.poll(drawers).toEqual([false, false, true])
    // The open drawer holds the focus and answers its own Esc (no router hop).
    const routedBefore = routed.length
    await page.keyboard.press('Escape')
    await expect.poll(drawers).toEqual([false, false, false])
    expect(routed.length).toBe(routedBefore)
    await expect.poll(depths).toEqual(['0', '0', '1'])
    await shot(page, 'c19-c62-three-columns')

    // C65: a Remove in column 1 toasts inside column 1, above its composer.
    const globalToasts = await page.locator('.notification-toast').count()
    const row = panels[0].locator('.thread-asked-row:not(.is-draft)').first()
    await centre(page, panels[0], row)
    await row.click()
    await expectDepth(panels[0], 1)
    await panels[0].locator('.thread-stack-header .thread-stack-more').click()
    await page.locator('.thread-menu [role="menuitem"]', { hasText: /Remove question/ }).click()
    const confirm = page.locator('.thread-confirm')
    if (await confirm.count() > 0) await confirm.locator('.thread-confirm-btn--danger').click()
    const toast = page.locator('.thread-toast')
    await expect(toast).toHaveCount(1)
    const t = (await toast.boundingBox())!
    const p1 = (await panels[0].boundingBox())!
    const comp = (await panels[0].locator('.chat-input-textarea').first().boundingBox())!
    expect(t.x).toBeGreaterThanOrEqual(p1.x)
    expect(t.x + t.width).toBeLessThanOrEqual(p1.x + p1.width)
    expect(t.y).toBeGreaterThanOrEqual(p1.y)
    expect(t.y + t.height).toBeLessThanOrEqual(comp.y)
    expect(await page.locator('.notification-toast').count()).toBe(globalToasts)
    await shot(page, 'c65-toast-in-column-1')
    // Hover holds it past its 8s: still there after 10s.
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
    await page.waitForTimeout(10_000)
    await expect(toast).toHaveCount(1)
    await page.mouse.move(p1.x + 20, p1.y + 200)
    await setPanelMode(page, 'Auto')
  })
})
