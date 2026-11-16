import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, showAllSections } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'
import { expectPeeksInPlace, expectRestored, expectStill, expectWidensInPlace, fits, followingOf, isOpen, openInRow, peekPill, topsOf } from './truncation-peek-helpers'

/**
 * Cut-off text peeks in place (web/src/utils/truncation-peek.ts). A task row widens in place
 * (2026-11-15, the user: the whole card gets wider, not taller; design 01 with 02's right-edge
 * fallback): with a real mouse anywhere on a row whose title is cut off, the real row opens in the
 * top layer at its own top and height, wide enough for its title on one line, over whatever is
 * beside it; an empty placeholder keeps its place, so no row moves. No native title is left above
 * the pointer, so no dark box opens; it closes when the pointer leaves or the list scrolls; a row
 * that fits shows nothing. Text outside a row that a column clips opens its own container the same
 * way.
 */

const SHOTS = '/tmp/truncation-peek'
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

const WORD = 'Zephyrpeek'
const LONG_A = `${WORD} alpha: Plan the garden shed rebuild, with the lumber list, the paint colours and every weekend step written out in full`
const LONG_B = `${WORD} beta: Write up the sourdough experiments, with the flour ratios, the proofing times and the notes from each bake`
const SHORT = `${WORD} gamma`

const pill = peekPill
const box = async (l: Locator) => (await l.boundingBox())!
const ids = new Map<string, string>()
// Pinned rows: the Home tier rows of the report (a pinned row's title is what showed the dark tooltip).
const row = (page: Page, title: string) => page.locator(`.todo-pinned-section [data-task-id="${ids.get(title)}"]`).first()
const titleOf = (page: Page, title: string) => row(page, title).locator('.todo-pinned-title').first()

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', { data: { title, source: 'local', project: 'Peek Spec' } })
  expect(res.status()).toBe(201)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  expect((await request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
  ids.set(title, id)
  return id
}

async function centerOf(page: Page, loc: ReturnType<Page['locator']>) {
  const box = await loc.boundingBox()
  if (!box) throw new Error('no box')
  return { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2, box }
}

/** Every native title from the element under the point up to the root. */
const titlesAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const out: string[] = []
  for (let el = document.elementFromPoint(px, py); el; el = el.parentElement) { const t = el.getAttribute('title'); if (t) out.push(t) }
  return out
}, [x, y] as const)

