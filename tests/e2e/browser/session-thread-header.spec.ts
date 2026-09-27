/**
 * Stack chrome (spec 5.2, 5.3, 5.6 to 5.8): the one 36px stack row (back,
 * question path, title, Done, More), inline rename, the Done split and the
 * follow-ups confirm, the More menu's Remove confirm, and the resolved strip's
 * takeaway edit. Dense fixture, reset per test, Chromium and WebKit.
 *
 * Checklist: C13, C21, C22, C24, C39, C46, C52, C70, C74, C78.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DENSE_SESSION, openThreadsSession, readRecord, resetThreadsFixture } from './threads-helpers'
import { buildDenseSession } from './threads-fixture'

const TASK = 'pw-task-threads-dense'

async function pinPanelWidth(page: Page, width: number): Promise<void> {
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${DENSE_SESSION}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
}

async function openDense(page: Page, width = 1400): Promise<Locator> {
  await page.goto('/')
  await pinPanelWidth(page, width)
  const panel = await openThreadsSession(page, DENSE_SESSION, TASK)
  await expect(panel.locator('.thread-drawer-toggle')).toBeVisible({ timeout: 30_000 })
  return panel
}

/** Go to a question through the drawer's search (Enter opens the first match). */
async function goTo(panel: Locator, query: string, title: string | RegExp): Promise<Locator> {
  await panel.locator('.thread-drawer-toggle').click()
  const drawer = panel.locator('.thread-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'open')
  await drawer.locator('.thread-drawer-chip', { hasText: /^All\b/ }).click()
  const search = drawer.locator('.thread-drawer-search-input')
  await search.fill(query)
  await search.press('Enter')
  await expect(drawer).toHaveCount(0)
  const header = panel.locator('.thread-stack-header')
  await expect(header.locator('.thread-stack-title')).toHaveText(title)
  return header
}

const rect = (loc: Locator) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: r.right, bottom: r.bottom }
})

/** Position in the Homepage column area's CONTENT coordinates: a 1400px panel is
 *  wider than that area, and Playwright scrolls it sideways to reach a control it
 *  types into (the drawer search), which moves everything on screen without any
 *  layout change. C70 is about layout, so the area's scroll is added back. */
const layoutRect = (loc: Locator) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  const area = el.closest('.main-page-sessions-area')
  return { x: Math.round(r.x + (area?.scrollLeft ?? 0)), y: Math.round(r.y + (area?.scrollTop ?? 0)), w: Math.round(r.width) }
})

/** The rect once it holds still for 400ms: the Homepage's smooth column scroll and
 *  the session header's own pills settle after the panel opens, which is not the
 *  stack's doing (C70 compares depths, not load stages). */
async function stableRect(loc: Locator) {
  let prev = await layoutRect(loc)
  for (let i = 0; i < 25; i++) {
    await loc.page().waitForTimeout(400)
    const next = await layoutRect(loc)
    if (next.x === prev.x && next.y === prev.y && next.w === prev.w) return next
    prev = next
  }
  return prev
}

async function fitsViewport(page: Page, menu: Locator): Promise<void> {
  const r = await rect(menu)
  const vp = page.viewportSize()!
  expect(r.x).toBeGreaterThanOrEqual(0)
  expect(r.y).toBeGreaterThanOrEqual(0)
  expect(r.right).toBeLessThanOrEqual(vp.width)
  expect(r.bottom).toBeLessThanOrEqual(vp.height)
}

const headOf = (q: string) => buildDenseSession(Date.now()).ids.head[q]

