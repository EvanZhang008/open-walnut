/**
 * The kanban in narrow mode (layout C, a 520px window) and in 248px wide lanes
 * (layout A, 1024px): sections instead of columns, no sideways scroll, the
 * drag between sections, the folded head that opens under a held drag, the
 * card detail that replaces the board, the wide done rail, status lines that
 * show whole, the hover bar that stays in its row, the head that ignores a
 * double click, Add lane, the board signal, the Tab budget (C16 C42 C45 C54
 * C55 C81 C82 C95). Chromium and WebKit, real clicks.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam
let lanesAtStart: unknown[] = []

test.use({ viewport: { width: 520, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({}, info) => {
  test.setTimeout(600_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  team = await seedKanbanTeam(api, { engine: info.project.name, litter })
  lanesAtStart = (await call<{ lanes_effective: unknown[] }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)).lanes_effective
  // One card a human placed in New, so the drag has a source section (one card: the drop target
  // in Investigating stays clear of the auto scroll band at the bottom of an 800px window).
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[3]}`, { lane: 'new' })
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
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  const row = page.locator(`.todo-panel-item[data-task-id="${team.leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  // The task summaries arrive in one read after the cards: wait so nothing grows under a measure.
  await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const lane = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-lane"][data-lane-id="${id}"]`)
const head = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-lane-head"][data-lane-id="${id}"]`)
const laneCards = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="${id}"] [data-testid="kanban-card"]`)
const cardsOf = async () => (await call<{ cards: Record<string, { lane?: string }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)).cards

/** Mouse drag from the card's title (or `grab`) to a point; `whileOver` runs with the button still down. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }, whileOver?: () => Promise<void>, drop = true, grab = 'kanban-card-title'): Promise<void> {
  const b = (await from.getByTestId(grab).boundingBox())!
  await page.mouse.move(b.x + Math.min(40, b.width / 2), b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 50, b.y + b.height / 2 + 8, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.waitForTimeout(150)
  if (whileOver) await whileOver()
  if (drop) await page.mouse.up()
}

const noSideScroll = (el: Locator) => el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)

test('C16: 520px is narrow: sections stacked, no sideways scroll anywhere, Resolved folded, the chips wrap in view', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const kb = pane.getByTestId('board-kanban')
  await expect(kb).toHaveAttribute('data-mode', 'narrow')
  await expect(page.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(1)
  const boxes = await pane.locator('[data-testid="kanban-lane"]').evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { id: e.getAttribute('data-lane-id'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }
  }))
  expect(boxes.map((b) => b.id)).toEqual(['new', 'investigating', 'mitigating', 'waiting-others', 'waiting-cr', 'resolved'])
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].x).toBe(boxes[0].x)
    expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y)
  }
  await expect(pane.getByTestId('kanban-done-rail')).toHaveCount(0)
  await expect(lane(pane, 'resolved')).toHaveAttribute('data-folded', 'true')
  await expect(laneCards(pane, 'resolved')).toHaveCount(0)
  for (const id of ['new', 'investigating', 'mitigating']) await expect(lane(pane, id)).not.toHaveAttribute('data-folded', 'true')
  expect(await noSideScroll(pane)).toBe(true)
  expect(await noSideScroll(pane.getByTestId('kanban-root'))).toBe(true)
  expect(await noSideScroll(pane.getByTestId('kanban-lanes'))).toBe(true)
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth + 1)).toBe(true)
  // Every chip is inside the pane: the row wraps instead of running off.
  const paneBox = (await pane.boundingBox())!
  const chips = pane.getByTestId('kanban-filters').locator('button')
  const n = await chips.count()
  expect(n).toBeGreaterThan(3)
  for (let i = 0; i < n; i++) {
    const b = (await chips.nth(i).boundingBox())!
    expect(b.x + b.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1)
    await expect(chips.nth(i)).toBeVisible()
  }
})

test('C42: a drag from the New section into Investigating lands before its first card, and stays there', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const src = team.idle[3]
  await expect(card(pane, src)).toHaveAttribute('data-lane', 'new')
  const first = laneCards(pane, 'investigating').first()
  const firstId = await first.getAttribute('data-task-id')
  // The source 60px under the sections' top: both ends of the drag clear of the auto scroll bands.
  await pane.getByTestId('kanban-lanes').evaluate((e, id) => {
    const c = e.querySelector(`[data-testid="kanban-card"][data-task-id="${id}"]`)!
    e.scrollTop += c.getBoundingClientRect().top - e.getBoundingClientRect().top - 60
  }, src)
  await page.waitForTimeout(150)
  await expect(first).toBeInViewport()
  const fb = (await first.boundingBox())!
  await drag(page, card(pane, src), { x: fb.x + fb.width / 2, y: fb.y + fb.height * 0.25 }, async () => {
    await expect(pane.locator('[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-testid="kanban-drop-line"]')).toHaveCount(1)
  })
  await expect(card(pane, src)).toHaveAttribute('data-lane', 'investigating', { timeout: 15_000 })
  await expect.poll(async () => (await cardsOf())[src]?.lane, { timeout: 15_000 }).toBe('investigating')
  const ids = await laneCards(pane, 'investigating').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
  expect(ids.indexOf(src)).toBe(ids.indexOf(firstId) - 1)
  // A fresh window draws the same place.
  const other = await (await browser.newContext({ viewport: { width: 520, height: 800 } })).newPage()
  const pane2 = await openBoard(other)
  await expect(card(pane2, src)).toHaveAttribute('data-lane', 'investigating')
  const ids2 = await laneCards(pane2, 'investigating').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
  expect(ids2.indexOf(src)).toBe(ids2.indexOf(firstId) - 1)
  await other.context().close()
})

test('C45: a drag held on a folded head opens it after 600ms; reduced motion turns off the tilt and the flash', async ({ page }) => {
  test.setTimeout(240_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/kanban-seen`, { cards: 'all' })
  const pane = await openBoard(page)
  await page.evaluate(() => {
    const w = window as unknown as { __flashes: number }
    w.__flashes = 0
    new MutationObserver((ms) => { for (const m of ms) if ((m.target as HTMLElement).getAttribute?.('data-flash') === 'true') w.__flashes++ })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-flash'] })
  })
  await expect(lane(pane, 'resolved')).toHaveAttribute('data-folded', 'true')
  // The parked card sits two sections above Resolved: both in view at once.
  // Scrolled to the end, so the auto scroll near the bottom edge has nowhere to go while the drag
  // rests; the grab point (the status line) is clear of the top edge's auto scroll band.
  const src = card(pane, team.waiting)
  await pane.getByTestId('kanban-lanes').evaluate((e) => { e.scrollTop = e.scrollHeight })
  await page.waitForTimeout(150)
  await expect(head(pane, 'resolved')).toBeInViewport()
  await expect(src.getByTestId('kanban-card-title')).toBeInViewport()
  const g = (await src.getByTestId('kanban-card-status').boundingBox())!
  await page.mouse.move(g.x + 30, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(g.x + 40, g.y + g.height / 2 + 10, { steps: 3 })
  const overlay = page.locator('.kanban-drag-overlay')
  await expect(overlay).toBeVisible()
  await expect(overlay).not.toHaveClass(/is-tilted/)
  // Rest on the head where it is now (the sections may have moved under the drag). The 600ms are
  // timed from the first moment the drag is seen over the head, not from the end of the loop: on a
  // loaded machine the three moves alone took longer than 600ms and the lane had opened on time.
  let overAt = 0
  for (let i = 0; i < 3; i++) {
    const hb = (await head(pane, 'resolved').boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2, { steps: 4 })
    if (!overAt && /Resolved/.test(await pane.getByTestId('kanban-live').innerText())) {
      overAt = Date.now()
      expect(await lane(pane, 'resolved').getAttribute('data-folded')).toBe('true')
    }
    await page.waitForTimeout(80)
  }
  await expect(pane.getByTestId('kanban-live')).toContainText('Resolved')
  if (!overAt) { overAt = Date.now(); expect(await lane(pane, 'resolved').getAttribute('data-folded')).toBe('true') }
  await expect(lane(pane, 'resolved')).not.toHaveAttribute('data-folded', 'true', { timeout: 3_000 })
  // Not at once: the head held it folded for most of the 600ms (the probe reads the live text late by up to ~200ms).
  expect(Date.now() - overAt).toBeGreaterThanOrEqual(350)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(card(pane, team.waiting)).toHaveAttribute('data-lane', 'waiting-others')
  await expect(pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="waiting-others"] [data-task-id="${team.waiting}"]`)).toHaveCount(1)
  // The leader changes a card while the user looks: it reads Changed, with no flash.
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[5]}`, { summary: 'Leader note for the narrow board.' }, { 'x-walnut-caller-sid': team.leaderSid })
  await expect(card(pane, team.idle[5])).toHaveAttribute('data-changed', 'true', { timeout: 15_000 })
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => (window as unknown as { __flashes: number }).__flashes)).toBe(0)
})

/** The board as it stands: the sections' scroll and every fold. */
async function boardState(pane: Locator): Promise<{ top: number; folds: Array<string | null> }> {
  const top = await pane.getByTestId('kanban-lanes').evaluate((e) => e.scrollTop)
  const folds = await pane.locator('[data-testid="kanban-lane"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-folded')))
  return { top, folds }
}

