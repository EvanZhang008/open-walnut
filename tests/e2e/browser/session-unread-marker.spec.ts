/**
 * Playwright browser test: a session window whose agent output has not been
 * read yet (task.unread) shows two quiet markers, a red dot before the title and
 * a red composer card, and both go away on the user's first click or keystroke
 * in that window (2026-09-29: a full red frame did this job but was too loud;
 * the user asked for "the red dot, some red in the input box, gone when I click
 * it: basically the task's read status").
 *
 * Real UI, real server, mock CLI. What a user sees, in order:
 *   1. a first session's turn ends: dot + red composer, no frame, and the
 *      title does not move;
 *   2. a second session still working next to it has neither; it gets them
 *      when its own turn ends;
 *   3. focus arriving without the user (a window coming back to the front
 *      refocuses the composer) leaves both markers on;
 *   4. a click in the first window's transcript clears them there, and only
 *      there; typing into the second window's composer clears that one;
 *   5. a follow-up turn: no markers while it runs, back when it ends, twice;
 *   6. completing an unread task clears them;
 *   7. the Ask Walnut slot follows the same rule, in dark mode.
 * Each "read" is also checked on the server, not only in the DOM.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openChatOnLoad, openDraftOnCwd } from './draft-helpers'
import { selectSection } from './todo-panel-helpers'
import { sessionResultPhase } from '../../../src/core/phase'

const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/session-unread-marker'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const HANDBACK_PHASE = sessionResultPhase('IN_PROGRESS')!
const UNREAD_CLASS = /session-panel-unread/

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function sendQuickStart(page: Page, composer: Locator, prompt: string): Promise<string> {
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(prompt)
  await composer.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  return ((await quickStart.json()) as { taskId: string }).taskId
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

interface TaskRow { phase: string; unread?: boolean }

async function readTask(page: Page, taskId: string): Promise<TaskRow> {
  const response = await page.request.get(`/api/tasks/${taskId}`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { task: TaskRow }).task
}

const dot = (panel: Locator): Locator => panel.locator('.session-panel-header .session-panel-unread-dot')
const solidDot = (panel: Locator): Locator => panel.locator('.session-panel-header .session-panel-unread-dot:not(.session-panel-attention-dot)')
const ringDot = (panel: Locator): Locator => panel.locator('.session-panel-header .session-panel-unread-dot.session-panel-attention-dot')
const composerCard = (panel: Locator): Locator => panel.locator('.session-panel-input .chat-input-box')
/** The title's x inside its own panel (columns move when another one opens). */
const titleX = async (panel: Locator): Promise<number> =>
  (await panel.locator('.session-panel-header .session-panel-title').first().boundingBox())!.x
    - (await panel.boundingBox())!.x

async function expectMarked(page: Page, panel: Locator, taskId: string): Promise<void> {
  await expect.poll(async () => (await readTask(page, taskId)).unread === true, { timeout: 30_000 }).toBe(true)
  await expect(panel).toHaveClass(UNREAD_CLASS, { timeout: 15_000 })
  await expect(solidDot(panel)).toBeVisible()
  await expect(ringDot(panel)).toHaveCount(0)
  // The card's own 0.2s transition fades the red in; read it once it settles.
  await expect.poll(() => composerCard(panel).evaluate((el) => {
    const s = getComputedStyle(el)
    return { border: s.borderTopColor, halo: s.boxShadow.includes('rgba(255, 59, 48, 0.14)') }
  }), { timeout: 5_000 }).toEqual({ border: 'rgba(255, 59, 48, 0.6)', halo: true })
}

async function expectRead(page: Page, panel: Locator, taskId: string): Promise<void> {
  await expect(panel).not.toHaveClass(UNREAD_CLASS, { timeout: 15_000 })
  // Read is not done: the task still needs the user, so the header keeps the
  // list's hollow ring (transparent fill, red outline) until they reply or complete.
  await expect(solidDot(panel)).toHaveCount(0)
  await expect(ringDot(panel)).toBeVisible()
  expect(await ringDot(panel).evaluate((el) => {
    const s = getComputedStyle(el)
    return { fill: s.backgroundColor, ring: s.boxShadow.includes('rgb(255, 59, 48)') }
  })).toEqual({ fill: 'rgba(0, 0, 0, 0)', ring: true })
  await expect.poll(() => composerCard(panel).evaluate((el) => getComputedStyle(el).boxShadow.includes('rgba(255, 59, 48')),
    { timeout: 5_000 }).toBe(false)
  await expect.poll(async () => (await readTask(page, taskId)).unread === true, { timeout: 15_000 }).toBe(false)
}

