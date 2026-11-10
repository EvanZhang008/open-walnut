/**
 * REAL-PIPELINE spec for the usage-limit wait (src/core/sessions/usage-limit-wait.ts): a turn the
 * subscription's usage limit refused shows the Limited banner in place of the error banner, the
 * task's row reads "[Limited] resets <time>" first under Waiting, and the banner's three buttons do
 * what they say.
 *
 * Nothing is route-mocked but ui-prefs. quick-start → MockDaemon spawns the mock Claude CLI → its
 * `limit-error:<reset epoch secs>` mode writes the CLI's real limit lines (rate_limit_event
 * rejected, the blocked assistant message, the error result) → ClaudeCodeSession hands the facts
 * to the waiter → session record + user status → the browser.
 */
import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSectionCard, statusSectionToggle } from './status-section-helpers'

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/usage-limit-spec'
const COLUMNS_KEY = 'open-walnut-home-session-columns'

test.setTimeout(240_000)

const litter: { tasks: string[]; sessions: string[] } = { tasks: [], sessions: [] }

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.sessions = []
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 800 })
})

test.afterEach(async ({ request }) => {
  for (const sid of litter.sessions) await request.post(`/api/sessions/${sid}/terminate`).catch(() => undefined)
  for (const id of litter.tasks) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

type Rec = { process_status?: string; usageLimit?: { state?: string; resetsAt?: string } }

async function sessionOf(request: APIRequestContext, sid: string): Promise<Rec> {
  const b = (await (await request.get(`/api/sessions/${sid}`)).json().catch(() => ({}))) as { session?: Rec }
  return b.session ?? {}
}

async function limitedSession(request: APIRequestContext, title: string, resetInSecs: number, project?: string, focus = false): Promise<{ taskId: string; sid: string }> {
  const pin = focus ? { pinned: true, focus_tier: 'focus' } : { pinned: false }
  const res = await request.post('/api/tasks', { data: { title: `${title} (${test.info().project.name})`, source: 'local', ...pin, ...(project ? { project } : {}) } })
  expect(res.ok(), await res.text()).toBe(true)
  const taskId = ((await res.json()) as { task: { id: string } }).task.id
  litter.tasks.push(taskId)
  const dirs = (await (await request.get('/api/sessions/working-dirs')).json()) as { dirs: Array<{ cwd: string }> }
  const cwd = dirs.dirs.find((d) => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))?.cwd
  expect(cwd, 'ps-fixture/projects/walnut seed').toBeTruthy()
  const reset = Math.floor(Date.now() / 1000) + resetInSecs
  const start = await request.post('/api/sessions/quick-start', { data: { cwd, message: `limit-error:${reset}`, taskId } })
  expect(start.ok(), await start.text()).toBe(true)
  const { sessionId: sid } = (await start.json()) as { sessionId: string }
  litter.sessions.push(sid)
  await expect.poll(async () => (await sessionOf(request, sid)).usageLimit?.state, { timeout: 90_000 }).toBe('waiting').catch(async (err) => {
    const rec = await (await request.get(`/api/sessions/${sid}`)).text()
    const hist = await (await request.get(`/api/sessions/${sid}/history`)).text()
    throw new Error(`${err}\nrecord: ${rec.slice(0, 3000)}\nhistory: ${hist.slice(0, 3000)}`)
  })
  return { taskId, sid }
}

/** Display > status sentences on (off by default since 2026-11-06): the Flat rows' third line. */
async function showStatusLines(page: Page): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('open-walnut-view:tasks.statusLines', 'true') } catch { /* storage off */ } })
}

async function seedColumns(page: Page, sids: string[]): Promise<void> {
  await page.addInitScript(({ key, ids }) => {
    try { sessionStorage.setItem(key, JSON.stringify(ids.map((id) => ({ id, locked: false })))) } catch { /* ignore */ }
  }, { key: COLUMNS_KEY, ids: sids })
}

const columnFor = (page: Page, sid: string): Locator =>
  page.locator('.main-page-sessions-area > .main-page-session-column').filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })

