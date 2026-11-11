/**
 * First-run setup (web/src/components/first-run/): a fresh install opens with "Add your other
 * machines", the hosts of ~/.ssh/config each with Add. Add connects it and the row says so; a
 * host that asks for a password is walked through in place (ssh-copy-id), with Try again; Done,
 * Not now and Escape record the answer, so it never comes back; an existing install never sees
 * it; Settings › Remote Hosts › Add host › Pick from your SSH config opens it again and records
 * nothing; "Add a machine that is not listed" opens a new SSH row in Settings.
 *
 * The fixture server is an existing install (its config.yaml is written before boot), so the
 * question and the found hosts are laid over its answers here; nothing is written to its data.
 * The existing-install case reads the fixture server's own answer.
 * WebKit: `PW_WEBKIT=1 bun x playwright test first-run --project=webkit --workers=1`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { dropFakes } from './route-teardown'

test.setTimeout(180_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/wn-first-run'

interface Fake {
  pending: string[];
  answers: string[];
  yes: string[];
  connects: string[];
  /** What a yes to each host answers as its status. */
  onYes: Record<string, (host: string) => Record<string, unknown>>;
  found: Record<string, Record<string, unknown>>;
  /** What GET /api/hosts/:host/ssh-key answers (the key ssh offers that host). */
  keys: Record<string, { path: string; exists: boolean } | null>;
}

const statusOf = (host: string, over: Record<string, unknown>) => ({
  host, label: host, hostname: `${host}.example.test`, connected: false, phase: 'idle', phaseLabel: '',
  steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: Date.now(), ...over,
});
const connected = (host: string) => statusOf(host, { connected: true, phase: 'connected', connectedAt: Date.now() });
const needsPassword = (host: string) => statusOf(host, {
  phase: 'failed', kind: 'auth', retryable: false,
  error: `sam@${host}.example.test: Permission denied (publickey,password,keyboard-interactive).`,
  hint: `Walnut runs \`ssh ${host}\` without a password prompt.`,
});

const notLinux = (host: string) => statusOf(host, {
  phase: 'failed', kind: 'not_linux', retryable: false,
  error: `${host} runs Darwin: Walnut sets up SSH hosts on Linux only`,
});

async function serve(page: Page, opts: { pending: string[] }): Promise<Fake> {
  const fake: Fake = {
    pending: [...opts.pending], answers: [], yes: [], connects: [], keys: {},
    onYes: { 'lab-mac': connected, 'home-pc': needsPassword, 'mac-mini': notLinux },
    found: {
      'lab-mac': { hostname: '10.0.0.9', user: 'sam', port: 2222, label: 'Lab Mac', discovered: true, connect: 'ask', enabled: false },
      'home-pc': { hostname: '10.0.0.12', discovered: true, connect: 'ask', enabled: false },
      'mac-mini': { hostname: '10.0.0.14', discovered: true, connect: 'ask', enabled: false },
    },
  };
  await page.route((url) => url.pathname === '/api/first-run', (route) => route.fulfill({ json: { pending: fake.pending } }));
  await page.route((url) => url.pathname === '/api/first-run/answer', async (route) => {
    const { step } = route.request().postDataJSON() as { step: string };
    fake.answers.push(step);
    fake.pending = fake.pending.filter((s) => s !== step);
    await route.fulfill({ json: { ok: true, pending: fake.pending } });
  });
  await page.route((url) => url.pathname === '/api/config', async (route: Route) => {
    if (route.request().method() !== 'GET') { await route.fulfill({ json: { ok: true } }); return; }
    const res = await route.fetch();
    const body = await res.json() as { config: { hosts?: Record<string, unknown> } };
    await route.fulfill({ response: res, json: { ...body, config: { ...body.config, hosts: { ...(body.config.hosts ?? {}), ...fake.found } } } });
  });
  await page.route('**/api/hosts/*/found-answer', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0]);
    const { answer } = route.request().postDataJSON() as { answer: string };
    if (answer === 'yes') fake.yes.push(host);
    fake.found[host] = { ...fake.found[host], connect: answer, enabled: answer === 'yes' };
    await route.fulfill({ json: { ok: true, host, answer, ...(answer === 'yes' ? { status: fake.onYes[host]?.(host) } : {}) } });
  });
  // Never the real `ssh -G` of the machine running the test.
  await page.route('**/api/hosts/*/ssh-key', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0]);
    await route.fulfill({ json: { key: fake.keys[host] ?? null } });
  });
  await page.route('**/api/hosts/*/connect', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0]);
    fake.connects.push(host);
    await route.fulfill({ json: { ok: true, status: connected(host) } });
  });
  return fake;
}

