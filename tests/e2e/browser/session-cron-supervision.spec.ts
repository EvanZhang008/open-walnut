import fs from 'node:fs/promises'
import { expect, test, type Page, type Locator } from '@playwright/test'
import { openAskWalnutDrawer } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import type { SessionCronJob, SessionCronMetadata } from '../../../src/core/types'
import type { SessionSupervision } from '../../../web/src/api/sessions'

const SID = 'pw-vscode-session'
const TASK = 'pw-task-vscode'
const SHOTS = process.env.PW_SUPERVISION_SHOTS ?? '/tmp/session-cron-pill'
// One epoch for the whole file: the store accepts the FIRST epoch it sees and
// rejects any later one unless a reconnect opened intake, so every fixture
// observation must share it.
const CRON_EPOCH = 'pill-test'
// A draft that must survive every recovery write. Written as escapes so the
// non-ASCII coverage stays without putting non-English text in the source.
const DRAFT = '\u672A\u53D1\u9001\u7684\u8349\u7A3F remains while recovery changes'
const LONG_TITLE = 'Editor fixture task carrying a deliberately long title that truncates without pushing its pills out'
const HOUR = 3_600_000
// The shape a real CronCreate leaves behind (id, humanSchedule, recurring,
// durable from the result; cron and prompt from the input). The prompt is
// multi-line, long, and carries non-ASCII as escapes.
const PROMPT_BODY = 'Daily disk inspection (5-day watch after the disk-full incident; stop after the 20th). '
  + 'Do the full check, not a summary: du on the stream dir, the biggest ten files, growth since yesterday.\n\n'
  + 'Report in the task, never as a chat message. \u78C1\u76D8\u5DE1\u68C0 \u6BCF\u5929\u4E00\u6B21.\n'
  + 'Line four keeps going with enough text that the collapsed preview has to trim it somewhere sensible. '.repeat(6)
const JOB: SessionCronJob = {
  id: '41935620', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM', prompt: PROMPT_BODY, promptTruncated: false,
  recurring: true, durable: false, createdAt: Date.now() - HOUR, nextRunAt: Date.now() + 12 * HOUR + 40 * 60_000, expiresAt: Date.now() + 6 * 24 * HOUR,
}

test.use({ viewport: { width: 1280, height: 850 }, deviceScaleFactor: 1 })
test.setTimeout(90_000)

function snapshot(): SessionSupervision {
  return {
    available: true, startup: 'login', stopRequest: null,
    supervision: { enabled: true, state: 'checking', reason: 'scheduler-unconfirmed', generation: 1, retryAt: null, updatedAt: Date.now() },
  }
}

function cron(patch: Partial<SessionCronMetadata> & { revision: number }): SessionCronMetadata {
  const base: SessionCronMetadata = {
    sessionId: SID,
    epoch: CRON_EPOCH,
    presence: 'active',
    source: 'cron',
    known: true,
    stale: false,
    observedAt: Date.now(),
    validUntil: null,
    ...patch,
  }
  // Only an active observation carries jobs, exactly like the daemon.
  if (!('jobs' in patch)) base.jobs = base.presence === 'active' && base.source === 'cron' ? [JOB] : []
  return base
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/**
 * Both REST carriers of cron metadata, rewritten on top of the REAL body: the
 * hydration map (`/api/sessions/status` → `cron[sessionId]`) is what seeds a task
 * row, and the single-session read (`/api/sessions/:id` → `cron`) is what seeds a
 * panel header. `read()` is the fixture's current observation, so a reload or a
 * reconnect rehydration agrees with what the WS already pushed.
 */
async function routeCron(page: Page, read: () => SessionCronMetadata | null, readProcessStatus = () => 'idle'): Promise<void> {
  await page.route((url) => url.pathname === '/api/sessions/status', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    const metadata = read()
    body.cron = metadata ? { [SID]: metadata } : {}
    if (body.statuses?.[SID]) body.statuses[SID].process_status = readProcessStatus()
    await route.fulfill({ response, json: body })
  })
  await page.route((url) => url.pathname === `/api/sessions/${SID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    body.cron = read()
    if (body.session) body.session.process_status = readProcessStatus()
    await route.fulfill({ response, json: body })
  })
}

async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket
    class PatchedWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), window.location.href).pathname !== '/ws') return
        ;(window as Window & { __capturedWs?: WebSocket }).__capturedWs = this
      }
    }
    window.WebSocket = PatchedWebSocket as unknown as typeof WebSocket
  })
}

async function waitForWs(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs
    return ws?.readyState === WebSocket.OPEN
  }, null, { timeout: 20_000 })
}

async function pushCron(page: Page, metadata: SessionCronMetadata): Promise<void> {
  await page.evaluate((data) => {
    const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs
    if (!ws) throw new Error('No captured WebSocket')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: 'session:cron-metadata', data, seq: Date.now() }),
    }))
  }, metadata)
}

/**
 * The header's CRON pill opens the job card; the recovery bar only ever opens
 * itself, when something needs a decision.
 */
async function openCronCard(panel: Locator): Promise<Locator> {
  const pill = panel.locator('.session-cron-pill')
  await expect(pill).toBeVisible()
  await pill.click()
  const card = panel.locator('.session-cron-detail')
  await expect(card).toBeVisible()
  return card
}

async function openHome(page: Page, baseURL: string) {
  await page.setContent('<a id="open-app">Open Walnut</a>')
  await page.locator('#open-app').evaluate((node, url) => { (node as HTMLAnchorElement).href = url }, baseURL)
  await page.locator('#open-app').click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
}

function taskRow(page: Page): Locator {
  return page.locator(`.todo-panel-item[data-task-id="${TASK}"]`)
}

async function findTask(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SID)
  const row = taskRow(page)
  await expect(row).toBeVisible()
  return row
}

async function openColumn(page: Page): Promise<Locator> {
  const row = await findTask(page)
  await row.locator('.todo-item-title').click()
  const column = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
  await expect(column).toBeVisible()
  return column
}

async function exposeAsk(page: Page) {
  await page.route((url) => url.pathname === '/api/tasks' || url.pathname === `/api/tasks/${TASK}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    const patch = (task: Record<string, unknown>) => task.id === TASK ? { ...task, project: 'Ask Walnut', walnut_agent: true } : task
    if (Array.isArray(body.tasks)) body.tasks = body.tasks.map(patch)
    if (body.task) body.task = patch(body.task)
    await route.fulfill({ response, json: body })
  })
}

