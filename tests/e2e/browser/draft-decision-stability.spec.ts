/**
 * The decision chips never flicker, never push the fixed row, and never steal the
 * caret. Runs under BOTH engines: the Mac app is a WKWebView, so every claim here is
 * also run with `PW_WEBKIT=1 npx playwright test <this file> --project=webkit`.
 * No `test.use` pin on purpose: the same file serves both projects.
 *
 *   C51  typing a sentence key by key, with eager replies that lack fields between
 *        trailing replies that carry them, never removes a chip from the DOM;
 *   C54  at 300px and 420px column widths a four-chip landing moves neither the
 *        folder pill nor More by more than 1px, and the chip row sits above them;
 *   C38  the densest state (D4) fits a 300px column without clipping built-in chip
 *        words, and the composer's bottom edge does not move when it lands;
 *   C55  a mouse click on a chip keeps the textarea focused, the menu pick hands the
 *        caret back, and Enter is Start;
 *   C52  Enter without a folder ("Pick a folder first") leaves chips, badges and the
 *        legend exactly as they were, then and after the text's round trip.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  bootDecisions, captureDraftRequests, discoverFixtureRoot, draftComposer, draftCwdPill,
  draftDecisionChips, draftDecisionChip, draftMoreButton, draftTaskMenu, isoDay, nthRequest, openDraft,
  openDraftOnCwd, openDraftSettings, typeAndSettle, watchChipRemovals, type ParseCall,
} from './draft-helpers'

const SHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-decisions/stability'
let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })
test.setTimeout(180_000)
// test-results/ is shared and wiped by peer runs: keep a failure shot under /tmp.
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    const slug = info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
    await page.screenshot({ path: `/tmp/draft-decisions/fail/${info.project.name}-${slug}.png` }).catch(() => {})
  }
})

const FOUR = { pinTier: 'satellite', priority: 'immediate', start_date: `${isoDay(2)}T15:00:00`, due_date: isoDay(4) }

/** Pin the draft column to `width` px so the geometry claims run at a known width. */
async function pinColumnWidth(page: Page, width: number): Promise<void> {
  await page.addStyleTag({ content: `.main-page-session-column:has(.draft-session-panel) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
}
async function rect(loc: Locator): Promise<{ x: number; y: number; bottom: number }> {
  return loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom } })
}

// ── C51 ──────────────────────────────────────────────────────────────────────

test('typing key by key with alternating eager and trailing replies never removes a chip', async ({ page, browserName }) => {
  // Stage fields grow with the sentence, so trailing replies only ever ADD.
  const stage = (text: string): Record<string, unknown> => ({
    ...(text.includes('marina') ? { pinTier: 'satellite' } : {}),
    ...(text.includes('friday') ? { due_date: isoDay(4) } : {}),
    ...(text.includes('urgent') ? { priority: 'immediate' } : {}),
  })
  const keys: number[] = []
  // An EAGER request leaves right after a keystroke; a TRAILING one only after a
  // 350ms pause. Eager replies deliberately lack every field (a prefix guess).
  const answer = (call: ParseCall) => {
    const lastKey = keys.filter((k) => k <= call.at).pop() ?? 0
    return call.at - lastKey < 200 ? {} : stage(call.text)
  }
  const mock = await bootDecisions(page, answer)
  const panel = await openDraft(page)
  const removals = await watchChipRemovals(panel)
  await draftComposer(page).click()
  for (const burst of ['fix the flaky login test in marina', ' by friday', ' urgent']) {
    for (const ch of burst) {
      keys.push(Date.now())
      await page.keyboard.type(ch)
      await page.waitForTimeout(35)
    }
    await page.waitForTimeout(800)
  }
  await expect(draftDecisionChips(panel)).toHaveCount(3)
  expect(mock.calls.length, 'both kinds of parse actually ran').toBeGreaterThan(3)
  expect(await removals(), `no chip left the DOM (${browserName})`).toEqual([])
  await page.screenshot({ path: `${SHOT_DIR}/c51-${browserName}.png` })
})

// ── C54 C38 ──────────────────────────────────────────────────────────────────

for (const width of [300, 420]) {
  test(`at a ${width}px column a four-chip landing moves neither the folder pill nor More`, async ({ page, browserName }) => {
    const mock = await bootDecisions(page, {})
    await pinColumnWidth(page, width)
    const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
    await typeAndSettle(page, mock, 'pair on the marina release friday 3pm, urgent, due sunday')
    await expect(draftDecisionChips(panel)).toHaveCount(0)
    // Measure AFTER the text is in (the composer may have grown) and BEFORE the reply.
    mock.set({ body: FOUR, delayMs: 1_200 })
    await draftComposer(page).fill('pair on the marina release friday 3pm, urgent, due monday')
    await page.waitForTimeout(100)
    const folder0 = await rect(draftCwdPill(panel))
    const more0 = await rect(draftMoreButton(panel))
    const composer0 = await rect(panel.locator('.session-panel-input > .chat-input-container'))
    await expect(draftDecisionChips(panel)).toHaveCount(4, { timeout: 10_000 })
    await page.waitForTimeout(450) // let the staggered fade-in finish
    const folder1 = await rect(draftCwdPill(panel))
    const more1 = await rect(draftMoreButton(panel))
    const composer1 = await rect(panel.locator('.session-panel-input > .chat-input-container'))
    for (const [what, a, b] of [['folder', folder0, folder1], ['More', more0, more1]] as const) {
      expect(Math.abs(b.x - a.x), `${what} x (${browserName} ${width}px)`).toBeLessThanOrEqual(1)
      expect(Math.abs(b.y - a.y), `${what} y (${browserName} ${width}px)`).toBeLessThanOrEqual(1)
    }
    // C38: the composer stays put; the bar grows upward into the empty body.
    expect(Math.abs(composer1.bottom - composer0.bottom), 'composer bottom edge').toBeLessThanOrEqual(1)
    const row = await rect(panel.locator('.draft-decision-row'))
    expect(row.bottom, 'the chip row sits above the folder/project row').toBeLessThanOrEqual(folder1.y + 0.5)
    await panel.screenshot({ path: `${SHOT_DIR}/c54-${browserName}-${width}.png` })
  })
}

test('the densest state (D4) fits a 300px column with every built-in chip word whole', async ({ page, browserName }) => {
  const mock = await bootDecisions(page, { ...FOUR, end_date: `${isoDay(2)}T17:00:00` })
  await pinColumnWidth(page, 300)
  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  await typeAndSettle(page, mock, 'pair on the marina release friday 3 to 5pm, urgent, due sunday')
  const menu = await openDraftSettings(panel, 'more')
  await menu.getByRole('button', { name: /Start unread/ }).click()
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(draftDecisionChips(panel)).toHaveCount(5)
  await expect(draftDecisionChip(panel, 'startDate')).toHaveText(/ to /)
  for (const sel of ['.draft-decision-row', '.draft-composer-bar']) {
    const fits = await panel.locator(sel).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    expect(fits, `${sel} does not overflow (${browserName})`).toBe(true)
  }
  const clipped = await draftDecisionChips(panel).evaluateAll((els) => els
    .filter((el) => Array.from(el.querySelectorAll('*')).concat([el])
      .some((n) => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1))
    .map((el) => el.getAttribute('data-field')))
  expect(clipped, 'built-in tier, priority and date words are never cut').toEqual([])
  await panel.screenshot({ path: `${SHOT_DIR}/c38-d4-${browserName}-300.png` })
})

// ── C55 ──────────────────────────────────────────────────────────────────────

test('a mouse pick from a chip keeps the caret: type on, then Enter is Start', async ({ page, browserName }) => {
  const mock = await bootDecisions(page, { pinTier: 'satellite', priority: 'immediate' })
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  await typeAndSettle(page, mock, 'fix the flaky login test, urgent')
  const composer = draftComposer(page)
  await composer.click()
  await composer.press('End')
  await composer.evaluate((el) => {
    const w = window as unknown as { __blurs: number }
    w.__blurs = 0
    el.addEventListener('blur', () => { w.__blurs++ })
  })
  await draftDecisionChip(panel, 'priority').click()
  await expect(draftTaskMenu(page)).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __blurs: number }).__blurs),
    `the chip's mousedown never blurs the textarea (${browserName})`).toBe(0)
  await expect(composer).toBeFocused()
  await draftTaskMenu(page).locator('.task-kebab-priority-options button').filter({ hasText: 'Important' }).click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(composer).toBeFocused()
  await page.keyboard.type('x')
  expect(await composer.inputValue()).toMatch(/x$/)
  expect(await composer.evaluate((el) => document.activeElement === el)).toBe(true)
  await page.keyboard.press('Enter')
  const body = await nthRequest(log, 'quickStart')
  expect(String(body.message ?? '')).toMatch(/x$/)
  expect(body.taskMeta?.priority).toBe('important')
})

// ── C52 ──────────────────────────────────────────────────────────────────────

test('Enter with no folder shows "Pick a folder first" and leaves every chip, badge and the legend in place', async ({ page }) => {
  const mock = await bootDecisions(page, FOUR)
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'pair on the marina release friday 3pm, urgent, due monday')
  await expect(draftDecisionChips(panel)).toHaveCount(4)
  const snapshot = () => panel.locator('.draft-launch-bar').evaluate((bar) => ({
    chips: Array.from(bar.querySelectorAll('.draft-decision-chip')).map((c) => `${c.getAttribute('data-field')}:${c.textContent}`),
    badges: bar.querySelectorAll('.draft-ai-badge').length,
    key: bar.querySelector('.draft-decisions-key')?.textContent ?? null,
  }))
  const before = await snapshot()
  const removals = await watchChipRemovals(panel)
  await draftComposer(page).click()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="draft-needs-folder"]')).toBeVisible()
  expect(await snapshot()).toEqual(before)
  // Past the clear debounce: the text's reset/restore round trip must not count as
  // "the composer was emptied".
  await page.waitForTimeout(900)
  expect(await snapshot()).toEqual(before)
  expect(await removals()).toEqual([])
  await expect(draftComposer(page)).toHaveValue(/due monday/)
})

