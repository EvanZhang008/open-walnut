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
 * burst (`N running tasks`), never a card per agent, never an in-place dropdown;
 * the chip and the ledger's "View transcript" both open the two-column Background
 * tasks panel (agents on the left, the selected agent's transcript on the right).
 *
 * Asserts (real React components in a real browser):
 *   1. main text interrupted by a subagent text line stays ONE contiguous block
 *   2. the chip is the only trace of the agent in the chat; its narration is on
 *      screen only inside the panel
 *   3. late lane lines with no anchor in the stream render NOWHERE (no box,
 *      no flat text)
 *   4. the pic-1 shape — Agent row already in history + live lane blocks —
 *      shows exactly ONE chip, the ledger carries the run, both open the panel
 *   5. three parallel spawns are one `3 running tasks` chip; the panel lists all
 *      three and switches the reader on click
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

/** Placeholder for the ledger's "View transcript" control — set to the class the
 *  AgentRow renders (see WorkflowProgress.tsx). */
const TRANSCRIPT_BUTTON = '.wf-agent-row-transcript';

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
    await expect(chip).toHaveText(/1 running task/);
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
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Now I have the two distinct enums.');
    await expect(panel.locator('.bg-tasks-detail')).toContainText('grep enum');
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
    const ledger = page.locator('.wf-card');
    await expect(ledger).toHaveCount(1);
    await expect(ledger.locator('.wf-card-title')).toContainText('Background');
    await expect(ledger.locator('.wf-card-running')).toContainText('1 running');
    await ledger.locator('.wf-card-collapse').click();
    const row = ledger.locator('.wf-agent-row');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveClass(/wf-agent-row-running/);
    await expect(row.locator('.wf-agent-row-name')).toContainText('Find other insights needing audit log');
    await expect(row.locator('.wf-agent-row-meta')).toContainText('60 tool uses');
    await expect(row.locator('.wf-agent-row-meta')).toContainText('61k tokens');
    // The chat chip mirrors the ledger: running, pulsing.
    await expect(chip).toHaveText(/1 running task/);
    await expect(chip.locator('.task-group-streaming-dot')).toHaveCount(1);

    // Drill-in from the ledger opens the panel on that agent.
    await expect(row.locator(TRANSCRIPT_BUTTON)).toHaveCount(1);
    await row.locator(TRANSCRIPT_BUTTON).click();
    const panel = page.locator('.wf-modal--tasks');
    await expect(panel).toHaveCount(1);
    const rows = panel.locator('.bg-task-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveClass(/bg-task-row-running/);
    await expect(rows.first()).toHaveClass(/bg-task-row--selected/);
    await expect(rows.first().locator('.bg-task-row-meta')).toContainText('60 tool uses');
    // While the agent runs, the reader IS the live lane from the stream buffer (no
    // fetch, no poll): the 60 probes and the narration the chat refused to show.
    await expect(panel.locator('.bg-tasks-live-lane')).toHaveCount(1);
    await expect(panel.locator('.bg-tasks-detail')).toContainText('probe 12');
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Lane narration that must stay off the main conversation.');
    await expect(panel.locator('.bg-tasks-detail')).not.toContainText('Transcript line from the running agent.');
    await expect(panel.locator('.bg-tasks-detail-head .wf-modal-live')).toHaveCount(1);
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
    await expect(row).toHaveClass(/wf-agent-row-completed/);
    await expect(ledger.locator('.wf-card-running')).toHaveCount(0);
    await expect(chip).toHaveText(/1 task done/);
    await expect(chip.locator('.task-group-streaming-dot')).toHaveCount(0);
    await expect(chip.locator('.bg-tasks-chip-icon')).toHaveText('✓');
    // Reopen: the finished agent is listed under Finished, and its reader is now the
    // persisted transcript (the canonical record), not the stream lane.
    await chip.click();
    await expect(panel.locator('.bg-tasks-section')).toHaveText(['Finished']);
    await expect(panel.locator('.bg-tasks-live-lane')).toHaveCount(0);
    await expect(panel.locator('.bg-tasks-detail')).toContainText('Transcript line from the running agent.');
    await expect(panel.locator('.bg-tasks-detail-head .wf-modal-live')).toHaveCount(0);
  });

  test('three parallel spawns are ONE `3 running tasks` chip; the panel lists all three and switches the reader', async ({ page }) => {
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
    await expect(chip).toHaveText(/3 running tasks/);
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
    await expect(chip).toHaveText(/2 running tasks/);
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
    await expect(chip).toHaveText(/2 running tasks/);
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
});