test('C55: a tapped card replaces the board; Back and Escape return with the scroll and the folds as they were', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await head(pane, 'mitigating').getByTestId('kanban-lane-toggle').click()
  await expect(lane(pane, 'mitigating')).toHaveAttribute('data-folded', 'true')
  const lanes = pane.getByTestId('kanban-lanes')
  await lanes.evaluate((e) => { e.scrollTop = 420 })
  await page.waitForTimeout(200)
  const before = await boardState(pane)
  expect(before.top).toBeGreaterThan(300)
  // The first card fully inside the scrolled view.
  const id = await lanes.evaluate((host) => {
    const box = host.getBoundingClientRect()
    const hit = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]'))
      .find((c) => { const r = c.getBoundingClientRect(); return r.top > box.top + 30 && r.bottom < box.bottom - 10 })
    return hit?.dataset.taskId ?? ''
  })
  expect(id).not.toBe('')
  for (const leave of ['back', 'escape'] as const) {
    await card(pane, id).getByTestId('kanban-card-title').click()
    const detail = pane.getByTestId('kanban-card-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toHaveAttribute('data-task-id', id)
    await expect(lanes).toBeHidden()
    await expect(pane.getByTestId('kanban-detail-back')).toBeFocused()
    await expect(detail.locator('.kanban-detail-title')).toHaveText(team.titles[id] ?? /\S/)
    if (leave === 'back') await pane.getByTestId('kanban-detail-back').click()
    else await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(lanes).toBeVisible()
    const after = await boardState(pane)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
    expect(after.folds).toEqual(before.folds)
    await expect(card(pane, id)).toBeFocused()
  }
  await head(pane, 'mitigating').getByTestId('kanban-lane-toggle').click()
})

