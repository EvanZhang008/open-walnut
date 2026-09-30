/**
 * REAL-PIPELINE Playwright spec for the turn speed readout row above each
 * session panel's composer (SessionSpeedReadout).
 *
 * Nothing about the readout is injected or route-mocked: session:start WS RPC
 * → MockDaemon spawns the mock Claude CLI → real stream_event JSONL → the
 * server's TurnSpeedMeter (src/core/sessions/turn-speed.ts) → real
 * `session:turn-speed` WS frames → turn-speed-store → the row. The final frame
 * is also persisted as `lastTurnSpeed` on the session record, which is what a
 * cold load reads.
 *
 * The mock turn (`chunk-delay:300 stream-partial-speed`, mock-claude.mjs mode
 * 'speed') is two API messages with a 6s tool run between them:
 *   message 1: message_start, then 4 deltas, 300ms pauses (~1.5s), output_tokens 30
 *   tool gap:  6000ms of no model output
 *   message 2: same shape, output_tokens 20
 *   result:    output_tokens 50, duration_ms 9000, total_cost_usd 0.0123
 * Generation windows (message_start → message_stop) sum to ~3.0s, so tok/s is
 * ~17. A rate over wall time (50 / 9.0s ≈ 5.6) would mean the tool gap was
 * counted as generation, which is the one thing the readout promises not to
 * do. The floor below (9) sits well above that and still leaves a loaded
 * machine room to stretch the windows to ~5.5s.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SPEED_MESSAGE = 'chunk-delay:300 stream-partial-speed'
const COLUMNS_KEY = 'open-walnut-home-session-columns'

let rpcSeq = 0

/** Start a real session via the session:start WS RPC from inside the page.
 *  Same as single-timeline-real-pipeline.spec.ts, plus an optional `model`. */
async function startRealSession(page: Page, message: string, taskId: string, model?: string): Promise<void> {
  const reqId = `pw-speed-start-${++rpcSeq}`
  await page.evaluate(
    async ({ message, taskId, model, reqId }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      ws.send(JSON.stringify({
        type: 'req', id: reqId, method: 'session:start',
        payload: { taskId, message, project: 'Walnut', ...(model ? { model } : {}) },
      }))
      await new Promise<void>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'res' && parsed.id === reqId) resolve()
          } catch { /* ignore */ }
        }
        setTimeout(resolve, 5000)
      })
      ws.close()
    },
    { message, taskId, model, reqId },
  )
}

/** Session ids already on a task. Snapshot before a start so the wait below
 *  only accepts the session THIS test started. Not filtered by id shape: the
 *  server now hands the CLI a UUID via --session-id, so the mock's own
 *  `mock-session-*` ids no longer appear. */
async function sessionIdsFor(request: APIRequestContext, taskId: string): Promise<Set<string>> {
  const res = await request.get(`/api/sessions/task/${taskId}`)
  if (!res.ok()) return new Set()
  const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
  return new Set((body.sessions ?? []).map((s) => s.claudeSessionId))
}

/** Poll until a NEW session appears on taskId; return its id. Generous budget:
 *  the mock CLI spawn is a node process start, slow on a loaded box. */
