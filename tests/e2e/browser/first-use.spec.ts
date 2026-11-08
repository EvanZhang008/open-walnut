import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { Config, Task } from '../../../src/core/types';
import type { HostStatus } from '../../../web/src/api/hosts';
import type { LocalClaudeProblem } from '../../../web/src/api/local-claude';
import type { SystemHealth } from '../../../web/src/hooks/useSystemHealth';
import { dropFakes } from './route-teardown';

const missing = {
  hasReadyProvider: false, claudeCliAvailable: false, claudeCodeNeeded: true,
  localClaude: { checkedAt: 1, claude: { found: false }, problems: [{ kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: ['claude'] }] },
} satisfies SystemHealth;

function setupHealth(fix?: LocalClaudeProblem['fix']): SystemHealth {
  return {
    ...missing,
    localClaude: {
      ...missing.localClaude,
      problems: [{ ...missing.localClaude.problems[0], ...(fix ? { fix } : {}) }],
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function openFresh(page: Page, baseURL: string) {
  let socket: WebSocketRoute | undefined;
  await page.addInitScript(() => {
    if (localStorage.getItem('open-walnut-home-chat-visible') === null) localStorage.setItem('open-walnut-home-chat-visible', 'true');
  });
  // Layout writes belong to this browser, not the server shared by the spec's tests.
  await page.route('**/api/ui-prefs', route => route.fulfill({
    json: route.request().method() === 'GET' ? { prefs: {} } : { ok: true },
  }));
  await page.route('**/api/tasks*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue();
    await route.fulfill({ json: { tasks: [], groups: [], completedHidden: 0 } });
  });
  await page.routeWebSocket('**/ws*', ws => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage(message => {
      const frame = JSON.parse(message.toString());
      // Keep the real SPA socket and navigation, but let the test own these snapshots.
      if (frame.type !== 'event' || !['system:health', 'config:changed', 'task:created', 'host:status'].includes(frame.name)) ws.send(message);
    });
  });
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  // A cold Vite load previously missed 30s and passed only on retry.
  await expect(page.getByTestId('ask-walnut-slot')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => !!socket, { timeout: 60_000 }).toBe(true);
  return {
    async reload() {
      const previous = socket;
      await page.reload();
      // HTTP health can paint before the replacement WebSocket is ready.
      await expect.poll(() => !!socket && socket !== previous, { timeout: 60_000 }).toBe(true);
    },
    push(name: 'system:health' | 'host:status' | 'config:changed' | 'task:created', data: unknown) {
      expect(socket, 'the real SPA WebSocket is connected').toBeDefined();
      socket!.send(JSON.stringify({ type: 'event', name, data, seq: Date.now() }));
    },
  };
}

type FoundHosts = NonNullable<Config['hosts']>;
type FoundAnswer = { host: string; answer: 'yes' | 'not_now' };
const connectionError = 'Could not reach this computer. Check its SSH address, then try again.';
const connectSteps = [
  ['ssh', 'SSH'], ['probe', 'Probe'], ['install-runtime', 'Install runtime'],
  ['upload', 'Upload daemon'], ['start', 'Start daemon'], ['tunnel', 'Tunnel'], ['handshake', 'Handshake'],
] as const;

function hostStatus(host: string, def: FoundHosts[string], phase: HostStatus['phase']): HostStatus {
  const active = phase === 'failed' ? 0 : connectSteps.findIndex(([step]) => step === phase);
  return {
    host, label: def.label ?? host, hostname: def.hostname, discovered: true,
    connected: phase === 'connected', phase,
    phaseLabel: phase === 'install-runtime' ? 'Installing the session daemon runtime' : `Connection: ${phase}`,
    steps: connectSteps.map(([step, label], i) => ({
      phase: step, label,
      status: phase === 'connected' || i < active ? 'done' : i === active ? 'active' : 'todo',
    })),
    phaseElapsedMs: 0, connectElapsedMs: 0, at: Date.now(),
    ...(phase === 'connected' ? { connectedAt: Date.now() } : {}),
    ...(phase === 'failed' ? { error: connectionError, hint: connectionError, retryable: true } : {}),
  };
}

async function mockFoundHosts(page: Page, opts: {
  count?: number;
  answerPhase?: 'ssh' | 'failed' | 'connected';
  holdAnswer?: Promise<void>;
} = {}) {
  const hosts: FoundHosts = Object.fromEntries(Array.from({ length: opts.count ?? 2 }, (_, i) => {
    const host = `devbox-${i + 1}`;
    return [host, {
      hostname: `${host}.example`,
      label: `Development computer ${i + 1} for application builds, integration checks and long-running experiments`,
      discovered: true, connect: 'ask', enabled: false,
    }];
  }));
  const answers: FoundAnswer[] = [];
  const connects: string[] = [];
  const installs: string[] = [];
  const statuses: Record<string, HostStatus> = Object.fromEntries(
    Object.entries(hosts).map(([host, def]) => [host, hostStatus(host, def, 'off')]),
  );
  let nextConfigRead: { requested: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  await page.route('**/api/system/health', route => route.fulfill({ json: missing }));
  await page.route('**/api/hosts/status', route => route.fulfill({ json: { hosts: Object.values(statuses) } }));
  await page.route(url => url.pathname === '/api/config', async route => {
    const hold = nextConfigRead;
    nextConfigRead = undefined;
    const response = await route.fetch();
    const body = await response.json();
    // Snapshot before waiting: this GET can answer after a newer consent POST.
    const snapshot = { ...body, config: { ...body.config, hosts: structuredClone(hosts) } };
    hold?.requested.resolve();
    if (hold) await hold.release.promise;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route('**/api/hosts/*/found-answer', async route => {
    expect(route.request().method()).toBe('POST');
    const host = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    const { answer } = route.request().postDataJSON() as Pick<FoundAnswer, 'answer'>;
    answers.push({ host, answer });
    if (opts.holdAnswer) await opts.holdAnswer;
    hosts[host] = { ...hosts[host], connect: answer, enabled: answer === 'yes' };
    statuses[host] = hostStatus(host, hosts[host], answer === 'yes' ? opts.answerPhase ?? 'ssh' : 'off');
    await route.fulfill({ json: { ok: true, host, answer, status: statuses[host] } });
  });
  await page.route('**/api/hosts/*/connect', async route => {
    expect(route.request().method()).toBe('POST');
    const host = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    connects.push(host);
    if (route.request().postDataJSON()?.agents === true) {
      installs.push(host);
      const fixing = { action: 'install-claude-native', text: 'Installing Claude Code', startedAt: Date.now() };
      statuses[host] = {
        ...statuses[host], at: Date.now(),
        readiness: {
          ...statuses[host].readiness, fixing,
          problems: statuses[host].readiness!.problems!.map(problem => ({
            ...problem, fix: { action: fixing.action, state: 'running', text: fixing.text },
          })),
        },
      };
    } else {
      statuses[host] = hostStatus(host, hosts[host], 'ssh');
    }
    await route.fulfill({ json: { ok: true, status: statuses[host] } });
  });
  return {
    hosts, answers, connects, installs, statuses,
    holdNextConfigRead() {
      const hold = { requested: deferred(), release: deferred() };
      nextConfigRead = hold;
      return hold;
    },
  };
}

const prompts = (page: Page) => page.getByTestId('found-host-prompts');
// The question row for a host. Not now turns it into a one-line note in its place
// (found-host-not-now), which says the host stays off and how to connect it later.
const foundRow = (page: Page, host: string) => prompts(page).locator(`li[data-host="${host}"]:not(.found-host-not-now)`);
const notNowRow = (page: Page, host: string) => prompts(page).locator(`li.found-host-not-now[data-host="${host}"]`);
const taskPanelToggle = (page: Page) => page.locator('.sidebar-home-panels .app-task-panel-toggle');

// Acceptance: fresh setup, 20 long labels, isolated answers, duplicate clicks,
// late config reads, and consented progress/failure after reload and panel remount.
// Only UI regression coverage: no real SSH, installer, Main session or production writes.
test.setTimeout(120_000);
test.afterEach(async ({ page }) => { await dropFakes(page); });

test('fresh install shows one setup action, restores progress and retries a failed install', async ({ page, baseURL }) => {
  let health = setupHealth();
  const fixes: unknown[] = [];
  await page.route('**/api/system/health', route => route.fulfill({ json: health }));
  await page.route('**/api/system/local-claude/check', route => route.fulfill({ json: { localClaude: health.localClaude } }));
  await page.route('**/api/system/local-claude/fix', async route => {
    expect(route.request().method()).toBe('POST');
    fixes.push(route.request().postDataJSON());
    health = setupHealth({ action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' });
    await route.fulfill({ status: 202, json: { localClaude: health.localClaude } });
    events.push('system:health', health);
  });
  const events = await openFresh(page, baseURL!);
  const setup = page.getByTestId('first-use-setup');
  await expect(setup).toBeVisible({ timeout: 30_000 });
  await expect(setup.getByRole('heading', { name: 'Welcome to Walnut' })).toBeVisible();
  await expect(setup.getByRole('button', { name: 'Install Claude Code', exact: true })).toBeVisible();
  await expect(setup.getByRole('button', { name: /Fix with agent/ })).toHaveCount(0);
  await expect(page.getByTestId('ask-walnut-main-draft')).toHaveCount(0);
  await expect(setup.getByRole('button', { name: 'Use an API key or another provider' })).not.toBeVisible();
  await setup.getByText('Other ways to connect', { exact: true }).click();
  await expect(setup.getByRole('button', { name: 'Use an API key or another provider' })).toBeVisible();
  await setup.getByRole('button', { name: 'Install Claude Code', exact: true }).click();
  await expect(setup.getByRole('progressbar')).toBeVisible();
  await events.reload();
  await expect(setup.getByRole('progressbar')).toBeVisible({ timeout: 60_000 });
  await expect(setup).toContainText('Installing Claude Code');
  const progress = setup.getByRole('progressbar');
  await expect(progress).not.toHaveAttribute('aria-valuenow');
  const fill = await progress.locator('.setup-progress-fill').evaluate(element => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, background: style.backgroundColor };
  });
  expect(fill.height, 'the unknown-progress fill has a painted height').toBeGreaterThan(0);
  expect(fill.background).not.toBe('transparent');
  expect(fill.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(fixes).toEqual([{ kind: 'claude_missing' }]);

  health = setupHealth({ action: 'install-claude-native', state: 'failed', text: 'Claude Code download failed: connection timed out.' });
  events.push('system:health', health);
  await expect(setup.getByTestId('setup-banner-fix-failed')).toContainText('Claude Code download failed: connection timed out.');
  await expect(setup.getByRole('progressbar')).toHaveCount(0);
  await events.reload();
  await expect(setup.getByRole('button', { name: 'Try again', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByTestId('setup-banner-fix-failed')).toContainText('connection timed out');
  await setup.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(setup.getByRole('progressbar')).toBeVisible();
  await expect(setup.getByTestId('setup-banner-fix-failed')).toHaveCount(0);
  expect(fixes).toEqual([{ kind: 'claude_missing' }, { kind: 'claude_missing' }]);
});

test('Home keeps 20 long-label hosts unanswered and answering one leaves every other question intact', async ({ page, baseURL }) => {
  const fixture = await mockFoundHosts(page, { count: 20 });
  await openFresh(page, baseURL!);
  await expect(prompts(page).locator('li[data-host]')).toHaveCount(20);
  for (const [host, def] of Object.entries(fixture.hosts)) {
    const row = foundRow(page, host);
    await expect(row.getByText(`Connect to ${def.label}?`, { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Not now', exact: true })).toBeEnabled();
  }
  expect(fixture.answers).toEqual([]);
  expect(fixture.connects).toEqual([]);

  await foundRow(page, 'devbox-10').getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(foundRow(page, 'devbox-10')).toHaveCount(0);
  await expect(notNowRow(page, 'devbox-10')).toBeVisible();
  await expect(prompts(page).locator('li[data-host]:not(.found-host-not-now)')).toHaveCount(19);
  await expect(prompts(page).getByRole('button', { name: 'Connect', exact: true })).toHaveCount(19);
  for (const [host, def] of Object.entries(fixture.hosts)) {
    if (host !== 'devbox-10') await expect(foundRow(page, host)).toContainText(`Connect to ${def.label}?`);
  }
  await foundRow(page, 'devbox-20').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(foundRow(page, 'devbox-20').getByRole('progressbar')).toBeVisible();
  await expect(prompts(page).getByRole('button', { name: 'Connect', exact: true })).toHaveCount(18);
  expect(fixture.answers).toEqual([{ host: 'devbox-10', answer: 'not_now' }, { host: 'devbox-20', answer: 'yes' }]);
  expect(fixture.connects).toEqual([]);
});

test('double-clicking Connect sends one consent POST and does not answer another host', async ({ page, baseURL }) => {
  const heldAnswer = deferred();
  const fixture = await mockFoundHosts(page, { holdAnswer: heldAnswer.promise });
  try {
    await openFresh(page, baseURL!);
    const row = foundRow(page, 'devbox-1');
    await row.getByRole('button', { name: 'Connect', exact: true }).dblclick();
    await expect.poll(() => fixture.answers).toEqual([{ host: 'devbox-1', answer: 'yes' }]);
    await expect(row.getByRole('progressbar')).toBeVisible();
    await expect(foundRow(page, 'devbox-2').getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    const answered = page.waitForResponse(response => response.url().endsWith('/devbox-1/found-answer'));
    heldAnswer.resolve();
    await answered;
    await foundRow(page, 'devbox-2').getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(foundRow(page, 'devbox-2')).toHaveCount(0);
    await expect(notNowRow(page, 'devbox-2')).toBeVisible();
    expect(fixture.answers).toEqual([{ host: 'devbox-1', answer: 'yes' }, { host: 'devbox-2', answer: 'not_now' }]);
    expect(fixture.connects).toEqual([]);
  } finally {
    heldAnswer.resolve();
  }
});

test('a failed found-answer status survives reload and Try again uses connect rather than repeating consent', async ({ page, baseURL }) => {
  const fixture = await mockFoundHosts(page, { answerPhase: 'failed' });
  await openFresh(page, baseURL!);
  const row = foundRow(page, 'devbox-1');
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(row.getByRole('alert')).toHaveText(connectionError);
  await expect(row.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(row.getByRole('progressbar')).toHaveCount(0);
  expect(fixture.hosts['devbox-1'].connect).toBe('yes');
  expect(fixture.statuses['devbox-1'].phase).toBe('failed');

  const hydrated = page.waitForResponse(response => response.url().endsWith('/api/hosts/status'));
  await page.reload();
  expect((await (await hydrated).json()).hosts).toContainEqual(fixture.statuses['devbox-1']);
  await expect(row.getByRole('button', { name: 'Try again', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(row.getByRole('alert')).toHaveText(connectionError);
  // A failed host can still be put aside, as a found one can.
  await expect(row.getByRole('button', { name: 'Not now', exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row.getByRole('progressbar')).toBeVisible();
  await expect(row.getByRole('alert')).toHaveCount(0);
  expect(fixture.answers).toEqual([{ host: 'devbox-1', answer: 'yes' }]);
  expect(fixture.connects).toEqual(['devbox-1']);
  await expect(foundRow(page, 'devbox-2')).toContainText(`Connect to ${fixture.hosts['devbox-2'].label}?`);
});

for (const phase of ['install-runtime', 'failed'] as const) {
  test(`consented ${phase} status survives task-panel remount without asking again`, async ({ page, baseURL }) => {
    const fixture = await mockFoundHosts(page);
    const events = await openFresh(page, baseURL!);
    await foundRow(page, 'devbox-1').getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.poll(() => fixture.hosts['devbox-1'].connect).toBe('yes');
    fixture.statuses['devbox-1'] = hostStatus('devbox-1', fixture.hosts['devbox-1'], phase);
    events.push('host:status', fixture.statuses['devbox-1']);
    // The consent route also announces config:changed; remount must read that saved yes,
    // not the shared pre-consent GET that other Home consumers may still hold.
    const consentConfig = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config');
    events.push('config:changed', {});
    expect((await (await consentConfig).json()).config.hosts['devbox-1'].connect).toBe('yes');
    const row = foundRow(page, 'devbox-1');
    if (phase === 'failed') await expect(row.getByRole('alert')).toHaveText(connectionError);
    else await expect(row.getByRole('progressbar')).toHaveAccessibleName(/Installing the session daemon runtime/);

    // MainPage mounts this component in a different place when the task panel hides.
    await taskPanelToggle(page).click();
    await expect(taskPanelToggle(page)).toHaveAttribute('aria-expanded', 'false');
    if (phase === 'failed') {
      await expect(row.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await expect(row.getByRole('alert')).toHaveText(connectionError);
    } else {
      await expect(row.getByRole('progressbar')).toHaveAccessibleName(/Installing the session daemon runtime/);
    }
    await expect(row.getByRole('button', { name: 'Not now', exact: true })).toHaveCount(phase === 'failed' ? 1 : 0);
    await taskPanelToggle(page).click();
    await expect(taskPanelToggle(page)).toHaveAttribute('aria-expanded', 'true');
    if (phase === 'failed') await expect(row.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    else await expect(row.getByRole('progressbar')).toBeVisible();
    await page.reload();
    if (phase === 'failed') {
      await expect(row.getByRole('button', { name: 'Try again', exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(row.getByRole('alert')).toHaveText(connectionError);
    } else {
      await expect(row.getByRole('progressbar')).toBeVisible({ timeout: 60_000 });
      await expect(row.getByRole('progressbar')).toHaveAccessibleName(/Installing the session daemon runtime/);
    }
    expect(fixture.answers).toEqual([{ host: 'devbox-1', answer: 'yes' }]);
    expect(fixture.connects).toEqual([]);
  });
}

test('a connected found host still asks for engine setup and disappears only after readiness clears', async ({ page, baseURL }) => {
  const fixture = await mockFoundHosts(page, { answerPhase: 'connected' });
  const events = await openFresh(page, baseURL!);
  const row = foundRow(page, 'devbox-1');
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(row.getByRole('progressbar')).toHaveAccessibleName(`Checking ${fixture.hosts['devbox-1'].label}...`);
  expect(fixture.installs).toEqual([]);

  fixture.statuses['devbox-1'] = {
    ...fixture.statuses['devbox-1'], at: Date.now(),
    readiness: {
      checkedAt: Date.now(), claude: { found: true, kind: 'npm', installMethod: 'npm' },
      problems: [{
        kind: 'claude_needs_node',
        message: 'Claude Code on this computer needs Node.js. Install the native build instead.',
        commands: ['curl -fsSL https://claude.ai/install.sh | bash'],
      }],
    },
  };
  events.push('host:status', fixture.statuses['devbox-1']);
  // The row offers the fix itself; the command by hand and Check again fold under Install by hand
  // (RemoteHostReadiness ByHand: the button names the fix, so the row shows no problem text).
  const install = row.getByRole('button', { name: `Install Claude Code on ${fixture.hosts['devbox-1'].label}`, exact: true });
  await expect(install).toBeVisible();
  await row.getByRole('button', { name: 'Install by hand' }).click();
  await expect(row).toContainText('claude.ai/install.sh');
  await expect(row.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
  expect(fixture.installs, 'a daemon connection never silently installs an engine').toEqual([]);
  await install.click();
  await expect.poll(() => fixture.installs).toEqual(['devbox-1']);
  await expect(row.getByRole('progressbar')).toHaveAccessibleName(/Installing Claude Code/);
  await expect(row.getByRole('button', { name: /^(Install|Update) Claude Code on / })).toHaveCount(0);
  await events.reload();
  await expect(row.getByRole('progressbar')).toHaveAccessibleName(/Installing Claude Code/, { timeout: 60_000 });

  const finishedAt = Math.max(Date.now(), fixture.statuses['devbox-1'].readiness!.fixing!.startedAt! + 1);
  fixture.statuses['devbox-1'] = {
    ...fixture.statuses['devbox-1'], at: finishedAt,
    readiness: { checkedAt: finishedAt, claude: { found: true, installMethod: 'native', auth: 'unknown' }, problems: [] },
  };
  events.push('host:status', fixture.statuses['devbox-1']);
  await expect(row).toContainText('could not confirm the Claude Code sign-in');
  await expect(row).toContainText('If you have not signed in');
  await expect(row).not.toContainText('is ready');
  await expect(row.getByRole('button', { name: /^(Install|Update) Claude Code on / })).toHaveCount(0);
  await events.reload();
  await expect(row.getByRole('button', { name: 'Check again', exact: true })).toBeVisible({ timeout: 60_000 });
  let checks = 0;
  await page.route('**/api/hosts/*/check', async route => {
    checks++;
    await route.fulfill({ status: 503, json: { error: 'The sign-in check timed out.' } });
  });
  await row.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect.poll(() => checks).toBe(1);
  await expect(row).toContainText('could not confirm');
  await expect(row.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  fixture.statuses['devbox-1'] = {
    ...fixture.statuses['devbox-1'], at: finishedAt + 1,
    readiness: { checkedAt: finishedAt + 1, claude: { found: true, installMethod: 'native', auth: 'ok' }, problems: [] },
  };
  events.push('host:status', fixture.statuses['devbox-1']);
  await expect(row).toHaveCount(0);
  expect(fixture.answers).toEqual([{ host: 'devbox-1', answer: 'yes' }]);
  expect(fixture.connects).toEqual(['devbox-1']);
  expect(fixture.installs).toEqual(['devbox-1']);
  await expect(foundRow(page, 'devbox-2').getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
});

test('a found host with no readiness answer stops waiting and keeps a retry after reload', async ({ page, baseURL }) => {
  const fixture = await mockFoundHosts(page, { answerPhase: 'connected' });
  const events = await openFresh(page, baseURL!);
  const row = foundRow(page, 'devbox-1');
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(row.getByRole('progressbar')).toBeVisible();
  fixture.statuses['devbox-1'] = { ...fixture.statuses['devbox-1'], connectedAt: Date.now() - 60_000, at: Date.now() };
  events.push('host:status', fixture.statuses['devbox-1']);
  await expect(row.getByRole('progressbar')).toHaveCount(0);
  await expect(row).toContainText('This host may need a daemon update.');
  await events.reload();
  await expect(row.getByRole('button', { name: 'Check again', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.route('**/api/hosts/*/check', route => route.fulfill({ status: 503, json: { error: 'The check timed out.' } }));
  await row.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(row.getByRole('alert')).toHaveText('The check could not finish. Try again.');
  await expect(row.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  fixture.statuses['devbox-1'] = {
    ...fixture.statuses['devbox-1'], at: Date.now(),
    readiness: { checkedAt: Date.now(), claude: { found: false, unknown: 'The login shell timed out.' }, problems: [] },
  };
  events.push('host:status', fixture.statuses['devbox-1']);
  await expect(row).toContainText('The login shell timed out.');
  await expect(row).not.toContainText('is ready');
  await expect(row.getByRole('button', { name: /^(Install|Update) Claude Code on / })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
  await events.reload();
  await expect(row).toContainText('The login shell timed out.', { timeout: 60_000 });
  fixture.statuses['devbox-1'] = {
    ...fixture.statuses['devbox-1'], at: Date.now(),
    readiness: { checkedAt: Date.now(), claude: { found: false, auth: 'unknown' }, problems: [], checkError: 'The first readiness check timed out.' },
  };
  events.push('host:status', fixture.statuses['devbox-1']);
  await expect(row).toContainText('The first readiness check timed out.');
  await expect(row.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
});

test('a config read started before Not now cannot bring the answered question back', async ({ page, baseURL }) => {
  const fixture = await mockFoundHosts(page);
  const events = await openFresh(page, baseURL!);
  await expect(foundRow(page, 'devbox-1').getByRole('button', { name: 'Not now', exact: true })).toBeVisible();
  const heldConfig = fixture.holdNextConfigRead();
  try {
    events.push('config:changed', {});
    await heldConfig.requested.promise;
    // Consent now starts its own fresh GET: distinguish the two replies by their snapshot,
    // not the shared URL, and let the fresh answer land before releasing the older one.
    const freshResponse = page.waitForResponse(async response =>
      new URL(response.url()).pathname === '/api/config'
      && (await response.json()).config.hosts['devbox-1'].connect === 'not_now');
    const staleResponse = page.waitForResponse(async response =>
      new URL(response.url()).pathname === '/api/config'
      && (await response.json()).config.hosts['devbox-1'].connect === 'ask');
    await foundRow(page, 'devbox-1').getByRole('button', { name: 'Not now', exact: true }).click();
    await freshResponse;
    await expect(foundRow(page, 'devbox-1')).toHaveCount(0);
    heldConfig.release.resolve();
    const response = await staleResponse;
    expect((await response.json()).config.hosts['devbox-1'].connect).toBe('ask');
    await response.finished();
    // Give fetch/React the next paints before the negative assertion; no fixed sleep.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(foundRow(page, 'devbox-1')).toHaveCount(0);
    await expect(foundRow(page, 'devbox-2')).toContainText(`Connect to ${fixture.hosts['devbox-2'].label}?`);
    expect(fixture.answers).toEqual([{ host: 'devbox-1', answer: 'not_now' }]);
    expect(fixture.connects).toEqual([]);
  } finally {
    heldConfig.release.resolve();
  }
});

const readyForMain: SystemHealth = {
  hasReadyProvider: true, claudeCliAvailable: true, claudeCodeNeeded: true,
  localClaude: { checkedAt: 1, claude: { found: true, auth: 'ok' }, problems: [] },
};

async function mockFirstMain(page: Page, initial: SystemHealth, orgOn = true) {
  const at = new Date().toISOString();
  const main: Task = {
    id: 'first-use-main', title: 'CEO', org_role: 'main', walnut_agent: true,
    status: 'todo', priority: 'none', project: 'Ask Walnut', phase: 'TODO',
    session_ids: [], description: '', summary: '', note: '', source: 'local', created_at: at, updated_at: at,
  };
  let health = initial;
  let enabled = orgOn;
  const ensures: string[] = [];
  const starts: Array<{ auto: boolean }> = [];
  const launches: Array<{ taskId: string; message: string }> = [];
  const checks: Array<{ poll: boolean }> = [];
  const checkReply = deferred();
  await page.route('**/api/system/health', route => route.fulfill({ json: health }));
  await page.route('**/api/hosts/status', route => route.fulfill({ json: { hosts: [] } }));
  await page.route(url => url.pathname === '/api/config', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, config: { ...body.config, hosts: {}, org: { ...body.config.org, enabled } } } });
  });
  await page.route('**/api/v1/org/settings', route => route.fulfill({ json: { name: 'Org', founderTitle: 'Founder', enabled } }));
  await page.route('**/api/v1/org/main', async route => {
    ensures.push(route.request().method());
    await route.fulfill({ json: { task: main } });
  });
  await page.route('**/api/v1/org/nodes/*/start', async route => {
    starts.push(route.request().postDataJSON());
    await route.fulfill({ json: { queued: true } });
  });
  // A failed background start is retried by sending from the CEO draft; this path
  // must also be stubbed or a test could create a real fixture session.
  await page.route('**/api/sessions/quick-start', async route => {
    launches.push(route.request().postDataJSON());
    await route.fulfill({ json: { taskId: main.id, task: main, preparing: true } });
  });
  await page.route('**/api/system/local-claude/check', async route => {
    checks.push(route.request().postDataJSON());
    await checkReply.promise;
    await route.fulfill({ status: 503, json: { error: 'The sign-in check could not finish. Try again.' } });
  });
  return {
    main, ensures, starts, launches, checks, releaseCheck: checkReply.resolve,
    setHealth(next: SystemHealth) { health = next; },
    setOrgEnabled(next: boolean) { enabled = next; },
  };
}

test('first Main waits for confirmed sign-in, shows queued progress and accepts a message retry after a failed start', async ({ page, baseURL }) => {
  const noProbe: SystemHealth = { hasReadyProvider: true, claudeCliAvailable: true, claudeCodeNeeded: true };
  const fixture = await mockFirstMain(page, noProbe);
  try {
    const events = await openFresh(page, baseURL!);
    const setup = page.getByTestId('first-use-setup');
    await expect(setup.getByRole('progressbar')).toHaveAccessibleName('Checking your AI...');
    expect(fixture.ensures).toEqual([]);
    expect(fixture.starts).toEqual([]);
    const unknown: SystemHealth = {
      ...readyForMain, localClaude: {
        ...readyForMain.localClaude!, claude: { found: false, auth: 'unknown' },
        checkError: 'The first sign-in check timed out.',
      },
    };
    fixture.setHealth(unknown);
    events.push('system:health', unknown);
    await expect(setup).toContainText('Walnut could not confirm your AI sign-in.');
    await expect(setup.getByRole('progressbar')).toHaveCount(0);
    await expect(setup.getByRole('alert')).toHaveText('The first sign-in check timed out.');
    await expect(page.getByTestId('ask-walnut-main-draft')).toHaveCount(0);
    await setup.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect.poll(() => fixture.checks).toEqual([{ poll: false }]);
    await expect(setup.getByRole('progressbar')).toHaveAccessibleName('Checking your AI...');
    fixture.releaseCheck();
    await expect(setup.getByRole('alert').last()).toHaveText('The sign-in check could not finish. Try again.');
    const installedUnknown: SystemHealth = {
      ...unknown, localClaude: { ...unknown.localClaude!, claude: { found: true, auth: 'unknown' }, checkError: undefined },
    };
    fixture.setHealth(installedUnknown);
    events.push('system:health', installedUnknown);
    await expect(setup).toContainText('If you have not signed in');
    await expect(setup.locator('code')).toHaveText('claude auth login');
    await expect(setup.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
    await expect(setup.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
    expect(fixture.ensures).toEqual([]);
    expect(fixture.starts).toEqual([]);

    fixture.setHealth(readyForMain);
    events.push('system:health', readyForMain);
    await expect.poll(() => fixture.ensures).toEqual(['POST']);
    await expect.poll(() => fixture.starts).toEqual([{ auto: true }]);
    const starting = page.getByTestId('ask-walnut-main-starting');
    await expect(starting.getByRole('progressbar')).toHaveAccessibleName('Starting the CEO...');
    await expect(page.getByTestId('ask-walnut-main-draft')).toHaveCount(0);
    await expect(setup).toHaveCount(0);
    // Repeated health and config events must not enqueue a second start.
    events.push('system:health', readyForMain);
    const settingsRead = page.waitForResponse(response => response.url().endsWith('/api/v1/org/settings'));
    events.push('config:changed', {});
    await settingsRead;
    fixture.main.org_start = { state: 'failed', at: new Date().toISOString(), error: 'The session host did not answer.' };
    events.push('task:created', { task: fixture.main });
    const draft = page.getByTestId('ask-walnut-main-draft');
    await expect(draft.getByRole('alert')).toContainText('The session host did not answer.');
    await expect(draft.getByRole('alert')).toContainText('Send your message to try again.');
    await expect(starting).toHaveCount(0);
    expect(fixture.ensures).toEqual(['POST']);
    expect(fixture.starts).toEqual([{ auto: true }]);
    const message = 'Please retry the first conversation.';
    await draft.locator('.chat-input-textarea').fill(message);
    await draft.locator('.chat-input-textarea').press('Enter');
    await expect.poll(() => fixture.launches.map(({ taskId, message }) => ({ taskId, message })))
      .toEqual([{ taskId: fixture.main.id, message }]);
    await expect(page.getByTestId('ask-walnut-pending')).toHaveCount(0);
    expect(fixture.ensures).toEqual(['POST', 'POST']);
    expect(fixture.starts).toEqual([{ auto: true }]);
  } finally {
    fixture.releaseCheck();
  }
});

test('first Main stays off while Org is disabled and starts once after settings are read again', async ({ page, baseURL }) => {
  const fixture = await mockFirstMain(page, readyForMain, false);
  const settingsRead = page.waitForResponse(response => response.url().endsWith('/api/v1/org/settings'));
  const events = await openFresh(page, baseURL!);
  expect((await (await settingsRead).json()).enabled).toBe(false);
  await expect(page.getByTestId('ask-walnut-main-draft')).toBeVisible();
  await expect(page.getByTestId('ask-walnut-main-starting')).toHaveCount(0);
  expect(fixture.ensures).toEqual([]);
  expect(fixture.starts).toEqual([]);
  fixture.setOrgEnabled(true);
  const enabledRead = page.waitForResponse(async response => response.url().endsWith('/api/v1/org/settings') && (await response.json()).enabled === true);
  events.push('config:changed', {});
  await enabledRead;
  await expect.poll(() => fixture.ensures).toEqual(['POST']);
  await expect.poll(() => fixture.starts).toEqual([{ auto: true }]);
  await expect(page.getByTestId('ask-walnut-main-starting').getByRole('progressbar')).toHaveAccessibleName('Starting the CEO...');
  await expect(page.getByTestId('ask-walnut-main-draft')).toHaveCount(0);
  const unchangedRead = page.waitForResponse(response => response.url().endsWith('/api/v1/org/settings'));
  events.push('config:changed', {});
  await unchangedRead;
  expect(fixture.ensures).toEqual(['POST']);
  expect(fixture.starts).toEqual([{ auto: true }]);
});
