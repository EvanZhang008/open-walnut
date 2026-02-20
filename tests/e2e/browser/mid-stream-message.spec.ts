/**
 * Playwright browser test: Mid-stream user message persistence across turn boundaries.
 *
 * Reproduces the bug where a user sends a message while a session is streaming,
 * the message appears correctly in the timeline, but DISAPPEARS after the turn
 * completes (session:batch-completed fires).
 *
 * Root cause: After batch-completed, the useLayoutEffect fires onBatchCompleted
 * (promoting messages to 'committed') then immediately onClearCommitted (removing
 * committed messages). Since FIFO-injected user messages don't appear in JSONL
 * history, the message is gone from both optimistic state and persisted history.
 *
 * Test approach:
 *   - Patch WebSocket to capture the instance + auto-respond to RPCs
 *   - Mock session history API to control when messages.length grows
 *   - Inject streaming events to simulate a running session
 *   - Use real UI to send a message mid-stream (via chat input)
 *   - Inject turn-completion events (result, batch-completed)
 *   - Assert the user message is still visible after turn boundary
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-normal-session';

// ── Helpers ──

/** Inject a fake WS event by dispatching a MessageEvent on the captured WebSocket. */
async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as any).__capturedWs as WebSocket | undefined;
      if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
      const frame = JSON.stringify({ type: 'event', name, data, seq: Date.now() });
      ws.dispatchEvent(new MessageEvent('message', { data: frame }));
    },
    { name, data },
  );
}

/** Wait for WebSocket to be captured and connected */
async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
}

// ── Setup: Patch WebSocket before each test ──

test.beforeEach(async ({ page }) => {
  // Patch WebSocket BEFORE the page loads:
  // 1. Capture the WS instance
  // 2. Intercept outgoing RPCs and auto-respond to session:send + session:stream-subscribe
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);

        if (!(window as any).__capturedWs) {
          (window as any).__capturedWs = this;

          // Intercept outgoing messages to auto-respond to specific RPCs.
          // IMPORTANT: Do NOT forward session:send and session:stream-subscribe to the
          // real server — the test session doesn't exist on the server and the error
          // response would race with our auto-respond, removing optimistic messages.
          const origSend = this.send.bind(this);
          let mockMsgCounter = 0;
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req') {
                if (parsed.method === 'session:send') {
                  intercepted = true;
                  // Auto-respond with a messageId (don't forward to real server)
                  setTimeout(() => {
                    const response = JSON.stringify({
                      type: 'res',
                      id: parsed.id,
                      ok: true,
                      data: { messageId: 'mock-msg-' + (++mockMsgCounter) },
                    });
                    this.dispatchEvent(new MessageEvent('message', { data: response }));
                  }, 10);
                }

                if (parsed.method === 'session:stream-subscribe') {
                  intercepted = true;
                  // Auto-respond with empty snapshot (don't forward to real server)
                  setTimeout(() => {
                    const response = JSON.stringify({
                      type: 'res',
                      id: parsed.id,
                      ok: true,
                      data: { blocks: [], isStreaming: false },
                    });
                    this.dispatchEvent(new MessageEvent('message', { data: response }));
                  }, 10);
                }
              }
            } catch { /* non-JSON, ignore */ }

            // Forward everything else to the real server
            if (!intercepted) origSend(data);
          };
        }
      }
    } as any;

    // Preserve static properties
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try {
          (window.WebSocket as any)[key] = (OrigWebSocket as any)[key];
        } catch { /* read-only */ }
      }
    }
  });
});

// ── Tests ──

