/**
 * The draft's decision chips and its More button share ONE settings popover.
 *
 * What this file pins (checklist ids in each test name's comment): the empty draft
 * has no chips and the folder/project/More row is exact (C3 C4 C35); every chip
 * opens the same popover anchored on itself, a second trigger re-anchors it without
 * a remount (C6 C41); chip words equal the lit menu row's words (C36); Escape,
 * outside click and focus return (C26); the popover is a portalled dialog that stays
 * inside a 1280x800 and an 800x600 viewport, Due calendar open included (C25 C25b);
 * the lit-row "accept" grammar, `Don't pin`, and `Use Walnut's pick` (C56 C61 C65);
 * the legend (C34); keyboard entry, Mod+. included (C40); typing closes the menu
 * (C46); the fade-in and its reduced-motion opt-out (C48 C66); ARIA names (C62);
 * the exactly-7-days date words (C64).
 *
 * Engines: chromium by default; the C6 / C25 / C25b / C40 tests are part of the
 * WebKit gate (`PW_WEBKIT=1 npx playwright test <this file> --project=webkit`). No
 * `test.use` pin: one file runs under either project, so no scenario is duplicated.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  bootDecisions, chipLabel, dayWords, draftComposer, draftDecisionChip, draftDecisionChips,
  draftMoreButton, draftPills, draftTaskMenu, isoDay, openDraft, openDraftSettings, typeAndSettle,
  type ParseSource,
} from './draft-helpers'

const SHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-decisions/menu'
test.setTimeout(180_000)
// test-results/ is shared and wiped by peer runs: keep a failure shot under /tmp.
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    const slug = info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
    await page.screenshot({ path: `/tmp/draft-decisions/fail/${info.project.name}-${slug}.png` }).catch(() => {})
  }
})

const DESKTOP = { width: 1280, height: 800 }
const SMALL = { width: 800, height: 600 }
const D1: ParseSource = { pinTier: 'satellite', priority: 'immediate', due_date: isoDay(3) }
const AI = /draft-decision-chip-ai/

const boot = (page: Page, source: ParseSource, viewport = DESKTOP, showPriority = true) =>
  bootDecisions(page, source, { quickParse: true, showPriority }, viewport)

/** Boot, open a draft, type the D1 sentence and wait for its three chips. */
async function draftWithD1(page: Page, viewport = DESKTOP): Promise<Locator> {
  const mock = await boot(page, D1, viewport)
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'fix the flaky login test by friday, urgent')
  await expect(draftDecisionChips(panel)).toHaveCount(3)
  return panel
}

type Box = { x: number; y: number; width: number; height: number }
async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}
/** The popover "sits on" the anchor: overlaps it horizontally and its nearest
 *  vertical edge is within 8px of the anchor's top or bottom edge. */
function expectAnchoredOn(menu: Box, anchor: Box, what: string): void {
  const overlapX = Math.min(menu.x + menu.width, anchor.x + anchor.width) - Math.max(menu.x, anchor.x)
  expect(overlapX, `${what}: the menu overlaps the anchor horizontally`).toBeGreaterThan(0)
  const gapAbove = Math.abs(anchor.y - (menu.y + menu.height))
  const gapBelow = Math.abs(menu.y - (anchor.y + anchor.height))
  expect(Math.min(gapAbove, gapBelow), `${what}: the menu touches the anchor edge`).toBeLessThanOrEqual(8)
}
async function expectInViewport(page: Page, loc: Locator, what: string): Promise<void> {
  const b = await box(loc)
  const vp = page.viewportSize() ?? DESKTOP
  expect(b.x, `${what}: left edge`).toBeGreaterThanOrEqual(-0.5)
  expect(b.y, `${what}: top edge`).toBeGreaterThanOrEqual(-0.5)
  expect(b.x + b.width, `${what}: right edge`).toBeLessThanOrEqual(vp.width + 0.5)
  expect(b.y + b.height, `${what}: bottom edge`).toBeLessThanOrEqual(vp.height + 0.5)
}
const activeTag = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return el ? `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').join('.')}` : ''
})

