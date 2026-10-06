/**
 * The fourth fixer round on the kanban (board-kanban-fixture.ts team, 37 cards,
 * every live state), chromium and WebKit, real clicks:
 *   R3-01 cards draw once at their final height (summaries in the first paint)
 *   R3-02 the user's own Complete is never Changed
 *   R3-03 a reload never flashes a Changed count or a guessed writer
 *   R3-04 the change label keeps who and when visible
 *   R3-05 a narrow card opens the task itself (its session) in place of the board
 *   R3-06 the Cards view loads as skeleton lanes
 *   R3-07 R3-08 R3-09 heads, strip, rail and badges agree under a filter
 *   R3-10 .. R3-25 the polish items (weights, markdown, chips, scroll, overlay, toasts, contrast, reload, menu)
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOTS = '/tmp/kanban/shots/r4'
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam
let engine = ''

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
// Each test stands on its own: a failure re-seeds a team for the rest instead of skipping them.
test.describe.configure({ mode: 'default' })

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

/** Real navigation by link click (never page.goto), then the leader's row and its Board chip. */
async function openHome(page: Page): Promise<Locator> {
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
  return panel
}

async function openBoard(page: Page): Promise<Locator> {
  const panel = await openHome(page)
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const leaderHeaders = () => ({ 'x-walnut-caller-sid': team.leaderSid })
const chipCount = (pane: Locator, chip: string) => pane.getByTestId(`kanban-chip-${chip}`).getAttribute('data-count').then(Number)
/** Idle cards with nothing special: not handed back, not stale, not the nested worker's parent. */
const plainIdle = () => team.idle.filter((id) => id !== team.handedBack && id !== team.stale && id !== team.all[9])

async function letGo(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

/** The kanban_seen baseline the server holds (null = never looked). */
async function serverSeen(): Promise<{ at?: string } | null> {
  const b = await call(api, 'GET', `/api/v1/tasks/${team.leader}/board`) as { kanban_seen?: { at?: string } | null }
  return b.kanban_seen ?? null
}

/** Mark everything seen through the UI so Changed starts at 0. */
async function settleBaseline(page: Page, pane: Locator): Promise<void> {
  await expect.poll(async () => !!(await serverSeen())?.at, { timeout: 30_000 }).toBe(true)
  if ((await chipCount(pane, 'changed')) > 0) {
    await pane.getByTestId('kanban-chip-changed').click()
    await pane.getByTestId('kanban-mark-seen').click()
  }
  await expect.poll(() => chipCount(pane, 'changed'), { timeout: 15_000 }).toBe(0)
  await letGo(page)
}

/** Every animation frame from now: the cards drawn, their summaries, one card's height, the skeletons, the pane text. */
async function startSampler(page: Page, watchId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as { __kb: Array<Record<string, unknown>>; __kbStop?: boolean }
    w.__kb = []
    w.__kbStop = false
    const t0 = performance.now()
    const tick = () => {
      if (w.__kbStop) return
      const pane = document.querySelector('[data-testid="task-board-pane"]')
      if (pane) {
        const cards = pane.querySelectorAll('[data-testid="kanban-card"]:not(.kanban-skeleton)').length
        const sums = pane.querySelectorAll('[data-testid="kanban-card-summary"]').length
        const one = pane.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-task-id="${id}"]`)
        const chip = pane.querySelector('[data-testid="kanban-chip-changed"]')
        w.__kb.push({
          ms: Math.round(performance.now() - t0), cards, sums, h: one ? Math.round(one.getBoundingClientRect().height) : -1,
          sk: pane.querySelectorAll('[data-testid="kanban-skeleton"]').length, text: /Loading the board/.test(pane.textContent ?? ''),
          changed: chip ? Number(chip.getAttribute('data-count')) : -1,
          session: /a session/.test(Array.from(pane.querySelectorAll('[data-testid="kanban-card-changed"]')).map((e) => e.getAttribute('title') ?? '').join(' ')),
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, watchId)
}

async function stopSampler(page: Page): Promise<Array<{ ms: number; cards: number; sums: number; h: number; sk: number; text: boolean; changed: number; session: boolean }>> {
  return page.evaluate(() => {
    const w = window as unknown as { __kb: Array<Record<string, unknown>>; __kbStop?: boolean }
    w.__kbStop = true
    return w.__kb as never
  })
}

test('R3-01 R3-06: the Board opens as skeleton lanes, then every card once at its final height', async ({ page }) => {
  test.setTimeout(240_000)
  const panel = await openHome(page)
  // Every board read waits until the test saw the skeleton (4 lanes of 2 cards; 20s at most): a loaded machine never races past it.
  let release = () => {}
  const gate = new Promise<void>((res) => { release = res; setTimeout(res, 20_000) })
  const boardRead = (u: URL) => u.pathname === `/api/v1/tasks/${team.leader}/board` && u.searchParams.get('team') === '1' && !u.searchParams.has('fields')
  await page.route(boardRead, async (r) => {
    await gate
    await r.fallback()
  })
  const watch = plainIdle()[0]
  await startSampler(page, watch)
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban-loading')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => pane.getByTestId('kanban-skeleton').count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(8)
  await page.waitForTimeout(400) // the sheet's open animation ends, the read is still held
  await page.screenshot({ path: `${SHOTS}/${engine}-r306-skeleton.png` })
  release()
  await expect(card(pane, watch).getByTestId('kanban-card-summary')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  const s = await stopSampler(page)
  const drawn = s.filter((x) => x.cards > 0)
  const final = drawn[drawn.length - 1]
  const trace = s.filter((x, i) => i === 0 || x.cards !== s[i - 1].cards || x.sums !== s[i - 1].sums || x.h !== s[i - 1].h).map((x) => `${x.ms}:c${x.cards}:s${x.sums}:h${x.h}:k${x.sk}`).join(' ')
  expect(s.some((x) => x.text), trace).toBe(false)
  expect(final.sums, trace).toBeGreaterThanOrEqual(10)
  // The first frame with cards already holds every summary, and the watched card never changes height.
  expect(drawn[0].sums, trace).toBe(final.sums)
  const hs = drawn.filter((x) => x.h > 0).map((x) => x.h)
  expect(Math.max(...hs) - Math.min(...hs), trace).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `${SHOTS}/${engine}-r301-open.png` })
})

test('R3-02: the user\'s own Complete, Undo and Reopen never count as Changed', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await settleBaseline(page, pane)
  const id = plainIdle()[1]
  const c = card(pane, id)
  await c.scrollIntoViewIfNeeded()
  await c.hover()
  await c.getByTestId('kanban-card-complete').click()
  const toast = page.locator('[data-testid="kanban-toast"]', { hasText: 'Completed' })
  await expect(toast).toBeVisible({ timeout: 10_000 })
  const seenCounts: number[] = []
  for (let i = 0; i < 25; i++) { seenCounts.push(await chipCount(pane, 'changed')); await page.waitForTimeout(100) }
  expect(seenCounts.every((n) => n === 0), seenCounts.join(',')).toBe(true)
  await expect(card(pane, id).getByTestId('kanban-card-changed')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${engine}-r302-completed.png` })
  await toast.getByTestId('kanban-toast-undo').click()
  await expect.poll(async () => ((await call(api, 'GET', `/api/tasks/${id}`)) as { task: { phase: string } }).task.phase, { timeout: 15_000 }).not.toBe('COMPLETE')
  const afterUndo: number[] = []
  for (let i = 0; i < 20; i++) { afterUndo.push(await chipCount(pane, 'changed')); await page.waitForTimeout(100) }
  expect(afterUndo.every((n) => n === 0), afterUndo.join(',')).toBe(true)
  await letGo(page)
})

