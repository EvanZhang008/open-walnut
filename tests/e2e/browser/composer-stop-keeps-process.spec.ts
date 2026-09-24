import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'

const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/composer-stop-keeps-process'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

/** The partial answer the mock streams before it is cut short. */
const PARTIAL_TEXT = 'Starting a long answer that will be cut short'
const LONG_TURN = 'snapshot-long-turn:60000:text'
const browserErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
})

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
  expect(browserErrors.get(page)).toEqual([])
})

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  // WebKit's first load of the dev-mode SPA compiles on demand; give it room under load.
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
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
    expect(response.ok()).toBe(true)
    sessions = ((await response.json()) as { sessions: typeof sessions }).sessions
    return sessions.length
  }, { timeout: 20_000 }).toBe(1)
  return sessions[0].claudeSessionId
}

interface SessionRecord {
  process_status: string
  status_reason?: string
  errorMessage?: string
  pid?: number
}

async function sessionRecord(page: Page, sessionId: string): Promise<SessionRecord> {
  const response = await page.request.get(`/api/sessions/${sessionId}`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { session: SessionRecord }).session
}

/**
 * Watch the whole document for the "Resuming session..." indicator. A polling
 * locator can miss a one-frame render; the observer records the first sighting
 * and keeps it until read.
 */
async function armResumingWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __resumingSeen?: number }
    w.__resumingSeen = 0
    const check = () => {
      if (document.body.innerText.includes('Resuming session')) w.__resumingSeen = (w.__resumingSeen ?? 0) + 1
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    check()
  })
}

async function resumingSightings(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __resumingSeen?: number }).__resumingSeen ?? 0)
}

function stopButton(panel: Locator): Locator {
  return panel.getByRole('button', { name: 'Stop the running turn', exact: true })
}

/** Start a long turn from the draft column and wait until its partial answer is on screen. */
async function startLongTurnFromDraft(page: Page): Promise<{ sessionId: string; taskId: string; panel: Locator }> {
  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const taskId = await sendQuickStart(page, LONG_TURN)
  const sessionId = await sessionIdForTask(page, taskId)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText(PARTIAL_TEXT, { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await expect(stopButton(panel)).toBeVisible()
  return { sessionId, taskId, panel }
}

/** Start another long turn on an existing panel and wait for its partial answer. */
async function startLongTurnFromPanel(panel: Locator, before: number): Promise<void> {
  const composer = panel.locator('.chat-input-textarea')
  await composer.fill(LONG_TURN)
  await composer.press('Enter')
  await expect(panel.getByText(PARTIAL_TEXT, { exact: false })).toHaveCount(before + 1, { timeout: 20_000 })
  await expect(stopButton(panel)).toBeVisible()
}

test('Stop mid-stream keeps the process: no error banner, follow-up streams with no "Resuming session"', async ({ page }) => {
  test.setTimeout(90_000)
  const { sessionId, taskId, panel } = await startLongTurnFromDraft(page)
  await armResumingWatch(page)
  const running = await sessionRecord(page, sessionId)
  expect(running.process_status).toBe('running')
  const pidBefore = running.pid
  expect(pidBefore).toBeTruthy()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-streaming-before-stop.png` })

  const stoppedAt = Date.now()
  await stopButton(panel).click()

  // The turn settles as a USER STOP: idle, `turn_interrupted`, no error, same pid.
  await expect.poll(() => sessionRecord(page, sessionId).then((r) => r.status_reason), { timeout: 10_000 })
    .toBe('turn_interrupted')
  expect(Date.now() - stoppedAt).toBeLessThan(10_000)
  const stopped = await sessionRecord(page, sessionId)
  expect(stopped.process_status).toBe('idle')
  expect(stopped.errorMessage).toBeUndefined()
  expect(stopped.pid).toBe(pidBefore)
  await expect(panel.locator('.session-error-banner')).toHaveCount(0)
  await expect(stopButton(panel)).toHaveCount(0)
  // The partial answer stays in the transcript; the user stopped it, nothing was lost.
  await expect(panel.getByText(PARTIAL_TEXT, { exact: false }).first()).toBeVisible()
  // The task is still the user's to continue, not handed back as failed.
  const afterStop = await page.request.get(`/api/tasks/${taskId}`)
  expect(afterStop.ok()).toBe(true)
  expect((await afterStop.json()).task.phase).not.toBe('ERROR')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-after-stop-idle-no-banner.png` })

  // Follow-up on the same process: the answer streams, no "Resuming session...".
  const composer = panel.locator('.chat-input-textarea')
  await composer.fill('snapshot-clean-turn:after the stop')
  await composer.press('Enter')
  await expect(panel.getByText('after the stop', { exact: false }).last()).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => sessionRecord(page, sessionId).then((r) => r.process_status), { timeout: 10_000 }).toBe('idle')
  const afterFollowUp = await sessionRecord(page, sessionId)
  expect(afterFollowUp.pid).toBe(pidBefore)
  expect(afterFollowUp.errorMessage).toBeUndefined()
  expect(await resumingSightings(page)).toBe(0)
  await expect(panel.locator('.session-error-banner')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-follow-up-answered-same-process.png` })
})

test('three Stop rounds in a row on one process', async ({ page }) => {
  test.setTimeout(120_000)
  const { sessionId, panel } = await startLongTurnFromDraft(page)
  await armResumingWatch(page)
  const pidBefore = (await sessionRecord(page, sessionId)).pid
  expect(pidBefore).toBeTruthy()

  for (let round = 1; round <= 3; round++) {
    await stopButton(panel).click()
    await expect.poll(() => sessionRecord(page, sessionId).then((r) => r.process_status), { timeout: 10_000 }).toBe('idle')
    const rec = await sessionRecord(page, sessionId)
    expect(rec.status_reason).toBe('turn_interrupted')
    expect(rec.pid).toBe(pidBefore)
    await expect(panel.locator('.session-error-banner')).toHaveCount(0)
    if (round < 3) await startLongTurnFromPanel(panel, round)
  }
  const composer = panel.locator('.chat-input-textarea')
  await composer.fill('snapshot-clean-turn:round three done')
  await composer.press('Enter')
  await expect(panel.getByText('round three done', { exact: false }).last()).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => sessionRecord(page, sessionId).then((r) => r.process_status), { timeout: 10_000 }).toBe('idle')
  expect((await sessionRecord(page, sessionId)).pid).toBe(pidBefore)
  expect(await resumingSightings(page)).toBe(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-three-rounds-same-process.png` })
})

