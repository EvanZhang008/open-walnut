/**
 * REAL-PIPELINE spec for the Claude subscription limit readout: the block in
 * the Switch Model popover (SubscriptionLimitReadout, under the turn speed row)
 * and the dot on the composer's model pill (SubscriptionLimitPillHint).
 *
 * Nothing is route-mocked. session:start / session:send WS RPC → MockDaemon
 * spawns the mock Claude CLI → its `rate-limit-event:<json>` mode writes real
 * `rate_limit_event` stream lines (mock-claude.mjs) → ClaudeCodeSession files
 * them in the per-host store (src/core/sessions/subscription-limits.ts) → the
 * `host:subscription-limits` WS push and GET /api/subscription-limits → the
 * browser store → the readout.
 *
 * Every reading lands on the fixture's ONE local host, so the two browser
 * projects must not interleave: the whole flow holds a cross-process lock.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SHOTS = '/tmp/limit-window'
const COLUMNS_KEY = 'open-walnut-home-session-columns'
const H = 3600
const DAY = 24 * H
const LOCK_DIR = path.join(os.tmpdir(), `walnut-pw-limit-window-${process.env.PW_TEST_PORT ?? 3457}.lock`)

const lineFor = (info: object) => `rate-limit-event:${JSON.stringify(info)}`

/** The CLI's own shape (2.1.284): the limiting window, plus every window's usage. */
const WARNING = {
  status: 'allowed_warning', rateLimitType: 'five_hour', resetsIn: 3 * H + 40 * 60, utilization: 0.92,
  surpassedThreshold: 0.9, isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.92, resetsIn: 3 * H + 40 * 60 },
    seven_day: { utilization: 0.31, resetsIn: 4 * DAY },
    // The per-model weekly bucket, present only for accounts that have one.
    seven_day_overage_included: { utilization: 0.18, resetsIn: 5 * DAY },
  },
}
/** The 5-hour limit is reached and the account runs on extra usage. */
const ON_EXTRA_USAGE = {
  status: 'rejected', rateLimitType: 'five_hour', resetsIn: 2 * H, utilization: 1,
  overageStatus: 'allowed', overageResetsIn: 10 * DAY, isUsingOverage: true,
  unifiedWindows: { five_hour: { utilization: 1, resetsIn: 2 * H }, seven_day: { utilization: 0.34, resetsIn: 4 * DAY } },
}
/** A fresh 5-hour window after the warning: normal state. */
const NORMAL = {
  status: 'allowed', rateLimitType: 'five_hour', resetsIn: 4 * H + 50 * 60, isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.12, resetsIn: 4 * H + 50 * 60 }, seven_day: { utilization: 0.33, resetsIn: 4 * DAY } },
}
/** A warning whose window resets in `s` seconds, so the reset really happens in the test. */
const RESETS_SOON = (s: number) => ({
  status: 'allowed_warning', rateLimitType: 'five_hour', resetsIn: s, utilization: 0.97, isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.97, resetsIn: s }, seven_day: { utilization: 0.34, resetsIn: 4 * DAY } },
})

let rpcSeq = 0

/** One WS RPC from inside the page (same as session-speed-readout.spec.ts). */
async function rpc(page: Page, method: string, payload: Record<string, unknown>): Promise<void> {
  const reqId = `pw-limit-${method}-${++rpcSeq}`
  await page.evaluate(async ({ method, payload, reqId }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    ws.send(JSON.stringify({ type: 'req', id: reqId, method, payload }))
    await new Promise<void>((resolve) => {
      ws.onmessage = (ev) => {
        try { const parsed = JSON.parse(ev.data as string); if (parsed.type === 'res' && parsed.id === reqId) resolve() } catch { /* ignore */ }
      }
      setTimeout(resolve, 5000)
    })
    ws.close()
  }, { method, payload, reqId })
}

async function newTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', { data: { title: `${title} (${test.info().project.name})`, source: 'local', project: 'Walnut' } })
  expect(res.ok(), `create task: ${res.status()}`).toBe(true)
  const body = await res.json() as { task?: { id: string }; id?: string }
  return body.task?.id ?? body.id!
}

