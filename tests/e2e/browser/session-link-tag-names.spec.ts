/**
 * Link tags in the session header read a NAME, never just their kind (src/core/link-tags.ts):
 *   - three plans that each read "plan" before (2026-10-25, the user: "plan +2 ... so confused")
 *     read "Test matrix r5" (the name the session gave), "Fix plan r5b" and "Fix plan r5c"
 *     (made from the file names), a pull request its id, each after its kind's icon;
 *   - the hover card names the link, its kind and its whole path, and where a click goes;
 *   - a click on a file opens it in Files; a file that is gone (cleaned from a temp dir) draws
 *     no pill and counts in no "+N", a task whose links are all gone draws no tag, and a file
 *     that comes back brings its pill back (2026-10-26, the user: "if a file is removed please
 *     don't show the tag");
 *   - the header pill is never cut by the title row (2026-10-25, "it somehow get cropped out":
 *     the tag row's 16px overflow box clipped the 20px header pill), in a wide and a narrow column.
 *
 * The fixture task `pw-task-links` (test-server.ts) holds the tags; its two existing files are
 * written by the fixture, the third never is. `pw-task-links-gone-<browser>` links only files
 * that do not exist; its test writes one and removes it again.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const SHOT_DIR = '/tmp/session-link-tag-names'
const TASK = 'pw-task-links'
const SESSION = 'pw-links-session'

async function openSession(page: Page, task = TASK, session = SESSION, title = 'Linked plans fixture'): Promise<Locator> {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  await page.locator('.todo-search-input').fill(title)
  const row = page.locator(`.todo-panel-item[data-task-id="${task}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${session}"]`)
  await expect(panel).toBeVisible()
  return panel
}

/** The pill's box is inside every ancestor that clips, up to the header. */
async function clippedBy(pill: Locator): Promise<string[]> {
  return pill.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const out: string[] = []
    for (let a = el.parentElement; a && !a.classList.contains('session-panel'); a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const r = a.getBoundingClientRect()
      if (box.top < r.top - 0.5 || box.bottom > r.bottom + 0.5 || box.left < r.left - 0.5 || box.right > r.right + 0.5) {
        out.push(`${a.className} (${Math.round(r.top)}..${Math.round(r.bottom)} vs pill ${Math.round(box.top)}..${Math.round(box.bottom)})`)
      }
    }
    return out
  })
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test('each link pill reads a name after its icon, and the header pill is never cut', async ({ page, browserName }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  const panel = await openSession(page)
  const group = panel.locator('.session-panel-title-meta > .session-panel-tag-pills .tag-pill-group')
  const head = group.locator('.tag-chip-link-tag')
  await expect(head.locator('.tag-chip-value')).toHaveText('Test matrix r5')
  await expect(head.locator('svg.tag-chip-icon')).toHaveAttribute('data-kind-group', 'doc')
  // On the right with the status pills, not beside the title (2026-10-26, "should be on the right").
  const row = await panel.locator('.session-panel-header-top').boundingBox()
  const tagBox = await group.boundingBox()
  expect(tagBox!.x).toBeGreaterThan(row!.x + row!.width / 2)
  // The gone plan counts in no "+N".
  await expect(group.locator('[data-testid="tag-pills-more"]')).toHaveText('+2')
  // 20px, whole: no ancestor up to the panel cuts it.
  const box = await head.boundingBox()
  expect(Math.round(box!.height)).toBe(20)
  expect(await clippedBy(group)).toEqual([])
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-header.png` })

  // Hover: name, kind, the whole path, where a click goes.
  await head.hover()
  const card = page.getByTestId('link-hover-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.link-hover-card-name')).toHaveText('Test matrix r5')
  await expect(card.locator('.link-hover-card-kind')).toHaveText('plan')
  await expect(card.locator('.link-hover-card-target')).toHaveText(/\/link-fixture\/fix\/MATRIX-r5\.md$/)
  await expect(card.locator('.link-hover-card-opens')).toHaveText('Opens in Files')
  await page.mouse.move(0, 0)

  // The rest: distinct names; the gone file is not there at all.
  await group.locator('[data-testid="tag-pills-more"]').click()
  const menu = page.getByTestId('tag-pills-menu')
  await expect(menu.locator('.tag-chip-value')).toHaveText(['Fix plan r5b', 'app#12'])
  await expect(menu.locator('svg.tag-chip-icon[data-kind-group="review"]')).toHaveCount(1)
  await expect(page.getByText('Fix plan r5c')).toHaveCount(0)
  await menu.screenshot({ path: `${SHOT_DIR}/${browserName}-menu.png` })
  await page.keyboard.press('Escape')

  // A live one opens in Files.
  await head.click()
  await expect(page.getByText('Test matrix r5', { exact: false }).last()).toBeVisible({ timeout: 15_000 })
  expect(errors).toEqual([])
})

test('a narrow column keeps the header pill whole', async ({ page, browserName }) => {
  // Just above the phone layout (769px): the narrowest desktop session column.
  await page.setViewportSize({ width: 900, height: 700 })
  const panel = await openSession(page)
  const group = panel.locator('.session-panel-title-meta > .session-panel-tag-pills .tag-pill-group')
  await expect(group).toBeVisible()
  expect(await clippedBy(group)).toEqual([])
  const head = await group.boundingBox()
  const header = await panel.locator('.session-panel-header').boundingBox()
  expect(head!.x + head!.width).toBeLessThanOrEqual(header!.x + header!.width + 1)
  // On the right, after the title, and the title keeps room for its text (TITLE_FLOOR_WIDTH).
  const title = await panel.locator('.session-panel-header-top .session-panel-title').boundingBox()
  expect(head!.x).toBeGreaterThanOrEqual(title!.x + title!.width - 1)
  expect(title!.width).toBeGreaterThanOrEqual(48)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-narrow-header.png` })
})

