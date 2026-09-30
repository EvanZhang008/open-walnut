/**
 * Playwright browser test: a session window whose task was handed back
 * (NEED_ACTION: the turn ended, errored, or waits on a decision) gets a red
 * frame around the WHOLE window, so a finished column reads as ready at a
 * glance (2026-09-29 user report: an "Idle" column next to a running one did not
 * look ready; the faint header tint was the only signal).
 *
 * Real UI, real server, mock CLI. What a user sees, in order:
 *   1. a first session's turn ends: its column is framed red on all four edges,
 *      over the glass header and the composer;
 *   2. a second session is still working in the next column: no frame there,
 *      while the first keeps its frame; it gets one when its own turn ends;
 *   3. a follow-up in the first column drops its frame while the agent works and
 *      brings it back when the turn ends, twice in a row;
 *   4. full screen keeps the frame on the rounded sheet;
 *   5. marking the task complete removes the frame.
 */
import fs from 'node:fs/promises'
import sharp from 'sharp'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { selectSection } from './todo-panel-helpers'
import { sessionResultPhase } from '../../../src/core/phase'

const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/session-needs-action-frame'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const HANDBACK_PHASE = sessionResultPhase('IN_PROGRESS')!
const FRAME_CLASS = /session-panel-needs-action/

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

