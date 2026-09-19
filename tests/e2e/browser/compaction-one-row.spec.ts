/**
 * REAL-PIPELINE spec for "one compaction is one row" (reported 2026-09-18:
 * five identical "Compacting context..." rows above one "Context compacted 444K
 * tokens", collapsed behind an opaque "6 system messages").
 *
 * Runs the whole chain for real: session:start RPC → MockDaemon spawns the mock
 * CLI → the CLI's actual compaction line shapes (status{compacting} × 5 →
 * compact_boundary) → server SessionStreamBuffer → WS broadcast → reducer →
 * render, with history served by the REAL JSONL parser.
 *
 * Five status lines is what a real auto-compaction emits: the CLI re-emits that
 * status every 30s as a transport keep-alive and a real compaction runs 147-539s.
 * The spec spaces them 1s apart (`compaction-test:5:1000`) so the assertions land
 * WHILE the compaction is in flight — emitted in one burst the whole thing would be
 * over before the browser painted, and only the history parser would be tested.
 *
 * Pinned here:
 *   1. Mid-compaction: ONE placeholder row, no matter how many keep-alives landed.
 *   2. After the boundary: that row IS the outcome (the placeholder is gone), and
 *      the numbers are labelled at both ends so "444K" can't read as a percentage.
 *   3. A reload still says it once. (Which twin answers depends on what survives
 *      the reload: the server's stream snapshot, or the JSONL parser. Both apply
 *      the same rule, which is the point of sharing it; the parser's exact wording
 *      is pinned in tests/core/session-history.test.ts.)
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

const TASK_ID = 'pw-task-compaction'
const PRE = 'Context is nearly full'
const POST = 'Compaction done'

async function sendViaRpc(page: Page, method: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    async ({ method, payload }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      const id = `pw-compact-${Math.random().toString(36).slice(2)}`
      ws.send(JSON.stringify({ type: 'req', id, method, payload }))
      await new Promise<void>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'res' && parsed.id === id) resolve()
          } catch { /* ignore */ }
        }
        setTimeout(resolve, 3000)
      })
      ws.close()
    },
    { method, payload },
  )
}

/** The fixture task is seeded with NO sessions, so the first one to appear is the
 *  mock CLI's. Do NOT filter on a `mock-session-` prefix: Walnut pre-assigns the
 *  session id at spawn (`--session-id`), so the id is a plain uuid. */
async function waitForSessionId(request: APIRequestContext, taskId: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const res = await request.get(`/api/sessions/task/${taskId}`)
    if (res.ok()) {
      const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
      const sid = body.sessions?.[0]?.claudeSessionId
      if (sid) return sid
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no session appeared for task ${taskId}`)
}

function count(txt: string | null, needle: string): number {
  if (!txt) return 0
  return txt.split(needle).length - 1
}

test.describe('Compaction renders as ONE row (real mock-CLI pipeline)', () => {
  test('five keep-alives collapse into one row that becomes the labelled outcome', async ({ page, request }) => {
    test.setTimeout(120_000)

    // ONE turn, deliberately: a second FIFO turn would make this spec depend on
    // the mock CLI's between-turns stdin path, which is not what is under test.
    // The keep-alives are 1s apart instead, so the boundary lands ~7s in and the
    // panel is open long before the compaction finishes.
    await page.goto('/')
    await sendViaRpc(page, 'session:start', {
      taskId: TASK_ID, message: 'compaction-test:5:1000', project: 'Walnut',
    })
    const sid = await waitForSessionId(request, TASK_ID)

    await page.goto(`/sessions?id=${sid}`)
    const history = page.locator('.session-history')

    await expect(history).toContainText(PRE, { timeout: 25_000 })

    // (1) MID-COMPACTION — the reported bug's exact moment. However many
    // keep-alives have landed, there is exactly ONE placeholder row.
    await expect(history).toContainText('Compacting context', { timeout: 25_000 })
    await page.screenshot({ path: '/tmp/compaction-one-row/mid-compaction.png' })
    const placeholderSamples: number[] = []
    for (let i = 0; i < 12; i++) {
      placeholderSamples.push(count(await history.textContent(), 'Compacting context'))
      await page.waitForTimeout(200)
    }
    // MAX, not `every(n => n <= 1)`: a sample run that only ever saw 0 would mean
    // the loop straddled the boundary and this assertion proved nothing. Requiring
    // the peak to be exactly 1 fails BOTH the stacking bug and a vacuous pass.
    expect(
      Math.max(...placeholderSamples),
      `expected one placeholder throughout; samples were [${placeholderSamples.join(',')}]`,
    ).toBe(1)

    // (2) The boundary turns that row INTO the outcome — one row, no placeholder.
    await expect(history).toContainText('Context compacted', { timeout: 25_000 })
    await expect(history).toContainText(POST, { timeout: 25_000 })
    await expect.poll(async () => count(await history.textContent(), 'Context compacted'), {
      timeout: 20_000,
    }).toBe(1)
    await expect.poll(async () => count(await history.textContent(), 'Compacting context'), {
      timeout: 20_000,
    }).toBe(0)

    // The numbers say what they are, at both ends, and that it was automatic.
    await expect(history).toContainText('444K → 49K tokens')
    await expect(history).toContainText('· auto')
    // One row cannot form a collapsed run, so the opaque "N system messages"
    // toggle from the report must not be there either.
    expect(await history.textContent()).not.toContain('system messages')
    await page.screenshot({ path: '/tmp/compaction-one-row/live-one-row.png' })

    // (3) A reload must still show exactly one row with its numbers. Whether the
    // stream snapshot or the JSONL parser serves it, both run the shared rule.
    await page.reload()
    await expect(history).toContainText(POST, { timeout: 25_000 })
    await expect.poll(async () => count(await history.textContent(), 'Context compacted'), {
      timeout: 20_000,
    }).toBe(1)
    await expect(history).toContainText('444K → 49K tokens')
    expect(count(await history.textContent(), 'Compacting context')).toBe(0)
    await page.screenshot({ path: '/tmp/compaction-one-row/after-reload.png' })
  })
})
