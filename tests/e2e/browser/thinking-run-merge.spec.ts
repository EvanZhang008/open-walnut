/**
 * Reasoning rides the tool run it belongs to.
 *
 * The CLI streams a step's thinking and the call it leads to as SEPARATE blocks,
 * so a turn that thinks before every call used to render one zebra row per step
 * ("Thinking › / Fetched a page › / Thinking › / Fetched a page › …", 2026-09-15
 * report) while the persisted twin of the same turn was already ONE
 * "Fetched 2 pages ›" row. These specs pin the rule on every surface that folds
 * rows: the live stream, the history/stream boundary run, and persisted history
 * that happens to carry thinking-only messages (a half-written message read
 * mid-turn). Since 2026-10-04 the run also keeps the reasoning that led to the
 * prose after it, and a call still in flight is inside the closed run (the row
 * breathes) instead of a full card under it: the reader asked for one closed
 * line whatever arrives. Boundaries that still split a run (prose, notices, an
 * Agent chip) are pinned in ghost-run-merge.spec.ts.
 *
 * Since 2026-11-12 every step of a turn before its answer is ONE fold row, the
 * turn's (`[data-testid="turn-fold"]`, "Working · Ran 5 tools" while it runs),
 * closed by default and breathing while the turn runs. The run is no line of its
 * own any more: opened, the fold's body holds the run flat (`.tool-run-flat`),
 * its calls and its reasoning as rows, in order. What these specs guard is the
 * same: reasoning rides the run and is never a "Thinking ›" row of its own
 * beside it, no zebra, one row whatever arrives, and the row (and its open
 * state) stays when history takes the turn.
 *
 * Events that the CLI writes as ONE assistant line (a step's thinking and its
 * tool_use) are dispatched inside ONE page.evaluate, so they land in the same JS
 * task the way they do over the real socket — the ordering the stream hook has
 * to get right cannot be reproduced one CDP round trip at a time.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-thinking-run-session'

async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs
      if (!ws) throw new Error('No captured WebSocket')
      ws.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }),
      }))
    },
    { name, data },
  )
}

/** Several events in ONE JS task (what one assistant line looks like on the wire). */
async function injectEvents(page: Page, events: Array<{ name: string; data: unknown }>): Promise<void> {
  await page.evaluate((events) => {
    const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs
    if (!ws) throw new Error('No captured WebSocket')
    for (const { name, data } of events) {
      ws.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }),
      }))
    }
  }, events)
}

async function waitForWs(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs
    return ws?.readyState === WebSocket.OPEN
  }, null, { timeout: 10_000 })
}

async function mockSession(page: Page, messages: Record<string, unknown>[]): Promise<void> {
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({ json: { messages, cursor: messages.length, delta: false } })
  })
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-thinking-run',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: messages.length,
          title: 'Thinking run fixture',
        },
      },
    })
  })
}

async function openSession(page: Page): Promise<Locator> {
  await page.addInitScript((id) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]))
  }, SESSION_ID)
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await waitForWs(page)
  return panel
}

const TOOL_INPUTS: Record<string, (id: string) => Record<string, string>> = {
  WebFetch: (id) => ({ url: `https://docs.example.invalid/${id}` }),
  Read: (id) => ({ file_path: `/tmp/${id}.txt` }),
  Bash: (id) => ({ command: `printf ${id}` }),
}

async function startTool(page: Page, name: string, id: string, msgId?: string): Promise<void> {
  await injectEvent(page, 'session:tool-use', {
    sessionId: SESSION_ID, toolName: name, toolUseId: id, input: TOOL_INPUTS[name](id), ...(msgId ? { msgId } : {}),
  })
}

async function finishTool(page: Page, id: string): Promise<void> {
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: id, result: `${id} result` })
}

/** A call and its result. `msgId` is the API message the CLI streams it under, which
 *  its saved row carries too (the turn fold's key comes from the first step's). */
async function completedTool(page: Page, name: string, id: string, msgId?: string): Promise<void> {
  await startTool(page, name, id, msgId)
  await finishTool(page, id)
}

async function think(page: Page, msgId: string, text: string): Promise<void> {
  await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: text, msgId })
}

/** One step as the CLI emits it: the reasoning and the call it led to arrive
 *  together (one API message, one msgId), then the result. */
async function thinkThenTool(page: Page, msgId: string, text: string, name: string, id: string): Promise<void> {
  await injectEvents(page, [
    { name: 'session:thinking-delta', data: { sessionId: SESSION_ID, delta: text, msgId } },
    { name: 'session:tool-use', data: { sessionId: SESSION_ID, toolName: name, toolUseId: id, input: TOOL_INPUTS[name](id), msgId } },
  ])
  await finishTool(page, id)
}

