/**
 * The fixer round on the kanban (board-kanban-fixture.ts team, 37 cards, every
 * live state): the hover hold keeps only its own lane and the counts follow the
 * cards drawn (N1), Escape never leaves the Board by accident and closing a
 * menu or the composer gives focus back to the card (N2 N10), the change label
 * has its own line (N3), a card the user adds is not news (N4), Edit waiting
 * on only in a wait lane (N5), the narrow detail (N6 N20), contrast in both
 * themes (N7 N8), `/` (N9), one clock (N11 N12), the chips (N13 N17 N18), the
 * submenu on hover (N14), the suggestion row (N15 N16), the composer's Send
 * (N21), the tag preview (N22), the pinned rail (N23) and a hand back with
 * no board file yet (C57). Chromium and WebKit, real clicks.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, presetHumanPlacement, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOTS = '/tmp/kanban/shots/fix'
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
const inLane = (pane: Locator, lane: string, id: string) => pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="${lane}"] [data-testid="kanban-card"][data-task-id="${id}"]`)
const leaderHeaders = () => ({ 'x-walnut-caller-sid': team.leaderSid })
const activeTestId = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  return a?.getAttribute('data-testid') ?? a?.tagName ?? ''
})

async function letGo(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

/** Every open lane: the head's number is the number of cards drawn under it, and so is the strip's. */
async function countsAgree(pane: Locator): Promise<string[]> {
  return pane.evaluate((root) => {
    const bad: string[] = []
    for (const lane of Array.from(root.querySelectorAll('[data-testid="kanban-lane"]'))) {
      if (lane.getAttribute('data-kind') === 'done' || lane.getAttribute('data-folded') === 'true') continue
      const id = lane.getAttribute('data-lane-id') ?? ''
      const head = Number((lane.querySelector('[data-testid="kanban-lane-count"]')?.textContent ?? '').trim().split(/\s/)[0])
      const drawn = lane.querySelectorAll('[data-testid="kanban-lane-body"] [data-testid="kanban-card"]').length
      if (head !== drawn) bad.push(`${id}: head ${head}, drawn ${drawn}`)
      const strip = root.querySelector(`[data-testid="kanban-lane-strip"] [data-lane-id="${id}"] .kanban-lane-strip-count`)
      if (strip && Number(strip.textContent) !== drawn) bad.push(`${id}: strip ${strip.textContent}, drawn ${drawn}`)
    }
    return bad
  })
}

test('N1: the pointer holds only its own lane; a card it holds says where it goes; counts always match the cards drawn', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const inv = await pane.locator('[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-testid="kanban-card"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id') ?? ''))
  const plain = inv.filter((id) => team.idle.includes(id) && id !== team.handedBack && id !== team.stale)
  expect(plain.length).toBeGreaterThanOrEqual(3)
  // 1. The pointer rests on the empty Mitigating lane: a leader move lands at once, counts agree.
  const mit = pane.locator('[data-testid="kanban-lane"][data-lane-id="mitigating"]')
  const mb = (await mit.boundingBox())!
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height - 20)
  await expect(pane.locator('.kanban-lanes-host')).toHaveAttribute('data-held-lanes', 'mitigating')
  const a = plain[0]
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${a}`, { lane: 'mitigating' }, leaderHeaders())
  await expect(inLane(pane, 'mitigating', a)).toHaveCount(1, { timeout: 3_000 })
  expect(await countsAgree(pane)).toEqual([])
  // 2. The pointer on a card in Investigating: a card leaving that lane stays drawn there, marked, never "Moved".
  const hovered = card(pane, plain[2])
  await hovered.scrollIntoViewIfNeeded()
  const hb = (await hovered.getByTestId('kanban-card-title').boundingBox())!
  await page.mouse.move(hb.x + 10, hb.y + hb.height / 2)
  await expect(pane.locator('.kanban-lanes-host')).toHaveAttribute('data-held-lanes', 'investigating')
  const b = plain[1]
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${b}`, { lane: 'mitigating' }, leaderHeaders())
  await expect(card(pane, b).getByTestId('kanban-card-moving')).toHaveText('Moving to Mitigating', { timeout: 5_000 })
  await expect(inLane(pane, 'investigating', b)).toHaveCount(1)
  await expect(card(pane, b).getByTestId('kanban-card-changed')).toHaveCount(0)
  await expect(pane.locator('[data-testid="kanban-lane-head"][data-lane-id="mitigating"] [data-testid="kanban-lane-incoming"]')).toHaveText('1 incoming')
  expect(await countsAgree(pane)).toEqual([])
  // 3. A phase change of another Investigating card while hovered: the same, the counts still agree.
  const c = plain[3] ?? plain[0]
  if (c !== a) {
    await call(api, 'PATCH', `/api/tasks/${c}`, { phase: 'WAITING' })
    await expect(card(pane, c).getByTestId('kanban-card-moving')).toBeVisible({ timeout: 5_000 })
    expect(await countsAgree(pane)).toEqual([])
  }
  for (let i = 0; i < 4; i++) { await page.waitForTimeout(500); expect(await countsAgree(pane)).toEqual([]) }
  // 4. The pointer leaves: the held lane catches up, with the moved flash.
  await letGo(page)
  await expect(inLane(pane, 'mitigating', b)).toHaveCount(1, { timeout: 3_000 })
  await expect(card(pane, b).getByTestId('kanban-card-moving')).toHaveCount(0)
  await expect(pane.locator('[data-testid="kanban-lane-incoming"]')).toHaveCount(0)
  expect(await countsAgree(pane)).toEqual([])
  // Put them back for the tests after this one.
  for (const id of [a, b]) await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: '' }, leaderHeaders())
  if (c !== a) await call(api, 'PATCH', `/api/tasks/${c}`, { phase: 'NEED_ACTION' }).catch(() => undefined)
})

