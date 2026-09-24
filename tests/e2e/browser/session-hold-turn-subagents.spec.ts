/**
 * Playwright browser test: a turn that launches a background subagent must stay
 * OPEN until the subagent finishes, and the followup summary must surface as
 * the turn's answer (port of upstream ACP fix #870 / issues #864-#866).
 *
 * The failure mode this pins:
 *   The CLI emits the user turn's terminal `result` — and its trailing idle —
 *   IMMEDIATELY, while the launched subagent is still running (real-CLI-verified
 *   cycle). Settling there marks the session idle/NEED_ACTION, so the
 *   subagent's later output and the model's promised followup summary land
 *   outside any turn and the "done" state lies.
 *
 * Driven through the real UI against the real server + mock CLI's
 * `hold-turn-test` scenario, which emits exactly that lifecycle INCLUDING the
 * early trailing idle and, deliberately, NO idle after the followup result —
 * so it also pins the followup-result settle lane (a lost trailing idle must
 * not wedge the hold). Reverting the #870 port in
 * src/providers/claude-code-session.ts makes the mid-hold status assertion fail
 * (session flips idle while the subagent is live).
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { selectSection } from './todo-panel-helpers'
import { sessionResultPhase } from '../../../src/core/phase'

const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/session-hold-turn-subagents'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

/** The followup summary the mock CLI streams AFTER the early result+idle. */
const FOLLOWUP_SUMMARY = 'The background agent finished its verification pass.'
const HOLD_PROMPT = `hold-turn-test:${FOLLOWUP_SUMMARY}`

let fixtureRoot = ''

const densityTaskIds: string[] = []
const densityProject = `Status checks ${Date.now()}`

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000)
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  let index = 0
  for (const [tier, count] of [['focus', 21], ['satellite', 50], ['wait', 23], ['backlog', 11]] as const) {
    for (let i = 0; i < count; i++, index++) {
      const response = await request.post('/api/tasks', {
        data: {
          title: `Status board ${index + 1}: verify background work and followup delivery`,
          project: densityProject, pinned: true, focus_tier: tier,
        },
      })
      expect(response.status()).toBe(201)
      const { task } = await response.json()
      densityTaskIds.push(task.id)
      const phase = index < 6 ? 'IN_PROGRESS' : index < 11 ? 'NEED_ACTION' : index < 25 ? 'COMPLETE' : 'TODO'
      if (phase !== 'TODO') {
        const updated = await request.patch(`/api/tasks/${task.id}`, { data: { phase } })
        expect(updated.ok()).toBe(true)
      }
    }
  }
  const response = await request.get(`/api/tasks?working_set=true&project=${encodeURIComponent(densityProject)}`)
  expect(response.ok()).toBe(true)
  const { tasks, truncated } = await response.json()
  expect(truncated).toBe(false)
  expect(tasks).toHaveLength(105)
  for (const [phase, count] of [['TODO', 80], ['NEED_ACTION', 5], ['COMPLETE', 14], ['IN_PROGRESS', 6]]) {
    expect(tasks.filter((task: { phase: string }) => task.phase === phase)).toHaveLength(count)
  }
})

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async ({ request }) => {
  test.setTimeout(120_000)
  for (const id of densityTaskIds) {
    const response = await request.delete(`/api/tasks/${id}`)
    expect(response.ok()).toBe(true)
  }
})

/**
 * Open a draft session column on a real fixture cwd (Claude engine).
 *
 * The launcher moved: "+" grows a draft column and its cwd pill hosts the same
 * folder picker. The draft morphs into the pending → real column in place, so
 * every session assertion below is untouched.
 */
async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible()
  if (process.env.PW_BUILT_SPA === '1') {
    await expect(page.locator('script[src^="/assets/"]')).toHaveCount(1)
    await expect(page.locator('script[src*="/@vite/client"]')).toHaveCount(0)
  }
}

async function openQuickStart(page: Page): Promise<void> {
  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
}

/** Send a prompt through the draft's composer and return the created task id. */
async function sendQuickStart(page: Page, prompt: string): Promise<string> {
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(prompt)
  await input.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }
  return taskId
}

