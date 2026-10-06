/**
 * The kanban's layouts and its steadiness under live updates (board-kanban-fixture
 * team): layouts A, B, C (spec 3.0) measured on the real pane and shot light and
 * dark into /tmp/kanban/shots; the fixed header over the sideways scroll and
 * the sticky lane heads; the 600/624 switch that does not flap under the chat
 * divider; the hover that holds the layout while sessions push status; first
 * render time, long tasks, one card re-rendered per status update, and the
 * Page iframe kept across a card-only reload (C37 C38 C50 C51 C67 C96).
 * Chromium and WebKit, real clicks.
 */
import { mkdirSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, getTask, kanbanApi, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOTS = '/tmp/kanban/shots'
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({}, info) => {
  test.setTimeout(600_000)
  mkdirSync(SHOTS, { recursive: true })
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  team = await seedKanbanTeam(api, { engine: info.project.name, litter })
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** Real navigation by link click (never page.goto), then the leader's Board tab. */
async function openBoard(page: Page, beforeBoard?: () => Promise<void>): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: team.project })
  await page.route('https://tickets.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>ticket</p>' }))
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  const row = page.locator(`.todo-panel-item[data-task-id="${team.leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  if (beforeBoard) await beforeBoard()
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  await expect(pane.locator('[data-testid="kanban-card"]').first()).toBeVisible({ timeout: 30_000 })
  // The task summaries arrive in one read after the cards: wait so nothing grows under a measure.
  await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
  return pane
}

/**
 * Layout A (3.0, a ~700px pane). The Board opens its column full screen (SessionPanel:
 * opening a view enters full screen, leaving it closes the view), so a Board inside a
 * Home column (the table's A) does not occur; the same pane width is the chat divider
 * dragged until the Board is 700px wide.
 */
async function toLayoutA(page: Page, pane: Locator): Promise<void> {
  const w = await setPane(page, pane, 700)
  expect(Math.abs(w - 700)).toBeLessThanOrEqual(3)
  await page.mouse.move(2, 2)
  await page.waitForTimeout(300)
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const rootWidth = (pane: Locator) => pane.getByTestId('kanban-root').evaluate((e) => e.clientWidth)
const box = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }

/** No text runs out of its card, no two cards overlap (C37). */
async function checkCards(pane: Locator): Promise<void> {
  const bad = await pane.locator('[data-testid="kanban-lane-body"]').evaluateAll((bodies) => {
    const out: string[] = []
    for (const body of bodies) {
      const cards = Array.from(body.querySelectorAll<HTMLElement>(':scope > [data-testid="kanban-card"], :scope [data-testid="kanban-card"]'))
      const rects = cards.map((c) => c.getBoundingClientRect())
      for (let i = 0; i < cards.length; i++) {
        const r = rects[i]
        for (const el of Array.from(cards[i].querySelectorAll<HTMLElement>('*'))) {
          const e = el.getBoundingClientRect()
          if (e.width === 0 || getComputedStyle(el).visibility === 'hidden') continue
          if (e.right > r.right + 1 || e.left < r.left - 1) out.push(`${cards[i].dataset.taskId} ${el.className} sticks out`)
        }
        for (let j = i + 1; j < cards.length; j++) {
          const q = rects[j]
          if (r.top < q.bottom - 1 && q.top < r.bottom - 1) out.push(`${cards[i].dataset.taskId} overlaps ${cards[j].dataset.taskId}`)
        }
      }
    }
    return out
  })
  expect(bad).toEqual([])
}

async function shots(page: Page, pane: Locator, layout: string, engine: string): Promise<string[]> {
  const out: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    const path = `${SHOTS}/${engine}-${layout}-${scheme}.png`
    await pane.screenshot({ path })
    out.push(path)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  return out
}

const measured: Record<string, number> = {}

test('C37 C51: layout A (Home, chat open) and B (full screen) are wide, C (520px) narrow; shot light and dark; nothing overflows', async ({ page, browser }, info) => {
  test.setTimeout(300_000)
  const engine = info.project.name
  const pane = await openBoard(page)
  // B: the Board as it opens at 1440 (its column full screen, the chat open at its default width).
  await page.mouse.move(2, 2)
  await page.waitForTimeout(300)
  measured.B = await rootWidth(pane)
  await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'wide')
  expect(measured.B).toBeGreaterThanOrEqual(900)
  await checkCards(pane)
  const files = await shots(page, pane, 'layout-b', engine)

  // A: a ~700px pane (the chat divider dragged), still wide.
  await toLayoutA(page, pane)
  measured.A = await rootWidth(pane)
  await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'wide')
  await checkCards(pane)
  files.push(...await shots(page, pane, 'layout-a', engine))

  // C: a 520px window; the Board opens with the chat collapsed.
  const ctx = await browser.newContext({ viewport: { width: 520, height: 800 }, deviceScaleFactor: 1 })
  const small = await ctx.newPage()
  const paneC = await openBoard(small)
  await expect(paneC.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
  await expect.poll(() => rootWidth(paneC)).toBeGreaterThanOrEqual(480)
  measured.C = await rootWidth(paneC)
  expect(measured.C).toBeLessThan(600)
  await checkCards(paneC)
  files.push(...await shots(small, paneC, 'layout-c', engine))
  await ctx.close()
  info.annotations.push({ type: 'kanban-root clientWidth', description: JSON.stringify(measured) })
  info.annotations.push({ type: 'shots', description: files.join(' ') })
  console.log(`[kanban-layout] ${engine} kanban-root clientWidth ${JSON.stringify(measured)} shots ${files.join(' ')}`)
})

test('C38: layout A scrolls the lanes sideways under a fixed header; lane heads stay on top while a lane scrolls', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await toLayoutA(page, pane)
  const lanes = pane.getByTestId('kanban-lanes')
  expect(await lanes.evaluate((e) => e.scrollWidth > e.clientWidth + 100)).toBe(true)
  const fixed = ['kanban-rollup', 'kanban-filters', 'kanban-lane-strip']
  const before = await Promise.all(fixed.map((id) => box(pane.getByTestId(id))))
  await lanes.evaluate((e) => { e.scrollLeft = 420 })
  await page.waitForTimeout(200)
  expect(await lanes.evaluate((e) => e.scrollLeft)).toBeGreaterThan(300)
  const after = await Promise.all(fixed.map((id) => box(pane.getByTestId(id))))
  expect(after).toEqual(before)
  await lanes.evaluate((e) => { e.scrollLeft = 0 })
  // Investigating holds 13 cards: scroll it, its head stays at the lane's top.
  const inv = pane.locator('[data-testid="kanban-lane"][data-lane-id="investigating"]')
  const headBox = () => box(pane.locator('[data-testid="kanban-lane-head"][data-lane-id="investigating"]'))
  const h0 = await headBox()
  expect(await inv.evaluate((e) => e.scrollHeight > e.clientHeight + 200)).toBe(true)
  await inv.evaluate((e) => { e.scrollTop = 600 })
  await page.waitForTimeout(200)
  expect(await inv.evaluate((e) => e.scrollTop)).toBeGreaterThan(400)
  const h1 = await headBox()
  expect(Math.abs(h1.y - h0.y)).toBeLessThanOrEqual(1)
  await expect(pane.locator('[data-testid="kanban-lane-head"][data-lane-id="investigating"]')).toBeInViewport()
})

/** Drag the chat divider until the board pane is `target` px wide (+-3). */
const paneTrail: number[] = []
async function setPane(page: Page, pane: Locator, target: number): Promise<number> {
  const handle = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"] .session-panel-chat-resize`)
  await expect(handle).toHaveCount(1)
  let w = await rootWidth(pane)
  paneTrail.length = 0
  paneTrail.push(w)
  for (let i = 0; i < 8 && Math.abs(w - target) > 3; i++) {
    const b = (await handle.boundingBox())!
    // The grab zone's left half: the chat column paints over its right half and the line itself.
    const x = b.x - 1.5
    // A different height on each try: some heights of the grab zone sit under board content.
    const y = b.y + 60 + ((i * 97) % Math.max(1, b.height - 120))
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (target - w), y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    w = await rootWidth(pane)
    paneTrail.push(w)
  }
  return w
}

