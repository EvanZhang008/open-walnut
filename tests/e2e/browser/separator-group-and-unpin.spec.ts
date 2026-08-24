/**
 * Two reported pinned-area bugs, one spec.
 *
 * Reported 2026-08-24, with a screenshot of a fork group sitting above a divider
 * line: "如果说它是在一个group … 它都在这个separation line上面, 新的task drag上去会把
 * 之前那个task给挤到这个separation line下面这个是不能接受的" and "我一旦拖一个任务进
 * 去我没有办法再拖出来了就是在这个pinned area".
 *
 *  1. A GROUP IS ONE UNIT, like a project folder. A divider line anchors to a card
 *     id, so when a card joined a group the line followed that card INTO the
 *     cluster and split it: members the user had put above the line ended up below
 *     it. The line must land on a group boundary, never between two members.
 *
 *  2. There was no way to drag a card OUT of the pinned area. `onUnpinTask` was
 *     reachable only from a card menu — no drag path called it, and the pinned
 *     DndContext covers Pinned + Recent only, so dragging down to the main list
 *     could never do anything. The gesture that puts a card in has to have a
 *     reverse.
 *
 * Both assertions are about THIS test's own ids: the fixture dataset is shared
 * across the specs in a run.
 */
import { test, expect, type Page } from '@playwright/test'
import { presetTierViewModes } from './draft-surface-helpers'
import { selectSection } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOT_DIR = process.env.SEPARATOR_SHOT_DIR ?? '/tmp/walnut-separators'

test.describe.configure({ mode: 'serial' })

async function createTask(title: string, project: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, project, source: 'local' }),
  })
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`)
  return (await res.json()).task
}

async function pinToFocus(taskId: string): Promise<void> {
  const p = await fetch(`${API}/api/focus/tasks/${taskId}`, { method: 'POST' })
  if (!p.ok) throw new Error(`pin failed: ${p.status}`)
  const t = await fetch(`${API}/api/focus/tasks/${taskId}/tier`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'focus' }),
  })
  if (!t.ok) throw new Error(`tier failed: ${t.status}`)
}

async function groupTasks(taskIds: string[], label: string): Promise<string> {
  const res = await fetch(`${API}/api/tasks/groups`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds, label }),
  })
  if (!res.ok) throw new Error(`group failed: ${res.status} ${await res.text()}`)
  return (await res.json()).group_id
}

async function pinnedOrder(): Promise<string[]> {
  const res = await fetch(`${API}/api/focus/tasks`)
  return ((await res.json()) as { pinned_tasks: string[] }).pinned_tasks
}

/** Re-sequence only THIS test's ids inside the global pin order. */
async function reorderOwn(ids: string[]): Promise<void> {
  const all = await pinnedOrder()
  const own = new Set(ids)
  let i = 0
  const next = all.map((id) => (own.has(id) ? ids[i++] : id))
  for (const id of ids) if (!all.includes(id)) next.push(id)
  const res = await fetch(`${API}/api/focus/reorder`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: next }),
  })
  if (!res.ok) throw new Error(`reorder failed: ${res.status}`)
}

async function putSeparators(separators: unknown[]): Promise<void> {
  const res = await fetch(`${API}/api/ordering/separators`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ separators }),
  })
  if (!res.ok) throw new Error(`separators failed: ${res.status} ${await res.text()}`)
}

async function openFocus(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await selectSection(page, 'Focus')
  await page.waitForTimeout(900)
}

const TIER_SCOPE = '.todo-pinned-section:not(.todo-pinned-section-recent)'

/** Every row of the Focus tier in DOM order: task cards AND divider lines. */
function tierRows(page: Page): Promise<Array<{ task: string | null; sep: string | null }>> {
  return page.$$eval(
    `${TIER_SCOPE} [data-task-id], ${TIER_SCOPE} [data-separator-id]`,
    (els) => els.map((el) => ({
      task: el.getAttribute('data-task-id'),
      sep: el.getAttribute('data-separator-id'),
    })),
  )
}

/** Press the card's grip and drag to (x, y), in steps, then release. */
async function dragCardTo(page: Page, taskId: string, x: number, y: number): Promise<void> {
  const card = page.locator(`${TIER_SCOPE} [data-task-id="${taskId}"]`).first()
  await card.hover()
  const grip = card.locator('.todo-pinned-drag-handle')
  const box = await grip.boundingBox()
  if (!box) throw new Error(`no drag handle for ${taskId}`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // Past dnd-kit's activation constraint first, then to the target.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 10)
  await page.mouse.move(x, y, { steps: 16 })
  await page.waitForTimeout(400)
  await page.mouse.up()
  await page.waitForTimeout(1200)
}

test('a divider line never splits a group: a card joining the cluster keeps every member on one side', async ({ page }) => {
  test.setTimeout(150_000)
  const proj = `SepGrp${Date.now().toString(36)}`

  // Focus: [m1, m2, joiner, outsider]; m1+m2 are one group; the line sits directly
  // BELOW the group (after m2, before joiner) — so all members start above it.
  const m1 = await createTask('member one', proj)
  const m2 = await createTask('member two', proj)
  const joiner = await createTask('joins the group', proj)
  const outsider = await createTask('stays outside', proj)
  const gid = await groupTasks([m1.id, m2.id], 'Sep Group')
  for (const t of [m1, m2, joiner, outsider]) await pinToFocus(t.id)
  await reorderOwn([m1.id, m2.id, joiner.id, outsider.id])
  // Custom order: the mode where lines anchor to CARDS, which is where a line
  // could get pulled inside a cluster.
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([{ id: 'sep_grpsplit', tier: 'focus', mode: 'custom', after: m2.id, before: joiner.id }])

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  await openFocus(page)

  await expect(page.locator(`${TIER_SCOPE} [data-task-id="${m1.id}"]`).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(`${TIER_SCOPE} [data-separator-id="sep_grpsplit"]`)).toBeVisible({ timeout: 20_000 })

  const sideOf = async (): Promise<{ sep: number; members: number[] }> => {
    const rows = await tierRows(page)
    const sep = rows.findIndex((r) => r.sep === 'sep_grpsplit')
    const members = [m1.id, m2.id, joiner.id]
      .map((id) => rows.findIndex((r) => r.task === id))
      .filter((i) => i !== -1)
    return { sep, members }
  }

  const before = await sideOf()
  expect(before.sep, 'the line must be on screen to start').toBeGreaterThan(-1)

  // The reported gesture: drag the card just below the line onto a group member,
  // which makes it join the group.
  const target = page.locator(`${TIER_SCOPE} [data-task-id="${m2.id}"]`).first()
  const targetBox = await target.boundingBox()
  expect(targetBox).not.toBeNull()
  await dragCardTo(page, joiner.id, targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2)

  await expect
    .poll(async () => (await fetch(`${API}/api/tasks/${joiner.id}`).then((r) => r.json())).task.group_id, {
      timeout: 20_000,
      message: 'the drag never added the card to the group',
    })
    .toBe(gid)
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${SHOT_DIR}/07-group-vs-separator.png` })

  const after = await sideOf()
  expect(after.sep, 'the line is still rendered').toBeGreaterThan(-1)
  expect(after.members.length, 'all three members are on screen').toBe(3)
  const above = after.members.filter((i) => i < after.sep).length
  expect(
    above === 0 || above === after.members.length,
    `the line split the group: ${above} of ${after.members.length} members above it`,
  ).toBe(true)
  expect(errors).toEqual([])
})

