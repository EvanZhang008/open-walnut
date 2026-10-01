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

  const TASK_A = await newTask(request, 'Speed readout A')
  const TASK_B = await newTask(request, 'Speed readout B')
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

  // Mid-stream: each panel's picker shows ITS OWN live row (the model it runs,
  // a first-token slot once the first delta landed). The two turns run for
  // ~9s, so both pickers can be opened in turn while both are live.
  const liveIn = async (col: Locator) => {
    await openPicker(page, col)
    return readoutState(page)
  }
  for (const [col, sid, model, label] of [[colA, sidA, 'Opus 5.5', 'A'], [colB, sidB, 'Sonnet 5.5', 'B']] as const) {
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
