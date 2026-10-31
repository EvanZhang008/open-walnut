/**
 * Playwright browser test: Agent streaming text deduplication across multi-round tool calls.
 *
 * Verifies the fix for a bug where text from Round 1 was duplicated in Round 2
 * when the agent loop produced text → tool_call → text across multiple rounds.
 *
 * This test patches WebSocket before the page loads to capture the instance,
 * then injects fake server-push events to simulate multi-round agent streaming.
 * Finally, it asserts on the rendered DOM to verify no text duplication.
 *
 * Surface: the Notes page's Note Agent chat. The home page has no agent chat any
 * more (its chat slot became the Ask Walnut session view in 83766d0b0), and the
 * Note Agent is the chat that still renders `useChat` through ChatMessage.
 */
import { test, expect, type Page } from '@playwright/test'

const NOTE_AGENT_ID = 'note-agent'

/**
 * Inject a fake WS event by dispatching a MessageEvent on the captured WebSocket.
 */
async function injectEvent(page: import('@playwright/test').Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      if (!ws) throw new Error('No captured WebSocket — did addInitScript run?')
      const frame = JSON.stringify({ type: 'event', name, data, seq: Date.now() })
      ws.dispatchEvent(new MessageEvent('message', { data: frame }))
    },
    { name, data },
  )
}

/**
 * Inject several WS events in ONE task, as frames that arrive together do: no
 * animation frame runs between them, so text deltas are still buffered when the
 * next event is applied.
 */
async function injectEventsAtOnce(page: Page, events: Array<[string, unknown]>) {
  await page.evaluate((events) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    if (!ws) throw new Error('No captured WebSocket: did addInitScript run?')
    for (const [name, data] of events) {
      const frame = JSON.stringify({ type: 'event', name, data, seq: Date.now() })
      ws.dispatchEvent(new MessageEvent('message', { data: frame }))
    }
  }, events)
}

/**
 * Open the Note Agent chat the way a user does (Notes in the sidebar, then the
 * AI toggle) and wait until its history has been applied, so a late history
 * load cannot replace the injected turn. Returns the fields every real agent
 * stream event carries (src/web/routes/chat.ts), so `useChat` claims them.
 */
async function openNoteAgentChat(page: Page): Promise<Record<string, string>> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // Wait for WS to connect
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 5000 })

  await page.locator('a[href="/notes"]').first().click()
  // Whether the column is open is a synced UI pref, so the test before this one
  // may have left it open: close it first, so the click below opens a fresh one.
  const toggle = page.locator('.notes-ai-toggle')
  if ((await toggle.getAttribute('aria-pressed')) === 'true') {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  }
  // useChat asks for stats only after it has applied the history it read.
  const statsReq = page.waitForRequest((r) => {
    const url = new URL(r.url())
    return url.pathname === '/api/chat/stats'
      && url.searchParams.get('agentId') === NOTE_AGENT_ID
      && !!url.searchParams.get('conversationId')
  }, { timeout: 15_000 })
  await page.locator('.notes-ai-toggle').click()
  const conversationId = new URL((await statsReq).url()).searchParams.get('conversationId')!

  // The turn starts in an empty chat: nothing earlier can absorb its blocks.
  await expect(page.locator('.notes-chat-empty')).toBeVisible()
  await expect(page.locator('.notes-chat .chat-message')).toHaveCount(0)
  return { agentId: NOTE_AGENT_ID, conversationId, turnId: `pw-turn-${Date.now()}` }
}

// ── Setup: Patch WebSocket before each test ──

test.beforeEach(async ({ page }) => {
  // Patch WebSocket BEFORE the page loads to capture the instance
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          ;(window as any).__capturedWs = this
        }
      }
    } as any
    // Preserve static properties (CONNECTING, OPEN, CLOSING, CLOSED)
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try {
          (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]
        } catch { /* read-only */ }
      }
    }
  })
})

// ── Tests ──