async function shot(page: Page, name: string, region: Locator) {
  mkdirSync(SHOTS, { recursive: true });
  const engine = page.context().browser()?.browserType().name() ?? 'browser';
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' });
}

test.afterEach(async ({ page }) => { await dropFakes(page); });

const dialog = (page: Page) => page.getByTestId('first-run-dialog');

test('an existing install never sees the setup', async ({ page }) => {
  // The page side: the server's answer of no question opens nothing. Which installs the server
  // asks (an empty data home only) is tested on a real server in tests/e2e/first-run-e2e.test.ts.
  const seen: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/first-run')) seen.push(r.url()); });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  await expect(dialog(page)).toHaveCount(0);
});

test('a fresh install: Add connects a host, Done records the answer, a reload asks nothing', async ({ page }) => {
  const fake = await serve(page, { pending: ['hosts'] });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await expect(dialog(page).getByRole('heading', { name: 'Add your other machines' })).toBeVisible();
  await expect(dialog(page).getByTestId('first-run-host-here')).toContainText('This computer');
  await expect(dialog(page).getByTestId('first-run-host-lab-mac')).toContainText('sam@10.0.0.9:2222');
  // One step: no step dots; the way out reads Not now until a host is added.
  await expect(dialog(page).locator('.fr-dots')).toHaveCount(0);
  await expect(page.getByTestId('first-run-primary')).toHaveText('Not now');
  // Focus starts on the dialog (nothing looks picked); Tab reaches the first Add, Enter adds it.
  await shot(page, 'open', dialog(page).locator('.fr-modal'));
  const order = () => dialog(page).locator('[data-testid^="first-run-host-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  const before = await order();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('first-run-add-lab-mac')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('first-run-state-lab-mac')).toHaveText('Connected');
  expect(fake.yes).toEqual(['lab-mac']);
  // The row stays where it was (the next Add is not slid under the pointer), and focus moves to that next Add.
  expect(await order()).toEqual(before);
  await expect(page.getByTestId('first-run-add-home-pc')).toBeFocused();
  await expect(page.getByTestId('first-run-primary')).toHaveText('Done');
  // Tab and Shift+Tab stay inside the dialog: the page under it is out of reach.
  for (const key of [...Array(8).fill('Tab'), ...Array(8).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.fr-modal')), key).toBe(true);
  }
  await shot(page, 'added', dialog(page).locator('.fr-modal'));
  // An outside click is not an answer.
  await page.mouse.click(5, 5);
  await expect(dialog(page)).toBeVisible();
  await page.getByTestId('first-run-primary').click();
  await expect(dialog(page)).toHaveCount(0);
  expect(fake.answers).toEqual(['hosts']);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1_500);
  await expect(dialog(page)).toHaveCount(0);
});

test('a host that asks for a password is walked through in place, and Try again connects it', async ({ page }) => {
  const fake = await serve(page, { pending: ['hosts'] });
  // The host's Host block names its own key, which exists: no ssh-keygen step, and the copy names it.
  fake.keys['home-pc'] = { path: '~/.ssh/home_pc', exists: true };
  await page.goto('/');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('first-run-add-home-pc').click();
  const failure = page.getByTestId('first-run-failure-home-pc');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('asks for a password');
  await expect(failure.getByTestId('first-run-command-home-pc-0')).toHaveText('ssh-copy-id -i ~/.ssh/home_pc home-pc');
  await expect(failure.getByTestId('first-run-command-home-pc-1')).toHaveCount(0);
  // Nothing connected yet: no Done; the footer says where the host waits.
  await expect(page.getByTestId('first-run-primary')).toHaveText('Close');
  await expect(page.getByTestId('first-run-later')).toContainText('Pick from your SSH config');
  // No raw ssh words on the card.
  await expect(failure).not.toContainText('Permission denied');
  await expect(failure).toContainText('home-pc needs a one-time setup');
  await expect(failure).not.toContainText('Could not connect');
  await shot(page, 'password', dialog(page).locator('.fr-modal'));
  await page.getByTestId('first-run-retry-home-pc').click();
  await expect(page.getByTestId('first-run-state-home-pc')).toHaveText('Connected');
  await expect(failure).toHaveCount(0);
  expect(fake.connects).toEqual(['home-pc']);
  await expect(page.getByTestId('first-run-primary')).toHaveText('Done');
});

test('Try again that fails again says it tried, so the click is never silent', async ({ page }) => {
  const fake = await serve(page, { pending: ['hosts'] });
  await page.route('**/api/hosts/*/connect', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0]);
    fake.connects.push(host);
    await route.fulfill({ json: { ok: true, status: needsPassword(host) } });
  });
  await page.goto('/');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('first-run-add-home-pc').click();
  await page.getByTestId('first-run-retry-home-pc').click();
  await expect(page.getByTestId('first-run-retry-home-pc')).toHaveText('Trying…');
  await expect(page.getByTestId('first-run-tried-home-pc')).toContainText('Still not connected');
  await expect(page.getByTestId('first-run-retry-home-pc')).toHaveText('Try again');
  expect(fake.connects).toEqual(['home-pc']);
  // A reload keeps it: the host is added (its yes is in the config) and has not connected, so still Close, not Not now.
  await page.reload();
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('first-run-primary')).toHaveText('Close');
});

