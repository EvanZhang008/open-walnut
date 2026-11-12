import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { isolateUiPrefs, showAllSections } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

/**
 * Cut-off text peeks in place (web/src/utils/truncation-peek.ts; 2026-11-12, the user, of a
 * Home row's dark native tooltip: "I want it to actually make the full line expanded like
 * what we did for side bar"). With a real mouse: hovering a Home row whose title is cut off
 * lays a light pill with the whole title over that title, on the same spot, grown over the
 * neighbours; no native title is left anywhere above it, so no dark box opens; the pill stays
 * in the window and takes no clicks (the row below it still gets them); the next cut-off row
 * takes it at once; a row that fits shows nothing; leaving puts every title back. Text a
 * column clips without an ellipsis (the Org list's lines) peeks the same way.
 */

const SHOTS = '/tmp/truncation-peek'
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

const WORD = 'Zephyrpeek'
const LONG_A = `${WORD} alpha: Plan the garden shed rebuild, with the lumber list, the paint colours and every weekend step written out in full`
const LONG_B = `${WORD} beta: Write up the sourdough experiments, with the flour ratios, the proofing times and the notes from each bake`
const SHORT = `${WORD} gamma`

const pill = (page: Page) => page.getByTestId('truncation-peek')
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

test('a cut-off Home row grows its full title in place, takes no clicks, and leaves no native tooltip', async ({ page, baseURL, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const made = [await createTask(request, LONG_A), await createTask(request, LONG_B), await createTask(request, SHORT)]
  try {
    await isolateUiPrefs(page)
    await openHome(page, baseURL!)
    await showAllSections(page)
    for (const t of [LONG_A, LONG_B, SHORT]) await expect(row(page, t)).toBeVisible({ timeout: 20_000 })
    await page.mouse.move(1200, 780)

    // The row's own title is cut off: the page shows less than the text.
    const cut = await titleOf(page, LONG_A).evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(cut).toBe(true)

    const a = await centerOf(page, titleOf(page, LONG_A))
    await page.mouse.move(a.x, a.y)
    await expect(pill(page)).toHaveCount(1)
    await expect(pill(page)).toHaveText(LONG_A)
    await pill(page).evaluate((el) => Promise.all(el.getAnimations().map((x) => x.finished.catch(() => undefined))))
    await page.screenshot({ path: `${SHOTS}/1-home-row.png`, clip: { x: 0, y: Math.max(0, a.y - 160), width: 1280, height: 320 } })

    // On the same spot: the pill's text starts where the row's text starts.
    const textLeft = await titleOf(page, LONG_A).evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().left })
    const pillBox = (await pill(page).boundingBox())!
    expect(Math.abs(pillBox.x + 6 - textLeft)).toBeLessThanOrEqual(1.5)
    expect(Math.abs(pillBox.y + 2 - a.box.y)).toBeLessThanOrEqual(3)
    // Grown past the row's cut, inside the window.
    expect(pillBox.width).toBeGreaterThan(a.box.width + 20)
    expect(pillBox.x).toBeGreaterThanOrEqual(0)
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(1280)
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(800)
    // One line, like the side bar's pill: the row below stays uncovered.
    const nextTop = (await titleOf(page, LONG_B).boundingBox())!.y
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(nextTop + 1)
    // No native title above the pointer, so no dark tooltip.
    expect(await titlesAt(page, a.x, a.y)).toEqual([])

    // It takes no pointer: the point under it is the page's own element.
    const under = await page.evaluate(([x, y]) => !document.elementFromPoint(x, y)?.closest('.truncation-peek'), [pillBox.x + pillBox.width - 10, pillBox.y + pillBox.height / 2] as const)
    expect(under).toBe(true)

    // The next cut-off row takes the pill at once.
    const b = await centerOf(page, titleOf(page, LONG_B))
    await page.mouse.move(b.x, b.y, { steps: 4 })
    await expect(pill(page)).toHaveText(LONG_B)
    await expect(pill(page)).toHaveCount(1)

    // A row whose title fits shows nothing.
    const s = await centerOf(page, titleOf(page, SHORT))
    await page.mouse.move(s.x - (s.box.width / 2) + 10, s.y, { steps: 4 })
    await expect(pill(page)).toHaveCount(0)

    // A click goes to the row under the pointer, pill or no pill.
    await page.mouse.move(a.x, a.y, { steps: 4 })
    await expect(pill(page)).toHaveCount(1)
    await page.mouse.down()
    await expect(pill(page)).toHaveCount(0)
    await page.mouse.up()

    // Leaving puts every title back where it was.
    await page.mouse.move(1200, 780)
    await expect(pill(page)).toHaveCount(0)
    expect(errors).toEqual([])
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

test('a task row expands as a whole: the pointer anywhere on a status row shows its cut title; its own ⋮ stays quiet', async ({ page, baseURL }) => {
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
  await card.hover({ position: at })
  expect(await page.evaluate(() => !!document.querySelector('.todo-pinned-title:hover'))).toBe(false)
  await expect(pill(page)).toHaveCount(1)
  await expect(pill(page)).toHaveText(full)
  await pill(page).evaluate((el) => Promise.all(el.getAnimations().map((x) => x.finished.catch(() => undefined))))
  const box = (await pill(page).boundingBox())!
  await page.screenshot({ path: `${SHOTS}/3-status-row.png`, clip: { x: 0, y: Math.max(0, box.y - 120), width: 1280, height: 260 } })
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(1280)
  // No native title from the pointer up to the page while it shows, so no dark tooltip opens.
  const cardBox = (await card.boundingBox())!
  expect(await titlesAt(page, cardBox.x + at.x, cardBox.y + at.y)).toEqual([])

  // The row's own ⋮ shows itself: over it there is no pill, and its title is back.
  if (await kebab.count()) {
    await kebab.hover()
    await expect(pill(page)).toHaveCount(0)
    await expect(kebab).toHaveAttribute('title', 'More actions')
  }
  await page.mouse.move(1200, 780)
  await expect(pill(page)).toHaveCount(0)
})
