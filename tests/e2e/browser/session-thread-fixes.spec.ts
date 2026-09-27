/**
 * Layout fixes of the slice 1 fixer round, measured in the real panel:
 *  - N13: the drawer starts below the session header, so its toggle (click again
 *    to close) and the session name stay reachable at 480px;
 *  - N14: the toast after Done leaves the row that just changed visible;
 *  - N19: a resolved Asked-from row reads grey;
 *  - N22: in Show all in order the outline rail sits over the gutter bars on an
 *    opaque backing.
 * Dense fixture, reset per test, Chromium and WebKit.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { centreInHistory, DENSE_SESSION, openThreadsSession, passageRects, resetThreadsFixture } from './threads-helpers'
import { densePassage } from './threads-fixture'

const TASK = 'pw-task-threads-dense'

// Wide enough that a 720px column sits beside the board and the Ask slot
// instead of under them (the pointer and hit tests need the whole panel).
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

async function goTo(panel: Locator, query: string, title: RegExp): Promise<void> {
  await panel.locator('.thread-drawer-toggle').click()
  const drawer = panel.locator('.thread-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'open')
  await drawer.locator('.thread-drawer-chip', { hasText: /^All\b/ }).click()
  const search = drawer.locator('.thread-drawer-search-input')
  await search.fill(query)
  await search.press('Enter')
  await expect(drawer).toHaveCount(0)
  await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(title)
}

/** Wheel `target` into the middle of the transcript (WebKit will not click a
 *  row its own scroll-into-view left outside the viewport). */
async function centre(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target)
}

type Rect = { left: number; top: number; right: number; bottom: number }
const rectOf = (loc: Locator): Promise<Rect> => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
})
const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Is the centre of `loc` the topmost thing at that point (or inside it)? */
const onTop = (loc: Locator): Promise<boolean> => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return !!hit && (hit === el || el.contains(hit))
})

