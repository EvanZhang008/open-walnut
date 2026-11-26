/**
 * The workers line stays inside a narrow session column in every shape it takes: by itself after
 * the lead's turn, and inside the live turn's "<engine> is working…" row while the lead's own turn
 * runs (SessionWorkingIndicator.tsx). 2026-11-25: at 820px (a 508px column) with 13 workers at work
 * and the list open, the lead's own turn widened the line to 527px and two long titles ran past the
 * column's edge with no ellipsis; by itself the same line kept its 467px. The nested row is a flex
 * item, and a flex item's min-width is its content's unless it says otherwise.
 *
 * On a phone (390px) each chip's finger target is 44px tall over its drawn 24px (choice-controls.css),
 * and the workers' chips sat in rows with no gap: the first chip's target covered the "13 workers
 * are working…" toggle, so a tap meant to fold the list opened that worker instead (2026-11-25).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, pollUntil, startSession, type KanbanApi } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const PROJECT = 'Workers Narrow'
const litter: string[] = []
let api: KanbanApi
let lead = ''
let leadSid = ''
let fewLead = ''
let fewLeadSid = ''
const PLAN = 'Planned the work in thirteen parts. Each part has its own worker and its own tests, '
  + 'and each reports back here when it is done. The service parts go first, then the hosts, then the phone app and the docs. '
  + 'Nothing ships until its part passes its own checks on the cloud box, and the phone part waits for the hosts.'
const LEAD_TITLE = `Narrow column lead ${Date.now().toString(36)}`
const FEW_TITLE = `Two workers lead ${Date.now().toString(36)}`

// Titles as long as the user's own workers' titles.
const TITLES = Array.from({ length: 13 }, (_, i) => i % 7 === 0
  ? `Part ${i + 1}: one process manager runs every service on each machine, and the desktop app only asks it to start or stop them`
  : `Part ${i + 1}: health checks per host`)

test.use({ viewport: { width: 820, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

const task = (body: Record<string, unknown>) => call<{ task: { id: string } }>(api, 'POST', '/api/tasks', { project: PROJECT, source: 'local', ...body })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  lead = (await task({ title: LEAD_TITLE })).task.id
  litter.push(lead)
  // A reply a few lines long: the chat fits a phone's screen until the open workers line grows it past.
  leadSid = await startSession(api, lead, `snapshot-clean-turn:${PLAN}`)
  for (const title of TITLES) {
    const id = (await task({ title, parent_task_id: lead })).task.id
    litter.push(id)
    await startSession(api, id, 'slow:900000 snapshot-clean-turn:Worker finished.')
  }
  // A lead with two workers: a short list folds too (2026-11-25, the user: "defualt collapes bro.").
  fewLead = (await task({ title: FEW_TITLE })).task.id
  litter.push(fewLead)
  fewLeadSid = await startSession(api, fewLead, 'snapshot-clean-turn:Two parts, one worker each.')
  for (const title of ['Part A: the settings page', 'Part B: the docs']) {
    const id = (await task({ title, parent_task_id: fewLead })).task.id
    litter.push(id)
    await startSession(api, id, 'slow:900000 snapshot-clean-turn:Worker finished.')
  }
  await pollUntil('13 workers at work', async () => (await call<{ tasks: Array<{ parent_task_id?: string; user_status?: { state?: string } }> }>(api, 'GET', '/api/tasks')).tasks
    .filter((t) => t.parent_task_id === lead && t.user_status?.state === 'working').length, (n) => n === TITLES.length, 120_000)
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) await fetch(`${api.base}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
})

async function openLead(page: Page, phone = false, title = LEAD_TITLE, sid = leadSid): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: PROJECT })
  await page.setContent(`<a href="${api.base}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  // Found by search, as the user finds one task among many in a narrow window; a phone lists this
  // project's tasks on its first screen (its search opens a page of its own).
  if (!phone) {
    await page.locator('.todo-search-input').click()
    await page.keyboard.type(title)
  }
  // A phone draws the list's rows in its own shape: the row is the one carrying the task's id.
  const id = title === LEAD_TITLE ? lead : fewLead
  const row = page.locator(phone ? `.todo-panel [data-task-id="${id}"]` : `.todo-panel-item[data-task-id="${id}"]`).first()
  await expect(row).toBeVisible({ timeout: 90_000 })
  await (phone ? row.getByText(title, { exact: true }) : row.locator('.todo-item-title')).click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

/** The line, its chips and the column it sits in, as boxes; every chip's title cut shows its ellipsis. */
async function expectInside(panel: Locator, shape: string): Promise<void> {
  const line = panel.getByTestId('session-workers-working')
  await expect(line).toHaveAttribute('data-open', 'true')
  const m = await line.evaluate((el) => {
    const column = el.closest('.main-page-session-column')!.getBoundingClientRect()
    const chips = [...el.querySelectorAll<HTMLElement>('.wn-chip')]
    return {
      column: { left: column.left, right: column.right },
      line: el.getBoundingClientRect().right,
      chips: chips.map((c) => {
        const label = c.querySelector<HTMLElement>('.wn-chip-label')
        return { right: c.getBoundingClientRect().right, clipped: label ? label.scrollWidth > label.clientWidth : false,
          ellipsis: label ? getComputedStyle(label).textOverflow : '' }
      }),
    }
  })
  expect(m.chips, shape).toHaveLength(TITLES.length)
  expect(m.line, `${shape}: the line ends inside the column`).toBeLessThanOrEqual(m.column.right + 0.5)
  for (const [i, c] of m.chips.entries()) {
    expect(c.right, `${shape}: chip ${i + 1} ends inside the column`).toBeLessThanOrEqual(m.column.right + 0.5)
    if (c.clipped) expect(c.ellipsis, `${shape}: chip ${i + 1} cut with an ellipsis`).toBe('ellipsis')
  }
  // The long titles are cut in a 508px column: the test means nothing if none is.
  expect(m.chips.some((c) => c.clipped), `${shape}: a long title is cut`).toBe(true)
}

