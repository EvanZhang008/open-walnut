/**
 * Phone session overlay, round 3 (N2-06, N2-07, N2-08, N2-09, N2-10, C19):
 * each test pins one defect a reviewer found in the session overlay on a
 * phone at real density. WebKit with devices['iPhone 15'] first, chromium too.
 *
 * The session's record, history and task are stubbed per test, so nothing
 * here reaches the fixture's CLI; the home rows come from the fixture.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, findSmallTargets, findSmallText } from './phone-helpers'

const SHOTS = '/tmp/mobile-web/phone-session-r3'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

// A/B proof that the tests pin this round's fixes: PW_R3_WITHOUT_FIX=1 serves
// the round's phone stylesheet empty (the dev server loads it as a module).
test.beforeEach(async ({ page }) => {
  if (!process.env.PW_R3_WITHOUT_FIX) return
  await page.route('**/styles/phone-session-r3.css*', (route) => route.fulfill({ contentType: 'text/javascript', body: 'export {}' }))
})

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const overlayOf = (page: Page, sid: string) => page.locator(`.session-panel.is-phone-layer[data-session-id="${sid}"]`)
const subtitle = (page: Page) => page.locator('.phone-topbar .phone-topbar-subtitle')
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })

function historyOf(turns: number) {
  const msgs: Record<string, unknown>[] = []
  for (let i = 1; i <= turns; i++) {
    msgs.push({ role: 'user', text: `Request ${i} for the shed inventory`, timestamp: iso(90_000 - i * 1000), msgId: `u-${i}` })
    msgs.push({ role: 'assistant', text: `Working on request ${i}. `.repeat(25), timestamp: iso(89_000 - i * 1000), msgId: `a-${i}` })
  }
  return msgs
}

/** A route that answers only when the test lets it go. */
function held() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  return { gate, release }
}

interface StubOpts {
  sid: string
  taskId: string
  status?: string
  turns?: number
  /** Answer the task fetch with this task (a task the home list does not carry). */
  task?: Record<string, unknown>
  /** Hold the record until this resolves. */
  recordGate?: Promise<void>
  /** Hold every history read until this returns a resolved promise. */
  historyGate?: () => Promise<void>
}

async function stubSession(page: Page, o: StubOpts): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
  const messages = historyOf(o.turns ?? 2)
  await page.route(`**/api/sessions/${o.sid}`, async (route: Route) => {
    if (o.recordGate) await o.recordGate
    await route.fulfill({ json: {
      session: { claudeSessionId: o.sid, taskId: o.taskId, project: 'Walnut', process_status: o.status ?? 'running', mode: 'default',
        startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: messages.length, title: 'Round three fixture' },
      pendingPermissions: [],
    } }).catch(() => undefined)
  })
  await page.route(`**/api/sessions/${o.sid}/history**`, async (route: Route) => {
    if (o.historyGate) await o.historyGate()
    await route.fulfill({ json: { messages, cursor: messages.length, delta: false } }).catch(() => undefined)
  })
  if (o.task) {
    await page.route(`**/api/tasks/${o.taskId}`, (route: Route) => route.request().method() === 'GET'
      ? route.fulfill({ json: { task: o.task } })
      : route.fallback())
  }
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/**
 * Tap a home row once the list has stopped moving: rows load in above it for a
 * moment after boot (reported to the home fixer), and a tap during that shift
 * lands on nothing. Unfolds the project and pages in rows like openHomeRow.
 */
