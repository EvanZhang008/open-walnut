/**
 * Tier separators + the multi-verb "+" (R9).
 *
 * Two asks, one surface. The tier/project "+" used to be a single-verb button
 * (open a draft session); it now offers "New task", "New task with session" and
 * "Add separator", and a separator is a plain divider line the user drags to
 * wherever they want a band boundary inside a tier.
 *
 * What this spec owns:
 *   1. the "+" really is a menu with those three verbs, and right-click opens it too
 *   2. "Add separator" puts a line in the tier and it SURVIVES A RELOAD (it lives in
 *      config, not component state)
 *   3. dragging the line re-anchors it to the row it was dropped above, persisted
 *   4. the hover "x" removes it for good
 *   5. "New task" opens that tier's inline add row and a typed title becomes a task
 *
 * Anchors are asserted through `/api/ordering` (the stored `before`/`after` task
 * ids) rather than by pixel order: the position is the CONTRACT, the DOM order is
 * its rendering, and on the shared fixture another spec's card can sit between
 * mine at any time.
 *
 * House rules: `page.goto('/')` is the initial load only, every later step is a
 * real click, and the tier used here is scoped to a stamped private project so a
 * parallel spec's cards can't be mistaken for this one's.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import { chooseFromPlus, pinToTier, plusControl, presetTierViewModes } from './draft-surface-helpers'
import { presetPanelView } from './todo-panel-helpers'

const SCREENSHOT_DIR = process.env.SEPARATOR_SHOT_DIR ?? '/tmp/walnut-separators'

/** Own tier + own project: the pinned area is shared server state. */
const TIER = 'wait' as const
const PROJECT = 'SeparatorProj'

// Round-trips queue behind the fixture's session health monitor on its seeded
// dataset, same budget the sibling surface specs run on.
test.setTimeout(180_000)
// Serial: every scenario reads and rewrites ONE global separator list.
test.describe.configure({ mode: 'serial' })

interface StoredSeparator {
  id: string
  tier: string
  mode: string
  project?: string
  after?: string
  before?: string
}

async function readSeparators(page: Page): Promise<StoredSeparator[]> {
  const res = await page.request.get('/api/ordering')
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { separators?: StoredSeparator[] }).separators ?? []
}

async function clearSeparators(page: Page): Promise<void> {
  const res = await page.request.put('/api/ordering/separators', { data: { separators: [] } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function makeTask(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project: PROJECT } })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { task: { id: string } }).task.id
}

/** Seed N pinned cards in the tier under test, concurrently (tasks.json writes
 *  serialize behind a lock, so sequential seeds blow the budget on a loaded box). */
async function seed(page: Page, n: number, stamp: number): Promise<string[]> {
  const ids = await Promise.all(
    Array.from({ length: n }, (_, i) => makeTask(page, `separator probe ${i} ${stamp}`)),
  )
  await Promise.all(ids.map((id) => pinToTier(page, id, TIER)))
  return ids
}

/** Land on home with the tier tab open in a known view mode, and WAIT for the
 *  tier's cards. "Add separator" needs a non-empty scope to anchor to, so a click
 *  fired before the list paints correctly refuses (the product tells the user
 *  "nothing to separate here yet") and the spec would blame the wrong thing. */
async function openTier(page: Page, mode: 'project' | 'custom', anchorId?: string): Promise<void> {
  await presetTierViewModes(page, { [TIER]: mode })
  await presetPanelView(page, { section: TIER, project: '' })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('tier-view-bar')).toBeVisible({ timeout: 30_000 })
  if (anchorId) await expect(cardFor(page, anchorId)).toBeVisible({ timeout: 30_000 })
}

function separators(page: Page): Locator {
  return page.getByTestId('tier-separator')
}

function cardFor(page: Page, taskId: string): Locator {
  return page.locator(`[data-task-id="${taskId}"]`).first()
}

test('the tier "+" is a menu with three verbs, on left click and on right click', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  const ids = await seed(page, 2, stamp)
  await openTier(page, 'custom', ids[0])

  const plus = plusControl(page.getByTestId('tier-view-bar'))
  await expect(plus).toBeVisible()
  await plus.click()

  const menu = page.getByTestId('plus-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.task-kebab-item')).toHaveText([
    'New task', 'New task with session', 'Add separator',
  ])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-plus-menu.png` })

  // Escape closes it, then the SAME menu comes up on right-click — the "+" owns
  // its context menu because it is the one control here with several verbs.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await plus.click({ button: 'right' })
  await expect(page.getByTestId('plus-menu')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('"Add separator" drops a line into the tier and it survives a reload', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  const ids = await seed(page, 3, stamp)
  await openTier(page, 'custom', ids[0])
  await expect(separators(page)).toHaveCount(0)

  await chooseFromPlus(page, page.getByTestId('tier-view-bar'), 'Add separator')

  await expect(separators(page)).toHaveCount(1, { timeout: 15_000 })
  const stored = await readSeparators(page)
  expect(stored, 'the line is stored, not component state').toHaveLength(1)
  expect(stored[0].tier).toBe(TIER)
  expect(stored[0].mode).toBe('custom')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-separator-added.png` })

  // A reload is the honest test of "stored": component state would be gone.
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect(separators(page)).toHaveCount(1, { timeout: 30_000 })
})