test('Stop preserves a dense partial answer and a Unicode follow-up', async ({ page }) => {
  test.setTimeout(90000)
  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const taskId = await sendQuickStart(page, 'snapshot-long-turn:60000:dense')
  const sessionId = await sessionIdForTask(page, taskId)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('Section 80:', { exact: false })).toBeVisible({ timeout: 20000 })
  const pid = (await sessionRecord(page, sessionId)).pid
  await stopButton(panel).click()
  await expect.poll(() => sessionRecord(page, sessionId).then((r) => r.status_reason)).toBe('turn_interrupted')
  await expect(panel.getByText('Section 80:', { exact: false })).toBeVisible()
  const followUp = 'Unicode follow-up: café \u4f60\u597d' // CJK "hello"
  await panel.locator('.chat-input-textarea').fill(`snapshot-clean-turn:${followUp}`)
  await panel.locator('.chat-input-textarea').press('Enter')
  await expect(panel.getByText(followUp, { exact: true }).last()).toBeVisible({ timeout: 20000 })
  expect((await sessionRecord(page, sessionId)).pid).toBe(pid)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/07-dense-partial-preserved.png` })
})

test('"Interrupt & send" from the split menu replaces the turn on the same process', async ({ page }) => {
  test.setTimeout(90_000)
  const { sessionId, panel } = await startLongTurnFromDraft(page)
  await armResumingWatch(page)
  const pidBefore = (await sessionRecord(page, sessionId)).pid
  expect(pidBefore).toBeTruthy()

  // Typing mid-turn flips the primary back to Send and grows the "▾" split menu.
  const composer = panel.locator('.chat-input-textarea')
  await composer.fill('snapshot-clean-turn:replacement question')
  await expect(stopButton(panel)).toHaveCount(0)
  await panel.getByRole('button', { name: 'More send options', exact: true }).click()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-split-menu-open.png` })
  await page.getByRole('menuitem', { name: 'Interrupt & send' }).click()

  await expect(panel.getByText('replacement question', { exact: false }).last()).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => sessionRecord(page, sessionId).then((r) => r.process_status), { timeout: 10_000 }).toBe('idle')
  const rec = await sessionRecord(page, sessionId)
  expect(rec.pid).toBe(pidBefore)
  expect(rec.errorMessage).toBeUndefined()
  // The clean turn's completion is the last word, not the interrupted one.
  expect(rec.status_reason).toBe('turn_completed')
  await expect(panel.locator('.session-error-banner')).toHaveCount(0)
  expect(await resumingSightings(page)).toBe(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-interrupt-and-send-same-process.png` })
})
