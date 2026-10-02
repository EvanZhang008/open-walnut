/**
 * Dragging tasks and folders in a pinned tier, with nested folders and two projects.
 *
 * Reported 2026-09-30: a task could not be dragged into a subfolder (a folder whose
 * parent has no card of its own in the tier drew a heading that was not a drop target
 * at all), a folder could not be dragged by such a heading, a dragged folder landed one
 * slot short of its preview when moved down, and the project labels stayed put while
 * the rows around them slid, so a slot was drawn under the wrong project.
 *
 * Reported 2026-10-01: a loose card dragged down over a folder's cards made its gap flick
 * back and forth, the card under the pointer lit instead of showing where the card would
 * go, the card then landed first in the folder rather than at the gap, and a chain of
 * folders holding nothing but the next one drew one heading per level.
 *
 * The rules pinned here, in the order the board answers them:
 *  - a card's gap is where it lands: a gap between a folder's cards is inside it and
 *    lights the folder's row, the gap moves only with the pointer, and the drop puts the
 *    card exactly there;
 *  - a folder row's middle is the gap at the top of that folder, its top band the gap
 *    above it;
 *  - folders that hold only the next folder draw as one "Top / Mid / Leaf" row, which
 *    files into the deepest folder and folds as one;
 *  - a folder drags with its whole subtree, and dropped on another folder's row it
 *    nests there;
 *  - project labels move with their run, and a slot opened under a label lands in
 *    that project, a folder's cards included;
 *  - a folder's card dropped in another project's run moves there in one write (the
 *    move takes it out of the folder), so it never shows back in its old project.
 *
 * Every test builds its own custom tier and projects, so the layout is exactly what
 * the test made, whatever else the shared fixture server holds.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`)
  return await res.json() as T
}

interface Board {
  tier: string
  A: string
  B: string
  loose: string[]
  top: string
  mid: string
  leaf: string
  leafCards: string[]
  sib: string
  sibCard: string
  bCard: string
}

const made = { tasks: [] as string[], folders: [] as string[], tiers: [] as string[] }

async function task(title: string, project: string, tier: string): Promise<string> {
  const { task: t } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, project, source: 'local' })
  made.tasks.push(t.id)
  await api('POST', `/api/focus/tasks/${t.id}`)
  await api('PUT', `/api/focus/tasks/${t.id}/tier`, { tier })
  return t.id
}

async function folder(label: string, project: string, parentId?: string): Promise<string> {
  const { group_id } = await api<{ group_id: string }>('POST', '/api/tasks/folders', { label, project, ...(parentId ? { parent_id: parentId } : {}) })
  made.folders.unshift(group_id)
  return group_id
}

/** A tier holding project A (two loose cards, Top > Mid > Leaf with two cards, Sib with
 *  one card) and project B (one loose card). */
async function buildBoard(browserName: string): Promise<Board> {
  const stamp = `${browserName.slice(0, 2)}${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`
  const { tier } = await api<{ tier: { id: string } }>('POST', '/api/focus/tiers', { label: `FD ${stamp}` })
  made.tiers.push(tier.id)
  const A = `Drag A ${stamp}`
  const B = `Drag B ${stamp}`
  const loose = [await task(`Loose one ${stamp}`, A, tier.id), await task(`Loose two ${stamp}`, A, tier.id)]
  const top = await folder(`Top ${stamp}`, A)
  const mid = await folder(`Mid ${stamp}`, A, top)
  const leaf = await folder(`Leaf ${stamp}`, A, mid)
  const leafCards = [await task(`Leaf card one ${stamp}`, A, tier.id), await task(`Leaf card two ${stamp}`, A, tier.id)]
  await api('POST', `/api/tasks/groups/${leaf}/add`, { task_ids: leafCards })
  const sib = await folder(`Sib ${stamp}`, A)
  const sibCard = await task(`Sib card ${stamp}`, A, tier.id)
  await api('POST', `/api/tasks/groups/${sib}/add`, { task_ids: [sibCard] })
  const bCard = await task(`B card ${stamp}`, B, tier.id)
  return { tier: tier.id, A, B, loose, top, mid, leaf, leafCards, sib, sibCard, bCard }
}

