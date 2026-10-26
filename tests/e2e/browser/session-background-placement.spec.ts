/**
 * Where a session's background work shows (2026-10-26, the user: the "Background ·
 * 1/1 commands done · View all ›" bar at the top of every session "is too ugly").
 *
 * The shape now:
 *   - nothing is pinned at the top of the session for plain background work;
 *   - during a turn, the "<engine> is working…" line is followed by a note,
 *     "· 1 command in background ›", that opens the Background tasks panel;
 *   - after the turn, while something still runs, one quiet line takes the working
 *     line's place: "1 command still running in the background ›", same panel;
 *   - when everything finished, no note; the session's ⋮ menu has a "Background tasks"
 *     row (a count chip only while something runs) that opens the panel with the
 *     finished tasks; a session that never had background work has no such row;
 *   - a workflow run keeps its "Workflow: <name>" card.
 *
 * The ledger arrives the way it does in the app: a `session:background-tasks` event on
 * the app's own socket. The session is answered here (a running CLI, no stream yet),
 * the way subagent-working-indicator.spec.ts drives the working line.
 */
import fs from 'node:fs/promises';
import { test, expect, type Locator, type Page } from '@playwright/test';

const PORT = Number(process.env.PW_TEST_PORT ?? 3457);
const SHOTS = '/tmp/background-placement';
const SID_BG = '7e1b2026-1026-4000-8000-0000000000b1';
const SID_NONE = '7e1b2026-1026-4000-8000-0000000000b2';
const SID_STOP = '7e1b2026-1026-4000-8000-0000000000b3';

type Task = Record<string, unknown>;
const command = (id: string, status: string, description: string): Task => ({
  taskId: id, toolUseId: `call-${id}`, taskType: 'local_bash', status, isBackgrounded: true, description,
  startedAt: Date.now() - 30_000, ...(status === 'running' ? {} : { endedAt: Date.now() - 10_000 }),
});
const agent = (id: string, status: string, description: string): Task => ({
  taskId: id, toolUseId: `call-${id}`, taskType: 'local_agent', subagentType: 'Explore', status, isBackgrounded: true,
  description, tokens: 12_400, toolUses: 6, startedAt: Date.now() - 40_000, ...(status === 'running' ? {} : { endedAt: Date.now() - 5_000 }),
});
const speed = (final: boolean) => ({ startedAt: Date.now() - 2_000, endedAt: final ? Date.now() : undefined, final, ttftMs: 10, generationMs: 100, outputTokens: 20, messages: 1, inFlight: false, inFlightChars: 0, inFlightMs: 0, inFlightVisibleMs: 0 });
const history = Array.from({ length: 6 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  text: index % 2 ? `Checked step ${index}. The recorded state matches.` : `Run check ${index + 1} and tell me what changed.`,
  msgId: `history-${index}`, timestamp: new Date(1_000 + index).toISOString(),
}));

/** What the workflow route answers: the ledger last delivered, so a refetch never rolls it back. */
const ledgers = new Map<string, Task[]>();