test.describe('Slice 1 layout fixes', () => {
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  for (const width of [480, 720]) {
    test(`the open drawer leaves the header toggle and the session name reachable at ${width}px (N13)`, async ({ page }) => {
      const panel = await openDense(page, width)
      const toggle = panel.locator('.thread-drawer-toggle')
      await toggle.click()
      const drawer = panel.locator('.thread-drawer')
      await expect(drawer).toHaveAttribute('data-mode', 'open')
      const header = await rectOf(panel.locator('.session-panel-header'))
      const box = await rectOf(drawer)
      expect(box.top, 'drawer starts below the session header').toBeGreaterThanOrEqual(header.bottom)
      expect(await onTop(toggle), 'toggle is not covered').toBe(true)
      expect(await onTop(panel.locator('.session-panel-title').first()), 'session name is not covered').toBe(true)
      await toggle.click()
      await expect(drawer).toHaveCount(0)
    })
  }

  for (const width of [480, 720]) {
    test(`the Done toast leaves the resolved row visible at ${width}px (N14)`, async ({ page }) => {
      const panel = await openDense(page, width)
      await goTo(panel, 'point 22 change', /^Point 22:/)
      await panel.locator('.thread-stack-header .thread-stack-done').click()
      await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '2')
      const toast = page.locator('.thread-toast')
      await expect(toast).toContainText(/^Done: /)
      const row = panel.locator('.thread-asked-row.is-resolved', { hasText: /Point 22/ }).first()
      await expect(row).toBeVisible()
      // Let the re-measure after the pop land (one frame + 300ms).
      await page.waitForTimeout(600)
      const t = await rectOf(toast)
      const r = await rectOf(row)
      expect(intersects(t, r), `toast ${JSON.stringify(t)} over row ${JSON.stringify(r)}`).toBe(false)
      // The toast stays inside its panel.
      const p = await rectOf(panel)
      expect(t.left).toBeGreaterThanOrEqual(p.left)
      expect(t.right).toBeLessThanOrEqual(p.right)
    })
  }

  test('a resolved Asked-from row reads grey, an open one does not (N19)', async ({ page }) => {
    const panel = await openDense(page, 1400)
    const resolved = panel.locator('.thread-asked-row.is-resolved .thread-asked-title').first()
    const open = panel.locator('.thread-asked-row:not(.is-resolved):not(.is-draft) .thread-asked-title').first()
    await expect(resolved).toBeVisible()
    await expect(open).toBeVisible()
    const colours = await panel.evaluate((root) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--fg-muted)'
      root.appendChild(probe)
      const muted = getComputedStyle(probe).color
      probe.remove()
      const res = root.querySelector('.thread-asked-row.is-resolved .thread-asked-title') as HTMLElement
      const opn = root.querySelector('.thread-asked-row:not(.is-resolved):not(.is-draft) .thread-asked-title') as HTMLElement
      return { muted, resolved: getComputedStyle(res).color, open: getComputedStyle(opn).color }
    })
    expect(colours.resolved).toBe(colours.muted)
    expect(colours.open).not.toBe(colours.muted)
  })

  test('Show all in order: the outline rail sits on an opaque backing over the gutter bars (N22)', async ({ page }) => {
    const panel = await openDense(page, 1400)
    await goTo(panel, 'point 17 change', /^Reader skip cost$/)
    await panel.locator('.thread-stack-header .thread-stack-more').click()
    await page.locator('.thread-menu [role="menuitem"]', { hasText: 'Show all in order' }).click()
    await expect(panel.locator('.thread-linear-banner')).toBeVisible()
    await expect(panel.locator('.session-msg--threaded').first()).toBeAttached()
    const rail = panel.locator('.session-toc-rail')
    await expect(rail).toBeVisible()
    // The rail fades in over 120ms: read it once it settled.
    await expect.poll(() => rail.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    const style = await rail.evaluate((el) => {
      const cs = getComputedStyle(el)
      const tick = el.querySelector('.session-toc-tick')
      return { bg: cs.backgroundColor, opacity: cs.opacity, tickOpacity: tick ? getComputedStyle(tick).opacity : null }
    })
    // Opaque: rgb(...) or an rgba/color() with alpha 1, and the rail itself not faded.
    expect(style.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    expect(style.bg).not.toMatch(/\/ 0\.|, 0\.\d+\)$/)
    expect(style.opacity).toBe('1')
    expect(style.tickOpacity).toBe('0.55')
  })

  test('keyboard cursor row and the toggle after an Esc close both show a ring, in WebKit too (N5, N34)', async ({ page }) => {
    const panel = await openDense(page, 720)
    await panel.locator('.thread-drawer-toggle').click()
    const drawer = panel.locator('.thread-drawer')
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await drawer.locator('.thread-drawer-search-input').click()
    // Focus moves a frame after each key (the row can render late): pace them.
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200) }
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.classList.contains('thread-tree-row'))).toBe(true)
    const cursor = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el?.classList.contains('thread-tree-row')) return { row: false, ring: `${el?.tagName}.${String(el?.className ?? '')}` }
      const cs = getComputedStyle(el)
      return { row: true, ring: `${cs.boxShadow} | ${cs.outlineStyle}` }
    })
    expect(cursor.row, `focus is on a tree row, not ${cursor.ring}`).toBe(true)
    expect(cursor.ring, 'the cursor row wears the 2px inset ring').toMatch(/inset|solid/)
    expect(cursor.ring).not.toMatch(/^none \| none$/)
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    const toggle = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el?.classList.contains('thread-drawer-toggle')) return { toggle: false, outline: `${el?.tagName}.${String(el?.className ?? '')}` }
      const cs = getComputedStyle(el)
      return { toggle: true, outline: `${cs.outlineStyle} ${cs.outlineWidth}` }
    })
    expect(toggle.toggle, `focus returned to the toggle, not ${toggle.outline}`).toBe(true)
    expect(toggle.outline).toBe('solid 2px')
  })

  test('a page change clears the mark tooltip of the page it left (N8)', async ({ page }) => {
    const panel = await openDense(page, 720)
    const history = panel.locator('.session-history')
    const asked = panel.locator('.thread-asked-row', { hasText: 'Late flush risk' }).first()
    await expect(asked).toBeVisible()
    await centre(page, panel, asked)
    await asked.click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1')
    const phrase = densePassage('Q17')
    const tip = page.locator('.thread-hover-tip')
    for (let attempt = 0; attempt < 6 && await tip.count() === 0; attempt++) {
      const box = (await history.boundingBox())!
      const r = (await passageRects(panel, phrase))[0]
      const delta = r.top - (box.y + box.height * 0.4)
      if (Math.abs(delta) > 40) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, Math.max(-700, Math.min(700, Math.round(delta))))
        await page.waitForTimeout(400)
        continue
      }
      await page.mouse.move(r.left + 14 + attempt, r.top + r.height / 2, { steps: 3 })
      await page.waitForTimeout(300)
    }
    await expect(tip).toContainText('Reader skip cost')
    // Esc with the pointer still on the spot: the root page shows, the tip goes.
    await page.keyboard.press('Escape')
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '0')
    await expect(tip).toHaveCount(0)
  })

  test('the root page windows over its own rows: every root answer renders, no inflated Show earlier (N9)', async ({ page }) => {
    const panel = await openDense(page, 720)
    const history = panel.locator('.session-history')
    // Six root turns among 70 transcript rows: the old raw window of 30 left
    // R0 to R2 unrendered behind a `Show 46 earlier messages` that revealed 6.
    for (let r = 1; r <= 6; r++) await expect(history).toContainText(`Walk me through part ${r} of the storage notes.`)
    const btn = panel.locator('.session-show-earlier-btn')
    if (await btn.count() > 0) {
      const label = (await btn.textContent()) ?? ''
      const shown = Number(/Show (\d+)/.exec(label)?.[1] ?? '0')
      const before = await history.locator('[data-message-id]').count()
      await btn.click()
      await expect.poll(() => history.locator('[data-message-id]').count()).toBe(before + shown)
    }
  })

  for (const width of [480, 720]) {
    test(`drawer text stays whole and its triangles read at ${width}px (N10, N11, N26)`, async ({ page }) => {
      const panel = await openDense(page, width)
      await panel.locator('.thread-drawer-toggle').click()
      const drawer = panel.locator('.thread-drawer')
      await expect(drawer).toHaveAttribute('data-mode', 'open')
      await drawer.locator('.thread-drawer-chip', { hasText: /^All\b/ }).click()
      const summary = drawer.locator('.thread-drawer-summary')
      await expect(summary).toContainText('pinned')
      expect(await summary.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1), 'summary is not cut').toBe(true)
      const verdicts = drawer.locator('.thread-tree-verdict')
      await expect(verdicts.first()).toBeVisible()
      const cut = await verdicts.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 0.5).map((el) => el.textContent))
      expect(cut, 'Looks answered labels cut').toEqual([])
      const ratio = await drawer.evaluate((root) => {
        const tri = root.querySelector('.thread-tree-disclosure') as HTMLElement | null
        const body = root.querySelector('.thread-drawer-body') as HTMLElement | null
        if (!tri || !body) return 0
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
        const lum = (c: string) => {
          const [r, g, b] = rgb(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const a = lum(getComputedStyle(tri).color)
        const b = lum(getComputedStyle(body).backgroundColor)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
      expect(ratio, 'disclosure triangle contrast').toBeGreaterThanOrEqual(3)
    })
  }
})