test('C51: the switch is 600 down, 624 up: dragging the chat divider between 590 and 630 does not flap', async ({ page }, info) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const kb = pane.getByTestId('board-kanban')
  await kb.evaluate((el) => {
    const w = window as unknown as { __modes: string[] }
    w.__modes = []
    new MutationObserver(() => w.__modes.push(el.getAttribute('data-mode') ?? '')).observe(el, { attributes: true, attributeFilter: ['data-mode'] })
  })
  // 612 sits inside the 600..624 band: wide coming from above, narrow coming from below.
  const steps: Array<[number, 'wide' | 'narrow']> = [[640, 'wide'], [612, 'wide'], [590, 'narrow'], [612, 'narrow'], [630, 'wide'], [612, 'wide']]
  const seen: Array<{ target: number; width: number; mode: string | null }> = []
  for (const [target, mode] of steps) {
    const width = await setPane(page, pane, target)
    expect(Math.abs(width - target), `pane width for ${target}: ${paneTrail.join(' > ')}`).toBeLessThanOrEqual(3)
    await expect(kb).toHaveAttribute('data-mode', mode)
    seen.push({ target, width, mode: await kb.getAttribute('data-mode') })
  }
  // Exactly two switches: down at 590, up at 630.
  expect(await page.evaluate(() => (window as unknown as { __modes: string[] }).__modes)).toEqual(['narrow', 'wide'])
  info.annotations.push({ type: 'divider sweep', description: JSON.stringify(seen) })
})

