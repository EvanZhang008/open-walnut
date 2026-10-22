import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/task-row-wrap'
const tasks: string[] = []

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

async function create(title: string, fields: Record<string, unknown> = {}) {
  const response = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, source: 'local', pinned: false, ...fields }),
  })
  expect(response.ok).toBe(true)
  const { task } = await response.json()
  tasks.push(task.id)
  return task.id as string
}

const row = (page: Page, id: string) => page.locator(`.todo-panel-item[data-task-id="${id}"]`).first()

async function layout(host: Locator) {
  return host.locator('.todo-item-title-row').evaluate((el) => {
    const title = el.querySelector('.todo-item-title')!.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const bounds = (selector: string) => [...el.querySelectorAll(selector)].map((node) => {
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    })
    return {
      title: { x: title.x, y: title.y, width: title.width, bottom: title.bottom },
      pills: bounds('.task-tag-pills > .tag-chip, .todo-item-due-pill, .task-row-pill'),
      actions: bounds('.task-phase-icon-btn, .task-start-btn, .task-kebab-btn'),
      overflow: [...el.querySelectorAll('.task-tag-pills > .tag-chip, .todo-item-due-pill, .task-row-pill, .task-kebab-btn')]
        .some((node) => { const r = node.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1 }),
    }
  })
}

async function width(page: Page, value: number) {
  await page.locator('#home-task-navigation').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px` }, value)
  await expect.poll(async () => (await page.locator('#home-task-navigation').boundingBox())!.width).toBeCloseTo(value, 0)
}

test.beforeEach(async ({ page }) => {
  tasks.length = 0
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
})

test.afterEach(async () => {
  for (const id of [...tasks].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' })
})

test('crowded rows wrap metadata without squeezing titles or moving actions', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  const stamp = Date.now().toString(36)
  const title = `Review scheduled report delivery and its recovery ${stamp}`
  const dense = await create(title, { tags: ['report:https://example.com/reports/delivery', 'sev:2', 'label:scheduled'], due_date: '2030-12-31' })
  const plain = await create(`Plain task ${stamp}`)
  const short = await create(`Check ${stamp}`, { tags: ['sev:2'] })
  const unicode = await create(`Mixed ${String.fromCodePoint(0x4efb, 0x52a1)} title ${stamp}`, { tags: [`label:${'a'.repeat(160)}`, 'sev:2'] })
  let scrollTarget = ''
  for (let i = 0; i < 36; i++) {
    const id = await create(`Scheduled delivery check ${i} ${stamp}`, { tags: ['ticket:V2000000001', 'sev:2'], due_date: '2030-12-31' })
    if (i === 4) scrollTarget = id
  }
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('walnut-todo-groupBy', 'none') })
  await openHome(page, `${API}/`)
  const search = page.locator('.todo-search-input')
  await search.fill(stamp)
  await expect(row(page, dense)).toBeVisible({ timeout: 30_000 })
  await fs.mkdir(SHOTS, { recursive: true })
  await width(page, 306)
  await page.locator('#home-task-navigation').screenshot({ path: `${SHOTS}/${browserName}-initial.png` })

  for (const size of [306, 220, 640, 306, 640, 306]) {
    await width(page, size)
    await expect.poll(async () => {
      const box = await layout(row(page, dense))
      return size < 400 ? box.pills[0].y >= box.title.bottom : Math.abs(box.pills[0].y - box.title.y) < 5
    }, { message: `metadata wraps only when needed at ${size}px` }).toBe(true)
    for (const id of [dense, plain, short, unicode]) {
      const box = await layout(row(page, id))
      expect(box.overflow, `no clipped or overflowing metadata at ${size}px`).toBe(false)
      for (const action of box.actions) expect(Math.abs(action.y + action.height / 2 - box.title.y - 9)).toBeLessThan(5)
    }
    const box = await layout(row(page, dense))
    const plainBox = await layout(row(page, plain))
    if (size < 400) expect(box.title.width).toBeGreaterThanOrEqual(plainBox.title.width - 2)
    const shortBox = await layout(row(page, short))
    if (size >= 306) expect(Math.abs(shortBox.pills[0].y - shortBox.title.y), 'a short title and tag stay on one line').toBeLessThan(5)
    await row(page, dense).scrollIntoViewIfNeeded()
    await expect(row(page, dense)).toBeInViewport()
    await row(page, dense).hover()
    await row(page, dense).screenshot({ path: `${SHOTS}/${browserName}-dense-${size}.png` })
    await page.locator('#home-task-navigation').screenshot({ path: `${SHOTS}/${browserName}-${size}.png` })
  }

  const scroller = page.locator('.home-navigation-scroll')
  for (let i = 0; i < 3; i++) {
    await scroller.hover()
    await page.mouse.wheel(0, 500)
    await row(page, scrollTarget).scrollIntoViewIfNeeded()
    await expect(row(page, scrollTarget)).toBeInViewport()
    const before = await row(page, scrollTarget).boundingBox()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const after = await row(page, scrollTarget).boundingBox()
    expect(Math.abs(after!.y - before!.y), 'the target stays put after layout settles').toBeLessThan(2)
    await row(page, dense).scrollIntoViewIfNeeded()
    await expect(row(page, dense)).toBeInViewport()
  }
  await row(page, dense).getByRole('button', { name: 'More actions' }).click()
  await expect(page.locator('.task-kebab-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await fetch(`${API}/api/tasks/${plain}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ add_tags: ['ticket:V2000000001', 'sev:2'] }),
  })
  await expect(row(page, plain).getByTestId('task-tag-pills')).toBeVisible()
  await expect.poll(async () => (await layout(row(page, plain))).overflow).toBe(false)
  await search.fill('')
  await search.fill(stamp)
  await expect(row(page, dense)).toBeVisible()
  await expect.poll(async () => (await layout(row(page, dense))).pills[0].y >= (await layout(row(page, dense))).title.bottom).toBe(true)
  expect(errors).toEqual([])
})
