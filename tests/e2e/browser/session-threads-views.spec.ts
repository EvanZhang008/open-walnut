/**
 * Question stack, views and page surfaces (spec slice 1, sections 5.4, 5.6, 5.9,
 * 5.10): Conversation Mode, the marks in an answer, the Asked-from rows, Done,
 * Undo and Remove as they move the stack, and the quote head.
 *
 * Covers C35 (Conversation Mode: every row, turn rules lead back, the pill
 * back to Tree Mode restores the page and scroll, the choice survives a reload), C80
 * (an old saved view opens as Stack), C26 and C36 (marks: hover tip, click,
 * painted, resolved fainter, pin plus mark), C25 (Asked-from rows, keyboard),
 * C11, C12, C77 (Done pops, persists, rolls back on a failed write, Undo after
 * leaving keeps the page), C14 (Remove hides, keeps anchors), C76 (quote once,
 * short quote with context), C15 (a read that left before Done and lands after
 * it cannot undo it).
 *
 * Read-only tests use the dense fixture; the ones that write (Done, Remove) use
 * `pw-threads-session` with anchors this file PATCHes and resets.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, DENSE_SESSION, openThreadsSession, passageRects, readRecord, resetThreadsFixture, modePill, openQuestionList, switchView,
} from './threads-helpers'
import { buildDenseSession, densePassage } from './threads-fixture'

const DENSE_TASK = 'pw-task-threads-dense'
const DENSE_READY = 'Walk me through part 6 of the storage notes.'
const IDS = buildDenseSession(0).ids
const WRITE_SESSION = 'pw-threads-session'
const WRITE_TASK = 'pw-task-threads'
/** The last root reply once A, B and C are seeded (21 on belong to questions). */
const WRITE_READY = 'outline filler reply 20'
const askUuid = (n: number) => `0199bb02-0000-4aaa-8bbb-${String(n - 1).padStart(12, '0')}`
const replyUuid = (n: number) => `0199bb03-0000-4aaa-8bbb-${String(n - 1).padStart(12, '0')}`
const at = (s: number) => new Date(Date.now() - s * 1000).toISOString()
/** A (ask 21 + sticky ask 22) and C (ask 24) hang off root replies; B (ask 23)
 *  asks about a three-word passage of A's answer, stored with its context. */
const ANCHORS = [
  { msgId: askUuid(21), parent: replyUuid(20), quote: { exact: 'filler reply 20' }, source: 'selection', at: at(40) },
  { msgId: askUuid(22), parent: replyUuid(20), quote: { exact: 'filler reply 20' }, source: 'sticky', at: at(30) },
  { msgId: askUuid(23), parent: replyUuid(21), quote: { exact: 'filler reply 21', prefix: 'outline ' }, source: 'selection', at: at(20) },
  { msgId: askUuid(24), parent: replyUuid(19), quote: { exact: 'filler reply 19' }, source: 'selection', at: at(10) },
]
const META = [
  { headId: askUuid(21), status: 'open', title: 'Question about reply twenty', titleSource: 'user', titleState: 'done' },
  { headId: askUuid(23), status: 'open', title: 'Deeper about reply twenty one', titleSource: 'user', titleState: 'done' },
  { headId: askUuid(24), status: 'open', title: 'Side note on reply nineteen', titleSource: 'user', titleState: 'done' },
]
const RESET_META = ['takeaway', 'takeawaySource', 'takeawayState', 'hidden', 'suggestDismissed']

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

async function seedWriteSession(request: APIRequestContext): Promise<void> {
  const meta = META.map((m) => ({ ...m, ...Object.fromEntries(RESET_META.map((f) => [f, null])) }))
  const res = await request.patch(`/api/sessions/${WRITE_SESSION}`, { data: { thread_anchors: ANCHORS, thread_meta: meta, pinned_messages: [] } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function metaOf(request: APIRequestContext, headId: string): Promise<Record<string, unknown> | undefined> {
  return ((await readRecord(request, WRITE_SESSION)).threadMeta ?? []).find((m) => m.headId === headId)
}

/** Wheel the timeline until `target` sits near 40% of the box. */
async function centre(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target, { at: 0.4, tolerance: 60, capRow: true })
}

async function openAsked(page: Page, panel: Locator, text: string | RegExp, depth: number): Promise<void> {
  const row = panel.locator('.thread-asked-row', { hasText: text }).first()
  await expect(row).toBeVisible()
  await centre(page, panel, row)
  await row.click()
  await expectDepth(panel, depth)
}

async function pageMenu(page: Page, panel: Locator, item: string | RegExp): Promise<void> {
  await panel.locator('.thread-stack-header .thread-stack-more').click()
  await page.locator('.thread-menu [role="menuitem"]', { hasText: item }).click()
}

async function flashText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('walnut-pin-flash')
    return Array.from(hl ?? []).map((r) => r.toString()).join(' | ')
  })
}