async function open(page: Page, sid: string) {
  await fs.mkdir(SHOTS, { recursive: true });
  ledgers.set(sid, []);
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname !== '/ws') return;
        (window as any).__placementWs = this;
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
  await page.route(`**/api/sessions/${sid}`, route => route.fulfill({ json: { session: {
    claudeSessionId: sid, taskId: '', project: '', process_status: 'running', mode: 'bypass', engine: 'claude', provider: 'cli',
    statusRevision: 1, statusUpdatedAt: new Date().toISOString(), startedAt: new Date(Date.now() - 600_000).toISOString(),
    lastActiveAt: new Date().toISOString(), messageCount: history.length, title: 'Background placement fixture', lastTurnSpeed: speed(true),
  } } }));
  await page.route(`**/api/sessions/${sid}/history**`, route => route.fulfill({ json: { messages: history, cursor: history.length, delta: false, fromStart: true } }));
  await page.route(`**/api/sessions/${sid}/workflow`, route => route.fulfill({ json: { sessionId: sid, inFlight: 0, tasks: ledgers.get(sid) ?? [], agents: [], phases: [] } }));
  await page.route(`**/api/sessions/${sid}/subagent/**/history**`, route => route.fulfill({ json: { messages: [] } }));
  await page.setContent(`<a href="http://localhost:${PORT}/sessions?id=${sid}">Open session</a>`);
  await page.getByRole('link', { name: 'Open session', exact: true }).click();
  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`);
  // The first spec to reach a cold fixture waits on Vite compiling the app (dev mode).
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel).toContainText('Checked step 5.', { timeout: 20_000 });
  await page.waitForFunction(() => (window as any).__placementWs?.readyState === WebSocket.OPEN);
  return panel;
}

async function inject(page: Page, sid: string, name: string, data: object) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__placementWs as WebSocket;
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data: { sessionId: sid, ...data } });
}

async function ledger(page: Page, sid: string, tasks: Task[]) {
  ledgers.set(sid, tasks);
  await inject(page, sid, 'session:background-tasks', { inFlight: tasks.filter(t => t.status === 'running').length, tasks, agents: [], phases: [] });
}

async function startTurn(page: Page, sid: string) {
  await inject(page, sid, 'session:turn-speed', { speed: speed(false) });
  await inject(page, sid, 'session:text-delta', { delta: 'Checking the result of the last run.', msgId: `live-${Date.now()}` });
}

async function openMenu(page: Page, panel: Locator) {
  await panel.locator('.session-panel-header').getByRole('button', { name: 'More actions' }).click();
  const menu = page.locator('.task-kebab-menu:visible');
  await expect(menu).toHaveCount(1);
  return menu;
}

/** Plain background work leaves nothing at the top of the session: no card, no bar words. */
async function expectNoBarAtTop(panel: Locator) {
  await expect(panel.locator('.wf-card')).toHaveCount(0);
  await expect(panel.locator('.wf-card--bar')).toHaveCount(0);
  await expect(panel.getByText('Background', { exact: true })).toHaveCount(0);
  await expect(panel.getByText(/View all|commands? done/)).toHaveCount(0);
}

/** A crop around one element, at most 1280 px wide. */
async function shoot(page: Page, target: Locator, name: string, pad = 16) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: `${SHOTS}/${test.info().project.name}-${name}.png`, scale: 'css',
    clip: { x, y, width: Math.min(box.width + pad * 2, 1280), height: box.height + pad * 2 },
  });
}

test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });

test.describe('Session background work placement', () => {
  test.setTimeout(120_000);

  test('the working line carries the note during a turn, the quiet line after it, and the ⋮ menu once all finished', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const panel = await open(page, SID_BG);
    const note = panel.locator('[data-testid="session-background-note"]');
    const tasksPanel = page.locator('.wf-modal--tasks');

    // 1. A turn with one background command running and one finished.
    await startTurn(page, SID_BG);
    await ledger(page, SID_BG, [
      command('tests', 'running', 'npm run test:quick'),
      command('status', 'completed', 'git status --short'),
    ]);
    const row = panel.locator('.session-working-row');
    await expect(row.locator('.session-working-label')).toHaveText('Claude Code is working…');
    await expect(note).toHaveCount(1);
    await expect(note).toHaveText(/^·\s*1 command in background\s*›$/);
    await expectNoBarAtTop(panel);
    // The note sits on the working line, after it, on its middle.
    const geo = await row.evaluate(el => {
      const label = el.querySelector('.session-working-indicator')!.getBoundingClientRect();
      const n = el.querySelector('[data-testid="session-background-note"]')!.getBoundingClientRect();
      return { after: n.left >= label.right - 0.5, midDelta: Math.abs((n.top + n.height / 2) - (label.top + label.height / 2)) };
    });
    expect(geo.after, 'the note follows the working label').toBe(true);
    expect(geo.midDelta, 'the note shares the working line').toBeLessThanOrEqual(3);
    await shoot(page, row, '1-working-line-note');

    // 2. The note opens the Background tasks panel with both commands.
    await note.click();
    await expect(tasksPanel).toHaveCount(1);
    await expect(tasksPanel.locator('.wf-modal-meta').first()).toHaveText('2 commands · 1 running');
    await expect(tasksPanel.locator('.bg-task-row')).toHaveCount(2);
    await expect(tasksPanel.locator('.bg-task-row-running')).toContainText('npm run test:quick');
    await page.keyboard.press('Escape');
    await expect(tasksPanel).toHaveCount(0);

    // 3. An agent joins: the note counts both kinds.
    await ledger(page, SID_BG, [
      agent('audit', 'running', 'Audit the route deadlines'),
      command('tests', 'running', 'npm run test:quick'),
      command('status', 'completed', 'git status --short'),
    ]);
    await expect(note).toHaveText(/^·\s*1 agent, 1 command in background\s*›$/);

    // 4. The turn ends with both still running: one quiet line in the working line's place.
    await inject(page, SID_BG, 'session:result', { result: 'Started the checks.', isError: false });
    await expect(row).toHaveCount(0);
    await expect(panel.locator('.session-working-label', { hasText: 'is working…' })).toHaveCount(0);
    await expect(note).toHaveCount(1);
    await expect(note).toHaveClass(/session-background-after/);
    await expect(note.locator('.session-working-label')).toHaveText('1 agent, 1 command still running in the background');
    await expect(note).toHaveText(/background\s*›$/);
    await expectNoBarAtTop(panel);
    // It is the chat's last line, inside the chat column, its words whole.
    const fit = await note.evaluate(el => {
      const label = el.querySelector('.session-working-label') as HTMLElement;
      const r = el.getBoundingClientRect(), chat = el.closest('.session-history')!.getBoundingClientRect();
      return { cut: label.scrollWidth > label.clientWidth + 1, inside: r.left >= chat.left - 0.5 && r.right <= chat.right + 0.5 };
    });
    expect(fit).toEqual({ cut: false, inside: true });
    await shoot(page, note, '2-after-turn-line');
    // The ⋮ menu counts what still runs.
    let menu = await openMenu(page, panel);
    const menuRow = menu.locator('[data-testid="session-kebab-background"]');
    await expect(menuRow).toContainText('Background tasks');
    await expect(menuRow.locator('.session-action-chip-count')).toHaveText('2');
    await expect(menuRow.locator('.session-action-chip-count')).toHaveAttribute('title', '1 agent, 1 command running');
    // It sits right after "Msgs".
    const order = await menu.locator('.task-kebab-item').evaluateAll(els => els.map(el => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
    const msgsAt = order.findIndex(t => /^Msgs\b/.test(t));
    expect(msgsAt, `menu rows: ${order.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(order[msgsAt + 1]).toMatch(/^Background tasks/);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await note.click();
    await expect(tasksPanel.locator('.bg-tasks-tab-label')).toHaveText(['Agents', 'Commands']);
    await expect(tasksPanel.locator('.wf-modal-meta').first()).toHaveText('1 agent · 2 commands · 2 running');
    await page.keyboard.press('Escape');
    await expect(tasksPanel).toHaveCount(0);

    // 5. Everything finished: no note, the ⋮ menu row stays (no count) and lists them all.
    await ledger(page, SID_BG, [
      agent('audit', 'completed', 'Audit the route deadlines'),
      command('tests', 'completed', 'npm run test:quick'),
      command('status', 'completed', 'git status --short'),
    ]);
    await expect(note).toHaveCount(0);
    await expect(panel.locator('.session-background-working')).toHaveCount(0);
    await expectNoBarAtTop(panel);
    menu = await openMenu(page, panel);
    await expect(menuRow).toHaveText('Background tasks');
    await expect(menuRow.locator('.session-action-chip-count')).toHaveCount(0);
    // Let the menu finish fading in before the picture is taken.
    await menu.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)));
    await shoot(page, menu, '3-menu-row-all-finished', 8);
    await menuRow.click();
    await expect(menu).toHaveCount(0);
    await expect(tasksPanel).toHaveCount(1);
    await expect(tasksPanel.locator('.wf-modal-meta').first()).toHaveText('1 agent · 2 commands');
    await expect(tasksPanel.locator('.bg-tasks-tab-count')).toHaveText(['1', '2']);
    await expect(tasksPanel.locator('.bg-tasks-section-title')).toHaveText(['Finished']);
    await expect(tasksPanel.locator('.bg-task-row')).toContainText('Audit the route deadlines');
    await tasksPanel.locator('.bg-tasks-tab', { hasText: 'Commands' }).click();
    await expect(tasksPanel.locator('.bg-task-row')).toHaveCount(2);
    await expect(tasksPanel.locator('.bg-task-row-running')).toHaveCount(0);
    await page.waitForTimeout(220);
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-4-panel-finished.png`, scale: 'css' });
    await page.keyboard.press('Escape');
    await expect(tasksPanel).toHaveCount(0);

    // 6. A new turn with nothing running: the working line alone, no note.
    await startTurn(page, SID_BG);
    await expect(panel.locator('.session-working-label')).toHaveText('Claude Code is working…');
    await expect(note).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a session that never had background work has no note and no menu row', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const panel = await open(page, SID_NONE);
    const note = panel.locator('[data-testid="session-background-note"]');
    await expectNoBarAtTop(panel);
    await startTurn(page, SID_NONE);
    await expect(panel.locator('.session-working-label')).toHaveText('Claude Code is working…');
    await expect(note).toHaveCount(0);
    // An empty ledger is still nothing to show.
    await ledger(page, SID_NONE, []);
    await expect(note).toHaveCount(0);
    await inject(page, SID_NONE, 'session:result', { result: 'Done.', isError: false });
    await expect(panel.locator('.session-working-label')).toHaveCount(0);
    await expect(note).toHaveCount(0);
    await expectNoBarAtTop(panel);
    const menu = await openMenu(page, panel);
    await expect(menu.locator('.task-kebab-item', { hasText: /^Msgs/ })).toHaveCount(1);
    await expect(menu.locator('[data-testid="session-kebab-background"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  test('the working line keeps its clock when a note joins, and a stopped session claims nothing still running', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const panel = await open(page, SID_STOP);
    const note = panel.locator('[data-testid="session-background-note"]');
    await startTurn(page, SID_STOP);
    const line = panel.locator('.session-working-indicator', { hasText: 'is working…' });
    await expect(line).toHaveCount(1);
    // The same element before and after the note joins: a remount restarts the clock at 0s.
    await line.evaluate(el => { (el as any).__sameLine = true; });
    await ledger(page, SID_STOP, [command('serve', 'running', 'npm run dev')]);
    await expect(note).toHaveText(/^·\s*1 command in background\s*›$/);
    expect(await line.evaluate(el => (el as any).__sameLine === true)).toBe(true);
    await ledger(page, SID_STOP, [command('serve', 'completed', 'npm run dev')]);
    await expect(note).toHaveCount(0);
    expect(await line.evaluate(el => (el as any).__sameLine === true)).toBe(true);

    // The turn ends with a command running, then the CLI stops (Stop, a crash): its last
    // ledger still says running, but nothing runs any more.
    await ledger(page, SID_STOP, [command('serve', 'running', 'npm run dev')]);
    await inject(page, SID_STOP, 'session:result', { result: 'Started the dev server.', isError: false });
    await expect(note).toHaveClass(/session-background-after/);
    await inject(page, SID_STOP, 'session:status-changed', { taskId: null, process_status: 'stopped', activity: null, mode: 'bypass', planCompleted: false, archived: false, errorMessage: null, provider: 'cli', engine: 'claude', pendingPermissionTool: null, statusRevision: 5, statusUpdatedAt: new Date().toISOString() });
    await expect(note).toHaveCount(0);
    const menu = await openMenu(page, panel);
    const menuRow = menu.locator('[data-testid="session-kebab-background"]');
    await expect(menuRow).toHaveText('Background tasks');
    await expect(menuRow.locator('.session-action-chip-count')).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  test('a workflow run still shows its Workflow card', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/search/agent?*', route => route.fulfill({
      json: { summary: '', results: [], model: 'fixture', tookMs: 0 },
    }));
    await page.goto('/');
    const task = page.locator('.todo-panel-item[data-task-id="pw-task-workflow"]');
    // A fill that lands while the board is still hydrating can be reset; type again until it holds.
    await expect(async () => {
      await page.locator('.todo-search-input').fill('pw-task-workflow');
      await expect(task).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await task.locator('.todo-item-title').click();
    const panel = page.locator('.session-panel[data-session-id="pw-workflow-session"]');
    const card = panel.locator('.wf-card');
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card).not.toHaveClass(/wf-card--bar/);
    await expect(card.locator('.wf-card-title')).toContainText('deep-research');
    await expect(card.locator('.wf-card-count')).toContainText('106/107 agents done', { timeout: 30_000 });
    await shoot(page, card.locator('.wf-card-header'), '5-workflow-card', 8);
    expect(errors).toEqual([]);
  });
});
