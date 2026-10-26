import fs from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

const SID = '7e1b2026-1012-4000-8000-000000000001';
const PORT = Number(process.env.PW_TEST_PORT ?? 3457);
const EVIDENCE = process.env.PW_SCREENSHOT_DIR ?? '/tmp/subagent-working-indicator';
const agent = (id: string) => ({ taskId: id, toolUseId: `call-${id}`, taskType: 'local_agent', status: 'running', isBackgrounded: true, description: `Verification ${id}` });
const speed = (final: boolean, startedAt = 1000) => ({ startedAt, endedAt: final ? startedAt + 100 : undefined, final, ttftMs: 10, generationMs: 100, outputTokens: 20, messages: 1, inFlight: false, inFlightChars: 0, inFlightMs: 0, inFlightVisibleMs: 0 });
const history = Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `Verification step ${index + 1}. ${'This is a completed check of the recorded state. '.repeat(20)}`, msgId: `history-${index}`, timestamp: new Date(1000 + index).toISOString() }));

async function inject(page: Page, name: string, data: object) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__indicatorWs as WebSocket;
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data }) }));
  }, { name, data: { sessionId: SID, ...data } });
}

async function open(page: Page, cold = false) {
  await fs.mkdir(EVIDENCE, { recursive: true });
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname !== '/ws') return;
        (window as any).__indicatorWs = this;
        const send = this.send.bind(this);
        this.send = (raw: any) => {
          let frame: any;
          try { frame = JSON.parse(raw); } catch { return send(raw); }
          if (frame.method !== 'session:stream-subscribe') return send(raw);
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { blocks: [], isStreaming: false, completedLen: 0 } }),
          })), 0);
        };
      }
    } as any;
  });
  await page.route(`**/api/sessions/${SID}`, route => route.fulfill({ json: { session: {
    claudeSessionId: SID, taskId: '', project: '', process_status: 'running', mode: 'bypass', engine: 'claude', provider: 'cli',
    statusRevision: 1, statusUpdatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messageCount: history.length,
    lastTurnSpeed: speed(true),
  } } }));
  await page.route(`**/api/sessions/${SID}/history**`, route => route.fulfill({ json: { messages: history, cursor: history.length, delta: false, fromStart: true } }));
  await page.route(`**/api/sessions/${SID}/workflow`, route => route.fulfill({ json: { sessionId: SID, inFlight: 0, foregroundActive: cold ? false : undefined, tasks: cold ? [agent('one')] : [], agents: [], phases: [] } }));
  await page.route(`**/api/sessions/${SID}/subagent/**/history**`, route => route.fulfill({ json: { messages: [] } }));
  await page.setContent(`<a href="http://localhost:${PORT}/sessions?id=${SID}">Open session</a>`);
  await page.getByRole('link', { name: 'Open session', exact: true }).click();
  // The first spec to reach a cold fixture waits on Vite compiling the app (dev mode).
  await expect(page.locator(`.session-panel[data-session-id="${SID}"]`)).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => (window as any).__indicatorWs?.readyState === WebSocket.OPEN);
}

const panel = (page: Page) => page.locator(`.session-panel[data-session-id="${SID}"]`);
// The subagents-only line; the after-turn background line shares its look but not this class.
const indicator = (page: Page) => panel(page).locator('.session-background-working:not(.session-background-after)');
const backgroundNote = (page: Page) => panel(page).locator('[data-testid="session-background-note"]');
const ledger = (page: Page, tasks: object[], foregroundActive?: boolean) => inject(page, 'session:background-tasks', { inFlight: 0, foregroundActive, tasks, agents: [], phases: [] });

test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
// A cold fixture boot alone can take most of the default 30s on a loaded box.
test.describe.configure({ timeout: 120_000 });