async function sessionIdForTask(page: Page, taskId: string): Promise<string> {
  let sessions: Array<{ claudeSessionId: string }> = []
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    sessions = ((await response.json()) as { sessions: typeof sessions }).sessions
    return sessions.length
  }, { timeout: 20_000 }).toBe(1)
  return sessions[0].claudeSessionId
}

async function processStatus(page: Page, sessionId: string): Promise<string> {
  const response = await page.request.get(`/api/sessions/${sessionId}`)
  return ((await response.json()) as { session: { process_status: string } }).session.process_status
}

test('a spawned reservation joins snapshot tracking before its first turn ends', async ({ page }, testInfo) => {
  const errors: string[] = []
  const failedResponses: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  await openQuickStart(page)
  const taskId = await sendQuickStart(page, 'slow:8000 snapshot-clean-turn:Reservation tracking verified')
  const sessionId = await sessionIdForTask(page, taskId)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible()
  const read = async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    expect(response.ok()).toBe(true)
    return (await response.json()).session
  }
  await expect.poll(async () => (await read()).pid).toBeGreaterThan(1)
  const started = await read()
  expect(started.process_status).toBe('running')
  expect(started.status_reason).not.toBe('awaiting_spawn')
  const runningTask = await page.request.get(`/api/tasks/${taskId}`)
  expect(runningTask.ok()).toBe(true)
  const running = (await runningTask.json()).task
  expect(running.phase).toBe('IN_PROGRESS')
  await selectSection(page, running.focus_tier === 'focus' ? 'Focus' : 'Satellite')
  const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible()
  await expect(card).not.toHaveClass(/needs-action/)
  await card.scrollIntoViewIfNeeded()
  await expect(card).toBeInViewport()
  await expect(panel.locator('.session-panel-badge')).toContainText('Running')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/reservation-${testInfo.project.name}-started.png` })

  await expect.poll(async () => (await read()).process_status, { timeout: 20000 }).toBe('idle')
  const settled = await read()
  expect(settled.status_reason).not.toBe('awaiting_spawn')
  expect(settled.consumedOffset).toBeGreaterThan(0)
  await expect.poll(async () => {
    const response = await page.request.get(`/api/tasks/${taskId}`)
    expect(response.ok()).toBe(true)
    return (await response.json()).task.phase
  }).toBe(sessionResultPhase('IN_PROGRESS'))
  await expect(card).toHaveClass(/needs-action/)
  await expect(panel.locator('.session-panel-badge')).toContainText('Idle')
  await expect(panel.getByText('Reservation tracking verified', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/reservation-${testInfo.project.name}-settled.png` })

  const composer = panel.locator('.chat-input-textarea')
  await composer.fill('slow:300 snapshot-clean-turn:Followup stayed on the original process')
  await composer.press('Enter')
  await expect(panel.getByText('Followup stayed on the original process', { exact: true }).first()).toBeVisible()
  await expect.poll(async () => (await read()).process_status).toBe('idle')
  expect((await read()).pid).toBe(started.pid)
  await expect(card).toHaveClass(/needs-action/)
  await expect(panel.locator('.rich-app-building')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/reservation-${testInfo.project.name}-followup.png` })
  const evidence = JSON.stringify({ started, settled, final: await read(), failedResponses, errors,
    scripts: await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))),
  })
  await fs.writeFile(`${SCREENSHOT_DIR}/reservation-${testInfo.project.name}-state.json`, evidence)
  await testInfo.attach('reservation-state', { body: evidence, contentType: 'application/json' })
  expect(failedResponses).toEqual([])
  expect(errors).toEqual([])
})

test('a resumed background agent stays running until its new invocation ends', async ({ page }) => {
  await openQuickStart(page)
  const taskId = await sendQuickStart(page, 'resumed-background-agent-test')
  const sessionId = await sessionIdForTask(page, taskId)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('The same background agent is running its second verification pass.', { exact: false }).first()).toBeVisible()
  expect(await processStatus(page, sessionId)).toBe('running')
  const taskResponse = await page.request.get(`/api/tasks/${taskId}`)
  expect(taskResponse.ok()).toBe(true)
  expect((await taskResponse.json()).task.phase).toBe('IN_PROGRESS')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    expect(await processStatus(page, sessionId)).toBe('running')
    await page.waitForTimeout(200)
  }
  await page.screenshot({ path: `${SCREENSHOT_DIR}/resumed-agent-running.png` })
  await expect(panel.getByText('The second verification pass is complete.', { exact: false }).first()).toBeVisible({ timeout: 20000 })
  await expect.poll(() => processStatus(page, sessionId)).toBe('idle')
  await expect.poll(async () => {
    const response = await page.request.get(`/api/tasks/${taskId}`)
    expect(response.ok()).toBe(true)
    return (await response.json()).task.phase
  }).toBe(sessionResultPhase('IN_PROGRESS'))
  await expect(page.locator(`[data-task-id="${taskId}"]`).first()).toHaveClass(/needs-action/)
  await expect(page.getByText("A session's summary couldn't be parsed", { exact: true })).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/resumed-agent-finished.png` })
})

