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
 * mid-turn) — and the rule's edge: reasoning belongs to the run only when a TOOL
 * follows it; reasoning that led to prose is its own row above the answer, the
 * way the persisted message renders it. Boundaries that still split a run
 * (prose, notices, an in-flight card, an Agent chip) are pinned in
 * ghost-run-merge.spec.ts.
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

async function startTool(page: Page, name: string, id: string): Promise<void> {
  await injectEvent(page, 'session:tool-use', {
    sessionId: SESSION_ID, toolName: name, toolUseId: id, input: TOOL_INPUTS[name](id),
  })
}

async function finishTool(page: Page, id: string): Promise<void> {
  await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: id, result: `${id} result` })
}

async function completedTool(page: Page, name: string, id: string): Promise<void> {
  await startTool(page, name, id)
  await finishTool(page, id)
}

async function think(page: Page, msgId: string, text: string): Promise<void> {
  await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: text, msgId })
}

/** One step as the CLI emits it: the reasoning and the call it led to arrive
 *  together, then the result. */
async function thinkThenTool(page: Page, msgId: string, text: string, name: string, id: string): Promise<void> {
  await injectEvents(page, [
    { name: 'session:thinking-delta', data: { sessionId: SESSION_ID, delta: text, msgId } },
    { name: 'session:tool-use', data: { sessionId: SESSION_ID, toolName: name, toolUseId: id, input: TOOL_INPUTS[name](id) } },
  ])
  await finishTool(page, id)
}

