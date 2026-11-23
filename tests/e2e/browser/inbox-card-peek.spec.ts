import { expect, test } from '@playwright/test'
import { home } from './inbox-items-helpers'
import { expectInboxCardWhole, expectRestored, expectStill, expectTooltipNotPeek, expectWidensInPlace, expectWorkerRowWidens, isOpen, openInRow, peekMarks, topsOf } from './truncation-peek-helpers'

// A whole card widens sideways at its own height (2026-11-15, the user: wider, not taller), and
// only inside a peek zone (`[data-peek-zone]`, Home's task panel; 2026-11-23, the user: only very
// narrow places widen). The page fixture below is marked as one; its twin outside opens nothing.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

const SUBJECT = 'A letter with a full-length subject: review the garden schedule, the tool inventory and the next steps before the weekend'
const PREVIEW = 'The garden group needs a reply about the whole schedule. Check the tools, confirm the available dates, and bring the inventory notes from the last meeting. '.repeat(4)

test('dense inbox cards show their subject and preview whole, keep their actions, and wrap at a narrow window', async ({ page, request }, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const ids: string[] = []
  try {
    for (let i = 0; i < 12; i++) {
      const response = await request.post('/api/v1/human-inbox', { data: { subject: `${SUBJECT} (${i})`, type: 'review', markdown: PREVIEW } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    await home(page)
    await page.getByRole('button', { name: /^Notifications/ }).click()
    const panel = page.locator('.notification-panel')
    await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    const card = (id: string) => panel.locator(`[data-letter-id="${id}"]`)
    await expectInboxCardWhole(page, card(ids[11]), [card(ids[10]), card(ids[9])], info)
    expect(errors).toEqual([])
  } finally {
    for (const id of ids) await request.post(`/api/v1/human-inbox/${id}/archive`, { data: { archived: true } })
  }
})

test('in a zone, unmarked components, rows with twelve texts, a line longer than the window and the keyboard all widen the real row; outside one nothing opens', async ({ page }) => {
  await home(page)
  await page.mouse.move(1000, 100)
  await page.evaluate(() => {
    const cut = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    const fixture = document.createElement('section')
    fixture.id = 'peek-class-fixture'
    fixture.setAttribute('data-peek-zone', '')
    fixture.style.cssText = 'position:fixed;left:40px;top:60px;width:260px;z-index:9999;background:var(--bg)'
    fixture.innerHTML = [
      `<div data-peek-row="" id="many-texts" style="height:216px;overflow:hidden">${Array.from({ length: 12 }, (_, i) => `<div style="${cut};height:18px">Row ${i}: ${'A detailed entry with all of its words shown in this row. '.repeat(2)}</div>`).join('')}</div>`,
      `<div id="new-container"><span id="new-text" style="display:block;${cut}">${'A new component also widens in place. '.repeat(3)}</span></div>`,
      '<div id="following">Following component</div>',
      `<div role="listbox"><div role="option" id="option-a" style="${cut}">A long option name with many words that should only widen this option, never the whole list</div><div role="option" id="option-b" style="${cut}">A second long option that must remain cut while the first option is hovered</div></div>`,
      `<div id="icon-line" style="display:flex;width:240px;gap:8px"><span id="line-icon" style="flex:none">○</span><span id="line-text" style="${cut}">A long status text keeps its own icon beside it on the same line while the row widens</span></div>`,
      `<div id="too-long-box"><span id="too-long" style="display:block;${cut}">${'Far longer than any window: every word of this line will not fit on one screen. '.repeat(8)}</span></div>`,
      `<div data-peek-row="" id="btn-row" style="display:flex;gap:6px;width:240px"><span id="btn-text" style="${cut};flex:1;min-width:0">A row with its own button keeps that button working while it is wide open</span><button id="btn-spy" type="button">More</button></div><div id="btn-after">After the button row</div>`,
      `<button id="kbd-before">Before</button><div data-peek-row="" tabindex="0" id="kbd-row" style="${cut}">A row reached with the keyboard opens as wide as the pointer would make it</div><button id="kbd-after">After</button>`,
    ].join('')
    document.body.appendChild(fixture)
    // The same kinds outside any zone: an unmarked container, a row of cut texts, a row with a
    // button, and a row the keyboard reaches.
    const outside = document.createElement('section')
    outside.id = 'peek-outside-fixture'
    outside.style.cssText = 'position:fixed;left:700px;top:60px;width:260px;z-index:9999;background:var(--bg)'
    outside.innerHTML = [
      `<div id="out-container"><span id="out-text" style="display:block;${cut}">${'An unmarked component outside a zone keeps its place. '.repeat(3)}</span></div>`,
      `<div data-peek-row="" id="out-row" style="height:54px;overflow:hidden">${Array.from({ length: 3 }, (_, i) => `<div style="${cut};height:18px">Out ${i}: ${'A detailed entry outside a zone shows its words in a tooltip. '.repeat(2)}</div>`).join('')}</div>`,
      `<div data-peek-row="" id="out-btn-row" style="display:flex;gap:6px;width:240px"><span id="out-btn-text" style="${cut};flex:1;min-width:0">A row with its own button outside a zone keeps that button working</span><button id="out-btn" type="button">More</button></div>`,
      `<button id="out-kbd-before">Before</button><div data-peek-row="" tabindex="0" id="out-kbd-row" style="${cut}">A row reached with the keyboard outside a zone opens nothing</div>`,
      '<div id="out-following">Following outside</div>',
    ].join('')
    document.body.appendChild(outside)
    // The row's own button, as a menu button: every event of a press lands on it once, and its
    // click opens a menu outside the row.
    const spy = document.getElementById('btn-spy')!
    const w = window as unknown as { __spy: string[] }
    w.__spy = []
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) spy.addEventListener(type, (e) => { if (e.target === spy) w.__spy.push(type) })
    spy.addEventListener('click', () => { const m = document.createElement('div'); m.id = 'spy-menu'; m.setAttribute('role', 'menu'); m.textContent = 'Spy menu'; fixture.appendChild(m) })
  })
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!
  const off = () => page.mouse.move(1278, 790)

  // Outside a zone: each kind keeps its box, nothing below moves, its text is in a native title,
  // its button still takes the press, and the keyboard opens nothing either.
  const outBelow = [page.locator('#out-row'), page.locator('#out-btn-row'), page.locator('#out-following')]
  const outTops = await topsOf(outBelow)
  await expectTooltipNotPeek(page.locator('#out-text'), 'keeps its place', 'outside container')
  await expectTooltipNotPeek(page.locator('#out-row > div').nth(1), 'Out 1: A detailed entry', 'outside row of cut texts')
  await expectTooltipNotPeek(page.locator('#out-btn-text'), 'keeps that button working', 'outside row with a button')
  await expectStill(outBelow, outTops, 'outside')
  await page.locator('#out-btn').click()
  expect(await peekMarks(page), 'a press on the outside row\'s button opens nothing').toBe(0)
  await page.locator('#out-kbd-before').focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('#out-kbd-row')).toBeFocused()
  await page.waitForTimeout(300)
  expect(await peekMarks(page), 'Tab onto an outside row opens nothing').toBe(0)
  await page.locator('#out-kbd-row').blur()
  await off()

  // Twelve cut texts in one row: all open at once, all whole, and nothing below moves.
  const many = page.locator('#many-texts')
  const manyBefore = await box('#many-texts')
  const below = [page.locator('#new-container'), page.locator('#following')]
  const belowTops = await topsOf(below)
  await many.hover({ position: { x: 5, y: 5 } })
  await expectWidensInPlace(many, manyBefore, { label: 'twelve texts' })
  await expect(many.locator('[data-peek-open]')).toHaveCount(12)
  for (const t of await many.locator('[data-peek-open]').all()) expect(await openInRow(t)).toBe(true)
  await expectStill(below, belowTops, 'below twelve texts')
  await off()
  await expectRestored(many, manyBefore, 'twelve texts')

  // An unmarked component opens its container through the same path.
  const container = page.locator('#new-container')
  const containerBefore = await box('#new-container')
  const followingTop = await topsOf([page.locator('#following')])
  await page.locator('#new-text').hover()
  await expectWidensInPlace(container, containerBefore, { label: 'unmarked container' })
  await expect.poll(() => openInRow(page.locator('#new-text'))).toBe(true)
  await expectStill([page.locator('#following')], followingTop, 'after the unmarked container')
  // A live text change under the pointer opens it again on the new text, at the same height.
  await page.locator('#new-text').evaluate((el) => { el.textContent = 'Changed entry with new words: '.repeat(3) })
  await expect.poll(() => openInRow(page.locator('#new-text'))).toBe(true)
  await expect(page.locator('#new-text')).toContainText('Changed entry')
  await expectWidensInPlace(container, containerBefore, { label: 'unmarked container, changed' })
  await off()
  await expectRestored(container, containerBefore, 'unmarked container')

  // React's keyed reorder moves a node without changing its text. The old shell must be
  // removed before a frame paints the new order, even though the row remains connected.
  await page.locator('#new-text').hover()
  await expectWidensInPlace(container, containerBefore, { label: 'before same-node reorder' })
  await container.evaluate(el => el.parentElement!.appendChild(el))
  await expect(container).not.toHaveAttribute('data-peek-expanded')
  await expect(page.locator('[data-peek-placeholder]')).toHaveCount(0)
  expect(await container.evaluate(el => el.matches(':popover-open'))).toBe(false)
  await container.evaluate(el => el.parentElement!.insertBefore(el, document.getElementById('following')))
  await off()

  // One option of a list opens alone.
  const optionBTop = await topsOf([page.locator('#option-b')])
  const optionBefore = await box('#option-a')
  await page.locator('#option-a').hover()
  await expectWidensInPlace(page.locator('#option-a'), optionBefore, { label: 'option' })
  await expect(page.locator('#option-b')).not.toHaveAttribute('data-peek-open')
  await expectStill([page.locator('#option-b')], optionBTop, 'the next option')
  await off()
  await expectRestored(page.locator('#option-a'), optionBefore, 'option')

  // A text keeps its icon beside it on the same line.
  const lineBefore = await box('#icon-line')
  await page.locator('#line-text').hover()
  await expectWidensInPlace(page.locator('#icon-line'), lineBefore, { label: 'icon line' })
  await expect.poll(() => openInRow(page.locator('#line-text'))).toBe(true)
  const icon = await box('#line-icon')
  const text = await box('#line-text')
  expect(text.y).toBeCloseTo(icon.y, 0)
  expect(text.x).toBeGreaterThan(icon.x + icon.width)
  await off()
  await expectRestored(page.locator('#icon-line'), lineBefore, 'icon line')

  // Longer than the window: as wide as the window allows, still one line, and it may stay cut.
  const longBefore = await box('#too-long-box')
  await page.locator('#too-long').hover()
  await expectWidensInPlace(page.locator('#too-long-box'), longBefore, { label: 'longer than the window', capped: true })
  expect(await isOpen(page.locator('#too-long'))).toBe(true)
  await off()
  await expectRestored(page.locator('#too-long-box'), longBefore, 'longer than the window')

  // The open row is the real one: a press on its own button lands there once and opens its menu,
  // and the row is back in its place, visible, when the menu shows.
  const btnRow = page.locator('#btn-row')
  const btnBefore = await box('#btn-row')
  const btnAfterTop = await topsOf([page.locator('#btn-after')])
  await page.locator('#btn-text').hover()
  await expectWidensInPlace(btnRow, btnBefore, { label: 'row with a button' })
  await page.locator('#btn-spy').click()
  expect(await page.evaluate(() => (window as unknown as { __spy: string[] }).__spy)).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
  await expect(page.locator('#spy-menu')).toBeVisible()
  await expect(btnRow).toBeVisible()
  await expect(page.locator('#btn-spy')).toBeVisible()
  // Whether the click closed it or not, the row is still drawn at its own top and height.
  const clicked = (await btnRow.boundingBox())!
  expect(Math.abs(clicked.y - btnBefore.y)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(clicked.height - btnBefore.height)).toBeLessThanOrEqual(0.5)
  await off()
  await expectRestored(btnRow, btnBefore, 'row with a button after its click')
  await expectStill([page.locator('#btn-after')], btnAfterTop, 'after the button row')

  // The keyboard: Tab onto the row opens it at once, Escape closes it, Tab off it closes it.
  const kbd = page.locator('#kbd-row')
  const kbdBefore = await box('#kbd-row')
  await page.locator('#kbd-before').focus()
  await page.keyboard.press('Tab')
  await expect(kbd).toBeFocused()
  await expectWidensInPlace(kbd, kbdBefore, { label: 'keyboard row' })
  await page.keyboard.press('Escape')
  await expectRestored(kbd, kbdBefore, 'keyboard row after Escape')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expectWidensInPlace(kbd, kbdBefore, { label: 'keyboard row again' })
  await page.keyboard.press('Tab')
  await expect(page.locator('#kbd-after')).toBeFocused()
  await expectRestored(kbd, kbdBefore, 'keyboard row after Tab')
})

test('a worker row under a long lead says Worker alone and widens whole, with the metadata one line above the title', async ({ page, request }, info) => {
  await expectWorkerRowWidens(page, request, {
    // A project long enough to be cut at both panel widths, so the row has something to open: longer
    // than a whole meta line at 640 too, since that line wraps a part that fits rather than cut it
    // (ea0bd746c2, status-sections.css .status-card-meta).
    project: 'Garden Insights Re-Architecture Platform with the complete plan, the inventory of every tool, the planting log, the watering rota for every bed and the seed orders for next spring',
    lead: 'Garden Re-Architecture As Platform - Platform Lead with the complete plan and the inventory of every tool',
    worker: 'Garden org demo Friday: garden insight end to end, with the complete planting schedule and all the next steps',
  }, info)
})