test('turn stays open across the early result+idle and completes with the followup summary', async ({ page }) => {
  test.setTimeout(90_000)

  await openQuickStart(page)
  const taskId = await sendQuickStart(page, HOLD_PROMPT)
  const sessionId = await sessionIdForTask(page, taskId)

  // Phase 1 — the mock emitted the user result AND its trailing idle in the
  // first batch, with the subagent still live. THE ASSERTION THIS SPEC EXISTS
  // FOR: the session must NOT settle there. Pre-#870 the idle handler (or the
  // result handler) would flip process_status to idle here.
  // The launch text streams immediately; wait for it so we know the first
  // batch (assistant + result + idle) has been processed before judging.
  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Launching a background agent', { exact: false }).first())
    .toBeVisible({ timeout: 20_000 })
  expect(await processStatus(page, sessionId)).toBe('running')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/held-open-mid-subagent.png`, fullPage: true })

  // Phase 2 — subagent terminal + followup summary + followup result (NO
  // trailing idle after it). The turn must complete WITH the summary visible.
  await expect(panel.getByText(FOLLOWUP_SUMMARY, { exact: false }).first())
    .toBeVisible({ timeout: 30_000 })
  await expect.poll(() => processStatus(page, sessionId), { timeout: 20_000 })
    .toMatch(/idle|stopped/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/completed-with-summary.png`, fullPage: true })
})