test.describe('Mid-stream user message persistence', () => {
  test('user message sent during streaming survives turn boundary (batch-completed)', async ({ page }) => {
    // ── Mock session history API ──
    // First fetches return 2 initial messages. After batch-completed triggers
    // a re-fetch, return 3 messages (assistant response added — simulating
    // the JSONL growing, but WITHOUT the user's FIFO-injected message).
    let historyFetchCount = 0;
    const baseMessages = [
      { role: 'user', text: 'Start working on the task', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Sure, let me work on that.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    const afterTurnMessages = [
      ...baseMessages,
      { role: 'assistant', text: 'I have completed the task.', timestamp: '2026-01-01T00:01:00.000Z' },
    ];

    await page.route(`**/api/sessions/${SESSION_ID}/history`, async (route) => {
      historyFetchCount++;
      if (historyFetchCount <= 1) {
        await route.fulfill({ json: { messages: baseMessages } });
      } else {
        // After batch-completed re-fetch: JSONL has grown (assistant response added)
        // but user's FIFO message is NOT in the JSONL
        await route.fulfill({ json: { messages: afterTurnMessages } });
      }
    });

    // Also mock the session detail API so the page renders the session
    await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      // Only intercept the session detail endpoint, not /history
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({
        json: {
          session: {
            claudeSessionId: SESSION_ID,
            taskId: 'pw-task-001',
            project: 'Walnut',
            process_status: 'running',
            work_status: 'in_progress',
            mode: 'bypass',
            startedAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: new Date().toISOString(),
            messageCount: 2,
            title: 'Test session',
          },
        },
      });
    });

    // Navigate to sessions page with our session selected
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);

    // Wait for session history to load
    await page.waitForSelector('.session-msg', { timeout: 5000 });

    // Verify initial state: 2 persisted messages
    const initialMsgCount = await page.locator('.session-msg').count();
    expect(initialMsgCount).toBe(2);

    // ── Step 1: Inject streaming blocks (simulate Claude working) ──
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID,
      delta: 'Let me analyze ',
      taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100); // Allow rAF to flush

    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID,
      delta: 'the code structure...',
      taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    // Inject a tool call (makes it more realistic — multiple blocks)
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID,
      toolName: 'Bash',
      toolUseId: 'tool_001',
      input: { command: 'ls -la' },
      taskId: 'pw-task-001',
    });
    await page.waitForTimeout(50);

    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID,
      toolUseId: 'tool_001',
      result: 'file1.ts\nfile2.ts',
      taskId: 'pw-task-001',
    });
    await page.waitForTimeout(50);

    // More streaming text after tool result
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID,
      delta: 'Found the relevant files.',
      taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    // Verify streaming blocks are visible
    const streamingPanel = page.locator('.session-streaming-panel');
    await expect(streamingPanel).toBeVisible({ timeout: 3000 });

    // ── Step 2: User sends a message mid-stream ──
    const chatInput = page.getByPlaceholder('Send a message to this session...');
    await chatInput.fill('Hey, also check the test files please');
    const sendBtn = page.locator('.session-chat-input-wrapper .chat-send-btn');
    await sendBtn.click();

    // Wait for the optimistic message to appear
    await page.waitForTimeout(300);

    // The RPC auto-responds with messageId → status transitions to 'received'
    // Now inject session:messages-delivered to transition to 'delivered'
    await injectEvent(page, 'session:messages-delivered', {
      sessionId: SESSION_ID,
      count: 1,
    });
    await page.waitForTimeout(200);

    // ── Step 3: Verify the user message is visible mid-stream ──
    // The user message should be in the streaming panel timeline
    const userMsgText = 'Hey, also check the test files please';
    const userMsgLocator = page.locator('.session-streaming-panel').getByText(userMsgText);
    await expect(userMsgLocator).toBeVisible({ timeout: 2000 });

    // Take screenshots for debugging
    await page.screenshot({ path: 'test-results/mid-stream-before.png' });

    // ── Step 4: Turn completes — inject result and batch-completed ──
    // This is where the bug manifests: the user message should survive but disappears

    // session:result → isStreaming = false
    await injectEvent(page, 'session:result', {
      sessionId: SESSION_ID,
      result: 'I have completed the task.',
      isError: false,
      taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    // session:batch-completed → triggers turn boundary logic
    await injectEvent(page, 'session:batch-completed', {
      sessionId: SESSION_ID,
      count: 1,
    });

    // Wait for history re-fetch + useLayoutEffect + timeout fallback (up to 1.5s)
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'test-results/mid-stream-after.png' });

    // ── Step 5: THE CRITICAL ASSERTION ──
    // The user's mid-stream message MUST still be visible after the turn completes.
    // BUG: Without the fix, the message vanishes here because:
    //   1. onBatchCompleted promotes to 'committed'
    //   2. onClearCommitted immediately removes committed messages
    //   3. JSONL doesn't contain the FIFO-injected user message
    //   4. Message is gone from both optimistic state and persisted history

    // Check the full session history area (includes both persisted and optimistic)
    const sessionHistory = page.locator('.session-history');
    const fullText = await sessionHistory.textContent();

    // The user's mid-stream message must still be somewhere in the session history
    expect(fullText).toContain(userMsgText);

    // More specific: find the exact user message element
    const userMsgAfter = sessionHistory.getByText(userMsgText);
    await expect(userMsgAfter).toBeVisible();

    // Also verify the persisted messages are still there
    expect(fullText).toContain('Start working on the task');
    expect(fullText).toContain('I have completed the task.');
  });

  test('multiple mid-stream messages all survive turn boundary', async ({ page }) => {
    // Same setup but with 2 messages sent during streaming
    let historyFetchCount = 0;
    const baseMessages = [
      { role: 'user', text: 'Begin', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Starting.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];

    await page.route(`**/api/sessions/${SESSION_ID}/history`, async (route) => {
      historyFetchCount++;
      if (historyFetchCount <= 1) {
        await route.fulfill({ json: { messages: baseMessages } });
      } else {
        await route.fulfill({
          json: {
            messages: [
              ...baseMessages,
              { role: 'assistant', text: 'Done with everything.', timestamp: '2026-01-01T00:02:00.000Z' },
            ],
          },
        });
      }
    });

    await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({
        json: {
          session: {
            claudeSessionId: SESSION_ID,
            taskId: 'pw-task-001',
            project: 'Walnut',
            process_status: 'running',
            work_status: 'in_progress',
            mode: 'bypass',
            startedAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: new Date().toISOString(),
            messageCount: 2,
            title: 'Test session',
          },
        },
      });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 5000 });

    // Start streaming
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Working on step 1...', taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    // Send first message mid-stream
    const chatInput = page.getByPlaceholder('Send a message to this session...');
    await chatInput.fill('First mid-stream message');
    await page.locator('.session-chat-input-wrapper .chat-send-btn').click();
    await page.waitForTimeout(200);

    // More streaming
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: ' Now step 2...', taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    // Send second message mid-stream
    await chatInput.fill('Second mid-stream message');
    await page.locator('.session-chat-input-wrapper .chat-send-btn').click();
    await page.waitForTimeout(200);

    // Deliver both
    await injectEvent(page, 'session:messages-delivered', {
      sessionId: SESSION_ID, count: 2,
    });
    await page.waitForTimeout(100);

    // Verify both messages visible during streaming
    const panel = page.locator('.session-streaming-panel');
    await expect(panel.getByText('First mid-stream message')).toBeVisible();
    await expect(panel.getByText('Second mid-stream message')).toBeVisible();

    // Turn completes
    await injectEvent(page, 'session:result', {
      sessionId: SESSION_ID, result: 'Done.', isError: false, taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    await injectEvent(page, 'session:batch-completed', {
      sessionId: SESSION_ID, count: 2,
    });
    await page.waitForTimeout(2000);

    // BOTH messages must survive
    const history = page.locator('.session-history');
    const fullText = await history.textContent();
    expect(fullText).toContain('First mid-stream message');
    expect(fullText).toContain('Second mid-stream message');
  });

  test('mid-stream message appears BEFORE assistant final response (position, not just survival)', async ({ page }) => {
    // This test reproduces the "messages move to bottom" bug:
    // User sends a message mid-stream → it appears correctly during streaming →
    // after the turn ends, the message jumps to BELOW the assistant's final response.
    //
    // The fix has two parts:
    // 1. Data layer: parseSessionMessages includes queue-operation entries as user messages
    //    at their correct chronological position in the JSONL
    // 2. UI layer: committed messages stay in the timeline (not a separate section)
    //
    // This test verifies the DATA LAYER fix: after history re-fetch, the persisted
    // messages include the user's mid-stream message at the correct position (before
    // the assistant's final response), and the DOM renders them in that order.

    let historyFetchCount = 0;

    // Initial history: just the opening exchange
    const baseMessages = [
      { role: 'user', text: 'Read 3 files with 5s sleep', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Starting file reads.', timestamp: '2026-01-01T00:00:01.000Z',
        tools: [{ name: 'Read', input: { file: 'f1.ts' } }] },
    ];

    // After turn completes: history includes the user's mid-stream message
    // at the CORRECT position (between assistant segments) — this simulates
    // what parseSessionMessages now produces from queue-operation entries.
    const afterTurnMessages = [
      ...baseMessages,
      // Assistant segment 2 (more work)
      { role: 'assistant', text: 'File 2 read.', timestamp: '2026-01-01T00:00:10.000Z',
        tools: [{ name: 'Read', input: { file: 'f2.ts' } }] },
      // User's FIFO-injected mid-stream message — CORRECTLY positioned via queue-operation parsing
      { role: 'user', text: 'check test files too', timestamp: '2026-01-01T00:00:15.000Z' },
      // Assistant's final response (AFTER the user's mid-stream message)
      { role: 'assistant', text: 'Stopping. Got your messages.', timestamp: '2026-01-01T00:00:20.000Z' },
    ];

    await page.route(`**/api/sessions/${SESSION_ID}/history`, async (route) => {
      historyFetchCount++;
      if (historyFetchCount <= 1) {
        await route.fulfill({ json: { messages: baseMessages } });
      } else {
        await route.fulfill({ json: { messages: afterTurnMessages } });
      }
    });

    await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({
        json: {
          session: {
            claudeSessionId: SESSION_ID,
            taskId: 'pw-task-001',
            project: 'Walnut',
            process_status: 'running',
            work_status: 'in_progress',
            mode: 'bypass',
            startedAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: new Date().toISOString(),
            messageCount: 2,
            title: 'Test session',
          },
        },
      });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 5000 });

    // ── Step 1: Simulate streaming ──
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Reading file 2...', taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Read', toolUseId: 'tool_002',
      input: { file: 'f2.ts' }, taskId: 'pw-task-001',
    });
    await page.waitForTimeout(50);

    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID, toolUseId: 'tool_002',
      result: 'contents of f2.ts', taskId: 'pw-task-001',
    });
    await page.waitForTimeout(50);

    // ── Step 2: User sends mid-stream message ──
    const chatInput = page.getByPlaceholder('Send a message to this session...');
    await chatInput.fill('check test files too');
    await page.locator('.session-chat-input-wrapper .chat-send-btn').click();
    await page.waitForTimeout(200);

    await injectEvent(page, 'session:messages-delivered', {
      sessionId: SESSION_ID, count: 1,
    });
    await page.waitForTimeout(100);

    // More streaming after the user's message
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Stopping. Got your messages.', taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    // ── Step 3: Turn completes ──
    await injectEvent(page, 'session:result', {
      sessionId: SESSION_ID, result: 'Stopping.', isError: false, taskId: 'pw-task-001',
    });
    await page.waitForTimeout(100);

    await injectEvent(page, 'session:batch-completed', {
      sessionId: SESSION_ID, count: 1,
    });

    // Wait for history re-fetch + layout effects
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'test-results/mid-stream-position-after.png' });

    // ── Step 4: THE CRITICAL POSITION ASSERTION ──
    // Get all visible message texts in DOM order.
    // The user's "check test files too" MUST appear BEFORE "Stopping. Got your messages."
    const sessionHistory = page.locator('.session-history');
    const fullText = await sessionHistory.textContent() ?? '';

    // Both messages must exist
    expect(fullText).toContain('check test files too');
    expect(fullText).toContain('Stopping. Got your messages.');

    // Position check: user's mid-stream message must come BEFORE assistant's final response
    const userMsgIndex = fullText.indexOf('check test files too');
    const assistantFinalIndex = fullText.indexOf('Stopping. Got your messages.');
    expect(userMsgIndex).toBeGreaterThan(-1);
    expect(assistantFinalIndex).toBeGreaterThan(-1);
    expect(userMsgIndex).toBeLessThan(assistantFinalIndex);
  });
});
