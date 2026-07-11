/**
 * Playwright browser test: inline-subagent interleave must not corrupt main text.
 *
 * Reproduces inc-1783547185298 ("output completely broken"): new CLI builds
 * write the subagent's whole conversation into the MAIN session's stream with
 * parent_tool_use_id set. Before the fix, each interleaved subagent line cut
 * the main text accumulator mid-token — "**$0.10/c" | "luster/小时…" — and the
 * subagent's English narration rendered as main-conversation text in the
 * middle of the main reply.
 *
 * Asserts (real React components in a real browser):
 *   1. main text interrupted by a subagent text line stays ONE contiguous block
 *   2. subagent narration renders inside the Agent task-group, not as main text
 *   3. a subagent tool_use does not split main text either
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-normal-session';
const PARENT = 'toolu_pw_agent_parent';

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

async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-001',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 2,
          title: 'Subagent interleave repro',
        },
      },
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!(window as any).__capturedWs) {
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
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, data: { blocks: [], isStreaming: false } }),
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

test.describe('Inline-subagent interleave (main text integrity)', () => {
  test('subagent text + tool lines mid-turn do not split main text; narration lands in the task group', async ({ page }) => {
    const base = [
      { role: 'user', text: 'Analyze Outpost pricing', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Starting.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      if (url.searchParams.get('source') === 'streams') {
        return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
      if (since !== null) {
        return route.fulfill({ json: { messages: [], cursor: parseInt(since, 10), delta: true } });
      }
      return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const history = page.locator('.session-history');

    // ── Main turn starts; an Agent subagent is spawned (main-lane tool_use) ──
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Agent', toolUseId: PARENT,
      input: { description: 'explore pricing', subagent_type: 'explore', prompt: 'dig into it' },
    });
    await page.waitForTimeout(50);

    // ── Main text streams (same msgId) ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: '机架价格 **$0.10/c', msgId: 'msg_main' });
    await page.waitForTimeout(80);

    // ── Interleaved subagent lines arrive MID main-message ──
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Now I have the two distinct enums.', msgId: 'msg_sub', parentToolUseId: PARENT,
    });
    await page.waitForTimeout(50);
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'toolu_sub_bash', input: { command: 'grep enum' }, parentToolUseId: PARENT,
    });
    await page.waitForTimeout(50);

    // ── Main text continues (same msgId — must merge into the SAME block) ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'luster/小时** ≈ $73/月', msgId: 'msg_main' });
    await page.waitForTimeout(150);

    // 1. Main text is contiguous — the mid-token split is the bug signature.
    await expect(history).toContainText('$0.10/cluster/小时');
    // 2. Subagent narration is inside the task group body, not top-level.
    const taskGroup = page.locator('.task-group');
    await expect(taskGroup).toHaveCount(1);
    await expect(taskGroup.locator('.task-group-body')).toContainText('Now I have the two distinct enums.');
    // 3. Subagent Bash call is also inside the group.
    await expect(taskGroup.locator('.task-group-body')).toContainText('grep enum');
  });

  test('ORPHAN late subagent lines (no parent tool_call in blocks) render boxed, never flat', async ({ page }) => {
    // The background-subagent follow-up bug: the main turn ended, its blocks
    // (including the parent Agent tool_call) were promoted/cleared, then the
    // still-running subagent keeps streaming children. Before the fix these
    // rendered flat as main-conversation text ("subagent overflow").
    const base = [
      { role: 'user', text: 'Research in the background', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Spawned a background agent.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      if (url.searchParams.get('source') === 'streams') {
        return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
      }
      if (since !== null) {
        return route.fulfill({ json: { messages: [], cursor: parseInt(since, 10), delta: true } });
      }
      return route.fulfill({ json: { messages: base, cursor: base.length, delta: false } });
    });
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const history = page.locator('.session-history');

    // ── Late subagent children arrive with NO parent Agent tool_call block ──
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Late narration from the background agent.',
      msgId: 'msg_late_sub', parentToolUseId: PARENT,
      subagentType: 'explore', taskDescription: 'background research',
    });
    await page.waitForTimeout(50);
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Read', toolUseId: 'toolu_late_read',
      input: { file_path: '/tmp/pricing.md' }, parentToolUseId: PARENT,
      subagentType: 'explore', taskDescription: 'background research',
    });
    await page.waitForTimeout(150);

    // 1. An orphan task group is synthesized — children are boxed.
    const taskGroup = page.locator('.task-group');
    await expect(taskGroup).toHaveCount(1);
    await expect(taskGroup.locator('.task-group-body')).toContainText('Late narration from the background agent.');
    await expect(taskGroup.locator('.task-group-body')).toContainText('pricing.md');
    // 2. Group header carries the subagent identity from the children.
    await expect(taskGroup.locator('.task-group-agent-type')).toContainText('explore');
    await expect(taskGroup.locator('.task-group-description')).toContainText('background research');
    // 3. Narration must NOT appear as flat main-conversation text: with the
    //    task-group subtree removed, the history contains zero occurrences.
    const flatText = await history.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.task-group').forEach((n) => n.remove());
      return clone.textContent ?? '';
    });
    expect(flatText).not.toContain('Late narration');
    expect(flatText).not.toContain('pricing.md');
  });
});
