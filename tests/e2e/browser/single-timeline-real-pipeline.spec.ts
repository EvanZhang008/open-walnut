/**
 * REAL-PIPELINE Playwright specs for the single-timeline model.
 *
 * Unlike the other streaming specs (which inject events into a captured
 * WebSocket and route-mock the history REST), these run the WHOLE pipeline
 * for real: session:start RPC → MockDaemon spawns the mock Claude CLI →
 * real stream_event JSONL → server SessionStreamBuffer → real WS broadcast →
 * useSessionStream reducer → render filter, with history served by the REAL
 * JSONL parser reading the daemon streams file.
 *
 * This closes the gap mocked specs can't: whether the REAL parser's
 * msgId/content shapes match the render filter's evidence keys end-to-end.
 *
 * Invariants pinned:
 *   1. NEVER VANISH — streamed text stays visible from first paint through
 *      turn end and beyond (revert = blocks deleted at result/batch-completed
 *      before history lands → text absent for the archive-lag window).
 *   2. EXACTLY ONE COPY at steady state — real history twin hides the block.
 *
 * The mock CLI's `chunk-delay:<ms>` prefix spaces out deltas so mid-turn
 * assertions don't race a synchronous burst.
 *
 * Each test starts on a task of its own: a task holds one session, so a start
 * on a fixture task that already has a conversation continues THAT session
 * (src/core/sessions/task-session-claim.ts) instead of making a new one. The
 * session opens the way a person opens it, from its task row on Home.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'

const MARKER = 'Hello, world!'

let rpcSeq = 0

/** A task of this test's own, titled by browser project and repeat so runs
 *  against the one fixture server never share a task. */
async function newTask(request: APIRequestContext, title: string): Promise<string> {
  const info = test.info()
  const res = await request.post('/api/tasks', {
    data: { title: `${title} (${info.project.name} #${info.repeatEachIndex})`, source: 'local', project: 'Walnut' },
  })
  expect(res.ok(), `create task: ${res.status()}`).toBe(true)
  const body = await res.json() as { task?: { id: string }; id?: string }
  return body.task?.id ?? body.id!
}

/** Start a real session via the session:start WS RPC from inside the page. A
 *  refused or unanswered start fails here, not later as a missing session. */
async function startRealSession(page: Page, message: string, taskId: string): Promise<void> {
  const reqId = `pw-start-${++rpcSeq}`
  const answer = await page.evaluate(
    async ({ message, taskId, reqId }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      ws.send(JSON.stringify({
        type: 'req', id: reqId, method: 'session:start',
        payload: { taskId, message, project: 'Walnut' },
      }))
      const result = await new Promise<string>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'res' && parsed.id === reqId) {
              resolve(parsed.ok ? 'ok' : `error: ${JSON.stringify(parsed.error)}`)
            }
          } catch { /* ignore */ }
        }
        setTimeout(() => resolve('no answer within 10s'), 10_000)
      })
      ws.close()
      return result
    },
    { message, taskId, reqId },
  )
  expect(answer, 'session:start answer').toBe('ok')
}

/** Poll until the task's session appears; return its id. The task is new, so
 *  its session is the one this test started. No id-shape filter: Walnut names
 *  a new session itself (`--session-id <uuid>`) and the CLI adopts that id. */