// ── C39: light and dark evidence of the densest state and the open menu ──────

for (const theme of ['light', 'dark'] as const) {
  test(`C39 ${theme}: D4 and the open menu render legibly, and the tier icon matches the menu`, async ({ page, browserName }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((t) => {
      try { localStorage.setItem('open-walnut-theme', t) } catch { /* storage disabled */ }
      document.documentElement.setAttribute('data-theme', t)
    }, theme)
    const mock = await bootDecisions(page, { ...FOUR, end_date: `${isoDay(2)}T17:00:00` }, undefined, { width: 1280, height: 800 })
    await pinColumnWidth(page, 360)
    const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
    await typeAndSettle(page, mock, 'pair on the marina release friday 3 to 5pm, urgent, due sunday')
    let menu = await openDraftSettings(panel, 'more')
    await menu.getByRole('button', { name: /Start unread/ }).click()
    await page.keyboard.press('Escape')
    await expect(draftDecisionChips(panel)).toHaveCount(5)
    await page.waitForTimeout(450)
    const dir = '/tmp/draft-decisions'
    await panel.locator('.session-panel-input').screenshot({ path: `${dir}/c39-${theme}-d4-${browserName}.png` })

    menu = await openDraftSettings(panel, 'pinTier')
    const lit = menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')
    const svg = (loc: Locator) => loc.evaluate((el) => el.querySelector('svg')?.outerHTML ?? 'no svg')
    expect(await svg(draftDecisionChip(panel, 'pinTier'))).toBe(await svg(lit))
    // The AI outline differs from a plain chip's in this theme too.
    const border = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).borderTopColor)
    expect(await border(draftDecisionChip(panel, 'pinTier'))).not.toBe(await border(draftDecisionChip(panel, 'unread')))
    const menuBox = await menu.boundingBox()
    const barBox = await panel.locator('.session-panel-input').boundingBox()
    if (!menuBox || !barBox) throw new Error('nothing to crop')
    const x = Math.max(0, Math.min(menuBox.x, barBox.x) - 8)
    const y = Math.max(0, Math.min(menuBox.y, barBox.y) - 8)
    const right = Math.min(1280, Math.max(menuBox.x + menuBox.width, barBox.x + barBox.width) + 8)
    const bottom = Math.min(800, Math.max(menuBox.y + menuBox.height, barBox.y + barBox.height) + 8)
    await page.screenshot({ path: `${dir}/c39-${theme}-menu-${browserName}.png`, clip: { x, y, width: right - x, height: bottom - y } })
  })
}
