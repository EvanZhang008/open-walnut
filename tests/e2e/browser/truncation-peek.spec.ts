import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { isolateUiPrefs, showAllSections } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'
import { openInRow, peekPill } from './truncation-peek-helpers'

/**
 * Cut-off text peeks in place (web/src/utils/truncation-peek.ts). A task row expands in place
 * (2026-11-13, the user: "I want the actually the task to expand to a full one"): with a real
 * mouse anywhere on a row whose title is cut off, the row itself grows to the whole title,
 * wrapped in its own width, and the rows below move down; no native title is left above the
 * pointer, so no dark box opens; it closes when the pointer leaves or the list scrolls; a row
 * that fits shows nothing. Text outside a row that a column clips (2026-11-12, "make the full
 * line expanded like what we did for side bar") gets a light pill over it.
 */

const SHOTS = '/tmp/truncation-peek'
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

const WORD = 'Zephyrpeek'
const LONG_A = `${WORD} alpha: Plan the garden shed rebuild, with the lumber list, the paint colours and every weekend step written out in full`
const LONG_B = `${WORD} beta: Write up the sourdough experiments, with the flour ratios, the proofing times and the notes from each bake`
const SHORT = `${WORD} gamma`

const pill = peekPill
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

test('a cut-off Home row expands in place: it grows to its full title, pushes the rows below down, and closes when left', async ({ page, baseURL, request }) => {
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
    const before = (await row(page, LONG_A).boundingBox())!
    const belowBefore = (await row(page, LONG_B).boundingBox())!.y

    const a = await centerOf(page, titleOf(page, LONG_A))
    await page.mouse.move(a.x, a.y)
    // The row itself opens: its title wraps inside the row and shows every word.
    await expect.poll(() => openInRow(titleOf(page, LONG_A))).toBe(true)
    const after = (await row(page, LONG_A).boundingBox())!
    expect(after.height).toBeGreaterThan(before.height + 8)
    // Same place and width: it grows down from its own top, so the pointer stays on it.
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1)
    const t = (await titleOf(page, LONG_A).boundingBox())!
    expect(t.x + t.width).toBeLessThanOrEqual(after.x + after.width + 1)
    // The row below moved down by what it grew; nothing floats over another pane.
    const belowAfter = (await row(page, LONG_B).boundingBox())!.y
    expect(belowAfter - belowBefore).toBeGreaterThan(8)
    await expect(pill(page)).toHaveCount(0)
    // No native title above the pointer, so no dark tooltip.
    expect(await titlesAt(page, a.x, a.y)).toEqual([])
    await page.screenshot({ path: `${SHOTS}/1-home-row.png`, clip: { x: 0, y: Math.max(0, a.y - 160), width: 1280, height: 320 } })

    // Moving down within the grown row keeps it open.
    await page.mouse.move(a.x, after.y + after.height - 6, { steps: 4 })
    await page.waitForTimeout(250)
    expect(await openInRow(titleOf(page, LONG_A))).toBe(true)

    // On to the next cut-off row: it opens and the first closes in the same step.
    const bRow = (await row(page, LONG_B).boundingBox())!
    const onB = { x: bRow.x + 120, y: bRow.y + bRow.height / 2 }
    await page.mouse.move(onB.x, onB.y, { steps: 6 })
    await expect.poll(() => openInRow(titleOf(page, LONG_B))).toBe(true)
    expect(await openInRow(titleOf(page, LONG_A))).toBe(false)

    // A click lands on the open row as it is (it does not close under the press).
    await page.mouse.down()
    expect(await openInRow(titleOf(page, LONG_B))).toBe(true)
    await page.mouse.up()
    // Off the list: every row is back to one line.
    await page.mouse.move(1200, 780)
    await expect.poll(() => openInRow(titleOf(page, LONG_B))).toBe(false)
    await expect.poll(() => openInRow(titleOf(page, LONG_A))).toBe(false)
    expect(Math.abs((await row(page, LONG_A).boundingBox())!.height - before.height)).toBeLessThanOrEqual(1)

    // Back on a row, then a scroll: it closes while the list moves.
    const b = await centerOf(page, titleOf(page, LONG_B))
    await page.mouse.move(b.x, b.y, { steps: 6 })
    await expect.poll(() => openInRow(titleOf(page, LONG_B))).toBe(true)

    // A scroll closes it.
    await page.mouse.wheel(0, 40)
    await expect.poll(() => openInRow(titleOf(page, LONG_B))).toBe(false)

    // A row whose title fits shows nothing.
    await page.mouse.move(1200, 780)
    const s = await centerOf(page, titleOf(page, SHORT))
    const shortBefore = (await row(page, SHORT).boundingBox())!.height
    await page.mouse.move(s.x - (s.box.width / 2) + 10, s.y, { steps: 4 })
    await page.waitForTimeout(300)
    expect((await row(page, SHORT).boundingBox())!.height).toBeCloseTo(shortBefore, 0)
    await expect(pill(page)).toHaveCount(0)

    await page.mouse.move(1200, 780)
    expect(errors).toEqual([])
  } finally {
    for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
  }
})