// C3 C4 C35 C62: the empty draft and the row structure.
test('an empty draft shows folder, project and More only; a landed parse orders legend, chips, then the bar', async ({ page }) => {
  const mock = await boot(page, D1)
  const panel = await openDraft(page)
  await expect(draftDecisionChips(panel)).toHaveCount(0)
  await expect(panel.locator('.draft-decision-row')).toHaveCount(0)
  await expect(panel.locator('.draft-decisions-key')).toHaveCount(0)
  await expect(draftPills(panel)).toHaveCount(2)
  const more = draftMoreButton(panel)
  await expect(more).toHaveText('More')
  await expect(more).toHaveAttribute('aria-label', 'Task settings')
  await expect(more).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  expect(await panel.locator('.draft-composer-bar').evaluate((bar) => {
    const kids = Array.from(bar.children)
    return kids.map((k) => (k.classList.contains('draft-more-btn') ? 'more' : k.classList.contains('session-action-chip') ? 'pill' : 'other'))
  })).toEqual(['pill', 'pill', 'more'])

  await typeAndSettle(page, mock, 'fix the flaky login test by friday, urgent')
  await expect(draftDecisionChips(panel)).toHaveCount(3)
  // C4: still exactly two pills, folder first.
  await expect(draftPills(panel)).toHaveCount(2)
  await expect(draftPills(panel).first()).toHaveText(/Choose folder/)
  // C35: DOM order = reading order.
  const order = await panel.locator('.draft-launch-bar').evaluate((bar) => {
    const pick = (sel: string) => bar.querySelector(sel)
    const els = [pick('.draft-decisions-key'), pick('.draft-decision-row'), pick('.draft-composer-bar')]
    if (els.some((e) => !e)) return 'missing'
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const [key, row, pills] = els as Element[]
    const tops = els.map((e) => (e as HTMLElement).getBoundingClientRect().top)
    return before(key, row) && before(row, pills) && tops[0] < tops[1] && tops[1] < tops[2] ? 'ok' : `bad ${tops.join(',')}`
  })
  expect(order).toBe('ok')
  expect(await draftDecisionChips(panel).evaluateAll((els) => els.map((e) => e.getAttribute('data-field'))))
    .toEqual(['pinTier', 'priority', 'dueDate'])
  // C34 + C62 on the chips.
  await expect(panel.locator('.draft-decisions-key')).toHaveText('✦ = decided by Walnut')
  for (const chip of await draftDecisionChips(panel).all()) {
    await expect(chip).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(await chip.getAttribute('aria-label')).toMatch(/Set by Walnut from your text\. Click to change\.$/)
  }
  expect(await draftDecisionChip(panel, 'pinTier').getAttribute('title'))
    .toBe('Pinned tier: Satellite. Set by Walnut from your text. Click to change.')
})

