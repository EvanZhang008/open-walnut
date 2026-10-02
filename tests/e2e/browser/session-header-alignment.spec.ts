/**
 * Playwright browser test: every item on a session header's title row sits on
 * one center line, and the unread dot keeps the task list's spacing from the
 * phase circle (2026-09-30 user report: "the dots don't align, and neither does
 * the circle").
 *
 * Measured from PIXELS, not boxes: the bug was an SVG that sat on the text
 * baseline inside a correctly centered box, so box geometry said "aligned"
 * while the circle drew 2px high. Each item's ink (pixels that differ from the
 * row background in its own column band) is read from a 2x screenshot, so the
 * resolution is half a CSS pixel.
 *
 * Real density: the header carries the pills a busy task has (Trigger, Worker,
 * Leader · 1), the status badge and the kebab, in both marker states (solid
 * unread dot, hollow read ring), in a session column and in the Ask Walnut slot.
 */
import fs from 'node:fs/promises'
import sharp from 'sharp'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openChatOnLoad, openDraftOnCwd } from './draft-helpers'

const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/session-header-alignment'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
/** Half a CSS pixel: one device pixel at 2x, the finest step ink can move. */
const CENTER_TOLERANCE = 0.5

let fixtureRoot = ''
const litterTasks: string[] = []
const litterRoutines: string[] = []

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.afterAll(async () => {
  for (const id of litterRoutines) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
  // Children first, so no delete trips over a parent that still has children.
  for (const id of [...litterTasks].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function quickStart(page: Page, composer: Locator, prompt: string): Promise<{ taskId: string; sessionId: string }> {
  const response = page.waitForResponse((r) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(prompt)
  await composer.press('Enter')
  const res = await response
  expect(res.status()).toBe(200)
  const out = (await res.json()) as { taskId: string; sessionId: string }
  litterTasks.push(out.taskId)
  return out
}

/** The pills a busy task carries: a parent (Worker), a subtask (Leader · 1), a trigger. */
async function dressAsBusyTask(taskId: string): Promise<void> {
  await api('PATCH', `/api/tasks/${taskId}`, { title: 'Focus big instance alignment' })
  const parent = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `Alignment parent ${Date.now()}`, source: 'local', project: 'Work' })
  litterTasks.unshift(parent.task.id)
  await api('PATCH', `/api/tasks/${taskId}`, { parent_task_id: parent.task.id })
  const child = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `Alignment child ${Date.now()}`, source: 'local', project: 'Work', parent_task_id: taskId })
  litterTasks.push(child.task.id)
  const trigger = await api<{ job: { id: string } }>('POST', '/api/v1/routines/trigger', {
    name: 'Alignment watch', description: 'Watches nothing; it only puts a Trigger pill on the header.',
    run: `echo '{"fire": false}'`, every: '5m', prompt: 'Nothing to do.', session: taskId,
  })
  litterRoutines.push(trigger.job.id)
}

interface Ink { top: number; bottom: number; left: number; right: number; cy: number }

/** Ink of each element, read from one 2x screenshot of the title row. */
async function inkOf(page: Page, row: Locator, selectors: Record<string, string>): Promise<{ rowCy: number; ink: Record<string, Ink> }> {
  const boxes = await row.evaluate((el, sels) => {
    const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {}
    for (const [name, sel] of Object.entries(sels)) {
      const target = el.querySelector(sel)
      const b = target?.getBoundingClientRect()
      out[name] = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null
    }
    const r = el.getBoundingClientRect()
    out.__row = { x: r.x, y: r.y, w: r.width, h: r.height }
    return out
  }, selectors)
  const rowBox = boxes.__row!
  const clip = { x: rowBox.x - 16, y: rowBox.y, width: rowBox.w + 18, height: rowBox.h }
  const png = await page.screenshot({ clip, animations: 'disabled' })
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const scale = info.width / clip.width
  const ink: Record<string, Ink> = {}
  for (const [name, box] of Object.entries(boxes)) {
    if (name === '__row') continue
    expect(box, `${name} is on the title row`).not.toBeNull()
    const x0 = Math.max(0, Math.round((box!.x - clip.x) * scale))
    const x1 = Math.min(info.width - 1, Math.round((box!.x + box!.w - clip.x) * scale) - 1)
    // Background = the most common colour in this element's column band.
    const counts = new Map<number, number>()
    for (let y = 0; y < info.height; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * info.width + x) * 3
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const bgKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const bg = [(bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255]
    let top = -1, bottom = -1, left = Number.POSITIVE_INFINITY, right = -1
    for (let y = 0; y < info.height; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * info.width + x) * 3
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 60) {
        if (top < 0) top = y
        bottom = y
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
    expect(top, `${name} drew something`).toBeGreaterThanOrEqual(0)
    ink[name] = {
      top: top / scale + clip.y, bottom: (bottom + 1) / scale + clip.y,
      left: left / scale + clip.x, right: (right + 1) / scale + clip.x,
      cy: (top + bottom + 1) / (2 * scale) + clip.y,
    }
  }
  return { rowCy: rowBox.y + rowBox.h / 2, ink }
}

/** Evidence shots of a title row: its start (widened left so the gutter dot is
 *  in frame) and its end (pills, badge, kebab), each at most 640px wide. */
async function rowShot(page: Page, row: Locator, name: string): Promise<void> {
  const b = (await row.boundingBox())!
  const base = `${SCREENSHOT_DIR}/${test.info().project.name}-${name}`
  const width = Math.min(b.width + 18, 640)
  await page.screenshot({ path: `${base}.png`, clip: { x: b.x - 16, y: b.y - 4, width, height: b.height + 8 }, animations: 'disabled' })
  await page.screenshot({ path: `${base}-end.png`, clip: { x: b.x + b.width + 2 - width, y: b.y - 4, width, height: b.height + 8 }, animations: 'disabled' })
}

const HEADER_ITEMS = {
  marker: '.session-panel-unread-dot',
  circle: '.task-quick-phase-btn svg',
  trigger: '.session-panel-title-meta .task-trigger-pill',
  sub: '.session-panel-title-meta .task-team-pill',
  badge: '.session-panel-title-meta .session-panel-badge',
  kebab: '.session-panel-title-meta .task-kebab-btn',
}

/** Every item's ink on the row's center line; the title's line box too. */
async function expectRowAligned(page: Page, panel: Locator, label: string): Promise<Record<string, Ink>> {
  const row = panel.locator('.session-panel-header-top')
  const { rowCy, ink } = await inkOf(page, row, HEADER_ITEMS)
  const offsets = Object.fromEntries(Object.entries(ink).map(([k, v]) => [k, +(v.cy - rowCy).toFixed(2)]))
  await fs.writeFile(`${SCREENSHOT_DIR}/${test.info().project.name}-${label}.json`, JSON.stringify({ rowCy, offsets, ink }, null, 2))
  for (const [name, off] of Object.entries(offsets)) {
    expect(Math.abs(off), `${label}: ${name} is ${off}px off the row's center line`).toBeLessThanOrEqual(CENTER_TOLERANCE)
  }
  const titleCy = await row.locator('.session-panel-title').first().evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const b = range.getBoundingClientRect()
    return b.y + b.height / 2
  })
  expect(Math.abs(titleCy - rowCy), `${label}: the title's line box is off center`).toBeLessThanOrEqual(1)
  return ink
}