// 2026-11-25, the user: "defualt collapes bro." One to three workers were drawn as chips with no toggle.
test.describe('his window', () => {
test.use({ viewport: { width: 1280, height: 800 } })
test('a short list starts folded too: one line, its toggle opens it and the choice is kept across a reload', async ({ page }) => {
  test.setTimeout(180_000)
  await pollUntil('2 workers at work', async () => (await call<{ tasks: Array<{ parent_task_id?: string; user_status?: { state?: string } }> }>(api, 'GET', '/api/tasks')).tasks
    .filter((t) => t.parent_task_id === fewLead && t.user_status?.state === 'working').length, (n) => n === 2, 120_000)
  const panel = await openLead(page, false, FEW_TITLE, fewLeadSid)
  const line = panel.getByTestId('session-workers-working')
  const toggle = panel.getByTestId('session-workers-toggle')
  await expect(toggle).toHaveText('2 subtasks are working…', { timeout: 60_000 })
  await expect(line).toHaveAttribute('data-open', 'false')
  await expect(line.locator('.wn-chip')).toHaveCount(0)
  await toggle.click()
  await expect(line).toHaveAttribute('data-open', 'true')
  await expect(line.locator('.wn-chip')).toHaveCount(2)
  await page.reload()
  await expect(line).toHaveAttribute('data-open', 'true', { timeout: 60_000 })
  await toggle.click()
  await expect(line).toHaveAttribute('data-open', 'false')
  await expect(line.locator('.wn-chip')).toHaveCount(0)
})
})

test('open, the line keeps inside a narrow column by itself and inside the lead\'s live turn', async ({ page }) => {
  test.setTimeout(180_000)
  const panel = await openLead(page)
  const line = panel.getByTestId('session-workers-working')
  await expect(line).toBeVisible({ timeout: 60_000 })
  await panel.getByTestId('session-workers-toggle').click()
  await expectInside(panel, 'by itself')

  // The lead's own turn runs: the line moves inside the working row.
  await panel.locator('.chat-input-textarea').click()
  await page.keyboard.type('compaction-test:10:2000')
  await page.keyboard.press('Enter')
  await expect(panel.locator('.session-working-row .session-working-row[data-testid="session-workers-working"]')).toBeVisible({ timeout: 30_000 })
  await expectInside(panel, 'inside the live turn')
  await expect(panel.locator('.chat-input-textarea')).toBeInViewport()
})

/** Every chip takes a tap at its centre and at its top and bottom edge, and the toggle takes one at its own centre. */
async function expectTapsLand(panel: Locator, shape: string): Promise<void> {
  const misses = await panel.getByTestId('session-workers-working').evaluate((el) => {
    const out: string[] = []
    const at = (x: number, y: number) => document.elementFromPoint(x, y)
    const toggle = el.querySelector<HTMLElement>('[data-testid="session-workers-toggle"]')!
    toggle.scrollIntoView({ block: 'center' })
    const t = toggle.getBoundingClientRect()
    if (!toggle.contains(at(t.left + t.width / 2, t.top + t.height / 2))) out.push(`toggle centre is ${at(t.left + t.width / 2, t.top + t.height / 2)?.className}`)
    for (const [i, c] of [...el.querySelectorAll<HTMLElement>('.wn-chip')].entries()) {
      c.scrollIntoView({ block: 'center' }) // a point off screen hits nothing
      const r = c.getBoundingClientRect()
      for (const [where, y] of [['centre', r.top + r.height / 2], ['top', r.top + 1], ['bottom', r.bottom - 1]] as const) {
        if (!c.contains(at(r.left + r.width / 2, y))) out.push(`chip ${i + 1} ${where}`)
      }
    }
    return out
  })
  expect(misses, shape).toEqual([])
}

