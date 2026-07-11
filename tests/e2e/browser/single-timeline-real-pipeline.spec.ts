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
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

const MARKER = 'Hello, world!'

/** Start a real session via the session:start WS RPC from inside the page. */
async function startRealSession(page: Page, message: string, taskId: string): Promise<void> {
  await page.evaluate(
    async ({ message, taskId }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      ws.send(JSON.stringify({
        type: 'req', id: 'pw-start-1', method: 'session:start',
        payload: { taskId, message, project: 'Walnut' },
      }))
      await new Promise<void>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'res' && parsed.id === 'pw-start-1') resolve()
          } catch { /* ignore */ }
        }
        setTimeout(resolve, 3000)
      })
      ws.close()
    },
    { message, taskId },
  )
}

/** Poll the sessions REST list until the NEW mock-CLI session for taskId
 *  appears (seeded fixture sessions use pw-* ids; the mock CLI mints
 *  mock-session-*); return its id. */
async function waitForSessionId(request: APIRequestContext, taskId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`/api/sessions/task/${taskId}`)
    if (res.ok()) {
      const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
      const sid = body.sessions?.find((s) => s.claudeSessionId.startsWith('mock-session-'))?.claudeSessionId
      if (sid) return sid
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no mock session appeared for task ${taskId}`)
}

function countMarker(txt: string | null, marker: string = MARKER): number {
  if (!txt) return 0
  return txt.split(marker).length - 1
}

test.describe('Single-timeline REAL pipeline (mock CLI, real server events + history)', () => {
  test('A1: streamed turn survives its own boundary; exactly one copy at steady state', async ({ page, request }) => {
    // Kick off the streaming turn FIRST (chunk-delay stretches the stream to
    // ~2s), then open the session view while deltas are still arriving.
    await page.goto('/')
    await startRealSession(page, 'chunk-delay:250 stream-partial-thinking-then-text', 'pw-task-001')
    const sid = await waitForSessionId(request, 'pw-task-001')

    await page.goto(`/sessions?id=${sid}`)
    const history = page.locator('.session-history')

    // (i) Mid-turn: partial streamed text visible (subscribe snapshot + live deltas).
    await expect(history).toContainText('Hel', { timeout: 10_000 })
    await page.screenshot({ path: '/tmp/test-and-verify/a1-mid-stream.png' })

    // (ii) Continuity: from full-marker appearance through 3s past turn end,
    // the marker must NEVER disappear. The turn ends ~2s in; sample past it.
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
    // Delay (not mock) every history response: payload stays the REAL parser
    // output, only timing is faulted. This is the archive-lag fingerprint that
    // produced the original vanish incidents.
    await page.route('**/api/sessions/*/history**', async (route) => {
      await new Promise((r) => setTimeout(r, 2500))
      await route.fallback()
    })

    await page.goto('/')
    await startRealSession(page, 'chunk-delay:200 stream-partial-thinking-then-text', 'pw-task-in-progress')
    const sid = await waitForSessionId(request, 'pw-task-in-progress')

    await page.goto(`/sessions?id=${sid}`)
    const history = page.locator('.session-history')

    // Streamed text appears (stream events are NOT delayed — only history REST).
    await expect(history).toContainText(MARKER, { timeout: 10_000 })
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
