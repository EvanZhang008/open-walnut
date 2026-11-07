/**
 * REAL-PIPELINE Playwright spec for the turn speed readout row inside each
 * session panel's model picker (SessionSpeedReadout under the picker's live
 * strip; the picker opens from the composer's model pill).
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
import { holdPanelCountLock } from './panel-count-lock'

const SPEED_MESSAGE = 'chunk-delay:300 stream-partial-speed'
const COLUMNS_KEY = 'open-walnut-home-session-columns'

let rpcSeq = 0

/** One WS RPC from inside the page (session:start, session:send), as
 *  single-timeline-real-pipeline.spec.ts does: resolves on its answer. */
async function rpc(page: Page, method: string, payload: Record<string, unknown>): Promise<void> {
  const reqId = `pw-speed-${method}-${++rpcSeq}`
  await page.evaluate(
    async ({ method, payload, reqId }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      ws.send(JSON.stringify({ type: 'req', id: reqId, method, payload }))
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
    { method, payload, reqId },
  )
}

/** Start a real session, plus an optional `model`. */
async function startRealSession(page: Page, message: string, taskId: string, model?: string): Promise<void> {
  await rpc(page, 'session:start', { taskId, message, project: 'Walnut', ...(model ? { model } : {}) })
}

/** A quick first turn: the session exists (and has an id to seed a column with)
 *  before the measured turn starts. */
const WARM_UP = 'Speed readout warm-up'

/** Wait until the session's turn has ended (its CLI no longer runs), so the next
 *  send starts a turn of its own rather than landing inside this one. */
async function waitTurnEnded(request: APIRequestContext, sid: string): Promise<void> {
  await expect.poll(async () => {
    const res = await request.get(`/api/sessions/${sid}`)
    if (!res.ok()) return null
    return ((await res.json()) as { session?: { process_status?: string } }).session?.process_status ?? null
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).not.toBe('running')
}

/** Start the measured turn on a session the page already shows. The live window
 *  is the turn's ~9s, so it opens only once the panel is on screen: a turn begun
 *  before the page loaded was over on a loaded CI runner before the picker opened
 *  (2026-11-01: 7 of 7 CI runs read `data-live="false"` at the first look). */
async function sendSpeedTurn(page: Page, request: APIRequestContext, sid: string, message: string): Promise<void> {
  await waitTurnEnded(request, sid)
  await rpc(page, 'session:send', { sessionId: sid, message })
}

/** Session ids already on a task. Snapshot before a start so the wait below
 *  only accepts the session THIS test started. Not filtered by id shape: the
 *  server now hands the CLI a UUID via --session-id, so the mock's own
 *  `mock-session-*` ids no longer appear. */
/** A task of this test's own (titled by browser project), so two projects
 *  running against the one fixture server never start sessions on the same
 *  task: a second start on a task ends the first's CLI, which the readout now
 *  reports as a stopped turn. */
async function newTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', {
    data: { title: `${title} (${test.info().project.name})`, source: 'local', project: 'Walnut' },
  })
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

/** The one open model picker (it portals to <body>, so it is never inside a
 *  column). Exactly one is open at a time: openPicker closes any other first. */
const picker = (page: Page) => page.locator('.model-picker')
const readoutIn = (page: Page) => picker(page).getByTestId('session-speed-readout')

/** Open `col`'s model picker from its composer pill and wait for it. */
async function openPicker(page: Page, col: Locator): Promise<void> {
  await closePicker(page)
  await col.locator('.composer-model-pill').first().click()
  await expect(picker(page)).toHaveCount(1)
}

async function closePicker(page: Page): Promise<void> {
  if ((await picker(page).count()) === 0) return
  await picker(page).locator('.model-picker-close').click()
  await expect(picker(page)).toHaveCount(0)
}

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