async function tapSettledHomeRow(page: Page, project: string, title: string): Promise<void> {
  const header = page.locator('.todo-panel .todo-group-project-header', {
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${project}$`) }),
  }).first()
  await expect(header).toBeVisible({ timeout: 30_000 })
  if (/to expand/.test((await header.getAttribute('title')) ?? '')) await header.click({ position: { x: 48, y: 22 } })
  const row = page.locator('.todo-panel .todo-item-title', { hasText: title }).first()
  for (let i = 0; i < 8 && await row.count() === 0; i++) {
    const more = page.locator('.todo-panel').getByRole('button', { name: 'Show more' }).first()
    if (await more.count() === 0) break
    await more.scrollIntoViewIfNeeded()
    await more.click()
  }
  let last = Number.NaN
  await expect.poll(async () => {
    const top = await row.evaluate((el) => { el.scrollIntoView({ block: 'center' }); return Math.round(el.getBoundingClientRect().top) })
    const still = top === last
    last = top
    return still
  }, { intervals: [400], timeout: 15_000 }).toBe(true)
  await row.click()
}

const waitingTask = (id: string, sid: string) => ({
  id, title: 'Waiting on the seed order', status: 'in_progress', phase: 'WAITING', priority: 'none', project: 'Walnut',
  source: 'local', session_ids: [sid], active_session_ids: [sid], session_id: sid,
  wait_until: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  created_at: iso(86_400_000), updated_at: iso(60_000), description: '', summary: '', note: '', subtasks: [],
})

test('N2-06: keyboard up, a Waiting task\'s line folds away, its words move to the placeholder, the timeline keeps 300 px', async ({ page }) => {
  const sid = 'pw-r3-waiting-session'
  const taskId = 'pw-r3-waiting-task'
  const errors = await stubSession(page, { sid, taskId, task: waitingTask(taskId, sid) })
  // The spec's keyboard budget screen: 390 x 844.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/?s1=${sid}`)
  const panel = overlayOf(page, sid)
  await expect(panel.locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 30_000 })
  const line = panel.getByTestId('session-waiting-line')
  await expect(line).toBeVisible({ timeout: 15_000 })
  // What the line says while it shows is also what the empty field says.
  await expect(panel.locator('.session-panel-input textarea').first()).toHaveAttribute('placeholder', 'Message: moves it to In Progress')
  await page.evaluate(() => {
    const r = document.documentElement.style
    r.setProperty('--wn-safe-top', '47px')
    r.setProperty('--wn-keyboard-inset', '336px')
    document.documentElement.dataset.wnKeyboard = 'open'
  })
  await expect(line).toBeHidden()
  await expect.poll(async () => Math.round((await panel.locator('.session-history').boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(300)
  // One row, and nothing in it is cut: the controls the + menu holds take no
  // room (an invisible in-flow pill clipped the mode word to 'Bypas').
  const bar = panel.locator('.session-panel-input .session-mode-bar').first()
  const ghosts = await bar.evaluate((b) => Array.from(b.querySelectorAll<HTMLElement>('button'))
    .filter((el) => { const cs = getComputedStyle(el); return cs.visibility === 'hidden' && cs.position !== 'absolute' && el.getBoundingClientRect().width > 2 })
    .map((el) => el.getAttribute('aria-label') ?? el.textContent))
  expect(ghosts).toEqual([])
  const mode = bar.locator('[data-control-id="mode"] .mode-toggle-pill')
  expect(await mode.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await shot(page, 'n2-06-waiting-keyboard')
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--wn-keyboard-inset', '0px')
    document.documentElement.dataset.wnKeyboard = 'closed'
  })
  await expect(line).toBeVisible()
  expect(errors).toEqual([])
})

const plainTask = (id: string, sid: string) => ({ ...waitingTask(id, sid), title: 'Sorting the shed', phase: 'IN_PROGRESS', wait_until: undefined })

test('N2-08, C19: the timeline\'s own controls take a finger and read 12 px (trigger fold, Load earlier, task chips)', async ({ page }) => {
  const sid = 'pw-r3-chrome-session'
  const taskId = 'pw-r3-chrome-task'
  const errors = await stubSession(page, { sid, taskId, task: plainTask(taskId, sid) })
  await page.goto(`/?s1=${sid}`)
  const panel = overlayOf(page, sid)
  await expect(panel.locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 30_000 })
  // Chrome the live sessions draw and the fixture's do not, with the real class names.
  await panel.locator('.session-history').evaluate((h) => {
    const wrap = document.createElement('div')
    wrap.setAttribute('data-testid', 'r3-chrome')
    wrap.innerHTML = '<button type="button" class="session-show-earlier-btn">Load earlier turns</button>'
      + '<div class="provenance-card"><button type="button" class="provenance-fold"><span class="provenance-label">Trigger</span><span>It is 09:00 at the shed</span></button></div>'
      + '<p>A step <span class="tool-run-fail">1</span> failed, '
      + '<span class="bg-tasks-chip"><span class="bg-tasks-chip-icon">ok</span><span class="bg-tasks-chip-label">Seed count</span><span class="bg-tasks-chip-status">Done</span></span>'
      + ' <span class="task-group-model">small</span></p>'
    h.insertBefore(wrap, h.firstChild)
    h.scrollTop = 0
  })
  await page.waitForTimeout(300)
  const small = await findSmallTargets(page, '[data-testid="r3-chrome"]')
  expect(small, JSON.stringify(small)).toEqual([])
  const tiny = await findSmallText(page, 12, '[data-testid="r3-chrome"]')
  expect(tiny, JSON.stringify(tiny)).toEqual([])
  expect(errors).toEqual([])
})