test('C67: a hover holds the layout while sessions push status and a card parks; 400ms after the pointer leaves, it moves', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const inv = pane.locator('[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-testid="kanban-card"]')
  const ids = await inv.evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id') ?? ''))
  // The hovered card sits below an idle card that is about to park itself.
  const parker = ids.find((id) => team.idle.includes(id) && ![team.handedBack, team.stale, team.all[9]].includes(id) && ids.indexOf(id) + 2 < ids.length)!
  const hovered = card(pane, ids[ids.indexOf(parker) + 2])
  await hovered.scrollIntoViewIfNeeded()
  const tb = (await hovered.getByTestId('kanban-card-title').boundingBox())!
  await page.mouse.move(tb.x + 10, tb.y + tb.height / 2)
  const b0 = await box(hovered)
  let n = 0
  const pushes = setInterval(() => {
    n++
    for (const sid of team.runningSids) void call(api, 'PATCH', `/api/sessions/${sid}`, { activity: `Checking shard ${n}` }).catch(() => undefined)
  }, 2000)
  try {
    await call(api, 'PATCH', `/api/tasks/${parker}`, { phase: 'WAITING' })
    for (let t = 0; t < 20; t++) {
      await page.waitForTimeout(500)
      expect(await box(hovered)).toEqual(b0)
    }
    // Still drawn where it was while the pointer is in the lanes.
    await expect(pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-task-id="${parker}"]`)).toHaveCount(1)
  } finally {
    clearInterval(pushes)
  }
  expect(n).toBeGreaterThanOrEqual(4)
  await page.evaluate(() => {
    const w = window as unknown as { __moved: string[] }
    w.__moved = []
    const note = (el: Element) => { if (el.getAttribute('data-moved') === 'true') w.__moved.push(el.getAttribute('data-task-id') ?? '') }
    // A card that changed lanes mounts in its new lane already marked: watch insertions too.
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'attributes') note(m.target as Element)
        for (const n of Array.from(m.addedNodes)) if (n instanceof Element) { note(n); n.querySelectorAll('[data-moved="true"]').forEach(note) }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-moved'] })
  })
  await page.mouse.move(2, 2)
  await page.waitForTimeout(150)
  await expect(pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-task-id="${parker}"]`)).toHaveCount(1)
  const moved = pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="waiting-others"] [data-task-id="${parker}"]`)
  await expect(moved).toHaveCount(1, { timeout: 3_000 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __moved: string[] }).__moved)).toContain(parker)
  // Nobody ordered these: needs you first, then sev ascending, then created old to new.
  const order = await inv.evaluateAll((els) => els.map((e) => ({
    id: e.getAttribute('data-task-id') ?? '',
    red: e.querySelector('[data-testid="kanban-card-status"]')?.getAttribute('data-tone') === 'red',
    sev: Number((e.querySelector('[data-testid="kanban-card-sev"]')?.textContent ?? 'Sev 9').replace('Sev ', '')),
  })))
  // created_at, not the ticket number: the seeded stall was created days before the rest.
  const created = new Map<string, number>()
  for (const c of order) created.set(c.id, Date.parse((await getTask(api, c.id))?.created_at ?? '') || 0)
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1]
    const b = order[i]
    const rank = (c: typeof a) => [c.red ? 0 : 1, c.sev, created.get(c.id) ?? 0]
    const [ra, rb] = [rank(a), rank(b)]
    const cmp = ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
    expect(cmp, `${a.id} before ${b.id}`).toBeLessThanOrEqual(0)
  }
})

/** Long tasks from now on (Chromium; WebKit has no longtask entries: null). */
const watchLongTasks = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __long: number[] | null }
  if (!(PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')) { w.__long = null; return false }
  w.__long = []
  const at = window as unknown as { __longAt: string[] }
  at.__longAt = []
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      w.__long!.push(Math.round(e.duration))
      at.__longAt.push(`${Math.round(e.duration)}ms@${new Date(performance.timeOrigin + e.startTime).toISOString().slice(14, 23)}`)
    }
  }).observe({ type: 'longtask' })
  return true
})
const longTasks = (page: Page) => page.evaluate(() => (window as unknown as { __long: number[] | null }).__long)

/** The page's main-thread CPU so far in ms (CDP thread ticks), on Chromium; null elsewhere. */
async function cpuClock(page: Page, engine: string): Promise<(() => Promise<number>) | null> {
  if (engine !== 'chromium') return null
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable', { timeDomain: 'threadTicks' })
  return async () => ((await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000
}
// A wall clock budget holds only below one runnable process per core: above, it measures the CPU queue.
const quiet = () => loadavg()[0] < cpus().length
// Main-thread CPU budgets (React dev build, 37 cards), measured 290-360ms to open and 240-440ms for the
// drag below; an inline callback ref that re-measured the pane on every render made them 560-650 and 820-960.
const OPEN_CPU_MS = 500
const DRAG_CPU_MS = 600

test('C50: 37 cards are on screen and live within 1s of the Board click; a drag makes no long task over 100ms', async ({ page }, info) => {
  test.setTimeout(240_000)
  const clock: { read: (() => Promise<number>) | null; at: number } = { read: null, at: 0 }
  const pane = await openBoard(page, async () => {
    clock.read = await cpuClock(page, info.project.name)
    clock.at = clock.read ? await clock.read() : 0
    await page.evaluate(() => { (window as unknown as { __t0: number }).__t0 = performance.now() })
  })
  const openCpu = clock.read ? Math.round((await clock.read()) - clock.at) : null
  const r = await page.evaluate(() => {
    const m = performance.getEntriesByName('kanban:interactive').pop() as PerformanceMark | undefined
    return m ? { ms: Math.round(m.startTime - (window as unknown as { __t0: number }).__t0), cards: (m.detail as { cards: number }).cards } : null
  })
  expect(r).not.toBeNull()
  const load = Math.round(loadavg()[0])
  info.annotations.push({ type: 'first render to interactive', description: JSON.stringify({ ...r, openCpu, load, cores: cpus().length }) })
  console.log(`[kanban-layout] ${info.project.name} first render to interactive ${JSON.stringify({ ...r, openCpu, load })}`)
  expect(r!.cards).toBeGreaterThanOrEqual(37)
  if (openCpu !== null) expect(openCpu).toBeLessThan(OPEN_CPU_MS)
  if (quiet()) expect(r!.ms).toBeLessThan(1000)
  // A drag across two lanes and back, cancelled: no long task over 100ms.
  const supported = await watchLongTasks(page)
  const dragAt = clock.read ? await clock.read() : 0
  const src = pane.locator('[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-testid="kanban-card"]').nth(1)
  await src.scrollIntoViewIfNeeded()
  const t = (await src.getByTestId('kanban-card-title').boundingBox())!
  const target = (await pane.locator('[data-testid="kanban-lane-body"][data-lane-id="mitigating"]').boundingBox())!
  await page.mouse.move(t.x + 20, t.y + t.height / 2)
  await page.mouse.down()
  await page.mouse.move(t.x + 40, t.y + t.height / 2 + 10, { steps: 3 })
  await expect(page.locator('.kanban-drag-overlay')).toBeVisible()
  await page.mouse.move(target.x + 60, target.y + 40, { steps: 20 })
  await page.mouse.move(t.x + 40, t.y + 80, { steps: 20 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(pane.getByTestId('kanban-live')).toHaveText(/cancel/i)
  const long = await longTasks(page)
  const dragCpu = clock.read ? Math.round((await clock.read()) - dragAt) : null
  info.annotations.push({ type: 'drag long tasks ms', description: supported ? JSON.stringify({ long, dragCpu, load: Math.round(loadavg()[0]) }) : 'longtask not supported in this engine' })
  console.log(`[kanban-layout] ${info.project.name} drag ${JSON.stringify({ long, dragCpu, load: Math.round(loadavg()[0]) })}`)
  if (dragCpu !== null) expect(dragCpu).toBeLessThan(DRAG_CPU_MS)
  if (supported && quiet()) expect(Math.max(0, ...(long ?? []))).toBeLessThanOrEqual(100)
})

const renders = (page: Page) => page.evaluate(() => ({ ...((window as unknown as { __kanbanCardRenders?: Record<string, number> }).__kanbanCardRenders ?? {}) }))

test('C96: 30s of status pushes: no long task over 50ms, the hovered card holds still, activity text at most every 2s, one card per update, card reloads keep the Page frame', async ({ page }, info) => {
  test.setTimeout(300_000)
  const filler = Array.from({ length: 12 }, (_, i) => `<p>Shift note ${i + 1}: queue depth back to normal.</p>`).join('\n')
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board`, { html: `<section><h2>Shift notes</h2>\n${filler}</section>` })
  const pane = await openBoard(page)
  // Boot the Page once, mark its frame, back to Cards (the frame stays mounted, hidden).
  await pane.getByTestId('board-view-custom').click()
  const frame = pane.locator('iframe.task-board-frame')
  await expect(frame).toBeVisible({ timeout: 15_000 })
  await frame.evaluate((el) => el.setAttribute('data-probe', 'kept'))
  await pane.getByTestId('board-view-cards').click()
  await expect(pane.getByTestId('board-kanban')).toBeVisible()

  const busy = team.running[0]
  await page.evaluate((id) => {
    const w = window as unknown as { __act: Array<{ t: number; text: string }> }
    w.__act = []
    const el = document.querySelector(`[data-testid="kanban-card"][data-task-id="${id}"] [data-testid="kanban-card-status"]`)!
    new MutationObserver(() => w.__act.push({ t: performance.now(), text: el.textContent ?? '' })).observe(el, { subtree: true, childList: true, characterData: true })
  }, busy)
  const hovered = pane.locator('[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-testid="kanban-card"]').nth(5)
  await hovered.scrollIntoViewIfNeeded()
  const hb = (await hovered.getByTestId('kanban-card-title').boundingBox())!
  await page.mouse.move(hb.x + 10, hb.y + hb.height / 2)
  const b0 = await box(hovered)
  // The 30s of pushes stay clear of the wall clock minute: the minute tick (every relative time
  // on every card) is not a status push, and C96 measures what the pushes cost.
  const sec0 = new Date().getSeconds()
  if (sec0 > 25) await page.waitForTimeout((62 - sec0) * 1000)
  expect(await box(hovered)).toEqual(b0)
  const supported = await watchLongTasks(page)
  // Every 2s each running session moves; the busy one pushes every 700ms on top (the throttle's job).
  let n = 0
  const slow = setInterval(() => {
    n++
    for (const sid of team.runningSids.slice(1)) void call(api, 'PATCH', `/api/sessions/${sid}`, { activity: `Scanning partition ${n}` }).catch(() => undefined)
  }, 2000)
  let m = 0
  const fast = setInterval(() => { m++; void call(api, 'PATCH', `/api/sessions/${team.runningSids[0]}`, { activity: `Replaying batch ${m}` }).catch(() => undefined) }, 700)
  try {
    for (let t = 0; t < 30; t++) {
      await page.waitForTimeout(1000)
      expect(await box(hovered)).toEqual(b0)
    }
  } finally {
    clearInterval(slow)
    clearInterval(fast)
  }
  const long = await longTasks(page)
  const act = await page.evaluate(() => (window as unknown as { __act: Array<{ t: number; text: string }> }).__act)
  const changes = act.filter((a, i) => i === 0 || a.text !== act[i - 1].text)
  const gaps = changes.slice(1).map((a, i) => Math.round(a.t - changes[i].t))
  const longAt = await page.evaluate(() => (window as unknown as { __longAt?: string[] }).__longAt ?? [])
  info.annotations.push({ type: 'C96 raw', description: JSON.stringify({ pushesSlow: n, pushesFast: m, long: supported ? long : 'unsupported', longAt, activityChanges: changes.length, gaps }) })
  console.log('[kanban-layout] C96 long tasks', info.project.name, JSON.stringify(longAt))
  expect(changes.length).toBeGreaterThanOrEqual(5)
  for (const g of gaps) expect(g).toBeGreaterThanOrEqual(1900)
  if (supported) expect(Math.max(0, ...(long ?? []))).toBeLessThanOrEqual(50)

  // One status update re-renders one card (clear of a minute tick, which may touch every foot).
  await page.mouse.move(2, 2)
  await page.waitForTimeout(2500)
  const sec = new Date().getSeconds()
  if (sec > 40) await page.waitForTimeout((62 - sec) * 1000)
  const before = await renders(page)
  await call(api, 'PATCH', `/api/sessions/${team.runningSids[1]}`, { activity: 'One last look' })
  await expect(card(pane, team.running[1]).getByTestId('kanban-card-status')).toHaveText('Running: One last look', { timeout: 10_000 })
  await page.waitForTimeout(800)
  const after = await renders(page)
  const grew = Object.keys(after).filter((id) => (after[id] ?? 0) > (before[id] ?? 0))
  info.annotations.push({ type: 'C96 re-rendered on one update', description: JSON.stringify(grew.map((id) => [id, (after[id] ?? 0) - (before[id] ?? 0)])) })
  expect(grew).toEqual([team.running[1]])

  // A card write reloads the kanban fields only (no html), and the Page frame is the same element.
  const boardReads: string[] = []
  page.on('request', (r) => { const u = new URL(r.url()); if (r.method() === 'GET' && /\/board$/.test(u.pathname)) boardReads.push(u.search) })
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[0]}`, { summary: 'Queue drained, watching for a repeat.' }, { 'x-walnut-caller-sid': team.leaderSid })
  await expect(card(pane, team.idle[0]).getByTestId('kanban-card-summary')).toHaveText('Queue drained, watching for a repeat.', { timeout: 15_000 })
  expect(boardReads.length).toBeGreaterThanOrEqual(1)
  for (const q of boardReads) expect(q).toContain('fields=kanban')
  await expect(pane.locator('iframe.task-board-frame[data-probe="kept"]')).toHaveCount(1)
  info.annotations.push({ type: 'C96 board reads after a card write', description: JSON.stringify(boardReads) })
})
