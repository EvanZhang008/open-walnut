/**
 * Link tags in the session header read a NAME, never just their kind (src/core/link-tags.ts):
 *   - three plans that each read "plan" before (2026-10-25, the user: "plan +2 ... so confused")
 *     read "Test matrix r5" (the name the session gave), "Fix plan r5b" and "Fix plan r5c"
 *     (made from the file names), a pull request its id, each after its kind's icon;
 *   - the hover card names the link, its kind and its whole path, and where a click goes;
 *   - a click on a file opens it in Files; a file that is gone (cleaned from a temp dir) is
 *     struck through, listed last, and opens nothing;
 *   - the header pill is never cut by the title row (2026-10-25, "it somehow get cropped out":
 *     the tag row's 16px overflow box clipped the 20px header pill), in a wide and a narrow column.
 *
 * The fixture task `pw-task-links` (test-server.ts) holds the tags; its two existing files are
 * written by the fixture, the third never is.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const SHOT_DIR = '/tmp/session-link-tag-names'
const TASK = 'pw-task-links'
const SESSION = 'pw-links-session'

async function openSession(page: Page): Promise<Locator> {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  await page.locator('.todo-search-input').fill('Linked plans fixture')
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION}"]`)
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
  const group = panel.locator('.session-panel-title-area > .session-panel-tag-pills .tag-pill-group')
  const head = group.locator('.tag-chip-link-tag')
  await expect(head.locator('.tag-chip-value')).toHaveText('Test matrix r5')
  await expect(head.locator('svg.tag-chip-icon')).toHaveAttribute('data-kind-group', 'doc')
  await expect(group.locator('[data-testid="tag-pills-more"]')).toHaveText('+3')
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

  // The rest: distinct names, the gone file last and struck through.
  await group.locator('[data-testid="tag-pills-more"]').click()
  const menu = page.getByTestId('tag-pills-menu')
  const rows = menu.locator('.tag-chip-value')
  await expect(rows).toHaveText(['Fix plan r5b', 'app#12', 'Fix plan r5c'])
  const gone = menu.locator('.tag-chip-gone')
  await expect(gone).toHaveCount(1)
  await expect(gone.locator('.tag-chip-value')).toHaveText('Fix plan r5c')
  expect(await gone.locator('.tag-chip-value').evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('line-through')
  await expect(menu.locator('svg.tag-chip-icon[data-kind-group="review"]')).toHaveCount(1)
  await menu.screenshot({ path: `${SHOT_DIR}/${browserName}-menu.png` })
  await gone.hover()
  await expect(card.locator('.link-hover-card-opens')).toHaveText('This file no longer exists')
  // A gone file opens nothing.
  await gone.click()
  await expect(panel.locator('.session-panel-header')).toBeVisible()
  await expect(page.getByText('# Fix plan r5c')).toHaveCount(0)
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
  const group = panel.locator('.session-panel-title-area > .session-panel-tag-pills .tag-pill-group')
  await expect(group).toBeVisible()
  expect(await clippedBy(group)).toEqual([])
  const head = await group.boundingBox()
  const header = await panel.locator('.session-panel-header').boundingBox()
  expect(head!.x + head!.width).toBeLessThanOrEqual(header!.x + header!.width + 1)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-narrow-header.png` })
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
