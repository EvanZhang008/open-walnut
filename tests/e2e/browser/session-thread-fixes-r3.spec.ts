/**
 * Slice 1 fixer round 3, measured in the real panel:
 *  - N38: a click on a question mark over a pinned passage opens only the
 *    question, and a pin popover never outlives its page;
 *  - N39: a row Remove right after a row Done still leaves `Removed · Undo`
 *    and its toast;
 *  - N11, N10, N26, N43, N45, N47: drawer rows, summary, counts and filters;
 *  - N14: the toast stays clear of the drawer header and its close button.
 * Dense fixture, reset per test, Chromium and WebKit.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { centreInHistory, DENSE_SESSION, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage, sessionPanel } from './threads-helpers'
import { RELOAD_PASSAGE, RELOAD_SESSION, densePassage } from './threads-fixture'

const TASK = 'pw-task-threads-dense'

test.use({ viewport: { width: 1700, height: 900 } })

async function pinPanelWidth(page: Page, width: number): Promise<void> {
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${DENSE_SESSION}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
}

async function openDense(page: Page, width: number): Promise<Locator> {
  await page.goto('/')
  await pinPanelWidth(page, width)
  const panel = await openThreadsSession(page, DENSE_SESSION, TASK)
  await expect(panel.locator('.thread-drawer-toggle')).toBeVisible({ timeout: 30_000 })
  return panel
}

async function openDrawer(panel: Locator): Promise<Locator> {
  await panel.locator('.thread-drawer-toggle').click()
  const drawer = panel.locator('.thread-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'open')
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  return drawer
}

const chip = (drawer: Locator, name: string) => drawer.locator('.thread-drawer-chip', { hasText: new RegExp(`^${name}\\b`) })
const rowTitled = (drawer: Locator, title: string) =>
  drawer.locator('.thread-tree-row').filter({ has: drawer.page().locator('.thread-tree-title', { hasText: title }) })

type Rect = { left: number; top: number; right: number; bottom: number }
const rectOf = (loc: Locator): Promise<Rect> => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
})
const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

async function goTo(panel: Locator, query: string, title: RegExp | string): Promise<void> {
  const drawer = await openDrawer(panel)
  await drawer.locator('.thread-drawer-chip', { hasText: /^All\b/ }).click()
  const search = drawer.locator('.thread-drawer-search-input')
  await search.fill(query)
  await search.press('Enter')
  await expect(drawer).toHaveCount(0)
  await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(title)
}

/** Wheel `phrase` to 40% of the box and hover it until the mark answers. */
async function hoverMark(page: Page, panel: Locator, phrase: string): Promise<{ x: number; y: number }> {
  const hover = panel.locator('[data-thread-mark-hover]')
  let at = { x: 0, y: 0 }
  for (let attempt = 0; attempt < 8 && await hover.count() === 0; attempt++) {
    const hb = (await panel.locator('.session-history').boundingBox())!
    const r = (await passageRects(panel, phrase))[0]
    if (Math.abs(r.top - (hb.y + hb.height * 0.4)) > 40) {
      await centreInHistory(page, panel, phrase, { at: 0.4, tolerance: 40 })
      continue
    }
    at = { x: r.left + 14 + attempt, y: r.top + r.height / 2 }
    await page.mouse.move(at.x, at.y, { steps: 3 })
    await page.waitForTimeout(300)
  }
  await expect(hover).toHaveCount(1)
  return at
}