test('C95: a double click on a section head renames nothing; Add lane scrolls in with Add task focused; a board signal opens the Page; Tab reaches the 6th lane in 15', async ({ page, browserName }) => {
  test.setTimeout(300_000)
  const pane = await openBoard(page)
  const name = head(pane, 'investigating').getByTestId('kanban-lane-name')
  const fold = await lane(pane, 'investigating').getAttribute('data-folded')
  await name.dblclick()
  await page.waitForTimeout(300)
  await expect(pane.getByTestId('kanban-lane-rename-input')).toHaveCount(0)
  expect(await lane(pane, 'investigating').getAttribute('data-folded')).toBe(fold)

  // Add lane: the new section scrolls into view, its Add task holds the focus.
  const add = pane.getByTestId('kanban-add-lane')
  await add.scrollIntoViewIfNeeded()
  await add.click()
  await pane.getByTestId('kanban-add-lane-input').fill('Blocked upstream')
  await pane.getByTestId('kanban-add-lane-submit').click()
  const fresh = pane.locator('[data-testid="kanban-lane"]').filter({ has: page.locator('[data-testid="kanban-lane-name"]', { hasText: 'Blocked upstream' }) })
  await expect(fresh).toHaveCount(1, { timeout: 15_000 })
  await expect(fresh).toBeInViewport()
  await expect(fresh.getByTestId('kanban-add-task')).toBeFocused()
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/lanes`, { lanes: lanesAtStart })
  await expect(fresh).toHaveCount(0, { timeout: 15_000 })

  // Tab from the search box to the 6th lane: one stop per card lane and its Add task (G35); a
  // card's own controls are not on the way. The lane heads' fold and kebab buttons (KanbanLaneHead)
  // are stops too: counted apart, the budget of 15 is for the rest.
  // WebKit keeps Safari's default: Tab skips buttons, Option+Tab reaches every control.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
  await pane.getByTestId('kanban-search').focus()
  const path: string[] = []
  while (path.length < 40) {
    await page.keyboard.press(tab)
    const at = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null
      return { lane: a?.closest('[data-testid="kanban-lane"]')?.getAttribute('data-lane-id') ?? '', id: a?.getAttribute('data-testid') ?? a?.tagName ?? '' }
    })
    path.push(`${at.lane}:${at.id}`)
    if (at.lane === 'resolved') break
  }
  const heads = path.filter((x) => /:kanban-lane-(toggle|kebab)$/.test(x)).length
  test.info().annotations.push({ type: 'C95 Tab path', description: JSON.stringify({ presses: path.length, heads, path }) })
  expect(path[path.length - 1]).toMatch(/^resolved:/)
  for (const x of path) expect(x).toMatch(/:(kanban-card|kanban-add-task|kanban-lane-toggle|kanban-lane-kebab)$/)
  expect(path.length - heads).toBeLessThanOrEqual(15)
  // ArrowRight steps into a card's own controls, ArrowLeft back out.
  const c0 = laneCards(pane, 'investigating').first()
  await c0.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => c0.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== el)).toBe(true)
  await page.keyboard.press('ArrowLeft')
  await expect(c0).toBeFocused()

  // A choice on the Page names a card's task: its red status line opens the Page at that choice.
  const filler = Array.from({ length: 40 }, (_, i) => `<p>Timeline entry ${i + 1}: checked the ledger replica lag and the retry queue.</p>`).join('\n')
  const html = `<section><h2>Incident notes</h2>\n${filler}\n<walnut-choice id="c95-ship" title="Ship the retry fix" options="now:Ship it now,later:Wait for the window" task="${team.idle[0]}"></walnut-choice></section>`
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board`, { html })
  const status = card(pane, team.idle[0]).getByTestId('kanban-card-status')
  await expect(status).toHaveText(/^Needs you: /, { timeout: 15_000 })
  await expect(status).toHaveAttribute('data-tone', 'red')
  await status.scrollIntoViewIfNeeded()
  await status.click()
  await expect(pane.getByTestId('board-view-custom')).toHaveAttribute('aria-pressed', 'true')
  await expect(pane.getByTestId('board-kanban')).toBeHidden()
  const choice = pane.frameLocator('iframe.task-board-frame').locator('walnut-choice#c95-ship')
  await expect(choice).toBeInViewport({ timeout: 15_000 })
  await pane.getByTestId('board-view-cards').click()
  await expect(pane.getByTestId('board-kanban')).toBeVisible()
})