test('on a phone the open list folds with a tap on its line, by itself and inside the lead\'s live turn', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openLead(page, true)
  const line = panel.getByTestId('session-workers-working')
  await expect(line).toBeVisible({ timeout: 60_000 })
  const toggle = panel.getByTestId('session-workers-toggle')
  // Folded, the line says what they are: subtasks, his word for them (2026-11-25).
  await expect(toggle).toHaveText('13 subtasks are working…')
  if ((await line.getAttribute('data-open')) !== 'true') await toggle.click()
  await expect(line).toHaveAttribute('data-open', 'true')
  await expectTapsLand(panel, 'by itself')
  await toggle.click()
  await expect(line).toHaveAttribute('data-open', 'false')

  await toggle.click()
  await panel.locator('.chat-input-textarea').click()
  await page.keyboard.type('compaction-test:10:2000')
  await page.keyboard.press('Enter')
  await expect(panel.locator('.session-working-row .session-working-row[data-testid="session-workers-working"]')).toBeVisible({ timeout: 30_000 })
  await expect(line).toHaveAttribute('data-open', 'true')
  await expectTapsLand(panel, 'inside the live turn')
  await toggle.click()
  await expect(line).toHaveAttribute('data-open', 'false')
})

/** Where the chat stands and whether the last worker's chip shows above the composer, untouched. */
async function lastChipShows(panel: Locator) {
  return panel.evaluate((p) => {
    const box = p.querySelector<HTMLElement>('.session-history')!
    const chips = [...p.querySelectorAll<HTMLElement>('[data-testid="session-workers-working"] .wn-chip')]
    const last = chips[chips.length - 1]
    const r = last.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + 8, r.top + r.height / 2)
    return {
      scrollTop: Math.round(box.scrollTop), max: Math.round(box.scrollHeight - box.clientHeight),
      lastTop: Math.round(r.top), lastBottom: Math.round(r.bottom), boxBottom: Math.round(box.getBoundingClientRect().bottom),
      hitsLast: last.contains(hit), hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
    }
  })
}

// 2026-11-25: a reader at the end, list open, reloaded and came back with the chat's first message at
// the top and the last worker under the composer: the phone's reload restore had anchored that
// message over the reading place, which keeps "at the end" (usePhoneRestore.ts).
test('on a phone a reload with the list open lands at the chat\'s end, the last worker above the composer', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openLead(page, true)
  const line = panel.getByTestId('session-workers-working')
  await expect(line).toBeVisible({ timeout: 60_000 })
  if ((await line.getAttribute('data-open')) !== 'true') await panel.getByTestId('session-workers-toggle').click()
  await expect(line).toHaveAttribute('data-open', 'true')
  // He reads up a little and back down to the end by hand, the last worker in sight.
  const box = await panel.locator('.session-history').boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(500)
  await page.mouse.wheel(0, 6000)
  await page.waitForTimeout(2500)
  // A board as big as his loads its task list a moment after the chat: the workers line comes
  // last, inside the phone's open-time landing window (phone-turn-start.ts), and makes the one
  // turn taller than the screen.
  const late = async (r: import('@playwright/test').Route) => { await new Promise((ok) => setTimeout(ok, Number(process.env.PW_TASKS_DELAY ?? 1000))); await r.continue() }
  const landing: string[] = []
  page.on('console', (m) => { if (/phone turn start|phone-restore/.test(m.text())) landing.push(m.text().slice(0, 200)) })
  await page.route('**/api/tasks?**', late)
  await page.route('**/api/tasks', late)
  await page.reload()
  await expect(line).toHaveAttribute('data-open', 'true', { timeout: 60_000 })
  // Untouched as the auditor left it: every late layout (the workers line arrives with the task list) has landed.
  await page.waitForTimeout(9_000)
  const m = await lastChipShows(panel)
  expect(m.scrollTop, `back at the end: ${JSON.stringify(m)} ${landing.join(' | ')}`).toBeGreaterThanOrEqual(m.max - 2)
  expect(m.hitsLast, JSON.stringify(m)).toBe(true)
})