// C6 C41 C36 C62: every chip opens the SAME popover on itself, re-anchoring in place.
test('each chip anchors the one popover on itself, a second trigger re-anchors it without a remount, and the words agree', async ({ page }) => {
  const panel = await draftWithD1(page)
  const menu = await openDraftSettings(panel, 'pinTier')
  await expect(menu).toHaveAttribute('role', 'dialog')
  await expect(menu).toHaveAttribute('aria-label', 'Task settings')
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveClass(/draft-decision-chip-active/)
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveAttribute('aria-expanded', 'true')
  expectAnchoredOn(await box(menu), await box(draftDecisionChip(panel, 'pinTier')), 'tier chip')
  // Tag the popover node: a remount would drop the tag.
  await menu.evaluate((el) => { (el as HTMLElement).dataset.probe = 'first-open' })

  for (const field of ['priority', 'dueDate'] as const) {
    await draftDecisionChip(panel, field).click()
    await expect(draftTaskMenu(page)).toHaveCount(1)
    await expect(draftTaskMenu(page)).toHaveAttribute('data-probe', 'first-open')
    await expect(draftDecisionChip(panel, field)).toHaveClass(/draft-decision-chip-active/)
    await expect(draftDecisionChip(panel, 'pinTier')).not.toHaveClass(/draft-decision-chip-active/)
    await expect.poll(async () => {
      try { expectAnchoredOn(await box(draftTaskMenu(page)), await box(draftDecisionChip(panel, field)), field); return 'ok' }
      catch (e) { return String(e) }
    }, { timeout: 5_000 }).toBe('ok')
  }
  await draftMoreButton(panel).click()
  await expect(draftTaskMenu(page)).toHaveAttribute('data-probe', 'first-open')
  await expect(draftMoreButton(panel)).toHaveClass(/draft-more-btn-active/)
  await expect(draftMoreButton(panel)).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => {
    try { expectAnchoredOn(await box(draftTaskMenu(page)), await box(draftMoreButton(panel)), 'More'); return 'ok' }
    catch (e) { return String(e) }
  }, { timeout: 5_000 }).toBe('ok')

  // C36: the chip says what the lit menu row says.
  const litPriority = menu.locator('.task-kebab-priority-options .badge-active')
  await expect(litPriority).toHaveCount(1)
  const squash = (t: string) => t.replace(/\s+/g, '')
  expect(squash(await litPriority.textContent() ?? '')).toBe(squash(await chipLabel(draftDecisionChip(panel, 'priority'))))
  const litTier = menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')
  expect(squash(await litTier.textContent() ?? '')).toBe(squash(await chipLabel(draftDecisionChip(panel, 'pinTier'))))
  await expect(menu.locator('.task-kebab-date-label').filter({ hasText: /^Due/ })).toHaveText(`Due: ${dayWords(3)}`)
  expect(await chipLabel(draftDecisionChip(panel, 'dueDate'))).toBe(`Due ${dayWords(3)}`)
  // The priority glyph wears the same badge colour as the menu's badge.
  const glyphColor = await draftDecisionChip(panel, 'priority').evaluate((chip) => {
    const el = Array.from(chip.querySelectorAll('*')).find((n) => (n.textContent ?? '').trim() === '!!')
    return el ? getComputedStyle(el).color : 'no glyph'
  })
  expect(glyphColor).toBe(await litPriority.evaluate((el) => getComputedStyle(el).color))
  // Same tier icon in chip and lit row (C39's DOM half).
  const svg = (loc: Locator) => loc.evaluate((el) => el.querySelector('svg')?.outerHTML ?? 'no svg')
  expect(await svg(draftDecisionChip(panel, 'pinTier'))).toBe(await svg(litTier))
  await page.screenshot({ path: `${SHOT_DIR}/c6-c36-menu-on-more.png` })

  // Clicking the current anchor toggles it closed.
  await draftMoreButton(panel).click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
})

// C26: Escape, outside click, inside click, and where focus goes.
test('Escape returns focus by open mode, an outside click closes, a click inside does not', async ({ page }) => {
  const panel = await draftWithD1(page)
  const composer = draftComposer(page)

  // Mouse open: the caret never left the composer, and Escape leaves it there.
  await composer.click()
  await openDraftSettings(panel, 'priority')
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(composer).toBeFocused()

  // Keyboard open (Enter on a focused chip): focus goes into the menu, back on Escape.
  await draftDecisionChip(panel, 'dueDate').focus()
  await page.keyboard.press('Enter')
  await expect(draftTaskMenu(page)).toBeVisible()
  await expect.poll(async () => draftTaskMenu(page).evaluate((m) => m.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'dueDate')).toBeFocused()

  // Inside click keeps it; outside click closes it.
  const menu = await openDraftSettings(panel, 'more')
  await menu.locator('.draft-task-menu-title').click()
  await expect(draftTaskMenu(page)).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(draftTaskMenu(page)).toHaveCount(0)
})