test('only background agents get the clickable tail status, across repeated foreground turns', async ({ page }, info) => {
  await open(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await inject(page, 'session:turn-speed', { speed: speed(false) });
  await inject(page, 'session:text-delta', { delta: 'The main agent is checking the result.', msgId: 'live-one' });
  await ledger(page, [agent('one')]);
  await expect(indicator(page)).toHaveCount(0);
  await expect(panel(page).locator('.session-working-label')).toHaveText('Claude Code is working…');
  // The foreground turn runs beside the agent: the working line names it after itself.
  await expect(backgroundNote(page)).toHaveText(/^·\s*1 agent in background\s*›$/);

  await ledger(page, [agent('one')], false);
  await inject(page, 'session:result', { result: 'Main reply complete.', isError: false });
  await expect(backgroundNote(page)).toHaveCount(0);
  await expect(indicator(page)).toHaveText('1 subagent is working…›');
  await expect(panel(page).locator('.session-working-label')).toHaveCount(1);
  await indicator(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-one-agent.png` });
  await indicator(page).click();
  await expect(page.locator('.bg-task-row-running')).toContainText('Verification one');
  await expect(page.locator('.bg-task-row--selected')).toContainText('Verification one');
  await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-opened-agent.png` });
  await page.keyboard.press('Escape');

  await ledger(page, [agent('one'), agent('two')], false);
  await expect(indicator(page)).toContainText('2 subagents are working…');
  await indicator(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-task-row-running')).toHaveCount(2);
  await page.keyboard.press('Escape');

  for (let turn = 2; turn <= 3; turn++) {
    await ledger(page, [agent('one'), agent('two')], true);
    await inject(page, 'session:text-delta', { delta: `Foreground pass ${turn}.`, msgId: `live-${turn}` });
    await expect(indicator(page)).toHaveCount(0);
    await expect(panel(page).locator('.session-working-label')).toHaveText('Claude Code is working…');
    await ledger(page, [agent('one'), agent('two')], false);
    await inject(page, 'session:result', { result: 'Done', isError: false });
    await expect(indicator(page)).toContainText('2 subagents are working…');
  }
  await ledger(page, [agent('one'), { ...agent('two'), status: 'completed' }, { taskId: 'nested-command', taskType: 'local_bash', status: 'running', ownedBySubagent: true }], false);
  await expect(indicator(page)).toContainText('1 subagent is working…');
  await ledger(page, [{ ...agent('one'), status: 'completed' }, { ...agent('two'), status: 'failed' }]);
  await expect(indicator(page)).toHaveCount(0);
  await expect(backgroundNote(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('cold open and reload restore the foreground final and the running agent', async ({ page }, info) => {
  await open(page, true);
  // A cold open and a reload both wait on the ledger fetch; a loaded box takes longer than 5s.
  await expect(indicator(page)).toContainText('1 subagent is working…', { timeout: 20_000 });
  await page.reload();
  await expect(indicator(page)).toContainText('1 subagent is working…', { timeout: 20_000 });
  await indicator(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-reload.png` });
});

test('commands, mixed jobs, unknown foreground, permission waits, and terminal sessions never get the subagent-only label', async ({ page }) => {
  await open(page);
  await ledger(page, [agent('one')]);
  await expect(indicator(page)).toHaveCount(0);
  // Not known to wait on it: the quiet after-turn line names the agent instead.
  await expect(backgroundNote(page).locator('.session-working-label')).toHaveText('1 agent still running in the background');
  await ledger(page, [agent('one')], false);
  await expect(indicator(page)).toBeVisible();
  await expect(backgroundNote(page)).toHaveCount(0);
  const command = { taskId: 'command', taskType: 'local_bash', status: 'running', isBackgrounded: true };
  const shapes: Array<[object[], string]> = [
    [[command], '1 command'],
    [[agent('one'), command], '1 agent, 1 command'],
    [[{ ...agent('one'), status: 'paused' }], '1 agent'],
    [[{ ...agent('one'), taskType: 'unknown' }], '1 task'],
  ];
  for (const [tasks, label] of shapes) {
    await ledger(page, tasks, false);
    await expect(indicator(page)).toHaveCount(0);
    await expect(backgroundNote(page).locator('.session-working-label')).toHaveText(`${label} still running in the background`);
  }
  await ledger(page, [agent('one')], false);
  await expect(indicator(page)).toBeVisible();
  await inject(page, 'session:status-changed', { taskId: null, process_status: 'running', activity: null, mode: 'bypass', planCompleted: false, archived: false, errorMessage: null, provider: 'cli', engine: 'claude', pendingPermissionTool: 'AskUserQuestion', statusRevision: 2, statusUpdatedAt: new Date().toISOString() });
  await expect(indicator(page)).toHaveCount(0);
  await inject(page, 'session:status-changed', { taskId: null, process_status: 'stopped', activity: null, mode: 'bypass', planCompleted: false, archived: false, errorMessage: null, provider: 'cli', engine: 'claude', pendingPermissionTool: null, statusRevision: 3, statusUpdatedAt: new Date().toISOString() });
  await expect(indicator(page)).toHaveCount(0);
});