test('R3-04 R3-17: a leader move says who and when in full, and turning Changed on keeps the search box', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await settleBaseline(page, pane)
  const search = pane.getByTestId('kanban-search')
  const before = (await search.boundingBox())!
  const id = plainIdle()[2]
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: 'mitigating' }, leaderHeaders())
  const label = card(pane, id).getByTestId('kanban-card-changed')
  await expect(label).toHaveText(/^Moved by the leader \d{2}:\d{2}$/, { timeout: 15_000 })
  await expect(label).toHaveAttribute('title', /^Moved from Investigating by the leader \u00b7 \d{2}:\d{2}$/)
  // Who and when are whole: the text is not cut and the time ends inside the card.
  expect(await label.locator('.kanban-card-foot-change-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const at = (await label.getByTestId('kanban-card-changed-at').boundingBox())!
  const cb = (await card(pane, id).boundingBox())!
  expect(at.x + at.width).toBeLessThanOrEqual(cb.x + cb.width - 4)
  await card(pane, id).screenshot({ path: `${SHOTS}/${engine}-r304-moved-label.png` })
  // The card's own worker writing its summary is "the worker" in full, never its own title cut short.
  const own = plainIdle()[3], ownLabel = card(pane, own).getByTestId('kanban-card-changed')
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${own}`, { summary: 'Worker note: the retry storm is contained, watching the error rate.' }, { 'x-walnut-caller-sid': team.sessions[own] })
  await expect(ownLabel).toHaveText(/^Summary by the worker \d{2}:\d{2}$/, { timeout: 15_000 })
  expect(await ownLabel.locator('.kanban-card-foot-change-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await pane.getByTestId('kanban-chip-changed').click()
  await expect(pane.getByTestId('kanban-mark-seen')).toBeVisible()
  const after = (await search.boundingBox())!
  expect([Math.round(after.x), Math.round(after.width), Math.round(after.y)]).toEqual([Math.round(before.x), Math.round(before.width), Math.round(before.y)])
  await page.screenshot({ path: `${SHOTS}/${engine}-r317-changed-on.png` })
  await pane.getByTestId('kanban-chip-changed').click()
  await letGo(page)
})

test('R3-03: the Board opened after a reload never flashes a Changed count or a guessed writer', async ({ page }) => {
  test.setTimeout(300_000)
  const pane = await openBoard(page)
  await settleBaseline(page, pane)
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${plainIdle()[3]}`, { lane: 'mitigating' }, leaderHeaders())
  await expect.poll(() => chipCount(pane, 'changed'), { timeout: 15_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(1000)
  const final = await chipCount(pane, 'changed')
  await page.addInitScript(() => {
    const w = window as unknown as { __kbr: string[] }
    w.__kbr = []
    const tick = () => {
      const chip = document.querySelector('[data-testid="kanban-chip-changed"]')
      const pane = document.querySelector('[data-testid="task-board-pane"]')
      const writer = /a session/.test(Array.from(document.querySelectorAll('[data-testid="kanban-card-changed"]')).map((e) => e.getAttribute('title') ?? '').join(' '))
      w.__kbr.push(`${Math.round(performance.now())}:${pane ? 'P' : '-'}:${chip?.getAttribute('data-count') ?? '-'}:${writer ? 'W' : ''}`)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  for (let i = 0; i < 3; i++) {
    await page.reload()
    // A reload opens the column on its chat, as every split view does: the user opens the Board again.
    await page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`).getByTestId('session-board-chip').click({ timeout: 30_000 })
    await expect(page.getByTestId('task-board-pane').getByTestId('board-kanban')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('task-board-pane').locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(2500)
    const trace = await page.evaluate(() => (window as unknown as { __kbr: string[] }).__kbr)
    const counts = [...new Set(trace.map((x) => x.split(':')[2]).filter((x) => x !== '-'))]
    const changes = trace.filter((x, j) => j === 0 || x.split(':').slice(1).join(':') !== trace[j - 1].split(':').slice(1).join(':'))
    expect(counts, changes.join(' ')).toEqual([String(final)])
    expect(trace.some((x) => x.endsWith(':W')), changes.join(' ')).toBe(false)
    await expect(page.getByTestId('task-board-pane')).toBeVisible() // still open once the page settled
  }
  await page.screenshot({ path: `${SHOTS}/${engine}-r303-after-reloads.png` })
})

const stripTexts = (pane: Locator) => pane.getByTestId('kanban-lane-strip-item').allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, ' ').trim()))

test('R3-07 R3-08 R3-09: under a search the heads, the strip, the rail and the red badges all count the matches', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const search = pane.getByTestId('kanban-search')
  await search.click()
  await search.fill('zzzz no match')
  await expect(pane.getByTestId('kanban-lane-strip')).toBeVisible()
  const strip = await stripTexts(pane)
  // Every strip item reads like its head: `0 / 13`, an empty lane `0`, never `0 / 0` and never the unfiltered total.
  for (const t of strip) expect(t, strip.join(' | ')).toMatch(/^.+ (0 \/ \d+|0)$/)
  expect(strip.join(' | ')).not.toContain('0 / 0')
  await expect(pane.getByTestId('kanban-lane-needs')).toHaveCount(0)
  const heads = await pane.locator('[data-testid="kanban-lane"]').evaluateAll((els) => els.map((e) => e.querySelector('.kanban-lane-head')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''))
  expect(heads.join(' | ')).not.toMatch(/\b0 \/ 0\b/)
  const rail = pane.getByTestId('kanban-done-rail')
  if (await rail.count()) await expect(rail).toHaveText(/ 0 \/ \d+$/)
  await page.screenshot({ path: `${SHOTS}/${engine}-r307-search-nomatch.png` })
  // Needs you: the strip's red numbers match the lane badges.
  await search.fill('')
  await pane.getByTestId('kanban-chip-needs').click()
  const badges = await pane.getByTestId('kanban-lane-needs').allInnerTexts()
  const stripNeeds = await pane.locator('[data-testid="kanban-lane-strip-item"] .kanban-lane-strip-needs').allInnerTexts()
  expect(stripNeeds.map((t) => t.replace(/[()]/g, '')).sort(), `${badges} vs ${stripNeeds}`).toEqual([...badges].sort())
  await pane.getByTestId('kanban-chip-needs').click()
  // R3-09: the done lane's strip item carries the rail's `(N open)` note.
  const railText = (await rail.count()) ? (await rail.innerText()).replace(/\s+/g, ' ') : ''
  const doneStrip = (await stripTexts(pane)).find((t) => t.startsWith('Resolved')) ?? ''
  if (/\(\d+ open\)/.test(railText)) expect(doneStrip).toContain(railText.match(/\(\d+ open\)/)![0])
  else expect(doneStrip).not.toContain('open')
})

test('R3-19 R3-20 R3-21 R3-10 R3-12 R3-13: overflow cue, even lane widths, contrast, one red weight, a neutral ticket link', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const lanes = pane.getByTestId('kanban-lanes')
  await lanes.evaluate((el) => { el.scrollLeft = 0 })
  await expect(lanes).toHaveAttribute('data-more-right', 'true')
  await expect(lanes).not.toHaveAttribute('data-more-left', 'true')
  expect(await lanes.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage)).toContain('gradient')
  // R3-20: every card of every lane has the same width (a scrolling lane reserves no more than the others).
  const widths = await pane.locator('[data-testid="kanban-lane"] [data-testid="kanban-card"]').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().width)))])
  expect(widths.length, widths.join(',')).toBe(1)
  // R3-21: the Workers label reads at 4.5:1 or better on its background.
  const ratio = await pane.locator('.kanban-workers-label').evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
    const lum = (c: number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
    let bg = 'rgb(255, 255, 255)'
    for (let n: Element | null = el; n; n = n.parentElement) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(.*, 0\)$/.test(b) && b !== 'transparent') { bg = b; break } }
    const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(bg))
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
  expect(ratio).toBeGreaterThanOrEqual(4.5)
  // R3-10: every red status line has one weight, whatever element draws it.
  const weights = await pane.locator('.kanban-card-status.kanban-tone-red').evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fontWeight))])
  expect(weights.length, weights.join(',')).toBe(1)
  // R3-12: the ticket chip is neutral, not the Waiting violet; R3-13: hover says it is a link.
  const chip = card(pane, plainIdle()[0]).locator('[data-testid="kanban-card-ticket"] a.tag-chip')
  const style = (l: Locator) => l.evaluate((el) => { const s = getComputedStyle(el); return `${s.color}|${s.backgroundColor}|${s.textDecorationLine}` })
  const rest = await style(chip)
  const [r, g, b] = (rest.split('|')[0].match(/\d+/g) ?? []).map(Number)
  expect(r > g + 30 && b > g + 30, rest).toBe(false)
  expect(await chip.evaluate((el) => getComputedStyle(el, '::after').content)).toContain('\u2197')
  await chip.hover()
  await expect.poll(() => style(chip)).not.toBe(rest)
  await card(pane, plainIdle()[0]).screenshot({ path: `${SHOTS}/${engine}-r312-ticket-hover.png` })
  await page.screenshot({ path: `${SHOTS}/${engine}-r319-board-1280.png` })
})

test('R3-11 R3-24 R3-25: a markdown summary reads as sentences, the composer names the worker, the card menu is opaque', async ({ page }) => {
  test.setTimeout(240_000)
  const id = plainIdle()[4]
  const md = '## Status\n**Mitigated** for now: the shard limit is applied.\n- Root cause: a retry loop on one shard\n- Next: confirm the backfill finished\n\nThe export window reopens at 09:00.'
  await call(api, 'PUT', `/api/tasks/${id}/summary`, { content: md })
  const pane = await openBoard(page)
  const sum = card(pane, id).getByTestId('kanban-card-summary')
  await expect(sum).toHaveAttribute('title', /^Status: Mitigated for now: the shard limit is applied\. Root cause: a retry loop on one shard\. Next: confirm the backfill finished\. The export window/, { timeout: 15_000 })
  await card(pane, id).screenshot({ path: `${SHOTS}/${engine}-r311-markdown.png` })
  // R3-24: `Message <worker title, cut at 30>`.
  const c = card(pane, plainIdle()[0])
  await c.scrollIntoViewIfNeeded()
  await c.hover()
  await c.getByTestId('kanban-card-message').click()
  const t = team.titles[plainIdle()[0]]
  await expect(c.getByTestId('kanban-card-composer-input')).toHaveAttribute('placeholder', `Message ${t.length > 30 ? `${t.slice(0, 30).trimEnd()}\u2026` : t}`)
  await page.keyboard.press('Escape')
  // R3-25: the right click menu paints an opaque background, no glass.
  await c.click({ button: 'right', position: { x: 60, y: 12 } })
  const menu = page.locator('.task-kebab-menu.kanban-menu').first()
  await expect(menu).toBeVisible()
  const bg = await menu.evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, blur: s.backdropFilter || (s as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none' } })
  expect(bg.bg).toMatch(/^rgb\(/)
  expect(bg.blur).toBe('none')
  await page.screenshot({ path: `${SHOTS}/${engine}-r325-menu.png` })
  await page.keyboard.press('Escape')
  await letGo(page)
})

test('R3-14: adding to a full lane keeps the new card and the focused input in view', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const lane = pane.locator('[data-testid="kanban-lane"][data-lane-id="investigating"]')
  await lane.getByTestId('kanban-add-task').scrollIntoViewIfNeeded()
  await lane.getByTestId('kanban-add-task').click()
  const input = lane.getByTestId('kanban-add-task-input')
  await input.pressSequentially('V1000000140 ticket:V1000000140 sev:2 checkout latency', { delay: 5 })
  const inView = (l: Locator) => l.evaluate((el) => {
    const r = el.getBoundingClientRect(), box = (el.closest('[data-testid="kanban-lane"]') as HTMLElement).getBoundingClientRect()
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
  })
  await expect.poll(() => inView(lane.getByTestId('kanban-add-task-tags'))).toBe(true)
  await page.keyboard.press('Enter')
  const added = lane.locator('[data-testid="kanban-card"]', { hasText: 'checkout latency' }).filter({ hasText: 'V1000000140' })
  await expect(added).toHaveCount(1, { timeout: 15_000 })
  const id = await added.getAttribute('data-task-id')
  if (id) litter.push(id)
  await expect(input).toBeFocused()
  await expect.poll(() => inView(added), { timeout: 5_000 }).toBe(true)
  await expect.poll(() => inView(input), { timeout: 5_000 }).toBe(true)
  await page.screenshot({ path: `${SHOTS}/${engine}-r314-added.png` })
  await page.keyboard.press('Escape')
  await letGo(page)
})

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

test('R3-15 R3-16 R3-18: one card copy for keyboard and pointer drags, no hover under a drag, the toast close stays top right', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const [a, b] = plainIdle()
  // R3-15: the keyboard drag's copy is the whole card (title, ids, status, summary), like the pointer's overlay.
  await card(pane, a).focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowRight')
  const ghost = pane.getByTestId('kanban-key-ghost')
  await expect(ghost).toHaveCount(1)
  await expect(ghost.locator('.kanban-card-summary, [data-testid="kanban-card-summary"]')).toHaveCount(1)
  await expect(ghost.locator('[data-testid="kanban-card-status"]')).toHaveCount(1)
  const kh = (await ghost.boundingBox())!.height
  await page.screenshot({ path: `${SHOTS}/${engine}-r315-key-ghost.png` })
  await page.keyboard.press('Escape')
  // R3-16: under a pointer drag, the card under the pointer shows no action bar.
  const target = card(pane, b)
  const tb = (await target.boundingBox())!
  let overlayH = 0
  await dragTo(page, card(pane, a), tb.x + tb.width / 2, tb.y + tb.height - 12, async () => {
    const vis = await target.getByTestId('kanban-card-actions').evaluate((el) => getComputedStyle(el).visibility)
    expect(vis).toBe('hidden')
    overlayH = (await page.locator('.kanban-drag-overlay .kanban-card').first().boundingBox())?.height ?? 0
    await page.screenshot({ path: `${SHOTS}/${engine}-r316-drag-over.png` })
    await page.keyboard.press('Escape')
  })
  expect(Math.abs(overlayH - kh), `${overlayH} vs ${kh}`).toBeLessThanOrEqual(12)
  await letGo(page)
  // R3-18: a drop on the done rail toasts with two actions; the close button keeps the first line's right end.
  const rail = pane.getByTestId('kanban-done-rail')
  if (await rail.count()) {
    // The cancelled drag above may have auto-scrolled the lane: take the card from where it is now.
    await card(pane, b).scrollIntoViewIfNeeded()
    const rb = (await rail.boundingBox())!
    await dragTo(page, card(pane, b), rb.x + rb.width / 2, rb.y + 150)
    const toast = page.locator('[data-testid="kanban-toast"]', { hasText: 'still open' })
    await expect(toast).toBeVisible({ timeout: 10_000 })
    const close = (await toast.getByTestId('kanban-toast-dismiss').boundingBox())!
    const box = (await toast.boundingBox())!
    expect(close.y - box.y, 'close sits on the first line').toBeLessThan(16)
    expect(box.x + box.width - (close.x + close.width), 'close at the right end').toBeLessThan(16)
    await toast.screenshot({ path: `${SHOTS}/${engine}-r318-toast.png` })
    await toast.getByTestId('kanban-toast-dismiss').click().catch(() => undefined)
    // Back to its automatic lane for the next tests (a human write).
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${b}`, { lane: '' })
  }
  await letGo(page)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`R3-05: ${scheme}, 520px: an opened card shows the task itself, its session in place of the board`, async ({ page }) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width: 520, height: 800 })
    await page.emulateMedia({ colorScheme: scheme })
    const pane = await openBoard(page)
    await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
    await page.screenshot({ path: `${SHOTS}/${engine}-r305-narrow-${scheme}.png` })
    const withSession = card(pane, plainIdle()[0])
    await withSession.scrollIntoViewIfNeeded()
    await withSession.getByTestId('kanban-card-title').click()
    const detail = pane.getByTestId('kanban-card-detail')
    await expect(detail).toBeVisible()
    const session = detail.getByTestId('kanban-detail-session')
    await expect(session).toBeVisible()
    await expect(session).toHaveAttribute('data-session-id', team.sessions[plainIdle()[0]] ?? /\S/)
    await expect(session.locator('.session-panel').first()).toBeVisible({ timeout: 20_000 })
    // The chat takes the rest of the pane: no empty half under the card.
    const sb = (await session.boundingBox())!
    const pb = (await pane.boundingBox())!
    const why = `pane ${Math.round(pb.height)}, session ${Math.round(sb.height)}`
    expect(pb.y + pb.height - (sb.y + sb.height), why).toBeLessThan(40)
    expect(sb.height, why).toBeGreaterThan(280)
    // The nested chat is shown, not hidden by the outer panel's collapsed-chat rule: its history and composer.
    await expect(session.locator('.session-panel-body').first()).toBeVisible()
    await expect(session.getByRole('textbox').first()).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `${SHOTS}/${engine}-r305-detail-session-${scheme}.png` })
    await pane.getByTestId('kanban-detail-back').click()
    await expect(detail).toHaveCount(0)
    // A card with no session shows the task's own words (description, subtasks) or says it has none.
    const noSession = await pane.locator('[data-testid="kanban-card"]').evaluateAll((els) => els.find((e) => /No session/.test(e.querySelector('[data-testid="kanban-card-status"]')?.textContent ?? ''))?.getAttribute('data-task-id') ?? '')
    if (noSession) {
      await card(pane, noSession).scrollIntoViewIfNeeded()
      await card(pane, noSession).getByTestId('kanban-card-title').click()
      await expect(detail.getByTestId('kanban-detail-task')).toBeVisible()
      await expect(detail.getByTestId('kanban-detail-task')).not.toHaveAttribute('aria-busy', 'true', { timeout: 10_000 })
      await page.screenshot({ path: `${SHOTS}/${engine}-r305-detail-task-${scheme}.png` })
      await pane.getByTestId('kanban-detail-back').click()
    }
  })

  test(`screens: ${scheme}, 1280 and 520`, async ({ page }) => {
    test.setTimeout(240_000)
    await page.emulateMedia({ colorScheme: scheme })
    const pane = await openBoard(page)
    await page.screenshot({ path: `${SHOTS}/${engine}-board-1280-${scheme}.png` })
    await page.setViewportSize({ width: 520, height: 800 })
    await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow', { timeout: 10_000 })
    await page.waitForTimeout(400)
    // The rollup wraps in a pane this narrow; it never clips `1 task still open`.
    expect(await pane.getByTestId('kanban-rollup').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: `${SHOTS}/${engine}-board-520-${scheme}.png` })
  })
}