test('a plain turn with no subagents still completes instantly (no added latency)', async ({ page }) => {
  test.setTimeout(60_000)

  // Upstream's no-regression check: turns that spawned nothing settle at their
  // result — the hold must never tax a normal prompt.
  await openQuickStart(page)
  const taskId = await sendQuickStart(page, 'plain hold-port control message')
  const sessionId = await sessionIdForTask(page, taskId)

  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('I processed your message', { exact: false }).first())
    .toBeVisible({ timeout: 25_000 })
  await expect.poll(() => processStatus(page, sessionId), { timeout: 20_000 })
    .toMatch(/idle|stopped/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/plain-turn-control.png`, fullPage: true })
})

test('a late session hint cannot erase a red task row, but committed task changes can', async ({ page }) => {
  const taskId = densityTaskIds[6]
  const sessionId = 'phase-hint-fixture'
  let socket: import('@playwright/test').WebSocketRoute | undefined
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
    socket = route
    route.connectToServer()
  })
  await page.route('**/api/tasks?**', async (route) => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const body = await response.json()
    body.tasks = body.tasks.map((task: { id: string }) => task.id === taskId
      ? { ...task, session_id: sessionId } : task)
    await route.fulfill({ response, json: body })
  })
  await openHome(page)
  await selectSection(page, 'Focus')
  const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible()
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/red-before-session-hint.png` })
  await expect.poll(() => Boolean(socket)).toBe(true)
  socket!.send(JSON.stringify({
    type: 'event', name: 'session:status-changed', seq: Date.now(),
    data: { sessionId, taskId, phase: 'IN_PROGRESS', process_status: 'idle' },
  }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/red-after-session-hint.png` })
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  expect(await card.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgba(255, 59, 48, 0.08)')
  const persisted = await page.request.get(`/api/tasks/${taskId}`)
  expect(persisted.ok()).toBe(true)
  expect((await persisted.json()).task.phase).toBe('NEED_ACTION')
  for (const phase of ['IN_PROGRESS', 'NEED_ACTION'] as const) {
    const updated = await page.request.patch(`/api/tasks/${taskId}`, { data: { phase } })
    expect(updated.ok()).toBe(true)
    if (phase === 'IN_PROGRESS') await expect(card).not.toHaveClass(/todo-pinned-card-needs-action/)
    else await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  }
  const read = await page.request.patch(`/api/tasks/${taskId}`, { data: { unread: false } })
  expect(read.ok()).toBe(true)
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/red-retained-after-read.png` })
  await card.getByRole('button', { name: 'Mark complete', exact: true }).click()
  await expect(card).toHaveClass(/todo-pinned-card-done/)
  const completed = await page.request.get(`/api/tasks/${taskId}`)
  expect(completed.ok()).toBe(true)
  socket!.send(JSON.stringify({
    type: 'event', name: 'task:updated', seq: Date.now(),
    data: { task: { ...(await completed.json()).task, session_id: sessionId } },
  }))
  socket!.send(JSON.stringify({
    type: 'event', name: 'session:status-changed', seq: Date.now(),
    data: { sessionId, taskId, phase: 'IN_PROGRESS', process_status: 'running' },
  }))
  await page.waitForTimeout(300)
  await expect(card).toHaveClass(/todo-pinned-card-done/)
  await expect(card).not.toHaveClass(/todo-pinned-card-needs-action/)
})

test('red task rows stay current across tiers, reading races, and reconnects', async ({ page }) => {
  test.setTimeout(60_000)
  const sockets: import('@playwright/test').WebSocketRoute[] = []
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
    sockets.push(route)
    route.connectToServer()
  })
  await openHome(page)
  await expect.poll(() => sockets.length).toBe(1)
  for (const [tier, index] of [['Focus', 6], ['Satellite', 26], ['Wait', 71], ['Backlog', 94]] as const) {
    const id = densityTaskIds[index]
    const update = await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION', unread: true } })
    expect(update.ok()).toBe(true)
    await selectSection(page, tier)
    const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${id}"]`)
    await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
    await expect(card.locator('.task-unread-dot')).toBeVisible()
    await card.locator('.todo-pinned-title').click()
    await expect(card.locator('.task-unread-dot')).toHaveCount(0)
    await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/red-read-${tier.toLowerCase()}.png` })
  }

  const id = densityTaskIds[6]
  await selectSection(page, 'Focus')
  const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${id}"]`)
  const reset = await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'IN_PROGRESS', unread: true } })
  expect(reset.ok()).toBe(true)
  await expect(card).not.toHaveClass(/todo-pinned-card-needs-action/)
  await expect(card.locator('.task-unread-dot')).toBeVisible()
  let releaseRead!: () => void
  const holdRead = new Promise<void>((resolve) => { releaseRead = resolve })
  let readStarted = false
  await page.route(`**/api/tasks/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH' || route.request().postDataJSON()?.unread !== false) {
      await route.continue()
      return
    }
    readStarted = true
    await holdRead
    await route.continue()
  })
  try {
    await card.locator('.todo-pinned-title').click()
    await expect.poll(() => readStarted).toBe(true)
    const settled = await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION', unread: true } })
    expect(settled.ok()).toBe(true)
    await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  } finally {
    releaseRead()
  }
  await expect(card.locator('.task-unread-dot')).toHaveCount(0)
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/)

  const firstSocket = sockets[0]
  await firstSocket.close({ code: 1012, reason: 'test reconnect' })
  const offlineUpdate = await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'IN_PROGRESS' } })
  expect(offlineUpdate.ok()).toBe(true)
  await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThan(1)
  await expect(card).not.toHaveClass(/todo-pinned-card-needs-action/)
  const handback = await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION' } })
  expect(handback.ok()).toBe(true)
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/red-after-reconnect.png` })
})