async function waitForSessionId(request: APIRequestContext, taskId: string): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const res = await request.get(`/api/sessions/task/${taskId}`)
    if (res.ok()) {
      const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
      const sid = body.sessions?.[0]?.claudeSessionId
      if (sid) return sid
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no session appeared for task ${taskId}`)
}

/** The task's row on Home, found through the task search. */
async function findTaskRow(page: Page, taskId: string): Promise<Locator> {
  await page.locator('.todo-search-input').fill(taskId)
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  return row
}

/** Open the session's home column from its task row and return its history.
 *  The row offers Start until the page has heard of the session (a click before
 *  that only selects the task). Scoped to this session's column: the Ask Walnut
 *  slot mounts a session panel of its own. */
async function openFromTaskRow(page: Page, row: Locator, sid: string): Promise<Locator> {
  await expect(row.locator('.task-start-btn')).toHaveCount(0, { timeout: 20_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel.locator('.session-history')
}

function countMarker(txt: string | null, marker: string = MARKER): number {
  if (!txt) return 0
  return txt.split(marker).length - 1
}

test.describe('Single-timeline REAL pipeline (mock CLI, real server events + history)', () => {
  test('A1: streamed turn survives its own boundary; exactly one copy at steady state', async ({ page, request }) => {
    test.setTimeout(90_000)
    const taskId = await newTask(request, 'Real pipeline A1')
    await page.goto('/')
    const row = await findTaskRow(page, taskId)
    // A task with no session offers Start: the wait in openFromTaskRow is real.
    await expect(row.locator('.task-start-btn')).toHaveCount(1)

    // Kick off the streaming turn FIRST (chunk-delay stretches the stream to
    // ~5s, longer than finding and clicking the row takes on a loaded machine),
    // then open the session view while deltas are still arriving.
    await startRealSession(page, 'chunk-delay:600 stream-partial-thinking-then-text', taskId)
    const sid = await waitForSessionId(request, taskId)
    const history = await openFromTaskRow(page, row, sid)

    // (i) Mid-turn: partial streamed text visible (subscribe snapshot + live deltas).
    await expect(history).toContainText('Hel', { timeout: 10_000 })
    await page.screenshot({ path: '/tmp/test-and-verify/a1-mid-stream.png' })

    // (ii) Continuity: from full-marker appearance through 3s past turn end,
    // the marker must NEVER disappear. The turn ends right after the marker
    // completes; sample past it.
    await expect(history).toContainText(MARKER, { timeout: 10_000 })
    const samples: number[] = []
    for (let i = 0; i < 30; i++) {
      samples.push(countMarker(await history.textContent()))
      await page.waitForTimeout(150)
    }
    expect(samples.every((c) => c >= 1), `marker vanished mid-race: [${samples.join(',')}]`).toBe(true)
    await page.screenshot({ path: '/tmp/test-and-verify/a1-post-result.png' })

    // (iii) Steady state: exactly ONE copy (history twin hid the stream block).
    await expect.poll(async () => countMarker(await history.textContent()), { timeout: 15_000 }).toBe(1)
    await page.screenshot({ path: '/tmp/test-and-verify/a1-steady-state.png' })
  })

  test('A2: history REST delayed 2.5s — no vanish window, one copy after it lands', async ({ page, request }) => {
    test.setTimeout(90_000)
    // Delay (not mock) every history response: payload stays the REAL parser
    // output, only timing is faulted. This is the archive-lag fingerprint that
    // produced the original vanish incidents.
    await page.route('**/api/sessions/*/history**', async (route) => {
      await new Promise((r) => setTimeout(r, 2500))
      await route.fallback()
    })

    const taskId = await newTask(request, 'Real pipeline A2')
    await page.goto('/')
    const row = await findTaskRow(page, taskId)
    await expect(row.locator('.task-start-btn')).toHaveCount(1)

    // ~9s of stream: long enough for the panel's first (delayed) history answer
    // to land while the turn still runs.
    await startRealSession(page, 'chunk-delay:1200 stream-partial-thinking-then-text', taskId)
    const sid = await waitForSessionId(request, taskId)
    let historyAnswers = 0
    page.on('response', (res) => { if (res.url().includes(`/api/sessions/${sid}/history`)) historyAnswers++ })
    const history = await openFromTaskRow(page, row, sid)

    // The window under test exists only when history first answered mid-turn:
    // then the turn-end refetch, 2.5s late, is the only history that can carry
    // the marker, and the streamed copy alone must hold it until then.
    await expect.poll(() => historyAnswers, { timeout: 20_000 }).toBeGreaterThan(0)
    expect(countMarker(await history.textContent()), 'the marker was complete before history first answered').toBe(0)

    // Streamed text appears (stream events are NOT delayed — only history REST).
    await expect(history).toContainText(MARKER, { timeout: 20_000 })
    await page.screenshot({ path: '/tmp/test-and-verify/a2-streaming.png' })

    // Through the turn end + the 2.5s history lag: never absent. The old code
    // deleted blocks at batch-completed/5s-fallback inside exactly this window.
    const samples: number[] = []
    for (let i = 0; i < 40; i++) {
      samples.push(countMarker(await history.textContent()))
      await page.waitForTimeout(150)
    }
    expect(samples.every((c) => c >= 1), `marker vanished during history lag: [${samples.join(',')}]`).toBe(true)
    await page.screenshot({ path: '/tmp/test-and-verify/a2-during-lag.png' })

    // After the delayed (real) history lands: exactly one copy.
    await expect.poll(async () => countMarker(await history.textContent()), { timeout: 15_000 }).toBe(1)
    await page.screenshot({ path: '/tmp/test-and-verify/a2-steady-state.png' })
  })
})
