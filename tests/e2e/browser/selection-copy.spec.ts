/**
 * Playwright browser test: text selection survives streaming + auto-scroll.
 *
 * Reproduces the reported bugs:
 *   1. "I select lines 2-10 but the selection extends to the bottom" —
 *      auto-scroll writes scrollTop while the mouse is down, shifting content
 *      under the cursor so the browser extends the selection.
 *   2. "After selecting, the selection disappears" — two causes:
 *      a. The global mousedown handler called removeAllRanges() on EVERY
 *         mousedown (including right-click → context-menu Copy).
 *      b. Streaming deltas re-render the text block via innerHTML swap,
 *         destroying the selection's anchor nodes.
 *
 * Fixes under test:
 *   - main.tsx: mousedown clear is scoped (left-click only, not inside selection)
 *   - selection-guard.ts: auto-scroll paths pause while selecting
 *   - StreamingTextBlock/MemoizedTextBlock/StreamTextBlock: content freezes
 *     while a selection lives inside the block, catches up on clear.
 *
 * Harness: same WS-patch + history-mock approach as mid-stream-message.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-selection-copy';

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

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
}

/** Selected text (normalized whitespace) in the page. */
async function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim());
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                intercepted = true;
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                  }));
                }, 10);
              }
            } catch { /* non-JSON */ }
            if (!intercepted) origSend(data);
          };
        }
      }
    } as any;
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]; } catch { /* read-only */ }
      }
    }
  });
});

const baseMessages = [
  { role: 'user', text: 'Explain the design', timestamp: '2026-01-01T00:00:00.000Z' },
  {
    role: 'assistant',
    // Multi-line so a partial selection has lines above AND below it.
    text: [
      'Line one of the explanation.',
      'Line two SELECT-START anchor text here.',
      'Line three middle content for the range.',
      'Line four SELECT-END anchor text here.',
      'Line five below the selection.',
      'Line six even further below.',
    ].join('\n\n'),
    msgId: 'msg-base-1',
    timestamp: '2026-01-01T00:00:01.000Z',
  },
];

async function mockSession(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const url = new URL(route.request().url());
    const since = url.searchParams.get('since');
    if (since !== null) {
      return route.fulfill({ json: { messages: [], cursor: baseMessages.length, delta: true } });
    }
    return route.fulfill({ json: { messages: baseMessages, cursor: baseMessages.length, delta: false } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-selection',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Selection test session',
        },
      },
    });
  });
}

/** Drag-select from one locator to another; leaves the button HELD (callers
 *  release with page.mouse.up() after streaming more deltas mid-drag). */
async function dragSelect(page: Page, fromText: string, toText: string) {
  const from = page.locator('.session-history', { hasText: 'SELECT-START' }).getByText(fromText).first();
  const to = page.locator('.session-history').getByText(toText).first();
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox) throw new Error('selection anchors not visible');
  await page.mouse.move(fromBox.x + 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // Several small moves — realistic drag, gives the browser chances to extend.
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      fromBox.x + 2 + ((toBox.x + toBox.width - fromBox.x) * i) / steps,
      fromBox.y + fromBox.height / 2 + ((toBox.y + toBox.height / 2 - fromBox.y - fromBox.height / 2) * i) / steps,
    );
  }
}

