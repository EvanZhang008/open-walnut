/**
 * Playwright browser test: subagents live in the Background ledger, not in the
 * main conversation (the Claude Code model).
 *
 * History of this spec: inc-1783547185298 ("output completely broken") — new
 * CLI builds write the subagent's whole conversation into the MAIN session's
 * stream with parent_tool_use_id set, and each interleaved line used to cut
 * the main text accumulator mid-token. The lane-isolation fix boxed the lane
 * under the Agent card; then the 2026-09-08 report showed the box itself was
 * the problem: once history absorbed the Agent tool_call the still-running
 * lane re-boxed at the TAIL, so the user saw the same agent twice (a ✓ card
 * where it was spawned and a live "60 tools" box at the bottom) and could not
 * tell which was current.
 *
 * The shape now (Claude Code desktop parity): the chat shows ONE chip per spawn
 * burst (`● Agent  explore  opus  <title>  Running  16 tools`; a burst of several
 * reads `3 agents … 2 running · 1 done`), never a card per agent, never an in-place
 * dropdown; the chip and the pinned Background bar both open the two-column
 * Background tasks panel (agents on the left, the selected agent's transcript on
 * the right). The reader draws the transcript with the MAIN chat's rows: finished
 * tools fold into one "Ran N commands ›" run, a tool still executing is the
 * in-flight card, and a running lane ends in the "… is working…" indicator.
 *
 * Asserts (real React components in a real browser):
 *   1. main text interrupted by a subagent text line stays ONE contiguous block
 *   2. the chip is the only trace of the agent in the chat; its narration is on
 *      screen only inside the panel
 *   3. late lane lines with no anchor in the stream render NOWHERE (no box,
 *      no flat text)
 *   4. the pic-1 shape — Agent row already in history + live lane blocks —
 *      shows exactly ONE chip; the pinned Background bar is one line whose click
 *      opens the same panel (no caret, no in-place list)
 *   5. three parallel spawns are one `3 agents … 3 running` chip; the panel lists
 *      all three and switches the reader on click
 *   6. the panel survives the turn end: history absorbs the Agent tool_calls, the
 *      streaming chip is replaced by the history chip, and the open panel stays
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

async function mockHistory(page: Page, base: unknown[]) {
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

test.describe('Inline-subagent interleave (main text integrity)', () => {
  test('subagent text + tool lines mid-turn do not split main text; the chat shows one chip and the panel holds the narration', async ({ page }) => {
    const base = [
      { role: 'user', text: 'Analyze Outpost pricing', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Starting.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    await mockHistory(page, base);
    await mockSessionDetail(page);
    await page.route(`**/api/sessions/${SESSION_ID}/workflow`, (route) => route.fulfill({ status: 204, body: '' }));

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
    // 2. ONE chip, no card, no dropdown: the subagent's conversation is not
    //    main-conversation content, so nothing of it is on screen.
    const chip = history.locator('.bg-tasks-chip');
    await expect(chip).toHaveCount(1);
    // The chip carries what the old per-agent card carried: type, title, state.
    await expect(chip.locator('.bg-tasks-chip-label')).toHaveText('Agent');
    await expect(chip.locator('.task-group-agent-type')).toHaveText('explore');
    await expect(chip.locator('.bg-tasks-chip-desc')).toHaveText('explore pricing');
    await expect(chip.locator('.bg-tasks-chip-status')).toHaveText('Running');
    await expect(chip.locator('.task-group-streaming-dot')).toHaveCount(1);
    await expect(history.locator('.task-group')).toHaveCount(0);
    await expect(history.locator('.task-group-chevron')).toHaveCount(0);
    await expect(history).not.toContainText('Now I have the two distinct enums.');
    await expect(history).not.toContainText('grep enum');
    // 3. The chip opens the Background tasks panel: the agent listed on the left
    //    (selected), its live lane on the right. Nothing unfolds in the chat.
    await chip.click();
    const panel = page.locator('.wf-modal--tasks');
    await expect(panel).toHaveCount(1);
    await expect(panel.locator('.wf-modal-title')).toHaveText('Background tasks');
    const rows = panel.locator('.bg-task-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveClass(/bg-task-row--selected/);
    await expect(rows.first().locator('.bg-task-row-name')).toHaveText('explore pricing');
    await expect(panel.locator('.bg-tasks-section')).toHaveText(['Running']);
    await expect(panel.locator('.bg-tasks-detail-title')).toHaveText('explore pricing');
    const detail = panel.locator('.bg-tasks-detail');
    await expect(detail).toContainText('Now I have the two distinct enums.');
    await expect(detail).toContainText('grep enum');
    // The reader uses the main chat's rows: the still-running Bash is the
    // in-flight card (never folded into a run), and the live lane ends in the
    // working indicator, named after the agent.
    await expect(detail.locator('.chat-tool-block-calling')).toHaveCount(1);
    await expect(detail.locator('.chat-tool-block-calling .chat-tool-block-calling-dot')).toHaveCount(1);
    await expect(detail.locator('.tool-run-row')).toHaveCount(0);
    await expect(detail.locator('.session-working-indicator')).toHaveCount(1);
    await expect(detail.locator('.session-working-label')).toHaveText('explore agent is working…');
    // Two more commands finish: the reader folds them into ONE "Ran 2 commands ›"
    // run (same merge the main chat applies), the in-flight one stays a card.
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'toolu_sub_bash_2', input: { command: 'ls src' }, parentToolUseId: PARENT,
    });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'toolu_sub_bash_2', result: 'a.ts' });
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'toolu_sub_bash_3', input: { command: 'cat a.ts' }, parentToolUseId: PARENT,
    });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'toolu_sub_bash_3', result: 'export {}' });
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Read', toolUseId: 'toolu_sub_read', input: { file_path: '/tmp/x.md' }, parentToolUseId: PARENT,
    });
    await expect(detail.locator('.tool-run-row .tool-run-label')).toHaveText(['Ran 2 commands']);
    await expect(detail).not.toContainText('ls src');
    await detail.locator('.tool-run-toggle').click();
    await expect(detail).toContainText('ls src');
    await expect(detail).toContainText('cat a.ts');
    await expect(history).not.toContainText('Now I have the two distinct enums.');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('late subagent lines with NO anchor in the stream render nowhere: no box, no flat text', async ({ page }) => {
    // The background-subagent follow-up: the main turn ended, its blocks
    // (including the parent Agent tool_call) were promoted/cleared, then the
    // still-running subagent keeps streaming children. First they rendered
    // flat ("subagent overflow"), then as an anonymous box at the tail. Now
    // the lane is consumed whole: the ledger + panel own the run.
    const base = [
      { role: 'user', text: 'Research in the background', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Spawned a background agent.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    await mockHistory(page, base);
    await mockSessionDetail(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const history = page.locator('.session-history');

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

    await expect(page.locator('.task-group')).toHaveCount(0);
    await expect(page.locator('.bg-tasks-chip')).toHaveCount(0);
    await expect(history).not.toContainText('Late narration');
    await expect(history).not.toContainText('pricing.md');
    // The conversation itself is intact.
    await expect(history).toContainText('Spawned a background agent.');
  });

  test('pic-1 shape: Agent row in history + live lane → ONE chip, the ledger carries the run, both open the panel', async ({ page }) => {
    const AGENT_ID = 'a1b2c3d4e5f60718';
    const base = [
      { role: 'user', text: 'Also check the other insights', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        role: 'assistant',
        text: 'Dispatched an agent to check the other insights; here are the three points.',
        timestamp: '2026-01-01T00:00:01.000Z',
        msgId: 'msg_launch',
        tools: [{
          name: 'Agent', toolUseId: PARENT, agentId: AGENT_ID,
          input: { description: 'Find other insights needing audit log', subagent_type: 'explore', model: 'opus', run_in_background: true },
          result: `Async agent launched successfully. agentId: ${AGENT_ID}`,
        }],
      },
    ];
    await mockHistory(page, base);
    await mockSessionDetail(page);
    // The ledger's persisted-manifest fallback and the transcript endpoint.
    await page.route(`**/api/sessions/${SESSION_ID}/workflow`, (route) => route.fulfill({ status: 204, body: '' }));
    await page.route(`**/api/sessions/${SESSION_ID}/subagent/${AGENT_ID}/history**`, (route) => route.fulfill({
      json: { messages: [{ role: 'assistant', text: 'Transcript line from the running agent.', timestamp: '2026-01-01T00:00:02.000Z' }] },
    }));

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const history = page.locator('.session-history');
    const chip = history.locator('.bg-tasks-chip');
    await expect(chip).toHaveCount(1);
    await expect(history.locator('.task-group')).toHaveCount(0);

    // The stream still holds the Agent tool_call twin (turn ended, buffer
    // retained) and the agent keeps working: 60 lane tool calls.
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Agent', toolUseId: PARENT,
      input: { description: 'Find other insights needing audit log', subagent_type: 'explore', model: 'opus', run_in_background: true },
    });
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: PARENT, result: `agentId: ${AGENT_ID}` });
    for (let i = 0; i < 60; i++) {
      await injectEvent(page, 'session:tool-use', {
        sessionId: SESSION_ID, toolName: 'Bash', toolUseId: `toolu_lane_${i}`,
        input: { command: `probe ${i}` }, parentToolUseId: PARENT,
        subagentType: 'explore', taskDescription: 'Find other insights needing audit log',
      });
    }
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Lane narration that must stay off the main conversation.',
      msgId: 'msg_lane', parentToolUseId: PARENT, subagentType: 'explore',
    });
    await page.waitForTimeout(200);

    // Exactly one chip — the history one — and no live twin at the tail.
    await expect(chip).toHaveCount(1);
    await expect(history.locator('.task-group')).toHaveCount(0);
    await expect(history).not.toContainText('Lane narration');
    await expect(history).not.toContainText('probe 12');

    // The ledger carries the run.
    await injectEvent(page, 'session:background-tasks', {
      sessionId: SESSION_ID, inFlight: 1, phases: [], agents: [],
      tasks: [{
        taskId: AGENT_ID, toolUseId: PARENT, taskType: 'local_agent', status: 'running',
        description: 'Find other insights needing audit log', subagentType: 'explore',
        tokens: 61234, toolUses: 60, durationMs: 95000, startedAt: Date.now() - 95000, isBackgrounded: true,
      }],
    });
    // The pinned Background bar is ONE line and ONE button: counts + tokens, no
    // caret, no in-place list. Clicking it opens the same panel the chip opens.
    const ledger = page.locator('.wf-card');
    await expect(ledger).toHaveCount(1);
    await expect(ledger).toHaveClass(/wf-card--bar/);
    await expect(ledger.locator('.wf-card-title')).toHaveText('Background');
    await expect(ledger.locator('.wf-card-running')).toContainText('1 running');
    await expect(ledger.locator('.wf-card-tokens')).toContainText('61k tok');
    await expect(ledger.locator('.wf-card-caret')).toHaveCount(0);
    await expect(ledger.locator('.wf-agent-row')).toHaveCount(0);
    await expect(page.locator('.wf-card-tasks')).toHaveCount(0);
    // The chat chip mirrors the ledger: running, pulsing, with the ledger's tool count
    // and the agent's model from the tool input.
    await expect(chip.locator('.bg-tasks-chip-status')).toHaveText('Running');
    await expect(chip.locator('.task-group-model')).toHaveText('opus');
    await expect(chip.locator('.task-group-badge')).toHaveText('60 tools');
    await expect(chip.locator('.task-group-streaming-dot')).toHaveCount(1);

    await ledger.click();
    const panel = page.locator('.wf-modal--tasks');
    await expect(panel).toHaveCount(1);
    const rows = panel.locator('.bg-task-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveClass(/bg-task-row-running/);
    await expect(rows.first()).toHaveClass(/bg-task-row--selected/);
    await expect(rows.first().locator('.bg-task-row-name')).toContainText('Find other insights needing audit log');
    await expect(rows.first().locator('.bg-task-row-meta')).toContainText('60 tool uses');
    await expect(rows.first().locator('.bg-task-row-meta')).toContainText('61k tokens');
    // While the agent runs, the reader IS the live lane from the stream buffer (no
    // fetch, no poll): the 60 probes and the narration the chat refused to show.
    await expect(panel.locator('.bg-tasks-live-lane')).toHaveCount(1);
    await expect(panel.locator('.bg-tasks-detail')).toContainText('probe 12');
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Lane narration that must stay off the main conversation.');
    await expect(panel.locator('.bg-tasks-detail')).not.toContainText('Transcript line from the running agent.');
    await expect(panel.locator('.bg-tasks-detail-head .wf-modal-live')).toHaveCount(1);
    // 60 still-calling probes are 60 in-flight cards (a calling tool never folds),
    // and the lane ends in the working indicator clocked from the ledger's start.
    await expect(panel.locator('.bg-tasks-detail .tool-run-row')).toHaveCount(0);
    await expect(panel.locator('.bg-tasks-detail .chat-tool-block-calling')).toHaveCount(60);
    await expect(panel.locator('.bg-tasks-detail .session-working-label')).toHaveText('explore agent is working…');
    await expect(panel.locator('.bg-tasks-detail .session-working-meta')).toContainText(/9[4-9]s|1m 3[0-9]s/);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    // The chat chip is the SAME action: one panel, nothing unfolds in the chat.
    await chip.click();
    await expect(panel).toHaveCount(1);
    await expect(panel.locator('.bg-tasks-detail-title')).toHaveText('Find other insights needing audit log');
    await expect(panel.locator('.bg-tasks-detail')).toContainText('probe 59');
    await expect(history).not.toContainText('probe 59');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // The agent finishes: the ledger row and the chip settle together.
    await injectEvent(page, 'session:background-tasks', {
      sessionId: SESSION_ID, inFlight: 0, phases: [], agents: [],
      tasks: [{
        taskId: AGENT_ID, toolUseId: PARENT, taskType: 'local_agent', status: 'completed',
        description: 'Find other insights needing audit log', subagentType: 'explore',
        tokens: 70000, toolUses: 64, durationMs: 120000, startedAt: Date.now() - 120000, endedAt: Date.now(),
      }],
    });
    await expect(ledger.locator('.wf-card-running')).toHaveCount(0);
    await expect(ledger.locator('.wf-card-count')).toContainText('1/1 agents');
    await expect(chip.locator('.bg-tasks-chip-status')).toHaveText('Done');
    await expect(chip.locator('.task-group-badge')).toHaveText('64 tools');
    await expect(chip.locator('.task-group-streaming-dot')).toHaveCount(0);
    await expect(chip.locator('.bg-tasks-chip-icon')).toHaveText('✓');
    // Reopen: the finished agent is listed under Finished, and its reader is now the
    // persisted transcript (the canonical record), not the stream lane.
    await chip.click();
    await expect(panel.locator('.bg-tasks-section')).toHaveText(['Finished']);
    await expect(panel.locator('.bg-tasks-live-lane')).toHaveCount(0);
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Transcript line from the running agent.');
    await expect(panel.locator('.bg-tasks-detail-head .wf-modal-live')).toHaveCount(0);
    await expect(panel.locator('.bg-tasks-detail .session-working-indicator')).toHaveCount(0);
  });

  test('three parallel spawns are ONE `3 agents` chip; the panel lists all three and switches the reader', async ({ page }) => {
    const base = [
      { role: 'user', text: 'Fan out', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Spawning three explorers.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    await mockHistory(page, base);
    await mockSessionDetail(page);
    await page.route(`**/api/sessions/${SESSION_ID}/workflow`, (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const history = page.locator('.session-history');
    const names = ['audit the api routes', 'audit the web client', 'audit the daemon'];
    for (let i = 0; i < 3; i++) {
      // Two background explorers (CLI default) and one sync one: a sync agent's
      // tool_result settles it, a background agent's is launch metadata.
      await injectEvent(page, 'session:tool-use', {
        sessionId: SESSION_ID, toolName: 'Agent', toolUseId: `toolu_fan_${i}`,
        input: { description: names[i], subagent_type: 'explore', prompt: `look at ${i}`, ...(i === 2 ? { run_in_background: false } : {}) },
      });
    }
    for (let i = 0; i < 3; i++) {
      await injectEvent(page, 'session:text-delta', {
        sessionId: SESSION_ID, delta: `Narration from explorer ${i}.`, msgId: `msg_fan_${i}`, parentToolUseId: `toolu_fan_${i}`,
      });
    }
    await page.waitForTimeout(150);

    const chip = history.locator('.bg-tasks-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.bg-tasks-chip-label')).toHaveText('3 agents');
    await expect(chip.locator('.bg-tasks-chip-status')).toHaveText('3 running');
    await expect(chip.locator('.task-group-agent-type')).toHaveText(['explore']);
    await expect(chip.locator('.bg-tasks-chip-desc')).toHaveText(names.join(' · '));
    await expect(history.locator('.task-group')).toHaveCount(0);
    for (let i = 0; i < 3; i++) await expect(history).not.toContainText(`Narration from explorer ${i}.`);

    await chip.click();
    const panel = page.locator('.wf-modal--tasks');
    const rows = panel.locator('.bg-task-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.locator('.bg-task-row-name')).toHaveText(names);
    await expect(rows.nth(0)).toHaveClass(/bg-task-row--selected/);
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Narration from explorer 0.');
    await expect(panel.locator('.bg-tasks-detail')).not.toContainText('Narration from explorer 1.');
    await rows.nth(1).click();
    await expect(rows.nth(1)).toHaveClass(/bg-task-row--selected/);
    await expect(rows.nth(0)).not.toHaveClass(/bg-task-row--selected/);
    await expect(panel.locator('.bg-tasks-detail-title')).toHaveText(names[1]);
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Narration from explorer 1.');
    await expect(panel.locator('.bg-tasks-detail')).not.toContainText('Narration from explorer 0.');

    // The sync explorer's result lands: the chip counts down and the panel moves it to Finished.
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'toolu_fan_2', result: 'done' });
    await expect(chip.locator('.bg-tasks-chip-status')).toHaveText('2 running · 1 done');
    await expect(panel.locator('.bg-tasks-section')).toHaveText(['Running', 'Finished']);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('the open panel survives the turn end (stream chip → history chip hand-over)', async ({ page }) => {
    const base: unknown[] = [
      { role: 'user', text: 'Fan out', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Spawning two explorers.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    // Mutable history: the turn-end refetch returns the Agent tool_calls absorbed.
    let history = base;
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      const since = url.searchParams.get('since');
      if (since !== null && url.searchParams.get('source') !== 'streams') {
        return route.fulfill({ json: { messages: history.slice(parseInt(since, 10)), cursor: history.length, delta: true } });
      }
      return route.fulfill({ json: { messages: history, cursor: history.length, delta: false } });
    });
    await mockSessionDetail(page);
    await page.route(`**/api/sessions/${SESSION_ID}/workflow`, (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const col = page.locator('.session-history');
    for (let i = 0; i < 2; i++) {
      await injectEvent(page, 'session:tool-use', {
        sessionId: SESSION_ID, toolName: 'Agent', toolUseId: `toolu_hand_${i}`,
        input: { description: `explorer ${i}`, subagent_type: 'explore', prompt: `look at ${i}` },
      });
    }
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Live words from explorer 1.', msgId: 'msg_hand_1', parentToolUseId: 'toolu_hand_1',
    });
    const chip = col.locator('.bg-tasks-chip');
    await expect(chip.locator('.bg-tasks-chip-status')).toHaveText('2 running');
    await chip.click();
    const panel = page.locator('.wf-modal--tasks');
    const rows = panel.locator('.bg-task-row');
    await expect(rows).toHaveCount(2);
    await rows.nth(1).click();
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Live words from explorer 1.');

    // Turn ends: history now holds both Agent tool_calls (one settled, one still
    // running in the background), the streaming chip yields to the history chip.
    history = [
      ...base,
      {
        role: 'assistant', text: '', timestamp: '2026-01-01T00:00:02.000Z', msgId: 'msg_spawn',
        tools: [
          { name: 'Agent', toolUseId: 'toolu_hand_0', input: { description: 'explorer 0', subagent_type: 'explore' }, result: 'Explorer 0 report.', bgTaskFinished: true },
          { name: 'Agent', toolUseId: 'toolu_hand_1', input: { description: 'explorer 1', subagent_type: 'explore' }, result: 'Async agent launched successfully.' },
        ],
      },
    ];
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
    await expect(col.locator('.session-msg-content .bg-tasks-chip')).toHaveCount(1);
    // The panel is still open, still on explorer 1, still listing both agents.
    await expect(panel).toHaveCount(1);
    await expect(rows).toHaveCount(2);
    await expect(panel.locator('.bg-tasks-detail-title')).toHaveText('explorer 1');
    await expect(panel.locator('.bg-tasks-section')).toHaveText(['Running', 'Finished']);
    // Explorer 0's result reads from its settled tool_result.
    await rows.filter({ hasText: 'explorer 0' }).click();
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Explorer 0 report.');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('a background shell command is its own kind of row: Command pill, and a reader that shows the command and its output', async ({ page }) => {
    const base = [
      { role: 'user', text: 'Run the tests in the background', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Kicking off the tests and an explorer.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    await mockHistory(page, base);
    await mockSessionDetail(page);
    await page.route(`**/api/sessions/${SESSION_ID}/workflow`, (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    // The CLI runs `npm test` in the background: a Bash tool_use whose result is
    // the launch note, and a ledger row of task_type local_bash pointing at it.
    const BASH = 'toolu_bg_bash';
    const SHELL_TASK = 'b3lv4ei9g';
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Bash', toolUseId: BASH,
      input: { command: 'npm test -- --run tests/web', description: 'Run the web unit tier', run_in_background: true },
    });
    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID, toolUseId: BASH,
      result: `Command running in background with ID: ${SHELL_TASK}. Output is being written to: /tmp/out.log`,
    });
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Agent', toolUseId: 'toolu_cmd_agent',
      input: { description: 'audit the routes', subagent_type: 'explore', prompt: 'look' },
    });
    await injectEvent(page, 'session:background-tasks', {
      sessionId: SESSION_ID, inFlight: 2, phases: [], agents: [],
      tasks: [
        { taskId: SHELL_TASK, toolUseId: BASH, taskType: 'local_bash', status: 'running', description: 'Run the web unit tier', startedAt: Date.now() - 3000, isBackgrounded: true },
        { taskId: 'agent_cmd_1', toolUseId: 'toolu_cmd_agent', taskType: 'local_agent', status: 'running', description: 'audit the routes', subagentType: 'explore', tokens: 1200, toolUses: 3, startedAt: Date.now() - 2000 },
      ],
    });

    // The chat's chip counts only the agent; the shell command is the ledger's.
    const history = page.locator('.session-history');
    await expect(history.locator('.bg-tasks-chip')).toHaveCount(1);
    await expect(history.locator('.bg-tasks-chip .bg-tasks-chip-label')).toHaveText('Agent');
    await page.locator('.wf-card').click();
    const panel = page.locator('.wf-modal--tasks');
    const rows = panel.locator('.bg-task-row');
    await expect(rows).toHaveCount(2);
    // Agents first, then commands; each kind wears its own pill.
    await expect(rows.nth(0).locator('.task-group-agent-type')).toHaveText('explore');
    await expect(rows.nth(0).locator('.bg-task-kind')).toHaveCount(0);
    await expect(rows.nth(1).locator('.bg-task-kind--command')).toHaveText('Command');
    await expect(rows.nth(1).locator('.task-group-agent-type')).toHaveCount(0);
    await expect(rows.nth(1).locator('.bg-task-row-meta')).toContainText('Command');

    // The command's reader: what it ran, and (while it runs, launch note only) that
    // it is still running — never the launch note as if it were output.
    await rows.nth(1).click();
    const detail = panel.locator('.bg-tasks-detail');
    await expect(detail.locator('.bg-tasks-detail-head .bg-task-kind--command')).toHaveText('Command');
    await expect(detail.locator('.bg-tasks-command .bash-tool-pre').nth(0)).toContainText('$ npm test -- --run tests/web');
    await expect(detail.locator('.bg-tasks-command .bash-tool-pre').nth(1)).toHaveText('Running…');
    await expect(detail).not.toContainText('Command running in background');

    // The model reads the output (TaskOutput) and the task finishes: the reader
    // shows the read, in place, without reopening.
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'TaskOutput', toolUseId: 'toolu_read_1', input: { task_id: SHELL_TASK, block: true },
    });
    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID, toolUseId: 'toolu_read_1', result: '<status>completed</status>\n<exit_code>0</exit_code>\n<stdout>Tests 15 passed (15)</stdout>',
    });
    await injectEvent(page, 'session:background-tasks', {
      sessionId: SESSION_ID, inFlight: 1, phases: [], agents: [],
      tasks: [
        { taskId: SHELL_TASK, toolUseId: BASH, taskType: 'local_bash', status: 'completed', description: 'Run the web unit tier', startedAt: Date.now() - 6000, endedAt: Date.now(), isBackgrounded: true },
        { taskId: 'agent_cmd_1', toolUseId: 'toolu_cmd_agent', taskType: 'local_agent', status: 'running', description: 'audit the routes', subagentType: 'explore', tokens: 1200, toolUses: 3, startedAt: Date.now() - 5000 },
      ],
    });
    await expect(detail.locator('.bg-tasks-command .bash-tool-pre').nth(1)).toContainText('Tests 15 passed (15)');
    await expect(panel.locator('.bg-tasks-section')).toHaveText(['Running', 'Finished']);
    await page.keyboard.press('Escape');
  });

  test('the chip keeps one line while the title fits and moves the title to its own line when it does not', async ({ page }) => {
    const base = [
      { role: 'user', text: 'Two spawns', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Spawning.', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    await mockHistory(page, base);
    await mockSessionDetail(page);
    await page.route(`**/api/sessions/${SESSION_ID}/workflow`, (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    await page.waitForSelector('.session-msg', { timeout: 8000 });

    const history = page.locator('.session-history');
    // Burst 1: a short title. Burst 2 (split from the first by main text): a title
    // longer than any session column, next to type + model pills and a tool count.
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Agent', toolUseId: 'toolu_short',
      input: { description: 'grep enums', subagent_type: 'explore', prompt: 'x' },
    });
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'And a second one.', msgId: 'msg_between' });
    const longTitle = 'Inventory every document that still refers to the old module layout after the migration and list the stale paths';
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Agent', toolUseId: 'toolu_long',
      input: { description: longTitle, subagent_type: 'general-purpose', model: 'opus', prompt: 'x' },
    });
    await injectEvent(page, 'session:background-tasks', {
      sessionId: SESSION_ID, inFlight: 2, phases: [], agents: [],
      tasks: [
        { taskId: 'a_short', toolUseId: 'toolu_short', taskType: 'local_agent', status: 'running', description: 'grep enums', subagentType: 'explore', toolUses: 2, startedAt: Date.now() - 1000 },
        { taskId: 'a_long', toolUseId: 'toolu_long', taskType: 'local_agent', status: 'running', description: longTitle, subagentType: 'general-purpose', toolUses: 12, startedAt: Date.now() - 1000 },
      ],
    });

    const chips = history.locator('.bg-tasks-chip');
    await expect(chips).toHaveCount(2);
    const short = chips.nth(0);
    const long = chips.nth(1);
    await expect(short).not.toHaveClass(/bg-tasks-chip--stacked/);
    await expect(long).toHaveClass(/bg-tasks-chip--stacked/);

    // Geometry, not just the class: the short chip's title sits on the label's
    // line; the long chip's title sits BELOW its label and status, full width,
    // while the status stays on the first line at the right end.
    const rowOf = async (el: ReturnType<Page['locator']>) => (await el.boundingBox())!;
    const shortLabel = await rowOf(short.locator('.bg-tasks-chip-label'));
    const shortDesc = await rowOf(short.locator('.bg-tasks-chip-desc'));
    expect(Math.abs(shortDesc.y - shortLabel.y)).toBeLessThan(6);
    const longLabel = await rowOf(long.locator('.bg-tasks-chip-label'));
    const longDesc = await rowOf(long.locator('.bg-tasks-chip-desc'));
    const longMeta = await rowOf(long.locator('.bg-tasks-chip-meta'));
    const longChip = await rowOf(long);
    expect(longDesc.y).toBeGreaterThan(longLabel.y + longLabel.height - 2);
    expect(Math.abs(longMeta.y - longLabel.y)).toBeLessThan(6);
    expect(longDesc.width).toBeGreaterThan(longChip.width * 0.8);
    await expect(long.locator('.bg-tasks-chip-status')).toHaveText('Running');
    await expect(long.locator('.task-group-badge')).toHaveText('12 tools');
  });
});
