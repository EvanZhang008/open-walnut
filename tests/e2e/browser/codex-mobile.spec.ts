import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-ui-final'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SESSION_ID = 'pw-codex-customer-session'
const TASK_ID = 'pw-task-codex-customer'
const USER_TEXT = 'CODEX-MOBILE-USER-UNIQUE'
const ASSISTANT_TEXT = 'CODEX-MOBILE-ASSISTANT-UNIQUE'
let fixtureRoot = ''
let walnutHome = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT))
})

async function expectFullWidth(page: Page, selector: string): Promise<void> {
  const surface = page.locator(selector)
  await expect(surface).toBeVisible()
  await expect.poll(async () => (await surface.boundingBox())?.y ?? Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(53)
  const box = await surface.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeLessThanOrEqual(1)
  expect(box!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 2)
  expect(box!.height).toBeGreaterThan(page.viewportSize()!.height * 0.7)
}

async function chooseCodexQuickStart(page: Page): Promise<void> {
  await page.locator('.quick-access-pill', { hasText: /Quick session|\+ Session/ }).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()
  await page.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')
}

async function sessionIdForTask(page: Page, taskId: string): Promise<string> {
  let sessionId = ''
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    const body = await response.json() as {
      sessions: Array<{ claudeSessionId: string }>
    }
    sessionId = body.sessions[0]?.claudeSessionId ?? ''
    return sessionId
  }, { timeout: 15_000 }).not.toBe('')
  return sessionId
}

for (const viewport of [
  { width: 390, height: 844, slug: '390x844' },
  { width: 768, height: 1024, slug: '768x1024' },
]) {
  test(`Homepage uses mobile session master/detail at ${viewport.slug}`, async ({ page }) => {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const audit = await installBrowserAudit(page, walnutHome)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const taskSearchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET'
        && url.pathname === '/api/search'
        && url.searchParams.get('q') === SESSION_ID
    })
    await page.locator('.todo-search-input').fill(SESSION_ID)
    await taskSearchResponse
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible()
    await task.focus()
    await expect(task).toBeFocused()
    await task.click()

    const homePanel = page.locator('.main-page-session-column.is-mobile-active .session-panel')
    await expect(homePanel).toBeVisible()
    await expectFullWidth(page, '.main-page.has-mobile-session .main-page-sessions-area')
    await expect(homePanel.getByText(USER_TEXT, { exact: true })).toHaveCount(1)
    await expect(homePanel.getByText(ASSISTANT_TEXT, { exact: true })).toHaveCount(1)
    // The shared customer-session journal holds 2 parity + 2 mobile messages.
    await expect(homePanel.getByText('4 turns', { exact: true })).toHaveCount(1)
    const close = homePanel.getByRole('button', { name: 'Close session panel' })
    await expect(close).toBeFocused()
    const closeBox = await close.boundingBox()
    expect(closeBox!.width).toBeGreaterThanOrEqual(44)
    expect(closeBox!.height).toBeGreaterThanOrEqual(44)
    await expect(homePanel.locator('.chat-input-textarea')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/mobile-${viewport.slug}-homepage-session.png`,
    })

    await close.press('Enter')
    await expect(homePanel).toHaveCount(0)
    await expect(task).toBeFocused()

    // The seeded session above pins the delayed-open geometry regression. Now
    // prove the customer path at this exact viewport through the real quick
    // start route, ACP worker, journal, and session events.
    await page.locator('.todo-search-input').fill('')
    await chooseCodexQuickStart(page)
    const prompt = `mobile ${viewport.slug} real create and send`
    const reply = `hello from mock-acp (you said: ${prompt})`
    const quickStartResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/sessions/quick-start')
    const quickInput = page.locator('.main-page-chat .chat-input-textarea')
    await quickInput.fill(prompt)
    await quickInput.press('Enter')
    const quickStart = await quickStartResponse
    expect(quickStart.status()).toBe(200)
    const { taskId } = await quickStart.json() as { taskId: string }

    const realPanel = page.locator(
      '.main-page-session-column.is-mobile-active .session-panel:not(.pending-session-panel)',
    )
    await expect(realPanel).toBeVisible({ timeout: 15_000 })
    await expectFullWidth(page, '.main-page.has-mobile-session .main-page-sessions-area')
    await expect(realPanel.getByText(prompt, { exact: true })).toHaveCount(1)
    await expect(realPanel.getByText(reply, { exact: true }))
      .toHaveCount(1, { timeout: 20_000 })
    await sessionIdForTask(page, taskId)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/mobile-${viewport.slug}-real-create-send.png`,
    })

    const realClose = realPanel.getByRole('button', { name: 'Close session panel' })
    await realClose.focus()
    await realClose.press('Enter')
    const createdTask = page.locator(`[data-task-id="${taskId}"]:visible`).first()
    await expect(createdTask).toBeFocused()

    await audit.assertClean()
  })
}