test.describe('Selection & copy in session chat', () => {
  test('selection held during streaming does NOT extend to bottom and survives deltas', async ({ page }) => {
    await mockSession(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    // Start a streaming turn FIRST so the auto-scroll paths are hot.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Streaming tail begins. ', msgId: 'msg-stream-1' });
    await expect(page.locator('.session-history')).toContainText('Streaming tail begins.');

    // Drag a bounded selection over history lines 2→4, HOLD the button.
    await dragSelect(page, 'Line two SELECT-START anchor text here.', 'Line four SELECT-END anchor text here.');
    const heldSelection = await selectedText(page);
    expect(heldSelection).toContain('SELECT-START');
    expect(heldSelection).toContain('SELECT-END');

    // While the mouse is STILL DOWN, stream more deltas — each with a NEW
    // msgId so blocks.length grows and Path A-2's `scrollTop = scrollHeight`
    // write actually fires (same-msgId deltas only grow the same block, which
    // triggers no scroll path — the guard would be untested).
    for (let i = 0; i < 8; i++) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: `More streamed content chunk ${i}. `, msgId: `msg-stream-grow-${i}` });
      await page.waitForTimeout(60);
    }
    // Positive sentinel: the streamed tail really rendered (so the
    // not.toContain below can't pass vacuously on a broken stream).
    await expect(page.locator('.session-streaming-panel')).toContainText('More streamed content chunk 7');

    // Selection must still be bounded — not extended into the streamed tail.
    const midSelection = await selectedText(page);
    expect(midSelection).toContain('SELECT-START');
    expect(midSelection).toContain('SELECT-END');
    expect(midSelection).not.toContain('More streamed content chunk');
    expect(midSelection).not.toContain('below the selection');

    await page.mouse.up();

    // After release, more deltas arrive — the selection must SURVIVE them
    // (block content freezes while the selection lives inside it).
    for (let i = 8; i < 12; i++) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: `Post-release chunk ${i}. `, msgId: 'msg-stream-1' });
      await page.waitForTimeout(60);
    }
    const postSelection = await selectedText(page);
    expect(postSelection).toContain('SELECT-START');
    expect(postSelection).toContain('SELECT-END');
    expect(postSelection).not.toContain('Post-release chunk');

    // Clear the selection → auto-follow must RESUME (guards against a
    // regression where selectionActive() sticks true and kills follow-bottom
    // forever — the fix's biggest blast radius).
    await page.locator('.session-history').getByText('Line one of the explanation', { exact: false }).first().click();
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Resume-follow chunk. ', msgId: 'msg-resume-1' });
    await expect.poll(async () => page.evaluate(() => {
      const el = document.querySelector('.session-history') as HTMLElement | null;
      if (!el) return -1;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    }), { timeout: 5000 }).toBeLessThan(100);
  });

  test('selection inside a LIVE streaming block survives further deltas, then content catches up on clear', async ({ page }) => {
    await mockSession(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    // Stream a distinctive paragraph.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'UNIQUE-STREAM-PREFIX alpha bravo charlie.', msgId: 'msg-live-1' });
    const streamed = page.locator('.session-streaming-panel').getByText('UNIQUE-STREAM-PREFIX', { exact: false }).first();
    await expect(streamed).toBeVisible();

    // Select inside the LIVE block (triple-click selects the paragraph).
    await streamed.click({ clickCount: 3 });
    expect(await selectedText(page)).toContain('alpha bravo charlie');

    // More deltas hit the SAME block — innerHTML swap used to nuke the selection.
    for (let i = 0; i < 6; i++) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: ` delta-echo-${i}`, msgId: 'msg-live-1' });
      await page.waitForTimeout(50);
    }
    expect(await selectedText(page)).toContain('alpha bravo charlie');

    // Clear the selection (click a history line outside it) → frozen block
    // must catch up to the full streamed content.
    await page.locator('.session-history').getByText('Line one of the explanation', { exact: false }).first().click();
    await expect(page.locator('.session-streaming-panel')).toContainText('delta-echo-5');
  });

  test('right-click does NOT clear the selection (context-menu Copy path)', async ({ page }) => {
    await mockSession(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const line = page.locator('.session-history').getByText('Line three middle content', { exact: false }).first();
    await line.click({ clickCount: 3 });
    expect(await selectedText(page)).toContain('Line three middle content');

    // Right-click ON the selection — the old global mousedown handler cleared
    // it here, so context-menu "Copy" copied nothing. Selection surviving the
    // right-click IS the fix: the context menu copies whatever is selected.
    await line.click({ button: 'right' });
    expect(await selectedText(page)).toContain('Line three middle content');
  });

  test('left-click inside the selection does not clear it; outside does', async ({ page }) => {
    await mockSession(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const line = page.locator('.session-history').getByText('Line three middle content', { exact: false }).first();
    await line.click({ clickCount: 3 });
    expect(await selectedText(page)).toContain('Line three middle content');

    // mousedown INSIDE the selection: our handler must NOT clear it at
    // mousedown time (that's what breaks drag-of-selected-text and copy
    // affordances). Check at the held-down moment — the browser's own native
    // collapse happens later, at mouseup, which is out of our handler's hands.
    const box = await line.boundingBox();
    if (!box) throw new Error('selected line not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(await selectedText(page)).toContain('Line three middle content');
    await page.mouse.up();

    // Re-select, then click OUTSIDE the selection (another message) → clears
    // instantly (the macOS pink-flash guard, still working).
    await line.click({ clickCount: 3 });
    expect(await selectedText(page)).toContain('Line three middle content');
    await page.locator('.session-history').getByText('Line six even further below', { exact: false }).first().click();
    expect(await selectedText(page)).toBe('');
  });

  test('absorption (history twin arrives) defers while text is selected — selection survives turn end', async ({ page }) => {
    // The "select while generating, copy after it finishes" flow: at turn end
    // the persisted twin arrives and the render filter HIDES the streaming
    // block — unmounting the DOM the selection lives in. The hidden-set freeze
    // must defer that swap until the selection clears.
    const streamedText = 'ABSORB-TARGET delta echo foxtrot golf.';
    let turnDone = false;
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      const full = turnDone
        ? [...baseMessages, { role: 'assistant', text: streamedText, msgId: 'msg-absorb-1', timestamp: '2026-01-01T00:00:09.000Z' }]
        : baseMessages;
      if (since !== null) {
        const n = Number(since);
        return route.fulfill({ json: { messages: full.slice(n), cursor: full.length, delta: true } });
      }
      return route.fulfill({ json: { messages: full, cursor: full.length, delta: false } });
    });
    await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({
        json: {
          session: {
            claudeSessionId: SESSION_ID, taskId: 'pw-task-selection', project: 'Walnut',
            process_status: 'running', mode: 'bypass',
            startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(),
            messageCount: 2, title: 'Selection test session',
          },
        },
      });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    // Stream the block, then select inside it.
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: streamedText, msgId: 'msg-absorb-1' });
    const streamed = page.locator('.session-streaming-panel').getByText('ABSORB-TARGET', { exact: false }).first();
    await expect(streamed).toBeVisible();
    await streamed.click({ clickCount: 3 });
    expect(await selectedText(page)).toContain('delta echo foxtrot');

    // Turn ends; the twin lands in history and batch-completed triggers the
    // refetch that would normally hide (unmount) the streaming block.
    turnDone = true;
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false });
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });

    // The selection must survive the absorption window.
    await page.waitForTimeout(1500);
    expect(await selectedText(page)).toContain('delta echo foxtrot');

    // Clear the selection → the deferred swap completes → exactly ONE copy.
    await page.locator('.session-history').getByText('Line one of the explanation', { exact: false }).first().click();
    await expect.poll(async () => {
      const txt = (await page.locator('.session-history').textContent()) ?? '';
      return (txt.match(/ABSORB-TARGET/g) || []).length;
    }, { timeout: 8000 }).toBe(1);
  });
});