test('moving down a list: one row open at a time, the rows under the pointer stay put, and a press keeps the row as it is', async ({ page, baseURL, request }) => {
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
    const list = () => rowById(order[0]).evaluate((el) => {
      let l = el.parentElement
      while (l && !(/(auto|scroll)/.test(getComputedStyle(l).overflowY) && l.scrollHeight > l.clientHeight)) l = l.parentElement
      return l ? { top: l.scrollTop, max: l.scrollHeight - l.clientHeight } : null
    })
    const setScroll = (top: number) => rowById(order[0]).evaluate((el, v) => {
      let l = el.parentElement
      while (l && !(/(auto|scroll)/.test(getComputedStyle(l).overflowY) && l.scrollHeight > l.clientHeight)) l = l.parentElement
      if (l) l.scrollTop = v
    }, top)
    const hoverTitle = async (id: string, steps = 1) => {
      const b = (await titleById(id).boundingBox())!
      await page.mouse.move(b.x + Math.min(b.width / 2, 120), b.y + b.height / 2, { steps })
      await expect.poll(() => openInRow(titleById(id))).toBe(true)
    }
    /** From an open row down onto the next: answers how far the next row moved. */
    const downOnto = async (from: string, to: string) => {
      await hoverTitle(from)
      const top = (await rowById(to).boundingBox())!.y
      const extra = (await rowById(from).boundingBox())!.height
      const b = (await rowById(to).boundingBox())!
      const at = { x: b.x + 120, y: b.y + b.height / 2 }
      await page.mouse.move(at.x, at.y, { steps: 6 })
      await expect.poll(() => openInRow(titleById(to))).toBe(true)
      // One row open at a time, and the pointer is still on the row it went to.
      expect(await openInRow(titleById(from))).toBe(false)
      expect(await page.evaluate(([x, y, id]) => !!document.elementFromPoint(x, y)?.closest(`[data-task-id="${id}"]`), [at.x, at.y, to] as const)).toBe(true)
      const moved = top - (await rowById(to).boundingBox())!.y
      expect(moved).toBeLessThanOrEqual(extra)
      return moved
    }

    // A list scrolled down enough scrolls back by what the row above gave back, so the row the
    // pointer went to does not move; at the top of a list it moves up once, by at most that.
    await rowById(order[0]).evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(300)
    const scrolledTo = (await list())?.top ?? 0
    const moved = await downOnto(order[0], order[1])
    if (scrolledTo >= 80) {
      expect(Math.abs(moved)).toBeLessThanOrEqual(1)
      expect((await list())!.top).toBeLessThan(scrolledTo)
    }
    await page.mouse.move(1200, 780)
    await expect.poll(() => openInRow(titleById(order[1]))).toBe(false)

    // And from the top of the list, where it cannot scroll back.
    await setScroll(0)
    await page.waitForTimeout(300)
    const y1 = (await rowById(order[1]).boundingBox())!.y
    if (y1 > 60 && (await rowById(order[2]).boundingBox())!.y < 700) await downOnto(order[1], order[2])
    await page.mouse.move(1200, 780)
    await expect.poll(() => openInRow(titleById(order[2]))).toBe(false)

    await rowById(order[3]).evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(300)
    // A press that moves a little (under a drag's start) keeps the open row as it is.
    await hoverTitle(order[3], 4)
    const box = (await titleById(order[3]).boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 6)
    await page.mouse.down()
    await page.mouse.move(box.x + 23, box.y + 7)
    expect(await openInRow(titleById(order[3]))).toBe(true)
    await page.mouse.up()
    await page.mouse.move(1200, 780)
    await expect.poll(() => openInRow(titleById(order[3]))).toBe(false)
  } finally {
    for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
  }
})