/** The board opened on this test's tier alone (the panel's section key). */
async function openTier(page: Page, board: Board): Promise<Locator> {
  await presetPanelView(page, { section: board.tier, project: '' })
  await page.goto('/')
  const zone = page.locator(`[data-drop-zone="${board.tier}-drop-zone"]`).first()
  await expect(zone.locator(`[data-task-id="${board.bCard}"]`)).toBeVisible({ timeout: 90_000 })
  return zone
}

const taskOf = async (id: string) => (await api<{ task: { group_id?: string; project?: string } }>('GET', `/api/tasks/${id}`)).task
const folderOf = async (gid: string) => {
  const { groups } = await api<{ groups: Array<{ group_id: string; parent_id?: string; project: string }> }>('GET', '/api/tasks/groups')
  return groups.find((g) => g.group_id === gid)
}

/** `loc`'s box once the rows stopped sliding, where a person would aim: a drag start
 *  re-flows the list (a dragged folder's cards fold away), and WebKit can still be
 *  mid-slide when the drag has just started. */
async function settledBox(page: Page, loc: Locator) {
  await page.waitForTimeout(120)
  let b = (await loc.boundingBox())!
  for (let still = 0, k = 0; still < 2 && k < 30; k++) {
    await page.waitForTimeout(40)
    const n = (await loc.boundingBox())!
    still = Math.abs(n.y - b.y) < 0.5 ? still + 1 : 0
    b = n
  }
  return b
}

/** Press on `from`, glide to the middle of `to` (fy = how far down it), hold, then
 *  `finish` (release, or Escape). Returns what was lit while hovering. */
async function dragOnto(page: Page, zone: Locator, from: Locator, to: Locator, { fy = 0.6, finish = 'drop' }: { fy?: number; finish?: 'drop' | 'escape' } = {}) {
  const a = (await from.boundingBox())!
  const sx = a.x + Math.min(60, a.width / 2)
  const sy = a.y + a.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 3, sy + 6)
  await page.mouse.move(sx + 6, sy + 12)
  const b = await settledBox(page, to)
  const tx = b.x + Math.min(70, b.width / 2)
  const ty = b.y + b.height * fy
  for (let i = 1; i <= 14; i++) await page.mouse.move(sx + (tx - sx) * i / 14, sy + (ty - sy) * i / 14)
  await page.mouse.move(tx, ty + 1)
  await page.waitForTimeout(250)
  const lit = await zone.locator('.task-group-chip-drop').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')))
  const litCards = await zone.locator('.todo-panel-item-group-target').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
  const moved = await zone.locator('.task-group-chip, [data-task-id]').evaluateAll((els) =>
    els.filter((e) => { const t = getComputedStyle(e).transform; return t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)' }).length)
  if (finish === 'escape') await page.keyboard.press('Escape')
  await page.mouse.up()
  return { lit, litCards, moved }
}

/** Creep from `from` until the dragged item's own placeholder sits between `upper` and
 *  `lower` (null = below `upper`, the end of the tier), the way a person watches the
 *  preview before letting go. `lit` = the folder rows lit at that moment. */
async function dragUntilBetween(page: Page, from: Locator, upper: Locator, lower: Locator | null): Promise<{ hit: boolean; labelMoved: boolean; lit: Array<string | null>; framed: number }> {
  const a = (await from.boundingBox())!
  const sx = a.x + Math.min(60, a.width / 2)
  let y = a.y + a.height / 2
  await page.mouse.move(sx, y)
  await page.mouse.down()
  await page.mouse.move(sx + 2, y + 4)
  await page.mouse.move(sx + 4, y + 8)
  y += 8
  let hit = false
  let labelMoved = false
  let lit: Array<string | null> = []
  let framed = 0
  for (let i = 0; i < 200 && !hit; i++) {
    y += 5
    await page.mouse.move(sx + 4, y)
    // Let the rows finish sliding before reading them: a box read mid-transition is
    // neither the old slot nor the new one, and a 5px step can cross a whole slot.
    let p = await from.boundingBox()
    for (let w = 0; w < 12; w++) {
      await page.waitForTimeout(40)
      const again = await from.boundingBox()
      const settled = p && again && Math.abs(again.y - p.y) < 0.5
      p = again
      if (settled) break
    }
    const u = await upper.boundingBox()
    const l = lower ? await lower.boundingBox() : { y: Infinity }
    if (p && u && l && p.y >= u.y + u.height - 4 && p.y + p.height <= l.y + 4) {
      await page.waitForTimeout(250)
      const p2 = (await from.boundingBox())!
      const u2 = (await upper.boundingBox())!
      const l2 = lower ? (await lower.boundingBox())! : { y: Infinity }
      hit = p2.y >= u2.y + u2.height - 4 && p2.y + p2.height <= l2.y + 4
      labelMoved = await upper.evaluate((e) => { const t = getComputedStyle(e).transform; return t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)' })
      lit = await page.locator('.task-group-chip-drop').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')))
      framed = await page.locator('.todo-panel-item-group-target').count()
    }
  }
  await page.mouse.up()
  return { hit, labelMoved, lit, framed }
}

/** The rows as drawn right now, top to bottom (transforms included: the preview). */
const drawnRows = (zone: Locator) => zone.locator('.task-group-chip, [data-task-id], .tier-project-label').evaluateAll((els) => els
  .filter((e) => (e as HTMLElement).offsetParent !== null)
  .map((e) => ({ y: e.getBoundingClientRect().top, id: e.classList.contains('tier-project-label') ? `L:${e.getAttribute('data-project')}` : e.classList.contains('task-group-chip') ? `F:${e.getAttribute('data-group-id')}` : e.getAttribute('data-task-id')! }))
  .sort((a, b) => a.y - b.y).map((r) => r.id))

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of made.tasks.splice(0)) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
  for (const gid of made.folders.splice(0)) await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => {})
  for (const id of made.tiers.splice(0)) await fetch(`${API}/api/focus/tiers/${id}`, { method: 'DELETE' }).catch(() => {})
})