test('an unread session window shows a dot and a red composer until the user clicks or types in it', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const shot = (name: string) => `${SCREENSHOT_DIR}/${testInfo.project.name}-${name}.png`
  const errors: string[] = []
  const failedResponses: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await openHome(page)
  const cwd = `${fixtureRoot}/projects/walnut`

  // ── 1. First session's turn ends → dot + red composer, no frame ──
  await openDraftOnCwd(page, cwd)
  const taskA = await sendQuickStart(page, draftComposer(page), 'snapshot-clean-turn:Marker turn one finished')
  const sessionA = await sessionIdForTask(page, taskA)
  const panelA = page.locator(`${REAL_PANEL}[data-session-id="${sessionA}"]`)
  await expect(panelA.getByText('Marker turn one finished', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await readTask(page, taskA)).phase, { timeout: 20_000 }).toBe(HANDBACK_PHASE)
  await expectMarked(page, panelA, taskA)
  expect(await panelA.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
  // The dot lives in the header's left padding: left of the phase circle, and
  // inside the panel.
  const panelBox = (await panelA.boundingBox())!
  const dotBox = (await dot(panelA).boundingBox())!
  const circleBox = (await panelA.locator('.session-panel-title-area .task-quick-phase-btn').first().boundingBox())!
  expect(dotBox.x).toBeGreaterThan(panelBox.x)
  expect(dotBox.x + dotBox.width).toBeLessThanOrEqual(circleBox.x)
  await page.screenshot({ path: shot('1-unread') })

  // ── 2. A second session still working → no markers there ──
  await openDraftOnCwd(page, cwd)
  const taskB = await sendQuickStart(page, draftComposer(page), 'slow:6000 snapshot-clean-turn:Marker second column finished')
  const sessionB = await sessionIdForTask(page, taskB)
  const panelB = page.locator(`${REAL_PANEL}[data-session-id="${sessionB}"]`)
  await expect(panelB).toBeVisible()
  await expect(panelA).toBeVisible()
  expect((await readTask(page, taskB)).phase).toBe('IN_PROGRESS')
  await expect(panelB).not.toHaveClass(UNREAD_CLASS)
  await expect(dot(panelB)).toHaveCount(0)
  await expect(panelA).toHaveClass(UNREAD_CLASS)
  await page.screenshot({ path: shot('2-one-working-one-unread') })
  await expect.poll(async () => (await readTask(page, taskB)).phase, { timeout: 30_000 }).toBe(HANDBACK_PHASE)
  await expectMarked(page, panelB, taskB)
  await page.screenshot({ path: shot('2-both-unread') })

  // ── 3. Focus that the user did not cause leaves the markers on ──
  await panelA.locator('.chat-input-textarea').evaluate((el) => (el as HTMLTextAreaElement).focus())
  await page.waitForTimeout(800)
  await expect(panelA).toHaveClass(UNREAD_CLASS)
  expect((await readTask(page, taskA)).unread).toBe(true)

  // ── 4. Click in A's transcript → A read, B untouched; typing in B → B read ──
  const titleXUnread = await titleX(panelA)
  await panelA.getByText('Marker turn one finished', { exact: true }).first().click()
  await expectRead(page, panelA, taskA)
  expect(await titleX(panelA)).toBe(titleXUnread)
  await expect(panelB).toHaveClass(UNREAD_CLASS)
  expect((await readTask(page, taskB)).unread).toBe(true)
  await page.screenshot({ path: shot('4-a-read-b-unread') })
  const composerB = panelB.locator('.chat-input-textarea')
  await composerB.evaluate((el) => (el as HTMLTextAreaElement).focus())
  await page.keyboard.press('Shift')
  await page.waitForTimeout(500)
  await expect(panelB).toHaveClass(UNREAD_CLASS)
  await page.keyboard.type('x')
  await expectRead(page, panelB, taskB)
  await composerB.fill('')

  // ── 5. Follow-ups in A: nothing while it works, markers back after, twice ──
  for (const round of [1, 2]) {
    const composer = panelA.locator('.chat-input-textarea')
    // A follow-up rides the live FIFO, where the mock ignores `slow:`; a long
    // turn keeps the agent visibly working for a few seconds.
    await composer.fill('snapshot-long-turn:6000:text')
    await composer.press('Enter')
    await expect.poll(async () => (await readTask(page, taskA)).phase, { timeout: 15_000 }).toBe('IN_PROGRESS')
    await expect(panelA).not.toHaveClass(UNREAD_CLASS)
    await expect(dot(panelA)).toHaveCount(0)
    await page.screenshot({ path: shot(`5-round${round}-working`) })
    await expect.poll(async () => (await readTask(page, taskA)).phase, { timeout: 30_000 }).toBe(HANDBACK_PHASE)
    await expectMarked(page, panelA, taskA)
    await page.screenshot({ path: shot(`5-round${round}-unread`) })
    if (round === 1) {
      await composer.click()
      await expectRead(page, panelA, taskA)
    }
  }

  // ── 6. Completing the still-unread task clears the markers ──
  await selectSection(page, 'Focus')
  let card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskA}"]`)
  if (!(await card.isVisible())) {
    await selectSection(page, 'Satellite')
    card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskA}"]`)
  }
  await card.getByRole('button', { name: 'Mark complete', exact: true }).click()
  await expect.poll(async () => (await readTask(page, taskA)).phase, { timeout: 20_000 }).toBe('COMPLETE')
  await expect(panelA).not.toHaveClass(UNREAD_CLASS)
  await expect(dot(panelA)).toHaveCount(0)
  await page.screenshot({ path: shot('6-completed') })

  await fs.writeFile(`${SCREENSHOT_DIR}/${testInfo.project.name}-evidence.json`,
    JSON.stringify({ taskA, sessionA, taskB, sessionB, failedResponses, errors }, null, 2))
  expect(errors).toEqual([])
  expect(failedResponses.filter((line) => /\/api\//.test(line) && !/\/api\/notes|\/api\/mail/.test(line))).toEqual([])
})

