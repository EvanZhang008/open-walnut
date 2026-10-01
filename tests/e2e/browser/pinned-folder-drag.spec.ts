/**
 * Dragging tasks and folders in a pinned tier, with nested folders and two projects.
 *
 * Reported 2026-09-30: a task could not be dragged into a subfolder (a folder whose
 * parent has no card of its own in the tier drew a heading that was not a drop target
 * at all), a folder could not be dragged by such a heading, a dragged folder landed one
 * slot short of its preview when moved down, and the project labels stayed put while
 * the rows around them slid, so a slot was drawn under the wrong project.
 *
 * The rules pinned here, in the order the board answers them:
 *  - the pointer on a folder row means "into this folder": that row alone lights up
 *    and nothing else moves (its top band keeps meaning "a slot above it");
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
  const b = (await to.boundingBox())!
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
 *  preview before letting go. */
async function dragUntilBetween(page: Page, from: Locator, upper: Locator, lower: Locator | null): Promise<{ hit: boolean; labelMoved: boolean }> {
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
    }
  }
  await page.mouse.up()
  return { hit, labelMoved }
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of made.tasks.splice(0)) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
  for (const gid of made.folders.splice(0)) await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => {})
  for (const id of made.tiers.splice(0)) await fetch(`${API}/api/focus/tiers/${id}`, { method: 'DELETE' }).catch(() => {})
})

test('a card drops into a nested subfolder, or into a folder with no card of its own; only that row lights', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()
  // Top and Mid hold no card here, yet both are rows the drag can reach.
  await expect(chip(board.top)).toBeVisible()
  await expect(chip(board.mid)).toBeVisible()
  await expect(chip(board.leaf)).toHaveAttribute('data-folder-depth', '2')

  const into = await dragOnto(page, zone, card(board.loose[0]), chip(board.leaf))
  expect(into.lit).toEqual([board.leaf])
  expect(into.moved).toBe(0)
  await expect.poll(async () => (await taskOf(board.loose[0])).group_id, { timeout: 15_000 }).toBe(board.leaf)

  const ancestor = await dragOnto(page, zone, card(board.loose[1]), chip(board.mid))
  expect(ancestor.lit).toEqual([board.mid])
  await expect.poll(async () => (await taskOf(board.loose[1])).group_id, { timeout: 15_000 }).toBe(board.mid)

  // A member moves into another folder through that folder's row.
  const across = await dragOnto(page, zone, card(board.sibCard), chip(board.leaf))
  expect(across.lit).toEqual([board.leaf])
  await expect.poll(async () => (await taskOf(board.sibCard)).group_id, { timeout: 15_000 }).toBe(board.leaf)
})

test('the top band of a folder row and Escape leave the card where it was; a card\'s middle files it with that card', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  const card = (id: string) => zone.locator(`[data-task-id="${id}"]`).first()

  const band = await dragOnto(page, zone, card(board.loose[0]), chip(board.sib), { fy: 0.1 })
  expect(band.lit).toEqual([])
  await page.waitForTimeout(800)
  expect((await taskOf(board.loose[0])).group_id).toBeUndefined()

  const cancelled = await dragOnto(page, zone, card(board.loose[1]), chip(board.leaf), { finish: 'escape' })
  expect(cancelled.lit).toEqual([board.leaf])
  await page.waitForTimeout(800)
  expect((await taskOf(board.loose[1])).group_id).toBeUndefined()
  await expect(zone.locator('.task-group-chip-drop')).toHaveCount(0)

  // The middle of a card in a folder is "with this card": that card alone lights,
  // nothing slides, and the drop files the card into its folder.
  const withCard = await dragOnto(page, zone, card(board.loose[0]), card(board.sibCard), { fy: 0.5 })
  expect(withCard.litCards).toEqual([board.sibCard])
  expect(withCard.moved).toBe(0)
  await expect.poll(async () => (await taskOf(board.loose[0])).group_id, { timeout: 15_000 }).toBe(board.sib)
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
      `F:${board.top}`, `F:${board.mid}`, `F:${board.leaf}`, ...board.leafCards,
      `L:${board.B}`, board.bCard,
    ])
  expect((await folderOf(board.top))?.project).toBe(board.A)

  // Sib dropped on Leaf's row nests there (Top > Mid > Leaf > Sib).
  const nest = await dragOnto(page, zone, chip(board.sib), chip(board.leaf))
  expect(nest.lit).toEqual([board.leaf])
  await expect.poll(async () => (await folderOf(board.sib))?.parent_id, { timeout: 15_000 }).toBe(board.leaf)
  await expect(chip(board.sib)).toHaveAttribute('data-folder-depth', '3')
})

test('a folder never opens a slot inside another folder: it steps over the whole folder', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const board = await buildBoard(browserName)
  const zone = await openTier(page, board)
  const chip = (gid: string) => zone.locator(`.task-group-chip[data-group-id="${gid}"]`).first()
  // The rows as drawn right now, top to bottom (transforms included: the preview).
  const drawn = () => zone.locator('.task-group-chip, [data-task-id], .tier-project-label').evaluateAll((els) => els
    .filter((e) => (e as HTMLElement).offsetParent !== null)
    .map((e) => ({ y: e.getBoundingClientRect().top, id: e.classList.contains('tier-project-label') ? `L:${e.getAttribute('data-project')}` : e.classList.contains('task-group-chip') ? `F:${e.getAttribute('data-group-id')}` : e.getAttribute('data-task-id')! }))
    .sort((a, b) => a.y - b.y).map((r) => r.id))

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
    `F:${board.top}`, `F:${board.mid}`, `F:${board.leaf}`, ...board.leafCards,
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