test('folders holding only the next folder draw as one "Top / Mid / Leaf" row; a card dropped on it lands first in Leaf', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()
  // Top and Mid hold no card here: one row names the whole path, at Top's depth.
  await expect(chip(board.top)).toBeVisible()
  await expect(zone.locator(`.task-group-chip[data-group-id="${board.mid}"], .task-group-chip[data-group-id="${board.leaf}"]`)).toHaveCount(0)
  const stamp = board.A.split(' ').at(-1)
  await expect(chip(board.top).locator('.task-group-chip-path')).toHaveAttribute('title', `Top ${stamp} / Mid ${stamp} / Leaf ${stamp}`)
  await expect(chip(board.top)).not.toHaveAttribute('data-folder-depth', /.+/)
  // Leaf's cards sit one step in under that row, like the cards of the top-level Sib.
  expect((await card(board.leafCards[0]).boundingBox())!.x).toBe((await card(board.sibCard).boundingBox())!.x)

  // From above: the row's middle is the gap at the top of Leaf, and the row lights.
  const into = await dragOnto(page, zone, card(board.loose[0]), chip(board.top))
  expect(into.lit).toEqual([board.top])
  expect(into.litCards).toEqual([])
  await expect.poll(async () => (await taskOf(board.loose[0])).group_id, { timeout: 15_000 }).toBe(board.leaf)
  await expect.poll(async () => { const r = await drawnRows(zone); return r[r.indexOf(`F:${board.top}`) + 1] }, { timeout: 15_000 }).toBe(board.loose[0])

  // From below, a member of another folder: the same gap.
  const across = await dragOnto(page, zone, card(board.sibCard), chip(board.top))
  expect(across.lit).toEqual([board.top])
  await expect.poll(async () => (await taskOf(board.sibCard)).group_id, { timeout: 15_000 }).toBe(board.leaf)
  await expect.poll(async () => { const r = await drawnRows(zone); return r[r.indexOf(`F:${board.top}`) + 1] }, { timeout: 15_000 }).toBe(board.sibCard)

  // The row folds and unfolds the whole chain.
  await chip(board.top).locator('.collapse-chevron').click()
  await expect(card(board.leafCards[0])).toBeHidden()
  await chip(board.top).locator('.collapse-chevron').click()
  await expect(card(board.leafCards[0])).toBeVisible()
})