test('a cold Home whose socket connects late still paints the hand-back red', async ({ page }) => {
  test.setTimeout(90_000)
  // Index 0: focus tier, seeded IN_PROGRESS (so not red, no dot) and untouched
  // by every other test in this file.
  const taskId = densityTaskIds[0]
  let allowServer = false
  let serverConnects = 0
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
    if (!allowServer) {
      route.close()
      return
    }
    serverConnects++
    route.connectToServer()
  })
  await openHome(page)
  await selectSection(page, 'Focus')
  const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible()
  await expect(card).not.toHaveClass(/todo-pinned-card-needs-action/)

  const handback = await page.request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })
  expect(handback.ok()).toBe(true)
  const persisted = await page.request.get(`/api/tasks/${taskId}`)
  expect(persisted.ok()).toBe(true)
  const committed = (await persisted.json()).task
  expect(committed.phase).toBe('NEED_ACTION')
  expect(committed.unread).toBe(true)
  // Committed on the server, unreachable by this page: no socket carried it.
  await page.waitForTimeout(1_000)
  expect(serverConnects).toBe(0)
  await expect(card).not.toHaveClass(/todo-pinned-card-needs-action/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/cold-open-stale-before-connect.png` })

  allowServer = true
  await expect.poll(() => serverConnects, { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/, { timeout: 20_000 })
  await expect(card.locator('.task-unread-dot')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/cold-open-red-after-late-connect.png` })
})

test('permission, question, and plan decisions stay red while waiting and settle after the real FIFO reply', async ({ page }) => {
  test.setTimeout(120_000)
  let spawnMode = 'default'
  const settledSessions: string[] = []
  await page.route('**/api/sessions/quick-start', (route) => route.continue({
    postData: JSON.stringify({ ...route.request().postDataJSON(), mode: spawnMode }),
  }))
  for (const [toolName, mode, decision] of [
    ['Bash', 'default', 'allow'], ['Bash', 'default', 'deny'],
    ['AskUserQuestion', 'bypass', 'Staging'], ['ExitPlanMode', 'plan', 'allow'],
  ]) {
    spawnMode = mode
    await openQuickStart(page)
    const taskId = await sendQuickStart(page, `status-permission-test:${toolName}`)
    const sessionId = await sessionIdForTask(page, taskId)
    const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
    const taskResponse = await page.request.get(`/api/tasks/${taskId}`)
    expect(taskResponse.ok()).toBe(true)
    const { task } = await taskResponse.json()
    await selectSection(page, task.focus_tier === 'focus' ? 'Focus' : 'Satellite')
    const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)
    const permission = panel.locator('.permission-request-card').filter({ has: page.getByRole('button', { name: toolName === 'AskUserQuestion' ? 'Submit' : 'Allow', exact: true }) })
    await expect(permission).toBeVisible({ timeout: 20_000 })
    for (const settledId of settledSessions) {
      await expect(page.locator(`${REAL_PANEL}[data-session-id="${settledId}"] .permission-request-actions button`)).toHaveCount(0)
    }
    await expect.poll(() => processStatus(page, sessionId)).toBe('running')
    await expect(panel.locator('.session-panel-badge[title^="Waiting"]')).toBeVisible()
    await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/waiting-${toolName}-${decision}.png` })
    if (toolName === 'AskUserQuestion') {
      await permission.getByRole('button', { name: /Staging/ }).click()
      await permission.getByRole('button', { name: 'Submit', exact: true }).click()
    } else {
      await permission.getByRole('button', { name: decision === 'allow' ? 'Allow' : 'Deny', exact: true }).click()
    }
    await expect(panel.getByText(`${toolName} decision received: ${decision}`, { exact: false }).first()).toBeVisible()
    await expect.poll(() => processStatus(page, sessionId)).toBe('idle')
    await expect(panel.locator('.permission-request-actions button')).toHaveCount(0)
    settledSessions.push(sessionId)
    await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  }
  await page.screenshot({ path: `${SCREENSHOT_DIR}/permission-decisions-settled.png` })
})