async function persistedQueueMessages(sessionId: string): Promise<string[]> {
  try {
    const queue = JSON.parse(
      await fs.readFile(path.join(walnutHome, 'session-message-queue.json'), 'utf-8'),
    ) as { queues?: Record<string, Array<{ message: string }>> }
    return (queue.queues?.[sessionId] ?? []).map((message) => message.message)
  } catch {
    return []
  }
}

test('mobile creates, queues, reloads, and interrupts a real Codex session', async ({ page }) => {
  test.setTimeout(70_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const audit = await installBrowserAudit(page, walnutHome)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await chooseCodexQuickStart(page)

  const initialPrompt = 'mobile real Codex initial'
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const quickInput = page.locator('.main-page-chat .chat-input-textarea')
  await quickInput.fill(initialPrompt)
  await quickInput.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }

  const panel = page.locator('.main-page-session-column.is-mobile-active .session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText(`hello from mock-acp (you said: ${initialPrompt})`, { exact: true }))
    .toHaveCount(1, { timeout: 15_000 })

  let sessionId = ''
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    const body = await response.json() as {
      sessions: Array<{ claudeSessionId: string; process_status: string }>
    }
    sessionId = body.sessions[0]?.claudeSessionId ?? ''
    return body.sessions[0]?.process_status
  }).toBe('idle')

  const slowPrompt = 'lifecycle-slow-mobile active turn'
  const firstQueuedPrompt = 'mobile FIFO queued first'
  const secondQueuedPrompt = 'mobile FIFO queued second'
  const interruptSlowPrompt = 'lifecycle-slow-mobile interrupt phase'
  const replacementPrompt = 'mobile interrupt replacement'
  const panelInput = panel.locator('.chat-input-textarea')
  await panelInput.fill(slowPrompt)
  await panelInput.press('Enter')
  await expect(panel.getByText('thinking...', { exact: true })).toHaveCount(1, { timeout: 10_000 })
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    return ((await response.json()) as { session: { process_status: string } }).session.process_status
  }).toBe('running')

  await panelInput.fill(firstQueuedPrompt)
  await panelInput.press('Enter')
  await panelInput.fill(secondQueuedPrompt)
  await panelInput.press('Enter')
  const firstQueuedBubble = panel.locator('.session-msg-received', { hasText: firstQueuedPrompt })
  const secondQueuedBubble = panel.locator('.session-msg-received', { hasText: secondQueuedPrompt })
  await expect(firstQueuedBubble.getByText('Queued', { exact: true })).toBeVisible()
  await expect(secondQueuedBubble.getByText('Queued', { exact: true })).toBeVisible()
  await expect.poll(() => persistedQueueMessages(sessionId)).toEqual([
    firstQueuedPrompt,
    secondQueuedPrompt,
  ])

  await page.reload()
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const rehydratedFirst = panel.locator('.session-msg-received', { hasText: firstQueuedPrompt })
  const rehydratedSecond = panel.locator('.session-msg-received', { hasText: secondQueuedPrompt })
  await expect(rehydratedFirst.getByText('Queued', { exact: true })).toBeVisible()
  await expect(rehydratedSecond.getByText('Queued', { exact: true })).toBeVisible()
  const queuedText = await panel.locator('.session-msg-received').allInnerTexts()
  expect(queuedText.findIndex((text) => text.includes(firstQueuedPrompt)))
    .toBeLessThan(queuedText.findIndex((text) => text.includes(secondQueuedPrompt)))
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/mobile-390x844-queue-reloaded-fifo.png`,
  })

  const firstQueuedReply = `hello from mock-acp (you said: ${firstQueuedPrompt})`
  const secondQueuedReply = `hello from mock-acp (you said: ${secondQueuedPrompt})`
  await expect(panel.getByText(firstQueuedReply, { exact: true }))
    .toHaveCount(1, { timeout: 25_000 })
  await expect(panel.getByText(secondQueuedReply, { exact: true }))
    .toHaveCount(1, { timeout: 25_000 })
  await expect.poll(() => persistedQueueMessages(sessionId)).toEqual([])
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    const session = ((await response.json()) as {
      session: { messageCount: number; process_status: string }
    }).session
    return `${session.messageCount}:${session.process_status}`
  }, { timeout: 20_000 }).toBe('4:idle')

  const reloadedInput = panel.locator('.chat-input-textarea')
  await reloadedInput.fill(interruptSlowPrompt)
  await reloadedInput.press('Enter')
  await expect(panel.getByText('thinking...', { exact: true })).toHaveCount(1, { timeout: 10_000 })
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    return ((await response.json()) as { session: { process_status: string } }).session.process_status
  }).toBe('running')
  await reloadedInput.fill(replacementPrompt)
  await panel.getByRole('button', { name: 'More send options' }).click()
  await panel.getByRole('menuitem', { name: 'Interrupt & send' }).click()
  await expect(panel.getByText('Turn interrupted by user.', { exact: true }))
    .toHaveCount(1, { timeout: 20_000 })
  await expect(panel.getByText(`hello from mock-acp (you said: ${replacementPrompt})`, { exact: true }))
    .toHaveCount(1, { timeout: 20_000 })

  let history: Array<{ role: string; text: string }> = []
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}/history`)
    history = ((await response.json()) as { messages: typeof history }).messages
    return history.some((message) => message.text === `hello from mock-acp (you said: ${replacementPrompt})`)
  }).toBe(true)
  const orderedTexts = history.map((message) => message.text)
  expect(orderedTexts.indexOf(initialPrompt)).toBeLessThan(orderedTexts.indexOf(slowPrompt))
  expect(orderedTexts.indexOf(slowPrompt)).toBeLessThan(orderedTexts.indexOf(firstQueuedPrompt))
  expect(orderedTexts.indexOf(firstQueuedPrompt)).toBeLessThan(orderedTexts.indexOf(firstQueuedReply))
  expect(orderedTexts.indexOf(firstQueuedReply)).toBeLessThan(orderedTexts.indexOf(secondQueuedPrompt))
  expect(orderedTexts.indexOf(secondQueuedPrompt)).toBeLessThan(orderedTexts.indexOf(secondQueuedReply))
  expect(orderedTexts.indexOf(secondQueuedReply)).toBeLessThan(orderedTexts.indexOf(interruptSlowPrompt))
  expect(orderedTexts.indexOf(interruptSlowPrompt))
    .toBeLessThan(orderedTexts.indexOf('Turn interrupted by user.'))
  expect(orderedTexts.indexOf('Turn interrupted by user.')).toBeLessThan(orderedTexts.indexOf(replacementPrompt))
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    const session = ((await response.json()) as {
      session: { messageCount: number; process_status: string }
    }).session
    return `${session.messageCount}:${session.process_status}`
  }).toBe('6:idle')

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/mobile-390x844-real-queue-interrupt.png`,
  })

  const close = panel.getByRole('button', { name: 'Close session panel' })
  await close.focus()
  await close.press('Enter')
  const sourceTask = page.locator(`[data-task-id="${taskId}"]:visible`).first()
  await expect(sourceTask).toBeFocused()

  await audit.assertClean()
})