async function sendQuickStart(page: Page, prompt: string): Promise<string> {
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(prompt)
  await input.press('Enter')
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

async function taskPhase(page: Page, taskId: string): Promise<string> {
  const response = await page.request.get(`/api/tasks/${taskId}`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { task: { phase: string } }).task.phase
}

interface EdgeSample { left: boolean; right: boolean; top: boolean; bottom: boolean }

/** Reads the panel's own pixels and reports which edges are painted red. The
 *  top sample sits on the glass header and the bottom one on the composer row,
 *  so a frame hidden under either overlay fails here even when the class is set. */
async function redEdges(page: Page, panel: Locator): Promise<EdgeSample> {
  const box = await panel.boundingBox()
  expect(box).not.toBeNull()
  const clip = { x: Math.ceil(box!.x), y: Math.ceil(box!.y), width: Math.floor(box!.width) - 1, height: Math.floor(box!.height) - 1 }
  const png = await page.screenshot({ clip })
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const isRed = (x: number, y: number): boolean => {
    const i = (y * info.width + x) * info.channels
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    return r > 200 && g < 120 && b < 120
  }
  const midX = Math.floor(info.width / 2)
  const midY = Math.floor(info.height / 2)
  return {
    left: isRed(0, midY),
    right: isRed(info.width - 1, midY),
    top: isRed(midX, 0),
    bottom: isRed(midX, info.height - 1),
  }
}

const ALL_RED: EdgeSample = { left: true, right: true, top: true, bottom: true }
const NONE_RED: EdgeSample = { left: false, right: false, top: false, bottom: false }

async function expectFramed(page: Page, panel: Locator): Promise<void> {
  await expect(panel).toHaveClass(FRAME_CLASS, { timeout: 20_000 })
  // The frame fades in over 0.2s; sample after it settles.
  await expect.poll(() => redEdges(page, panel), { timeout: 5_000 }).toEqual(ALL_RED)
}

async function expectUnframed(page: Page, panel: Locator): Promise<void> {
  await expect(panel).not.toHaveClass(FRAME_CLASS, { timeout: 15_000 })
  await expect.poll(() => redEdges(page, panel), { timeout: 5_000 }).toEqual(NONE_RED)
}

test('a handed-back session window is framed red until the human acts', async ({ page }, testInfo) => {
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

  // ── 1. First session's turn ends → framed on all four edges ──
  await openDraftOnCwd(page, cwd)
  const taskA = await sendQuickStart(page, 'snapshot-clean-turn:Frame turn one finished')
  const sessionA = await sessionIdForTask(page, taskA)
  const panelA = page.locator(`${REAL_PANEL}[data-session-id="${sessionA}"]`)
  await expect(panelA.getByText('Frame turn one finished', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => taskPhase(page, taskA), { timeout: 20_000 }).toBe(HANDBACK_PHASE)
  await expectFramed(page, panelA)
  const frame = await panelA.evaluate((el) => {
    const s = getComputedStyle(el, '::after')
    return { width: s.borderTopWidth, color: s.borderTopColor, pointerEvents: s.pointerEvents, zIndex: s.zIndex }
  })
  expect(frame).toEqual({ width: '2px', color: 'rgb(255, 59, 48)', pointerEvents: 'none', zIndex: '31' })
  await page.screenshot({ path: shot('1-handed-back') })

  // ── 2. A second session still working → no frame there; framed when done ──
  await openDraftOnCwd(page, cwd)
  const taskB = await sendQuickStart(page, 'slow:6000 snapshot-clean-turn:Frame second column finished')
  const sessionB = await sessionIdForTask(page, taskB)
  const panelB = page.locator(`${REAL_PANEL}[data-session-id="${sessionB}"]`)
  await expect(panelB).toBeVisible()
  await expect(panelA).toBeVisible()
  expect(await taskPhase(page, taskB)).toBe('IN_PROGRESS')
  await expectUnframed(page, panelB)
  await expectFramed(page, panelA)
  await page.screenshot({ path: shot('2-one-working-one-ready') })
  await expect.poll(() => taskPhase(page, taskB), { timeout: 30_000 }).toBe(HANDBACK_PHASE)
  await expectFramed(page, panelB)
  await page.screenshot({ path: shot('2-both-ready') })

  // ── 3. Follow-ups in the first column: frame off while working, back after ──
  for (const round of [1, 2]) {
    const composer = panelA.locator('.chat-input-textarea')
    // A follow-up rides the live FIFO, where the mock ignores `slow:`; a long
    // turn is what keeps the agent visibly working for a few seconds.
    await composer.fill('snapshot-long-turn:8000:text')
    await composer.press('Enter')
    await expectUnframed(page, panelA)
    expect(await taskPhase(page, taskA)).toBe('IN_PROGRESS')
    await page.screenshot({ path: shot(`3-round${round}-working`) })
    await expect.poll(() => taskPhase(page, taskA), { timeout: 30_000 }).toBe(HANDBACK_PHASE)
    await expectFramed(page, panelA)
    await page.screenshot({ path: shot(`3-round${round}-handed-back`) })
  }

  // ── 4. Full screen keeps the frame, following the sheet's rounded corners ──
  await panelA.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(panelA).toHaveClass(/open-walnut-fullscreen/)
  await expectFramed(page, panelA)
  expect(await panelA.evaluate((el) => getComputedStyle(el, '::after').borderTopLeftRadius)).toBe('12px')
  await page.screenshot({ path: shot('4-fullscreen') })
  await panelA.getByRole('button', { name: 'Collapse session' }).click()
  await expect(panelA).not.toHaveClass(/open-walnut-fullscreen/)
  await expectFramed(page, panelA)

  // ── 5. The human completes the task → the frame goes away ──
  await selectSection(page, 'Focus')
  let card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskA}"]`)
  if (!(await card.isVisible())) {
    await selectSection(page, 'Satellite')
    card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskA}"]`)
  }
  await card.getByRole('button', { name: 'Mark complete', exact: true }).click()
  await expect.poll(() => taskPhase(page, taskA), { timeout: 20_000 }).toBe('COMPLETE')
  await expectUnframed(page, panelA)
  await expectFramed(page, panelB)
  await page.screenshot({ path: shot('5-completed') })

  await fs.writeFile(`${SCREENSHOT_DIR}/${testInfo.project.name}-evidence.json`,
    JSON.stringify({ taskA, sessionA, taskB, sessionB, failedResponses, errors }, null, 2))
  expect(errors).toEqual([])
  expect(failedResponses.filter((line) => /\/api\//.test(line) && !/\/api\/notes|\/api\/mail/.test(line))).toEqual([])
})

test('the Ask Walnut slot follows the same rule, in dark mode, under its drawer', async ({ page }, testInfo) => {
  test.setTimeout(150_000)
  const shot = (name: string) => `${SCREENSHOT_DIR}/${testInfo.project.name}-${name}.png`
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ colorScheme: 'dark' })
  await openHome(page)

  const composer = page.locator('[data-testid="ask-walnut-draft"] .chat-input-textarea')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  const quickStart = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await composer.fill('slow:5000 snapshot-clean-turn:Ask answered')
  await composer.press('Enter')
  const { taskId } = (await (await quickStart).json()) as { taskId: string }
  const panel = page.locator('[data-testid="ask-walnut-session"] .session-panel')
  await expect(panel).toBeVisible({ timeout: 60_000 })

  // Working: no frame. Answered: framed, like any column.
  expect(await taskPhase(page, taskId)).toBe('IN_PROGRESS')
  await expectUnframed(page, panel)
  await expect.poll(() => taskPhase(page, taskId), { timeout: 30_000 }).toBe(HANDBACK_PHASE)
  await expectFramed(page, panel)
  await page.screenshot({ path: shot('6-ask-slot-dark') })

  // The drawer (z-index 40) lies over the frame, not under it: the frame's top
  // edge is full red beside the drawer and covered (dimmed) where it runs under.
  const drawer = page.locator('[data-testid="ask-walnut-drawer"]')
  await page.locator('[data-testid="ask-walnut-menu"]').click()
  await expect(drawer).toBeVisible()
  const panelBox = (await panel.boundingBox())!
  const drawerBox = (await drawer.boundingBox())!
  const topIsFrameRed = async (x: number): Promise<boolean> => {
    const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.ceil(panelBox.y), width: 1, height: 1 } })
    const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return data[0] > 200 && data[1] < 120 && data[2] < 120
  }
  await expect.poll(() => topIsFrameRed(drawerBox.x + drawerBox.width / 2), { timeout: 5_000 }).toBe(false)
  expect(await topIsFrameRed(panelBox.x + panelBox.width - 20)).toBe(true)
  await page.screenshot({ path: shot('6-ask-slot-drawer') })
  expect(errors).toEqual([])
})