/** The fixture title is short; a long one is the only way to prove the pill does
 *  not shrink or ride out of a wrapped row. */
async function exposeLongTitle(page: Page) {
  await page.route((url) => url.pathname === '/api/tasks' || url.pathname === `/api/tasks/${TASK}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    const patch = (task: Record<string, unknown>) => task.id === TASK ? { ...task, title: LONG_TITLE } : task
    if (Array.isArray(body.tasks)) body.tasks = body.tasks.map(patch)
    if (body.task) body.task = patch(body.task)
    await route.fulfill({ response, json: body })
  })
}

const issues = new WeakMap<Page, { errors: string[]; checks: Promise<void>[] }>()

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => localStorage.setItem('open-walnut-agent-search', '0'))
  const observed = { errors: [] as string[], checks: [] as Promise<void>[] }
  issues.set(page, observed)
  page.on('pageerror', (error) => observed.errors.push(error.message))
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? 'unknown failure'
    if (!/cancelled|canceled|abort/i.test(reason)) observed.errors.push(`${request.method()} ${request.url()}: ${reason}`)
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    const pathname = new URL(response.url()).pathname
    observed.checks.push((async () => {
      if (response.status() === 503 && pathname === '/api/search/agent'
        && (await response.json()).code === 'ai_disabled') return
      if (response.status() === 503 && pathname === `/api/sessions/${SID}/supervision`
        && (await response.json()).error === 'Hook policy unavailable, retry after repair') return
      observed.errors.push(`${response.status()} ${pathname}`)
    })().catch((error) => { observed.errors.push(String(error)) }))
  })
})
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  const observed = issues.get(page)!
  await Promise.all(observed.checks)
  expect(observed.errors).toEqual([])
})

test('shared recovery toggle keeps both home surfaces and a dense transcript usable', async ({ page, baseURL }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let state = snapshot()
  let held = gate()
  let writes = 0
  let stops = 0
  await exposeAsk(page)
  await routeCron(page, () => cron({ revision: 1 }))
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, async (route) => {
    if (route.request().method() === 'PUT') {
      const enabled = route.request().postDataJSON().enabled
      writes += 1
      await held.promise
      state = { ...state, supervision: { ...state.supervision!, enabled, state: enabled ? 'checking' : 'disabled', reason: enabled ? 'scheduler-unconfirmed' : 'user-disabled', generation: state.supervision!.generation + 1 } }
    }
    await route.fulfill({ json: structuredClone(state) })
  })
  await page.route((url) => url.pathname === `/api/sessions/${SID}/terminate`, async (route) => {
    stops += 1
    await route.fulfill({ status: 500, json: { error: 'Unexpected stop' } })
  })
  try {
    await openHome(page, baseURL!)
    const column = await openColumn(page)
    await openAskWalnutDrawer(page)
    await page.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${TASK}"]`).click()
    const slot = page.locator(`[data-testid="ask-walnut-slot"] .session-panel[data-session-id="${SID}"]`)
    await expect(slot).toBeVisible()
    // A calm 'checking' state stays out of the way until asked for, in BOTH surfaces.
    await expect(column.locator('.session-supervision')).toHaveCount(0)
    await expect(slot.locator('.session-supervision')).toHaveCount(0)
    await expect(column.locator('.session-cron-detail')).toHaveCount(0)
    const bars = [await openCronCard(column), await openCronCard(slot)]
    const headerPill = column.locator('.session-cron-pill')
    await headerPill.focus()
    await page.keyboard.press('Enter')
    await expect(bars[0]).toHaveCount(0)
    await expect(headerPill).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Space')
    await expect(bars[0]).toBeVisible()
    await expect(headerPill).toHaveAttribute('aria-expanded', 'true')
    for (const bar of bars) {
      // The card is about the JOB; recovery is one compact row with its facts in the tooltip.
      await expect(bar.locator('.session-cron-job-heading strong')).toHaveText('Every day at 9:23 AM')
      await expect(bar.locator('.session-cron-job-heading code')).toHaveText('23 9 * * *')
      await expect(bar.locator('.session-cron-job-next')).toContainText(/Next run .*\(in 12h (39|40)m\)/)
      await expect(bar.locator('.session-cron-job-facts')).toHaveText(/^Recurring · Session-only · Expires .* · Created .* · Job 41935620$/)
      await expect(bar).not.toContainText('not available on this host')
      await expect(bar).not.toContainText('readiness is not confirmed')
      await expect(bar.locator('.session-cron-recovery')).toContainText('Auto-recover after host restart')
      await expect(bar.locator('.session-cron-recovery-state')).toHaveText('Checking')
      await expect(bar.locator('.session-cron-recovery-state')).toHaveAttribute('title', /scheduler unconfirmed; host starts the daemon at login/)
      await expect(bar.getByRole('switch')).toBeChecked()
    }
    await column.locator('.chat-input-textarea').fill(DRAFT)
    for (const enabled of [false, true, false, true]) {
      held = gate()
      await bars[0].getByRole('switch').click()
      for (const bar of bars) {
        await expect(bar.getByRole('switch')).toBeChecked({ checked: enabled })
        await expect(bar.getByRole('switch')).toBeDisabled()
        await expect(bar).toContainText('Saving\u2026')
      }
      held.release()
      for (const bar of bars) await expect(bar.getByRole('switch')).toBeEnabled()
    }
    expect(writes).toBe(4)
    expect(stops).toBe(0)
    await expect(column.locator('.chat-input-textarea')).toHaveValue(DRAFT)
    const history = column.locator('.session-history')
    expect(await history.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
    await history.hover()
    await page.mouse.wheel(0, -650)
    await expect(history).toContainText('filler')
    for (const bar of bars) {
      const bounds = await bar.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280)
      expect(await bar.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    }
    await page.locator('.todo-search-input').fill('')
    await page.getByRole('tab', { name: /^Tasks(?: \d+)?$/ }).click()
    await expect.poll(() => page.locator('.todo-panel-item').count()).toBeGreaterThan(10)
    const taskList = page.locator('.todo-panel-item').first()
    await taskList.hover()
    await page.mouse.wheel(0, 550)
    await page.mouse.wheel(0, -550)
    await expect(column.locator('.chat-input-textarea')).toHaveValue(DRAFT)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-shared-css.png`, scale: 'css' })
    await page.reload()
    // Reload starts collapsed again: the pill is the memory, not the card.
    const restored = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
    await expect(restored.locator('.session-cron-pill')).toBeVisible()
    await expect(restored.locator('.session-supervision')).toHaveCount(0)
    await expect(restored.locator('.session-cron-detail')).toHaveCount(0)
    await expect(await openCronCard(restored)).toContainText('Every day at 9:23 AM')
    expect(errors).toEqual([])
  } finally { held.release() }
})

test('offline stop remains pending through reload and retries without sending a message', async ({ page, baseURL }, info) => {
  let state = snapshot()
  const hold = gate()
  let stops = 0
  let sends = 0
  let metadata = cron({ revision: 1 })
  let processStatus = 'idle'
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/sessions/${SID}/send`) sends += 1
  })
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      if (String(payload).includes('session:send')) sends += 1
    })
  })
  await captureWs(page)
  await routeCron(page, () => metadata, () => processStatus)
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, (route) => route.fulfill({ json: structuredClone(state) }))
  await page.route((url) => url.pathname === `/api/sessions/${SID}/terminate`, async (route) => {
    stops += 1
    if (stops === 1) {
      await hold.promise
      state = { ...state, available: false, startup: 'unavailable', stopRequest: { id: 'stop-1', requestedAt: new Date().toISOString(), state: 'pending', error: 'Host unavailable' } }
      await route.fulfill({ json: { status: 'pending', sessionId: SID } })
    } else {
      state = { ...state, available: true, startup: 'login', stopRequest: { ...state.stopRequest!, state: 'confirmed' }, supervision: { ...state.supervision!, enabled: false, state: 'disabled', reason: 'user-disabled' } }
      processStatus = 'stopped'
      metadata = cron({ revision: 2, presence: 'unknown', stale: true })
      await pushCron(page, metadata)
      await route.fulfill({ json: { status: 'terminated', sessionId: SID } })
    }
  })
  try {
    await openHome(page, baseURL!)
    const column = await openColumn(page)
    await expect(column.locator('.session-supervision')).toHaveCount(0)
    await column.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.locator('.task-kebab-menu:visible').getByRole('button', { name: 'Terminate', exact: true }).click()
    // A stop in flight opens itself — the user never has to find it.
    const bar = column.locator('.session-supervision')
    await expect(bar).toContainText('Requesting stop')
    await expect(bar).not.toContainText('Automatic recovery off')
    hold.release()
    await expect(bar).toContainText('Stop pending host confirmation')
    await expect(bar.getByRole('switch')).toBeDisabled()
    await column.locator('.chat-input-textarea').click()
    await expect(page.locator('.task-kebab-menu:visible')).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-pending-stop-css.png`, scale: 'css' })
    await page.reload()
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
    const restored = panel.locator('.session-supervision')
    await expect(restored).toContainText('Stop pending host confirmation')
    await restored.getByRole('button', { name: 'Retry stop' }).click()
    // Confirmed: nothing is pending, so the bar collapses back on its own.
    await expect(restored).toHaveCount(0)
    await expect(panel.locator('.session-cron-pill')).toHaveCount(0)
    expect(stops).toBe(2)
    expect(sends).toBe(0)
  } finally { hold.release() }
})

test('failed changes remain visible and can be retried; unknown startup is not called boot', async ({ page, baseURL }, info) => {
  let state = snapshot()
  state.startup = 'service'
  state.supervision = { ...state.supervision!, state: 'blocked', reason: 'retry-budget-exhausted' }
  let reject = true
  await routeCron(page, () => cron({ revision: 1 }))
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, async (route) => {
    if (route.request().method() === 'PUT') {
      if (reject) return route.fulfill({ status: 503, json: { error: 'Hook policy unavailable, retry after repair' } })
      const enabled = route.request().postDataJSON().enabled
      state.supervision = { ...state.supervision!, enabled, state: enabled ? 'checking' : 'disabled', reason: enabled ? 'scheduler-unconfirmed' : 'user-disabled' }
    }
    await route.fulfill({ json: structuredClone(state) })
  })
  await openHome(page, baseURL!)
  const column = await openColumn(page)
  // Blocked recovery expands itself: it needs a decision, so it is never hidden
  // behind the pill.
  const bar = column.locator('.session-supervision')
  await expect(bar).toContainText('Service running; startup not verified')
  await expect(bar).not.toContainText('at boot')
  await bar.getByRole('button', { name: 'Retry recovery' }).click()
  await expect(bar.getByRole('alert')).toContainText('Hook policy unavailable')
  await expect(bar.getByRole('button', { name: 'Retry recovery' })).toBeEnabled()
  reject = false
  await bar.getByRole('button', { name: 'Retry recovery' }).click()
  await expect(bar).toHaveCount(0)
  const reopened = await openCronCard(column)
  await expect(reopened.getByRole('switch')).toBeChecked()
  await expect(reopened.getByRole('alert')).toHaveCount(0)
  await expect(reopened.locator('.session-cron-recovery-state')).toHaveText('Checking')
  await expect(reopened).toContainText('Every day at 9:23 AM')
  await page.setViewportSize({ width: 1000, height: 800 })
  expect(await reopened.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await reopened.screenshot({ path: `${SHOTS}/${info.project.name}-recovered-css.png`, scale: 'css' })
})

test('active recovery stays controllable without a cron badge', async ({ page, baseURL }, info) => {
  let state = snapshot()
  state.supervision = { ...state.supervision!, state: 'restarting', reason: 'retry-backoff' }
  let writes = 0
  await routeCron(page, () => cron({ revision: 1, presence: 'unknown', stale: true }), () => 'stopped')
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, async (route) => {
    if (route.request().method() === 'PUT') {
      expect(route.request().postDataJSON()).toMatchObject({ enabled: false })
      writes += 1
      state = { ...state, supervision: { ...state.supervision!, enabled: false, state: 'disabled', reason: 'user-disabled' } }
    }
    await route.fulfill({ json: state })
  })
  await openHome(page, baseURL!)
  const column = await openColumn(page)
  await expect(column.locator('.session-cron-pill')).toHaveCount(0)
  const bar = column.locator('.session-supervision')
  await expect(bar).toContainText('Waiting before the next restart attempt.')
  await expect(bar.getByRole('switch')).toBeChecked()
  await column.screenshot({ path: `${SHOTS}/${info.project.name}-recovery-without-cron.png`, scale: 'css' })
  await bar.getByRole('switch').click()
  await expect(bar).toHaveCount(0)
  expect(writes).toBe(1)
})

test('historical wakeups and unknown evidence never label a stopped session as cron', async ({ page, baseURL }, info) => {
  let observation = cron({ revision: 1, presence: 'unknown', source: null, known: true, stale: true })
  await captureWs(page)
  await exposeAsk(page)
  await routeCron(page, () => observation, () => 'stopped')
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, (route) => route.fulfill({
    json: { available: false, startup: 'on-demand', stopRequest: null, supervision: null },
  }))
  await openHome(page, baseURL!)
  const column = await openColumn(page)
  await openAskWalnutDrawer(page)
  await page.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${TASK}"]`).click()
  const slot = page.locator(`[data-testid="ask-walnut-slot"] .session-panel[data-session-id="${SID}"]`)
  await expect(slot).toBeVisible()
  for (const surface of [taskRow(page), column, slot]) await expect(surface.locator('.session-cron-pill')).toHaveCount(0)
  await waitForWs(page)
  observation = cron({ revision: 2, source: 'wakeup', validUntil: Date.now() + 60_000 })
  await pushCron(page, observation)
  for (const surface of [taskRow(page), column, slot]) await expect(surface.locator('.session-cron-pill')).toHaveCount(0)
  await expect(column.locator('.session-supervision')).toHaveCount(0)
  await expect(slot.locator('.session-supervision')).toHaveCount(0)
  await expect(column.locator('.session-cron-detail')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-no-ghost-cron.png`, scale: 'css' })
})

test('the cron pill rides the task row and the session header, and only a newer observation moves it', async ({ page, baseURL }, info) => {
  let observation: SessionCronMetadata | null = null
  // Accepted observations also become the REST truth, so a rehydration can never
  // contradict what the WS pushed.
  const push = async (metadata: SessionCronMetadata, authoritative = true) => {
    if (authoritative) observation = metadata
    await pushCron(page, metadata)
  }
  await captureWs(page)
  await exposeLongTitle(page)
  await routeCron(page, () => observation)
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, (route) => route.fulfill({
    json: { available: false, startup: 'on-demand', stopRequest: null, supervision: null },
  }))

  await openHome(page, baseURL!)
  const row = await findTask(page)
  await expect(row.locator('.todo-item-title')).toHaveText(LONG_TITLE)
  // No observation, no pill: an unknown schedule is never implied.
  await expect(row.locator('.session-cron-pill')).toHaveCount(0)
  await expect(row).not.toHaveClass(/task-focused/)
  const phaseTitle = await row.locator('.task-phase-icon-btn').getAttribute('title')

  await waitForWs(page)
  await push(cron({ revision: 1 }))
  const rowPill = row.locator('.session-cron-pill')
  await expect(rowPill).toHaveText('CRON')
  await expect(rowPill).toHaveAttribute('data-cron-presence', 'active')
  // The row pill cannot open a card, so its hover text carries the schedule itself.
  await expect(rowPill).toHaveAttribute('title', /^Cron job: Every day at 9:23 AM\. Next run .* \(in 12h (39|40)m\)\.$/)

  // The row pill is a plain span: clicking it still focuses the task and opens
  // its session column, exactly like clicking anywhere else on the row.
  await rowPill.click()
  await expect(row).toHaveClass(/task-focused/)
  const column = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
  await expect(column).toBeVisible()
  const headerPill = column.locator('.session-cron-pill')
  await expect(headerPill).toHaveText('CRON')
  await expect(headerPill).toHaveAttribute('data-cron-presence', 'active')
  await expect(headerPill).toHaveAttribute('data-cron-source', 'cron')
  // The pill is an addition, not a replacement: the process badge keeps its own
  // element and text, and the pill is not nested inside it.
  const badges = column.locator('.session-panel-badge')
  const badgeTexts = await badges.allTextContents()
  expect(badgeTexts.length).toBeGreaterThan(0)
  expect(await column.locator('.session-panel-badge .session-cron-pill').count()).toBe(0)
  await expect(column.locator('.session-supervision')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-pill-active-css.png`, scale: 'css' })

  // Narrow column + long title: the pill keeps its own width and stays inside the row.
  await page.setViewportSize({ width: 1024, height: 800 })
  await expect(rowPill).toBeVisible()
  const titleRow = row.locator('.todo-item-title-row')
  expect(await titleRow.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const titleStyle = await row.locator('.todo-item-title').evaluate((node) => ({
    whiteSpace: getComputedStyle(node).whiteSpace, overflow: getComputedStyle(node).textOverflow,
  }))
  expect(titleStyle.whiteSpace).toBe('normal')
  const rowBox = (await titleRow.boundingBox())!
  const pillBox = (await rowPill.boundingBox())!
  expect(pillBox.width).toBeGreaterThan(28)
  expect(pillBox.x).toBeGreaterThanOrEqual(rowBox.x - 1)
  expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
  const headerTop = column.locator('.session-panel-header-top')
  expect(await headerTop.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const headerBox = (await headerTop.boundingBox())!
  const headerPillBox = (await headerPill.boundingBox())!
  expect(headerPillBox.width).toBeGreaterThan(28)
  expect(headerPillBox.x + headerPillBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1)

  const statusResponse = await page.request.get(`/api/sessions/status?ids=${SID}`)
  expect(statusResponse.ok()).toBe(true)
  const baseline = (await statusResponse.json()).statuses[SID]
  let statusRevision = baseline.statusRevision + 10000
  let currentStatus = baseline
  const updateStatus = async (patch: Record<string, unknown>) => {
    currentStatus = { ...currentStatus, ...patch, statusRevision: ++statusRevision, statusUpdatedAt: new Date().toISOString() }
    await page.evaluate(({ status }) => {
      const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs!
      ws.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'event', name: 'session:status-changed', data: { status }, seq: Date.now() }),
      }))
    }, { status: currentStatus })
  }
  for (const [processStatus, pendingPermissionTool, label] of [
    ['idle', null, 'Idle'], ['running', null, 'Running'], ['running', 'Bash', 'Waiting'],
  ] as const) {
    await updateStatus({ process_status: processStatus, pendingPermissionTool })
    await expect(badges.last()).toHaveText(label)
    for (const pill of [rowPill, headerPill]) await expect(pill).toHaveAttribute('data-cron-presence', 'active')
  }
  await updateStatus({ archived: true })
  await expect(rowPill).toHaveCount(0)
  await expect(headerPill).toHaveCount(0)
  await updateStatus({ archived: false })
  await expect(rowPill).toHaveAttribute('data-cron-presence', 'active')
  await expect(headerPill).toHaveAttribute('data-cron-presence', 'active')

  await column.locator('.chat-input-textarea').fill(DRAFT)
  const details = await openCronCard(column)
  await expect(details).toBeVisible()
  await push(cron({ revision: 2, presence: 'unknown' }))
  for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0)
  await expect(details).toHaveCount(0)
  expect(await row.locator('.todo-item-title').evaluate((node) => ({
    whiteSpace: getComputedStyle(node).whiteSpace, overflow: getComputedStyle(node).textOverflow,
  }))).toEqual(titleStyle)
  await expect(column.locator('.chat-input-textarea')).toHaveValue(DRAFT)
  await expect(badges.last()).toHaveText('Waiting')
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-unconfirmed-hidden.png`, scale: 'css' })

  await push(cron({ revision: 1 }), false)
  for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0)

  for (const patch of [
    { revision: 3, source: 'wakeup' as const, validUntil: Date.now() + 60_000 },
    { revision: 4, stale: true },
    { revision: 5, known: false },
    { revision: 6, source: null },
  ]) {
    await push(cron(patch))
    for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0)
  }

  await push(cron({ revision: 7, validUntil: Date.now() + 2_500 }))
  for (const pill of [rowPill, headerPill]) await expect(pill).toHaveAttribute('data-cron-presence', 'active')
  for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0, { timeout: 15_000 })
  await expect(details).toHaveCount(0)

  for (let revision = 8; revision <= 12; revision += 2) {
    await push(cron({ revision }))
    for (const pill of [rowPill, headerPill]) await expect(pill).toBeVisible()
    // The card was open when its job vanished; a returning job does not reopen it.
    await expect(details).toHaveCount(0)
    await expect(headerPill).toHaveAttribute('aria-expanded', 'false')
    await push(cron({ revision: revision + 1, presence: 'inactive' }))
    for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0)
    await expect(details).toHaveCount(0)
  }

  await push(cron({ revision: 14 }))
  await updateStatus({ process_status: 'stopped', pendingPermissionTool: null })
  for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0)
  await updateStatus({ process_status: 'error', pendingPermissionTool: null })
  for (const pill of [rowPill, headerPill]) await expect(pill).toBeVisible()
  await push(cron({ revision: 15, presence: 'unknown', stale: true }))
  for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0)
  await updateStatus({ process_status: 'idle', pendingPermissionTool: null })
  await push(cron({ revision: 16 }))
  for (const pill of [rowPill, headerPill]) await expect(pill).toBeVisible()
  await push(cron({ revision: 17, presence: 'inactive' }))
  for (const pill of [rowPill, headerPill]) await expect(pill).toHaveCount(0)
  await expect(column.locator('.chat-input-textarea')).toHaveValue(DRAFT)
  expect(await row.locator('.task-phase-icon-btn').getAttribute('title')).toBe(phaseTitle)
  await expect(badges.last()).toHaveText(/^(Idle|Stopped|Running|Error|Waiting)$/)
})

test('the cron card shows each job as the CLI reported it and follows every change', async ({ page, baseURL }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const often: SessionCronJob = {
    id: 'a1b2c3d4', cron: '*/5 * * * *', schedule: 'Every 5 minutes', prompt: 'Short prompt', promptTruncated: false,
    recurring: true, durable: false, createdAt: null, nextRunAt: Date.now() + 3 * 60_000, expiresAt: Date.now() + 5 * 24 * HOUR,
  }
  const once: SessionCronJob = {
    id: 'ffff0001', cron: '30 14 16 9 *', schedule: 'On September 16 at 2:30 PM', prompt: 'x'.repeat(2000), promptTruncated: true,
    recurring: false, durable: false, createdAt: Date.now() - 2 * HOUR, nextRunAt: Date.now() + 26 * HOUR, expiresAt: Date.now() + 26 * HOUR,
  }
  // A row the daemon only saw in a CronList that carried no prompt, with an
  // expression the CLI rule could not evaluate: every optional field at its floor.
  const bare: SessionCronJob = {
    id: '0000bare', cron: 'every 5 minutes', schedule: null, prompt: null, promptTruncated: false,
    recurring: true, durable: false, createdAt: null, nextRunAt: null, expiresAt: null,
  }
  // Daemon order: by next run (unknown last), then id. The card renders the list as published.
  let observation = cron({ revision: 1, jobs: [often, JOB, once, bare] })
  await captureWs(page)
  await exposeAsk(page)
  await routeCron(page, () => observation)
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, (route) => route.fulfill({
    json: { available: false, startup: 'on-demand', stopRequest: null, supervision: null },
  }))
  await openHome(page, baseURL!)
  const column = await openColumn(page)
  await openAskWalnutDrawer(page)
  await page.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${TASK}"]`).click()
  const slot = page.locator(`[data-testid="ask-walnut-slot"] .session-panel[data-session-id="${SID}"]`)
  await expect(slot).toBeVisible()
  const card = await openCronCard(column)
  const slotCard = await openCronCard(slot)
  for (const surface of [card, slotCard]) {
    await expect(surface.locator('.session-cron-detail-heading strong')).toHaveText('Cron jobs · 4')
    await expect(surface.locator('.session-cron-job .session-cron-job-heading strong')).toHaveText([
      'Every 5 minutes', 'Every day at 9:23 AM', 'On September 16 at 2:30 PM', 'every 5 minutes',
    ])
    // A job seen only through CronList has no creation time, so no "Created" fact.
    await expect(surface.locator('.session-cron-job').nth(0).locator('.session-cron-job-facts')).toHaveText(/^Recurring · Session-only · Expires .* · Job a1b2c3d4$/)
    await expect(surface.locator('.session-cron-job').nth(2).locator('.session-cron-job-facts')).toHaveText(/^Runs once · Session-only · Created .* · Job ffff0001$/)
    // Floors: the raw expression stands in for the schedule, no next run is
    // invented, no expiry or creation is shown, and a missing prompt says so.
    const floor = surface.locator('.session-cron-job[data-job-id="0000bare"]')
    await expect(floor.locator('.session-cron-job-heading code')).toHaveCount(0)
    await expect(floor.locator('.session-cron-job-next')).toHaveText('Next run not computable from this expression')
    await expect(floor.locator('.session-cron-job-facts')).toHaveText('Recurring · Session-only · Job 0000bare')
    await expect(floor.locator('.session-cron-prompt-note')).toHaveText('Prompt not reported for this job.')
    await expect(floor.locator('.session-cron-prompt-toggle')).toHaveCount(0)
    // No recovery row at all when the host cannot recover: nothing reads as "disabled".
    await expect(surface.locator('.session-cron-recovery')).toHaveCount(0)
    await expect(surface).not.toContainText(/recovery/i)
  }
  // The prompt is collapsed to one trimmed line, and expands to the full text.
  const daily = card.locator('.session-cron-job[data-job-id="41935620"]')
  const preview = daily.locator('.session-cron-prompt-preview')
  await expect(preview).toHaveText(/^Daily disk inspection/)
  expect(await preview.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await daily.locator('.session-cron-prompt-toggle').click()
  const text = daily.locator('.session-cron-prompt-text')
  await expect(text).toContainText('\u78C1\u76D8\u5DE1\u68C0 \u6BCF\u5929\u4E00\u6B21')
  await expect(text).toContainText('Line four keeps going')
  expect(await text.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-wrap')
  expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await expect(daily.locator('.session-cron-prompt-note')).toHaveCount(0)
  const oneShot = card.locator('.session-cron-job[data-job-id="ffff0001"]')
  await oneShot.locator('.session-cron-prompt-toggle').click()
  await expect(oneShot.locator('.session-cron-prompt-note')).toHaveText('Showing the first 2,000 characters.')
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-card-jobs-css.png`, scale: 'css' })
  await daily.locator('.session-cron-prompt-toggle').click()
  await expect(text).toHaveCount(0)
  await expect(preview).toBeVisible()

  // A deletion of one job removes only that row, in both surfaces at once, and
  // the prompt the user had open on another job stays open.
  await waitForWs(page)
  await expect(oneShot.locator('.session-cron-prompt-text')).toBeVisible()
  observation = cron({ revision: 2, jobs: [JOB, once] })
  await pushCron(page, observation)
  for (const surface of [card, slotCard]) {
    await expect(surface.locator('.session-cron-detail-heading strong')).toHaveText('Cron jobs · 2')
    await expect(surface.locator('.session-cron-job[data-job-id="a1b2c3d4"]')).toHaveCount(0)
    await expect(surface.locator('.session-cron-job[data-job-id="0000bare"]')).toHaveCount(0)
  }
  await expect(oneShot.locator('.session-cron-prompt-text')).toBeVisible()
  await expect(oneShot.locator('.session-cron-prompt-note')).toHaveText('Showing the first 2,000 characters.')
  // A passed minute reads as due until the daemon republishes, never as a future time.
  observation = cron({ revision: 3, jobs: [{ ...JOB, nextRunAt: Date.now() - 30_000 }] })
  await pushCron(page, observation)
  await expect(card.locator('.session-cron-detail-heading strong')).toHaveText('Cron job · 1')
  await expect(card.locator('.session-cron-job-next')).toContainText('(due now)')
  // An active badge with an empty list (a daemon bug, not a user state) says so
  // rather than showing a heading over nothing.
  observation = cron({ revision: 4, jobs: [] })
  await pushCron(page, observation)
  await expect(card.locator('.session-cron-detail-heading strong')).toHaveText('Cron jobs · 0')
  await expect(card).toContainText('sent no job details')
  await expect(column.locator('.session-cron-pill')).toHaveAttribute('title', 'Confirmed cron job.')
  // A daemon that predates job details still backs the pill; the card says so instead of guessing.
  observation = cron({ revision: 5, jobs: undefined })
  await pushCron(page, observation)
  await expect(card.locator('.session-cron-detail-heading strong')).toHaveText('Cron job')
  await expect(card).toContainText('predates job details')
  await expect(card.locator('.session-cron-job')).toHaveCount(0)
  await expect(column.locator('.session-cron-pill')).toHaveAttribute('title', /host's daemon/)
  observation = cron({ revision: 6 })
  await pushCron(page, observation)
  await expect(card.locator('.session-cron-job')).toHaveCount(1)

  // Narrow column: the card and its longest row stay inside the panel.
  await page.setViewportSize({ width: 1024, height: 800 })
  await daily.locator('.session-cron-prompt-toggle').click()
  for (const node of [card, card.locator('.session-cron-job-facts').first(), text]) {
    expect(await node.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
  const columnBox = (await column.boundingBox())!
  const cardBox = (await card.boundingBox())!
  expect(cardBox.x).toBeGreaterThanOrEqual(columnBox.x - 1)
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(columnBox.x + columnBox.width + 1)
  await card.screenshot({ path: `${SHOTS}/${info.project.name}-card-narrow-css.png`, scale: 'css' })

  // The card's own close control collapses it and resets the pill.
  await card.getByRole('button', { name: 'Hide cron job details' }).click()
  await expect(card).toHaveCount(0)
  await expect(column.locator('.session-cron-pill')).toHaveAttribute('aria-expanded', 'false')
  await expect(slotCard).toBeVisible()
  expect(errors).toEqual([])
})

test('a response issued before disconnect cannot clear reconnect uncertainty', async ({ page, baseURL }) => {
  let observation = cron({ revision: 1 })
  const held = gate()
  const requested = gate()
  let heldRequests = 0
  await captureWs(page)
  await routeCron(page, () => observation)
  await page.route((url) => url.pathname === `/api/sessions/${SID}/supervision`, (route) => route.fulfill({ json: snapshot() }))
  await page.route((url) => url.pathname === `/api/sessions/${SID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    if (heldRequests++ > 0) return route.fulfill({ response, json: { ...body, cron: observation } })
    body.cron = cron({ revision: 99, presence: 'inactive' })
    requested.release()
    await held.promise
    await route.fulfill({ response, json: body })
  })
  try {
    await openHome(page, baseURL!)
    const row = await findTask(page)
    const pill = row.locator('.session-cron-pill')
    await expect(pill).toHaveAttribute('data-cron-presence', 'active')
    await row.locator('.todo-item-title').click()
    await requested.promise
    await waitForWs(page)
    await page.evaluate(() => {
      ;(window as Window & { __capturedWs?: WebSocket }).__capturedWs!.close()
    })
    await expect(pill).toHaveCount(0)
    await waitForWs(page)
    observation = cron({ revision: 2 })
    await pushCron(page, observation)
    await expect(pill).toHaveAttribute('data-cron-presence', 'active')
    held.release()
    const column = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
    await expect(column.locator('.session-cron-pill')).toHaveAttribute('data-cron-presence', 'active')
    await expect(pill).toHaveAttribute('data-cron-presence', 'active')
  } finally { held.release(); requested.release() }
})