test('a loose card dragged down over a folder\'s cards: its gap only moves with the pointer, and the folder row lights while the gap is inside', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()
  const from = card(board.loose[0])
  const a = (await from.boundingBox())!
  const end = (await card(board.sibCard).boundingBox())!
  const x = a.x + Math.min(60, a.width / 2)
  const y0 = a.y + a.height / 2
  await page.mouse.move(x, y0)
  await page.mouse.down()
  await page.mouse.move(x + 2, y0 + 4)
  await page.mouse.move(x + 4, y0 + 8)
  const samples: Array<{ top: number; lit: string }> = []
  for (let y = y0 + 8; y <= end.y + end.height / 2; y += 6) {
    await page.mouse.move(x + 4, y)
    await page.waitForTimeout(45)
    samples.push({
      top: (await from.boundingBox())!.y,
      lit: (await zone.locator('.task-group-chip-drop').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')).join())),
    })
  }
  await page.keyboard.press('Escape')
  await page.mouse.up()
  // The reported flicker: the gap jumped back each time the pointer crossed a card.
  const back = samples.filter((s, i) => i > 0 && s.top < samples[i - 1].top - 3)
  expect(back, 'the gap never moves back while the pointer moves down').toEqual([])
  const lits = samples.map((s) => s.lit).filter((l, i, all) => i === 0 || l !== all[i - 1])
  expect(lits, 'each folder lights once, in order').toEqual(['', board.top, board.sib])
  await page.waitForTimeout(800)
  expect((await taskOf(board.loose[0])).group_id).toBeUndefined()
})

test('the top band of a folder row and Escape keep the card out of it; a gap between a folder\'s cards files it right there', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()

  // From below, the top band of the Top row: the gap above the folder, so Sib's card
  // leaves its folder and lands right after the loose cards.
  const band = await dragOnto(page, zone, card(board.sibCard), chip(board.top), { fy: 0.1 })
  expect(band.lit).toEqual([])
  await expect.poll(async () => (await taskOf(board.sibCard)).group_id ?? null, { timeout: 15_000 }).toBeNull()
  await expect.poll(async () => { const r = await drawnRows(zone); return r.slice(r.indexOf(board.loose[1]), r.indexOf(`F:${board.top}`) + 1) }, { timeout: 15_000 })
    .toEqual([board.loose[1], board.sibCard, `F:${board.top}`])

  const cancelled = await dragOnto(page, zone, card(board.loose[1]), chip(board.top), { finish: 'escape' })
  expect(cancelled.lit).toEqual([board.top])
  await page.waitForTimeout(800)
  expect((await taskOf(board.loose[1])).group_id).toBeUndefined()
  await expect(zone.locator('.task-group-chip-drop')).toHaveCount(0)

  // A gap between two of Leaf's cards: Leaf's row lights, no card is framed, and the
  // card lands between those two.
  const gap = await dragUntilBetween(page, card(board.loose[0]), card(board.leafCards[0]), card(board.leafCards[1]))
  expect(gap.hit).toBe(true)
  expect(gap.lit).toEqual([board.top])
  expect(gap.framed).toBe(0)
  await expect.poll(async () => (await taskOf(board.loose[0])).group_id, { timeout: 15_000 }).toBe(board.leaf)
  await expect.poll(async () => { const r = await drawnRows(zone); return r.slice(r.indexOf(board.leafCards[0]), r.indexOf(board.leafCards[1]) + 1) }, { timeout: 15_000 })
    .toEqual([board.leafCards[0], board.loose[0], board.leafCards[1]])
})

test('a folder drags with its subtree, and nests when dropped on another folder row', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()
  const label = (p: string) => zone.locator(`.tier-project-label[data-project="${p}"]`).first()

  // Top (with Mid, Leaf and Leaf's cards) goes below Sib's card, still in project A.
  const moved = await dragUntilBetween(page, chip(board.top), card(board.sibCard), label(board.B))
  expect(moved.hit).toBe(true)
  await expect.poll(async () => zone.locator('.task-group-chip, [data-task-id], .tier-project-label').evaluateAll((els) =>
    els.map((e) => e.classList.contains('tier-project-label') ? `L:${e.getAttribute('data-project')}` : e.classList.contains('task-group-chip') ? `F:${e.getAttribute('data-group-id')}` : e.getAttribute('data-task-id'))), { timeout: 15_000 })
    .toEqual([
      `L:${board.A}`, board.loose[0], board.loose[1],
      `F:${board.sib}`, board.sibCard,
      `F:${board.top}`, ...board.leafCards,
      `L:${board.B}`, board.bCard,
    ])
  expect((await folderOf(board.top))?.project).toBe(board.A)

  // Sib dropped on the "Top / Mid / Leaf" row nests in Leaf (Top > Mid > Leaf > Sib),
  // one step in under that row.
  const nest = await dragOnto(page, zone, chip(board.sib), chip(board.top))
  expect(nest.lit).toEqual([board.top])
  await expect.poll(async () => (await folderOf(board.sib))?.parent_id, { timeout: 15_000 }).toBe(board.leaf)
  await expect(chip(board.sib)).toHaveAttribute('data-folder-depth', '1')
})

