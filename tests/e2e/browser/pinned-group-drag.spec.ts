/**
 * Whole-group drag in the pinned (Focus) area must LOOK like a drag, and pin order
 * must stay put when it isn't being dragged.
 *
 * Reported 2026-08-22: "drag 整个 ForkGroup 的时候它的 Visual 是完全错的 … 我拖动 B
 * 到最上面,它显示的是 A,然后是B … 它不会真的挤出来一个位置给它", plus "它的 order
 * 一直在变 … 如果是有新的 conversation … 它就会直接跑到最前面".
 *
 * Three separate causes, one spec each:
 *  1. The group chip lived OUTSIDE the tier's SortableContext items, so dnd-kit
 *     never displaced it and the dragged group's sentinel had no measured rect —
 *     no slot opened anywhere.
 *  2. togglePin() prepended (pin_order = min - 1). Pinning is also automatic (a
 *     fork inherits its source's pin), so a new arrival rewrote the user's order.
 *  3. Because the pinned area anchors a group at its FIRST member, an auto-pinned
 *     fork that joined an existing group dragged that whole group to the top.
 *
 * The fixture server's dataset is shared across specs in a run, so every assertion
 * here is about the RELATIVE order of this test's own ids.
 */
import { test, expect, type Page } from '@playwright/test'
import { selectSection } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

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