test('a pinned card can be dragged back out of the pinned area', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `SepUnpin${Date.now().toString(36)}`
  const t = await createTask('drag me out', proj)
  await pinToFocus(t.id)
  await putSeparators([])

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  await openFocus(page)

  const card = page.locator(`${TIER_SCOPE} [data-task-id="${t.id}"]`).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  expect(await pinnedOrder()).toContain(t.id)

  // The zone only exists while a pinned card is in flight, so grab the card first
  // and read the zone mid-drag.
  await card.hover()
  const grip = card.locator('.todo-pinned-drag-handle')
  const gripBox = await grip.boundingBox()
  expect(gripBox).not.toBeNull()
  await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2 + 12)

  const zone = page.getByTestId('unpin-drop-zone')
  await expect(zone, 'dragging a pinned card must offer a way out').toBeVisible({ timeout: 10_000 })
  const zoneBox = await zone.boundingBox()
  expect(zoneBox).not.toBeNull()
  await page.mouse.move(zoneBox!.x + zoneBox!.width / 2, zoneBox!.y + zoneBox!.height / 2, { steps: 14 })
  await page.waitForTimeout(350)
  // It has to say it is armed, or the user has no idea the drop will do anything.
  await expect(zone).toHaveClass(/todo-unpin-zone-hot/)
  await page.screenshot({ path: `${SHOT_DIR}/08-unpin-zone-hot.png` })
  await page.mouse.up()

  await expect
    .poll(async () => (await pinnedOrder()).includes(t.id), { timeout: 20_000, message: 'the card never left the pinned area' })
    .toBe(false)
  await expect(card).toHaveCount(0, { timeout: 20_000 })
  // The task itself survives — unpinning is not deleting.
  const still = await fetch(`${API}/api/tasks/${t.id}`).then((r) => r.json())
  expect(still.task.id).toBe(t.id)
  expect(errors).toEqual([])
})

test('the unpin zone stays out of the way of an ordinary reorder', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `SepKeep${Date.now().toString(36)}`
  const a = await createTask('keep one', proj)
  const b = await createTask('keep two', proj)
  for (const x of [a, b]) await pinToFocus(x.id)
  await reorderOwn([a.id, b.id])
  await putSeparators([])
  await openFocus(page)

  const bCard = page.locator(`${TIER_SCOPE} [data-task-id="${b.id}"]`).first()
  await expect(bCard).toBeVisible({ timeout: 20_000 })
  const aBox = await page.locator(`${TIER_SCOPE} [data-task-id="${a.id}"]`).first().boundingBox()
  expect(aBox).not.toBeNull()

  // Drop b onto a: a plain reorder. The zone is on screen during this drag, so if
  // it could win a drop it did not deserve, this card would silently unpin.
  await dragCardTo(page, b.id, aBox!.x + aBox!.width / 2, aBox!.y + 4)

  const order = (await pinnedOrder()).filter((id) => id === a.id || id === b.id)
  expect(order, 'a reorder near the bottom of the tier must not unpin').toHaveLength(2)
})