async function shot(page: Page, loc: Locator, name: string, pad = 24): Promise<void> {
  // The list may still move (a row re-sorts, a line appears above it): clip once the box holds.
  let box = await loc.boundingBox()
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(150)
    const next = await loc.boundingBox()
    if (next && box && next.x === box.x && next.y === box.y && next.height === box.height) break
    box = next
  }
  expect(box, `${name}: element has a box`).not.toBeNull()
  const vp = page.viewportSize()!
  const x = Math.max(0, box!.x - pad)
  const y = Math.max(0, box!.y - pad)
  const clip = { x, y, width: Math.min(vp.width - x, box!.width + 2 * pad), height: Math.min(vp.height - y, box!.height + 2 * pad) }
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-${name}.png`), clip, animations: 'disabled' })
}

test('a limited session: the banner, the Limited row, and its three buttons', async ({ page, request }) => {
  const { taskId, sid } = await limitedSession(request, 'Usage limit banner', 3 * 3600)

  await presetPanelDesign(page, 'status')
  await showStatusLines(page)
  await seedColumns(page, [sid])
  await page.goto('/')
  const col = columnFor(page, sid)
  await expect(col).toHaveCount(1, { timeout: 30_000 })
  const banner = col.getByTestId('usage-limit-banner')

  // 1. Waiting: the Limited banner, never the red error banner, says when it resets and continues.
  await expect(banner).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 })
  await expect(banner).toContainText(/Claude 5-hour limit reached · resets (\w{3}\s)?\d{1,2}:\d{2}\s[AP]M/)
  await expect(banner).toContainText(/Walnut continues it by itself at (\w{3}\s)?\d{1,2}:\d{2}\s[AP]M \(in [23] h( \d+ min)?\)\./)
  // What Continue now costs before the reset, in the banner itself, not only in a tooltip.
  await expect(banner).toContainText('Continue now tries sooner; if the limit still holds, it just waits again.')
  // Calm, not the red error banner (which it replaces), and below the glass header, not under it.
  await expect(col.locator('.session-error-banner:not(.usage-limit-banner)')).toHaveCount(0)
  const head = await col.locator('.session-panel-header').first().boundingBox()
  const box = await banner.boundingBox()
  expect(box!.y, 'the banner starts below the header').toBeGreaterThanOrEqual(head!.y + head!.height - 1)
  // One row: the icon beside the words, never on a line of its own, and the buttons inside the box
  // (the base error banner stacks its children; this one must not inherit that).
  const icon = (await banner.locator('.usage-limit-banner-icon').boundingBox())!
  const body = (await banner.locator('.usage-limit-banner-body').boundingBox())!
  expect(icon.x + icon.width, 'the icon sits left of the words').toBeLessThanOrEqual(body.x + 1)
  expect(Math.abs(icon.y - body.y), 'the icon and the words share a line').toBeLessThan(12)
  for (const b of await banner.locator('.usage-limit-btn').all()) {
    const bb = (await b.boundingBox())!
    expect(bb.x + bb.width, 'a button stays inside the banner').toBeLessThanOrEqual(box!.x + box!.width + 1)
  }
  await expect(banner.getByRole('button', { name: 'Continue now' })).toBeVisible()
  await expect(banner.getByRole('button', { name: "Don't auto-continue" })).toBeVisible()
  // Before the reset a continue may meet the limit again: one name for it, but not the primary
  // button, and its tooltip says what happens.
  await expect(banner.getByRole('button', { name: 'Continue now' })).not.toHaveClass(/is-primary/)
  await expect(banner.getByRole('button', { name: 'Continue now' })).toHaveAttribute('title', /may stop again; then Walnut waits for the reset/)
  await shot(page, banner, '1-banner-waiting')

  // 2. The task's row: Waiting, first in it, "[Limited] resets <time>". Over the sections a line says a limit
  // holds sessions, and takes you to them; a folded Waiting heading still says it too.
  await setStatusSectionOpen(page, 'waiting', false)
  const summary = page.getByTestId('status-limit-summary')
  await expect(summary).toHaveText(/^Limited\s*(\d+ waiting · \d+ needs? you|\d+ waiting|\d+ needs? you)\s*Next reset (\w{3}\s)?\d{1,2}:\d{2}\s[AP]M$/, { timeout: 30_000 })
  await expect(summary).toHaveAttribute('title', /stopped by a usage limit/)
  // Two lines, the counts and the next reset, neither cut.
  for (const part of ['.status-limit-summary-counts', '.status-limit-summary-when']) {
    expect(await summary.locator(part).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), part).toBe(true)
  }
  const [c, w] = [await summary.locator('.status-limit-summary-counts').boundingBox(), await summary.locator('.status-limit-summary-when').boundingBox()]
  expect(w!.y).toBeGreaterThan(c!.y + c!.height - 2)
  await shot(page, summary, '2-limit-summary', 8)
  // Each count leads to its own rows.
  await summary.getByTestId('status-limit-summary-waiting').click()
  await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'true')
  // It brings the limited rows into view and marks them a moment.
  const flashed = page.locator(`.status-section-card.is-limit-flash[data-task-id="${taskId}"]`)
  await expect(flashed).toHaveCount(1, { timeout: 5_000 })
  await expect(flashed).toBeInViewport()
  // The topmost limited row at the top of the list, just under the stuck headings, never mid-list
  // under unrelated rows. Another worker's limited rows may sit above this one, so the check reads
  // the topmost of the rows the count led to (the ones it marks), not this task's. Not "the first
  // row wearing the Limited tag": a row the summary counts (its task has a limit) can be drawn
  // without the tag for a moment while another worker's session continues (its state is no longer
  // waiting), and the count scrolls to that row, leaving the first tagged one a few rows lower
  // (CI 2026-11-10: "at 150", "at 210", "at 270", a row's height apart).
  const firstLedId = await page.getByTestId('status-section-waiting-rows').locator('.status-section-card.is-limit-flash').first().getAttribute('data-task-id')
  expect(firstLedId, 'the count marks the rows it led to').toBeTruthy()
  const firstLimited = page.getByTestId('status-section-waiting-rows').locator(`.status-section-card[data-task-id="${firstLedId}"]`)
  await expect.poll(() => firstLimited.evaluate((el) => {
    let sc = el.parentElement
    while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement
    if (!sc) return 'no scroller'
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
    return top >= margin - 2 && top <= margin + 40 ? 'top' : `at ${Math.round(top)} (margin ${margin})`
  }), { timeout: 4_000 }).toBe('top')
  await expect(flashed).toHaveCount(0, { timeout: 5_000 })
  await setStatusSectionOpen(page, 'waiting', false)
  await expect(page.getByTestId('status-section-waiting-limited')).toHaveText(/^· \d+ limited$/, { timeout: 30_000 })
  await page.getByTestId('status-section-waiting').scrollIntoViewIfNeeded()
  await shot(page, page.getByTestId('status-section-waiting'), '2-heading-folded', 8)
  await setStatusSectionOpen(page, 'waiting', true)
  const card = await showSectionCard(page, 'waiting', taskId)
  // The row names the reset in the banner's own words ("11:35 AM", a weekday first when not today).
  const bannerReset = ((await banner.locator('.usage-limit-banner-head').textContent()) ?? '').match(/resets (.+)$/)?.[1]
  expect(bannerReset).toBeTruthy()
  await expect(card.getByTestId('status-card-reason')).toHaveText(`Limited resets ${bannerReset}`)
  await expect(card.locator('.status-card-limit-tag')).toHaveText('Limited')
  // Its line says the reset, so the time slot does not say it again.
  await expect(card.getByTestId('task-row-wait-until')).toHaveCount(0)
  await card.scrollIntoViewIfNeeded()
  await shot(page, card, '2-row-limited', 8)

  // 3. Don't auto-continue: the banner says so and offers Continue after reset; the task needs the user.
  await banner.getByRole('button', { name: "Don't auto-continue" }).click()
  await expect(banner).toHaveAttribute('data-state', 'off', { timeout: 15_000 })
  await expect(banner).toContainText('Auto-continue is off, so this task now waits for you.')
  await expect(banner.getByRole('button', { name: 'Continue after reset' })).toBeVisible()
  // The switch replaced the button it was pressed on: focus is on the banner, so a second Enter
  // does not undo it.
  await expect(banner).toBeFocused()
  // Its row says it at once, with the banner, before the stored status moves it under Needs you.
  await expect(page.locator(`[data-task-id="${taskId}"] .status-card-limit-tag.is-off`).first()).toHaveText('Auto-continue off', { timeout: 3_000 })
  expect((await sessionOf(request, sid)).usageLimit?.state).toBe('off')
  await setStatusSectionOpen(page, 'needs', true)
  await expect(statusSectionCard(page, 'needs', taskId)).toBeVisible({ timeout: 30_000 })
  // Its line is a waiting limit row's: the Limited tag, why it is the user's, when it resets.
  const offCard = statusSectionCard(page, 'needs', taskId)
  const needsLine = offCard.getByTestId('status-card-needs-line')
  await expect(needsLine).toHaveAttribute('data-category', 'decide')
  await expect(needsLine).toHaveText(/^Auto-continue off\s*resets .+$/)
  await expect(needsLine.locator('.needs-line-text')).toContainText(`resets ${bannerReset}`)
  await expect(needsLine.locator('.needs-category')).toHaveCount(0)
  // Grey, as its banner is: the user's own choice, not the limit holding it.
  await expect(needsLine.locator('.status-card-limit-tag')).toHaveText('Auto-continue off')
  await expect(needsLine.locator('.status-card-limit-tag')).toHaveClass(/is-off/)
  // The whole line shows, the reset included, never cut.
  expect(await needsLine.locator('.needs-line-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  // The reset is on the line, in the banner's words, so the time slot does not say it again.
  await expect(offCard.getByTestId('task-row-limit-reset')).toHaveCount(0)
  await expect(offCard.getByTestId('task-row-wait-until')).toHaveCount(0)
  // One line, whole.
  expect(await needsLine.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  expect((await needsLine.boundingBox())!.height).toBeLessThan(24)
  await statusSectionCard(page, 'needs', taskId).scrollIntoViewIfNeeded()
  await shot(page, statusSectionCard(page, 'needs', taskId), '3-row-off', 8)
  await shot(page, banner, '3-banner-off')

  // 4. Continue after reset: back to waiting, and the row back under Waiting.
  await banner.getByRole('button', { name: 'Continue after reset' }).click()
  await expect(banner).toHaveAttribute('data-state', 'waiting', { timeout: 15_000 })
  await expect((await showSectionCard(page, 'waiting', taskId)).getByTestId('status-card-reason')).toHaveText(/^Limited resets /, { timeout: 30_000 })

  // 5. Continue now: the continue goes in, the mock answers it, the banner and the wait are gone.
  await banner.getByRole('button', { name: 'Continue now' }).click()
  // The row leaves "Limited" as soon as the continue goes in, not when a status settles later.
  await expect(page.locator(`[data-task-id="${taskId}"] [data-testid="status-card-reason"]`).filter({ hasText: /^Limited/ }))
    .toHaveCount(0, { timeout: 8_000 })
  await expect(banner).toHaveCount(0, { timeout: 60_000 })
  await expect.poll(async () => (await sessionOf(request, sid)).usageLimit, { timeout: 60_000 }).toBeUndefined()
  await expect(col.getByText('The user asked to continue now. Continue the task from where you stopped.').first()).toBeVisible({ timeout: 30_000 })
  // A lasting line says it went on, and that it was the user's Continue now.
  // Before the reset: Walnut's own continue at the reset is off, and the line says so.
  await expect(col.getByTestId('usage-limit-continued')).toContainText(/^You continued this session at .+\.$/, { timeout: 30_000 })
  await expect(col.locator('.session-error-banner:not(.usage-limit-note)')).toHaveCount(0)
  await shot(page, col, '4-continued', 0)
})

test('in a half-width column the banner stays compact; your own message ends the wait and the row follows, no reload', async ({ page, request }) => {
  const a = await limitedSession(request, 'Usage limit own message', 3 * 3600)
  const b = await limitedSession(request, 'Usage limit beside it', 3 * 3600)

  await presetPanelDesign(page, 'status')
  await showStatusLines(page)
  await seedColumns(page, [a.sid, b.sid])
  await page.goto('/')
  const col = columnFor(page, a.sid)
  await expect(col).toHaveCount(1, { timeout: 30_000 })
  const banner = col.getByTestId('usage-limit-banner')
  await expect(banner).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 })

  // Two columns: the tag stays on the heading's line, and the banner does not tower over the chat.
  const tag = await banner.locator('.usage-limit-tag').boundingBox()
  const head = await banner.locator('.usage-limit-banner-head').boundingBox()
  expect(Math.abs(tag!.y - head!.y), 'the tag sits on the heading\'s first line').toBeLessThan(6)
  expect((await banner.boundingBox())!.height).toBeLessThan(150)
  // The buttons sit under the words, lined up with them, at every width.
  const words = await banner.locator('.usage-limit-banner-body').boundingBox()
  const btns = await banner.locator('.usage-limit-btn').first().boundingBox()
  expect(btns!.y).toBeGreaterThanOrEqual(words!.y + words!.height - 1)
  expect(Math.abs(btns!.x - words!.x)).toBeLessThan(3)
  await shot(page, banner, '5-banner-half-width')

  await setStatusSectionOpen(page, 'waiting', true)
  const card = await showSectionCard(page, 'waiting', a.taskId)
  await expect(card.getByTestId('status-card-reason')).toHaveText(/^Limited resets /)

  // A person's own message: they drive the session now; the banner goes, and the row leaves
  // "Limited" by itself.
  const input = col.locator('.chat-input-textarea')
  await input.fill('Please continue with the parser.')
  await input.press('Enter')
  await expect(banner).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => (await sessionOf(request, a.sid)).usageLimit, { timeout: 30_000 }).toBeUndefined()
  await expect(page.locator(`[data-task-id="${a.taskId}"] [data-testid="status-card-reason"]`).filter({ hasText: /^Limited/ }))
    .toHaveCount(0, { timeout: 15_000 })
  // The panel says their message took it on, not only that the banner went.
  await expect(col.getByTestId('usage-limit-continued')).toHaveText(/^Your message continued this session at .+\.$/, { timeout: 15_000 })
  // The other session still waits.
  await expect(columnFor(page, b.sid).getByTestId('usage-limit-banner')).toHaveAttribute('data-state', 'waiting')
})

// 2026-11-07: By project became the default Home view, and drew a limited task like any other.
test('By project, the default view: a limited row wears the Limited tag and its reset, and turning auto-continue off shows at once', async ({ page, request }) => {
  const project = `Limit rows ${test.info().project.name}`
  const { taskId, sid } = await limitedSession(request, 'Usage limit by project', 3 * 3600, project)

  await presetPanelDesign(page, 'project')
  await seedColumns(page, [sid])
  await page.goto('/')
  const col = columnFor(page, sid)
  const banner = col.getByTestId('usage-limit-banner')
  await expect(banner).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 })
  const bannerReset = ((await banner.locator('.usage-limit-banner-head').textContent()) ?? '').match(/resets (.+)$/)?.[1]
  expect(bannerReset).toBeTruthy()
  const row = page.locator(`.todo-panel [data-task-id="${taskId}"]`).first()
  if (!(await row.isVisible().catch(() => false))) {
    await page.locator('.todo-panel .todo-group-project-header').filter({ hasText: project }).first().click()
  }
  await expect(row).toBeVisible({ timeout: 30_000 })
  const pill = row.getByTestId('task-row-limit')
  await expect(pill.locator('.status-card-limit-tag')).toHaveText('Limited', { timeout: 30_000 })
  // The banner's words for the reset, so the wait-until pill does not say a time again.
  await expect(pill).toContainText(`resets ${bannerReset}`)
  await expect(row.getByTestId('task-row-wait-until')).toHaveCount(0)
  // On the title's line, whole.
  expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await shot(page, row, '7-row-by-project', 8)

  await banner.getByRole('button', { name: "Don't auto-continue" }).click()
  await expect(pill.locator('.status-card-limit-tag.is-off')).toHaveText('Auto-continue off', { timeout: 3_000 })
  await expect(pill).toContainText(`resets ${bannerReset}`)
  await shot(page, row, '7-row-by-project-off', 8)
})

test('a Focus card wears the Limited tag and its reset ahead of its title, which a long title never hides', async ({ page, request }) => {
  const { taskId, sid } = await limitedSession(request, 'Usage limit on a Focus card with a title long enough to be cut at the end of the card', 3 * 3600, undefined, true)

  await seedColumns(page, [sid])
  await page.goto('/')
  const banner = columnFor(page, sid).getByTestId('usage-limit-banner')
  await expect(banner).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 })
  const bannerReset = ((await banner.locator('.usage-limit-banner-head').textContent()) ?? '').match(/resets (.+)$/)?.[1]
  const card = page.locator(`.todo-panel .todo-focus-card[data-task-id="${taskId}"]`).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  const pill = card.getByTestId('task-row-limit')
  await expect(pill.locator('.status-card-limit-tag')).toHaveText('Limited', { timeout: 30_000 })
  await expect(pill).toContainText(`resets ${bannerReset}`)
  // Whole, on the title's line, before the title.
  expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const [p, t] = [await pill.boundingBox(), await card.locator('.todo-pinned-title').boundingBox()]
  expect(p && t && p.x + p.width <= t.x + 1 && Math.abs((p.y + p.height / 2) - (t.y + t.height / 2)) < 6, `pill ${JSON.stringify(p)} title ${JSON.stringify(t)}`).toBe(true)
  await shot(page, card, '8-focus-card', 8)

  await banner.getByRole('button', { name: "Don't auto-continue" }).click()
  await expect(pill.locator('.status-card-limit-tag.is-off')).toHaveText('Auto-continue off', { timeout: 3_000 })
  await shot(page, card, '8-focus-card-off', 8)
})

test('a Codex session the usage limit stopped: the same calm banner, never the error banner', async ({ page, request }) => {
  const res = await request.post('/api/tasks', { data: { title: `Usage limit Codex (${test.info().project.name})`, source: 'local', pinned: false } })
  const taskId = ((await res.json()) as { task: { id: string } }).task.id
  litter.tasks.push(taskId)
  const dirs = (await (await request.get('/api/sessions/working-dirs')).json()) as { dirs: Array<{ cwd: string }> }
  const cwd = dirs.dirs.find((d) => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))?.cwd
  // The mock ACP adapter answers "usage-limit-hit" the way codex-acp reports usageLimitExceeded.
  const start = await request.post('/api/sessions/quick-start', { data: { cwd, message: 'usage-limit-hit', taskId, engine: 'codex' } })
  expect(start.ok(), await start.text()).toBe(true)
  let sid = ''
  await expect.poll(async () => {
    const b = (await (await request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: Array<{ claudeSessionId: string; usageLimit?: { state?: string } }> }
    sid = b.sessions[0]?.claudeSessionId ?? ''
    return b.sessions[0]?.usageLimit?.state
  }, { timeout: 90_000 }).toBe('waiting')
  litter.sessions.push(sid)

  await presetPanelDesign(page, 'status')
  await seedColumns(page, [sid])
  await page.goto('/')
  const col = columnFor(page, sid)
  const banner = col.getByTestId('usage-limit-banner')
  await expect(banner).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 })
  // Its reset is read from the limit's words, so the banner says it is about then.
  await expect(banner).toContainText(/Codex usage limit reached · resets (about )?(\w{3}\s)?\d{1,2}:\d{2}\s[AP]M/)
  await expect(col.locator('.session-error-banner:not(.usage-limit-banner)')).toHaveCount(0)
  // The transcript says it in words, as a note, not a failure with its error code.
  await expect(col.getByText('usage_limit', { exact: false })).toHaveCount(0)
  await expect(col.locator('.tool-run-fail')).toHaveCount(0)
  await shot(page, banner, '6-banner-codex')
  // Status sentences are off (the default): the row still says it, with the pill a By project row wears.
  await setStatusSectionOpen(page, 'waiting', true)
  const card = await showSectionCard(page, 'waiting', taskId)
  await expect(card.getByTestId('status-card-reason')).toHaveCount(0)
  await expect(card.getByTestId('task-row-limit').locator('.status-card-limit-tag')).toHaveText('Limited', { timeout: 30_000 })
  await expect(card.getByTestId('task-row-limit')).toContainText(/resets (about )?/)
})
