/**
 * Reported pinned-area drag bugs, one spec.
 *
 * Round 1 (2026-08-24), with a screenshot of a fork group sitting above a divider
 * line: "如果说它是在一个group … 它都在这个separation line上面, 新的task drag上去会把
 * 之前那个task给挤到这个separation line下面这个是不能接受的" and "我一旦拖一个任务进
 * 去我没有办法再拖出来了就是在这个pinned area".
 *
 * Round 2 (2026-08-25), three screenshots: "still like this … even worse after
 * drop, the whole thing move outside". Two more root causes fell out: a drop on
 * the group CHIP fell through to the plain reorder (card parked above the whole
 * cluster, no join), and a line anchored `before` a card RODE ALONG when that
 * card was dragged elsewhere — rule 5 in tier-separators.ts re-anchors it to the
 * band's neighbours that stayed.
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
 * Round 6 (2026-08-25/26): two mid-drag reports with one root cause — the line
 * was static DOM while cards moved as CSS transforms, so cards visually CROSSED
 * it and no slot could open above a top-anchored line. Fix: custom-mode lines
 * became real sortable units (withSeparatorSentinels), anchors are rewritten
 * from the final drop frame (syncSeparatorAnchorsFromArr), and a named line
 * renders as a section heading (label). The old "fade the line mid-drag"
 * band-aid is gone with its cause.
 *
 * Both assertions are about THIS test's own ids: the fixture dataset is shared
 * across the specs in a run.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
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

async function readSeparators(): Promise<Array<{ id: string; after?: string; before?: string }>> {
  const res = await fetch(`${API}/api/ordering`)
  return ((await res.json()) as { separators?: Array<{ id: string; after?: string; before?: string }> }).separators ?? []
}

async function openFocus(page: Page): Promise<void> {
  // Tall viewport so the accumulated fixture cards don't push this test's rows
  // into the tier's scroll tail: a drop held 45px from a scrollable container's
  // bottom edge sits in dnd-kit's autoscroll band, the rows slide up under the
  // pointer mid-hold, and `over` drifts to the dragged card itself.
  await page.setViewportSize({ width: 1400, height: 1000 })
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

/** Unpin everything so each test starts with an EMPTY focus tier. Earlier
 *  tests' cards otherwise pile up (22 by test 6) and push this test's rows
 *  into dnd-kit's bottom autoscroll band, where a held pointer scrolls the
 *  container and the collision answer drifts (the documented over→self trap). */