// C25 C25b: portalled, drag-proof, and inside the viewport with the calendar open.
for (const vp of [DESKTOP, SMALL]) {
  test(`at ${vp.width}x${vp.height} the popover is a body portal, drag-proof, and stays in the viewport with Due open`, async ({ page }) => {
    const panel = await draftWithD1(page, vp)
    const column = page.locator('.main-page-session-column').filter({ has: page.locator('.draft-session-panel') }).first()
    const menu = await openDraftSettings(panel, 'more')
    expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true)
    await expectInViewport(page, menu, 'closed-calendar menu')

    // A pointer drag that starts in the menu must not pick up the column.
    const colBefore = await box(column)
    const title = await box(menu.locator('.draft-task-menu-title'))
    await page.mouse.move(title.x + 10, title.y + title.height / 2)
    await page.mouse.down()
    await page.mouse.move(title.x + 220, title.y + 40, { steps: 8 })
    const colMid = await box(column)
    await page.mouse.up()
    const colAfter = await box(column)
    expect(Math.abs(colMid.x - colBefore.x), 'the column did not follow the pointer').toBeLessThanOrEqual(1)
    expect(Math.abs(colAfter.x - colBefore.x), 'the column did not move').toBeLessThanOrEqual(1)

    // Reopen (the drag's mouseup may count as an outside click) and expand Due.
    if (!(await draftTaskMenu(page).isVisible())) await openDraftSettings(panel, 'more')
    const dueRow = draftTaskMenu(page).locator('.task-kebab-date-toggle').filter({ hasText: /Due/ })
    const before = await box(dueRow)
    await dueRow.click()
    const calendar = draftTaskMenu(page).locator('.task-kebab-date.open .dp-content')
    await expect(calendar).toBeVisible()
    await page.waitForTimeout(150)
    const after = await box(dueRow)
    expect(Math.abs(after.y - before.y), 'C25b: the Due row moved less than its own height')
      .toBeLessThanOrEqual(before.height)
    expect((await box(calendar)).y, 'C25b: the calendar opens right under the Due row')
      .toBeGreaterThanOrEqual(after.y + after.height - 1)
    await expectInViewport(page, draftTaskMenu(page), 'menu with the Due calendar open')
    await expectInViewport(page, dueRow, 'the Due row')
    await page.screenshot({ path: `${SHOT_DIR}/c25-due-open-${vp.width}x${vp.height}.png` })
  })
}

// C5 C65: what More opens on a fresh draft, with and without priority shown.
for (const showPriority of [true, false]) {
  test(`More on a fresh draft lists tiers with Don't pin, Start, Due, Start unread; priority row ${showPriority ? 'shown' : 'hidden'}`, async ({ page }) => {
    await boot(page, {}, DESKTOP, showPriority)
    const panel = await openDraft(page)
    const menu = await openDraftSettings(panel, 'more')
    for (const tier of ['Focus', 'Satellite', 'Backlog', 'Wait', "Don't pin"]) {
      await expect(menu.locator('.task-kebab-tier-btn, .task-kebab-tier button').filter({ hasText: tier }).first()).toBeVisible()
    }
    // C65: nobody owns the tier, so nothing is lit and the label names the default.
    await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveCount(0)
    await expect(menu.locator('.task-kebab-tier-label')).toHaveText('Pin to (default Focus)')
    await expect(menu.locator('.task-kebab-date-toggle').filter({ hasText: /Start/ })).toBeVisible()
    await expect(menu.locator('.task-kebab-date-toggle').filter({ hasText: /Due/ })).toBeVisible()
    await expect(menu.getByRole('button', { name: /Start unread/ })).toBeVisible()
    await expect(menu.locator('.task-kebab-priority')).toHaveCount(showPriority ? 1 : 0)
    if (showPriority) {
      await expect(menu.locator('.task-kebab-priority-options button')).toHaveText([/!!\s*Immediate/, /!\s*Important/, /~\s*Backlog/, /None/])
    }
    // More's own tooltip names what it opens (priority only when shown).
    expect(await draftMoreButton(panel).getAttribute('title'))
      .toMatch(showPriority ? /^Pin tier, dates, priority, start unread \((⌘|Ctrl\+)\.\)$/ : /^Pin tier, dates, start unread \((⌘|Ctrl\+)\.\)$/)
    // Picking Focus from nothing is a human decision: a chip WITHOUT ✦.
    await menu.locator('.task-kebab-tier-btn').filter({ hasText: 'Focus' }).click()
    await expect(draftTaskMenu(page)).toHaveCount(0)
    await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Focus/)
    await expect(draftDecisionChip(panel, 'pinTier')).not.toHaveClass(AI)
  })
}