test('"Don\'t add it" on a host that could not connect gives it its Add back', async ({ page }) => {
  const fake = await serve(page, { pending: ['hosts'] });
  await page.goto('/');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('first-run-add-home-pc').click();
  await page.getByTestId('first-run-undo-home-pc').click();
  await expect(page.getByTestId('first-run-failure-home-pc')).toHaveCount(0);
  await expect(page.getByTestId('first-run-add-home-pc')).toBeVisible();
  await expect(page.getByTestId('first-run-primary')).toHaveText('Not now');
  expect(fake.found['home-pc']).toMatchObject({ connect: 'not_now' });
});

test('Escape is Not now: recorded, and the dialog is gone', async ({ page }) => {
  const fake = await serve(page, { pending: ['hosts'] });
  await page.goto('/');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  expect(fake.answers).toEqual(['hosts']);
  expect(fake.yes).toEqual([]);
});

test('Settings › Remote Hosts opens it again, and "not listed" opens a new SSH row', async ({ page }) => {
  const fake = await serve(page, { pending: [] });
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('link', { name: /settings/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('settings-nav-remote-hosts').click();
  await page.getByTestId('remote-hosts-add').click();
  await page.getByTestId('remote-hosts-add-menu').getByText('Pick from your SSH config').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.app-modal-title')).toHaveText('Remote Hosts');
  // Nothing connected from here: Close (Done only once a host connects), and no "add them later" line.
  await expect(page.getByTestId('first-run-primary')).toHaveText('Close');
  await expect(page.getByTestId('first-run-later')).toHaveText('Hosts you add here show in Remote Hosts.');
  await page.getByTestId('first-run-add-by-hand').click();
  await expect(dialog(page)).toHaveCount(0);
  // The picker records nothing, and the Remote Hosts page has a new SSH row open.
  expect(fake.answers).toEqual([]);
  await expect(page.getByTestId('remote-hosts-list').getByRole('textbox', { name: 'Hostname' })).toBeFocused({ timeout: 10_000 });
});

test('a machine that is not Linux (another Mac) says so and how to add it, with no Try again', async ({ page }) => {
  await serve(page, { pending: ['hosts'] });
  await page.goto('/');
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('first-run-add-mac-mini').click();
  const failure = page.getByTestId('first-run-failure-mac-mini');
  await expect(failure).toContainText('mac-mini is not a Linux machine');
  await expect(failure).toContainText('Join a machine with a link');
  await expect(page.getByTestId('first-run-retry-mac-mini')).toHaveCount(0);
  await expect(page.getByTestId('first-run-undo-mac-mini')).toBeVisible();
  await shot(page, 'not-linux', dialog(page).locator('.fr-modal'));
});