/** Which highlight names paint a range whose text contains `needle`. */
async function highlightsOver(page: Page, needle: string): Promise<string[]> {
  return page.evaluate((n) => {
    const out: string[] = []
    const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
    for (const [name, set] of hl ?? []) for (const r of set) if (r.toString().includes(n)) out.push(name)
    return out
  }, needle)
}

test.describe('Question stack views', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, DENSE_SESSION)
    await seedWriteSession(request)
  })

  test('Conversation Mode: every row, turn rules lead back, Tree Mode restores the page', async ({ page }) => {
    await boot(page)
    let panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    const history = panel.locator('.session-history')
    await openAsked(page, panel, 'Late flush risk', 1)
    await openAsked(page, panel, 'Reader skip cost', 2)
    const box = (await history.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 180)
    await page.waitForTimeout(700)
    const before = await history.evaluate((el) => el.scrollTop)
    await pageMenu(page, panel, 'Conversation Mode')
    // C35: the plain transcript, hidden questions included; the pill now offers Tree Mode.
    await expect(history).toHaveAttribute('data-view-mode', 'linear')
    await expect(modePill(panel)).toHaveText('Tree Mode')
    await expect(panel.locator('.thread-sliver, .thread-stack-header, .thread-quote-head, .thread-asked-from')).toHaveCount(0)
    await expect(panel.locator(`[data-message-id="${IDS.head.Q8}"]`)).toBeAttached()
    const bar = panel.locator(`.session-msg--threaded[data-message-id="${IDS.head.Q9}"]`)
    await expect(bar).toBeAttached()
    expect(await bar.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('2px')
    // One label per turn group, above the question's own row: number, title, status.
    const label = bar.locator('.thread-turn-label')
    await expect(label).toHaveCount(1)
    await expect(label.locator('.thread-map-num')).toHaveText(/^\d+$/)
    await expect(label.locator('.thread-status-word')).toBeVisible()
    await shot(page, 'c35-linear')
    // The bar is the way back to where that question was asked. Q9 sits ~26000px
    // below this spot in the full transcript, past what the wheel loop covers:
    // bring it near first, then settle it with real wheels.
    await bar.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(300)
    await centre(page, panel, bar)
    const r = (await bar.boundingBox())!
    await page.mouse.click(r.x + 1, r.y + Math.min(r.height / 2, 30))
    await expect.poll(() => flashText(page), { timeout: 10_000 }).toContain('Point 9:')
    // The jump may glide there: wait until the passage sits inside the box.
    const hb = (await history.boundingBox())!
    await expect.poll(async () => {
      const top = (await passageRects(panel, densePassage('Q9')))[0].top
      return top > hb.y && top < hb.y + hb.height
    }, { timeout: 10_000 }).toBe(true)
    // The choice is remembered per session across a reload.
    expect(await page.evaluate((k) => localStorage.getItem(k), `walnut:session-view.v2:${DENSE_SESSION}`)).toBe('linear')
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await expect(panel.locator('.session-history')).toHaveAttribute('data-view-mode', 'linear')
    // Back to Tree Mode through the pill: the page and the scroll he left.
    await switchView(panel, 'stack')
    await expectDepth(panel, 2)
    await expect(panel.locator('.thread-quote-head')).toContainText(densePassage('Q17').slice(0, 24))
    await expect.poll(() => panel.locator('.session-history').evaluate((el) => el.scrollTop)).toBeGreaterThan(before - 9)
    const after = await panel.locator('.session-history').evaluate((el) => el.scrollTop)
    expect(Math.abs(after - before)).toBeLessThanOrEqual(8)
  })

  test('a view saved under the old key opens as Stack; the new choice is what persists', async ({ page }) => {
    await page.addInitScript((sid) => {
      if (sessionStorage.getItem('pw-old-key-seeded')) return
      sessionStorage.setItem('pw-old-key-seeded', '1')
      localStorage.setItem(`walnut:session-view:${sid}`, 'linear')
      localStorage.removeItem(`walnut:session-view.v2:${sid}`)
    }, DENSE_SESSION)
    await boot(page)
    let panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    // C80: the old 'linear' is never read.
    await expect(panel.locator('.session-history')).toHaveAttribute('data-view-mode', 'stack')
    await expect(panel.locator('.thread-asked-from').first()).toBeVisible()
    expect(await page.evaluate((k) => localStorage.getItem(k), `walnut:session-view:${DENSE_SESSION}`)).toBe('linear')
    await switchView(panel, 'linear')
    await expect(panel.locator('.session-history')).toHaveAttribute('data-view-mode', 'linear')
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await expect(panel.locator('.session-history')).toHaveAttribute('data-view-mode', 'linear')
  })

  test('marks: hover names the question, a click opens it, resolved reads fainter, a pin and a mark both paint', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    const history = panel.locator('.session-history')
    const q6 = densePassage('Q6')
    // Centre it, and again if a late layout pass moved it back out of view.
    const hb = (await history.boundingBox())!
    for (let i = 0; i < 3; i++) {
      await centre(page, panel, panel.locator('.session-msg-content', { hasText: q6 }).first())
      await page.waitForTimeout(400)
      const r = (await passageRects(panel, q6))[0]
      if (r.top > hb.y && r.top + r.height < hb.y + hb.height) break
    }
    // C36 (c, d): painted, and a resolved question's mark has the fainter name.
    expect((await highlightsOver(page, q6)).some((n) => /^thread-mark-\d+$/.test(n))).toBe(true)
    expect((await highlightsOver(page, densePassage('Q10'))).some((n) => /^thread-mark-done-\d+$/.test(n))).toBe(true)
    const alphas = await page.evaluate(() => {
      const out: Record<string, string> = {}
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try { rules = sheet.cssRules } catch { continue }
        for (const r of Array.from(rules)) {
          // The base (light) rule only: the dark overrides live under
          // [data-theme="dark"] and inside a prefers-color-scheme media block.
          if (!(r instanceof CSSStyleRule) || !r.selectorText.startsWith('::highlight(')) continue
          const m = r.selectorText.match(/^::highlight\((thread-mark(?:-done)?-214)\)$/)
          if (m) out[m[1]] = r.cssText
        }
      }
      return out
    })
    // N18: a fill plus a hue underline; N48: the resolved mark is quieter AND a
    // different kind of mark (a grey fill, a thinner dotted underline).
    expect(alphas['thread-mark-214']).toMatch(/0\.22/)
    expect(alphas['thread-mark-214']).toMatch(/underline/)
    expect(alphas['thread-mark-214']).toMatch(/\b2px\b/)
    expect(alphas['thread-mark-done-214']).toMatch(/0\.14/)
    expect(alphas['thread-mark-done-214']).toMatch(/\b1\.5px\b/)
    expect(alphas['thread-mark-done-214']).toMatch(/dotted/)
    const rect = (await passageRects(panel, q6))[0]
    const clip = { x: rect.left, y: rect.top, width: Math.min(120, rect.right - rect.left), height: rect.height }
    const painted = await page.screenshot({ clip })
    await page.evaluate(() => {
      const hl = (CSS as unknown as { highlights: Map<string, unknown> }).highlights
      const w = window as unknown as { __saved: Array<[string, unknown]> }
      w.__saved = Array.from(hl.entries()).filter(([k]) => k.startsWith('thread-mark'))
      for (const [k] of w.__saved) hl.delete(k)
    })
    const bare = await page.screenshot({ clip })
    await page.evaluate(() => {
      const hl = (CSS as unknown as { highlights: Map<string, unknown> }).highlights
      for (const [k, v] of (window as unknown as { __saved: Array<[string, unknown]> }).__saved) hl.set(k, v)
    })
    expect(painted.equals(bare), 'the mark changes the pixels under the passage').toBe(false)
    // (a) hover: pointer cursor and the tooltip.
    await page.mouse.move(rect.left + 10, rect.top + rect.height / 2, { steps: 3 })
    await expect(history).toHaveAttribute('data-thread-mark-hover', '')
    await expect(history).toHaveCSS('cursor', 'pointer')
    await expect(page.locator('.thread-hover-tip')).toHaveText('Open “Late flush risk”')
    await shot(page, 'c36-mark-hover')
    // (b) a click with nothing selected opens it.
    await page.mouse.click(rect.left + 10, rect.top + rect.height / 2)
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-quote-head')).toContainText(q6.slice(0, 20))
    // C26: after a full re-render of the rows the marks still work.
    await pageMenu(page, panel, 'Conversation Mode')
    await switchView(panel, 'stack')
    await expectDepth(panel, 1)
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await page.waitForTimeout(500)
    const again = (await passageRects(panel, q6))[0]
    await page.mouse.move(again.left + 10, again.top + again.height / 2, { steps: 3 })
    await page.mouse.click(again.left + 10, again.top + again.height / 2)
    await expectDepth(panel, 1)
    // (e) on Q1's page one passage is both pinned and asked: both paint, a click opens the question.
    await openQuestionList(page, panel)
    await panel.locator('.thread-drawer .thread-tree-row[data-kind="thread"]', { hasText: 'Buffer flush order' }).first().click()
    await expectDepth(panel, 1)
    const q11 = densePassage('Q11')
    await centre(page, panel, panel.locator('.session-msg-content', { hasText: q11 }).first())
    await expect.poll(async () => (await highlightsOver(page, q11)).join(',')).toMatch(/thread-mark-\d+/)
    const names = await highlightsOver(page, q11)
    expect(names.some((n) => !n.startsWith('thread-mark')), `pin paint too: ${names.join(',')}`).toBe(true)
    const r11 = (await passageRects(panel, q11))[0]
    await page.mouse.move(r11.left + 10, r11.top + r11.height / 2, { steps: 3 })
    await page.mouse.click(r11.left + 10, r11.top + r11.height / 2)
    await expectDepth(panel, 2)
    await shot(page, 'c36-pin-and-mark-opened')
  })

  test('Asked-from rows list every visible child in transcript order; Enter and Space open them', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    // C25: every root answer renders (the root page windows over root rows, N9):
    // R0, R1, R2, R3 (Q6 then Q7) and R5 (Q9 then Q10) each list their questions;
    // R4's only question (Q8) is hidden, so R4 has no list.
    const groups = panel.locator('.thread-asked-from')
    await expect(groups).toHaveCount(5)
    await expect(groups.nth(3).locator('.thread-asked-heading')).toHaveText('Asked from this answer')
    const first = groups.nth(3).locator('.thread-asked-row')
    await expect(first).toHaveCount(2)
    await expect(first.nth(0)).toContainText('Late flush risk')
    await expect(first.nth(0).locator('.thread-asked-state--suggested')).toContainText('Looks answered')
    const second = groups.nth(4).locator('.thread-asked-row')
    await expect(second.nth(0)).toContainText('Version skip rule')
    await expect(second.nth(1)).toContainText('Batching writes')
    await expect(second.nth(1).locator('.thread-asked-done')).toHaveText('Done')
    await expect(second.nth(1).locator('.thread-asked-takeaway')).toHaveText('Point 10 keeps reads ordered before writes land.')
    await expect(second.nth(1)).toHaveClass(/is-resolved/)
    await shot(page, 'c25-asked-from')
    // Keyboard: Enter opens, Esc returns, Space opens.
    await centre(page, panel, second.nth(0))
    await second.nth(0).focus()
    await expect(second.nth(0)).toBeFocused()
    await page.keyboard.press('Enter')
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-stack-title')).toHaveText('Version skip rule')
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    const row = panel.locator('.thread-asked-row', { hasText: 'Batching writes' })
    await centre(page, panel, row)
    await row.focus()
    await page.keyboard.press(' ')
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-stack-title')).toHaveText('Batching writes')
  })

  test('Done pops to the passage and persists; Undo after leaving keeps the page, Undo in place returns', async ({ page, request }) => {
    await boot(page)
    // Wide enough for the labelled map: the count lives there now (the header
    // holds the mode pill alone).
    await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${WRITE_SESSION}"]) {
      flex: 0 0 900px !important; width: 900px !important; min-width: 900px !important; max-width: 900px !important; }` })
    let panel = await openThreadsSession(page, WRITE_SESSION, WRITE_TASK, WRITE_READY)
    const count = panel.locator('.thread-map .thread-map-count')
    await expect(count).toContainText('3 open')
    await openAsked(page, panel, 'Question about reply twenty', 1)
    await openAsked(page, panel, 'Deeper about reply twenty one', 2)
    // C11: Done on the leaf: resolved at once, one fewer open, back to the passage.
    await panel.locator('.thread-stack-done').first().click()
    await expectDepth(panel, 1)
    await expect(count).toContainText('2 open')
    const b = panel.locator('.thread-asked-row', { hasText: 'Deeper about reply twenty one' })
    await expect(b).toHaveClass(/is-resolved/)
    await expect(b.locator('.thread-asked-done')).toHaveText('Done')
    await expect(b.locator('.thread-asked-takeaway')).toHaveText('outline filler reply 23')
    await expect.poll(async () => (await metaOf(request, askUuid(23)))?.status).toBe('resolved')
    const saved = await metaOf(request, askUuid(23))
    expect(saved?.takeaway).toBe('outline filler reply 23')
    expect(saved?.takeawaySource).toBe('fallback')
    await shot(page, 'c11-done-popped')
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openThreadsSession(page, WRITE_SESSION, WRITE_TASK)
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-asked-row', { hasText: 'Deeper about reply twenty one' })).toHaveClass(/is-resolved/)

    // C77: Done on A, leave for C, then Undo: A reopens, the page stays C.
    await panel.locator('.thread-stack-done').first().click()
    await expectDepth(panel, 0)
    const toast = panel.locator('.thread-toast')
    await expect(toast).toBeVisible()
    await openAsked(page, panel, 'Side note on reply nineteen', 1)
    await toast.locator('.thread-toast-action', { hasText: 'Undo' }).click()
    await expect.poll(async () => (await metaOf(request, askUuid(21)))?.status).toBe('open')
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-stack-title')).toHaveText('Side note on reply nineteen')
    // Undo without leaving: the page comes back.
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await openAsked(page, panel, 'Question about reply twenty', 1)
    await panel.locator('.thread-stack-done').first().click()
    await expectDepth(panel, 0)
    await panel.locator('.thread-toast .thread-toast-action', { hasText: 'Undo' }).click()
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-stack-title')).toHaveText('Question about reply twenty')
    await expect.poll(async () => (await metaOf(request, askUuid(21)))?.status).toBe('open')
  })

  test('a Done the server refuses rolls back with a toast and pushes nothing twice', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, WRITE_SESSION, WRITE_TASK, WRITE_READY)
    await openAsked(page, panel, 'Side note on reply nineteen', 1)
    await page.route(`**/api/sessions/${WRITE_SESSION}`, (route) => (route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
      : route.continue()))
    await panel.locator('.thread-stack-done').first().click()
    await expectDepth(panel, 0)
    // C12: the failure says so and the row goes back to open.
    await expect(panel.locator('.thread-toast')).toContainText("Couldn't mark done. Try again.")
    const row = panel.locator('.thread-asked-row', { hasText: 'Side note on reply nineteen' })
    await expect(row).not.toHaveClass(/is-resolved/)
    await page.waitForTimeout(1200)
    await expectDepth(panel, 0)
    await page.unroute(`**/api/sessions/${WRITE_SESSION}`)
    expect((await metaOf(request, askUuid(24)))?.status).toBe('open')
  })

  test('Remove hides the question and keeps its anchors; Conversation Mode still shows its rows', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, WRITE_SESSION, WRITE_TASK, WRITE_READY)
    await openAsked(page, panel, 'Question about reply twenty', 1)
    await pageMenu(page, panel, /Remove question/)
    const confirm = page.locator('.thread-confirm')
    if (await confirm.count() > 0) await confirm.locator('.thread-confirm-btn--danger').click()
    await expectDepth(panel, 0)
    await expect(panel.locator('.thread-asked-row', { hasText: 'Question about reply twenty' })).toHaveCount(0)
    // C14: the anchors stay, the head entry is hidden.
    await expect.poll(async () => (await metaOf(request, askUuid(21)))?.hidden).toBe(true)
    expect((await readRecord(request, WRITE_SESSION)).threadAnchors ?? []).toHaveLength(ANCHORS.length)
    await switchView(panel, 'linear')
    await expect(panel.locator('.session-history')).toHaveAttribute('data-view-mode', 'linear')
    await expect(panel.locator(`.session-history [data-message-id="${askUuid(21)}"]`)).toBeAttached()
    await expect(panel.locator(`.session-history [data-message-id="${askUuid(23)}"]`)).toBeAttached()
  })

  test('a page shows its passage once, and a short passage with its context', async ({ page }) => {
    await boot(page)
    let panel = await openThreadsSession(page, WRITE_SESSION, WRITE_TASK, WRITE_READY)
    await openAsked(page, panel, 'Question about reply twenty', 1)
    await openAsked(page, panel, 'Deeper about reply twenty one', 2)
    // C76: three words, so the stored prefix rides along, faint.
    await expect(panel.locator('.thread-quote-context')).toHaveText('outline')
    await expect(panel.locator('.thread-quote-exact')).toHaveText('filler reply 21')
    // A dense page whose question starts with the quote: the head row hides it.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await openAsked(page, panel, 'Late flush risk', 1)
    const head = panel.locator(`[data-message-id="${IDS.head.Q6}"]`)
    await expect(head).toHaveAttribute('data-thread-head', '')
    await expect(head.locator('.markdown-body > blockquote').first()).toBeHidden()
    await expect(head).toContainText('What does point 6 change for the reader?')
    const visible = await panel.locator('.session-history').evaluate((el, needle) => {
      let n = 0
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        if (!(t.textContent ?? '').includes(needle)) continue
        if ((t.parentElement?.getClientRects().length ?? 0) > 0) n += 1
      }
      return n
    }, densePassage('Q6').slice(0, 30))
    expect(visible).toBe(1)
    await shot(page, 'c76-quote-once')
  })

  test('a session read that left before Done and lands after it cannot undo it', async ({ page, request }) => {
    // A WebSocket drop is a real source of reads: the reconnect refetches the record.
    const sockets: Array<{ close: () => Promise<void> }> = []
    await page.routeWebSocket('**/ws*', (ws) => { ws.connectToServer(); sockets.push(ws) })
    await boot(page)
    const panel = await openThreadsSession(page, WRITE_SESSION, WRITE_TASK, WRITE_READY)
    await openAsked(page, panel, 'Side note on reply nineteen', 1)
    // Hold every record read that starts now: its body is fetched at once (before
    // Done) and delivered only after Done's write came back.
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    let held = 0
    const recordUrl = new RegExp(`/api/sessions/${WRITE_SESSION}(\\?.*)?$`)
    await page.route(recordUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      held++
      const res = await route.fetch()
      const body = await res.text()
      await released
      await route.fulfill({ response: res, body })
    })
    expect(sockets.length).toBeGreaterThan(0)
    await sockets[sockets.length - 1].close()
    await expect.poll(() => held, { timeout: 30_000, message: 'the reconnect reads the record' }).toBeGreaterThan(0)
    // C15: Done, its write returns, THEN the stale read lands.
    const wrote = page.waitForResponse((r) => r.request().method() === 'PATCH' && recordUrl.test(r.url()))
    await panel.locator('.thread-stack-done').first().click()
    expect((await wrote).ok()).toBe(true)
    await expectDepth(panel, 0)
    const row = panel.locator('.thread-asked-row', { hasText: 'Side note on reply nineteen' })
    await expect(row).toHaveClass(/is-resolved/)
    release()
    await expect.poll(() => held).toBeGreaterThan(0)
    await page.waitForTimeout(1500)
    await expect(row).toHaveClass(/is-resolved/)
    await expect(row).toHaveAttribute('data-status', 'resolved')
    expect((await metaOf(request, askUuid(24)))?.status).toBe('resolved')
    await page.unroute(recordUrl)
  })
})