// C56 C61: the lit row accepts Walnut's pick; Don't pin; Use Walnut's pick hands it back.
test('clicking the lit tier or priority accepts it, Don\'t pin gives Not pinned, and Use Walnut\'s pick returns the field to the AI', async ({ page }) => {
  const mock = await boot(page, D1)
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'fix the flaky login test by friday, urgent')

  let menu = await openDraftSettings(panel, 'pinTier')
  await menu.locator('.task-kebab-tier-btn[aria-pressed="true"]').click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Satellite/)
  await expect(draftDecisionChip(panel, 'pinTier')).not.toHaveClass(AI)
  menu = await openDraftSettings(panel, 'priority')
  await menu.locator('.task-kebab-priority-options .badge-active').click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'priority')).not.toHaveClass(AI)

  // The parse now wants Backlog: the accepted Satellite is final.
  mock.set({ pinTier: 'backlog', priority: 'important', due_date: isoDay(3) })
  await typeAndSettle(page, mock, 'fix the flaky login test by friday, soon')
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Satellite/)
  await expect(draftDecisionChip(panel, 'priority')).toHaveText(/Immediate/)

  // C61: the menu offers the newer AI pick, and taking it gives the field back.
  menu = await openDraftSettings(panel, 'pinTier')
  const pick = menu.getByRole('button', { name: /Use Walnut's pick: Backlog/ })
  await expect(pick).toBeVisible()
  await pick.click()
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Backlog/)
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveClass(AI)
  mock.set({ pinTier: 'wait', priority: 'important', due_date: isoDay(3) })
  await typeAndSettle(page, mock, 'fix the flaky login test by friday, soon, blocked')
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Wait/)
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveClass(AI)

  // Don't pin: the one unpin entry in a draft.
  menu = await openDraftSettings(panel, 'pinTier')
  await menu.getByRole('button', { name: /Don't pin/ }).click()
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Not pinned/)
  await expect(draftDecisionChip(panel, 'pinTier')).not.toHaveClass(AI)
})

/** Mod+. in the composer. Tried with Meta first, then Control: the app reads the
 *  platform from the browser, and Playwright's Desktop devices do not all agree. */
async function pressModPeriod(page: Page): Promise<void> {
  await page.keyboard.press('Meta+Period')
  if (await draftTaskMenu(page).isVisible().catch(() => false)) return
  await page.waitForTimeout(400)
  if (await draftTaskMenu(page).isVisible().catch(() => false)) return
  await page.keyboard.press('Control+Period')
}

// C40: keyboard. Tab reaches every control once (Chromium); Mod+. works in both engines.
test('keyboard: Tab visits folder, project, each chip and More; Mod+. opens the menu on the first tier row', async ({ page, browserName }) => {
  const panel = await draftWithD1(page)
  if (browserName === 'chromium') {
    // Start at the bar's first control (quick folders, if any): the chip row sits
    // ABOVE the pills in the DOM, so starting at the folder pill would skip it.
    await panel.locator('.draft-launch-bar button').first().focus()
    const seen: string[] = []
    for (let i = 0; i < 24; i++) {
      const id = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el) return 'none'
        if (el.classList.contains('draft-more-btn')) return 'more'
        if (el.classList.contains('draft-decision-chip')) return `chip:${el.getAttribute('data-field')}`
        if (el.classList.contains('session-action-chip')) {
          const pills = Array.from(document.querySelectorAll('.main-page-session-column .draft-composer-bar .session-action-chip'))
          return pills.indexOf(el) === 0 ? 'folder' : 'project'
        }
        if (el.classList.contains('chat-input-textarea')) return 'composer'
        return 'other'
      })
      seen.push(id)
      if (id === 'chip:pinTier') {
        const outline = await draftDecisionChip(panel, 'pinTier').evaluate((el) => {
          const cs = getComputedStyle(el)
          return `${cs.outlineStyle} ${cs.outlineWidth}`
        })
        expect(outline, ':focus-visible draws a 2px outline').toBe('solid 2px')
      }
      if (id === 'composer') break
      await page.keyboard.press('Tab')
    }
    for (const want of ['folder', 'project', 'chip:pinTier', 'chip:priority', 'chip:dueDate', 'more']) {
      expect(seen.filter((s) => s === want), `Tab reaches ${want} exactly once: ${seen.join(' > ')}`).toHaveLength(1)
    }
    expect(seen.indexOf('folder')).toBeLessThan(seen.indexOf('project'))
    expect(seen.indexOf('chip:dueDate')).toBeLessThan(seen.indexOf('more'))
  }
  // Mod+. (the Mac app path: WKWebView does not Tab to buttons by default).
  await draftComposer(page).click()
  await pressModPeriod(page)
  await expect(draftTaskMenu(page)).toBeVisible()
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? ''))
    .toMatch(/task-kebab-tier-btn/)
  await expect(page.locator('[data-testid="draft-task-menu"] .task-kebab-tier-btn:focus')).toHaveText(/Satellite/)
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(draftMoreButton(panel), 'a keyboard open returns focus to its anchor, More').toBeFocused()
})

