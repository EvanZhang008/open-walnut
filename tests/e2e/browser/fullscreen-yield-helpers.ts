/**
 * Shared scaffolding for the fullscreen-yield specs (Chromium + WebKit files).
 * Playwright only accepts `test.use({ browserName })` at a file's top level, so
 * the engine split is two spec files over one set of helpers.
 */
import fs from 'node:fs/promises'
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { REAL_PANEL_IN_COLUMN } from './draft-helpers'

export const FULLSCREEN_SESSION = 'pw-vscode-session'
export const FULLSCREEN_TASK = 'pw-task-vscode'
/** A second stopped fixture session with a task — the "Open session" target. */
export const TARGET_SESSION = 'pw-pins-session'
export const SCREENSHOT_DIR = '/tmp/fullscreen-yield'
/** Provenance header the ops executor sets (src/ops: CALLER_SID_HEADER). */
const CALLER_SID_HEADER = 'x-walnut-caller-sid'
export const NONCE = Date.now().toString(36)

export async function ensureScreenshotDir(): Promise<void> {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
}

/** Capture the app's own /ws socket so server frames can be replayed into it. */
async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Original = window.WebSocket
    window.WebSocket = class YieldWebSocket extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const parsed = new URL(String(url), window.location.href)
        const holder = window as unknown as { __yieldWs?: WebSocket }
        if (parsed.pathname === '/ws' && !holder.__yieldWs) holder.__yieldWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] =
          (Original as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only browser constants already exist on the subclass.
      }
    }
  })
}

async function waitForWs(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as unknown as { __yieldWs?: WebSocket }).__yieldWs
    return !!ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 20_000 })
}

/** Dispatch one server event frame on the captured socket. */
async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ eventName, eventData }) => {
    const ws = (window as unknown as { __yieldWs?: WebSocket }).__yieldWs
    if (!ws) throw new Error('the app WebSocket was never captured')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: eventName, data: eventData, seq: Date.now() }),
    }))
  }, { eventName: name, eventData: data })
}

/** Raise a live AskUserQuestion permission toast attributed to `sessionId`. */
export async function raisePermissionToast(page: Page, sessionId: string, tag: string): Promise<Locator> {
  await injectEvent(page, 'notification:new', {
    id: `yield-perm-${tag}`, kind: 'permission', severity: 'warning',
    title: 'AskUserQuestion', body: 'Which test machine?', timestamp: Date.now(), read: false,
    dedupKey: `perm:yield-${tag}`, requestId: `yield-${tag}`, toolName: 'AskUserQuestion',
    sessionId,
    input: {
      questions: [{
        header: 'Machine', question: 'Which test machine?',
        options: [{ label: 'VM' }, { label: 'Test Mac' }], multiSelect: false,
      }],
    },
    host: 'yield-host', sessionTitle: `PW yield ${tag}`,
  })
  const toast = page.locator('.nfc-perm-toast').filter({ hasText: `PW yield ${tag}` })
  await expect(toast).toBeVisible()
  return toast
}

/**
 * Raise a hard-error toast carrying a navigate action. `actionOf` keeps an explicit
 * `action` over the session default, so the button below calls `navigateToTarget`
 * with exactly `to` — the same code path every notification action link takes.
 */
export async function raiseActionToast(page: Page, tag: string, to: string): Promise<Locator> {
  await injectEvent(page, 'notification:new', {
    id: `yield-err-${tag}`, kind: 'operation-error', severity: 'error',
    title: `PW yield ${tag}`, body: 'A letter needs you', timestamp: Date.now(), read: false,
    dedupKey: `error:yield-${tag}`, action: { label: 'Open letter', to },
  })
  const toast = page.locator('.notification-toast').filter({ hasText: `PW yield ${tag}` })
  await expect(toast).toBeVisible()
  return toast
}

/** `POST /api/v1/human-inbox` — exactly what `wn tools call human_inbox_send` hits. */
export async function sendLetter(request: APIRequestContext, subject: string, callerSid: string): Promise<string> {
  const res = await request.post('/api/v1/human-inbox', {
    data: { subject, type: 'info', markdown: `## Note\n\nSeeded by the fullscreen-yield spec (${NONCE}).`, text: subject },
    headers: { [CALLER_SID_HEADER]: callerSid },
  })
  expect(res.status(), await res.text()).toBe(201)
  const { id } = await res.json() as { id: string }
  expect(id).toMatch(/^lt-/)
  return id
}

export const columnPanel = (page: Page, sessionId: string): Locator =>
  page.locator(`.main-page-session-column ${REAL_PANEL_IN_COLUMN}[data-session-id="${sessionId}"]`)

/** Open the fixture session's panel from the homepage (real clicks, no page.goto). */
export async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(FULLSCREEN_SESSION)
  const task = page.locator(`.todo-panel-item[data-task-id="${FULLSCREEN_TASK}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = columnPanel(page, FULLSCREEN_SESSION)
  await expect(panel).toBeVisible()
  return panel
}

/** Files promotes the panel to the fullscreen sheet. */
export async function enterFilesFullscreen(page: Page, panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Files' }).click()
  await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 15_000 })
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(1)
}

export async function expectNoFullscreen(page: Page): Promise<void> {
  await expect(page.locator('.open-walnut-fullscreen')).toHaveCount(0)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
}

/**
 * The element under the pointer at the locator's centre must live INSIDE the
 * locator. This is the assertion the bug fails: before the fix the target column
 * was in the DOM and even "visible" to Playwright's definition, but every hit test
 * at its centre landed on the fullscreen sheet.
 *
 * Polled, and measured in ONE evaluate: the session strip runs a 320ms FLIP
 * animation when a column is added, so a box read in one round trip and hit-tested
 * in the next could point at a neighbour mid-slide. A miss (no element at the point
 * at all) is a failure, not a pass — the target must be what is hit.
 */
export async function expectOnTop(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((el) => {
    const b = el.getBoundingClientRect()
    if (b.width === 0 || b.height === 0) return 'target has no layout box'
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    if (!hit) return 'nothing under the centre point'
    return el.contains(hit) ? 'on top' : `covered by ${hit.tagName.toLowerCase()}.${hit.className}`
  }), { timeout: 5_000 }).toBe('on top')
}

/** The shared beforeEach: viewport, socket capture, expanded Files tree, home. */
export async function prepareHome(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 })
  await captureWs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForWs(page)
}

/** The core case, run by both engines. */
export async function openSessionFromToastRevealsTargetColumn(page: Page): Promise<void> {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  const panel = await openSessionPanel(page)
  await enterFilesFullscreen(page, panel)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-files-fullscreen-${engine}.png` })

  const toast = await raisePermissionToast(page, TARGET_SESSION, 'other')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-toast-over-fullscreen-${engine}.png` })
  await toast.getByRole('button', { name: 'Open session ↗' }).click()

  // The sheet is gone and the split closed with it (the same exit Escape takes).
  await expectNoFullscreen(page)
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
  // The source column is still here — yielding is not closing.
  await expect(panel).toBeVisible()
  // The target column opened AND is actually on top where the user can see it.
  const target = columnPanel(page, TARGET_SESSION)
  await expect(target).toBeVisible({ timeout: 10_000 })
  await expectOnTop(target)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-target-column-revealed-${engine}.png` })
}