test.describe('stack chrome', () => {
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  test('depth 1 shows only back to Main; deeper pages put the path in the same row (C21)', async ({ page }) => {
    const panel = await openDense(page)
    let header = await goTo(panel, 'point 1 change', 'Buffer flush order')
    const back = header.locator('.thread-stack-back')
    await expect(back).toHaveText('Main')
    await expect(back).toHaveAttribute('title', 'Back to Main conversation (Esc)')
    await expect(header.locator('nav[aria-label="Question path"]')).toHaveCount(0)
    expect((await rect(header.locator('.thread-stack-row'))).h).toBe(36)
    header = await goTo(panel, 'point 21 change', /^Point 21:/)
    const nav = header.locator('nav[aria-label="Question path"]')
    await expect(nav).toBeVisible()
    await expect(nav.locator('.thread-stack-crumb')).toHaveText(['Main', 'Buffer flush order', /^Point 11:/])
    expect((await rect(nav)).y).toBeGreaterThanOrEqual((await rect(header.locator('.thread-stack-row'))).y)
    expect((await rect(header.locator('.thread-stack-row'))).h).toBe(36)
    await nav.locator('.thread-stack-crumb', { hasText: 'Buffer flush order' }).click()
    await expect(header.locator('.thread-stack-title')).toHaveText('Buffer flush order')
    await header.locator('.thread-stack-back').click()
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
  })

  test('narrow columns fold the path; long press and right click open every ancestor (C22)', async ({ page }) => {
    let panel = await openDense(page, 480)
    const header = await goTo(panel, 'point 26 change', /^Point 26:/)
    await expect(header.locator('nav[aria-label="Question path"]')).toHaveCount(0)
    const back = header.locator('.thread-stack-back')
    await expect(back).toHaveAttribute('aria-label', /^Back to Point 21:/)
    await expect(back).toHaveAttribute('title', /^Back to Point 21:.*\(Esc\)$/)
    // N7: a short parent label stays, like an iOS back label (truncated, never gone).
    await expect(back.locator('.thread-stack-back-text')).toHaveText(/^Point 21:/)
    expect((await rect(back)).w).toBeLessThanOrEqual(110)
    await back.click({ button: 'right' })
    const menu = page.locator('.thread-path-menu')
    await expect(menu.locator('[role="menuitem"]')).toHaveText([/^Point 21:/, /^Point 11:/, 'Buffer flush order', 'Main'])
    await fitsViewport(page, menu)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    const b = await rect(back)
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2)
    await page.mouse.down()
    await page.waitForTimeout(650)
    await page.mouse.up()
    await expect(menu).toBeVisible()
    await expect(header.locator('.thread-stack-title')).toHaveText(/^Point 26:/)
    await menu.locator('[role="menuitem"]', { hasText: 'Buffer flush order' }).click()
    await expect(header.locator('.thread-stack-title')).toHaveText('Buffer flush order')
    // 560 to 719px with a long path: the middle folds into `…`.
    panel = await openDense(page, 640)
    const mid = await goTo(panel, 'point 26 change', /^Point 26:/)
    const fold = mid.locator('.thread-stack-crumb--fold')
    await expect(fold).toHaveText('…')
    await fold.click()
    const folded = page.locator('.thread-path-menu')
    await expect(folded.locator('[role="menuitem"]')).toHaveText(['Buffer flush order', /^Point 11:/])
    await fitsViewport(page, folded)
  })

  test('rename is inline: double-click or `Rename…`, Enter saves, Esc cancels, empty restores (C24)', async ({ page, request }) => {
    page.on('dialog', (d) => { throw new Error(`unexpected dialog: ${d.type()}`) })
    const panel = await openDense(page)
    const header = await goTo(panel, 'point 1 change', 'Buffer flush order')
    await header.locator('.thread-stack-title').dblclick()
    const input = header.locator('.thread-inline-rename')
    await expect(input).toBeFocused()
    await page.keyboard.type('Order of flushes')
    await page.keyboard.press('Enter')
    await expect(header.locator('.thread-stack-title')).toHaveText('Order of flushes')
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .find((m) => m.headId === headOf('Q1'))?.titleSource).toBe('user')
    await header.locator('.thread-stack-more').click()
    await page.locator('.thread-menu [role="menuitem"]', { hasText: 'Rename…' }).click()
    await expect(input).toBeFocused()
    await page.keyboard.type('Thrown away')
    await page.keyboard.press('Escape')
    await expect(header.locator('.thread-stack-title')).toHaveText('Order of flushes')
    await expect(panel.locator('.thread-stack-header')).toHaveCount(1)
    await header.locator('.thread-stack-title').dblclick()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await expect(header.locator('.thread-stack-title')).not.toHaveText('Order of flushes')
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .find((m) => m.headId === headOf('Q1'))?.titleSource ?? null).not.toBe('user')
  })

  test('`Naming…` stays whole next to a long fallback title at 480px (C74)', async ({ page }) => {
    const head = headOf('Q22')
    await page.route(`**/api/sessions/${DENSE_SESSION}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const json = await res.json() as { session: { threadMeta?: Array<Record<string, unknown>> } }
      // A name asked for just now (the 90s Naming clock runs from the entry's
      // last write when the answer time is unknown, N2).
      for (const m of json.session.threadMeta ?? []) if (m.headId === head) Object.assign(m, { titleState: 'pending', title: null, updatedAt: new Date().toISOString() })
      await route.fulfill({ response: res, json })
    })
    const panel = await openDense(page, 480)
    const header = await goTo(panel, 'point 22 change', /^Point 22:/)
    const naming = header.locator('.thread-naming')
    await expect(naming).toHaveText('Naming…')
    const [n, row] = [await rect(naming), await rect(header.locator('.thread-stack-row'))]
    expect(n.x).toBeGreaterThanOrEqual(row.x)
    expect(n.right).toBeLessThanOrEqual(row.right)
    expect(await naming.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5)).toBe(true)
    const title = header.locator('.thread-stack-title')
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  })

  test('Done with open follow-ups asks first; `Mark all done` is one PATCH (C52)', async ({ page, request }) => {
    const panel = await openDense(page)
    const header = await goTo(panel, 'point 1 change', 'Buffer flush order')
    await header.locator('.thread-stack-done').click()
    const confirm = page.locator('.thread-confirm')
    await expect(confirm.locator('.thread-confirm-title')).toHaveText(/^Also mark \d+ follow-ups done\?$/)
    // Soft: default focus is ThreadConfirm's (P1) job; the steps after it still run.
    await expect.soft(confirm.getByRole('button', { name: 'Only this one' })).toBeFocused()
    await expect(confirm.getByRole('button', { name: 'Mark all done' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(header.locator('.thread-stack-title')).toHaveText('Buffer flush order')
    const patches: Array<Array<{ status?: string }>> = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().includes(DENSE_SESSION)) patches.push((r.postDataJSON() as { thread_meta?: [] }).thread_meta ?? [])
    })
    await header.locator('.thread-stack-done').click()
    await confirm.getByRole('button', { name: 'Mark all done' }).click()
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
    await expect(page.locator('.thread-toast')).toContainText('Done: Buffer flush order')
    await expect.poll(() => patches.filter((p) => p.length > 1).length).toBe(1)
    expect(patches.find((p) => p.length > 1)!.every((e) => e.status === 'resolved')).toBe(true)
    const meta = (await readRecord(request, DENSE_SESSION)).threadMeta!
    expect(meta.find((m) => m.headId === headOf('Q1'))?.status).toBe('resolved')
    expect(meta.find((m) => m.headId === headOf('Q26'))?.status).toBe('resolved')
  })

  test('`Done, back to start` resolves the chain in one PATCH, lands on root, Undo restores all (C52)', async ({ page, request }) => {
    const panel = await openDense(page)
    const header = await goTo(panel, 'point 26 change', /^Point 26:/)
    await header.locator('.thread-stack-done-caret').click()
    const menu = page.locator('.thread-path-menu')
    await fitsViewport(page, menu)
    await menu.locator('[role="menuitem"]', { hasText: 'Done, back to start' }).click()
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
    const toast = page.locator('.thread-toast')
    await expect(toast).toContainText(/^Done: Point 26:.* and 3 above/)
    const chain = ['Q26', 'Q21', 'Q11', 'Q1'].map(headOf)
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .filter((m) => chain.includes(m.headId) && m.status === 'resolved').length).toBe(4)
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .filter((m) => chain.includes(m.headId) && m.status === 'open').length).toBe(4)
  })

  test('More menu: rows, the Remove confirm verbatim, only the verb Remove, Show in tree (C13, C39, C78)', async ({ page, request }) => {
    const panel = await openDense(page)
    let header = await goTo(panel, 'point 1 change', 'Buffer flush order')
    const more = header.locator('.thread-stack-more')
    await expect(more).toHaveAttribute('aria-haspopup', 'menu')
    await expect(more).toHaveAttribute('title', 'More')
    await more.click()
    const menu = page.locator('.thread-menu[role="menu"]')
    await expect(menu.locator('[role="menuitem"]')).toHaveText(['Rename…', 'Mark done', 'Show in tree', 'Show all in order', 'Remove question…'])
    await fitsViewport(page, menu)
    await expect(menu.locator('select')).toHaveCount(0)
    await expect(menu.locator('[data-item="remove"] svg[data-thread-icon="trash"]')).toHaveCount(1)
    await menu.locator('[role="menuitem"]', { hasText: 'Remove question…' }).click()
    const confirm = page.locator('.thread-confirm')
    await expect(confirm.locator('.thread-confirm-title')).toHaveText(/^Remove this question and \d+ follow-ups\?$/)
    await expect(confirm.locator('.thread-confirm-body')).toHaveText('Walnut hides them from this view. The session transcript is owned by the CLI and keeps every message; you can still read them in Show all in order.')
    // Soft: default focus is ThreadConfirm's (P1) job; the steps after it still run.
    await expect.soft(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await expect(confirm.getByRole('button', { name: 'Remove' })).toHaveClass(/thread-confirm-btn--danger/)
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(header.locator('.thread-stack-title')).toHaveText('Buffer flush order')
    // Show in tree keeps the drawer open on the current row.
    await more.click()
    await menu.locator('[role="menuitem"]', { hasText: 'Show in tree' }).click()
    const drawer = panel.locator('.thread-drawer')
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await expect(drawer.locator('.thread-tree-row[aria-selected="true"] .thread-tree-title')).toHaveText('Buffer flush order')
    await drawer.getByRole('button', { name: 'Close (Esc)' }).click()
    // A leaf question: `Remove question` without an ellipsis and without a confirm.
    header = await goTo(panel, 'point 22 change', /^Point 22:/)
    await header.locator('.thread-stack-more').click()
    await expect(menu.locator('[role="menuitem"]').last()).toHaveText('Remove question')
    await menu.locator('[role="menuitem"]', { hasText: 'Remove question' }).click()
    await expect(page.locator('.thread-confirm')).toHaveCount(0)
    await expect(page.locator('.thread-toast')).toContainText(/^Removed “Point 22:.*”\. The messages stay in the transcript\./)
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .find((m) => m.headId === headOf('Q22'))?.hidden).toBe(true)
    // Wording: no `Delete`, and no × anywhere in the stack chrome.
    const chrome = await panel.locator('.thread-stack-header').allInnerTexts()
    expect(chrome.join(' ')).not.toMatch(/Delete|×/)
  })

  test('the takeaway edits inline and saves as the user takeaway (C46)', async ({ page, request }) => {
    const panel = await openDense(page)
    const header = await goTo(panel, 'point 2 change', 'Checksum per page')
    await expect(header.locator('.thread-stack-reopen')).toHaveAttribute('title', 'Reopen this question')
    const strip = panel.locator('.thread-strip--resolved')
    await expect(strip.locator('.thread-strip-label')).toHaveText('Takeaway')
    const text = strip.locator('.thread-strip-text')
    await expect(text).toHaveAttribute('title', 'Edit takeaway')
    await text.click()
    const input = strip.locator('.thread-inline-rename')
    await expect(input).toBeFocused()
    expect(await input.getAttribute('maxlength')).toBe('280')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Each page checks its own sum before a read trusts it.')
    await page.keyboard.press('Enter')
    await expect(strip.locator('.thread-strip-text')).toHaveText('Each page checks its own sum before a read trusts it.')
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .find((m) => m.headId === headOf('Q2'))?.takeawaySource).toBe('user')
    await panel.locator('.thread-drawer-toggle').click()
    const drawer = panel.locator('.thread-drawer')
    await drawer.locator('.thread-drawer-search-input').fill('checksum per page')
    await expect(drawer.locator('.thread-tree-row[aria-selected="true"] .thread-tree-secondary'))
      .toHaveText('Each page checks its own sum before a read trusts it.')
  })

  for (const width of [480, 596, 720]) {
    test(`the page title wins over the path at ${width}px, depth 4 (N6, N12, N42)`, async ({ page }) => {
      const panel = await openDense(page, width)
      let header = await goTo(panel, 'point 1 change', 'Buffer flush order')
      for (const [q, title] of [['point 11 change', /^Point 11:/], ['point 21 change', /^Point 21:/], ['point 26 change', /^Point 26:/]] as const) {
        header = await goTo(panel, q, title)
      }
      const row = await rect(header.locator('.thread-stack-row'))
      const block = await rect(header.locator('.thread-stack-title-block'))
      // The floor: a third of the row or 200px, whichever is smaller.
      expect(block.w).toBeGreaterThanOrEqual(Math.min(row.w * 0.34, 200) - 1)
      const crumbs = header.locator('.thread-stack-crumbs')
      if (await crumbs.count()) expect((await rect(crumbs)).w).toBeLessThanOrEqual(block.w)
      // A suggested page keeps its verdict label at every width (N12).
      header = await goTo(panel, 'late flush', 'Late flush risk')
      // N42: the same words as the drawer and Asked-from at every width, whole;
      // the back button is whole too (the chevron alone when narrow).
      const label = header.locator('.thread-stack-suggested-label')
      await expect(label).toHaveText('Looks answered')
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'verdict label not cut').toBe(true)
      const backText = header.locator('.thread-stack-back-text')
      if (await backText.count()) {
        expect(await backText.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'back label not cut').toBe(true)
      }
      await expect(header.locator('.thread-stack-back')).toHaveAttribute('aria-label', /^Back to /)
      await expect(header.locator('.thread-stack-not-yet')).toBeVisible()
      const r = await rect(header.locator('.thread-stack-row'))
      const more = await rect(header.locator('.thread-stack-more'))
      expect(more.right).toBeLessThanOrEqual(r.right + 1)
    })
  }

  for (const width of [480, 1400]) {
    test(`stack chrome stays within 56px and never moves the session header at ${width}px (C70)`, async ({ page }) => {
      const panel = await openDense(page, width)
      const toggle = panel.locator('.thread-drawer-toggle')
      const at = { root: await stableRect(toggle) }
      const steps: Array<[string, RegExp | string]> = [
        ['point 1 change', 'Buffer flush order'], ['point 11 change', /^Point 11:/],
        ['point 21 change', /^Point 21:/], ['point 26 change', /^Point 26:/],
      ]
      for (const [q, title] of steps) {
        const header = await goTo(panel, q, title)
        const t = await stableRect(toggle)
        // At depth the root More menu gives way to a same-size blank slot
        // (SessionPanel), so the toggle and everything after it hold still.
        expect([t.x, t.y]).toEqual([at.root.x, at.root.y])
        expect((await rect(header)).h).toBeLessThanOrEqual(56)
        expect((await rect(header.locator('.thread-stack-row'))).h).toBe(36)
        // N7: the question subtitle shows at every width, inside the same 56px.
        const sub = header.locator('.thread-stack-subtitle')
        await expect(sub).toBeVisible()
        // N16: it starts under the title block, not under the back label or path.
        const titleX = (await rect(header.locator('.thread-stack-title-block'))).x
        const subText = await sub.evaluate((el) => {
          const pad = parseFloat(getComputedStyle(el).paddingLeft)
          return el.getBoundingClientRect().left + pad
        })
        expect(Math.abs(subText - titleX)).toBeLessThanOrEqual(1)
      }
    })
  }
})