/** The turn's one fold row (every step before the answer, 2026-11-12). */
const turnFold = (scope: Locator) => scope.locator('[data-testid="turn-fold"]')
/** The fold's own line: its phrase ("Ran 5 tools"), after the lead ("Working"). */
const foldLabel = (scope: Locator) => turnFold(scope).locator(':scope > .tool-run-toggle > .tool-run-label')
const foldLead = (scope: Locator) => turnFold(scope).locator(':scope > .tool-run-toggle > [data-testid="turn-fold-lead"]')

/** The turn's fold, opened, and its body. */
async function openTurn(scope: Locator): Promise<Locator> {
  const fold = turnFold(scope).last()
  await expect(fold).toHaveCount(1)
  if ((await fold.getAttribute('data-open')) !== 'true') await fold.locator(':scope > .tool-run-toggle').click()
  await expect(fold).toHaveAttribute('data-open', 'true')
  return fold.locator(':scope > .process-fold-body')
}
/** Inside the opened fold a run is no line of its own: its calls and reasoning are rows (flat). */
const runsIn = (body: Locator) => body.locator(':scope > .session-msg-bare > .tool-run-row.tool-run-flat')
/** Every reasoning row under `scope`, in a run or beside one. */
const thinkingIn = (scope: Locator) => scope.locator('.tool-run-row--step', { has: scope.page().locator(':scope > .tool-run-toggle > .tool-run-label', { hasText: /^Thinking$/ }) })
const callsOf = (scope: Locator) => scope.locator('.chat-tool-block')

/** The kind of every row of a flat run (a reasoning row or a call), in DOM order. A
 *  saved run wraps each message's rows in a box of their own; the rows are the same. */
async function runOrder(run: Locator): Promise<string[]> {
  return run.evaluate((root) => {
    const sel = '.tool-run-row--step, .chat-tool-block'
    return Array.from(root.querySelectorAll<HTMLElement>(sel))
      .filter((el) => el.parentElement?.closest(sel) === null || !root.contains(el.parentElement!.closest(sel)))
      .map((el) => {
        if (el.classList.contains('chat-tool-block')) return `tool:${el.querySelector('.chat-tool-block-name')?.textContent?.trim() ?? '?'}`
        const label = el.querySelector(':scope > .tool-run-toggle > .tool-run-label')?.textContent
        return label === 'Thinking' ? 'thinking' : `other:${label ?? el.className}`
      })
  })
}

/** A turn a person started: the live turn follows their words. With no input after
 *  "Parent turn." the stream would be that turn going on, and its words would fold
 *  into the live fold as words on the way (SessionChatHistory answerGoesOn). */
const PARENT: Record<string, unknown>[] = [
  { role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'user', text: 'Look it up.', timestamp: '2026-01-01T00:00:00.500Z' },
]

test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        if (socketUrl.pathname !== '/ws' || (window as Window & { __capturedWs?: WebSocket }).__capturedWs) return

        ;(window as Window & { __capturedWs?: WebSocket }).__capturedWs = this
        const originalSend = this.send.bind(this)
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          let intercepted = false
          try {
            const request = JSON.parse(data as string) as { type?: string; id?: string; method?: string }
            if (request.type === 'req' && request.method === 'session:stream-subscribe') {
              intercepted = true
              setTimeout(() => {
                this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                }))
              }, 10)
            }
          } catch { /* non-JSON WebSocket data */ }
          if (!intercepted) originalSend(data)
        }
      }
    } as typeof WebSocket

    for (const key of Object.getOwnPropertyNames(OriginalWebSocket)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] = (OriginalWebSocket as unknown as Record<string, unknown>)[key]
      } catch { /* read-only static */ }
    }
  })
})