async function clearFocus(): Promise<void> {
  const split = await fetch(`${API}/api/focus/tasks`).then((r) => r.json())
  const ids = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v && typeof v === 'object') {
      const id = (v as { id?: unknown }).id
      if (typeof id === 'string') { ids.add(id); return }
      for (const val of Object.values(v)) walk(val)
      return
    }
    if (typeof v === 'string') ids.add(v) // unpinning a non-pinned id is a no-op
  }
  walk(split)
  await Promise.all([...ids].map((id) => fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' })))
}

test.beforeEach(async () => {
  await clearFocus()
})

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

/** Drag a card ONTO a target row and release on its middle band ('middle' =
 *  join intent) or its top edge ('top' = insert-between intent). The join
 *  decision lives in dnd-kit's STATIC collision space (rects measured at drag
 *  start — the sortable rows sliding aside mid-drag are a transform-only
 *  preview), so aim at the target's rect BEFORE the drag displaces anything
 *  and never chase the live position: chasing a row that yields to the drag
 *  oscillates forever (probed 2026-08-25). */
async function dragCardOnto(page: Page, dragId: string, target: Locator, at: 'middle' | 'top'): Promise<void> {
  const card = page.locator(`${TIER_SCOPE} [data-task-id="${dragId}"]`).first()
  await card.hover()
  const grip = card.locator('.todo-pinned-drag-handle')
  const gb = await grip.boundingBox()
  if (!gb) throw new Error(`no drag handle for ${dragId}`)
  const tb = await target.boundingBox() // static layout — measured pre-drag
  if (!tb) throw new Error('drop target not visible')
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
  await page.mouse.down()
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2 + 10)
  const y = at === 'middle' ? tb.y + tb.height / 2 : tb.y + 3
  await page.mouse.move(tb.x + tb.width / 2, y, { steps: 12 })
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
  await dragCardOnto(page, joiner.id, target, 'middle')

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

test('dropping a card on the group CHIP joins the group — it never parks above the cluster', async ({ page }) => {
  // Second report, 2026-08-25 (screenshots): the drop fell through to the plain
  // reorder, so the card landed immediately ABOVE the whole group with no join,
  // and the divider line rode along with it — "the whole thing move outside".
  test.setTimeout(150_000)
  const proj = `SepChip${Date.now().toString(36)}`
  const m1 = await createTask('chip member one', proj)
  const m2 = await createTask('chip member two', proj)
  const m3 = await createTask('chip member three', proj)
  const joiner = await createTask('drops on the chip', proj)
  const outsider = await createTask('chip outsider', proj)
  const gid = await groupTasks([m1.id, m2.id, m3.id], 'Chip Group')
  for (const t of [m1, m2, m3, joiner, outsider]) await pinToFocus(t.id)
  await reorderOwn([m1.id, m2.id, m3.id, joiner.id, outsider.id])
  await presetTierViewModes(page, { focus: 'custom' })
  // The user's exact layout: the line directly under the group, the joiner under it.
  await putSeparators([{ id: 'sep_chip', tier: 'focus', mode: 'custom', after: m3.id, before: joiner.id }])

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  await openFocus(page)
  await expect(page.locator(`${TIER_SCOPE} [data-task-id="${joiner.id}"]`).first()).toBeVisible({ timeout: 20_000 })

  const chip = page.locator(`${TIER_SCOPE} [data-group-id="${gid}"]`).first()
  await expect(chip, 'the group chip header must be on screen').toBeVisible({ timeout: 20_000 })
  await dragCardOnto(page, joiner.id, chip, 'middle')

  await expect
    .poll(async () => (await fetch(`${API}/api/tasks/${joiner.id}`).then((r) => r.json())).task.group_id, {
      timeout: 20_000,
      message: 'dropping on the chip must JOIN the group',
    })
    .toBe(gid)
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${SHOT_DIR}/09-chip-drop-joins.png` })

  const rows = await tierRows(page)
  const sepIdx = rows.findIndex((r) => r.sep === 'sep_chip')
  const memberIdx = [m1.id, m2.id, m3.id, joiner.id].map((id) => rows.findIndex((r) => r.task === id))
  const outsiderIdx = rows.findIndex((r) => r.task === outsider.id)
  expect(sepIdx, 'the line is still rendered').toBeGreaterThan(-1)
  expect(memberIdx.every((i) => i !== -1 && i < sepIdx), `all four members stay above the line (rows: sep=${sepIdx}, members=${memberIdx})`).toBe(true)
  expect(outsiderIdx, 'the outsider stays below the line').toBeGreaterThan(sepIdx)
  expect(errors).toEqual([])
})

test('the line stays with its BAND when the card below it is dragged above the group', async ({ page }) => {
  // The distilled screenshot-3 state: the line was anchored `before` the card,
  // so moving the card above the cluster towed the line past the whole group and
  // every banded task changed sides. Rule 5: the drag re-anchors the line to the
  // neighbours that stayed.
  test.setTimeout(150_000)
  const proj = `SepBand${Date.now().toString(36)}`
  const top = await createTask('band top loose', proj)
  const m1 = await createTask('band member one', proj)
  const m2 = await createTask('band member two', proj)
  const mover = await createTask('band mover', proj)
  const outsider = await createTask('band outsider', proj)
  await groupTasks([m1.id, m2.id], 'Band Group')
  for (const t of [top, m1, m2, mover, outsider]) await pinToFocus(t.id)
  await reorderOwn([top.id, m1.id, m2.id, mover.id, outsider.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([{ id: 'sep_band', tier: 'focus', mode: 'custom', after: m2.id, before: mover.id }])

  await openFocus(page)
  const topCard = page.locator(`${TIER_SCOPE} [data-task-id="${top.id}"]`).first()
  await expect(topCard).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(`${TIER_SCOPE} [data-separator-id="sep_band"]`)).toBeVisible({ timeout: 20_000 })

  // Plain reorder: release on the top card's UPPER edge (away from the chip and
  // the members, so nothing reads as a group gesture).
  await dragCardOnto(page, mover.id, topCard, 'top')

  // The mover must NOT have joined or formed a group.
  await expect
    .poll(async () => {
      const rows = await tierRows(page)
      const mi = rows.findIndex((r) => r.task === mover.id)
      const g1 = rows.findIndex((r) => r.task === m1.id)
      return mi !== -1 && g1 !== -1 && mi < g1
    }, { timeout: 20_000, message: 'the drag never moved the card above the group' })
    .toBe(true)
  const moved = await fetch(`${API}/api/tasks/${mover.id}`).then((r) => r.json())
  expect(moved.task.group_id ?? null, 'a plain reorder must not group').toBeNull()

  // Rule 5, persisted: the stored anchors now name the rows that stayed.
  await expect
    .poll(async () => {
      const s = (await readSeparators()).find((x) => x.id === 'sep_band')
      return s ? `${s.after}→${s.before}` : 'missing'
    }, { timeout: 20_000, message: 'the line must re-anchor to the band, not follow the card' })
    .toBe(`${m2.id}→${outsider.id}`)

  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOT_DIR}/10-line-stays-with-band.png` })
  const rows = await tierRows(page)
  const sepIdx = rows.findIndex((r) => r.sep === 'sep_band')
  for (const id of [m1.id, m2.id, mover.id]) {
    const i = rows.findIndex((r) => r.task === id)
    expect(i !== -1 && i < sepIdx, `${id} stays above the line (idx ${i}, sep ${sepIdx})`).toBe(true)
  }
  expect(rows.findIndex((r) => r.task === outsider.id)).toBeGreaterThan(sepIdx)
})