test('N2 N10: Escape in an empty search, after a menu or after the composer never leaves the Board; focus goes back to the card', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const kb = pane.getByTestId('board-kanban')
  const search = pane.getByTestId('kanban-search')
  await search.click()
  await search.fill(team.tickets[team.idle[0]])
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(kb).toBeVisible()
  const target = card(pane, team.idle[0])
  await target.focus()
  await page.keyboard.press('.')
  await expect(page.getByTestId('kanban-card-menu')).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('kanban-card-menu')).toHaveCount(0)
  await expect(target).toBeFocused()
  await page.keyboard.press('m')
  await expect(target.getByTestId('kanban-card-composer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(target.getByTestId('kanban-card-composer')).toHaveCount(0)
  await expect(target).toBeFocused()
  // The kebab opens the menu: Escape gives focus back to the kebab.
  await target.hover()
  await target.getByTestId('kanban-card-more').click()
  await expect(page.getByTestId('kanban-card-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await activeTestId(page)).toBe('kanban-card-more')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
  await expect(kb).toBeVisible()
  await expect(page.locator('.open-walnut-fullscreen')).toHaveCount(1)
})

test('N3 N4 N22: the change label reads whole on its own line; a card the user adds is not Changed; the tag preview shows the whole ticket', async ({ page }) => {
  test.setTimeout(240_000)
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/kanban-seen`, { cards: 'all' })
  const pane = await openBoard(page)
  await letGo(page)
  const chip = pane.getByTestId('kanban-chip-changed')
  const before = Number(await chip.getAttribute('data-count'))
  // N4 + N22: Add task in New, with tags; the preview chip is not cut.
  const add = pane.locator('[data-testid="kanban-lane"][data-lane-id="new"] [data-testid="kanban-add-task"]')
  await add.click()
  const input = pane.getByTestId('kanban-add-task-input')
  const ticket = `V${1000000190 + (engine === 'webkit' ? 1 : 0)}`
  await input.fill(`${ticket} ticket:${ticket} sev:2 checkout latency`)
  const pill = pane.getByTestId('kanban-add-task-tags').locator('.tag-chip').first()
  await expect(pill).toContainText(ticket)
  expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: `${SHOTS}/${engine}-add-task-typing.png`, clip: (await pane.locator('[data-testid="kanban-lane"][data-lane-id="new"]').boundingBox())! })
  await input.press('Enter')
  const added = pane.locator('[data-testid="kanban-lane-body"][data-lane-id="new"] [data-testid="kanban-card"]').filter({ hasText: 'checkout latency' })
  await expect(added).toHaveCount(1, { timeout: 15_000 })
  const addedId = (await added.getAttribute('data-task-id'))!
  litter.push(addedId)
  await letGo(page)
  // N3: a leader move plus a summary rewrite on an idle card.
  const id = team.idle[1]
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: 'mitigating', summary: 'The leader rewrote this summary after the rollback.' }, leaderHeaders())
  const label = card(pane, id).getByTestId('kanban-card-changed')
  await expect(label).toHaveText(/^Moved by the leader \d{2}:\d{2} \+1$/, { timeout: 10_000 })
  // Round 3 N12: the label takes the foot's one line (cut with a tooltip, `+1` always shown), not a block of its own.
  expect(await label.evaluate((el) => !!el.closest('[data-testid="kanban-card-foot"]') && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height <= 18)).toBe(true)
  expect(await label.getAttribute('title')).toMatch(/^Moved from Investigating by the leader · \d{2}:\d{2}\n\+1 more/)
  await expect(label.locator('.kanban-card-foot-change-more')).toBeVisible()
  await card(pane, id).screenshot({ path: `${SHOTS}/${engine}-leader-moved-card.png` })
  await expect(card(pane, addedId).getByTestId('kanban-card-changed')).toHaveCount(0)
  await expect(card(pane, addedId)).not.toHaveAttribute('data-changed', 'true')
  expect(Number(await chip.getAttribute('data-count'))).toBeGreaterThanOrEqual(before + 1)
  await chip.click()
  await pane.getByTestId('kanban-changes-open').click()
  const log = page.getByTestId('kanban-changes')
  await expect(log).toContainText('moved')
  await expect(log).not.toContainText(`${ticket} new card`)
  await page.keyboard.press('Escape')
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: '' }, leaderHeaders())
})

test('N13 N14 N18: the Sev 1 chip has the count badge every chip has; the workers line says what each bucket is; the search does not move when Changed turns on', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  await letGo(page)
  const sev = pane.getByTestId('kanban-chip-sev')
  await expect(sev).toHaveText(/^Sev 1 \d+$/)
  // One count style: the same badge box on Sev 1 and on Needs you.
  const badge = async (testId: string) => pane.getByTestId(testId).getByTestId('kanban-chip-count').evaluate((el) => {
    const cs = getComputedStyle(el)
    return `${cs.backgroundColor}|${cs.borderRadius}|${cs.fontWeight}`
  })
  expect(await badge('kanban-chip-sev')).toBe(await badge('kanban-chip-stale'))
  const workers = pane.getByTestId('kanban-workers')
  await expect(workers).toContainText('waiting on your answer')
  await expect(workers).toContainText(/\d+ idle/)
  await expect(workers).not.toContainText('asking you')
  await expect(workers).not.toContainText('not running')
  const x0 = (await pane.getByTestId('kanban-search').boundingBox())!.x
  const changed = pane.getByTestId('kanban-chip-changed')
  if (Number(await changed.getAttribute('data-count')) === 0) {
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[2]}`, { summary: 'A fresh word from the leader.' }, leaderHeaders())
    await expect(changed).not.toHaveAttribute('data-count', '0', { timeout: 10_000 })
  }
  await changed.click()
  await expect(pane.getByTestId('kanban-mark-seen')).toBeVisible()
  const x1 = (await pane.getByTestId('kanban-search').boundingBox())!.x
  expect(Math.abs(x1 - x0)).toBeLessThanOrEqual(1)
  await changed.click()
})

