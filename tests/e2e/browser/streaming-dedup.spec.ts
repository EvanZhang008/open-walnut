/**
 * Playwright browser test: Agent streaming text deduplication across multi-round tool calls.
 *
 * Verifies the fix for a bug where text from Round 1 was duplicated in Round 2
 * when the agent loop produced text → tool_call → text across multiple rounds.
 *
 * This test patches WebSocket before the page loads to capture the instance,
 * then injects fake server-push events to simulate multi-round agent streaming.
 * Finally, it asserts on the rendered DOM to verify no text duplication.
 */
import { test, expect } from '@playwright/test'

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

// ── Setup: Patch WebSocket before each test ──

test.beforeEach(async ({ page }) => {
  // Patch WebSocket BEFORE the page loads to capture the instance
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        // Store the first WS connection (the app's main connection)
        if (!(window as any).__capturedWs) {
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
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Wait for WS to connect
    await page.waitForFunction(() => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      return ws && ws.readyState === WebSocket.OPEN
    }, null, { timeout: 5000 })

    // Simulate a multi-round agent turn:
    // Round 1: text deltas → tool call → tool result
    await injectEvent(page, 'agent:text-delta', { delta: 'Let me check ' })
    await injectEvent(page, 'agent:text-delta', { delta: 'your tasks.' })
    await page.waitForTimeout(50)

    await injectEvent(page, 'agent:tool-call', {
      toolName: 'query_tasks',
      input: { type: 'all' },
    })
    await injectEvent(page, 'agent:tool-result', {
      toolName: 'query_tasks',
      result: 'Found 5 tasks',
    })
    await page.waitForTimeout(50)

    // Round 2: text deltas → final response
    // This is where the bug would cause "Let me check your tasks.You have 5 tasks."
    // instead of just "You have 5 tasks."
    await injectEvent(page, 'agent:text-delta', { delta: 'You have ' })
    await injectEvent(page, 'agent:text-delta', { delta: '5 tasks.' })
    await page.waitForTimeout(50)

    await injectEvent(page, 'agent:response', {
      text: 'Let me check your tasks.You have 5 tasks.',
    })
    await page.waitForTimeout(300)

    // ── Assertions ──

    // One assistant message
    const assistantMsg = page.locator('.chat-message-assistant')
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
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForFunction(() => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      return ws && ws.readyState === WebSocket.OPEN
    }, null, { timeout: 5000 })

    await injectEvent(page, 'agent:text-delta', { delta: 'Hello! ' })
    await injectEvent(page, 'agent:text-delta', { delta: 'How can I help?' })
    await injectEvent(page, 'agent:response', { text: 'Hello! How can I help?' })
    await page.waitForTimeout(200)

    const assistantMsg = page.locator('.chat-message-assistant')
    await expect(assistantMsg).toHaveCount(1)

    const textBlocks = assistantMsg.locator('.markdown-body')
    await expect(textBlocks).toHaveCount(1)

    const text = await textBlocks.textContent()
    expect(text).toContain('Hello! How can I help?')
  })

  test('three rounds with two tool calls have no text duplication', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForFunction(() => {
      const ws = (window as any).__capturedWs as WebSocket | undefined
      return ws && ws.readyState === WebSocket.OPEN
    }, null, { timeout: 5000 })

    // Round 1: text + tool call 1
    await injectEvent(page, 'agent:text-delta', { delta: 'First, searching.' })
    await injectEvent(page, 'agent:tool-call', { toolName: 'search', input: { query: 'test' } })
    await injectEvent(page, 'agent:tool-result', { toolName: 'search', result: 'ok' })
    await page.waitForTimeout(30)

    // Round 2: text + tool call 2
    await injectEvent(page, 'agent:text-delta', { delta: 'Now, saving.' })
    await injectEvent(page, 'agent:tool-call', { toolName: 'memory', input: {} })
    await injectEvent(page, 'agent:tool-result', { toolName: 'memory', result: 'saved' })
    await page.waitForTimeout(30)

    // Round 3: final text + response
    await injectEvent(page, 'agent:text-delta', { delta: 'All done!' })
    await injectEvent(page, 'agent:response', { text: 'done' })
    await page.waitForTimeout(300)

    const assistantMsg = page.locator('.chat-message-assistant')
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
})