test('N2-10: before the record loads the bar says nothing, or what the home row said, never a made-up Stopped', async ({ page }) => {
  const sid = 'pw-r3-slow-record'
  const taskId = 'pw-r3-slow-task'
  const record = held()
  const errors = await stubSession(page, { sid, taskId, task: plainTask(taskId, sid), recordGate: record.gate })
  const seen: string[] = []
  await page.exposeFunction('__r3Sub', (t: string) => { if (seen[seen.length - 1] !== t) seen.push(t) })
  await page.addInitScript(() => {
    const tick = () => {
      const el = document.querySelector('.phone-topbar .phone-topbar-back') ? document.querySelector('.phone-topbar .phone-topbar-subtitle') : null
      if (document.querySelector('.phone-topbar .phone-topbar-back')) (window as unknown as { __r3Sub: (t: string) => void }).__r3Sub(el?.textContent ?? '')
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.goto(`/?s1=${sid}`)
  await expect(page.locator('.phone-topbar .phone-topbar-back')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)
  // The record is held: no status is known yet, so none is claimed.
  await expect(subtitle(page)).toHaveCount(0)
  record.release()
  await expect(subtitle(page)).toHaveText('Running', { timeout: 15_000 })
  expect(seen.filter((t) => t === 'Stopped'), JSON.stringify(seen)).toEqual([])
  expect(errors).toEqual([])
})

test('N2-09: a tapped session draws its bar and composer at once, and a second open draws the turns it already showed', async ({ page }) => {
  const sid = 'pw-question-recovery-session'
  let gate = held()
  const errors = await stubSession(page, { sid, taskId: 'pw-task-question-recovery', turns: 3, historyGate: () => gate.gate })
  await page.goto('/')
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  await tapSettledHomeRow(page, 'Walnut', 'Question recovery fixture')
  const panel = overlayOf(page, sid)
  // History held: the layer is not blank. Its bar and its composer are there now.
  await expect(page.locator('.phone-topbar .phone-topbar-title-text')).toHaveText('Question recovery fixture', { timeout: 15_000 })
  await expect(panel.locator('.session-panel-input textarea').first()).toBeVisible({ timeout: 1_000 })
  await shot(page, 'n2-09-first-frame')
  gate.release()
  await expect(panel.locator('[data-message-id="a-3"]')).toBeAttached({ timeout: 15_000 })
  await page.locator('.phone-topbar .phone-topbar-back').click()
  await expect(panel).toBeHidden({ timeout: 10_000 })
  // Second open, the read held again: what was shown is shown at once, then refreshed.
  gate = held()
  await tapSettledHomeRow(page, 'Walnut', 'Question recovery fixture')
  await expect(overlayOf(page, sid).locator('[data-message-id="a-3"]')).toBeVisible({ timeout: 1_500 })
  await expect(overlayOf(page, sid).getByText('No conversation history found')).toHaveCount(0)
  gate.release()
  expect(errors).toEqual([])
})

test('C19: a Board\'s card chips and its Status view read 12 px and take a finger (live board density)', async ({ page }) => {
  const sid = 'pw-question-recovery-session'
  const taskId = 'pw-task-question-recovery'
  const put = await page.request.put(`/api/v1/tasks/${taskId}/board`, { data: { html: '<h1>Shed board</h1><p>Seed order and beds.</p>' } })
  expect(put.ok(), await put.text()).toBe(true)
  try {
    const errors = await stubSession(page, { sid, taskId })
    await page.goto(`/?s1=${sid}`)
    await expect(overlayOf(page, sid).locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 30_000 })
    await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
    await page.getByTestId('phone-row-board').click()
    const pane = page.getByTestId('task-board-pane')
    await expect(pane).toBeVisible({ timeout: 15_000 })
    // What a team board draws at real density (a ticket, a Sev, a project
    // filter, the Status view's kicker, chips, rows and flags), with the real classes.
    await pane.evaluate((p) => {
      const wrap = document.createElement('div')
      wrap.setAttribute('data-testid', 'r3-board')
      wrap.innerHTML = '<div class="kanban-lane-head"><span class="kanban-lane-needs">1</span></div>'
        + '<div class="kanban-card"><div class="kanban-card-title">Order seeds</div><div class="kanban-card-ids">'
        + '<span class="kanban-card-ticket"><a class="tag-chip tag-chip-inline" href="#t"><span class="tag-chip-value">T-12</span></a></span>'
        + '<span class="kanban-card-sev kanban-sev-2">Sev 2</span><button type="button" class="kanban-card-project">Beds</button></div></div>'
        + '<div class="board-status"><div class="bs-who">Board · Lead</div>'
        + '<div class="bs-filters"><button type="button" class="bs-chip is-on">All open <b>14</b></button>'
        + '<button type="button" class="bs-chip bs-chip-needs"><span class="bs-dot"></span><b>2</b> Needs you</button></div>'
        + '<table class="bs-table"><thead><tr><th class="bs-c-status">Status</th><th>Task</th><th>Where it stands</th><th>Next · who</th><th class="bs-c-when">Updated</th></tr></thead>'
        + '<tbody><tr class="bs-row bs-row-needs"><td class="bs-c-status"><span class="bs-pill bs-pill-needs"><span class="bs-dot"></span>Needs you</span></td>'
        + '<td class="bs-c-task"><span class="bs-title">Order seeds</span><span class="bs-sub">Under Beds</span></td>'
        + '<td class="bs-c-where"><span class="bs-now">Two vendors quoted.</span><span class="bs-stale">No update in 2 days</span></td>'
        + '<td class="bs-c-next"><span class="bs-you"><b>You:</b> Pick a vendor?</span><button type="button" class="bs-act">Answer on the Page</button></td>'
        + '<td class="bs-c-when">14h</td></tr></tbody></table></div>'
        + '<span class="task-board-bar-sub">v3, updated 5 days ago</span>'
      p.insertBefore(wrap, p.firstChild)
    })
    for (const width of [390, 375, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 })
      await page.waitForTimeout(300)
      await page.getByTestId('r3-board').evaluate((w) => w.scrollIntoView({ block: 'start' }))
      const small = await findSmallTargets(page, '[data-testid="r3-board"]')
      expect(small, `${width}: ${JSON.stringify(small)}`).toEqual([])
      const tiny = await findSmallText(page, 12, '[data-testid="r3-board"]')
      expect(tiny, `${width}: ${JSON.stringify(tiny)}`).toEqual([])
    }
    expect(errors).toEqual([])
  } finally {
    await page.request.delete(`/api/v1/tasks/${taskId}/board`).catch(() => undefined)
  }
})

test('N2-07: in dark mode the session menu is opaque too', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const sid = 'pw-r3-menu-session'
  const taskId = 'pw-r3-menu-task'
  const errors = await stubSession(page, { sid, taskId, task: plainTask(taskId, sid) })
  await page.goto(`/?s1=${sid}`)
  await expect(overlayOf(page, sid).locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 30_000 })
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu').first()
  await expect(menu).toBeVisible()
  const bg = await menu.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).toMatch(/^rgb\(|, 1\)$/)
  await shot(page, 'n2-07-dark-menu')
  expect(errors).toEqual([])
})