test('a folder never opens a slot inside another folder: it steps over the whole folder', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  const drawn = () => drawnRows(zone)

  // Sib creeps up through Top > Mid > Leaf until its slot sits right above Top.
  const a = (await chip(board.sib).boundingBox())!
  const x = a.x + Math.min(60, a.width / 2)
  let y = a.y + a.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 2, y - 4)
  await page.mouse.move(x + 4, y - 8)
  y -= 8
  const below = new Set<string>()
  let landed = false
  for (let i = 0; i < 80 && !landed; i++) {
    y -= 5
    await page.mouse.move(x + 4, y)
    // Read the preview once the rows stop sliding (mid-transition orders are neither).
    let rows = await drawn()
    for (let w = 0; w < 15; w++) {
      await page.waitForTimeout(60)
      const again = await drawn()
      const same = again.join() === rows.join()
      rows = again
      if (same) break
    }
    const at = rows.indexOf(`F:${board.sib}`)
    below.add(rows[at + 1])
    landed = rows[at - 1] === board.loose[1] && rows[at + 1] === `F:${board.top}`
  }
  await page.mouse.up()
  expect(landed).toBe(true)
  // Only folder boundaries were ever offered: right above Top, or Sib's own place.
  expect([...below].sort()).toEqual([`F:${board.top}`, `L:${board.B}`].sort())
  await expect.poll(drawn, { timeout: 15_000 }).toEqual([
    `L:${board.A}`, board.loose[0], board.loose[1],
    `F:${board.sib}`, board.sibCard,
    `F:${board.top}`, ...board.leafCards,
    `L:${board.B}`, board.bCard,
  ])
})

test('labels move with their run: a slot under another project label lands in that project', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()
  const label = (p: string) => zone.locator(`.tier-project-label[data-project="${p}"]`).first()

  const cardMove = await dragUntilBetween(page, card(board.loose[0]), label(board.B), card(board.bCard))
  expect(cardMove.hit).toBe(true)
  // The label slid up with the rows that made room, instead of standing still.
  expect(cardMove.labelMoved).toBe(true)
  await expect.poll(async () => (await taskOf(board.loose[0])).project, { timeout: 15_000 }).toBe(board.B)

  // A folder goes below a run's loose cards ("By project" draws folders after them),
  // so its slot in project B opens under B's last card, never above a loose one.
  const folderMove = await dragUntilBetween(page, chip(board.sib), card(board.bCard), null)
  expect(folderMove.hit).toBe(true)
  await expect.poll(async () => (await folderOf(board.sib))?.project, { timeout: 15_000 }).toBe(board.B)
  await expect.poll(async () => (await taskOf(board.sibCard)).project, { timeout: 15_000 }).toBe(board.B)
})

test('a folder\'s card dropped in another project\'s run moves there in one write and never shows back in its old project', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()
  const label = (p: string) => zone.locator(`.tier-project-label[data-project="${p}"]`).first()
  // The project the card is drawn under: the nearest label above it, in DOM order.
  const drawnRun = (id: string) => zone.locator('.tier-project-label, [data-task-id]').evaluateAll((els, cardId) => {
    let run: string | null = null
    for (const e of els) {
      if (e.classList.contains('tier-project-label')) run = e.getAttribute('data-project')
      else if (e.getAttribute('data-task-id') === cardId) return run
    }
    return null
  }, id)
  // The move takes the card out of its folder server-side; a separate ungroup used to
  // refetch the list before the move was written and drew the card in project A again.
  const ungroups: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/tasks/groups/remove')) ungroups.push(r.url()) })

  const mover = board.leafCards[1]
  const moved = await dragUntilBetween(page, card(mover), label(board.B), card(board.bCard))
  expect(moved.hit).toBe(true)
  const seen = new Set<string | null>()
  for (let i = 0; i < 20; i++) {
    seen.add(await drawnRun(mover))
    await page.waitForTimeout(100)
  }
  expect([...seen]).toEqual([board.B])
  await expect.poll(async () => { const t = await taskOf(mover); return `${t.project}|${t.group_id ?? ''}` }, { timeout: 15_000 }).toBe(`${board.B}|`)
  expect(ungroups).toEqual([])
})