test('text a column clips with no ellipsis peeks too, and a title above it is lifted and put back', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)
  await page.mouse.move(1200, 780)
  await page.evaluate(() => {
    const box = document.createElement('div')
    box.id = 'peek-fixture'
    box.style.cssText = 'position:fixed;left:1100px;top:300px;width:150px;overflow:hidden;white-space:nowrap;z-index:5000;background:var(--bg);font-size:14px'
    box.innerHTML = '<button type="button" title="Open the long line: Working"><span class="clip-line">A line the column cuts off at its edge, with every word of it still to read</span></button>'
    document.body.appendChild(box)
  })
  const line = page.locator('#peek-fixture .clip-line')
  const at = await centerOf(page, line)
  await page.mouse.move(at.x, at.y)
  await expect(pill(page)).toHaveText('A line the column cuts off at its edge, with every word of it still to read')
  const box = (await pill(page).boundingBox())!
  // Near the right edge it moves left to stay in the window.
  expect(box.x + box.width).toBeLessThanOrEqual(1280 - 7)
  expect(await titlesAt(page, at.x, at.y)).toEqual([])
  await page.screenshot({ path: `${SHOTS}/2-clipped-line.png`, clip: { x: 500, y: 240, width: 780, height: 140 } })
  await page.mouse.move(600, 700)
  await expect(pill(page)).toHaveCount(0)
  await expect(page.locator('#peek-fixture button')).toHaveAttribute('title', 'Open the long line: Working')
})

test('a task row expands as a whole: the pointer anywhere on a status row opens it to its full title; on its ⋮ it stays open', async ({ page, baseURL }) => {
  const { presetPanelDesign, setStatusSectionOpen } = await import('./status-section-helpers')
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await openHome(page, baseURL!)
  await showAllSections(page)
  const panel = page.locator('.todo-panel').first()
  await setStatusSectionOpen(panel, 'needs', true)
  await page.mouse.move(1200, 780)
  // A status row of the fixture whose title the row cuts off, on screen.
  const cutId = await expect.poll(() => page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('.status-section-card[data-peek-row]')].find((c) => {
      const t = c.querySelector<HTMLElement>('.todo-pinned-title')
      const r = c.getBoundingClientRect()
      return t && t.scrollWidth > t.clientWidth + 1 && r.top > 60 && r.bottom < innerHeight - 20
    })
    return row?.dataset.taskId ?? ''
  }), { timeout: 20_000 }).not.toBe('').then(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.status-section-card[data-peek-row]')].find((c) => {
    const t = c.querySelector<HTMLElement>('.todo-pinned-title')
    const r = c.getBoundingClientRect()
    return t && t.scrollWidth > t.clientWidth + 1 && r.top > 60 && r.bottom < innerHeight - 20
  })!.dataset.taskId!))
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
  const cardBefore = (await card.boundingBox())!
  await card.hover({ position: at })
  expect(await page.evaluate(() => !!document.querySelector('.todo-pinned-title:hover'))).toBe(false)
  // The row itself opens to its full title, inside its own width; no pill.
  await expect.poll(() => openInRow(title)).toBe(true)
  await expect(title).toHaveText(full)
  await expect(pill(page)).toHaveCount(0)
  const cardBox = (await card.boundingBox())!
  expect(cardBox.height).toBeGreaterThan(cardBefore.height + 8)
  expect(Math.abs(cardBox.y - cardBefore.y)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `${SHOTS}/3-status-row.png`, clip: { x: 0, y: Math.max(0, cardBox.y - 120), width: 1280, height: 300 } })
  // No native title from the pointer up to the page while it shows, so no dark tooltip opens.
  expect(await titlesAt(page, cardBefore.x + at.x, cardBefore.y + at.y)).toEqual([])

  // The project name filters on click, yet reads as the row's text: the row still expands on it.
  const project = card.getByTestId('row-project-link')
  if (await project.count()) {
    await project.hover()
    expect(await openInRow(title)).toBe(true)
  }

  // On the open row's own ⋮ it stays open (closing would move the button from under the
  // pointer), and the button keeps its own label.
  if (await kebab.count()) {
    await kebab.hover()
    await page.waitForTimeout(250)
    expect(await openInRow(title)).toBe(true)
    await expect(kebab).toHaveAttribute('title', 'More actions')
  }
  await page.mouse.move(1200, 780)
  await expect.poll(() => openInRow(title)).toBe(false)
  await expect(pill(page)).toHaveCount(0)
})
