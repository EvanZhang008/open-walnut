import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { openKebabGroup } from './kebab-group-helpers'

const SESSION_ID = 'pw-workflow-session'
const TASK_ID = 'pw-task-workflow'
const PANEL = `.session-panel[data-session-id="${SESSION_ID}"]`

async function openTaskSession(page: Page, sessionId: string, taskId: string) {
  await page.route('**/api/search/agent?*', route => route.fulfill({
    json: { summary: '', results: [], model: 'fixture', tookMs: 0 },
  }))
  await page.goto('/')
  const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  // A fill that lands while the board is still hydrating can be reset; type again until it holds.
  await expect(async () => {
    await page.locator('.todo-search-input').fill(taskId)
    await expect(task).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  return page.locator(`.session-panel[data-session-id="${sessionId}"]`)
}

/** What the user reads: rendered text only, whitespace collapsed. */
function visibleText(locator: ReturnType<Page['locator']>) {
  return locator.evaluate(el => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
}

async function openWorkflow(page: Page, sessionId = SESSION_ID, taskId = TASK_ID) {
  const panel = await openTaskSession(page, sessionId, taskId)
  await expect(panel.locator('.wf-card-count')).toContainText('106/107 agents done', { timeout: 30_000 })
  await panel.locator('.wf-card-fullscreen').click()
  await expect(panel.locator('.wf-card')).toHaveClass(/open-walnut-fullscreen/)
  await expectSheetInsideWindow(page, panel.locator('.wf-card'))
  return panel
}

/** A fullscreen sheet sits 2.5vh from the top and ends inside the window. */
async function expectSheetInsideWindow(page: Page, sheet: ReturnType<Page['locator']>) {
  const vh = page.viewportSize()!.height
  await expect.poll(async () => {
    const box = (await sheet.boundingBox())!
    return Math.abs(box.y - vh * 0.025) <= 2 && box.y + box.height <= vh + 0.5
  }, { message: 'fullscreen sheet inside the window' }).toBe(true)
}

/** Keep a handle on the app's /ws socket so a test can deliver a live ledger event. */
async function captureSocket(page: Page) {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') (window as any).__workflowSocket = this
      }
    } as typeof WebSocket
  })
}

async function emitBackgroundTasks(page: Page, data: Record<string, unknown>) {
  await page.waitForFunction(() => (window as any).__workflowSocket?.readyState === WebSocket.OPEN)
  await page.evaluate((data) => {
    const ws = (window as any).__workflowSocket as WebSocket
    // The fixture session is stopped; a session whose backgrounded work still runs is
    // 'running' on the server (it stays so until the last one drains), and only a live
    // session claims work still running.
    const status = { taskId: null, process_status: 'running', activity: 'Background command running', mode: 'bypass', planCompleted: false, archived: false, errorMessage: null, provider: 'cli', engine: 'claude', pendingPermissionTool: null, statusRevision: Date.now(), statusUpdatedAt: new Date().toISOString() }
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'session:status-changed', data: { sessionId: data.sessionId, ...status }, seq: Date.now() }) }))
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'session:background-tasks', data, seq: Date.now() }) }))
  }, data)
}

function shellTask(i: number, status: string) {
  return { taskId: `bash-${i}`, taskType: 'local_bash', status, description: `Run the fixture check number ${i + 1}` }
}