test('a card dropped into the gap under the line lands BELOW the line', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `SepGap${Date.now().toString(36)}`
  const a = await createTask('gap above', proj)
  const b = await createTask('gap below', proj)
  const c = await createTask('gap newcomer', proj)
  for (const t of [a, b, c]) await pinToFocus(t.id)
  await reorderOwn([a.id, b.id, c.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([{ id: 'sep_gap', tier: 'focus', mode: 'custom', after: a.id, before: b.id }])

  await openFocus(page)
  const bCard = page.locator(`${TIER_SCOPE} [data-task-id="${b.id}"]`).first()
  await expect(bCard).toBeVisible({ timeout: 20_000 })
  // Take b's slot from below via its top edge — the insert-between gesture (a
  // release on b's MIDDLE now means "group c with b", a different verb).
  await dragCardOnto(page, c.id, bCard, 'top')

  await expect
    .poll(async () => {
      const rows = await tierRows(page)
      const sep = rows.findIndex((r) => r.sep === 'sep_gap')
      const ci = rows.findIndex((r) => r.task === c.id)
      const ai = rows.findIndex((r) => r.task === a.id)
      return sep !== -1 && ci !== -1 && ai !== -1 ? (ai < sep && sep < ci) : false
    }, { timeout: 20_000, message: 'the newcomer must land under the line, not above it' })
    .toBe(true)
  // Sync-from-final keeps the stored anchors HONEST: the newcomer is the line's
  // below-neighbour now (rendering is unchanged — `after` resolves first).
  const s = (await readSeparators()).find((x) => x.id === 'sep_gap')
  expect(s).toMatchObject({ after: a.id, before: c.id })
})

/** Live geometry of a row — boundingBox INCLUDES mid-drag CSS transforms, i.e.
 *  exactly what the user sees. Polls until two consecutive frames agree (<0.5px)
 *  so we measure after the make-room transition settles, not during. */
async function settledBox(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const loc = page.locator(selector).first()
  let prev = await loc.boundingBox()
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(80)
    const cur = await loc.boundingBox()
    if (prev && cur && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.x - prev.x) < 0.5) return cur
    prev = cur
  }
  if (!prev) throw new Error(`${selector}: no box`)
  return prev
}