async function sessionIdsFor(request: APIRequestContext, taskId: string): Promise<Set<string>> {
  const res = await request.get(`/api/sessions/task/${taskId}`)
  if (!res.ok()) return new Set()
  const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
  return new Set((body.sessions ?? []).map((s) => s.claudeSessionId))
}

async function waitForNewSessionId(request: APIRequestContext, taskId: string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const id of await sessionIdsFor(request, taskId)) if (!before.has(id)) return id
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no new mock session appeared for task ${taskId}`)
}

async function seedColumns(page: Page, sids: string[]): Promise<void> {
  await page.addInitScript(({ key, ids }) => {
    try { sessionStorage.setItem(key, JSON.stringify(ids.map((id) => ({ id, locked: false })))) } catch { /* ignore */ }
  }, { key: COLUMNS_KEY, ids: sids })
}

const columnFor = (page: Page, sid: string): Locator =>
  page.locator('.main-page-sessions-area > .main-page-session-column').filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })
const picker = (page: Page) => page.locator('.model-picker')
const readout = (page: Page) => picker(page).getByTestId('subscription-limit-readout')
const row = (page: Page, type: string) => readout(page).locator(`[data-testid="limit-row"][data-limit-type="${type}"]`)
const pillOf = (col: Locator) => col.locator('.composer-model-pill').first()
const hintOf = (col: Locator) => pillOf(col).getByTestId('limit-pill-hint')

async function openPicker(page: Page, col: Locator): Promise<void> {
  await closePicker(page)
  await pillOf(col).click()
  await expect(picker(page)).toHaveCount(1)
}

async function closePicker(page: Page): Promise<void> {
  if ((await picker(page).count()) === 0) return
  await picker(page).locator('.model-picker-close').click()
  await expect(picker(page)).toHaveCount(0)
}

/** A crop around `loc` (with some context), never wider than the 1280px viewport. */
async function shot(page: Page, loc: Locator, name: string, pad = 24): Promise<void> {
  const box = await loc.boundingBox()
  expect(box, `${name}: element has a box`).not.toBeNull()
  const vp = page.viewportSize()!
  const x = Math.max(0, box!.x - pad)
  const y = Math.max(0, box!.y - pad)
  const clip = { x, y, width: Math.min(vp.width - x, box!.width + 2 * pad), height: Math.min(vp.height - y, box!.height + 2 * pad) }
  fs.mkdirSync(SHOTS, { recursive: true })
  // The picker fades in over 150ms (commandPaletteIn); settle it so a crop taken
  // right after opening shows the finished popover, not the chat behind a fade.
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-${name}.png`), clip, animations: 'disabled' })
}