test.describe('Workflow overview at real fan-out density', () => {
  test.setTimeout(120_000)
  // The fixture server outlives a test (repeat runs reuse it): leave its disk as found.
  const writtenFiles: string[] = []
  test.afterEach(async () => { await Promise.all(writtenFiles.splice(0).map(f => fs.rm(f, { force: true }))) })

  test('the real manifest identifies the failure without a 107-cell diagram', async ({ page, request }) => {
    const response = await request.get(`/api/sessions/${SESSION_ID}/workflow`)
    expect(response.ok()).toBe(true)
    const payload = await response.json()
    expect(payload.agents).toHaveLength(107)
    expect(payload.agents.filter((agent: { status: string }) => agent.status === 'failed')).toHaveLength(1)

    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const failedRequests: string[] = []
    page.on('response', response => {
      if (response.status() >= 400 && response.url().includes('/api/sessions/pw-workflow-session/workflow')) {
        failedRequests.push(`${response.status()} ${response.url()}`)
      }
    })
    const panel = await openWorkflow(page)
    const card = panel.locator('.wf-card')
    const dir = `/tmp/workflow-overview/${test.info().project.name}`
    await fs.mkdir(dir, { recursive: true })
    await page.waitForTimeout(220)
    await page.screenshot({ path: `${dir}/dense-overview.png`, scale: 'css' })
    await expect(card.locator('.wf-graph-horizontal')).toHaveCount(0)
    await expect(card.locator('.wf-density-cell')).toHaveCount(0)
    // Fullscreen reads the stages left to right, one row, with the relationship
    // the clocks prove written on each connector.
    const strip = card.locator('.wf-stage-graph--strip')
    await expect(strip).toBeVisible()
    await expect(strip.locator('.wf-stage-card-title')).toHaveText(['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize'])
    await expect(strip.locator('.wf-stage-link')).toHaveCount(4)
    expect(await strip.locator('.wf-stage-link').evaluateAll(els => els.map(el => el.getAttribute('data-link-kind')))).toEqual(['split', 'stream', 'after', 'merge'])
    await expect(strip.locator('.wf-stage-link-verb')).toHaveText(['splits', 'streams', 'after all', 'merges'])
    await expect(strip.locator('.wf-stage-link-counts')).toHaveText(['1 → 5', '5 → 25', '25 → 75', '75 → 1'])
    await expect(strip.locator('.wf-stage-link').nth(1)).toHaveAttribute('title', 'starts as each finishes (5 → 25)')
    const cardTops = await strip.locator('.wf-stage-card').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)))
    expect(new Set(cardTops).size, 'the five stages share one row').toBe(1)
    expect(await strip.locator('.wf-stage-card').evaluateAll(els => els.map(el => [...el.classList].find(c => /--(done|failed|running|waiting|future)$/.test(c)))))
      .toEqual(['wf-stage-card--done', 'wf-stage-card--done', 'wf-stage-card--failed', 'wf-stage-card--done', 'wf-stage-card--done'])
    await expect(strip.locator('.wf-stage-card--open .wf-stage-card-title')).toHaveText('Fetch')
    await expect(strip.locator('.wf-stage-card--failed .wf-stage-card-sub')).toHaveText(/^1 failed · \d+m \d+s$/)
    await expect(strip.locator('.wf-stage-card').first().locator('.wf-stage-card-sub')).toHaveText('Done in 32s')
    await expect(strip.locator('.wf-stage-card--failed .wf-stage-card-count')).toHaveText('25/25')
    await expect(card.locator('.wf-overview-heading .wf-overview-link')).toHaveText('starts as each finishes (5 → 25)')
    await expect(card.locator('.wf-gnode-failed .wf-gnode-name')).toHaveText('Fetch the long-form source with complete citations and a fallback archive')
    await expect(card.locator('.wf-gnode-head')).toHaveCount(25)
    const firstName = await card.locator('.wf-gnode-name').first().textContent()
    expect(firstName).toBe('Fetch the long-form source with complete citations and a fallback archive')
    await card.locator('.wf-gnode-failed .wf-gnode-head').click()
    await expect(card.locator('.wf-agent-prompt')).toContainText('Preserve every citation')
    await card.locator('.wf-transcript-toggle').click()
    await expect(page.locator('.wf-modal-body')).toContainText('The source returned an error after the retry.')
    await page.keyboard.press('Escape')
    await expect(page.locator('.wf-modal-body')).toHaveCount(0)
    await card.locator('.wf-stage-card', { hasText: 'Verify' }).click()
    await expect(card.locator('.wf-stage-card--open .wf-stage-card-title')).toHaveText('Verify')
    await expect(card.locator('.wf-gnode-head')).toHaveCount(75)
    await expect(card.locator('.wf-overview-count')).toHaveText('75 agents')
    await expect(card.locator('.wf-overview-heading .wf-overview-link')).toHaveText('after all 25, fans out to 75')
    await card.locator('.wf-search').fill('source 75')
    await expect(card.locator('.wf-gnode-head')).toHaveCount(1)
    await expect(card.locator('.wf-gnode-name')).toContainText('Verify source 75')
    await card.locator('.wf-search').fill('fallback archive')
    await expect(card.locator('.wf-gnode-head')).toHaveCount(1)
    await expect(card.locator('.wf-gnode-failed')).toHaveCount(1)
    await card.locator('.wf-search').fill('no matching agent')
    await expect(card.locator('.wf-empty')).toContainText('No matching agents')
    await card.locator('.wf-search').fill('')
    await expect(card.locator('.wf-gnode-head')).toHaveCount(75)
    await card.locator('.wf-script-toggle').click()
    await expect(card.locator('.wf-script')).toContainText('deep-research')
    await card.locator('.wf-script-toggle').click()
    await expect(card.locator('.wf-script')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(card).not.toHaveClass(/open-walnut-fullscreen/)
    await card.locator('.wf-card-collapse').click()
    await expect(card.locator('.wf-overview')).toBeVisible()
    // The session column stacks the stages top to bottom; the chosen phase's
    // agents open right under its card, and the sentence sits on each connector.
    const column = card.locator('.wf-stage-graph--column')
    await expect(column).toBeVisible()
    await expect(card.locator('.wf-stage-graph--strip')).toHaveCount(0)
    await expect(column.locator('.wf-stage-link-label')).toHaveText(['splits into 5', 'starts as each finishes (5 → 25)', 'after all 25, fans out to 75', 'merges 75 into 1'])
    const verifyStage = column.locator('.wf-stage', { has: page.locator('.wf-stage-card--open') })
    await expect(verifyStage.locator('.wf-stage-card-title')).toHaveText('Verify')
    await expect(verifyStage.locator('.wf-stage-list .wf-gnode-head')).toHaveCount(75)
    const columnCards = await column.locator('.wf-stage-card').evaluateAll(els => els.map(el => el.getBoundingClientRect().top))
    expect(columnCards.every((top, i) => i === 0 || top > columnCards[i - 1]), 'stages read top to bottom').toBe(true)
    const listBox = (await verifyStage.locator('.wf-stage-list .wf-overview-list').boundingBox())!
    expect(listBox.height, 'a 75-agent phase scrolls inside its own box').toBeLessThanOrEqual(265)
    await page.waitForTimeout(220)
    await page.screenshot({ path: `${dir}/narrow-stage-column.png`, scale: 'css' })
    // Clicking the open card closes its list; clicking it again brings it back.
    await verifyStage.locator('.wf-stage-card').click()
    await expect(column.locator('.wf-stage-list')).toHaveCount(0)
    await column.locator('.wf-stage-card', { hasText: 'Verify' }).click()
    await expect(card.locator('.wf-gnode-head')).toHaveCount(75)

    await page.screenshot({ path: `${dir}/narrow-after-reopen.png`, scale: 'css' })
    const narrowTitle = card.locator('.wf-card-title')
    const titleBox = await narrowTitle.boundingBox()
    const headerBox = await card.locator('.wf-card-header').boundingBox()
    expect(titleBox && headerBox && titleBox.x + titleBox.width <= headerBox.x + headerBox.width).toBe(true)
    // A two-column layout leaves the card ~300px: the name keeps its room, the
    // header tallies drop their optional parts before the counts are cut.
    await card.evaluate(el => { (el as HTMLElement).style.width = '300px' })
    await expect.poll(() => visibleText(card.locator('.wf-card-title'))).toBe('deep-research')
    await expect.poll(() => visibleText(card.locator('.wf-script-toggle'))).toBe('Script')
    await expect(card.locator('.wf-card-failed')).toBeVisible()
    await expectNothingClipped(card.locator('.wf-card-header-meta'), 'workflow header at 300px')
    await card.evaluate(el => { (el as HTMLElement).style.width = '' })
    await expect.poll(() => visibleText(card.locator('.wf-card-title'))).toBe('Workflow: deep-research')
    await page.reload()
    const reopened = page.locator(PANEL)
    await expect.poll(() => visibleText(reopened.locator('.wf-card-count')), { timeout: 30_000 }).toBe('106/107 agents done · 1 failed')
    await expect(reopened.locator('.wf-card-header .wf-card-state--failed')).toHaveText('!')
    await expect(reopened.locator('.wf-card-header .wf-card-tokens')).toHaveText('8.6M tok')
    await expect(reopened.locator('.wf-card-header .wf-card-count')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await reopened.locator('.wf-card-fullscreen').click()
    await expect(reopened.locator('.wf-gnode-failed')).toHaveCount(1)
    await expectSheetInsideWindow(page, reopened.locator('.wf-card'))
    await page.evaluate(() => {
      localStorage.setItem('open-walnut-theme', 'dark')
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await page.waitForTimeout(220)
    await page.screenshot({ path: `${dir}/dark-overview.png`, scale: 'css' })
    expect(errors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('a later workflow resets the old phase and search without losing the new run', async ({ page }) => {
    const sessionId = `pw-workflow-switch-${test.info().project.name}`
    const taskId = `pw-switch-workflow-task-${test.info().project.name}`
    await captureSocket(page)
    const panel = await openWorkflow(page, sessionId, taskId)
    const card = panel.locator('.wf-card')
    await card.locator('.wf-stage-card', { hasText: 'Verify' }).click()
    await card.locator('.wf-search').fill('source 75')
    await expect(card.locator('.wf-gnode-head')).toHaveCount(1)
    await page.waitForFunction(() => (window as any).__workflowSocket?.readyState === WebSocket.OPEN)
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    expect(response.ok()).toBe(true)
    const session = (await response.json()).session
    const fixtureHome = path.dirname(path.dirname(session.cwd))
    expect(path.basename(fixtureHome)).toMatch(/^walnut-pw-\d+$/)
    const dir = path.join(fixtureHome, '.claude', 'projects', session.cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'workflows')
    const followUp = path.join(dir, 'wf_follow-up-run.json')
    writtenFiles.push(followUp)
    await fs.writeFile(followUp, JSON.stringify({
      runId: 'wf_follow-up-run', workflowName: 'follow-up-review', summary: 'Check the last unresolved item.',
      script: 'export const meta = { name: "follow-up-review" }', startTime: Date.now() + 1_000,
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Review' },
        { type: 'workflow_agent', agentId: 'new-run-1', index: 0, phaseIndex: 1, label: 'Review final result', state: 'start', promptPreview: 'Review the final result.' },
      ],
    }))
    const onDisk = await page.request.get(`/api/sessions/${sessionId}/workflow`)
    expect(onDisk.ok()).toBe(true)
    expect((await onDisk.json()).workflowName).toBe('follow-up-review')
    await emitBackgroundTasks(page, {
      sessionId, workflowName: 'follow-up-review', scriptSource: 'export const meta = { name: "follow-up-review" }',
      workflowDescription: 'Check the last unresolved item.', inFlight: 1, tasks: [],
      phases: [{ index: 1, title: 'Review' }],
      agents: [{ agentId: 'new-run-1', index: 0, phaseIndex: 1, label: 'Review final result', status: 'running', promptPreview: 'Review the final result.' }],
    })
    await expect(card.locator('.wf-card-title')).toHaveText('Workflow: follow-up-review')
    await expect(card.locator('.wf-search')).toHaveValue('')
    await expect(card.locator('.wf-stage-card-title')).toHaveText(['Review'])
    await expect(card.locator('.wf-stage-card--running .wf-stage-card-sub')).toHaveText('1 running')
    await expect(card.locator('.wf-gnode-name')).toHaveText('Review final result')
    await expect(card.locator('.wf-gnode-running')).toHaveCount(1)
    await card.locator('.wf-card-fullscreen').click()
    await expect(card).not.toHaveClass(/open-walnut-fullscreen/)
    await expect(card.locator('.wf-overview')).toHaveCount(0)
    await card.locator('.wf-card-collapse').click()
    await expect(card.locator('.wf-gnode-running')).toHaveCount(1)
    await card.locator('.wf-card-collapse').click()
    await expect(card.locator('.wf-overview')).toHaveCount(0)
    await card.locator('.wf-card-collapse').click()
    await expect(card.locator('.wf-gnode-running')).toHaveCount(1)
  })
})

/** Nothing the user reads is cut: the title, the running and failed counts, and the tally. */
async function expectNothingClipped(root: ReturnType<Page['locator']>, label: string) {
  const clipped = await root.evaluate(el => {
    const count = el.querySelector('.wf-card-count') as HTMLElement
    const c = count.getBoundingClientRect()
    return ['.wf-card-title', '.wf-card-running', '.wf-card-failed', '.wf-card-count-done', '.wf-card-count-short'].flatMap(sel => {
      const part = el.querySelector(sel) as HTMLElement | null
      if (!part || part.getClientRects().length === 0) return []
      const r = part.getBoundingClientRect()
      const cut = part.scrollWidth > part.clientWidth + 1 || (sel !== '.wf-card-title' && r.right > c.right + 0.5)
      return cut ? [sel] : []
    })
  })
  expect(clipped, label).toEqual([])
}

/** The after-turn line that names the session's background work (SessionWorkingIndicator). */
function backgroundNote(panel: ReturnType<Page['locator']>) {
  return panel.locator('[data-testid="session-background-note"]')
}

/** The session's ⋮ menu, opened from the panel header the way a user opens it, with its
 *  Views group open (the Background tasks row lives there). */
async function openSessionMenu(page: Page, panel: ReturnType<Page['locator']>) {
  await panel.locator('.session-panel-header').getByRole('button', { name: 'More actions' }).click()
  await openKebabGroup(page.locator('.task-kebab-menu:visible'), 'session-kebab-views')
  const row = page.locator('.task-kebab-menu:visible [data-testid="session-kebab-background"]')
  return row
}

async function shootNote(page: Page, note: ReturnType<Page['locator']>, name: string) {
  const dir = `/tmp/workflow-overview/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await note.scrollIntoViewIfNeeded()
  const box = (await note.boundingBox())!
  await page.screenshot({
    path: `${dir}/${name}.png`, scale: 'css',
    clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: Math.min(box.width + 32, 1280), height: box.height + 32 },
  })
}

test.describe('Background work', () => {
  test.setTimeout(120_000)

  test('has no bar at the top: its running count rides the after-turn line and the ⋮ menu, from the reported case to completion and dark', async ({ page }) => {
    const project = test.info().project.name
    const sessionId = `pw-background-bar-${project}`
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await captureSocket(page)
    const panel = await openTaskSession(page, sessionId, `pw-bgbar-task-${project}`)
    // History has rendered, so the ledger hook is subscribed before the first event.
    await expect(panel).toContainText('Review underway.', { timeout: 30_000 })
    const note = backgroundNote(panel)

    // The reported shape: six shell commands, five finished, one still running.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 1, phases: [], agents: [],
      tasks: [0, 1, 2, 3, 4].map(i => shellTask(i, 'completed')).concat(shellTask(5, 'running')),
    })
    await expect(note.locator('.session-working-label')).toHaveText('1 command still running in the background', { timeout: 30_000 })
    await expect(note).toHaveText(/background\s*›$/)
    // Nothing is pinned at the top of the session for plain background work.
    await expect(panel.locator('.wf-card')).toHaveCount(0)
    await expect(panel.locator('.wf-card--bar')).toHaveCount(0)
    // The line is the chat's last thing, inside the chat column, and its words are whole.
    const fit = await note.evaluate(el => {
      const label = el.querySelector('.session-working-label') as HTMLElement
      const r = el.getBoundingClientRect(), chat = el.closest('.session-history')!.getBoundingClientRect()
      return { cut: label.scrollWidth > label.clientWidth + 1, inside: r.left >= chat.left - 0.5 && r.right <= chat.right + 0.5, height: r.height }
    })
    expect(fit).toEqual({ cut: false, inside: true, height: expect.any(Number) })
    expect(fit.height).toBeLessThanOrEqual(44)
    await shootNote(page, note, 'background-after-turn-reported')
    // The ⋮ menu counts what is running.
    let row = await openSessionMenu(page, panel)
    await expect(row).toBeVisible()
    await expect(row.locator('.session-action-chip-count')).toHaveText('1')
    await page.keyboard.press('Escape')
    await expect(row).toHaveCount(0)

    // A running agent next to commands, one of which failed: only the agent still runs.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 1, phases: [], agents: [],
      tasks: [
        { taskId: 'agent-1', taskType: 'local_agent', subagentType: 'explore', status: 'running', description: 'Find every caller of the old parser', tokens: 61_234 },
        shellTask(0, 'completed'), shellTask(1, 'completed'), shellTask(2, 'completed'), shellTask(3, 'failed'),
      ],
    })
    await expect(note.locator('.session-working-label')).toHaveText('1 agent still running in the background', { timeout: 30_000 })

    // The reported density: 2 agents beside 150 commands, one failed, one running.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 3, phases: [], agents: [],
      tasks: [
        { taskId: 'agent-a', taskType: 'local_agent', status: 'running', description: 'Map every caller', tokens: 96_200 },
        { taskId: 'agent-b', taskType: 'local_agent', status: 'running', description: 'Draft the notes', tokens: 94_100 },
        ...Array.from({ length: 150 }, (_, i) => shellTask(i, i === 40 ? 'failed' : i === 149 ? 'running' : 'completed')),
      ],
    })
    await expect(note.locator('.session-working-label')).toHaveText('2 agents, 1 command still running in the background', { timeout: 30_000 })
    await expect(panel.locator('.wf-card')).toHaveCount(0)
    row = await openSessionMenu(page, panel)
    await expect(row.locator('.session-action-chip-count')).toHaveText('3')
    await expect(row.locator('.session-action-chip-count')).toHaveAttribute('title', '2 agents, 1 command running')
    await page.keyboard.press('Escape')
    await shootNote(page, note, 'background-after-turn-dense')

    // Everything settles: the line goes, the ⋮ menu keeps the way in (no count), and
    // the panel lists every finished command.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 0, phases: [], agents: [],
      tasks: [0, 1, 2, 3, 4, 5].map(i => shellTask(i, 'completed')),
    })
    await expect(note).toHaveCount(0)
    row = await openSessionMenu(page, panel)
    await expect(row).toHaveText('Background tasks')
    await expect(row.locator('.session-action-chip-count')).toHaveCount(0)
    await row.click()
    const tasksPanel = page.locator('.wf-modal--tasks')
    await expect(tasksPanel.locator('.bg-task-row')).toHaveCount(6)
    await expect(tasksPanel.locator('.bg-tasks-section-title')).toHaveText(['Finished'])
    await page.keyboard.press('Escape')
    await expect(tasksPanel).toHaveCount(0)

    // Dark: the line takes the dark muted ink, never a light native button face.
    await page.evaluate(() => {
      localStorage.setItem('open-walnut-theme', 'dark')
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 1, phases: [], agents: [],
      tasks: [0, 1, 2, 3, 4].map(i => shellTask(i, 'completed')).concat(shellTask(5, 'running')),
    })
    await expect(note.locator('.session-working-label')).toHaveText('1 command still running in the background', { timeout: 30_000 })
    await page.mouse.move(0, 0)
    const darkInk = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.cssText = 'color: var(--fg-muted)'
      document.body.append(probe)
      const { color } = getComputedStyle(probe)
      probe.remove()
      return color
    })
    await expect(note).toHaveCSS('color', darkInk)
    await expect(note).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await shootNote(page, note, 'background-after-turn-dark')
    // The line opens the same panel, with the running command in it.
    await note.click()
    await expect(tasksPanel.locator('.bg-task-row-running')).toHaveCount(1)
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('the panel keeps agents and commands apart: one tab each, commands one line apiece', async ({ page }) => {
    const project = test.info().project.name
    const sessionId = `pw-background-bar-${project}`
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await captureSocket(page)
    const panel = await openTaskSession(page, sessionId, `pw-bgbar-task-${project}`)
    await expect(panel).toContainText('Review underway.', { timeout: 30_000 })
    // The reported density: 2 agents, 150 commands (one failed, one running), and a
    // job of no known kind, the "bgpq669i Task" row from the report.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 2, phases: [], agents: [],
      tasks: [
        ...Array.from({ length: 150 }, (_, i) => ({ ...shellTask(i, i === 40 ? 'failed' : i === 149 ? 'running' : 'completed'), startedAt: Date.now() - 60_000, ...(i === 149 ? {} : { endedAt: Date.now() - 60_000 + 3_000 + i * 100 }) })),
        { taskId: 'agent-a', taskType: 'local_agent', subagentType: 'general-purpose', status: 'running', description: '/code-review', tokens: 96_200, toolUses: 40, startedAt: Date.now() - 580_000 },
        { taskId: 'agent-b', taskType: 'local_agent', subagentType: 'general-purpose', status: 'completed', description: '/code-review', tokens: 94_100, toolUses: 12, startedAt: Date.now() - 120_000, endedAt: Date.now() - 67_000 },
        { taskId: 'bgpq669i', status: 'completed' },
      ],
    })
    const note = backgroundNote(panel)
    await expect(note.locator('.session-working-label')).toHaveText('1 agent, 1 command still running in the background', { timeout: 30_000 })
    await note.click()
    const tasksPanel = page.locator('.wf-modal--tasks')
    await expect(tasksPanel.locator('.wf-modal-meta').first()).toHaveText('2 agents · 150 commands · 1 other task · 2 running')

    // Agents come first; their tab lists only the two agents, as cards.
    const tabs = tasksPanel.locator('.bg-tasks-tab')
    await expect(tabs.locator('.bg-tasks-tab-label')).toHaveText(['Agents', 'Commands', 'Other'])
    await expect(tabs.locator('.bg-tasks-tab-count')).toHaveText(['2', '150', '1'])
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(0).locator('.bg-tasks-tab-live')).toHaveCount(1)
    await expect(tabs.nth(1).locator('.bg-tasks-tab-live')).toHaveCount(1)
    await expect(tabs.nth(2).locator('.bg-tasks-tab-live')).toHaveCount(0)
    const list = tasksPanel.locator('.bg-tasks-list')
    await expect(list.locator('.bg-task-row')).toHaveCount(2)
    await expect(list.locator('.bg-task-row--compact')).toHaveCount(0)
    await expect(list.locator('.bg-tasks-section-title')).toHaveText(['Running', 'Finished'])
    await expect(list.locator('.bg-task-row').first()).toHaveClass(/bg-task-row--selected/)
    await expect(list.locator('.task-group-agent-type')).toHaveText(['general-purpose', 'general-purpose'])
    const dir = `/tmp/workflow-overview/${project}`
    await fs.mkdir(dir, { recursive: true })
    await page.waitForTimeout(220)
    await page.screenshot({ path: `${dir}/background-panel-agents.png`, scale: 'css' })

    // Commands: 150 dense rows, the running one first and selected, the failure counted.
    await tabs.nth(1).click()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    const rows = list.locator('.bg-task-row--compact')
    await expect(rows).toHaveCount(150)
    await expect(list.locator('.bg-tasks-section')).toHaveText(['Running1', 'Finished1491 failed'])
    await expect(list.locator('.bg-tasks-section-failed')).toHaveText('1 failed')
    await expect(rows.first()).toHaveClass(/bg-task-row-running/)
    await expect(rows.first()).toHaveClass(/bg-task-row--selected/)
    await expect(list.locator('.bg-task-kind')).toHaveCount(0)
    await expect(tasksPanel.locator('.bg-tasks-detail-title')).toHaveText('Run the fixture check number 150')
    await expect(tasksPanel.locator('.bg-tasks-detail-head .bg-task-kind--command')).toHaveText('Command')
    const heights = await rows.evaluateAll(els => els.slice(0, 20).map(el => el.getBoundingClientRect().height))
    for (const h of heights) expect(h, 'a command is one line').toBeLessThanOrEqual(34)
    await expect(rows.nth(1).locator('.bg-task-row-time')).toHaveText('3s')
    await page.waitForTimeout(220)
    await page.screenshot({ path: `${dir}/background-panel-commands.png`, scale: 'css' })

    // Each tab keeps its own selection.
    await rows.nth(41).click()
    await expect(tasksPanel.locator('.bg-tasks-detail-title')).toHaveText('Run the fixture check number 41')
    await expect(rows.nth(41)).toHaveClass(/bg-task-row-failed/)
    await list.locator('.bg-task-row--compact.bg-task-row-failed').click()
    await expect(tasksPanel.locator('.bg-tasks-detail-title')).toHaveText('Run the fixture check number 41')
    await tabs.nth(0).click()
    await list.locator('.bg-task-row').nth(1).click()
    await expect(list.locator('.bg-task-row').nth(1)).toHaveClass(/bg-task-row--selected/)
    await tabs.nth(1).click()
    await expect(tasksPanel.locator('.bg-tasks-detail-title')).toHaveText('Run the fixture check number 41')
    await tabs.nth(0).click()
    await expect(list.locator('.bg-task-row').nth(1)).toHaveClass(/bg-task-row--selected/)
    await tabs.nth(2).click()
    await expect(list.locator('.bg-task-row--compact .bg-task-row-name')).toHaveText(['bgpq669i'])

    // A live update keeps the chosen tab and row.
    await tabs.nth(1).click()
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 1, phases: [], agents: [],
      tasks: [
        ...Array.from({ length: 150 }, (_, i) => ({ ...shellTask(i, i === 40 ? 'failed' : 'completed'), startedAt: Date.now() - 60_000, endedAt: Date.now() - 60_000 + 3_000 + i * 100 })),
        { taskId: 'agent-a', taskType: 'local_agent', subagentType: 'general-purpose', status: 'running', description: '/code-review', tokens: 99_000, toolUses: 44, startedAt: Date.now() - 590_000 },
        { taskId: 'agent-b', taskType: 'local_agent', subagentType: 'general-purpose', status: 'completed', description: '/code-review', tokens: 94_100, toolUses: 12, startedAt: Date.now() - 120_000, endedAt: Date.now() - 67_000 },
        { taskId: 'bgpq669i', status: 'completed' },
      ],
    })
    await expect(list.locator('.bg-tasks-section-title')).toHaveText(['Finished'])
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1).locator('.bg-tasks-tab-live')).toHaveCount(0)
    await expect(tasksPanel.locator('.bg-tasks-detail-title')).toHaveText('Run the fixture check number 41')

    await page.evaluate(() => {
      localStorage.setItem('open-walnut-theme', 'dark')
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await page.waitForTimeout(220)
    await page.screenshot({ path: `${dir}/background-panel-commands-dark.png`, scale: 'css' })
    await page.keyboard.press('Escape')
    await expect(tasksPanel).toHaveCount(0)
    expect(errors).toEqual([])
  })
})
