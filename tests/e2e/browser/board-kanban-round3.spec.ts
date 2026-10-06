/**
 * The third fixer round on the kanban (board-kanban-fixture.ts team, 37 cards,
 * every live state), chromium and WebKit, real clicks:
 *   N1  a card held on the pinned Resolved rail stays aimed at it (no autoscroll under it) and lands there
 *   N2  every move into a done lane, by the rail or by the keyboard, toasts `The task is still open`
 *   N3  a keyboard drag shows the lifted card, the drop line, and scrolls its target into view
 *   N4  the rail covers no lane: every lane ends left of it, at rest and scrolled
 *   N5  a reload draws the lanes once: no card marked moved, no reorder under the user
 *   N6  `Leader suggests <lane>` shows the lane name whole
 *   N7 N8 N9 N10 N12  target lane tint, no text selection, card hover lift, pressed chip, one line foot
 *   C12 a card completed after the user placed it, dragged back, stays there after a reload
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOTS = '/tmp/kanban/shots/r3'
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam
let engine = ''

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({}, info) => {
  test.setTimeout(600_000)
  engine = info.project.name
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  team = await seedKanbanTeam(api, { engine, litter })
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** Real navigation by link click (never page.goto), then the leader's Board tab. */
async function openBoard(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: team.project })
  await page.route('https://tickets.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>ticket</p>' }))
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  const row = page.locator(`.todo-panel-item[data-task-id="${team.leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const leaderHeaders = () => ({ 'x-walnut-caller-sid': team.leaderSid })
/** Idle cards with nothing special: not handed back, not stale, not the nested worker's parent (team.all[9]). */
const plainIdle = () => team.idle.filter((id) => id !== team.handedBack && id !== team.stale && id !== team.all[9])

async function letGo(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

async function boardCard(id: string): Promise<{ lane?: string; lane_by?: string } | undefined> {
  const b = await call(api, 'GET', `/api/v1/tasks/${team.leader}/board`) as { cards?: Record<string, { lane?: string; lane_by?: string }> }
  return b.cards?.[id]
}

/** Mouse down on the card's title, past the 6px threshold, then to (x, y); `hold` runs with the button still down. */
async function dragTo(page: Page, from: Locator, x: number, y: number, hold?: () => Promise<void>): Promise<void> {
  const b = (await from.getByTestId('kanban-card-title').boundingBox())!
  await page.mouse.move(b.x + 30, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 45, b.y + b.height / 2 + 10, { steps: 4 })
  await page.mouse.move(x, y, { steps: 20 })
  await page.waitForTimeout(200)
  if (hold) await hold()
  await page.mouse.up()
}

/** The lanes row's scroll offset and the rail's left edge. */
const railState = (pane: Locator) => pane.evaluate((root) => {
  const lanes = root.querySelector('[data-testid="kanban-lanes"]') as HTMLElement
  const rail = root.querySelector('[data-testid="kanban-done-rail"]') as HTMLElement | null
  return { scrollLeft: Math.round(lanes.scrollLeft), railX: rail ? Math.round(rail.getBoundingClientRect().x) : -1, over: !!rail?.classList.contains('is-over') }
})

test('N1 N2: a card held on the pinned rail stays aimed at it, lands in Resolved, and toasts that the task is still open', async ({ page }) => {
  test.setTimeout(240_000)
  const logs: string[] = []
  page.on('console', (m) => { if (/kanban/.test(m.text())) logs.push(m.text().slice(0, 300)) })
  const pane = await openBoard(page)
  const a = plainIdle()[0]
  const rail = pane.getByTestId('kanban-done-rail')
  await expect(rail).toBeVisible()
  await card(pane, a).scrollIntoViewIfNeeded()
  const rb = (await rail.boundingBox())!
  const samples: string[] = []
  await dragTo(page, card(pane, a), rb.x + rb.width / 2, rb.y + 150, async () => {
    // Hold 1.5s on the rail: the lanes must not autoscroll the rail away from the pointer.
    for (let i = 0; i < 6; i++) {
      const s = await railState(pane)
      samples.push(`${i * 250}:${s.scrollLeft}:${s.railX}:${s.over}`)
      await page.waitForTimeout(250)
    }
    await page.screenshot({ path: `${SHOTS}/${engine}-rail-hold.png` })
  })
  const xs = samples.map((s) => Number(s.split(':')[2]))
  expect(Math.max(...xs) - Math.min(...xs), samples.join(' ')).toBeLessThanOrEqual(1)
  expect(samples.every((s) => s.endsWith(':true')), samples.join(' ')).toBe(true)
  await expect.poll(async () => (await boardCard(a))?.lane, { timeout: 10_000 }).toBe('resolved')
  await expect(rail).toContainText('(1 open)')
  const toast = page.locator('[data-testid="kanban-toast"]', { hasText: 'The task is still open.' })
  await expect(toast, logs.join('\n')).toBeVisible({ timeout: 5_000 })
  await expect(toast.getByRole('button', { name: 'Complete task' })).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Always do this' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${engine}-rail-drop-toast.png` })
  await toast.getByRole('button', { name: 'Dismiss' }).click().catch(() => undefined)
  // Back where it was, for the next tests.
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${a}`, { lane: '' })
})

/** True when `el` is fully inside the lanes row's visible box (not scrolled away, not under the rail). */
const inView = (pane: Locator, testId: string) => pane.evaluate((root, tid) => {
  const el = root.querySelector(`[data-testid="${tid}"]`)
  const box = root.querySelector('[data-testid="kanban-lanes"]')?.getBoundingClientRect()
  if (!el || !box) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.left >= box.left - 1 && r.right <= box.right + 1
}, testId)

test('N3 N2: a keyboard drag lifts the card, draws it at the line in view, and a drop into Resolved toasts', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const a = plainIdle()[1]
  const live = pane.getByTestId('kanban-live')
  await card(pane, a).scrollIntoViewIfNeeded()
  await card(pane, a).focus()
  await page.keyboard.press('Space')
  await expect(live).toContainText('Picked up')
  await expect(card(pane, a)).toHaveClass(/is-placeholder/)
  // Three lanes to the right: the target is past the pane's right edge before the drag.
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight')
  await expect(live).toContainText('is over Waiting on others')
  const ghost = pane.getByTestId('kanban-key-ghost')
  await expect(ghost).toHaveCount(1)
  await expect(pane.getByTestId('kanban-drop-line')).toHaveCount(1)
  await expect.poll(() => inView(pane, 'kanban-key-ghost'), { timeout: 3_000 }).toBe(true)
  await page.screenshot({ path: `${SHOTS}/${engine}-kbd-drag-mid.png` })
  // On to the rail: it lights up, nothing hides it.
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')
  await expect(live).toContainText('is over Resolved')
  await expect(pane.getByTestId('kanban-done-rail')).toHaveClass(/is-over/)
  await page.keyboard.press('Space')
  await expect(live).toContainText('dropped in Resolved')
  await expect.poll(async () => (await boardCard(a))?.lane, { timeout: 10_000 }).toBe('resolved')
  const toast = page.locator('[data-testid="kanban-toast"]', { hasText: 'The task is still open.' })
  await expect(toast).toBeVisible({ timeout: 5_000 })
  await expect(toast.getByRole('button', { name: 'Complete task' })).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Always do this' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${engine}-kbd-drop-toast.png` })
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${a}`, { lane: '' })
})

test('N5: a reload lays the lanes out once: no card flashes as moved, no lane re-sorts after first paint', async ({ page }) => {
  test.setTimeout(300_000)
  let pane = await openBoard(page)
  // The statuses that drive the needs-you sort answer late, as on a loaded machine (the verifier's reload saw ~1.6s).
  await page.route('**/api/sessions/status**', async (r) => { await new Promise((res) => setTimeout(res, 1_500)); await r.continue() })
  const trace: string[] = []
  for (let round = 0; round < 3; round++) {
    await page.reload()
    pane = page.getByTestId('task-board-pane')
    const kanban = pane.getByTestId('board-kanban')
    if (!(await kanban.isVisible({ timeout: 20_000 }).catch(() => false))) pane = await openBoard(page)
    let first = ''
    let movedMax = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 3_500) {
      const s = await pane.evaluate((root) => {
        const body = root.querySelector('[data-testid="kanban-lane-body"][data-lane-id="investigating"]')
        const ids = Array.from(body?.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]') ?? []).map((el) => el.dataset.taskId ?? '')
        return { order: ids.join(','), moved: root.querySelectorAll('[data-testid="kanban-card"][data-moved="true"]').length }
      }).catch(() => ({ order: '', moved: 0 }))
      if (s.order && !first) first = s.order
      if (first && s.order && s.order !== first) trace.push(`round ${round} at ${Date.now() - t0}ms: ${first} -> ${s.order}`)
      movedMax = Math.max(movedMax, s.moved)
      await page.waitForTimeout(100)
    }
    expect(first, 'cards drawn').not.toBe('')
    expect(movedMax, `round ${round}: cards marked moved after a reload`).toBe(0)
  }
  expect(trace).toEqual([])
  await page.screenshot({ path: `${SHOTS}/${engine}-after-reload.png` })
})

test('C12: completed after the user placed it, it shows in Resolved and says why; moved back, it stays there after a reload', async ({ page }) => {
  test.setTimeout(240_000)
  const id = plainIdle()[2]
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: 'mitigating' })
  await new Promise((r) => setTimeout(r, 30))
  await call(api, 'POST', `/api/tasks/${id}/complete`, {})
  let pane = await openBoard(page)
  await pane.getByTestId('kanban-done-rail').click()
  const c = card(pane, id)
  await expect(c).toHaveAttribute('data-lane', 'resolved', { timeout: 15_000 })
  await expect(c).toHaveAttribute('data-completed-after-move', 'true')
  expect(await c.getByTestId('kanban-card-status').getAttribute('title')).toContain('Completed after it was placed in Mitigating, so it moved here')
  // Move to lane is the drag's twin (the same move request).
  await c.scrollIntoViewIfNeeded()
  await c.hover()
  await c.getByTestId('kanban-card-more').click()
  await page.getByTestId('kanban-card-menu-move').hover()
  await page.getByTestId('kanban-card-move-flyout').getByRole('menuitemradio', { name: 'Mitigating' }).click()
  await expect(card(pane, id)).toHaveAttribute('data-lane', 'mitigating', { timeout: 10_000 })
  await page.reload()
  pane = page.getByTestId('task-board-pane')
  if (!(await pane.getByTestId('board-kanban').isVisible({ timeout: 20_000 }).catch(() => false))) pane = await openBoard(page)
  await expect(card(pane, id)).toHaveAttribute('data-lane', 'mitigating', { timeout: 15_000 })
  await expect(card(pane, id)).not.toHaveAttribute('data-completed-after-move', 'true')
  await call(api, 'PATCH', `/api/v1/tasks/${id}`, { phase: 'NEED_ACTION' }).catch(() => undefined)
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: '' })
})

test('N6 N11 N12: the suggestion names its lane whole; a leader move shows in the one line foot and never beside Active', async ({ page }) => {
  test.setTimeout(240_000)
  const [s, m] = [plainIdle()[3], team.stale]
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${s}`, { lane: 'waiting-others' })
  const res = await fetch(`${API}/api/v1/tasks/${team.leader}/board/cards/${s}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...leaderHeaders() }, body: JSON.stringify({ lane: 'mitigating' }),
  })
  expect(res.status).toBe(409)
  const pane = await openBoard(page)
  await letGo(page)
  const sug = card(pane, s).getByTestId('kanban-card-suggested')
  await sug.scrollIntoViewIfNeeded()
  const label = sug.locator('.kanban-card-suggested-text')
  await expect(label).toHaveText('Leader suggests Mitigating')
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await expect(sug.getByTestId('kanban-card-suggest-accept')).toBeVisible()
  await card(pane, s).screenshot({ path: `${SHOTS}/${engine}-suggested-card.png` })
  // N12: the change label lives in the foot row; the card keeps its height when it arrives.
  const h0 = (await card(pane, m).boundingBox())!.height
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${m}`, { lane: 'mitigating' }, leaderHeaders())
  const changed = card(pane, m).getByTestId('kanban-card-changed')
  await expect(changed).toHaveText(/^Moved by the leader \d{2}:\d{2}$/, { timeout: 15_000 })
  expect(await changed.evaluate((el) => !!el.closest('[data-testid="kanban-card-foot"]'))).toBe(true)
  expect((await changed.boundingBox())!.height).toBeLessThanOrEqual(18)
  expect(Math.abs((await card(pane, m).boundingBox())!.height - h0)).toBeLessThanOrEqual(1)
  expect(await changed.getAttribute('title')).toMatch(/^Moved from Investigating by the leader/)
  // N11: a stale card never also says Active.
  const foot = (await card(pane, m).getByTestId('kanban-card-foot').innerText()).replace(/\s+/g, ' ')
  expect(foot).toContain('Stale')
  expect(foot).not.toMatch(/Active/)
  await card(pane, m).screenshot({ path: `${SHOTS}/${engine}-what-changed.png` })
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${s}`, { lane: '' })
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${m}`, { lane: '' })
})