test.describe('248px lanes (a 1440 window, the chat open)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('C81: a red status line shows whole in at most 2 lines, the others in 1, wide and narrow', async ({ page, browser }) => {
    test.setTimeout(240_000)
    const pane = await openBoard(page)
    await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'wide')
    const w = await lane(pane, 'investigating').evaluate((e) => e.getBoundingClientRect().width)
    expect(Math.abs(w - 248)).toBeLessThanOrEqual(1)
    const check = async (p: Locator) => {
      const lines = await p.locator('[data-testid="kanban-card-status"]').evaluateAll((els) => els.map((e) => {
        const t = e.querySelector('.kanban-card-status-text') as HTMLElement
        return { tone: e.getAttribute('data-tone'), text: t.textContent ?? '', h: t.clientHeight, sh: t.scrollHeight, lh: parseFloat(getComputedStyle(t).lineHeight) }
      }))
      expect(lines.filter((l) => l.tone === 'red').length).toBeGreaterThanOrEqual(4)
      for (const l of lines) {
        if (l.tone === 'red') {
          expect(l.sh, l.text).toBeLessThanOrEqual(l.h + 1)
          expect(l.h, l.text).toBeLessThanOrEqual(2 * l.lh + 1)
        } else expect(l.h, l.text).toBeLessThanOrEqual(l.lh + 1)
      }
    }
    await check(pane)
    const other = await (await browser.newContext({ viewport: { width: 520, height: 800 } })).newPage()
    const narrow = await openBoard(other)
    await expect(narrow.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
    await check(narrow)
    await other.context().close()
  })

  test('C82: on hover the action bar sits in the foot row, clear of the title, and the card keeps its height', async ({ page }) => {
    test.setTimeout(240_000)
    const pane = await openBoard(page)
    for (const id of [team.perm, team.idle[0], team.longTitle]) {
      const c = card(pane, id)
      await c.scrollIntoViewIfNeeded()
      await page.mouse.move(2, 2)
      const h0 = (await c.boundingBox())!.height
      await expect(c.getByTestId('kanban-card-actions')).toBeHidden()
      await c.getByTestId('kanban-card-foot').hover({ position: { x: 4, y: 12 } })
      const bar = c.getByTestId('kanban-card-actions')
      await expect(bar).toBeVisible()
      const b = (await bar.boundingBox())!
      const foot = (await c.getByTestId('kanban-card-foot').boundingBox())!
      const title = (await c.getByTestId('kanban-card-title').boundingBox())!
      expect(b.y).toBeGreaterThanOrEqual(foot.y - 1)
      expect(b.y + b.height).toBeLessThanOrEqual(foot.y + foot.height + 1)
      const overlaps = b.x < title.x + title.width && title.x < b.x + b.width && b.y < title.y + title.height && title.y < b.y + b.height
      expect(overlaps).toBe(false)
      expect(Math.abs((await c.boundingBox())!.height - h0)).toBeLessThanOrEqual(0.5)
    }
  })

  test('C54: the done lane starts as a 56px rail, opens on a click (kept for the tab), and takes a dropped card', async ({ page }) => {
    test.setTimeout(240_000)
    const pane = await openBoard(page)
    const rail = pane.getByTestId('kanban-done-rail')
    await expect(rail).toHaveText(/^Resolved 23/)
    expect(Math.round((await rail.boundingBox())!.width)).toBe(56)
    await rail.click()
    await expect(lane(pane, 'resolved')).toBeVisible()
    await expect(rail).toHaveCount(0)
    const kept = await page.evaluate((owner) => Object.keys(sessionStorage).filter((k) => k.includes('board-done-rail') && k.includes(owner)).map((k) => sessionStorage.getItem(k)), team.leader)
    expect(kept.length).toBe(1)
    // Close the Board and open it again in this tab: still open.
    const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
    await panel.getByTestId('session-board-chip').click()
    await expect(pane).toHaveCount(0)
    await panel.getByTestId('session-board-chip').click()
    await expect(lane(page.getByTestId('task-board-pane'), 'resolved')).toBeVisible({ timeout: 30_000 })
    // Fold it back to the rail and drop a card on it: the card goes into Resolved.
    await page.getByTestId('task-board-pane').getByTestId('kanban-done-fold').click()
    const pane2 = page.getByTestId('task-board-pane')
    await expect(pane2.getByTestId('kanban-done-rail')).toBeVisible()
    // The source card sits in the lane next to the rail, both in view (pointer out: nothing holds the layout).
    await page.mouse.move(2, 2)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[1]}`, { lane: 'waiting-cr' })
    // Drawn there (data-lane is the card's lane at once; its place follows 400ms after the pointer left).
    const drawnIn = () => card(pane2, team.idle[1]).evaluate((e) => `${e.getAttribute('data-lane')}|${e.closest('[data-testid="kanban-lane-body"]')?.getAttribute('data-lane-id') ?? 'none'}`).catch(() => 'gone')
    await expect.poll(drawnIn, { timeout: 15_000 }).toBe('waiting-cr|waiting-cr')
    await pane2.getByTestId('kanban-lanes').evaluate((e) => { e.scrollLeft = e.scrollWidth })
    await page.waitForTimeout(150)
    const rb = (await pane2.getByTestId('kanban-done-rail').boundingBox())!
    await drag(page, card(pane2, team.idle[1]), { x: rb.x + rb.width / 2, y: rb.y + 120 }, async () => {
      await expect(pane2.getByTestId('kanban-done-rail')).toHaveClass(/is-over/)
    })
    await expect(card(pane2, team.idle[1])).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(async () => (await cardsOf())[team.idle[1]]?.lane, { timeout: 15_000 }).toBe('resolved')
    await expect(pane2.getByTestId('kanban-done-rail')).toHaveText(/^Resolved 24/)
  })
})
