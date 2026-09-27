import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

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
    await expect(card.locator('.wf-phase-nav')).toContainText('Fetch')
    await expect(card.locator('.wf-phase-nav')).toContainText('Verify')
    await expect(card.locator('.wf-gnode-failed .wf-gnode-name')).toHaveText('Fetch the long-form source with complete citations and a fallback archive')
    await expect(card.locator('.wf-gnode-head')).toHaveCount(25)
    await expect(card.locator('.wf-phase-failed')).toHaveText('1 failed')
    const firstName = await card.locator('.wf-gnode-name').first().textContent()
    expect(firstName).toBe('Fetch the long-form source with complete citations and a fallback archive')
    await card.locator('.wf-gnode-failed .wf-gnode-head').click()
    await expect(card.locator('.wf-agent-prompt')).toContainText('Preserve every citation')
    await card.locator('.wf-transcript-toggle').click()
    await expect(page.locator('.wf-modal-body')).toContainText('The source returned an error after the retry.')
    await page.keyboard.press('Escape')
    await expect(page.locator('.wf-modal-body')).toHaveCount(0)
    await card.locator('.wf-phase-nav').getByRole('button', { name: /Verify/ }).click()
    await expect(card.locator('.wf-gnode-head')).toHaveCount(75)
    await expect(card.locator('.wf-overview-count')).toHaveText('75 agents')
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
    await card.locator('.wf-phase-nav').getByRole('button', { name: /Verify/ }).click()
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
    await expect(card.locator('.wf-phase-nav')).toContainText('Review')
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

/** The bar's parts sit on one line, centred, left to right, with the action flush right. */
async function expectOneTidyLine(bar: ReturnType<Page['locator']>) {
  const geometry = await bar.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const parts = [...el.children].filter(c => getComputedStyle(c).display !== 'none').map(c => {
      const r = c.getBoundingClientRect()
      return { cls: c.className, left: r.left, right: r.right, mid: r.top + r.height / 2 }
    })
    return { height: box.height, width: box.width, right: box.right, mid: box.top + box.height / 2, parts }
  })
  expect(geometry.height).toBeLessThanOrEqual(40)
  for (const part of geometry.parts) expect(Math.abs(part.mid - geometry.mid), part.cls).toBeLessThanOrEqual(2)
  for (let i = 1; i < geometry.parts.length; i++) {
    expect(geometry.parts[i].left, `${geometry.parts[i].cls} overlaps ${geometry.parts[i - 1].cls}`)
      .toBeGreaterThanOrEqual(geometry.parts[i - 1].right - 0.5)
  }
  const open = geometry.parts[geometry.parts.length - 1]
  expect(open.cls).toBe('wf-card-open')
  expect(geometry.right - open.right).toBeGreaterThanOrEqual(10)
  expect(geometry.right - open.right).toBeLessThanOrEqual(14)
  // Whatever is still shown keeps the fixed left-to-right order.
  const canonical = ['wf-card-state', 'wf-card-title', 'wf-card-count', 'wf-card-meter', 'wf-card-tokens', 'wf-card-open']
  const order = geometry.parts.map(p => p.cls.split(' ')[0])
  expect(order.filter(c => canonical.includes(c))).toEqual(canonical.filter(c => order.includes(c)))
  for (const required of ['wf-card-state', 'wf-card-title', 'wf-card-count', 'wf-card-open']) expect(order).toContain(required)
  return geometry
}

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