/** Press a card's grip and HOVER (no release) at (x, y): activation nudge, slow
 *  stepped approach, then hold until the layout settles. */
async function dragHoldAt(page: Page, taskId: string, x: number, y: number): Promise<void> {
  const card = page.locator(`${TIER_SCOPE} [data-task-id="${taskId}"]`).first()
  await card.hover()
  const grip = card.locator('.todo-pinned-drag-handle')
  const gb = await grip.boundingBox()
  if (!gb) throw new Error(`no grip for ${taskId}`)
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
  await page.mouse.down()
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2 + 10)
  await page.mouse.move(x, y, { steps: 20 })
  await page.waitForTimeout(500)
}

test('the line YIELDS mid-drag: a card can never be pushed across it (round 6 report B)', async ({ page }) => {
  // 2026-08-25: "when i drag T2 to before T1, T1 get push to below drag bar" —
  // the line was static DOM while cards moved as transforms, so T1's make-room
  // slide crossed it. The line is a sortable unit now: it moves WITH its band.
  test.setTimeout(120_000)
  const proj = `SepYield${Date.now().toString(36)}`
  const t1 = await createTask('yield top card', proj)
  const xx1 = await createTask('yield below-line one', proj)
  const xx2 = await createTask('yield below-line two', proj)
  const t2 = await createTask('yield dragged card', proj)
  for (const t of [t1, xx1, xx2, t2]) await pinToFocus(t.id)
  await reorderOwn([t1.id, xx1.id, xx2.id, t2.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([{ id: 'sep_yield', tier: 'focus', mode: 'custom', after: t1.id, before: xx1.id }])

  await openFocus(page)
  const lineSel = `${TIER_SCOPE} [data-separator-id="sep_yield"]`
  await expect(page.locator(lineSel)).toBeVisible({ timeout: 20_000 })
  const t1Sel = `${TIER_SCOPE} [data-task-id="${t1.id}"]`
  const t1Before = await settledBox(page, t1Sel)
  const lineBefore = await settledBox(page, lineSel)
  expect(t1Before.y, 'sanity: T1 starts above the line').toBeLessThan(lineBefore.y)

  // Hold T2 over T1's top edge: T1 makes room downward — and the line moves with it.
  await dragHoldAt(page, t2.id, t1Before.x + t1Before.width / 2, t1Before.y + 3)
  const t1Live = await settledBox(page, t1Sel)
  const lineLive = await settledBox(page, lineSel)
  await page.screenshot({ path: `${SHOT_DIR}/13-line-yields-mid-drag.png` })
  expect(t1Live.y, 'T1 must stay ABOVE the line mid-drag').toBeLessThan(lineLive.y)
  expect(lineLive.y, 'the line yields with its band').toBeGreaterThan(lineBefore.y + 10)

  await page.mouse.up()
  await page.waitForTimeout(1200)
  // Landed: [t2, t1, line, xx…] and the anchors did not change — t1 is still the
  // card above the line, xx1 still the card below it.
  const rows = await tierRows(page)
  const sepIdx = rows.findIndex((r) => r.sep === 'sep_yield')
  expect(rows.findIndex((r) => r.task === t2.id)).toBeLessThan(rows.findIndex((r) => r.task === t1.id))
  expect(rows.findIndex((r) => r.task === t1.id)).toBeLessThan(sepIdx)
  expect(rows.findIndex((r) => r.task === xx1.id)).toBeGreaterThan(sepIdx)
  const s = (await readSeparators()).find((x) => x.id === 'sep_yield')
  expect(s).toMatchObject({ after: t1.id, before: xx1.id })
})

test('a card dragged to the very top lands ABOVE a top-anchored line (round 6 report A)', async ({ page }) => {
  // 2026-08-25: "to very top it doesn't show correctly … it show below the line,
  // instead of top even if my cursor is at the top" — no slot could open above a
  // static line. As a sortable unit the line is a real drop target: taking its
  // slot from above puts the card above it, preview and drop alike.
  test.setTimeout(120_000)
  const proj = `SepTop${Date.now().toString(36)}`
  const xx1 = await createTask('top first card', proj)
  const xx2 = await createTask('top second card', proj)
  const t1 = await createTask('top dragged card', proj)
  for (const t of [xx1, xx2, t1]) await pinToFocus(t.id)
  await reorderOwn([xx1.id, xx2.id, t1.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([{ id: 'sep_top', tier: 'focus', mode: 'custom', after: '', before: xx1.id }])

  await openFocus(page)
  const lineSel = `${TIER_SCOPE} [data-separator-id="sep_top"]`
  await expect(page.locator(lineSel)).toBeVisible({ timeout: 20_000 })
  const lineBefore = await settledBox(page, lineSel)
  const xx1Before = await settledBox(page, `${TIER_SCOPE} [data-task-id="${xx1.id}"]`)

  // Pointer at the VERY TOP: above the line, above everything.
  await dragHoldAt(page, t1.id, xx1Before.x + xx1Before.width / 2, lineBefore.y - 4)
  const line = await settledBox(page, lineSel)
  // The dragged card's own element is transformed into the insert slot — its
  // live box IS the preview of where it will land.
  const slot = await settledBox(page, `${TIER_SCOPE} [data-task-id="${t1.id}"]`)
  await page.screenshot({ path: `${SHOT_DIR}/14-slot-above-top-line.png` })
  expect(slot.y, 'the insert slot opens ABOVE the line, where the pointer is').toBeLessThan(line.y)

  await page.mouse.up()
  await page.waitForTimeout(1200)
  const rows = await tierRows(page)
  const sepIdx = rows.findIndex((r) => r.sep === 'sep_top')
  expect(rows.findIndex((r) => r.task === t1.id), 'the card landed above the line').toBeLessThan(sepIdx)
  const s = (await readSeparators()).find((x) => x.id === 'sep_top')
  expect(s).toMatchObject({ after: t1.id, before: xx1.id })
})

test('the line itself drags as a sortable row and re-anchors where it lands', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `SepSelf${Date.now().toString(36)}`
  const a = await createTask('self one', proj)
  const b = await createTask('self two', proj)
  const c = await createTask('self three', proj)
  for (const t of [a, b, c]) await pinToFocus(t.id)
  await reorderOwn([a.id, b.id, c.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([{ id: 'sep_self', tier: 'focus', mode: 'custom', after: '', before: a.id }])

  await openFocus(page)
  const line = page.locator(`${TIER_SCOPE} [data-separator-id="sep_self"]`)
  await expect(line).toBeVisible({ timeout: 20_000 })
  const lb = await line.boundingBox()
  expect(lb).not.toBeNull()
  const cCard = page.locator(`${TIER_SCOPE} [data-task-id="${c.id}"]`).first()
  const cb = await cCard.boundingBox()
  expect(cb).not.toBeNull()

  // The whole row is its own drag handle. Take c's slot from above.
  await page.mouse.move(lb!.x + lb!.width / 2, lb!.y + lb!.height / 2)
  await page.mouse.down()
  await page.mouse.move(lb!.x + lb!.width / 2, lb!.y + lb!.height / 2 + 10)
  await page.mouse.move(cb!.x + cb!.width / 2, cb!.y + 4, { steps: 12 })
  await page.waitForTimeout(400)
  await page.mouse.up()
  await page.waitForTimeout(1200)

  await expect
    .poll(async () => {
      const s = (await readSeparators()).find((x) => x.id === 'sep_self')
      return s ? `${s.after}→${s.before}` : 'missing'
    }, { timeout: 20_000, message: 'the dragged line must re-anchor to its landing slot' })
    .toBe(`${b.id}→${c.id}`)
  const rows = await tierRows(page)
  const sepIdx = rows.findIndex((r) => r.sep === 'sep_self')
  expect(rows.findIndex((r) => r.task === b.id)).toBeLessThan(sepIdx)
  expect(rows.findIndex((r) => r.task === c.id)).toBeGreaterThan(sepIdx)
})

test('naming a line turns it into a heading, and the name survives a reload', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `SepName${Date.now().toString(36)}`
  const a = await createTask('name one', proj)
  const b = await createTask('name two', proj)
  for (const t of [a, b]) await pinToFocus(t.id)
  await reorderOwn([a.id, b.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([{ id: 'sep_name', tier: 'focus', mode: 'custom', after: a.id, before: b.id }])

  await openFocus(page)
  const line = page.locator(`${TIER_SCOPE} [data-separator-id="sep_name"]`)
  await expect(line).toBeVisible({ timeout: 20_000 })
  await line.hover()
  await line.locator('.tier-separator-edit').click()
  await line.locator('.tier-separator-label-input').fill('Do it now')
  await line.locator('.tier-separator-label-input').press('Enter')
  await expect(line.locator('.tier-separator-label')).toHaveText('Do it now', { timeout: 10_000 })
  await expect
    .poll(async () => (await readSeparators() as Array<{ id: string; label?: string }>).find((x) => x.id === 'sep_name')?.label,
      { timeout: 20_000 })
    .toBe('Do it now')
  await page.screenshot({ path: `${SHOT_DIR}/15-heading-named.png` })

  // Survives a full reload (round-trips through config).
  await openFocus(page)
  await expect(page.locator(`${TIER_SCOPE} [data-separator-id="sep_name"] .tier-separator-label`)).toHaveText('Do it now', { timeout: 20_000 })
})

test('a drop BESIDE a group never falls into it — joining needs the pointer on a card\'s middle', async ({ page }) => {
  // Round 3 (2026-08-25): "我明明是拉到外面的,然后他还是并到了这个Group里" — the
  // join decision came from closestCenter (the NEAREST card), so releasing next
  // to a cluster joined it. Joining now requires the pointer to sit in the
  // target card's MIDDLE band; the edge band is an insert-between gesture.
  test.setTimeout(150_000)
  const proj = `SepEdge${Date.now().toString(36)}`
  const m1 = await createTask('edge member one', proj)
  const m2 = await createTask('edge member two', proj)
  const loose = await createTask('edge stays loose', proj)
  const gid = await groupTasks([m1.id, m2.id], 'Edge Group')
  for (const t of [m1, m2, loose]) await pinToFocus(t.id)
  await reorderOwn([m1.id, m2.id, loose.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([])

  await openFocus(page)
  const m1Card = page.locator(`${TIER_SCOPE} [data-task-id="${m1.id}"]`).first()
  await expect(m1Card).toBeVisible({ timeout: 20_000 })
  // Release on the group's TOP EDGE (first member's top 3px): between-rows
  // intent, one pixel row away from what used to be a silent join.
  await dragCardOnto(page, loose.id, m1Card, 'top')

  // The reorder lands (the card moves above the group)…
  await expect
    .poll(async () => {
      const rows = await tierRows(page)
      const li = rows.findIndex((r) => r.task === loose.id)
      const g1 = rows.findIndex((r) => r.task === m1.id)
      return li !== -1 && g1 !== -1 && li < g1
    }, { timeout: 20_000, message: 'the edge drop must reorder the card above the group' })
    .toBe(true)
  // …and NOTHING joined: the loose card has no group, the group kept exactly two.
  const looseNow = await fetch(`${API}/api/tasks/${loose.id}`).then((r) => r.json())
  expect(looseNow.task.group_id ?? null, 'a drop beside the group must not join it').toBeNull()
  for (const id of [m1.id, m2.id]) {
    const t = await fetch(`${API}/api/tasks/${id}`).then((r) => r.json())
    expect(t.task.group_id).toBe(gid)
  }
  await page.screenshot({ path: `${SHOT_DIR}/11-edge-drop-stays-out.png` })
})

test('the blue join frame follows the pointer\'s middle-band test — no frame, no join', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `SepFrame${Date.now().toString(36)}`
  const m1 = await createTask('frame member one', proj)
  const m2 = await createTask('frame member two', proj)
  const loose = await createTask('frame prober', proj)
  await groupTasks([m1.id, m2.id], 'Frame Group')
  for (const t of [m1, m2, loose]) await pinToFocus(t.id)
  await reorderOwn([m1.id, m2.id, loose.id])
  await presetTierViewModes(page, { focus: 'custom' })
  await putSeparators([])

  await openFocus(page)
  const looseCard = page.locator(`${TIER_SCOPE} [data-task-id="${loose.id}"]`).first()
  const target = page.locator(`${TIER_SCOPE} [data-task-id="${m1.id}"]`).first()
  await expect(looseCard).toBeVisible({ timeout: 20_000 })
  const tBox = await target.boundingBox()
  expect(tBox).not.toBeNull()

  await looseCard.hover()
  const grip = looseCard.locator('.todo-pinned-drag-handle')
  const gBox = await grip.boundingBox()
  expect(gBox).not.toBeNull()
  await page.mouse.move(gBox!.x + gBox!.width / 2, gBox!.y + gBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(gBox!.x + gBox!.width / 2, gBox!.y + gBox!.height / 2 + 12)

  const lit = page.locator(`${TIER_SCOPE} [data-task-id="${m1.id}"].todo-panel-item-group-target`)
  // Middle of the member's AT-DRAG-START rect → the join frame lights. The
  // test lives in dnd-kit's static collision space (the rows sliding aside are
  // a transform-only preview), so aim at the pre-drag rect and stay there.
  await page.mouse.move(tBox!.x + tBox!.width / 2, tBox!.y + tBox!.height / 2, { steps: 10 })
  await expect(lit, 'pointer on the card middle must announce the join').toHaveCount(1, { timeout: 5_000 })
  await page.screenshot({ path: `${SHOT_DIR}/12-join-frame-middle.png` })
  // Slide to its top edge → the frame goes out: this release would reorder.
  await page.mouse.move(tBox!.x + tBox!.width / 2, tBox!.y + 2, { steps: 6 })
  await expect(lit, 'pointer on the edge band must NOT announce a join').toHaveCount(0, { timeout: 5_000 })
  // Release here and verify the promise held.
  await page.mouse.up()
  await page.waitForTimeout(1200)
  const after = await fetch(`${API}/api/tasks/${loose.id}`).then((r) => r.json())
  expect(after.task.group_id ?? null, 'the unlit frame promised no join').toBeNull()
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
  const aCard = page.locator(`${TIER_SCOPE} [data-task-id="${a.id}"]`).first()

  // Drop b at a's top edge: a plain reorder. The zone is on screen during this
  // drag, so if it could win a drop it did not deserve, this card would
  // silently unpin — and a release on a's MIDDLE would now group the two.
  await dragCardOnto(page, b.id, aCard, 'top')

  const order = (await pinnedOrder()).filter((id) => id === a.id || id === b.id)
  expect(order, 'a reorder near the bottom of the tier must not unpin').toHaveLength(2)
})