/** The task list's own dot-to-circle ink gap, the spacing the header copies. */
async function listGap(page: Page, taskId: string): Promise<number> {
  const card = page.locator(`.todo-panel [data-task-id="${taskId}"]:has(.task-unread-dot)`).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  const { ink } = await inkOf(page, card, { dot: '.task-unread-dot', circle: '.task-phase-icon-btn svg' })
  expect(Math.abs(ink.dot.cy - ink.circle.cy), 'the list itself centers its dot on its circle').toBeLessThanOrEqual(CENTER_TOLERANCE)
  return ink.circle.left - ink.dot.right
}

test('a session column header: dot or ring, circle, pills, badge and kebab share one center line', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const { taskId, sessionId } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Alignment turn finished')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('Alignment turn finished', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await dressAsBusyTask(taskId)
  const header = panel.locator('.session-panel-header-top')
  for (const pill of ['Trigger', 'Worker', 'Leader']) {
    await expect(header.locator('.session-panel-title-meta').getByText(new RegExp(pill, 'i')).first()).toBeVisible({ timeout: 20_000 })
  }
  await expect(header.locator('.session-panel-unread-dot:not(.session-panel-attention-dot)')).toBeVisible({ timeout: 20_000 })

  const gap = await listGap(page, taskId)
  const unread = await expectRowAligned(page, panel, 'column-unread')
  expect(Math.abs((unread.circle.left - unread.marker.right) - gap), 'dot-to-circle gap matches the task list').toBeLessThanOrEqual(1)
  await rowShot(page, header, 'column-unread')

  // Read: the hollow ring takes the dot's place, on the same line and spacing.
  await panel.getByText('Alignment turn finished', { exact: true }).first().click()
  await expect(header.locator('.session-panel-attention-dot')).toBeVisible({ timeout: 20_000 })
  const read = await expectRowAligned(page, panel, 'column-read')
  expect(Math.abs((read.circle.left - read.marker.right) - gap), 'ring-to-circle gap matches the task list').toBeLessThanOrEqual(1)
  await rowShot(page, header, 'column-read')
  expect(errors).toEqual([])
})

test('the Ask Walnut slot header: the dot after the menu button keeps the same line and spacing', async ({ page }) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The chat spot starts hidden on a fresh browser; this test is about it.
  await openChatOnLoad(page)
  await openHome(page)
  const draft = page.locator('[data-testid="ask-walnut-draft"] .chat-input-textarea')
  await expect(draft).toBeVisible({ timeout: 30_000 })
  const { taskId } = await quickStart(page, draft, 'snapshot-clean-turn:Ask alignment answered')
  const panel = page.locator('[data-testid="ask-walnut-session"] .session-panel')
  await expect(panel.locator('.session-panel-unread-dot')).toBeVisible({ timeout: 60_000 })
  const gap = await listGap(page, taskId)
  const row = panel.locator('.session-panel-header-top')
  const { rowCy, ink } = await inkOf(page, row, {
    menu: '[data-testid="ask-walnut-menu"] svg', marker: '.session-panel-unread-dot', circle: '.task-quick-phase-btn svg',
  })
  for (const name of ['marker', 'circle'] as const) {
    expect(Math.abs(ink[name].cy - rowCy), `ask slot: ${name} off the center line`).toBeLessThanOrEqual(CENTER_TOLERANCE)
  }
  expect(ink.marker.left, 'the dot sits after the menu button').toBeGreaterThan(ink.menu.right)
  expect(Math.abs((ink.circle.left - ink.marker.right) - gap), 'dot-to-circle gap matches the task list').toBeLessThanOrEqual(1)
  await rowShot(page, row, 'ask-slot-unread')
  expect(errors).toEqual([])
})