test('the Ask Walnut slot shows the same markers, in dark mode, and a click in its composer clears them', async ({ page }, testInfo) => {
  test.setTimeout(150_000)
  const shot = (name: string) => `${SCREENSHOT_DIR}/${testInfo.project.name}-${name}.png`
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ colorScheme: 'dark' })
  // The Ask Walnut slot starts hidden until opened.
  await openChatOnLoad(page)
  await openHome(page)

  const draft = page.locator('[data-testid="ask-walnut-draft"] .chat-input-textarea')
  await expect(draft).toBeVisible({ timeout: 30_000 })
  const taskId = await sendQuickStart(page, draft, 'slow:5000 snapshot-clean-turn:Ask answered')
  const panel = page.locator('[data-testid="ask-walnut-session"] .session-panel')
  await expect(panel).toBeVisible({ timeout: 60_000 })

  expect((await readTask(page, taskId)).phase).toBe('IN_PROGRESS')
  await expect(panel).not.toHaveClass(UNREAD_CLASS)
  await expect.poll(async () => (await readTask(page, taskId)).phase, { timeout: 30_000 }).toBe(HANDBACK_PHASE)
  await expectMarked(page, panel, taskId)
  // After the ≡ button there is no gutter: the dot sits between ≡ and the circle.
  const menuBox = (await panel.locator('[data-testid="ask-walnut-menu"]').boundingBox())!
  const dotBox = (await dot(panel).boundingBox())!
  expect(dotBox.x).toBeGreaterThanOrEqual(menuBox.x + menuBox.width)
  await page.screenshot({ path: shot('7-ask-slot-dark-unread') })

  await panel.locator('.chat-input-textarea').click()
  await expectRead(page, panel, taskId)
  await page.screenshot({ path: shot('7-ask-slot-dark-read') })
  expect(errors).toEqual([])
})