/** The kind of every direct child of an expanded run body, in DOM order. */
async function bodyOrder(run: Locator): Promise<string[]> {
  return run.locator(':scope > .tool-run-body > *').evaluateAll((nodes) => nodes.map((node) => {
    const el = node as HTMLElement
    if (el.classList.contains('tool-run-row')) return 'thinking'
    if (el.classList.contains('chat-tool-block')) return `tool:${el.querySelector('.chat-tool-block-name')?.textContent?.trim() ?? '?'}`
    return `other:${el.className}`
  }))
}

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
  test('a think/call/think/call turn is ONE run row, with the reasoning inside in order', async ({ page }) => {
    await mockSession(page, [{ role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' }])
    const panel = await openSession(page)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')

    // The reported zebra, block for block, each step's reasoning and call in
    // one task (the stream hook must land the reasoning first).
    await thinkThenTool(page, 'think_1', 'Which page documents this? Fetch it.', 'WebFetch', 'fetch_1')
    await thinkThenTool(page, 'think_2', 'That page points at a second one.', 'WebFetch', 'fetch_2')
    await thinkThenTool(page, 'think_3', 'Confirm locally, then read both remaining pages.', 'Bash', 'cmd_1')
    await completedTool(page, 'WebFetch', 'fetch_3')
    await completedTool(page, 'WebFetch', 'fetch_4')

    const streamRows = panel.locator('.session-streaming-panel > .session-msg-bare > .tool-run-row')
    await expect(streamRows).toHaveCount(1)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Fetched 4 pages, ran a command')
    // Nothing is a top-level "Thinking ›" row any more, and nothing pulses: the
    // turn's tail is a finished tool.
    await expect(panel.locator('.session-streaming-panel .tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)
    await expect(streamRows.locator('.tool-run-live-dot')).toHaveCount(0)
    await expect(streamRows.locator('.tool-run-body')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('zebra-collapsed.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })

    await streamRows.locator(':scope > .tool-run-toggle').click()
    expect(await bodyOrder(streamRows)).toEqual([
      'thinking', 'tool:WebFetch',
      'thinking', 'tool:WebFetch',
      'thinking', 'tool:Bash', 'tool:WebFetch', 'tool:WebFetch',
    ])
    const innerThinking = streamRows.locator('.tool-run-body .tool-run-row')
    await expect(innerThinking.locator('.tool-run-label')).toHaveText(['Thinking', 'Thinking', 'Thinking'])
    await innerThinking.nth(1).locator('.tool-run-toggle').click()
    await expect(innerThinking.nth(1).locator('.chat-thinking-content')).toHaveText('That page points at a second one.')
    await page.screenshot({ path: test.info().outputPath('zebra-expanded.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })
  })

  test('reasoning streaming into a run pulses the row; reasoning with no tool stays a Thinking row', async ({ page }) => {
    await mockSession(page, [{ role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' }])
    const panel = await openSession(page)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')
    const streamRows = panel.locator('.session-streaming-panel > .session-msg-bare > .tool-run-row')

    // Only reasoning so far: the familiar live "Thinking ›" row.
    await think(page, 'think_1', 'Let me look this up.')
    await expect(streamRows).toHaveCount(1)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Thinking')
    await expect(streamRows.locator('.tool-run-live-dot')).toHaveCount(1)

    // The call it leads to is in flight: a full card under the thinking row.
    await startTool(page, 'WebFetch', 'fetch_1')
    await expect(panel.locator('.session-streaming-panel .chat-tool-block')).toHaveCount(1)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Thinking')

    // Finished: the two become ONE run and the row reads as what it did.
    await finishTool(page, 'fetch_1')
    await expect(streamRows).toHaveCount(1)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Fetched a page')
    await expect(panel.locator('.session-streaming-panel .chat-tool-block')).toHaveCount(0)
    await expect(streamRows.locator('.tool-run-live-dot')).toHaveCount(0)

    // More reasoning streams INTO the run: same row, now pulsing.
    await think(page, 'think_2', 'Now compare with the second source.')
    await expect(streamRows).toHaveCount(1)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Fetched a page')
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-live-dot')).toHaveCount(1)
    await expect(panel.locator('.session-streaming-panel .tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)

    // The answer arrives: that reasoning led to PROSE, not to a tool, so it
    // leaves the run and stands above the answer — where the persisted message
    // will render it — and nothing pulses any more.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Both sources agree.', msgId: 'answer' })
    await expect(panel.locator('.session-streaming-panel')).toContainText('Both sources agree.')
    await expect(streamRows).toHaveCount(2)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText(['Fetched a page', 'Thinking'])
    await expect(streamRows.locator('.tool-run-live-dot')).toHaveCount(0)
    await streamRows.first().locator(':scope > .tool-run-toggle').click()
    expect(await bodyOrder(streamRows.first())).toEqual(['thinking', 'tool:WebFetch'])
    await streamRows.nth(1).locator(':scope > .tool-run-toggle').click()
    await expect(streamRows.nth(1).locator('.chat-thinking-content')).toHaveText('Now compare with the second source.')
    await page.screenshot({ path: test.info().outputPath('prose-splits-trailing-thinking.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })
  })

  test('a reader who opened live reasoning keeps it open when its tool folds it into a run', async ({ page }) => {
    await mockSession(page, [{ role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' }])
    const panel = await openSession(page)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')
    const streamRows = panel.locator('.session-streaming-panel > .session-msg-bare > .tool-run-row')

    await think(page, 'think_1', 'Reading the design before I act.')
    await streamRows.locator(':scope > .tool-run-toggle').click()
    await expect(streamRows.locator('.chat-thinking-content')).toHaveText('Reading the design before I act.')

    await completedTool(page, 'Bash', 'cmd_1')
    await expect(streamRows).toHaveCount(1)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Ran a command')
    // Still open: the body now lists the reasoning row and the command card.
    await expect(streamRows.locator(':scope > .tool-run-body')).toHaveCount(1)
    expect(await bodyOrder(streamRows)).toEqual(['thinking', 'tool:Bash'])
  })

  test('reasoning that led to the answer renders above it live AND after absorption', async ({ page }) => {
    const messages: Record<string, unknown>[] = [
      { role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' },
    ]
    await mockSession(page, messages)
    const panel = await openSession(page)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')

    await thinkThenTool(page, 'msg_a', 'Check the file first.', 'Read', 'read_a')
    await injectEvents(page, [
      { name: 'session:thinking-delta', data: { sessionId: SESSION_ID, delta: 'Now I can answer.', msgId: 'msg_b' } },
      { name: 'session:text-delta', data: { sessionId: SESSION_ID, delta: 'The file has it.', msgId: 'msg_b' } },
    ])
    const streamRows = panel.locator('.session-streaming-panel > .session-msg-bare > .tool-run-row')
    await expect(panel.locator('.session-streaming-panel')).toContainText('The file has it.')
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText(['Read a file', 'Thinking'])

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

    await expect(panel.locator('.session-streaming-panel .tool-run-row')).toHaveCount(0)
    const historyRows = panel.locator('.session-history .tool-run-row')
    await expect(historyRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText(['Read a file', 'Thinking'])
    await expect(panel.locator('.session-history')).toContainText('The file has it.')
    await page.screenshot({ path: test.info().outputPath('absorbed-same-shape.png'), clip: { x: 0, y: 0, width: 1200, height: 800 } })
  })

  test('reasoning that opens the live turn continues the persisted run at the boundary', async ({ page }) => {
    await mockSession(page, [{
      role: 'assistant', text: '', timestamp: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'Read', toolUseId: 'history_read', input: { file_path: '/tmp/history.txt' }, result: 'history content' }],
    }])
    const panel = await openSession(page)
    const rows = panel.locator('.tool-run-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Read a file')

    // Thinking is the first thing the stream carries: it joins the persisted run
    // (one row, now pulsing) instead of opening a "Thinking ›" row under it.
    await think(page, 'think_1', 'The file names a page; fetch it.')
    await expect(rows).toHaveCount(1)
    await expect(rows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Read a file')
    await expect(rows.locator(':scope > .tool-run-toggle > .tool-run-live-dot')).toHaveCount(1)

    await completedTool(page, 'WebFetch', 'fetch_1')
    await expect(rows).toHaveCount(1)
    await expect(rows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Read a file, fetched a page')
    await expect(rows.locator('.tool-run-live-dot')).toHaveCount(0)

    await rows.locator(':scope > .tool-run-toggle').click()
    await expect(rows.locator('.chat-tool-block')).toHaveCount(2)
    const innerThinking = rows.locator('.tool-run-body .tool-run-row')
    await expect(innerThinking).toHaveCount(1)
    await innerThinking.locator('.tool-run-toggle').click()
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
    await expect(panel.locator('.session-history')).toContainText('The API page has it.')

    const rows = panel.locator('.session-history .tool-run-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Fetched 2 pages')
    await expect(panel.locator('.session-history .tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(0)

    await rows.locator(':scope > .tool-run-toggle').click()
    await expect(rows.locator('.chat-tool-block')).toHaveCount(2)
    const innerThinking = rows.locator('.tool-run-body .tool-run-row')
    await expect(innerThinking.locator('.tool-run-label')).toHaveText(['Thinking', 'Thinking'])
    await innerThinking.first().locator('.tool-run-toggle').click()
    await expect(innerThinking.first().locator('.chat-thinking-content')).toHaveText('Start with the index page.')
  })

  test('a live zebra turn keeps its one row when history absorbs it', async ({ page }) => {
    const messages: Record<string, unknown>[] = [
      { role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' },
    ]
    await mockSession(page, messages)
    const panel = await openSession(page)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')

    await think(page, 'msg_a', 'Fetch the first page.')
    await completedTool(page, 'WebFetch', 'fetch_a')
    await think(page, 'msg_b', 'And the second.')
    await completedTool(page, 'WebFetch', 'fetch_b')
    const streamRows = panel.locator('.session-streaming-panel .tool-run-row')
    await expect(streamRows).toHaveCount(1)
    await expect(streamRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Fetched 2 pages')

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
    await expect(panel.locator('.session-streaming-panel .tool-run-row')).toHaveCount(0)
    const historyRows = panel.locator('.session-history .tool-run-row')
    await expect(historyRows).toHaveCount(1)
    await expect(historyRows.locator(':scope > .tool-run-toggle > .tool-run-label')).toHaveText('Fetched 2 pages')
    await historyRows.locator(':scope > .tool-run-toggle').click()
    await expect(historyRows.locator('.chat-tool-block')).toHaveCount(2)
    await expect(historyRows.locator('.tool-run-body .tool-run-label', { hasText: /^Thinking$/ })).toHaveCount(2)
  })
})