async function addToGroup(groupId: string, taskIds: string[]): Promise<void> {
  const res = await fetch(`${API}/api/tasks/groups/${groupId}/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds }),
  })
  if (!res.ok) throw new Error(`addToGroup failed: ${res.status} ${await res.text()}`)
}

/** Put THIS test's ids in a known order without touching anyone else's pins: send
 *  the current global order with our ids re-sequenced in place. */
async function reorderOwn(ids: string[]): Promise<void> {
  const all = await serverPinnedOrder()
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

async function serverPinnedOrder(): Promise<string[]> {
  const res = await fetch(`${API}/api/focus/tasks`)
  return ((await res.json()) as { pinned_tasks: string[] }).pinned_tasks
}

/** Focus-tier card ids in render order (the tier region, not the Recent feed). */
function renderedFocusOrder(page: Page): Promise<string[]> {
  return page.$$eval(
    '.todo-pinned-section:not(.todo-pinned-section-recent) .todo-focus-card',
    (els) => els.map((el) => el.getAttribute('data-task-id') ?? ''),
  )
}

async function ownFocusOrder(page: Page, ids: string[]): Promise<string[]> {
  const own = new Set(ids)
  return (await renderedFocusOrder(page)).filter((id) => own.has(id))
}

async function ownServerOrder(ids: string[]): Promise<string[]> {
  const own = new Set(ids)
  return (await serverPinnedOrder()).filter((id) => own.has(id))
}

async function openFocus(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await selectSection(page, 'Focus')
  await page.waitForTimeout(900)
}

test('dragging a whole group opens a slot — siblings displace', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `GrpDrag${Date.now().toString(36)}`

  // Two groups of two, pinned to Focus in a known order: A(a1,a2) then B(b1,b2).
  const a1 = await createTask('A one', proj)
  const a2 = await createTask('A two', proj)
  const b1 = await createTask('B one', proj)
  const b2 = await createTask('B two', proj)
  const gidA = await groupTasks([a1.id, a2.id], 'Group A')
  const gidB = await groupTasks([b1.id, b2.id], 'Group B')
  for (const t of [a1, a2, b1, b2]) await pinToFocus(t.id)
  const ids = [a1.id, a2.id, b1.id, b2.id]
  await reorderOwn(ids)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  await openFocus(page)

  const scope = page.locator('.todo-pinned-section:not(.todo-pinned-section-recent)')
  const a1Card = scope.locator(`.todo-focus-card[data-task-id="${a1.id}"]`)
  await expect(a1Card).toBeVisible({ timeout: 15_000 })
  expect(await ownFocusOrder(page, ids)).toEqual(ids)

  // Both chips must be real, addressable rows — the chip is what carries the
  // whole-group drag handle.
  const chipA = scope.locator(`.task-group-chip[data-group-id="${gidA}"]`)
  const chipB = scope.locator(`.task-group-chip[data-group-id="${gidB}"]`)
  await expect(chipA).toBeVisible()
  await expect(chipB).toBeVisible()

  const gripBox = await chipB.locator('.task-group-chip-grip').boundingBox()
  const a1Box = await a1Card.boundingBox()
  const chipABox = await chipA.boundingBox()
  expect(gripBox).not.toBeNull()
  expect(a1Box).not.toBeNull()
  expect(chipABox).not.toBeNull()

  // On-screen top edge (already includes any dnd-kit transform) and the raw
  // transform, read through the same locators asserted above.
  const dy = (loc: typeof chipA) => loc.evaluate((el) => {
    const t = getComputedStyle(el).transform
    return !t || t === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(t).m42)
  })
  const top = (loc: typeof chipA) => loc.evaluate((el) => Math.round(el.getBoundingClientRect().top))

  // At rest B sits below A.
  expect(await top(chipB)).toBeGreaterThan(await top(a1Card))

  await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2)
  await page.mouse.down()
  // Past the activation constraint, then up onto Group A's chip (= "land above A").
  await page.mouse.move(gripBox!.x + gripBox!.width / 2, gripBox!.y + gripBox!.height / 2 + 10)
  await page.mouse.move(chipABox!.x + chipABox!.width / 2, chipABox!.y + chipABox!.height / 2, { steps: 14 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: '/tmp/pinned-group-drag/mid-drag.png' })

  // THE assertion: a slot must actually open. Group B's chip (which stands in for
  // the whole collapsed cluster) has to sit ABOVE Group A's cards mid-drag, and
  // A's cards have to be pushed down to make room. Before the fix nothing moved
  // at all — "它不会真的挤出来一个位置给它".
  const mid = {
    chipB: await top(chipB),
    chipA: await top(chipA),
    lead: await top(a1Card),
    leadShift: await dy(a1Card),
    secondShift: await dy(scope.locator(`.todo-focus-card[data-task-id="${a2.id}"]`)),
    chipAShift: await dy(chipA),
  }

  await page.mouse.up()
  await page.waitForTimeout(1200)

  expect(mid.chipB, 'the dragged group never moved above Group A — no slot opened').toBeLessThan(mid.lead)
  expect(mid.leadShift, 'Group A lead card did not displace').toBeGreaterThan(10)
  expect(mid.secondShift, 'Group A second card did not displace with its lead').toBeGreaterThan(10)
  // Group A's header must stay attached to its own cards: either both move or
  // neither does, never one without the other.
  expect(mid.chipA, "Group A's header detached from its cards").toBeLessThan(mid.lead)
  expect(
    mid.chipAShift === 0 || Math.abs(mid.chipAShift - mid.leadShift) < 4,
    `chip shifted ${mid.chipAShift} while its lead card shifted ${mid.leadShift}`,
  ).toBe(true)

  // And the drop must actually land B above A, on screen and on the server.
  expect(await ownFocusOrder(page, ids)).toEqual([b1.id, b2.id, a1.id, a2.id])
  expect(await ownServerOrder(ids)).toEqual([b1.id, b2.id, a1.id, a2.id])
  expect(errors).toEqual([])
})

test('a newly pinned task never jumps above the existing pin order', async ({ page }) => {
  test.setTimeout(90_000)
  const proj = `PinOrder${Date.now().toString(36)}`

  const t1 = await createTask('Pinned first', proj)
  const t2 = await createTask('Pinned second', proj)
  await pinToFocus(t1.id)
  await pinToFocus(t2.id)
  await reorderOwn([t1.id, t2.id])

  await openFocus(page)
  const scope = page.locator('.todo-pinned-section:not(.todo-pinned-section-recent)')
  await expect(scope.locator(`.todo-focus-card[data-task-id="${t1.id}"]`)).toBeVisible({ timeout: 15_000 })
  expect(await ownFocusOrder(page, [t1.id, t2.id])).toEqual([t1.id, t2.id])

  // A fresh task gets pinned — what a new session or a fork does automatically.
  const fresh = await createTask('Fresh arrival', proj)
  await pinToFocus(fresh.id)
  const ids = [t1.id, t2.id, fresh.id]
  await expect
    .poll(() => ownFocusOrder(page, ids), { timeout: 15_000 })
    .toEqual(ids)
  expect(await ownServerOrder(ids), 'server order disagrees with the rendered order').toEqual(ids)
})

test('a new pin joining an existing group does not drag the group to the top', async ({ page }) => {
  test.setTimeout(90_000)
  const proj = `GrpAnchor${Date.now().toString(36)}`

  // Standalone pin on top, then a group below it.
  const solo = await createTask('Solo top', proj)
  const g1 = await createTask('Grp one', proj)
  const g2 = await createTask('Grp two', proj)
  const gid = await groupTasks([g1.id, g2.id], 'Anchored group')
  for (const t of [solo, g1, g2]) await pinToFocus(t.id)
  await reorderOwn([solo.id, g1.id, g2.id])

  await openFocus(page)
  const scope = page.locator('.todo-pinned-section:not(.todo-pinned-section-recent)')
  await expect(scope.locator(`.todo-focus-card[data-task-id="${solo.id}"]`)).toBeVisible({ timeout: 15_000 })
  expect(await ownFocusOrder(page, [solo.id, g1.id, g2.id])).toEqual([solo.id, g1.id, g2.id])

  // A fork lands: new task, joins the group, gets pinned.
  const forked = await createTask('Forked member', proj)
  await addToGroup(gid, [forked.id])
  await pinToFocus(forked.id)

  // The group must stay anchored BELOW the solo pin, with the new member last.
  const ids = [solo.id, g1.id, g2.id, forked.id]
  await expect
    .poll(() => ownFocusOrder(page, ids), { timeout: 15_000 })
    .toEqual(ids)
})
