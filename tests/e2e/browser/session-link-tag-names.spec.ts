/**
 * Link tags in the session header read a NAME, never just their kind (src/core/link-tags.ts):
 *   - three plans that each read "plan" before (2026-10-25, the user: "plan +2 ... so confused")
 *     read "Test matrix r5" (the name the session gave), "Fix plan r5b" and "Fix plan r5c"
 *     (made from the file names), a pull request its id, each after its kind's icon;
 *   - the hover card names the link, its kind and its whole path, and where a click goes;
 *   - a click on a file opens it in Files; a file that is gone (cleaned from a temp dir) draws
 *     no pill and counts as no label, a task whose links are all gone draws no labels control,
 *     and a file that comes back brings its pill back (2026-10-26, the user: "if a file is
 *     removed please don't show the tag");
 *   - the header folds the link tags into ONE control beside the title (2026-11-02,
 *     SessionHeaderLabels.tsx; the state pills stay on the row): its flyout lists every link
 *     whole, 20px, uncut (2026-10-25, "it somehow get cropped out"), and the title keeps its
 *     room, in a wide and a narrow column (narrow: the control goes to a line under the title).
 *
 * The fixture task `pw-task-links` (test-server.ts) holds the tags; its two existing files are
 * written by the fixture, the third never is. `pw-task-links-gone-<browser>` links only files
 * that do not exist; its test writes one and removes it again.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { closeHeaderLabels, expectHeaderLabel, headerLabelsButton, openHeaderLabels, openLabelsFlyout } from './session-header-labels-helpers'

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

/** The pill's box is inside every ancestor that clips, up to the panel (or the body, for the labels flyout). */
async function clippedBy(pill: Locator): Promise<string[]> {
  return pill.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const out: string[] = []
    for (let a = el.parentElement; a && a !== document.body && !a.classList.contains('session-panel'); a = a.parentElement) {
      const cs = getComputedStyle(a)
      // A `display: contents` box draws nothing, so its overflow clips nothing (the labels
      // flyout lays the tag group's pills straight into its own row this way).
      if (cs.display === 'contents' || (cs.overflowX === 'visible' && cs.overflowY === 'visible')) continue
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

test('each link pill reads a name after its icon, and the labels flyout shows each one whole', async ({ page, browserName }) => {
  // A full app boot plus the labels flyout: 30 s ran out on a loaded machine.
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  const panel = await openSession(page)
  // The labels control sits on the right, after the title (2026-10-26, "should be on the
  // right"), and names the links; the gone plan is no label.
  await expectHeaderLabel(panel, 'Test matrix r5')
  const button = headerLabelsButton(panel)
  await expect(button.locator('.session-header-labels-count')).toHaveText('3')
  await expect(button).not.toHaveAttribute('title', /Fix plan r5c/)
  const row = await panel.locator('.session-panel-header-top').boundingBox()
  const btnBox = await button.boundingBox()
  expect(btnBox!.x).toBeGreaterThan(row!.x + row!.width / 2)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-header.png` })

  // The flyout: every link, its name after its kind's icon; no "+N" (it holds them all).
  await openHeaderLabels(panel)
  const labels = openLabelsFlyout(panel)
  const links = labels.locator('.tag-chip-link-tag')
  await expect(links.locator('.tag-chip-value')).toHaveText(['Test matrix r5', 'Fix plan r5b', 'app#12'])
  const head = links.first()
  await expect(head.locator('svg.tag-chip-icon')).toHaveAttribute('data-kind-group', 'doc')
  await expect(labels.locator('svg.tag-chip-icon[data-kind-group="review"]')).toHaveCount(1)
  await expect(labels.locator('[data-testid="tag-pills-more"]')).toHaveCount(0)
  await expect(page.getByText('Fix plan r5c')).toHaveCount(0)
  // 20px, whole: no ancestor up to the flyout cuts any pill.
  for (const pill of await links.all()) {
    const box = await pill.boundingBox()
    expect(Math.round(box!.height)).toBe(20)
    expect(await clippedBy(pill)).toEqual([])
  }
  await labels.screenshot({ path: `${SHOT_DIR}/${browserName}-labels.png` })

  // Hover: name, kind, the whole path, where a click goes.
  await head.hover()
  const card = page.getByTestId('link-hover-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.link-hover-card-name')).toHaveText('Test matrix r5')
  await expect(card.locator('.link-hover-card-kind')).toHaveText('plan')
  await expect(card.locator('.link-hover-card-target')).toHaveText(/\/link-fixture\/fix\/MATRIX-r5\.md$/)
  await expect(card.locator('.link-hover-card-opens')).toHaveText('Opens in Files')
  await page.mouse.move(0, 0)

  // A live one opens in Files (read outside the labels flyout, which holds the pill's own name).
  await head.click()
  const app = page.locator('body > :not([data-testid="session-header-labels-flyout"])')
  await expect(app.getByText('Test matrix r5', { exact: false }).last()).toBeVisible({ timeout: 15_000 })
  expect(errors).toEqual([])
})

test('a narrow column keeps the labels control in the header and every pill whole in its flyout', async ({ page, browserName }) => {
  // A full app boot plus the labels flyout: 30 s ran out on a loaded machine.
  test.setTimeout(60_000)
  // Just above the phone layout (769px): the narrowest desktop session column.
  await page.setViewportSize({ width: 900, height: 700 })
  const panel = await openSession(page)
  const button = headerLabelsButton(panel)
  await expectHeaderLabel(panel, 'Test matrix r5')
  const head = await button.boundingBox()
  const header = await panel.locator('.session-panel-header').boundingBox()
  expect(head!.x + head!.width).toBeLessThanOrEqual(header!.x + header!.width + 1)
  // On the right, after the title, and the title keeps room for its text.
  const title = await panel.locator('.session-panel-header-top .session-panel-title').boundingBox()
  expect(head!.x).toBeGreaterThanOrEqual(title!.x + title!.width - 1)
  expect(title!.width).toBeGreaterThanOrEqual(48)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-narrow-header.png` })
  await openHeaderLabels(panel)
  const labels = openLabelsFlyout(panel)
  const flyout = (await labels.boundingBox())!
  expect(flyout.x).toBeGreaterThanOrEqual(0)
  expect(flyout.x + flyout.width).toBeLessThanOrEqual(900)
  for (const pill of await labels.locator('.tag-chip-link-tag').all()) expect(await clippedBy(pill)).toEqual([])
  await closeHeaderLabels(panel)
})