// C46: typing is leaving the menu; the next parse still lands.
test('the first keystroke in the composer closes the menu and the next parse updates the chip', async ({ page }) => {
  const mock = await boot(page, D1)
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'fix the flaky login test by friday, urgent')
  await draftComposer(page).click()
  await openDraftSettings(panel, 'more')
  mock.set({ pinTier: 'satellite', priority: 'important', due_date: isoDay(3) })
  const t0 = Date.now()
  await page.keyboard.type('x')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect.poll(() => mock.calls.some((c) => c.at - t0 >= 300), { timeout: 10_000 }).toBe(true)
  await expect(draftDecisionChip(panel, 'priority')).toHaveText(/Important/)
  await expect(draftComposer(page)).toBeFocused()
})

// C48 C66: one landing staggers its chips by 60ms; reduced motion turns it off.
for (const reduced of [false, true]) {
  test(`chips inserted by one parse ${reduced ? 'appear with no animation under reduced motion' : 'fade in 120ms, staggered 60ms in field order'}`, async ({ page }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' })
    const mock = await boot(page, D1)
    const panel = await openDraft(page)
    await draftComposer(page).fill('fix the flaky login test by friday, urgent')
    await expect(draftDecisionChips(panel)).toHaveCount(3)
    const styles = await draftDecisionChips(panel).evaluateAll((els) => els.map((el) => {
      const cs = getComputedStyle(el)
      return { name: cs.animationName, duration: cs.animationDuration, delay: cs.animationDelay }
    }))
    if (reduced) {
      for (const s of styles) expect(s.name === 'none' || s.duration === '0s', JSON.stringify(s)).toBe(true)
      for (const s of styles) expect(s.delay === '0s' || s.name === 'none', JSON.stringify(s)).toBe(true)
    } else {
      expect(styles.map((s) => s.duration)).toEqual(['0.12s', '0.12s', '0.12s'])
      expect(styles.map((s) => s.delay)).toEqual(['0s', '0.06s', '0.12s'])
      for (const s of styles) expect(s.name).not.toBe('none')
    }
    // A withdrawal is instant (no fade-out showing a decision that no longer holds).
    mock.set({})
    await typeAndSettle(page, mock, 'fix the flaky login test')
    await expect(draftDecisionChips(panel)).toHaveCount(0, { timeout: 1_000 })
  })
}

// C64: exactly one week ahead reads as a date, never as a weekday.
test('a due exactly seven days ahead reads M/D on the chip and in the menu', async ({ page }) => {
  const mock = await boot(page, { due_date: isoDay(7) })
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'send the marina invoice a week from today')
  expect(await chipLabel(draftDecisionChip(panel, 'dueDate'))).toBe(`Due ${dayWords(7)}`)
  expect(dayWords(7)).toMatch(/^\d{1,2}\/\d{1,2}$/)
  const menu = await openDraftSettings(panel, 'dueDate')
  await expect(menu.locator('.task-kebab-date-label').filter({ hasText: /^Due/ })).toHaveText(`Due: ${dayWords(7)}`)
})