test('dragging the line re-anchors it above the row it was dropped on', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  const ids = await seed(page, 3, stamp)
  await openTier(page, 'custom', ids[2])
  const target = cardFor(page, ids[2])

  await chooseFromPlus(page, page.getByTestId('tier-view-bar'), 'Add separator')
  const line = separators(page).first()
  await expect(line).toBeVisible({ timeout: 15_000 })

  // Drop on the TOP half of the third card → the line lands directly above it.
  // Native HTML5 drag: the line is `draggable`, the tier list carries the drop
  // handlers, and the drop bubbles from the card to that list.
  const box = await target.boundingBox()
  expect(box, 'the drop target must be laid out').not.toBeNull()
  await line.dragTo(target, { targetPosition: { x: Math.min(40, (box!.width) / 2), y: 3 } })

  await expect.poll(async () => (await readSeparators(page))[0]?.before, {
    timeout: 15_000,
    message: 'the drop never re-anchored the line',
  }).toBe(ids[2])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-separator-dragged.png` })

  // And the new spot is where a reload puts it.
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect(separators(page)).toHaveCount(1, { timeout: 30_000 })
  expect((await readSeparators(page))[0].before).toBe(ids[2])
})

test('the hover "x" removes the line for good', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  const ids = await seed(page, 2, stamp)
  await openTier(page, 'custom', ids[0])
  await chooseFromPlus(page, page.getByTestId('tier-view-bar'), 'Add separator')

  const line = separators(page).first()
  await expect(line).toBeVisible({ timeout: 15_000 })
  await line.hover()
  await line.locator('.tier-separator-delete').click()

  await expect(separators(page)).toHaveCount(0, { timeout: 15_000 })
  expect(await readSeparators(page)).toEqual([])
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect(separators(page)).toHaveCount(0)
})

test('"New task" opens the tier\'s inline add row and a typed title becomes a task', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  const ids = await seed(page, 1, stamp)
  await openTier(page, 'custom', ids[0])

  await chooseFromPlus(page, page.getByTestId('tier-view-bar'), 'New task')

  const input = page.locator('.focus-inline-add input')
  await expect(input, 'the "+" opens the add row instead of creating an untitled task')
    .toBeVisible({ timeout: 15_000 })
  await expect(input).toBeFocused()

  const title = `separator menu task ${stamp}`
  await input.fill(title)
  await input.press('Enter')
  await expect(page.locator('.todo-pinned-card, .todo-focus-card').filter({ hasText: title }))
    .toHaveCount(1, { timeout: 30_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-new-task-inline.png` })
})

test('a project run gets its own line in "By project" mode', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  const mine = await seed(page, 2, stamp)
  // A tier needs 2+ DISTINCT projects for the folder labels (and the project "+"
  // they carry) to render at all.
  const otherRes = await page.request.post('/api/tasks', {
    data: { title: `separator alt ${stamp}`, source: 'local', project: 'SeparatorAltProj' },
  })
  expect(otherRes.ok(), await otherRes.text()).toBe(true)
  const other = ((await otherRes.json()) as { task: { id: string } }).task.id
  await pinToTier(page, other, TIER)

  await openTier(page, 'project', mine[0])
  const label = page.locator('.tier-project-label').filter({
    has: page.locator('.tier-project-label-name').filter({ hasText: new RegExp(`^${PROJECT}$`) }),
  }).first()
  await expect(label).toBeVisible({ timeout: 30_000 })
  await label.hover()

  await chooseFromPlus(page, label, 'Add separator')

  await expect(separators(page)).toHaveCount(1, { timeout: 15_000 })
  const stored = await readSeparators(page)
  expect(stored[0].mode).toBe('project')
  expect(stored[0].project, 'the line belongs to the run whose "+" was used').toBe(PROJECT)
  // Its anchor is a card of THAT project, never the other run's. Asserted by
  // looking the anchor up rather than against this test's own ids: earlier
  // scenarios in this file pin cards into the same run, so the top of the run is
  // legitimately one of theirs.
  const anchorId = stored[0].before
  expect(anchorId, 'a line at the top of a run anchors to that run\'s first card').toBeTruthy()
  const anchorRes = await page.request.get(`/api/tasks/${anchorId}`)
  expect(anchorRes.ok(), await anchorRes.text()).toBe(true)
  const anchor = ((await anchorRes.json()) as { task: { project?: string } }).task
  expect(anchor.project).toBe(PROJECT)
  expect(mine.length, 'this scenario seeded its own cards into that run').toBeGreaterThan(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-project-run-separator.png` })
})