test.describe('Slice 1 fixes, round 3', () => {
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  for (const [gap, slow] of [[150, 0], [500, 1500]] as const) test(`a row Remove ${gap}ms after a row Done (writes +${slow}ms) still leaves Removed · Undo and a toast (N39)`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1535, height: 900 })
    if (slow > 0) {
      // The machine the report came from answered a PATCH in about a second:
      // both writes are in flight together.
      await page.route(`**/api/sessions/${DENSE_SESSION}`, async (route) => {
        if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, slow))
        await route.continue()
      })
    }
    const panel = await openDense(page, 720)
    const drawer = await openDrawer(panel)
    await expect(chip(drawer, 'Open')).toHaveAttribute('aria-pressed', 'true')
    const first = rowTitled(drawer, 'Point 22:')
    const second = rowTitled(drawer, 'Point 26:')
    await second.scrollIntoViewIfNeeded()
    await first.hover()
    const check = (await first.getByRole('button', { name: 'Mark done' }).boundingBox())!
    await page.mouse.click(check.x + check.width / 2, check.y + check.height / 2)
    await page.waitForTimeout(gap)
    const box = (await second.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const y = Math.round(box.y)
    const trash = (await second.getByRole('button', { name: 'Remove (Undo available)' }).boundingBox())!
    await page.mouse.click(trash.x + trash.width / 2, trash.y + trash.height / 2)
    const confirm = page.locator('.thread-confirm')
    if (await confirm.count()) await confirm.getByRole('button', { name: 'Remove' }).click()
    const placeholder = drawer.locator('.thread-tree-row--removed')
    await expect(placeholder).toHaveCount(1)
    expect(Math.round((await rectOf(placeholder)).top)).toBe(y)
    await expect(page.locator('.thread-toast')).toContainText(/^Removed /)
    // Still there a moment later, after both writes landed.
    await page.waitForTimeout(2500)
    await expect(placeholder).toHaveCount(1)
    await expect(page.locator('.thread-toast')).toContainText(/^Removed /)
    await placeholder.getByRole('button', { name: 'Undo' }).click()
    await expect(rowTitled(drawer, 'Point 26:')).toHaveCount(1)
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!.filter((m) => m.hidden === true).length).toBe(3)
  })

  test('a question sent here is still there after a reload: its page, its answer and t<n> (N37)', async ({ page, request }) => {
    await resetThreadsFixture(request, RELOAD_SESSION)
    await page.goto('/')
    let panel = await openThreadsSession(page, RELOAD_SESSION, 'pw-task-threads-reload', 'What does the reader do after a rotation?')
    const phrase = RELOAD_PASSAGE.slice(0, 40)
    // Wheel the passage to the middle of the box (a real scroll, like a reader).
    await centreInHistory(page, panel, phrase)
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1')
    const box = panel.locator('.chat-input-textarea').first()
    await box.click()
    await box.fill('what drains first')
    await box.press('Enter')
    await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 60_000 })
    let head = ''
    await expect.poll(async () => {
      const anchors = (await readRecord(request, RELOAD_SESSION)).threadAnchors ?? []
      head = anchors[anchors.length - 1]?.msgId ?? ''
      return anchors.length
    }).toBe(1)
    // The history the server serves now files the question under the uuid the
    // anchor names (the mock CLI wrote it into the transcript, like the real one).
    const hist = await (await request.get(`/api/sessions/${RELOAD_SESSION}/history`)).json() as { messages?: Array<{ role: string; uuid?: string; msgId?: string; id?: string }> }
    expect((hist.messages ?? []).some((m) => m.role === 'user' && (m.uuid ?? m.msgId ?? m.id) === head), 'asked row in the served history').toBe(true)
    await expect.poll(() => new URL(page.url()).search).toContain(`=${head}`)
    await page.reload()
    await page.waitForLoadState('networkidle')
    // The reload itself brings the column back (s<n> in the URL): opening it from
    // the board would race that restore and hide a restore that never came.
    panel = sessionPanel(page, RELOAD_SESSION)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1', { timeout: 30_000 })
    await expect(panel.locator('.thread-quote-head')).toContainText(phrase)
    await expect(panel.locator('.session-history')).toContainText('what drains first')
    await expect(panel.locator('.session-history')).toContainText('processed your message')
    await expect(panel.locator('.thread-drawer-toggle')).toBeVisible()
    expect(new URL(page.url()).search).toContain(`=${head}`)
  })

  test('a click on a question mark over a pinned passage opens only the question, no pin popover (N38)', async ({ page }) => {
    const panel = await openDense(page, 720)
    await goTo(panel, 'point 1 change', 'Buffer flush order')
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1')
    // Point 11 is asked about AND pinned on this page.
    const at = await hoverMark(page, panel, densePassage('Q11'))
    await page.mouse.click(at.x, at.y)
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '2')
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(/^Point 11:/)
    await page.waitForTimeout(600)
    await expect(page.locator('[data-testid="quote-pin-popover"]')).toHaveCount(0)
    // Back on the parent page, nothing of the old press is left over either.
    await page.keyboard.press('Escape')
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1')
    await expect(page.locator('[data-testid="quote-pin-popover"]')).toHaveCount(0)
  })

  test('fullscreen: Ask on already asked passages, Esc back: each sentence lands where it was, the note stays on its page (C4)', async ({ page }) => {
    const panel = await openDense(page, 720)
    await panel.locator('button[title="Expand to full screen"]').click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    const history = panel.locator('.session-history')
    const topOf = async (phrase: string) => {
      const r = (await passageRects(panel, phrase))[0]
      return r.top - (await history.boundingBox())!.y
    }
    const note = panel.locator('.thread-same-passage')
    const chain = ['Q6', 'Q17', 'Q24']
    const asked: number[] = []
    for (let i = 0; i < chain.length; i++) {
      const phrase = densePassage(chain[i])
      await hoverMark(page, panel, phrase)
      await page.waitForTimeout(300)
      asked.push(await topOf(phrase))
      await selectPassage(page, panel, phrase)
      await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
      await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(i + 1))
      await expect(note).toHaveCount(1)
      await page.mouse.move(10, 10)
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      await history.click({ position: { x: 5, y: 5 } }).catch(() => {})
      await page.keyboard.press('Escape')
      await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(i))
      await page.waitForTimeout(400)
      // The page it returns to looks as it was left: its note too (root has none).
      await expect(note).toHaveCount(i > 0 ? 1 : 0)
      const drift = (await topOf(densePassage(chain[i]))) - asked[i]
      expect(Math.abs(drift), `landing drift for ${chain[i]}`).toBeLessThanOrEqual(8)
    }
  })

  for (const width of [480, 720]) {
    test(`drawer rows at ${width}px: no clipped control or label, one Mark done per row, readable triangles (N11, N10, N26, N43)`, async ({ page }) => {
      const panel = await openDense(page, width)
      const drawer = await openDrawer(panel)
      await expect(chip(drawer, 'Open')).toHaveAttribute('aria-pressed', 'true')
      // N43: the Open chip counts what the summary calls open.
      const summary = drawer.locator('.thread-drawer-summary')
      const open = Number(/(\d+) open/.exec((await summary.textContent()) ?? '')?.[1])
      await expect(chip(drawer, 'Open')).toHaveText(`Open ${open}`)
      // N10: a wrap never splits a number from its noun.
      for (const seg of await summary.locator('.thread-drawer-summary-seg').all()) {
        const lines = await seg.evaluate((el) => el.getClientRects().length)
        expect(lines, `segment ${await seg.textContent()} on one line`).toBe(1)
      }
      // N11: every suggested row keeps its verdict whole, and hovering it shows
      // exactly one Mark done and one Not yet, both whole buttons.
      const suggested = drawer.locator('.thread-tree-row[data-status="suggested"]')
      expect(await suggested.count()).toBeGreaterThan(0)
      for (const row of await suggested.all()) {
        await row.hover()
        const cut = await row.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>('.thread-tree-verdict, button'))
          .filter((b) => b.offsetParent !== null && b.scrollWidth > b.clientWidth + 0.5).map((b) => b.textContent))
        expect(cut, 'clipped in a suggested row').toEqual([])
        await expect(row.getByRole('button', { name: 'Mark done' })).toHaveCount(1)
        await expect(row.getByRole('button', { name: 'Not yet' })).toHaveCount(1)
        await expect(row.getByRole('button', { name: 'Mark done' })).toBeVisible()
        await expect(row.getByRole('button', { name: 'Not yet' })).toBeVisible()
      }
      // N26: disclosure triangles as painted (opacity included) keep 3:1.
      const ratio = await drawer.evaluate((root) => {
        const tri = (root.querySelector('.thread-tree-disclosure[data-disabled="true"]:has(svg)')
          ?? root.querySelector('.thread-tree-disclosure:has(svg)')) as HTMLElement
        const body = root.querySelector('.thread-drawer-body') as HTMLElement
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
        let alpha = 1
        for (let el: HTMLElement | null = tri; el && el !== body; el = el.parentElement) alpha *= Number(getComputedStyle(el).opacity)
        const fg = rgb(getComputedStyle(tri).color)
        const bg = rgb(getComputedStyle(body).backgroundColor)
        const mixed = fg.map((v, i) => v * alpha + bg[i] * (1 - alpha))
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const a = lum(mixed)
        const b = lum(bg)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
      expect(ratio, 'painted disclosure contrast').toBeGreaterThanOrEqual(3)
    })
  }

  test('Show hidden questions lists the Hidden group under All only (N45)', async ({ page }) => {
    const panel = await openDense(page, 720)
    await panel.locator('.thread-stack-more').first().click()
    await page.locator('.thread-menu [role="menuitem"]', { hasText: /^Show hidden questions/ }).click()
    const drawer = panel.locator('.thread-drawer')
    await expect(drawer.locator('.thread-tree-group-label')).toHaveText('Hidden')
    await chip(drawer, 'Pinned').click()
    await expect(drawer.locator('.thread-tree-row[data-kind="pin"]').first()).toBeVisible()
    await expect(drawer.locator('.thread-tree-group-label')).toHaveCount(0)
    await expect(drawer.locator('.thread-tree-row[data-kind="hidden"]')).toHaveCount(0)
    await chip(drawer, 'All').click()
    await expect(drawer.locator('.thread-tree-row[data-kind="hidden"]').first()).toBeVisible()
  })

  for (const width of [480, 720]) {
    test(`a row action toast leaves the drawer header and its close button clear at ${width}px (N14)`, async ({ page }) => {
      const panel = await openDense(page, width)
      const drawer = await openDrawer(panel)
      const row = rowTitled(drawer, 'Point 22:')
      await row.hover()
      await row.getByRole('button', { name: 'Mark done' }).click()
      const toast = page.locator('.thread-toast')
      await expect(toast).toContainText(/^Done: /)
      await page.waitForTimeout(600) // the re-measure after the rows settle
      const t = await rectOf(toast)
      // It holds still (a spot that narrows it must not flip it to another).
      await page.waitForTimeout(700)
      expect(await rectOf(toast), 'toast moved after it settled').toEqual(t)
      expect(intersects(t, await rectOf(drawer.locator('.thread-drawer-head'))), 'toast over the drawer header').toBe(false)
      expect(intersects(t, await rectOf(drawer.locator('.thread-drawer-close'))), 'toast over the close button').toBe(false)
      const p = await rectOf(panel)
      expect(t.left).toBeGreaterThanOrEqual(p.left)
      expect(t.right).toBeLessThanOrEqual(p.right)
    })
  }

  test('search keeps every bold match inside its row: one clip per line, a window on a late match (N23)', async ({ page }) => {
    const panel = await openDense(page, 480)
    const drawer = await openDrawer(panel)
    await chip(drawer, 'All').click()
    await drawer.locator('.thread-drawer-search-input').fill('lantern')
    const hits = drawer.locator('.thread-tree-row:not([data-ancestor-only]) .thread-tree-hit')
    await expect(hits.first()).toBeVisible()
    const outside = await hits.evaluateAll((els) => els.filter((m) => {
      const box = (m.closest('.thread-tree-title, .thread-tree-secondary-text, .thread-tree-secondary') as HTMLElement).getBoundingClientRect()
      const r = m.getBoundingClientRect()
      return r.right > box.right + 1 || r.left < box.left - 1
    }).map((m) => m.closest('.thread-tree-row')?.textContent?.slice(0, 60)))
    expect(outside, 'matches hidden under an ellipsis').toEqual([])
    // Each matched row shows its match somewhere.
    const rows = drawer.locator('.thread-tree-row[data-kind="thread"]:not([data-ancestor-only])')
    const bare = await rows.evaluateAll((els) => els.filter((el) => !el.querySelector('.thread-tree-hit')).map((el) => (el as HTMLElement).innerText.replace(/\n/g, ' | ')))
    expect(bare, 'matched rows that show no match').toEqual([])
  })

  test('a 360px column keeps its session title readable next to the toggle (N47)', async ({ page }) => {
    const panel = await openDense(page, 360)
    const toggle = panel.locator('.thread-drawer-toggle')
    await expect(toggle).toHaveText(/\d+ open/)
    // The narrow slot is sized for `<n> to check`; while any question is open
    // the label is `<n> open`, which the base width (the `All done` width) fits.
    await expect(toggle).toHaveAttribute('data-tier', 'base')
    const title = panel.locator('.session-panel-title').first()
    // The old 117px pill left `Threa…` (about 40px).
    expect((await rectOf(title)).right - (await rectOf(title)).left, 'session title width').toBeGreaterThanOrEqual(70)
  })

  test('resolved marks are grey and dotted, open marks keep their hue (N48)', async ({ page }) => {
    await openDense(page, 720)
    const rules = await page.evaluate(() => {
      const out: Record<string, { bg: string; deco: string }> = {}
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList
        try { list = sheet.cssRules } catch { continue }
        for (const r of Array.from(list)) {
          const sr = r as CSSStyleRule
          if (sr.selectorText === '::highlight(thread-mark-280)' || sr.selectorText === '::highlight(thread-mark-done-280)') {
            out[sr.selectorText] = { bg: sr.style.getPropertyValue('background-color'), deco: sr.style.getPropertyValue('text-decoration') }
          }
        }
      }
      return out
    })
    const sat = (c: string) => {
      const hsl = /hsl\(\s*[\d.]+\s+([\d.]+)%/.exec(c)
      if (hsl) return Number(hsl[1])
      const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Number(v) / 255)
      const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2
      return max === min ? 0 : 100 * (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min))
    }
    const open = rules['::highlight(thread-mark-280)']
    const done = rules['::highlight(thread-mark-done-280)']
    expect(open && done, JSON.stringify(rules)).toBeTruthy()
    expect(sat(open.bg) - sat(done.bg), `${open.bg} vs ${done.bg}`).toBeGreaterThanOrEqual(40)
    expect(done.deco).toContain('dotted')
  })

  test('the follow-ups confirm opened from the keyboard rings its default button (N46)', async ({ page }) => {
    const panel = await openDense(page, 720)
    const drawer = await openDrawer(panel)
    const row = rowTitled(drawer, 'Buffer flush order')
    await row.focus()
    await page.keyboard.press(' ')
    const confirm = page.locator('.thread-confirm')
    await expect(confirm).toContainText(/follow-ups done\?/)
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const cs = getComputedStyle(el)
      return { text: el.textContent, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }
    })
    expect(ring.text).toBe('Only this one')
    expect(ring.style).not.toBe('none')
    expect(ring.width).toBeGreaterThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
  })

  test('the first question is born without moving the page: the header keeps its height (N15)', async ({ page, request }) => {
    await resetThreadsFixture(request, RELOAD_SESSION)
    await page.goto('/')
    const panel = await openThreadsSession(page, RELOAD_SESSION, 'pw-task-threads-reload', 'What does the reader do after a rotation?')
    await expect(panel.locator('.thread-drawer-toggle')).toHaveCount(0)
    const header = panel.locator('.session-panel-header')
    const h0 = (await rectOf(header)).bottom - (await rectOf(header)).top
    const phrase = RELOAD_PASSAGE.slice(0, 40)
    for (let i = 0; i < 40; i++) {
      const hb = (await panel.locator('.session-history').boundingBox())!
      const r = (await passageRects(panel, phrase))[0]
      const delta = r.top - (hb.y + hb.height * 0.45)
      if (Math.abs(delta) < 50) break
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.wheel(0, Math.max(-700, Math.min(700, Math.round(delta))))
      await page.waitForTimeout(160)
    }
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    const box = panel.locator('.chat-input-textarea').first()
    await box.click()
    await box.fill('how long is a rotation')
    await box.press('Enter')
    await expect(panel.locator('.thread-drawer-toggle')).toBeVisible({ timeout: 30_000 })
    const h1 = (await rectOf(header)).bottom - (await rectOf(header)).top
    expect(Math.abs(h1 - h0), `header ${h0}px before the first question, ${h1}px after`).toBeLessThan(0.5)
  })
})
