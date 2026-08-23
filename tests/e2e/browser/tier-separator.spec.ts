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
 *   6. in "By project" a FOLDER IS ONE UNIT: the line lands between folders (and a
 *      mid-folder drop snaps to the nearest boundary), never between a folder's
 *      label and its own cards
 *
 * Anchors are asserted through `/api/ordering` (the stored anchors: card ids in
 * custom mode, folder names in project mode) rather than by pixel order: the
 * position is the CONTRACT, the DOM order is its rendering, and on the shared
 * fixture another spec's card can sit between mine at any time. The one thing
 * asserted in the DOM is what the user actually judges in project mode: the row
 * below the line is a folder LABEL, so the line is outside every folder.
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
  after?: string
  before?: string
  afterProject?: string
  beforeProject?: string
  project?: string
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

/** Pin one task of its own project into the tier, so the tier has another folder. */
async function seedProject(page: Page, project: string, title: string): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  await pinToTier(page, id, TIER)
  return id
}

/** The folders currently rendered in the tier, top to bottom, as STORED names —
 *  Inbox is '' and shows as "Inbox", so the visible text is not the name. */
async function folderOrder(page: Page): Promise<string[]> {
  return page.locator('.tier-project-label').evaluateAll(
    (els) => els.map((el) => (el as HTMLElement).dataset.project ?? ''),
  )
}

test('in "By project" the line goes BETWEEN folders, never inside one', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  const mine = await seed(page, 2, stamp)
  // A tier needs 2+ DISTINCT projects for the folder labels (and the project "+"
  // they carry) to render at all.
  await seedProject(page, 'SeparatorAltProj', `separator alt ${stamp}`)

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
  // A folder is one unit here, so the line is positioned by FOLDER, and card
  // anchors must not exist at all — a card anchor is what used to let a line land
  // between a folder's label and its own tasks.
  expect(stored[0].after, 'no card anchors in project mode').toBeUndefined()
  expect(stored[0].before).toBeUndefined()
  const folders = await folderOrder(page)
  const boundary = stored[0].beforeProject
  // '' is Inbox, a real folder — so the check is "is it a rendered folder", never
  // truthiness.
  expect(boundary, 'the line names the folder it sits above').not.toBeUndefined()
  expect(folders, 'and that folder is one actually rendered in this tier').toContain(boundary)
  expect(stored[0].afterProject, 'clicking a folder\'s "+" ends the band after it')
    .toBe(PROJECT)

  // The rendering, which is what the user judges: the row right below the line is
  // a FOLDER LABEL, so the line is outside every folder.
  const nextClass = await separators(page).first().evaluate(
    (el) => el.nextElementSibling?.className ?? '',
  )
  expect(nextClass, 'the line sits directly above a folder label').toContain('tier-project-label')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-project-run-separator.png` })
})

test('dragging in "By project" snaps to a folder boundary, even mid-folder', async ({ page }) => {
  const stamp = Date.now()
  await clearSeparators(page)
  // Three folders → two real boundaries, so a drag has somewhere to move TO.
  const mine = await seed(page, 2, stamp)
  await seedProject(page, 'SeparatorAltProj', `separator alt ${stamp}`)
  await seedProject(page, 'SeparatorThirdProj', `separator third ${stamp}`)

  await openTier(page, 'project', mine[0])
  // 3+ because the shared fixture carries folders of its own (including Inbox) —
  // the exact set is not this spec's business, only that there are two boundaries.
  await expect(page.locator('.tier-project-label').nth(2)).toBeVisible({ timeout: 30_000 })
  const folders = await folderOrder(page)
  expect(folders.length).toBeGreaterThanOrEqual(3)

  await chooseFromPlus(page, page.getByTestId('tier-view-bar'), 'Add separator')
  const line = separators(page).first()
  await expect(line).toBeVisible({ timeout: 15_000 })
  const start = (await readSeparators(page))[0].beforeProject
  expect(start, 'a tier-level "+" takes the first boundary').toBe(folders[1])

  // Drop on the BOTTOM half of the LAST card of the second folder. Mid-folder is
  // exactly the drop that used to split a folder; it must resolve to the boundary
  // BELOW that folder instead.
  const midFolderCard = page.locator('.tier-project-label').nth(2)
    .locator('xpath=preceding-sibling::*[@data-task-id][1]')
  await expect(midFolderCard).toBeVisible()
  const box = await midFolderCard.boundingBox()
  expect(box).not.toBeNull()
  await line.dragTo(midFolderCard, {
    targetPosition: { x: Math.min(40, box!.width / 2), y: box!.height - 3 },
  })

  await expect.poll(async () => (await readSeparators(page))[0]?.beforeProject, {
    timeout: 15_000,
    message: 'the mid-folder drop never moved the line to the next boundary',
  }).toBe(folders[2])
  const after = await readSeparators(page)
  expect(after[0].afterProject).toBe(folders[1])
  expect(after[0].before, 'still no card anchors').toBeUndefined()
  const nextClass = await separators(page).first().evaluate(
    (el) => el.nextElementSibling?.className ?? '',
  )
  expect(nextClass, 'and it is still drawn above a folder label').toContain('tier-project-label')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-project-boundary-drag.png` })
})