test('N5 N14 N11 N12 C57: Edit waiting on outside a wait lane says why; the lane flyout opens on hover; a parked card says its time once; a hand back is red with no board write first', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  // C57: seeded by the worker's own PATCH before anything wrote the board.
  const handed = card(pane, team.handedBack).getByTestId('kanban-card-status')
  await expect(handed).toHaveText(/^Needs you: handed back/)
  await expect(handed).toHaveAttribute('data-tone', 'red')
  // N24: the question's refuse button says what it does.
  const q = card(pane, team.question)
  await expect(q.getByTestId('kanban-card-status')).toHaveAttribute('title', /question/)
  await q.getByTestId('kanban-card-prompt-toggle').click()
  const skip = q.getByRole('button', { name: 'Skip question' })
  await expect(skip).toBeVisible({ timeout: 10_000 })
  await expect(skip).toHaveAttribute('title', /skipped its question/)
  await expect(q.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0)
  await q.getByTestId('kanban-card-prompt-toggle').click()
  // N5: an idle card that is in Investigating now (N1 parked one of them for good).
  const invIds = await pane.locator('[data-testid="kanban-lane-body"][data-lane-id="investigating"] [data-testid="kanban-card"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id') ?? ''))
  const target = card(pane, invIds.find((id) => team.idle.includes(id) && id !== team.handedBack)!)
  await target.hover()
  await target.getByTestId('kanban-card-more').click()
  const waiting = page.getByTestId('kanban-card-menu-waiting')
  await expect(waiting).toHaveAttribute('aria-disabled', 'true')
  await expect(waiting).toHaveAttribute('title', /waiting lane/)
  // N14: hover, no click.
  await page.getByTestId('kanban-card-menu-move').hover()
  await expect(page.getByTestId('kanban-card-move-flyout')).toBeVisible({ timeout: 2_000 })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('kanban-card-menu')).toHaveCount(0)
  // N11 N12: the parked card in Waiting on others.
  const parked = card(pane, team.waiting)
  await parked.scrollIntoViewIfNeeded()
  await expect(parked.getByTestId('kanban-card-status')).toHaveText(/^Waiting until (Today|Tomorrow|Sun|Mon|Tue|Wed|Thu|Fri|Sat|[A-Z][a-z]{2} \d{1,2}) \d{2}:\d{2}$/)
  const row = parked.getByTestId('kanban-card-parked')
  if (await row.count()) await expect(row).not.toContainText('until')
  const tip = await parked.locator('.kanban-card-active').getAttribute('title')
  expect(tip ?? '').not.toMatch(/\b(AM|PM)\b/)
})