test('a narrower column folds the tag with the status pills and never squeezes the title out', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const panel = await openSession(page)
  const meta = panel.locator('.session-panel-header-top > .session-panel-title-meta')
  const tags = meta.locator('> .session-panel-tag-pills')
  await expect(tags.locator('.tag-chip-link-tag .tag-chip-value')).toHaveText('Test matrix r5')
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const forms: string[] = []
  for (const width of [560, 420, 340, 260, 200]) {
    await panel.evaluate((el, w) => { (el as HTMLElement).style.flex = `0 0 ${w}px`; (el as HTMLElement).style.width = `${w}px` }, width)
    await page.waitForTimeout(400)
    const state = await panel.evaluate((el) => {
      const row = el.querySelector('.session-panel-header-top')!.getBoundingClientRect()
      const title = el.querySelector('.session-panel-header-top .session-panel-title')!
      const m = el.querySelector('.session-panel-title-meta') as HTMLElement
      const tag = m.querySelector(':scope > .session-panel-tag-pills') as HTMLElement | null
      const value = tag?.querySelector('.tag-chip-link-tag .tag-chip-value') as HTMLElement | null
      const shown = !!tag && getComputedStyle(tag).display !== 'none'
      const t = title.getBoundingClientRect()
      return {
        titleWidth: t.width, titleNatural: (title as HTMLElement).scrollWidth,
        form: !shown ? 'menu' : value && getComputedStyle(value).display === 'none' ? 'icon' : 'name',
        tagLeft: shown ? tag!.getBoundingClientRect().left : null, titleRight: t.right,
        metaRight: m.getBoundingClientRect().right, rowRight: row.right,
      }
    })
    forms.push(state.form)
    expect(state.titleWidth, `${width}px: the title keeps its room`).toBeGreaterThanOrEqual(Math.min(48, state.titleNatural) - 1)
    expect(state.metaRight, `${width}px: nothing leaves the row`).toBeLessThanOrEqual(state.rowRight + 1)
    if (state.tagLeft !== null) expect(state.tagLeft, `${width}px: the tag stays right of the title`).toBeGreaterThanOrEqual(state.titleRight - 1)
    await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-column-${width}.png` })
  }
  // It folds in order (name, then icon and "+N", then the menu) and never comes back wider.
  const rank = { name: 0, icon: 1, menu: 2 } as Record<string, number>
  for (let i = 1; i < forms.length; i++) expect(rank[forms[i]]).toBeGreaterThanOrEqual(rank[forms[i - 1]])
  expect(forms[0]).toBe('name')
  expect(forms.at(-1)).not.toBe('name')
  if (forms.at(-1) === 'menu') {
    await panel.locator('.session-panel-title-meta .task-kebab-btn').click()
    const row = page.getByTestId('session-header-kebab-pill-tag')
    await expect(row).toContainText('Links')
    await row.click()
    await expect(page.getByTestId('tag-pills-menu')).toBeVisible()
    await page.keyboard.press('Escape')
  }
})

test('a task whose links are all gone draws no tag, and a file that comes back brings its pill back', async ({ page, request, browserName }) => {
  // Two 5.5s waits for the window-back recheck on top of opening the session.
  test.setTimeout(75_000)
  // One task per browser (test-server.ts): this test writes one of its files and removes it again.
  const task = `pw-task-links-gone-${browserName}`
  const detail = await (await request.get(`/api/v1/tasks/${task}`)).json() as { task: { links: { kind: string; target: string }[] } }
  const plan = detail.task.links.find((l) => l.kind === 'plan')!.target
  await fs.rm(plan, { force: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  const checked = page.waitForResponse((res) => res.url().includes('/api/files/exists') && res.request().postData()?.includes(`GONE-a-${browserName}`) === true, { timeout: 20_000 })
  const panel = await openSession(page, task, `pw-links-gone-session-${browserName}`, `Gone links fixture task ${browserName}`)
  await expect(panel.locator('.session-panel-header')).toBeVisible()
  // The check has its answer (both gone), and nothing has appeared.
  const { exists } = await (await checked).json() as { exists: Record<string, boolean> }
  expect(Object.values(exists)).toEqual([false, false])
  await page.waitForTimeout(500)
  const pills = panel.locator('.session-panel-title-meta > .session-panel-tag-pills .tag-chip-link-tag')
  await expect(pills).toHaveCount(0)
  await expect(panel.locator('[data-testid="task-tag-pills"]')).toHaveCount(0)

  // The header asks again when the window comes back (and every minute while it is visible).
  const comeBack = async () => {
    await page.waitForTimeout(5_500)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  }
  try {
    await fs.writeFile(plan, '# Gone a\n')
    await comeBack()
    await expect(pills).toHaveCount(1)
    await expect(pills.locator('svg.tag-chip-icon')).toHaveAttribute('data-kind-group', 'doc')
    // The other link is still gone: no "+N".
    await expect(panel.locator('[data-testid="tag-pills-more"]')).toHaveCount(0)
    await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-file-back.png` })
  } finally {
    await fs.rm(plan, { force: true })
  }
  await comeBack()
  await expect(pills).toHaveCount(0)
})

test('the task detail serves the names for the phone', async ({ request }) => {
  const res = await request.get(`/api/v1/tasks/${TASK}`)
  expect(res.ok()).toBe(true)
  const { task } = await res.json() as { task: { links?: { name: string; group: string; file: boolean; gone?: boolean }[] } }
  expect(task.links?.map((l) => [l.name, l.group, l.file, l.gone === true])).toEqual([
    ['Test matrix r5', 'doc', true, false],
    ['Fix plan r5b', 'doc', true, false],
    ['Fix plan r5c', 'doc', true, true],
    ['app#12', 'review', false, false],
  ])
})