/** Every slot's text in one read (picker open), for assertion messages and the report. */
async function readoutState(page: Page): Promise<Record<string, string | null>> {
  const r = readoutIn(page)
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

async function report(label: string, sid: string, page: Page): Promise<Record<string, string | null>> {
  const state = await readoutState(page)
  const logs = turnSpeedLogLines(sid)
  const text = `${label} ${sid}\nreadout: ${JSON.stringify(state)}\nserver:\n${logs.join('\n') || '(no "turn speed" line)'}`
  console.log(text)
  await test.info().attach(`${label}-readout`, { body: text, contentType: 'text/plain' })
  return state
}

/** Screenshot of the session strip (and the picker floating over it), into the
 *  test's own output dir. */
async function clipShot(page: Page, name: string): Promise<void> {
  const box = await page.locator('.main-page-sessions-area').boundingBox()
  expect(box, 'sessions area has a box').not.toBeNull()
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: box! })
}

/** The final-numbers contract, identical for both models (picker open). Returns tok/s. */
async function assertFinalReadout(page: Page, model: string): Promise<number> {
  const r = readoutIn(page)
  await expect(r).toHaveAttribute('data-live', 'false')
  await expect(r.getByTestId('speed-model')).toHaveText(model)
  // The CLI's own count, and the "~" of the interim estimate is gone.
  await expect(r.getByTestId('speed-tokens')).toHaveText('50 tok')
  await expect(r.getByTestId('speed-duration')).toHaveText('9.0s')
  // Cost lives in the picker's session cost line, not in the turn readout.
  await expect(r.getByTestId('speed-cost')).toHaveCount(0)
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
// The panel count is one value the whole fixture shares: hold it while this test runs.
holdPanelCountLock('test')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('two panels side by side show a live readout each, then final numbers', async ({ page, request }) => {
  await setPanelMode(page, '2')

  const TASK_A = await newTask(request, 'Speed readout A')
  const TASK_B = await newTask(request, 'Speed readout B')
  const beforeA = await sessionIdsFor(request, TASK_A)
  const beforeB = await sessionIdsFor(request, TASK_B)
  await startRealSession(page, WARM_UP, TASK_A, 'claude-opus-5-5')
  await startRealSession(page, WARM_UP, TASK_B, 'claude-sonnet-5-5')
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

  // Mid-stream: each panel's picker shows ITS OWN live row (the model it runs,
  // a first-token slot once the first delta landed). Each measured turn starts
  // right before its picker is read, so neither ~9s window is spent on loading.
  const liveIn = async (col: Locator) => {
    await openPicker(page, col)
    return readoutState(page)
  }
  for (const [col, sid, model, label] of [[colA, sidA, 'Opus 5.5', 'A'], [colB, sidB, 'Sonnet 5.5', 'B']] as const) {
    await sendSpeedTurn(page, request, sid, SPEED_MESSAGE)
    try {
      await expect.poll(async () => (await liveIn(col)).live, { timeout: 8_000, intervals: [100] }).toBe('true')
    } catch (err) {
      await report(`live-miss-${label}`, sid, page)
      throw err
    }
    const r = readoutIn(page)
    await expect(r).toBeVisible()
    await expect(r.getByTestId('speed-model')).toHaveText(model)
    await expect(r.getByTestId('speed-ttft')).toHaveText(/^first \d/, { timeout: 6_000 })
    await clipShot(page, `two-panels-live-${label}`)
    const live = await report(`live-${label}`, sid, page)
    expect(live.live, `${label} is live while its turn streams`).toBe('true')
  }

  // Final: both rows freeze on the turn's own numbers.
  await openPicker(page, colA)
  await expect(readoutIn(page)).toHaveAttribute('data-live', 'false', { timeout: 20_000 })
  await report('final-A', sidA, page)
  const tpsA = await assertFinalReadout(page, 'Opus 5.5')
  await clipShot(page, 'two-panels-final-A')
  await openPicker(page, colB)
  await expect(readoutIn(page)).toHaveAttribute('data-live', 'false', { timeout: 20_000 })
  await report('final-B', sidB, page)
  const tpsB = await assertFinalReadout(page, 'Sonnet 5.5')
  await clipShot(page, 'two-panels-final-B')
  test.info().annotations.push({ type: 'tok/s', description: `A (Opus 5.5) ${tpsA}, B (Sonnet 5.5) ${tpsB}` })
  console.log(`observed tok/s: A ${tpsA}, B ${tpsB}`)
  // Closed picker: no readout anywhere on the page (the row is not a panel fixture).
  await closePicker(page)
  await expect(page.getByTestId('session-speed-readout')).toHaveCount(0)
})

test('reload keeps the last turn\'s readout', async ({ page, request }) => {
  const TASK = await newTask(request, 'Speed readout reload')
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  const before = await sessionIdsFor(request, TASK)
  await startRealSession(page, SPEED_MESSAGE, TASK, 'claude-opus-5-5')
  const sid = await waitForNewSessionId(request, TASK, before)

  await seedColumns(page, [sid])
  await page.goto('/')
  const col = columnFor(page, sid)
  await expect(col).toHaveCount(1, { timeout: 30_000 })
  await openPicker(page, col)
  await expect(readoutIn(page)).toHaveAttribute('data-live', 'false', { timeout: 30_000 })
  await expect(readoutIn(page).getByTestId('speed-tokens')).toHaveText('50 tok')
  await closePicker(page)

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
  await expect(colAfter.locator('.composer-model-pill').first()).toBeVisible({ timeout: 30_000 })
  await openPicker(page, colAfter)
  const r = readoutIn(page)
  await expect(r).toBeVisible({ timeout: 30_000 })
  await expect(r).toHaveAttribute('data-live', 'false')
  await expect(r.getByTestId('speed-tokens')).toHaveText('50 tok')
  await expect(r.getByTestId('speed-model')).toHaveText('Opus 5.5')
  await report('after-reload', sid, page)
  await clipShot(page, 'after-reload')
})

test('a subagent on another model gets its own row under the main one, live then final', async ({ page, request }) => {
  const TASK = await newTask(request, 'Speed readout agent lane')
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  const before = await sessionIdsFor(request, TASK)
  // The agent variant of the speed turn: the tool is an Agent whose lane
  // answers as haiku (mock-claude.mjs `speed-agent`), with 300ms pauses so the
  // lane is still running when the picker opens.
  await startRealSession(page, WARM_UP, TASK, 'claude-opus-5-5')
  const sid = await waitForNewSessionId(request, TASK, before)

  await seedColumns(page, [sid])
  await page.goto('/')
  const col = columnFor(page, sid)
  await expect(col).toHaveCount(1, { timeout: 30_000 })
  await expect(col.locator('.composer-model-pill').first()).toBeVisible({ timeout: 30_000 })
  // The lane runs ~6s: its turn starts once the panel is on screen.
  await sendSpeedTurn(page, request, sid, 'chunk-delay:300 stream-partial-speed-agent')
  await openPicker(page, col)
  const lane = picker(page).getByTestId('speed-lane')
  // The lane row appears with the Agent call, under the main row, named by its model.
  await expect(lane).toHaveCount(1, { timeout: 30_000 })
  await expect(lane.getByTestId('speed-lane-model')).toHaveText('Haiku 5.5', { timeout: 30_000 })
  const mainBox = await readoutIn(page).boundingBox()
  const laneBox = await lane.boundingBox()
  expect(laneBox!.y).toBeGreaterThan(mainBox!.y)
  // Live: an estimate (~) and "running"; the main row still names the main model.
  await expect(lane.getByTestId('speed-lane-tokens')).toHaveText(/^~/)
  await expect(lane.getByTestId('speed-lane-status')).toHaveText('running')
  await expect(readoutIn(page).getByTestId('speed-model')).toHaveText('Opus 5.5')
  await clipShot(page, 'agent-lane-live')

  // Final: still an estimate (the CLI counts no agent), no status flag (done), a rate.
  await expect(readoutIn(page)).toHaveAttribute('data-live', 'false', { timeout: 60_000 })
  await expect(lane.getByTestId('speed-lane-tokens')).toHaveText(/^~\d+ tok$/)
  await expect(lane.getByTestId('speed-lane-status')).toHaveCount(0)
  await expect(lane.getByTestId('speed-lane-tps')).toHaveText(/^~\d+ tok\/s$/)
  await expect(lane.getByTestId('speed-lane-first')).toContainText('first')
  await expect(readoutIn(page).getByTestId('speed-tokens')).toHaveText('50 tok')
  await clipShot(page, 'agent-lane-final')
  await closePicker(page)

  // Cold load: the record carries the lane.
  await page.reload()
  const colAfter = columnFor(page, sid)
  await expect(colAfter.locator('.composer-model-pill').first()).toBeVisible({ timeout: 30_000 })
  await openPicker(page, colAfter)
  await expect(picker(page).getByTestId('speed-lane').getByTestId('speed-lane-tokens')).toHaveText(/^~\d+ tok$/, { timeout: 30_000 })
  await expect(picker(page).getByTestId('speed-lane').getByTestId('speed-lane-model')).toHaveText('Haiku 5.5')
})

// 2026-11-06: a turn began on Fable 5.1, the user switched to Opus in this
// picker while it ran, and the row kept naming Fable 5.1 alone for the whole
// turn (most of it on Opus) right under "Current: Opus 5.5". A switch applies
// from the turn's next model call: until then the row says which model takes
// over, and once it has, it names both, in order.
test('a model switched mid-turn: the row says it takes the next call, then names both models', async ({ page, request }) => {
  const TASK = await newTask(request, 'Speed readout mid-turn switch')
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  const before = await sessionIdsFor(request, TASK)
  await startRealSession(page, WARM_UP, TASK, 'claude-fable-5-1')
  const sid = await waitForNewSessionId(request, TASK, before)

  await seedColumns(page, [sid])
  await page.goto('/')
  const col = columnFor(page, sid)
  await expect(col.locator('.composer-model-pill').first()).toBeVisible({ timeout: 30_000 })
  // 500ms pauses: the first call takes ~2.5s, then a 10s tool run leaves room for the switch.
  await sendSpeedTurn(page, request, sid, 'chunk-delay:500 stream-partial-speed')
  await openPicker(page, col)
  const r = readoutIn(page)
  await expect(r.getByTestId('speed-tokens')).toHaveText('30 tok', { timeout: 30_000 })
  await expect(r).toHaveAttribute('data-live', 'true')
  await expect(r.getByTestId('speed-model')).toHaveText('Fable 5.1')
  await expect(r.getByTestId('speed-next-model')).toHaveCount(0)

  // The switch, through the picker's own row, while the tool runs.
  await picker(page).locator('.model-picker-col-models .model-picker-row')
    .filter({ has: page.locator('.model-picker-row-name', { hasText: /^Opus$/ }) }).click()
  await expect(picker(page)).toHaveCount(0)
  await openPicker(page, col)
  // Still the same turn, still all on Fable so far: the row says Opus takes the next call.
  await expect(r).toHaveAttribute('data-live', 'true')
  await expect(r.getByTestId('speed-model')).toHaveText('Fable 5.1')
  await expect(r.getByTestId('speed-next-model')).toHaveText(/^\u2192 Opus.* next call$/, { timeout: 10_000 })
  await clipShot(page, 'switch-pending')

  // The answer ran on Opus: the row names both models, in order, and the pending note is gone.
  await expect(r).toHaveAttribute('data-live', 'false', { timeout: 60_000 })
  await expect(r.getByTestId('speed-model')).toHaveText(/^Fable 5\.1 \u2192 Opus/)
  await expect(r.getByTestId('speed-next-model')).toHaveCount(0)
  await expect(r.getByTestId('speed-tokens')).toHaveText('50 tok')
  await clipShot(page, 'switch-final')
  await closePicker(page)

  // Cold load: the record keeps both.
  await page.reload()
  const colAfter = columnFor(page, sid)
  await expect(colAfter.locator('.composer-model-pill').first()).toBeVisible({ timeout: 30_000 })
  await openPicker(page, colAfter)
  await expect(readoutIn(page).getByTestId('speed-model')).toHaveText(/^Fable 5\.1 \u2192 Opus/, { timeout: 30_000 })
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
  // The picker renders its live strip for any live session; the readout row
  // under it only exists once a turn was measured, so here there is none.
  await expect(col.locator('.composer-model-pill').first()).toBeVisible({ timeout: 30_000 })
  await openPicker(page, col)
  await expect(picker(page).getByTestId('picker-live-strip')).toBeVisible()
  await expect(readoutIn(page)).toHaveCount(0)
})