const rgb = (s: string): number[] => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
const channelGap = (a: string, b: string) => Math.max(...rgb(a).map((v, i) => Math.abs(v - (rgb(b)[i] ?? 0))))

for (const theme of ['light', 'dark'] as const) {
  test(`N4 N7 N8 N9 N10 (${theme}): the rail covers no lane, the target lane tints, no text selection, cards lift, a pressed chip is on`, async ({ page }) => {
    test.setTimeout(240_000)
    await page.emulateMedia({ colorScheme: theme })
    const pane = await openBoard(page)
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await letGo(page)
    // N4: at rest and scrolled, the lanes row ends left of the rail, and every visible count badge is the top element.
    for (const scroll of [0, 150, 99_999]) {
      const r = await pane.evaluate((root, x) => {
        const lanes = root.querySelector('[data-testid="kanban-lanes"]') as HTMLElement
        lanes.scrollLeft = x
        const rail = root.querySelector('[data-testid="kanban-done-rail"]')!.getBoundingClientRect()
        const box = lanes.getBoundingClientRect()
        const hidden: string[] = []
        for (const b of Array.from(root.querySelectorAll<HTMLElement>('[data-testid="kanban-lane-head"] .kanban-lane-count, [data-testid="kanban-lane-head"] [data-testid="kanban-lane-count"]'))) {
          const c = b.getBoundingClientRect()
          const cx = c.x + c.width / 2, cy = c.y + c.height / 2
          if (cx < box.left || cx > box.right) continue
          const top = document.elementFromPoint(cx, cy)
          if (!top || !(b === top || b.contains(top))) hidden.push(b.closest('[data-lane-id]')?.getAttribute('data-lane-id') ?? '?')
        }
        return { lanesRight: Math.round(box.right), railLeft: Math.round(rail.left), hidden }
      }, scroll)
      expect(r.lanesRight, `scroll ${scroll}`).toBeLessThanOrEqual(r.railLeft)
      expect(r.hidden, `scroll ${scroll}`).toEqual([])
    }
    await pane.evaluate((root) => { (root.querySelector('[data-testid="kanban-lanes"]') as HTMLElement).scrollLeft = 0 })
    // N9: a hovered card lifts.
    const a = card(pane, plainIdle()[0])
    const look = (l: Locator) => l.evaluate((el) => `${getComputedStyle(el).boxShadow}|${getComputedStyle(el).borderColor}`)
    const rest = await look(a)
    await a.hover()
    await expect.poll(() => look(a)).not.toBe(rest)
    // N10: the pressed Needs you chip is filled.
    const needs = pane.getByTestId('kanban-chip-needs')
    const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
    const off = await bg(needs)
    await needs.click()
    await expect(needs).toHaveAttribute('aria-pressed', 'true')
    expect(channelGap(await bg(needs), off)).toBeGreaterThanOrEqual(60)
    await page.screenshot({ path: `${SHOTS}/${engine}-${theme}-needs-pressed.png` })
    await needs.click()
    await letGo(page)
    // N8: a drag across empty lane space selects no text.
    const body = pane.locator('[data-testid="kanban-lane-body"][data-lane-id="new"]')
    const bb = (await body.boundingBox())!
    await page.mouse.move(bb.x + 20, bb.y + bb.height - 20)
    await page.mouse.down()
    await page.mouse.move(bb.x + 600, bb.y + 40, { steps: 12 })
    await page.mouse.up()
    expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBe(0)
    // N7: the lane under a dragged card is clearly tinted, against its own resting panel.
    const lane = pane.locator('[data-testid="kanban-lane"][data-lane-id="mitigating"]')
    const laneRest = await bg(lane)
    await a.scrollIntoViewIfNeeded()
    const lb = (await lane.boundingBox())!
    const ab = (await a.getByTestId('kanban-card-title').boundingBox())!
    await page.mouse.move(ab.x + 30, ab.y + ab.height / 2)
    await page.mouse.down()
    await page.mouse.move(ab.x + 45, ab.y + ab.height / 2 + 10, { steps: 4 })
    await page.mouse.move(lb.x + lb.width / 2, lb.y + 200, { steps: 15 })
    await expect(lane).toHaveClass(/is-over/)
    expect(channelGap(await bg(lane), laneRest)).toBeGreaterThanOrEqual(10)
    await page.screenshot({ path: `${SHOTS}/${engine}-${theme}-drag-over.png` })
    await page.keyboard.press('Escape')
    await page.mouse.up()
  })
}

test('520px: narrow sections in light and dark, no rail, a suggestion and a change label still one tidy card', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 520, height: 800 })
  const pane = await openBoard(page)
  await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
  await expect(pane.getByTestId('kanban-done-rail')).toHaveCount(0)
  await letGo(page)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${SHOTS}/${engine}-narrow-${theme}.png` })
    const needs = pane.getByTestId('kanban-chip-needs')
    await needs.click()
    await expect(needs).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: `${SHOTS}/${engine}-narrow-needs-${theme}.png` })
    await needs.click()
  }
  // No card or label is wider than its section in the narrow column.
  const over = await pane.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]'))
    .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.dataset.taskId ?? ''))
  expect(over).toEqual([])
})