test('a cut-off Home row widens in place: as tall as it was, nothing below moves, and it closes when left', async ({ page, baseURL, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const made = [await createTask(request, LONG_A), await createTask(request, LONG_B), await createTask(request, SHORT)]
  try {
    await isolateUiPrefs(page)
    await openHome(page, baseURL!)
    await showAllSections(page)
    for (const t of [LONG_A, LONG_B, SHORT]) await expect(row(page, t)).toBeVisible({ timeout: 20_000 })
    // Other specs may have pinned more: bring ours on screen.
    await row(page, LONG_A).evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(1200, 780)
    await page.waitForTimeout(300)

    // The row's own title is cut off: the page shows less than the text.
    expect(await titleOf(page, LONG_A).evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(true)
    const before = await box(row(page, LONG_A))
    const beforeB = await box(row(page, LONG_B))
    const neighbours = [row(page, LONG_B), row(page, SHORT)]
    const tops = await topsOf(neighbours)

    const a = await centerOf(page, titleOf(page, LONG_A))
    await page.mouse.move(a.x, a.y)
    // The whole row opens wider at its own top and height, its title whole on one line.
    const after = await expectWidensInPlace(row(page, LONG_A), before, { label: 'Home row' })
    await expect.poll(() => openInRow(titleOf(page, LONG_A))).toBe(true)
    const t = await box(titleOf(page, LONG_A))
    expect(t.x + t.width).toBeLessThanOrEqual(after.x + after.width + 1)
    await expectStill(neighbours, tops, 'Home row below')
    // No native title above the pointer, so no dark tooltip.
    expect(await titlesAt(page, a.x, a.y)).toEqual([])
    await page.screenshot({ path: `${SHOTS}/1-home-row.png`, clip: { x: 0, y: Math.max(0, a.y - 160), width: 1280, height: 320 } })

    // The widened part is the row too: the pointer out on it, over what was beside the row, keeps it open.
    await page.mouse.move(after.x + after.width - 6, a.y, { steps: 4 })
    await page.waitForTimeout(250)
    expect(await isOpen(titleOf(page, LONG_A))).toBe(true)
    await page.mouse.move(a.x, a.y, { steps: 4 })

    // A re-render under the resting pointer (a rename the server pushes) opens the row again on
    // its new text in the same step: no painted frame shows it narrow, and none shows it taller
    // (2026-11-15, board-kanban-layout C67; truncation-peek.ts reopenInPlace).
    await row(page, LONG_A).evaluate((el, h0) => {
      const w = window as unknown as { __peekMinW: number; __peekDH: number; __peekStop: boolean }
      w.__peekMinW = Infinity
      w.__peekDH = 0
      w.__peekStop = false
      const tick = () => {
        if (w.__peekStop) return
        if (el.isConnected) {
          const r = el.getBoundingClientRect()
          w.__peekMinW = Math.min(w.__peekMinW, r.width)
          w.__peekDH = Math.max(w.__peekDH, Math.abs(r.height - h0))
        } else w.__peekMinW = 0
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, before.height)
    expect((await request.patch(`/api/tasks/${made[0]}`, { data: { title: `${LONG_A}, renamed while open` } })).ok()).toBe(true)
    await expect(titleOf(page, LONG_A)).toContainText('renamed while open', { timeout: 10_000 })
    await page.waitForTimeout(400)
    const painted = await page.evaluate(() => { const w = window as unknown as { __peekMinW: number; __peekDH: number; __peekStop: boolean }; w.__peekStop = true; return { minW: w.__peekMinW, dh: w.__peekDH } })
    expect(painted.minW, 'the open row never painted closed while it re-rendered').toBeGreaterThan(before.width + 8)
    expect(painted.dh, 'nor any taller or shorter').toBeLessThanOrEqual(0.5)
    await expect.poll(() => openInRow(titleOf(page, LONG_A))).toBe(true)

    // On to the next cut-off row: it opens and the first is back as it was.
    await page.mouse.move(beforeB.x + 120, beforeB.y + beforeB.height / 2, { steps: 6 })
    await expectWidensInPlace(row(page, LONG_B), beforeB, { label: 'next Home row' })
    await expectRestored(row(page, LONG_A), before, 'the row left')
    await expect.poll(() => openInRow(titleOf(page, LONG_B))).toBe(true)

    // A press lands on the open row as it is (it does not close under the press).
    await page.mouse.down()
    expect(await isOpen(titleOf(page, LONG_B))).toBe(true)
    await page.mouse.up()
    // Off the list: every row is back.
    await page.mouse.move(1200, 780)
    await expectRestored(row(page, LONG_B), beforeB, 'next Home row')
    await expectRestored(row(page, LONG_A), before, 'Home row')

    // Back on a row, then a scroll: it closes while the list moves.
    const b = await centerOf(page, titleOf(page, LONG_B))
    await page.mouse.move(b.x, b.y, { steps: 6 })
    await expect.poll(() => isOpen(titleOf(page, LONG_B))).toBe(true)
    await page.mouse.wheel(0, 40)
    await expect.poll(() => isOpen(titleOf(page, LONG_B))).toBe(false)
    await expect(page.locator('[data-peek-placeholder]')).toHaveCount(0)

    // A row whose title fits shows nothing.
    await page.mouse.move(1200, 780)
    const s = await centerOf(page, titleOf(page, SHORT))
    const shortBefore = await box(row(page, SHORT))
    await page.mouse.move(s.x - (s.box.width / 2) + 10, s.y, { steps: 4 })
    await page.waitForTimeout(300)
    await expect(row(page, SHORT)).not.toHaveAttribute('data-peek-expanded')
    const shortNow = await box(row(page, SHORT))
    expect(shortNow.width).toBeCloseTo(shortBefore.width, 0)
    expect(shortNow.height).toBeCloseTo(shortBefore.height, 0)
    await expect(pill(page)).toHaveCount(0)

    await page.mouse.move(1200, 780)
    expect(errors).toEqual([])
  } finally {
    for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
  }
})

test('moving down a list: one row open at a time, no row and no scroll moves, and a press keeps the row as it is', async ({ page, baseURL, request }) => {
  const titles = ['delta', 'epsilon', 'zeta', 'eta'].map((w) => `${WORD} ${w}: Sort the attic boxes by room, label each one, and write the list of what goes to the charity shop`)
  const made: string[] = []
  for (const t of titles) made.push(await createTask(request, t))
  try {
    await isolateUiPrefs(page)
    await openHome(page, baseURL!)
    await showAllSections(page)
    for (const t of titles) await expect(row(page, t)).toBeVisible({ timeout: 20_000 })
    await page.mouse.move(1200, 780)
    // Our rows top to bottom, and the list they scroll in.
    const order = await page.evaluate((ids) => ids.map((id) => [id, document.querySelector(`.todo-pinned-section [data-task-id="${id}"]`)!.getBoundingClientRect().top] as const).sort((a, b) => a[1] - b[1]).map(([id]) => id), made)
    const rowById = (id: string) => page.locator(`.todo-pinned-section [data-task-id="${id}"]`).first()
    const titleById = (id: string) => rowById(id).locator('.todo-pinned-title').first()
    const scrollTop = () => rowById(order[0]).evaluate((el) => {
      let l = el.parentElement
      while (l && !(/(auto|scroll)/.test(getComputedStyle(l).overflowY) && l.scrollHeight > l.clientHeight)) l = l.parentElement
      return l ? l.scrollTop : 0
    })
    await rowById(order[0]).evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(1200, 780)
    await page.waitForTimeout(300)
    const rows = order.map(rowById)
    const boxes = await Promise.all(rows.map(box))
    const tops = await topsOf(rows)
    const scrolled = await scrollTop()

    for (let i = 0; i + 1 < order.length; i++) {
      const b = await box(titleById(order[i]))
      await page.mouse.move(b.x + Math.min(b.width / 2, 120), b.y + b.height / 2)
      await expectWidensInPlace(rows[i], boxes[i], { label: `row ${i}` })
      // Down onto the next row: it opens, this one closes, and the pointer is still on it.
      const at = { x: boxes[i + 1].x + 120, y: boxes[i + 1].y + boxes[i + 1].height / 2 }
      await page.mouse.move(at.x, at.y, { steps: 6 })
      await expectWidensInPlace(rows[i + 1], boxes[i + 1], { label: `row ${i + 1}` })
      expect(await isOpen(titleById(order[i]))).toBe(false)
      expect(await page.evaluate(([x, y, id]) => !!document.elementFromPoint(x, y)?.closest(`[data-task-id="${id}"]`), [at.x, at.y, order[i + 1]] as const)).toBe(true)
      await expectStill(rows, tops, `moving from row ${i}`)
      expect(await scrollTop(), 'nothing scrolls to make up for a closing row').toBe(scrolled)
    }
    await page.mouse.move(1200, 780)
    await expectRestored(rows[3], boxes[3], 'last of ours')

    // A press that moves a little (under a drag's start) keeps the open row as it is.
    const last = await box(titleById(order[3]))
    await page.mouse.move(last.x + 20, last.y + 6, { steps: 4 })
    await expect.poll(() => isOpen(titleById(order[3]))).toBe(true)
    await page.mouse.down()
    await page.mouse.move(last.x + 23, last.y + 7)
    expect(await isOpen(titleById(order[3]))).toBe(true)
    await page.mouse.up()
    await page.mouse.move(1200, 780)
    await expect.poll(() => isOpen(titleById(order[3]))).toBe(false)
  } finally {
    for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
  }
})

test('at the window\'s right edge a row grows to the left, the last row of a scrolled list opens over its clip, and titles are restored', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)
  await page.mouse.move(600, 700)
  await page.evaluate(() => {
    const edge = document.createElement('div')
    edge.id = 'peek-fixture'
    edge.style.cssText = 'position:fixed;left:1000px;top:300px;width:250px;z-index:5000;background:var(--bg);font-size:14px'
    edge.innerHTML = '<button type="button" title="Open the long line: Working" style="display:block;width:100%;overflow:hidden;white-space:nowrap;text-align:left"><span class="clip-line">A line the column cuts off at its edge, with every word of it still to read</span></button><div id="peek-following">Following row</div>'
    document.body.appendChild(edge)
    const list = document.createElement('div')
    list.id = 'peek-list'
    list.style.cssText = 'position:fixed;left:900px;top:560px;width:300px;height:120px;overflow:auto;z-index:5000;background:var(--bg);font-size:14px'
    list.innerHTML = Array.from({ length: 6 }, (_, i) => `<div data-peek-row="" class="peek-list-row" style="height:30px;line-height:30px;padding:0 8px"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">List row ${i}: the last one of a list scrolled to its end opens over the clip of the list</span></div>`).join('')
    document.body.appendChild(list)
  })

  // At the right edge: it keeps its right edge and grows to the left, inside the window.
  const button = page.locator('#peek-fixture button:not([data-peek-placeholder])')
  const line = page.locator('#peek-fixture .clip-line')
  const before = await box(button)
  const following = await topsOf([page.locator('#peek-following')])
  const at = await centerOf(page, button)
  await page.mouse.move(at.x, at.y)
  const after = await expectWidensInPlace(button, before, { label: 'right-edge control' })
  expect(after.x, 'it grew to the left').toBeLessThan(before.x - 1)
  await expect.poll(() => isOpen(line)).toBe(true)
  await expect.poll(() => fits(button), 'the whole line shows in the widened control').toBe(true)
  await expectStill([page.locator('#peek-following')], following, 'below the right-edge control')
  expect(await titlesAt(page, at.x, at.y)).toEqual([])
  await page.screenshot({ path: `${SHOTS}/2-right-edge.png`, clip: { x: 600, y: 240, width: 680, height: 240 } })
  await page.mouse.move(600, 700)
  await expectRestored(button, before, 'right-edge control')
  await expect(button).toHaveAttribute('title', 'Open the long line: Working')

  // The last row of a list scrolled to its end: it opens over the list's clip, and the list
  // neither scrolls nor grows.
  const list = page.locator('#peek-list')
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(300)
  const lastRow = page.locator('#peek-list .peek-list-row').last()
  const prevRow = page.locator('#peek-list .peek-list-row').nth(4)
  const lastBefore = await box(lastRow)
  const prevTop = await topsOf([prevRow])
  const listBefore = await list.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, left: el.getBoundingClientRect().left }))
  await page.mouse.move(lastBefore.x + 40, lastBefore.y + lastBefore.height / 2)
  const open = await expectWidensInPlace(lastRow, lastBefore, { label: 'last list row' })
  await expect.poll(() => openInRow(lastRow.locator('span'))).toBe(true)
  expect(open.x, 'it reaches past the list it was clipped by').toBeLessThan(listBefore.left - 1)
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.peek-list-row'), [open.x + 4, open.y + open.height / 2] as const), 'drawn over the clip, not cut by it').toBe(true)
  await expectStill([prevRow], prevTop, 'the row above the last')
  expect(await list.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, left: el.getBoundingClientRect().left }))).toEqual(listBefore)
  await page.screenshot({ path: `${SHOTS}/3-last-row.png`, clip: { x: 400, y: 520, width: 880, height: 200 } })
  await page.mouse.move(600, 700)
  await expectRestored(lastRow, lastBefore, 'last list row')
  expect((await list.evaluate((el) => el.scrollTop))).toBe(listBefore.top)
})