test('a narrower column never squeezes the title out, and the links stay one click away', async ({ page, browserName }) => {
  // A full app boot plus the labels flyout: 30 s ran out on a loaded machine.
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  const panel = await openSession(page)
  const button = headerLabelsButton(panel)
  await expectHeaderLabel(panel, 'Test matrix r5')
  await fs.mkdir(SHOT_DIR, { recursive: true })
  for (const width of [560, 420, 340, 260, 200]) {
    // Narrow the column's width only. The panel sits in a column-direction flex box, where a
    // flex basis is its HEIGHT: `flex: 0 0 200px` crushed the panel to 200px tall, and once a
    // narrow row put the labels on a line under the title the composer covered that line.
    await panel.evaluate((el, w) => {
      const box = el as HTMLElement
      const parent = box.parentElement ? getComputedStyle(box.parentElement) : null
      const row = parent?.display.includes('flex') && parent.flexDirection.startsWith('row')
      if (row) box.style.flex = `0 0 ${w}px`
      box.style.width = `${w}px`
    }, width)
    await page.waitForTimeout(400)
    const state = await panel.evaluate((el) => {
      const row = el.querySelector('.session-panel-header-top')!.getBoundingClientRect()
      const title = el.querySelector('.session-panel-header-top .session-panel-title')!
      const m = el.querySelector('.session-panel-title-meta') as HTMLElement
      const btn = m.querySelector('[data-testid="session-header-labels"]') as HTMLElement | null
      const t = title.getBoundingClientRect()
      return {
        titleWidth: t.width, titleNatural: (title as HTMLElement).scrollWidth,
        btnLeft: btn ? btn.getBoundingClientRect().left : null, titleRight: t.right,
        btnTop: btn ? btn.getBoundingClientRect().top : null, titleBottom: t.bottom,
        tight: el.querySelector('.session-panel-header-top')!.getAttribute('data-header-fit') === 'tight',
        metaRight: m.getBoundingClientRect().right, rowRight: row.right,
      }
    })
    expect(state.titleWidth, `${width}px: the title keeps its room`).toBeGreaterThanOrEqual(Math.min(48, state.titleNatural) - 1)
    expect(state.metaRight, `${width}px: nothing leaves the row`).toBeLessThanOrEqual(state.rowRight + 1)
    expect(state.btnLeft, `${width}px: the labels control stays on the row`).not.toBeNull()
    // A wide row keeps the control right of the title; a narrow one (data-header-fit="tight")
    // puts it on a line under the title (2026-11-04, the user: "maybe we shoud make the
    // lable another line if the space is narrow"). Either way it never covers the title.
    if (state.tight) expect(state.btnTop!, `${width}px: the labels control sits on the line under the title`).toBeGreaterThanOrEqual(state.titleBottom - 1)
    else expect(state.btnLeft!, `${width}px: the labels control stays right of the title`).toBeGreaterThanOrEqual(state.titleRight - 1)
    await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-column-${width}.png` })
  }
  // The labels never fold away: at the narrowest the flyout still names the link whole.
  await expect(button).toHaveAttribute('title', /Test matrix r5/)
  await openHeaderLabels(panel)
  const labels = openLabelsFlyout(panel)
  await expect(labels.locator('.tag-chip-link-tag .tag-chip-value').first()).toHaveText('Test matrix r5')
  await expect(labels.locator('.tag-chip-link-tag .tag-chip-value').first()).toBeVisible()
  await closeHeaderLabels(panel)
})

test('a task whose links are all gone draws no labels, and a file that comes back brings its pill back', async ({ page, request, browserName }) => {
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
  // No label at all: the header draws no labels control.
  const button = headerLabelsButton(panel)
  await expect(button).toHaveCount(0)

  // The header asks again when the window comes back (and every minute while it is visible).
  const comeBack = async () => {
    await page.waitForTimeout(5_500)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  }
  try {
    await fs.writeFile(plan, '# Gone a\n')
    await comeBack()
    await expect(button).toBeVisible()
    // The other link is still gone: one label.
    await expect(button.locator('.session-header-labels-count')).toHaveText('1')
    await openHeaderLabels(panel)
    const labels = openLabelsFlyout(panel)
    const pills = labels.locator('.tag-chip-link-tag')
    await expect(pills).toHaveCount(1)
    await expect(pills.locator('svg.tag-chip-icon')).toHaveAttribute('data-kind-group', 'doc')
    await expect(labels.locator('[data-testid="tag-pills-more"]')).toHaveCount(0)
    await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-file-back.png` })
    await closeHeaderLabels(panel)
  } finally {
    await fs.rm(plan, { force: true })
  }
  await comeBack()
  await expect(button).toHaveCount(0)
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