async function shootBar(page: Page, bar: ReturnType<Page['locator']>, name: string) {
  const dir = `/tmp/workflow-overview/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  const box = (await bar.boundingBox())!
  await page.screenshot({
    path: `${dir}/${name}.png`, scale: 'css',
    clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 },
  })
}

test.describe('Background bar', () => {
  test.setTimeout(120_000)

  test('reads as one quiet line from the reported case to failures, completion, dark and narrow', async ({ page }) => {
    const project = test.info().project.name
    const sessionId = `pw-background-bar-${project}`
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await captureSocket(page)
    const panel = await openTaskSession(page, sessionId, `pw-bgbar-task-${project}`)
    // History has rendered, so the ledger hook is subscribed before the first event.
    await expect(panel).toContainText('Review underway.', { timeout: 30_000 })
    const bar = panel.locator('.wf-card--bar')

    // The reported shape: six shell commands, five finished, one still running.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 1, phases: [], agents: [],
      tasks: [0, 1, 2, 3, 4].map(i => shellTask(i, 'completed')).concat(shellTask(5, 'running')),
    })
    await expect.poll(() => visibleText(bar.locator('.wf-card-count')), { timeout: 30_000 }).toBe('5/6 tasks done · 1 running')
    await expect(bar.locator('.wf-card-state--running .task-group-streaming-dot')).toHaveCount(1)
    await expect(bar.locator('.wf-card-open')).toHaveText('View all ›')
    await expect(bar.locator('.wf-card-count')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const inks = await bar.evaluate(el => ({
      bar: getComputedStyle(el).color,
      title: getComputedStyle(el.querySelector('.wf-card-title')!).color,
      open: getComputedStyle(el.querySelector('.wf-card-open')!).color,
      count: getComputedStyle(el.querySelector('.wf-card-count')!).color,
    }))
    expect(inks.title).toBe(inks.bar)
    expect(inks.open).toBe(inks.count)
    const wide = await expectOneTidyLine(bar)
    const meterDone = await bar.locator('.wf-card-meter-done').evaluate(el => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width)
    expect(meterDone).toBeCloseTo(5 / 6, 2)
    await shootBar(page, bar, 'background-bar-reported')

    // A running agent next to commands, one of which failed, with token spend.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 1, phases: [], agents: [],
      tasks: [
        { taskId: 'agent-1', taskType: 'local_agent', subagentType: 'explore', status: 'running', description: 'Find every caller of the old parser', tokens: 61_234 },
        shellTask(0, 'completed'), shellTask(1, 'completed'), shellTask(2, 'completed'), shellTask(3, 'failed'),
      ],
    })
    await expect.poll(() => visibleText(bar.locator('.wf-card-count')), { timeout: 30_000 }).toBe('Agents 0/1 · Tasks 3/4 · 1 running · 1 failed')
    await expect(bar.locator('.wf-card-tokens')).toHaveText('61k tok')
    await expect(bar.locator('.wf-card-failed')).toContainText('1 failed')
    await expect(bar.locator('.wf-card-failed')).toHaveCSS('color', await bar.locator('.wf-card-meter-failed').evaluate(el => getComputedStyle(el).backgroundColor))
    await expectOneTidyLine(bar)
    await expectNothingClipped(bar, 'mixed at column width')
    // Wide enough to show every part, the meter carries the failed share next to the tokens.
    await bar.evaluate(el => { (el as HTMLElement).style.width = '760px' })
    await expect(bar.locator('.wf-card-meter')).toBeVisible()
    const mixed = await expectOneTidyLine(bar)
    const meter = mixed.parts.find(p => p.cls === 'wf-card-meter')!, tokens = mixed.parts.find(p => p.cls === 'wf-card-tokens')!
    expect(tokens.left - meter.right).toBeLessThanOrEqual(12)
    const failedShare = await bar.locator('.wf-card-meter-failed').evaluate(el => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width)
    expect(failedShare).toBeCloseTo(1 / 5, 2)
    await shootBar(page, bar, 'background-bar-mixed')
    await bar.evaluate(el => { (el as HTMLElement).style.width = '' })

    // The reported density: 2 agents beside 150 commands, one failed. The optional
    // parts give way before the tally is cut.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 3, phases: [], agents: [],
      tasks: [
        { taskId: 'agent-a', taskType: 'local_agent', status: 'running', description: 'Map every caller', tokens: 96_200 },
        { taskId: 'agent-b', taskType: 'local_agent', status: 'running', description: 'Draft the notes', tokens: 94_100 },
        ...Array.from({ length: 150 }, (_, i) => shellTask(i, i === 40 ? 'failed' : i === 149 ? 'running' : 'completed')),
      ],
    })
    await expect.poll(() => visibleText(bar.locator('.wf-card-running')), { timeout: 30_000 }).toBe('· 3 running')
    await expect(bar.locator('.wf-card-failed')).toBeVisible()
    await expectOneTidyLine(bar)
    await expectNothingClipped(bar, 'dense at column width')
    await shootBar(page, bar, 'background-bar-dense')

    // Everything settles: a check, no pulse, the full meter.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 0, phases: [], agents: [],
      tasks: [0, 1, 2, 3, 4, 5].map(i => shellTask(i, 'completed')),
    })
    await expect.poll(() => visibleText(bar.locator('.wf-card-count')), { timeout: 30_000 }).toBe('6/6 tasks done')
    await expect(bar.locator('.wf-card-state--done')).toHaveText('✓')
    await expect(bar.locator('.task-group-streaming-dot')).toHaveCount(0)
    await expectOneTidyLine(bar)

    // The bar is still the one way into the panel.
    await bar.click()
    const tasksPanel = page.locator('.wf-modal--tasks')
    await expect(tasksPanel.locator('.bg-task-row')).toHaveCount(6)
    await page.keyboard.press('Escape')
    await expect(tasksPanel).toHaveCount(0)

    await page.evaluate(() => {
      localStorage.setItem('open-walnut-theme', 'dark')
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 1, phases: [], agents: [],
      tasks: [0, 1, 2, 3, 4].map(i => shellTask(i, 'completed')).concat(shellTask(5, 'running')),
    })
    await expect.poll(() => visibleText(bar.locator('.wf-card-count')), { timeout: 30_000 }).toBe('5/6 tasks done · 1 running')
    // Focus is back on the bar after Esc closed the panel, as it is for a real user.
    await page.mouse.move(0, 0)
    // Dark surfaces come from the dark tokens, never a light native button face.
    const darkInk = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.cssText = 'background: var(--bg-secondary); color: var(--fg)'
      document.body.append(probe)
      const { backgroundColor, color } = getComputedStyle(probe)
      probe.remove()
      return { backgroundColor, color }
    })
    await expect(bar).toHaveCSS('background-color', darkInk.backgroundColor)
    await expect(bar.locator('.wf-card-title')).toHaveCSS('color', darkInk.color)
    await shootBar(page, bar, 'background-bar-dark')

    // Narrowing column: detail goes in one order (meter, tokens, per-kind tally,
    // words) and never comes back as the bar narrows; the title and the running
    // and failed counts never truncate, and the line never wraps.
    let previousLevel = -1
    for (const width of [760, 640, 440, 380, 300]) {
      await bar.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px` }, width)
      await emitBackgroundTasks(page, {
        sessionId, inFlight: 1, phases: [], agents: [],
        tasks: [
          { taskId: 'agent-1', taskType: 'local_agent', status: 'running', description: 'Find every caller', tokens: 61_234 },
          shellTask(0, 'completed'), shellTask(1, 'failed'),
        ],
      })
      await expect(bar.locator('.wf-card-failed')).toBeVisible()
      await expect.poll(() => visibleText(bar.locator('.wf-card-count')), { timeout: 30_000 }).toMatch(/^(Agents 0\/1 · Tasks 1\/2|1\/3 done|1\/3) · 1 running · 1 failed$/)
      const level = Number(await bar.getAttribute('data-shed'))
      expect(level, `shed level at ${width}px`).toBeGreaterThanOrEqual(previousLevel)
      previousLevel = level
      await expect(bar.locator('.wf-card-meter')).toBeVisible({ visible: level < 1 })
      await expect(bar.locator('.wf-card-tokens')).toBeVisible({ visible: level < 2 })
      await expect(bar.locator('.wf-card-open-label')).toBeVisible({ visible: level < 4 })
      await expectNothingClipped(bar, `at ${width}px`)
      await expectOneTidyLine(bar)
      await shootBar(page, bar, `background-bar-${width}px`)
    }
    expect(Number(await bar.getAttribute('data-shed')), 'the narrowest bar sheds everything optional').toBe(4)
    await expect.poll(() => visibleText(bar.locator('.wf-card-count'))).toBe('1/3 · 1 running · 1 failed')

    // The reported density at 300px: even '148/152' does not fit beside the running
    // and failed counts, so the total goes and they keep the line, uncut.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 3, phases: [], agents: [],
      tasks: [
        { taskId: 'agent-a', taskType: 'local_agent', status: 'running', description: 'Map every caller', tokens: 96_200 },
        { taskId: 'agent-b', taskType: 'local_agent', status: 'running', description: 'Draft the notes', tokens: 94_100 },
        ...Array.from({ length: 150 }, (_, i) => shellTask(i, i === 40 ? 'failed' : i === 149 ? 'running' : 'completed')),
      ],
    })
    await expect.poll(() => visibleText(bar.locator('.wf-card-count')), { timeout: 30_000 }).toBe('3 running · 1 failed')
    expect(await bar.getAttribute('data-shed')).toBe('5')
    await expectNothingClipped(bar, 'dense at 300px')
    await expectOneTidyLine(bar)
    await shootBar(page, bar, 'background-bar-dense-300px')
    // With nothing running or failed the total is all the line says, so it stays.
    await emitBackgroundTasks(page, {
      sessionId, inFlight: 0, phases: [], agents: [],
      tasks: Array.from({ length: 150 }, (_, i) => shellTask(i, 'completed')),
    })
    await expect.poll(() => visibleText(bar.locator('.wf-card-count')), { timeout: 30_000 }).toMatch(/^150\/150( tasks done| done)?$/)
    await expectNothingClipped(bar, 'all done at 300px')
    await bar.evaluate(el => { (el as HTMLElement).style.width = '760px' })
    await expect.poll(() => bar.getAttribute('data-shed'), { message: 'widening brings the detail back' }).toBe('0')
    expect(wide.width).toBeGreaterThan(420)
    expect(errors).toEqual([])
  })
})