// 2026-11-16 (session-panel-narrow R5): a host name cut inside a sentence opened the sentence's
// inline span, whose placeholder held one line, so the open box stood 86px taller and 2px lower than
// its place. Every inline box around a cut text (one span in another, a link) is passed over: the
// block that holds the sentence is what opens, at its own top and height.
test('a cut name inside a sentence opens the block that holds the sentence, never an inline span around it', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)
  await page.mouse.move(600, 700)
  const NAME = 'garden-box-example-7f3a9c21.north-3.lab.example.net'
  await page.evaluate((name) => {
    const token = `<span class="prose-token" style="display:inline-block;max-width:calc(100% - 20px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom">${name}</span>`
    const fixture = document.createElement('div')
    fixture.id = 'peek-prose'
    fixture.style.cssText = 'position:fixed;left:300px;top:200px;width:220px;z-index:5000;background:var(--bg);font-size:14px;line-height:20px'
    fixture.innerHTML = [
      `<div class="prose-block" data-case="span"><span class="prose-inline">${token} is reachable, and this session's process is not running. Send a message to resume it.</span></div>`,
      `<div class="prose-block" data-case="nested" style="margin-top:12px"><span><em>${token} is reachable, and the words go on for a few more lines below it.</em></span></div>`,
      `<div class="prose-block" data-case="link" style="margin-top:12px">The host <a href="#peek-prose">${token}</a> answered, and the words go on for a few more lines below it.</div>`,
    ].join('')
    document.body.appendChild(fixture)
  }, NAME)
  for (const kind of ['span', 'nested', 'link']) {
    const block = page.locator(`#peek-prose .prose-block[data-case="${kind}"]`)
    const token = block.locator('.prose-token')
    const before = await box(block)
    expect(before.height, `${kind}: the sentence runs over several lines`).toBeGreaterThan(40)
    await expectPeeksInPlace(token, NAME, `${kind} sentence`)
    // While open, it is the sentence's block that is in the top layer.
    await token.hover()
    await expect.poll(() => token.evaluate((el) => el.closest('[data-peek-expanded]')?.classList.contains('prose-block') ?? null), { timeout: 5_000 }).toBe(true)
    await page.mouse.move(600, 700)
    await expectRestored(block, before, `${kind} sentence`)
  }
})