async function waitForNewSessionId(request: APIRequestContext, taskId: string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ids = await sessionIdsFor(request, taskId)
    for (const id of ids) if (!before.has(id)) return id
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no new mock session appeared for task ${taskId}`)
}

/** Seed the home column queue (left to right) for every later navigation. */
async function seedColumns(page: Page, sids: string[]): Promise<void> {
  await page.addInitScript(({ key, ids }) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(ids.map((id) => ({ id, locked: false }))))
    } catch { /* ignore */ }
  }, { key: COLUMNS_KEY, ids: sids })
}

const columns = (page: Page) => page.locator('.main-page-sessions-area > .main-page-session-column')

/** The home column holding `sid`'s real panel. Every readout locator is scoped
 *  to one of these: the Ask Walnut slot mounts a SessionPanel of its own. */
function columnFor(page: Page, sid: string): Locator {
  return columns(page).filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })
}

const readoutIn = (col: Locator) => col.getByTestId('session-speed-readout')

/** Pick a panel count through the real Settings UI, then wait for it to reach
 *  config (copied from session-panel-count.spec.ts: the write is a read-modify-
 *  write that can be starved, so a stalled write gets its click retried). */
async function setPanelMode(page: Page, label: '1' | '2' | '3' | '4' | '5' | 'Auto') {
  if (!page.url().startsWith('http')) {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  }
  const settingsLink = page.locator('.sidebar a[href^="/settings"]')
  await expect(settingsLink).toBeVisible({ timeout: 60_000 })
  await settingsLink.click()
  const picker = page.locator('#settings-session-panels')
  await expect(picker).toBeVisible({ timeout: 20_000 })
  const btn = picker.locator('.settings-segment').filter({ hasText: new RegExp(`^${label}$`) })
  await btn.click()
  await expect(btn).toHaveAttribute('aria-checked', 'true')
  const expected = label === 'Auto' ? 'auto' : label
  // An unset value IS '2': that is the default the picker lights, and clicking
  // the already-lit default writes nothing, so config never names it.
  const readMode = async () => {
    const res = await page.request.get('/api/config')
    return (await res.json())?.config?.ui?.session_panels ?? '2'
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await expect.poll(readMode, { timeout: 15_000, intervals: [250, 500, 1000, 2000] }).toBe(expected)
      return
    } catch {
      if (attempt === 2) throw new Error(`session_panels never became ${expected} (last: ${await readMode()})`)
      await btn.click()
    }
  }
}

/** Every slot's text in one read, for assertion messages and the report. */
async function readoutState(col: Locator): Promise<Record<string, string | null>> {
  const r = readoutIn(col)
  if ((await r.count()) === 0) return { present: null }
  return r.evaluate((el) => {
    const pick = (id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null
    // The row clips at its right edge in a narrow column (by design, see
    // session-speed.css); name the slots that are cut, for the report.
    const right = el.getBoundingClientRect().right
    const clipped = Array.from(el.querySelectorAll('[data-testid^="speed-"]'))
      .filter((c) => c.getBoundingClientRect().right > right + 0.5)
      .map((c) => c.getAttribute('data-testid'))
      .join(',')
    return {
      clipped: clipped || null,
      live: el.getAttribute('data-live'),
      model: pick('speed-model'),
      tokens: pick('speed-tokens'),
      ttft: pick('speed-ttft'),
      tps: pick('speed-tps'),
      duration: pick('speed-duration'),
      cost: pick('speed-cost'),
      flag: pick('speed-flag'),
    }
  })
}

/** The fixture server's "turn speed" log lines for a session (its structured
 *  log lives in <tmp>/walnut-pw-<ts>/daemon/). Evidence for a failure report. */
function turnSpeedLogLines(sid: string): string[] {
  const tmp = os.tmpdir()
  const dirs = fs.readdirSync(tmp)
    .filter((n) => /^walnut-pw-\d+$/.test(n))
    .map((n) => path.join(tmp, n, 'daemon'))
    .filter((d) => fs.existsSync(d))
  const out: string[] = []
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => /^open-walnut-.*\.log$/.test(n))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const line of text.split('\n')) {
        if (line.includes('turn speed') && line.includes(sid)) out.push(line)
      }
    }
  }
  return out
}

async function report(label: string, sid: string, col: Locator): Promise<Record<string, string | null>> {
  const state = await readoutState(col)
  const logs = turnSpeedLogLines(sid)
  const text = `${label} ${sid}\nreadout: ${JSON.stringify(state)}\nserver:\n${logs.join('\n') || '(no "turn speed" line)'}`
  console.log(text)
  await test.info().attach(`${label}-readout`, { body: text, contentType: 'text/plain' })
  return state
}

/** Screenshot of the session strip only, into the test's own output dir. */
async function clipShot(page: Page, name: string): Promise<void> {
  const box = await page.locator('.main-page-sessions-area').boundingBox()
  expect(box, 'sessions area has a box').not.toBeNull()
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: box! })
}

/** The final-numbers contract, identical for both models. Returns tok/s. */
async function assertFinalReadout(col: Locator, model: string): Promise<number> {
  const r = readoutIn(col)
  await expect(r).toHaveAttribute('data-live', 'false')
  await expect(r.getByTestId('speed-model')).toHaveText(model)
  // The CLI's own count, and the "~" of the interim estimate is gone.
  await expect(r.getByTestId('speed-tokens')).toHaveText('50 tok')
  await expect(r.getByTestId('speed-duration')).toHaveText('9.0s')
  await expect(r.getByTestId('speed-cost')).toHaveText('$0.01')
  await expect(r.getByTestId('speed-ttft')).toHaveText(/^first \d+(\.\d)?s$/)
  await expect(r.getByTestId('speed-flag')).toHaveCount(0)
  const tpsText = (await r.getByTestId('speed-tps').textContent())?.trim() ?? ''
  const m = tpsText.match(/^(\d+) tok\/s$/)
  expect(m, `tok/s reads "${tpsText}"`).not.toBeNull()
  const tps = Number(m![1])
  // 50 tokens over ~3.0s of generation ≈ 17. A wall-clock rate (tool gap
  // counted) would be ≈ 6, well below this floor.
  expect(tps, `tok/s ${tps} excludes the tool gap`).toBeGreaterThanOrEqual(9)
  expect(tps, `tok/s ${tps} is not inflated`).toBeLessThanOrEqual(40)
  return tps
}

// One worker, in order: each test spawns real mock CLIs, and the box is loaded.
test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('two panels side by side show a live readout each, then final numbers', async ({ page, request }) => {
  await setPanelMode(page, '2')

  const TASK_A = 'pw-task-001'
  const TASK_B = 'pw-task-in-progress'
  const beforeA = await sessionIdsFor(request, TASK_A)
  const beforeB = await sessionIdsFor(request, TASK_B)
  await startRealSession(page, SPEED_MESSAGE, TASK_A, 'claude-opus-5-5')
  await startRealSession(page, SPEED_MESSAGE, TASK_B, 'claude-sonnet-5-5')
  const [sidA, sidB] = await Promise.all([
    waitForNewSessionId(request, TASK_A, beforeA),
    waitForNewSessionId(request, TASK_B, beforeB),
  ])

  await seedColumns(page, [sidA, sidB])
  await page.goto('/')

  const colA = columnFor(page, sidA)
  const colB = columnFor(page, sidB)
  await expect(colA).toHaveCount(1, { timeout: 30_000 })
  await expect(colB).toHaveCount(1, { timeout: 30_000 })
  // Seed order is the strip order: A is the LEFT column.
  await expect(columns(page).first().locator('.session-panel').first()).toHaveAttribute('data-session-id', sidA)

  // Mid-stream: both rows are live at the same time, each naming its own model,
  // with a first-token slot once the first delta landed.
  const liveBoth = async () => {
    const [a, b] = await Promise.all([readoutState(colA), readoutState(colB)])
    return `${a.live}|${b.live}`
  }
  try {
    await expect.poll(liveBoth, { timeout: 8_000, intervals: [100] }).toBe('true|true')
  } catch (err) {
    await report('live-miss-A', sidA, colA)
    await report('live-miss-B', sidB, colB)
    throw err
  }
  for (const [col, model] of [[colA, 'Opus 5.5'], [colB, 'Sonnet 5.5']] as const) {
    const r = readoutIn(col)
    await expect(r).toBeVisible()
    await expect(r.getByTestId('speed-model')).toHaveText(model)
    await expect(r.getByTestId('speed-ttft')).toHaveText(/^first \d/, { timeout: 6_000 })
  }
  await clipShot(page, 'two-panels-live')
  const liveA = await report('live-A', sidA, colA)
  const liveB = await report('live-B', sidB, colB)
  expect(liveA.live === 'true' || liveB.live === 'true', 'screenshot caught at least one live row').toBe(true)

  // Final: both rows freeze on the turn's own numbers.
  await expect(readoutIn(colA)).toHaveAttribute('data-live', 'false', { timeout: 20_000 })
  await expect(readoutIn(colB)).toHaveAttribute('data-live', 'false', { timeout: 20_000 })
  await report('final-A', sidA, colA)
  await report('final-B', sidB, colB)
  const tpsA = await assertFinalReadout(colA, 'Opus 5.5')
  const tpsB = await assertFinalReadout(colB, 'Sonnet 5.5')
  test.info().annotations.push({ type: 'tok/s', description: `A (Opus 5.5) ${tpsA}, B (Sonnet 5.5) ${tpsB}` })
  console.log(`observed tok/s: A ${tpsA}, B ${tpsB}`)
  await clipShot(page, 'two-panels-final')
})

test('reload keeps the last turn\'s readout', async ({ page, request }) => {
  const TASK = 'pw-task-agent-complete'
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  const before = await sessionIdsFor(request, TASK)
  await startRealSession(page, SPEED_MESSAGE, TASK, 'claude-opus-5-5')
  const sid = await waitForNewSessionId(request, TASK, before)

  await seedColumns(page, [sid])
  await page.goto('/')
  const col = columnFor(page, sid)
  await expect(col).toHaveCount(1, { timeout: 30_000 })
  await expect(readoutIn(col)).toHaveAttribute('data-live', 'false', { timeout: 30_000 })
  await expect(readoutIn(col).getByTestId('speed-tokens')).toHaveText('50 tok')

  // The final is written onto the record asynchronously; the cold load below
  // reads that copy, so wait for it to land first.
  const recordSpeed = async () => {
    const res = await request.get(`/api/sessions/${sid}`)
    if (!res.ok()) return null
    const body = await res.json() as { session?: { lastTurnSpeed?: { final?: boolean; outputTokens?: number } } }
    return body.session?.lastTurnSpeed ?? null
  }
  await expect.poll(async () => (await recordSpeed())?.final ?? null, { timeout: 15_000 }).toBe(true)
  const persisted = await recordSpeed()
  expect(persisted?.final).toBe(true)
  expect(persisted?.outputTokens).toBe(50)

  // Cold load: no live frame exists in this page any more, only the record.
  await page.reload()
  const colAfter = columnFor(page, sid)
  await expect(colAfter).toHaveCount(1, { timeout: 30_000 })
  const r = readoutIn(colAfter)
  await expect(r).toBeVisible({ timeout: 30_000 })
  await expect(r).toHaveAttribute('data-live', 'false')
  await expect(r.getByTestId('speed-tokens')).toHaveText('50 tok')
  await expect(r.getByTestId('speed-model')).toHaveText('Opus 5.5')
  await report('after-reload', sid, colAfter)
})

test('a session with no measured turn shows no readout', async ({ page, request }) => {
  const SID = 'pw-normal-session'
  // The premise: this seeded session has never run a turn this server measured.
  const res = await request.get(`/api/sessions/${SID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json() as { session?: { lastTurnSpeed?: unknown } }
  expect(body.session?.lastTurnSpeed).toBeUndefined()

  await seedColumns(page, [SID])
  await page.goto('/')
  const col = columnFor(page, SID)
  await expect(col).toHaveCount(1, { timeout: 30_000 })
  // The composer's controls bar renders only once the record has loaded, so the
  // readout (which sits right above the composer) had its chance to render.
  await expect(col.locator('.session-mode-bar')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1000)
  await expect(readoutIn(col)).toHaveCount(0)
})