test.describe('Reasoning folds into the tool run around it', () => {
  test('a think/call/think/call turn is ONE row, with the reasoning inside the run in order', async ({ page }) => {
    await mockSession(page, PARENT)
    const panel = await openSession(page)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')

    // The reported zebra, block for block, each step's reasoning and call in
    // one task (the stream hook must land the reasoning first).
    await thinkThenTool(page, 'think_1', 'Which page documents this? Fetch it.', 'WebFetch', 'fetch_1')
    await thinkThenTool(page, 'think_2', 'That page points at a second one.', 'WebFetch', 'fetch_2')
    await thinkThenTool(page, 'think_3', 'Confirm locally, then read both remaining pages.', 'Bash', 'cmd_1')
    await completedTool(page, 'WebFetch', 'fetch_3')
    await completedTool(page, 'WebFetch', 'fetch_4')

    // One closed row for the whole turn: the turn's fold, breathing while it runs
    // (was: one closed "Fetched 4 pages, ran a command" run row, still once its
    // tail call was done; the fold now says the turn runs, not one call).
    const history = panel.locator('.session-history')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLead(history)).toHaveText(/^Working/)
    await expect(foldLabel(history)).toHaveText('Ran 5 tools')
    await expect(turnFold(history)).toHaveAttribute('data-open', 'false')
    await expect(turnFold(history)).toHaveAttribute('data-running', 'true')
    // Nothing is a top-level "Thinking ›" row, and nothing of the run is drawn.
    await expect(history.locator('.tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)
    await expect(history.locator('.process-fold-body, .tool-run-body, .chat-tool-block')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('zebra-collapsed.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })

    // Opened: ONE run, flat, the reasoning in order between its calls.
    const body = await openTurn(history)
    const runs = runsIn(body)
    await expect(runs).toHaveCount(1)
    // The person's words start the turn, so the earlier answer is not in its fold.
    await expect(body.locator('[data-testid="folded-words"]')).toHaveCount(0)
    expect(await runOrder(runs)).toEqual([
      'thinking', 'tool:WebFetch',
      'thinking', 'tool:WebFetch',
      'thinking', 'tool:Bash', 'tool:WebFetch', 'tool:WebFetch',
    ])
    const innerThinking = thinkingIn(runs)
    await expect(innerThinking).toHaveCount(3)
    await innerThinking.nth(1).locator(':scope > .tool-run-toggle').click()
    await expect(innerThinking.nth(1).locator('.chat-thinking-content')).toHaveText('That page points at a second one.')
    await page.screenshot({ path: test.info().outputPath('zebra-expanded.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })
  })

  test('reasoning and a running call stay in the one closed row; the reasoning before the answer stays in it', async ({ page }) => {
    await mockSession(page, PARENT)
    const panel = await openSession(page)
    const history = panel.locator('.session-history')
    await expect(history).toContainText('Parent turn.')

    // Only reasoning so far: the turn's fold, "Working" with no count, and nothing under
    // its line (was: the thought as a live line under it; 2026-11-14 the user: "Even not
    // showing the currently working command, below collpes, if people need people cna click intop").
    await think(page, 'think_1', 'Let me look this up.')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLead(history)).toHaveText(/^Working/)
    await expect(foldLabel(history)).toHaveCount(0)
    await expect(turnFold(history)).toHaveAttribute('data-running', 'true')
    await expect(turnFold(history).locator(':scope > :not(.tool-run-toggle)')).toHaveCount(0)
    await expect(history).not.toContainText('Let me look this up.')

    // The call it leads to is in flight: it joins the closed row at once (no card
    // opens under it) and the row breathes while it runs.
    await startTool(page, 'WebFetch', 'fetch_1')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    await expect(history.locator('.chat-tool-block')).toHaveCount(0)
    await expect(turnFold(history)).toHaveAttribute('data-running', 'true')
    await page.screenshot({ path: test.info().outputPath('running-call-closed.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })
    // Opened, the running call is there and says so.
    const opened = await openTurn(history)
    await expect(opened.locator('.chat-tool-block-calling')).toHaveCount(1)
    await turnFold(history).locator(':scope > .tool-run-toggle').click()
    await expect(turnFold(history)).toHaveAttribute('data-open', 'false')

    // Finished: the same closed row, still the turn's (it breathes until the turn ends).
    await finishTool(page, 'fetch_1')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    await expect(history.locator('.chat-tool-block')).toHaveCount(0)

    // More reasoning streams INTO it: same row, no "Thinking ›" row beside it.
    await think(page, 'think_2', 'Now compare with the second source.')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    await expect(turnFold(history)).toHaveAttribute('data-running', 'true')
    await expect(history.locator('.tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)

    // The answer arrives: that reasoning led to PROSE, and it stays in the fold
    // rather than splitting off as a "Thinking ›" row of its own.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Both sources agree.', msgId: 'answer' })
    await expect(panel.locator('[data-stream-reply]', { hasText: 'Both sources agree.' })).toHaveCount(1)
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    await expect(history.locator('.tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)
    const runs = runsIn(await openTurn(history))
    await expect(runs).toHaveCount(1)
    expect(await runOrder(runs)).toEqual(['thinking', 'tool:WebFetch', 'thinking'])
    await page.screenshot({ path: test.info().outputPath('prose-keeps-trailing-thinking.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })
  })

  test('a reader who opened live reasoning keeps it open when its tool joins it', async ({ page }) => {
    await mockSession(page, PARENT)
    const panel = await openSession(page)
    const history = panel.locator('.session-history')
    await expect(history).toContainText('Parent turn.')

    // The reader opens the turn, then the reasoning in it.
    await think(page, 'think_1', 'Reading the design before I act.')
    const body = await openTurn(history)
    const thought = thinkingIn(body)
    await expect(thought).toHaveCount(1)
    await thought.locator(':scope > .tool-run-toggle').click()
    await expect(thought.locator('.chat-thinking-content')).toHaveText('Reading the design before I act.')

    await completedTool(page, 'Bash', 'cmd_1')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    // Still open: the fold, and the reasoning now in the run, before the command.
    await expect(turnFold(history)).toHaveAttribute('data-open', 'true')
    const runs = runsIn(body)
    await expect(runs).toHaveCount(1)
    expect(await runOrder(runs)).toEqual(['thinking', 'tool:Bash'])
    await expect(thinkingIn(runs).locator('.chat-thinking-content')).toHaveText('Reading the design before I act.')
  })

  test('reasoning that led to the answer rides the fold live AND after absorption', async ({ page }) => {
    const messages: Record<string, unknown>[] = [...PARENT]
    await mockSession(page, messages)
    const panel = await openSession(page)
    const history = panel.locator('.session-history')
    await expect(history).toContainText('Parent turn.')

    await thinkThenTool(page, 'msg_a', 'Check the file first.', 'Read', 'read_a')
    await injectEvents(page, [
      { name: 'session:thinking-delta', data: { sessionId: SESSION_ID, delta: 'Now I can answer.', msgId: 'msg_b' } },
      { name: 'session:text-delta', data: { sessionId: SESSION_ID, delta: 'The file has it.', msgId: 'msg_b' } },
    ])
    await expect(panel.locator('[data-stream-reply]', { hasText: 'The file has it.' })).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    const liveBody = await openTurn(history)
    const liveThinking = await thinkingIn(liveBody).count()
    expect(liveThinking).toBe(2)
    await expect(callsOf(liveBody)).toHaveCount(1)

    // The parser attaches each step's reasoning to the message of its block.
    messages.push(
      {
        role: 'assistant', text: '', thinking: 'Check the file first.', msgId: 'msg_a', timestamp: '2026-01-01T00:00:01.000Z',
        tools: [{ name: 'Read', toolUseId: 'read_a', input: TOOL_INPUTS.Read('read_a'), result: 'read_a result' }],
      },
      { role: 'assistant', text: 'The file has it.', thinking: 'Now I can answer.', msgId: 'msg_b', timestamp: '2026-01-01T00:00:02.000Z' },
    )
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 })
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false })

    await expect(panel.locator('[data-stream-reply]')).toHaveCount(0)
    // The answer's own reasoning (msg_b) rides the fold before it, as it did live,
    // and the turn the reader watched keeps the shape it streamed in (2026-11-01:
    // "no flash, no change"): one row, the same line. The reader opened it live, so
    // it is still open (the fold's key is the first step's message, msg_a).
    await expect(turnFold(history)).toHaveCount(1)
    await expect(turnFold(history)).not.toHaveAttribute('data-running', 'true')
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    await expect(turnFold(history)).toHaveAttribute('data-open', 'true')
    await expect(history.locator('.markdown-body p', { hasText: 'The file has it.' })).toHaveCount(1)
    // Its body: both pieces of reasoning around the call, as live.
    const savedBody = turnFold(history).locator(':scope > .process-fold-body')
    const innerThinking = thinkingIn(savedBody)
    await expect(innerThinking).toHaveCount(liveThinking)
    await expect(callsOf(savedBody)).toHaveCount(1)
    await innerThinking.last().locator(':scope > .tool-run-toggle').click()
    await expect(innerThinking.last().locator('.chat-thinking-content')).toHaveText('Now I can answer.')
    await page.screenshot({ path: test.info().outputPath('absorbed-same-shape.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })
  })

  test('reasoning that opens the live turn continues the persisted run at the boundary', async ({ page }) => {
    await mockSession(page, [{
      role: 'assistant', text: '', timestamp: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'Read', toolUseId: 'history_read', input: { file_path: '/tmp/history.txt' }, result: 'history content' }],
    }])
    const panel = await openSession(page)
    const history = panel.locator('.session-history')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')

    // Thinking is the first thing the stream carries: it joins the persisted turn
    // (one row, now breathing) instead of opening a "Thinking ›" row under it.
    await think(page, 'think_1', 'The file names a page; fetch it.')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 1 tool')
    await expect(turnFold(history)).toHaveAttribute('data-running', 'true')
    await expect(history.locator('.tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)

    await completedTool(page, 'WebFetch', 'fetch_1')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 2 tools')

    // Opened: ONE run, the saved call and the live one, the reasoning between them.
    const runs = runsIn(await openTurn(history))
    await expect(runs).toHaveCount(1)
    expect(await runOrder(runs)).toEqual(['tool:Read', 'thinking', 'tool:WebFetch'])
    const innerThinking = thinkingIn(runs)
    await innerThinking.locator(':scope > .tool-run-toggle').click()
    await expect(innerThinking.locator('.chat-thinking-content')).toHaveText('The file names a page; fetch it.')
  })

  test('history read mid-turn: thinking-only messages between tool-only ones fold into the run', async ({ page }) => {
    await mockSession(page, [
      { role: 'user', text: 'Check the docs.', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: '', thinking: 'Start with the index page.', timestamp: '2026-01-01T00:00:01.000Z' },
      {
        role: 'assistant', text: '', timestamp: '2026-01-01T00:00:02.000Z',
        tools: [{ name: 'WebFetch', toolUseId: 'h_fetch_1', input: { url: 'https://docs.example.invalid/index' }, result: 'index' }],
      },
      { role: 'assistant', text: '', thinking: 'It links to the API page.', timestamp: '2026-01-01T00:00:03.000Z' },
      {
        role: 'assistant', text: '', timestamp: '2026-01-01T00:00:04.000Z',
        tools: [{ name: 'WebFetch', toolUseId: 'h_fetch_2', input: { url: 'https://docs.example.invalid/api' }, result: 'api' }],
      },
      { role: 'assistant', text: 'The API page has it.', timestamp: '2026-01-01T00:00:05.000Z' },
    ])
    const panel = await openSession(page)
    const history = panel.locator('.session-history')
    await expect(history).toContainText('The API page has it.')

    // The person's message starts the turn: "Worked for 5s · Ran 2 tools".
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLead(history)).toHaveText(/^Worked for 5s/)
    await expect(foldLabel(history)).toHaveText('Ran 2 tools')
    await expect(history.locator('.tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)

    const runs = runsIn(await openTurn(history))
    await expect(runs).toHaveCount(1)
    expect(await runOrder(runs)).toEqual(['thinking', 'tool:WebFetch', 'thinking', 'tool:WebFetch'])
    const innerThinking = thinkingIn(runs)
    await innerThinking.first().locator(':scope > .tool-run-toggle').click()
    await expect(innerThinking.first().locator('.chat-thinking-content')).toHaveText('Start with the index page.')
  })

  test('a live zebra turn keeps its one row when history absorbs it', async ({ page }) => {
    const messages: Record<string, unknown>[] = [...PARENT]
    await mockSession(page, messages)
    const panel = await openSession(page)
    const history = panel.locator('.session-history')
    await expect(history).toContainText('Parent turn.')

    await think(page, 'msg_a', 'Fetch the first page.')
    await completedTool(page, 'WebFetch', 'fetch_a', 'msg_a')
    await think(page, 'msg_b', 'And the second.')
    await completedTool(page, 'WebFetch', 'fetch_b', 'msg_b')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 2 tools')

    // The parser merges each step's reasoning into the message of its call.
    messages.push(
      {
        role: 'assistant', text: '', thinking: 'Fetch the first page.', msgId: 'msg_a', timestamp: '2026-01-01T00:00:01.000Z',
        tools: [{ name: 'WebFetch', toolUseId: 'fetch_a', input: TOOL_INPUTS.WebFetch('fetch_a'), result: 'fetch_a result' }],
      },
      {
        role: 'assistant', text: '', thinking: 'And the second.', msgId: 'msg_b', timestamp: '2026-01-01T00:00:02.000Z',
        tools: [{ name: 'WebFetch', toolUseId: 'fetch_b', input: TOOL_INPUTS.WebFetch('fetch_b'), result: 'fetch_b result' }],
      },
    )
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 })
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false })

    // Same count, same words, now drawn from history.
    await expect(turnFold(history)).not.toHaveAttribute('data-running', 'true')
    await expect(turnFold(history)).toHaveCount(1)
    await expect(foldLabel(history)).toHaveText('Ran 2 tools')
    const runs = runsIn(await openTurn(history))
    await expect(runs).toHaveCount(1)
    expect(await runOrder(runs)).toEqual(['thinking', 'tool:WebFetch', 'thinking', 'tool:WebFetch'])
  })
})