test.describe('Agent streaming text deduplication', () => {
  test('multi-round tool call does not duplicate text in rendered chat', async ({ page }) => {
    const turn = await openNoteAgentChat(page)

    // Simulate a multi-round agent turn:
    // Round 1: text deltas → tool call → tool result
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'Let me check ' })
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'your tasks.' })
    await page.waitForTimeout(50)

    await injectEvent(page, 'agent:tool-call', {
      ...turn,
      toolName: 'task_query',
      input: { type: 'all' },
    })
    await injectEvent(page, 'agent:tool-result', {
      ...turn,
      toolName: 'task_query',
      result: 'Found 5 tasks',
    })
    await page.waitForTimeout(50)

    // Round 2: text deltas → final response
    // This is where the bug would cause "Let me check your tasks.You have 5 tasks."
    // instead of just "You have 5 tasks."
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'You have ' })
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: '5 tasks.' })
    await page.waitForTimeout(50)

    await injectEvent(page, 'agent:response', {
      ...turn,
      text: 'Let me check your tasks.You have 5 tasks.',
    })
    await page.waitForTimeout(300)

    // ── Assertions ──

    // One assistant message
    const assistantMsg = page.locator('.notes-chat .chat-message-assistant')
    await expect(assistantMsg).toHaveCount(1)

    // 2 text blocks + 1 tool block
    const textBlocks = assistantMsg.locator('.markdown-body')
    const toolBlocks = assistantMsg.locator('.chat-tool-block')
    await expect(toolBlocks).toHaveCount(1)
    await expect(textBlocks).toHaveCount(2)

    // CRITICAL: Round 1 text block must NOT contain Round 2 text
    const firstText = await textBlocks.nth(0).textContent()
    expect(firstText).toContain('Let me check your tasks.')
    expect(firstText).not.toContain('You have')

    // CRITICAL: Round 2 text block must NOT contain Round 1 text
    const secondText = await textBlocks.nth(1).textContent()
    expect(secondText).toContain('You have 5 tasks.')
    expect(secondText).not.toContain('Let me check')

    // No duplicate strings in full message text
    const fullText = await assistantMsg.textContent() ?? ''
    expect((fullText.match(/Let me check/g) || []).length).toBe(1)
    expect((fullText.match(/You have/g) || []).length).toBe(1)
  })

  test('single-round response without tool calls renders correctly', async ({ page }) => {
    const turn = await openNoteAgentChat(page)

    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'Hello! ' })
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'How can I help?' })
    await injectEvent(page, 'agent:response', { ...turn, text: 'Hello! How can I help?' })
    await page.waitForTimeout(200)

    const assistantMsg = page.locator('.notes-chat .chat-message-assistant')
    await expect(assistantMsg).toHaveCount(1)

    const textBlocks = assistantMsg.locator('.markdown-body')
    await expect(textBlocks).toHaveCount(1)

    const text = await textBlocks.textContent()
    expect(text).toContain('Hello! How can I help?')
  })

  test('three rounds with two tool calls have no text duplication', async ({ page }) => {
    const turn = await openNoteAgentChat(page)

    // Round 1: text + tool call 1
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'First, searching.' })
    await injectEvent(page, 'agent:tool-call', { ...turn, toolName: 'task_search', input: { query: 'test' } })
    await injectEvent(page, 'agent:tool-result', { ...turn, toolName: 'task_search', result: 'ok' })
    await page.waitForTimeout(30)

    // Round 2: text + tool call 2
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'Now, saving.' })
    await injectEvent(page, 'agent:tool-call', { ...turn, toolName: 'memory', input: {} })
    await injectEvent(page, 'agent:tool-result', { ...turn, toolName: 'memory', result: 'saved' })
    await page.waitForTimeout(30)

    // Round 3: final text + response
    await injectEvent(page, 'agent:text-delta', { ...turn, delta: 'All done!' })
    await injectEvent(page, 'agent:response', { ...turn, text: 'done' })
    await page.waitForTimeout(300)

    const assistantMsg = page.locator('.notes-chat .chat-message-assistant')
    await expect(assistantMsg).toHaveCount(1)

    const textBlocks = assistantMsg.locator('.markdown-body')
    const toolBlocks = assistantMsg.locator('.chat-tool-block')
    await expect(toolBlocks).toHaveCount(2)
    await expect(textBlocks).toHaveCount(3)

    // Verify no cross-round leakage
    const t1 = await textBlocks.nth(0).textContent()
    expect(t1).toContain('First, searching.')
    expect(t1).not.toContain('Now,')
    expect(t1).not.toContain('All done')

    const t2 = await textBlocks.nth(1).textContent()
    expect(t2).toContain('Now, saving.')
    expect(t2).not.toContain('First,')
    expect(t2).not.toContain('All done')

    const t3 = await textBlocks.nth(2).textContent()
    expect(t3).toContain('All done!')
    expect(t3).not.toContain('First,')
    expect(t3).not.toContain('Now,')
  })

  test('text still buffered when the tool call arrives stays in its own round', async ({ page }) => {
    const turn = await openNoteAgentChat(page)

    // The whole turn in one task: the text deltas wait for an animation frame
    // that never comes before the tool call is applied.
    await injectEventsAtOnce(page, [
      ['agent:text-delta', { ...turn, delta: 'Let me check ' }],
      ['agent:text-delta', { ...turn, delta: 'your tasks.' }],
      ['agent:tool-call', { ...turn, toolName: 'task_query', input: { type: 'all' } }],
      ['agent:tool-result', { ...turn, toolName: 'task_query', result: 'Found 5 tasks' }],
      ['agent:text-delta', { ...turn, delta: 'You have 5 tasks.' }],
      ['agent:response', { ...turn, text: 'Let me check your tasks.You have 5 tasks.' }],
    ])

    const assistantMsg = page.locator('.notes-chat .chat-message-assistant')
    await expect(assistantMsg).toHaveCount(1)
    const textBlocks = assistantMsg.locator('.markdown-body')
    await expect(assistantMsg.locator('.chat-tool-block')).toHaveCount(1)
    await expect(textBlocks).toHaveCount(2)
    await expect(textBlocks.nth(0)).toHaveText('Let me check your tasks.')
    await expect(textBlocks.nth(1)).toHaveText('You have 5 tasks.')

    // Round 1 text renders before its tool call, not after it.
    const order = await assistantMsg.evaluate((el) => {
      const text = el.querySelector('.markdown-body')!
      const tool = el.querySelector('.chat-tool-block')!
      return text.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING ? 'text-first' : 'tool-first'
    })
    expect(order).toBe('text-first')
  })
})