async function rowText(page: Page, type: string): Promise<Record<string, string | null>> {
  return row(page, type).evaluate((el) => {
    const pick = (id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null
    return { state: el.getAttribute('data-state'), label: pick('limit-label'), value: pick('limit-value'), when: pick('limit-when'), age: pick('limit-age') }
  })
}

/** The fixture's one local host is shared by both projects: hold it for the whole flow. */
async function takeLock(): Promise<void> {
  const deadline = Date.now() + 8 * 60_000
  for (;;) {
    try { fs.mkdirSync(LOCK_DIR); return } catch { /* held */ }
    try { if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 6 * 60_000) fs.rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* gone */ }
    if (Date.now() > deadline) throw new Error(`limit-window lock ${LOCK_DIR} never freed`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

test.describe('subscription limit window', () => {
  test.beforeAll(async () => { await takeLock() })
  test.afterAll(() => { fs.rmSync(LOCK_DIR, { recursive: true, force: true }) })
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 800 }) })

  test('a subscription host: warning, back to normal, a reload, then a window that really resets', async ({ page, request }) => {
    const TASK = await newTask(request, 'Limit window')
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    const before = await sessionIdsFor(request, TASK)
    await rpc(page, 'session:start', { taskId: TASK, message: lineFor(WARNING), project: 'Walnut' })
    const sid = await waitForNewSessionId(request, TASK, before)

    await seedColumns(page, [sid])
    await page.goto('/')
    const col = columnFor(page, sid)
    await expect(col).toHaveCount(1, { timeout: 30_000 })
    await expect(pillOf(col)).toBeVisible({ timeout: 30_000 })

    // 1. Warning: the pill carries the amber dot without opening anything.
    await expect(hintOf(col)).toHaveAttribute('data-level', 'warning', { timeout: 30_000 })
    await expect(hintOf(col)).toHaveAttribute('aria-label', /^5-hour limit 92% used · resets \d{1,2}:\d{2}\s[AP]M$/)
    await shot(page, pillOf(col), '1-warning-pill', 40)
    // The line is a known type: no "unknown event" block in the chat.
    await expect(col.getByText(/rate_limit_event/)).toHaveCount(0)

    await openPicker(page, col)
    await expect(readout(page)).toBeVisible()
    await expect(readout(page)).toHaveAttribute('data-host', '__local__')
    expect(await rowText(page, 'five_hour')).toMatchObject({ state: 'warning', label: '5-hour limit', value: '92%', age: null })
    expect((await rowText(page, 'five_hour')).when).toMatch(/^resets \d{1,2}:\d{2}\s[AP]M$/)
    expect(await rowText(page, 'seven_day')).toMatchObject({ state: 'ok', label: 'Weekly limit', value: '31%' })
    expect((await rowText(page, 'seven_day')).when).toMatch(/^resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
    expect(await rowText(page, 'seven_day_overage_included')).toMatchObject({ state: 'ok', label: 'Weekly Fable limit', value: '18%' })
    // Window order: 5-hour, weekly, then the per-model weekly bucket.
    await expect(readout(page).getByTestId('limit-label')).toHaveText(['5-hour limit', 'Weekly limit', 'Weekly Fable limit'])
    await expect(readout(page).getByTestId('limit-overage')).toHaveCount(0)
    await shot(page, picker(page), '2-warning-popover', 8)

    // 2. A fresh window, normal state: the dot goes away, the numbers move.
    await closePicker(page)
    await rpc(page, 'session:send', { sessionId: sid, message: lineFor(NORMAL) })
    await expect(hintOf(col)).toHaveCount(0, { timeout: 30_000 })
    await openPicker(page, col)
    await expect(row(page, 'five_hour').getByTestId('limit-value')).toHaveText('12%', { timeout: 15_000 })
    expect(await rowText(page, 'five_hour')).toMatchObject({ state: 'ok' })
    await expect(row(page, 'seven_day').getByTestId('limit-value')).toHaveText('33%')
    await shot(page, picker(page), '3-normal-popover', 8)
    await closePicker(page)
    await shot(page, pillOf(col), '3-normal-pill', 40)

    // 3. A reload keeps the reading (hydrated from the server, not from this tab).
    await page.reload()
    const colAfter = columnFor(page, sid)
    await expect(colAfter).toHaveCount(1, { timeout: 30_000 })
    await expect(pillOf(colAfter)).toBeVisible({ timeout: 30_000 })
    await openPicker(page, colAfter)
    await expect(row(page, 'five_hour').getByTestId('limit-value')).toHaveText('12%', { timeout: 15_000 })
    await expect(row(page, 'seven_day').getByTestId('limit-value')).toHaveText('33%')
    await closePicker(page)
    // Hydrated (the popover above read it), and still no dot in the normal state.
    await expect(hintOf(colAfter)).toHaveCount(0)
    await shot(page, pillOf(colAfter), '4-after-reload-pill', 40)

    // 4. Limit reached, running on extra usage: amber (not red) dot, and the extra-usage line.
    await rpc(page, 'session:send', { sessionId: sid, message: lineFor(ON_EXTRA_USAGE) })
    await expect(hintOf(colAfter)).toHaveAttribute('data-level', 'warning', { timeout: 30_000 })
    await expect(hintOf(colAfter)).toHaveAttribute('aria-label', '5-hour limit reached · using extra usage')
    await openPicker(page, colAfter)
    await expect(row(page, 'five_hour')).toHaveAttribute('data-state', 'rejected', { timeout: 10_000 })
    expect(await rowText(page, 'five_hour')).toMatchObject({ value: '100%' })
    await expect(readout(page).getByTestId('limit-overage')).toHaveText(/^Using extra usage · resets \w{3} \d{1,2}$/)
    await shot(page, picker(page), '5-extra-usage-popover', 8)
    await closePicker(page)

    // 5. A window that resets while the user watches: it turns into "reset", not the old 97%.
    await rpc(page, 'session:send', { sessionId: sid, message: lineFor(RESETS_SOON(25)) })
    await expect(hintOf(colAfter)).toHaveAttribute('data-level', 'warning', { timeout: 20_000 })
    await openPicker(page, colAfter)
    await expect(row(page, 'five_hour').getByTestId('limit-value')).toHaveText('97%', { timeout: 10_000 })
    // That snapshot says nothing about extra usage any more: the line is gone.
    await expect(readout(page).getByTestId('limit-overage')).toHaveCount(0)
    await shot(page, picker(page), '6-before-reset-popover', 8)
    // The readout changes in place: the open popover is not rebuilt (no re-fade, no jump).
    await picker(page).evaluate((el) => { el.setAttribute('data-pw-open-mark', '1') })
    await expect(row(page, 'five_hour')).toHaveAttribute('data-state', 'reset', { timeout: 45_000 })
    await expect(picker(page)).toHaveAttribute('data-pw-open-mark', '1')
    // The popover is opaque and on top of the chat: its header, the readout and
    // the model list all hit-test to the popover itself.
    const covered = await picker(page).evaluate((el) => {
      const probe = (node: Element | null) => {
        if (!node) return 'missing'
        const r = node.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return top && el.contains(top) ? 'popover' : (top?.className?.toString() ?? 'none')
      }
      let opacity = 1
      for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
      return {
        header: probe(el.querySelector('.model-picker-header')),
        readout: probe(el.querySelector('[data-testid="subscription-limit-readout"]')),
        list: probe(el.querySelector('.model-picker-row')),
        opacity,
      }
    })
    // (In WebKit the chat still shows faintly through the popover's frosted glass,
    // globals.css "iOS Materials Pass": WebKit does not blur across a backdrop root.)
    expect(covered).toEqual({ header: 'popover', readout: 'popover', list: 'popover', opacity: 1 })
    expect(await rowText(page, 'five_hour')).toMatchObject({ state: 'reset', value: null, when: 'reset', age: null })
    // The weekly window has not reset, so it keeps its number.
    expect(await rowText(page, 'seven_day')).toMatchObject({ state: 'ok', value: '34%' })
    await shot(page, picker(page), '7-reset-popover', 8)
    await closePicker(page)
    await expect(hintOf(colAfter)).toHaveCount(0)
    await shot(page, pillOf(colAfter), '7-reset-pill', 40)
  })

  test('a host that never reported a reading (Bedrock, an API key) shows nothing at all', async ({ page, request }) => {
    const SID = 'pw-limits-remote-session'
    // Per host: this machine has a reading by now, the session's host has none.
    const read = await (await request.get('/api/subscription-limits')).json() as { hosts: Array<{ host: string }> }
    expect(read.hosts.map((h) => h.host)).toContain('__local__')
    expect(read.hosts.map((h) => h.host)).not.toContain('fixture-remote')

    await seedColumns(page, [SID])
    const hydrated = page.waitForResponse((r) => r.url().includes('/api/subscription-limits') && r.status() === 200, { timeout: 60_000 })
    await page.goto('/')
    const col = columnFor(page, SID)
    await expect(col).toHaveCount(1, { timeout: 30_000 })
    await expect(pillOf(col)).toBeVisible({ timeout: 30_000 })
    await hydrated
    await openPicker(page, col)
    await expect(picker(page).locator('.model-picker-header')).toBeVisible()
    // No block, no empty meter, no zero: nothing.
    await expect(readout(page)).toHaveCount(0)
    await expect(picker(page).getByText(/Usage limits|5-hour limit|Weekly limit/)).toHaveCount(0)
    await expect(hintOf(col)).toHaveCount(0)
    await shot(page, picker(page), '8-no-reading-popover', 8)
  })
})