test('a task row widens as a whole: the pointer anywhere on a status row opens it; on its ⋮ it stays open, and the ⋮ still opens its menu', async ({ page, baseURL }) => {
  const { presetPanelDesign, setStatusSectionOpen } = await import('./status-section-helpers')
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await openHome(page, baseURL!)
  await showAllSections(page)
  const panel = page.locator('.todo-panel').first()
  await setStatusSectionOpen(panel, 'needs', true)
  await page.mouse.move(1200, 780)
  // A status row of the fixture whose title the row cuts off, on screen.
  const findCut = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.status-section-card[data-peek-row]')].find((c) => {
    const t = c.querySelector<HTMLElement>('.todo-pinned-title')
    const r = c.getBoundingClientRect()
    return t && t.scrollWidth > t.clientWidth + 1 && r.top > 60 && r.bottom < innerHeight - 20
  })?.dataset.taskId ?? '')
  await expect.poll(findCut, { timeout: 20_000 }).not.toBe('')
  const cutId = await findCut()
  const card = panel.locator(`.status-section-card[data-task-id="${cutId}"]`).first()
  const full = (await card.locator('.todo-pinned-title').textContent()) ?? ''

  // On the row, right of its title (the time and project side), not on the title's own text
  // nor on the row's own ⋮.
  const kebab = card.getByRole('button', { name: 'More actions' })
  const at = await card.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const t = el.querySelector('.todo-pinned-title')!.getBoundingClientRect()
    const k = el.querySelector('[aria-label="More actions"]')?.getBoundingClientRect()
    const x = Math.max(t.right + 4 - r.left, (k ? k.left : r.right) - r.left - 40)
    return { x, y: t.top + t.height / 2 - r.top }
  })
  const title = card.locator('.todo-pinned-title')
  const cardBefore = await box(card)
  const following = await followingOf(card, 'status-row')
  const tops = following ? await topsOf([following]) : []
  await card.hover({ position: at })
  expect(await page.evaluate(() => !!document.querySelector('.todo-pinned-title:hover'))).toBe(false)
  // The row itself opens wider, at its own top and height; no pill.
  await expectWidensInPlace(card, cardBefore, { label: 'status row' })
  await expect.poll(() => openInRow(title)).toBe(true)
  await expect(title).toHaveText(full)
  if (following) await expectStill([following], tops, 'the status row below')
  await page.screenshot({ path: `${SHOTS}/4-status-row.png`, clip: { x: 0, y: Math.max(0, cardBefore.y - 120), width: 1280, height: 300 } })
  // No native title from the pointer up to the page while it shows, so no dark tooltip opens.
  expect(await titlesAt(page, cardBefore.x + at.x, cardBefore.y + at.y)).toEqual([])

  // The project name filters on click, yet reads as the row's text: the row stays open on it.
  const project = card.getByTestId('row-project-link')
  if (await project.count()) {
    await project.hover()
    expect(await isOpen(title)).toBe(true)
  }

  // On the open row's own ⋮ it stays open (closing would move the button from under the
  // pointer), the button keeps its own label, and a click on it opens the row's real menu.
  if (await kebab.count()) {
    await kebab.hover()
    await page.waitForTimeout(250)
    expect(await isOpen(title)).toBe(true)
    await expect(kebab).toHaveAttribute('title', 'More actions')
    await kebab.click()
    await expect(page.locator('.task-kebab-menu:visible')).toBeVisible()
    await expect(card).toBeVisible()
    const clicked = await box(card)
    expect(Math.abs(clicked.y - cardBefore.y), 'the row is still drawn at its own top').toBeLessThanOrEqual(0.5)
    expect(Math.abs(clicked.height - cardBefore.height), 'and its own height').toBeLessThanOrEqual(0.5)
    await page.keyboard.press('Escape')
    await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  }
  await page.mouse.move(1200, 780)
  await expectRestored(card, cardBefore, 'status row')
  if (following) await expectStill([following], tops, 'the status row below, after')
  await expect(pill(page)).toHaveCount(0)
})