test('N15 N16: a suggestion is one line with both buttons and is not repeated in the foot; the 409 says a readable time', async ({ page }) => {
  test.setTimeout(180_000)
  const id = team.idle[4]
  await presetHumanPlacement(api, team, [{ task: id, lane: 'waiting-others' }])
  const res = await fetch(`${API}/api/v1/tasks/${team.leader}/board/cards/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...leaderHeaders() }, body: JSON.stringify({ lane: 'mitigating' }),
  })
  expect(res.status).toBe(409)
  const body = await res.json() as { error: { message: string }; lane_at: string }
  expect(body.error.message).not.toContain(body.lane_at)
  expect(body.error.message).toMatch(/placed this card in "Waiting on others" (today|yesterday) at \d{2}:\d{2}\./)
  const pane = await openBoard(page)
  const c = card(pane, id)
  await c.scrollIntoViewIfNeeded()
  const row = c.getByTestId('kanban-card-suggested')
  await expect(row).toBeVisible()
  const ya = (await c.getByTestId('kanban-card-suggest-accept').boundingBox())!.y
  const yd = (await c.getByTestId('kanban-card-suggest-dismiss').boundingBox())!.y
  expect(Math.abs(ya - yd)).toBeLessThan(2)
  expect((await c.getByTestId('kanban-card-changed').allInnerTexts()).join(' ')).not.toContain('suggests')
  // N23: a card scrolled into view sits beside the pinned rail, not under it.
  const rail = await pane.getByTestId('kanban-done-rail').first().boundingBox()
  const cb = (await c.boundingBox())!
  if (rail) expect(cb.x + cb.width).toBeLessThanOrEqual(rail.x + 1)
  await c.screenshot({ path: `${SHOTS}/${engine}-suggested-card.png` })
  await c.getByTestId('kanban-card-suggest-dismiss').click()
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: '' })
})

/** Text contrast against the composited backgrounds under it (rgba tints included). */
async function contrastOf(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const parse = (c: string) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 } }
    const layers: Array<{ r: number; g: number; b: number; a: number }> = []
    for (let n: Element | null = node; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor)
      if (bg.a > 0) layers.push(bg)
      if (bg.a >= 1) break
    }
    let base = { r: 255, g: 255, b: 255 }
    if (layers.length && layers[layers.length - 1].a >= 1) { const l = layers.pop()!; base = { r: l.r, g: l.g, b: l.b } }
    for (const l of layers.reverse()) base = { r: base.r * (1 - l.a) + l.r * l.a, g: base.g * (1 - l.a) + l.g * l.a, b: base.b * (1 - l.a) + l.b * l.a }
    const fg = parse(getComputedStyle(node).color)
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }
    const a = lum(fg), b = lum(base)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`N7 N8 N23 N9 N21: ${scheme}: small text and the ticket clear 4.5:1, the rail is in view, / finds the search, the composer has Send`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.emulateMedia({ colorScheme: scheme })
    const pane = await openBoard(page)
    // N9: right after the Board chip, before any click in the board.
    await page.keyboard.press('/')
    await expect(pane.getByTestId('kanban-search')).toBeFocused()
    await letGo(page)
    const c = card(pane, team.idle[0])
    const ratios: Record<string, number> = {
      ticket: await contrastOf(c.getByTestId('kanban-card-ticket').locator('.tag-chip-value')),
      foot: await contrastOf(c.locator('.kanban-card-active')),
    }
    const empty = pane.locator('[data-testid="kanban-lane-empty"], .kanban-lane-empty').first()
    if (await empty.count()) ratios.empty = await contrastOf(empty)
    ratios.addTask = await contrastOf(pane.locator('[data-testid="kanban-add-task"]').first())
    for (const [k, v] of Object.entries(ratios)) expect(v, `${scheme} ${k} ${v.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    // N23 (round 3 N4): Resolved's rail is in view at first sight, beside the scrolling lanes, never over them.
    const host = (await pane.getByTestId('kanban-lanes').boundingBox())!
    const kb = (await pane.getByTestId('board-kanban').boundingBox())!
    const rail = (await pane.getByTestId('kanban-done-rail').first().boundingBox())!
    expect(rail.x + rail.width).toBeLessThanOrEqual(kb.x + kb.width + 1)
    expect(rail.x).toBeGreaterThanOrEqual(host.x + host.width - 1)
    await page.screenshot({ path: `${SHOTS}/${engine}-wide-${scheme}.png` })
    // N21
    await c.focus()
    await page.keyboard.press('m')
    const composer = c.getByTestId('kanban-card-composer')
    await expect(composer.getByTestId('kanban-card-composer-send')).toBeVisible()
    const ph = await composer.getByTestId('kanban-card-composer-input').getAttribute('placeholder')
    // R3-24: the worker's title cut at 30, not the ticket alone.
    const t = team.titles[team.idle[0]]
    expect(ph).toBe(`Message ${t.length > 30 ? `${t.slice(0, 30).trimEnd()}\u2026` : t}`)
    await page.keyboard.press('Escape')
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`N6 N20: ${scheme}, 520px: the opened card flows from the top and offers what the card offers`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 520, height: 800 })
    await page.emulateMedia({ colorScheme: scheme })
    const pane = await openBoard(page)
    await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
    await page.screenshot({ path: `${SHOTS}/${engine}-narrow-${scheme}.png` })
    const c = card(pane, team.idle[0])
    await c.scrollIntoViewIfNeeded()
    await c.getByTestId('kanban-card-title').click()
    const detail = pane.getByTestId('kanban-card-detail')
    await expect(detail).toBeVisible()
    const status = (await detail.locator('.kanban-detail-status').boundingBox())!
    const summary = (await detail.getByTestId('kanban-detail-summary').boundingBox())!
    expect(summary.y - (status.y + status.height)).toBeLessThan(24)
    await expect(detail.getByTestId('kanban-detail-ticket').locator('a.tag-chip')).toHaveAttribute('href', /tickets\.example\.test/)
    await expect(detail.getByTestId('kanban-detail-complete')).toBeVisible()
    await expect(detail.getByText('Open beside the board')).toHaveCount(0)
    await detail.getByTestId('kanban-detail-more').click()
    await expect(page.getByTestId('kanban-card-menu-move')).toBeVisible()
    if (scheme === 'dark') expect(await contrastOf(detail.getByTestId('kanban-detail-ticket').locator('.tag-chip-value'))).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: `${SHOTS}/${engine}-narrow-detail-${scheme}.png` })
    await page.keyboard.press('Escape')
    await pane.getByTestId('kanban-detail-back').click()
    await expect(detail).toHaveCount(0)
  })
}
