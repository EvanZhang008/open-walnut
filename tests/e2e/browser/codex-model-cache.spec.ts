import fs from 'node:fs/promises';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { draftModelPill, draftQuickChipFor, openDraft } from './draft-helpers';
import { isolateUiPrefs } from './todo-panel-helpers';

// Storage contract from web/src/api/engine-model-cache.ts, not a second cache implementation.
const CACHE_KEY = 'walnut:engine-model-catalogs:v1';
const SHOTS = '/tmp/walnut-codex-latency';
const CODEX_MODELS = {
  engine: 'codex', source: 'probe', currentModelId: 'neutral-balanced',
  models: [
    { modelId: 'neutral-balanced', name: 'Neutral Balanced' },
    { modelId: 'neutral-fast', name: 'Neutral Fast' },
    { modelId: 'neutral-careful', name: 'Neutral Careful' },
  ],
};

const picker = (page: Page) => page.locator('.model-picker');
const modelRows = (page: Page) => picker(page).getByRole('listbox', { name: 'Model', exact: true });
const model = (page: Page, name: string) => modelRows(page).getByRole('option').filter({
  has: page.locator('.model-picker-row-name').filter({ hasText: new RegExp(`^${name}$`) }),
});

async function loadHome(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error('The isolated Playwright fixture must provide baseURL');
  await page.evaluate((url) => { location.href = url; }, `${baseURL}/`);
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.new-launcher-btn')).toBeVisible();
}

async function openCodexPicker(page: Page, panel: Locator) {
  await draftModelPill(panel).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).locator('[data-provider="codex"]').click();
  await expect(picker(page).locator('[data-provider="codex"]')).toHaveAttribute('aria-selected', 'true');
}

async function expectCatalog(page: Page, names = ['Neutral Balanced', 'Neutral Fast', 'Neutral Careful']) {
  for (const name of names) await expect(model(page, name)).toBeVisible();
  await expect(picker(page).getByText(/^Loading .* models/)).toHaveCount(0);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await fs.mkdir(SHOTS, { recursive: true });
  await picker(page).screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` });
}

// Matrix: cold -> warm reopen -> reload; engine and cwd identity; stale hold ->
// usable selection -> honest failure -> successful Retry. No session is launched.
test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page);
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-home-chat-visible', 'false');
    sessionStorage.removeItem('open-walnut-home-session-columns');
    localStorage.removeItem('open-walnut-layout:home-columns');
  });
});

test('Codex catalog opens from New, reopens without a request, and survives a page reload', async ({ page, baseURL }, info) => {
  const calls: string[] = [];
  await page.route('**/api/engines/codex/models**', async (route) => {
    calls.push(route.request().url());
    await route.fulfill({ json: CODEX_MODELS });
  });
  await loadHome(page, baseURL);
  const panel = await openDraft(page);
  await openCodexPicker(page, panel);
  await expectCatalog(page);
  expect(calls).toHaveLength(1);
  const fetchedAt = await page.evaluate((key) => {
    const entry = JSON.parse(localStorage.getItem(key) ?? '{}').entries?.find(
      (row: { cwd?: string; catalog: { engine: string } }) => row.catalog.engine === 'codex' && row.cwd === undefined,
    );
    return entry?.fetchedAt as number | undefined;
  }, CACHE_KEY);
  expect(fetchedAt).toBeDefined();
  await picker(page).locator('.model-picker-close').click();
  await expect(picker(page)).toHaveCount(0);

  // A held server would not matter: these rows must render from the browser cache.
  const openedAt = Date.now();
  await draftModelPill(panel).click();
  await expect(model(page, 'Neutral Balanced')).toBeVisible({ timeout: 1_000 });
  await expectCatalog(page);
  expect(Date.now() - openedAt).toBeLessThan(1_000);
  expect(calls).toHaveLength(1);
  await screenshot(page, info, 'model-cache-warm');

  await page.reload();
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 });
  const reloadedDraft = await openDraft(page);
  await openCodexPicker(page, reloadedDraft);
  await expect(model(page, 'Neutral Balanced')).toBeVisible({ timeout: 1_000 });
  await expectCatalog(page);
  expect(Date.now() - fetchedAt!).toBeLessThan(30_000);
  expect(calls).toHaveLength(1);
  await screenshot(page, info, 'model-cache-reload');
});

test('an engine or cwd switch never borrows rows from the previous Codex target', async ({ page, baseURL }, info) => {
  const response = await page.request.get('/api/sessions/working-dirs');
  expect(response.ok()).toBe(true);
  const dirs = (await response.json()).dirs as Array<{ cwd: string }>;
  const first = dirs.find((dir) => /\/ps-fixture\/projects\/walnut$/.test(dir.cwd))?.cwd;
  if (!first) throw new Error('Missing isolated path-selector fixture');
  const second = first.replace(/\/walnut$/, '/wallets');
  await page.route('**/api/sessions/working-dirs', (route) => route.fulfill({ json: {
    dirs: [first, second].map((cwd, index) => ({ cwd, host: null, count: 20 - index, lastUsed: new Date().toISOString() })),
    hosts: [],
  } }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const heldCalls: string[] = [];
  await page.route('**/api/engines/codex/models**', async (route) => {
    const cwd = new URL(route.request().url()).searchParams.get('cwd');
    if (cwd === second) {
      heldCalls.push(route.request().url());
      await held;
      await route.fulfill({ json: {
        engine: 'codex', source: 'probe', currentModelId: 'folder-specific',
        models: [{ modelId: 'folder-specific', name: 'Folder Specific' }],
      } }).catch(() => undefined);
    } else await route.fulfill({ json: CODEX_MODELS });
  });
  try {
    await loadHome(page, baseURL);
    const panel = await openDraft(page);
    await expect(draftQuickChipFor(panel, first)).toBeVisible();
    await draftQuickChipFor(panel, first).click();
    await openCodexPicker(page, panel);
    await expectCatalog(page);
    await picker(page).locator('[data-provider="claude"]').click();
    await expect(picker(page).locator('[data-provider="claude"]')).toHaveAttribute('aria-selected', 'true');
    await expect(modelRows(page)).not.toContainText('Neutral Balanced');
    await expect(modelRows(page)).not.toContainText('Neutral Fast');
    await picker(page).locator('[data-provider="codex"]').click();
    await expectCatalog(page);
    await picker(page).locator('.model-picker-close').click();

    await draftQuickChipFor(panel, second).click();
    await draftModelPill(panel).click();
    await expect(picker(page).locator('[data-provider="codex"]')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => heldCalls.length).toBeGreaterThan(0);
    // Assert while the NEW request is held, not only after fresh rows replace old ones.
    await expect(modelRows(page)).not.toContainText('Neutral Balanced');
    await expect(modelRows(page)).not.toContainText('Neutral Fast');
    release();
    await expectCatalog(page, ['Folder Specific']);
    await screenshot(page, info, 'model-cache-cwd-isolation');
  } finally { release(); }
});

test('an engine configuration change invalidates the open Codex picker before a held fresh catalog arrives', async ({ page, baseURL }, info) => {
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname === '/ws') (window as any).__modelCacheWs = this;
      }
    } as typeof WebSocket;
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (!['prototype', 'length', 'name'].includes(key)) {
        try { (window.WebSocket as any)[key] = (Original as any)[key]; } catch { /* Read-only static property. */ }
      }
    }
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let changed = false;
  let refreshCalls = 0;
  await page.route('**/api/engines/codex/models**', async (route) => {
    if (!changed) return route.fulfill({ json: CODEX_MODELS });
    refreshCalls++;
    await held;
    await route.fulfill({ json: {
      engine: 'codex', source: 'probe', currentModelId: 'configured-new',
      models: [{ modelId: 'configured-new', name: 'Configured New' }],
    } }).catch(() => undefined);
  });
  try {
    await loadHome(page, baseURL);
    const panel = await openDraft(page);
    await openCodexPicker(page, panel);
    await expectCatalog(page);
    await page.waitForFunction(() => (window as any).__modelCacheWs?.readyState === WebSocket.OPEN);
    changed = true;
    await page.evaluate(() => {
      const socket = (window as any).__modelCacheWs as WebSocket;
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'event', name: 'config:changed', data: { key: 'engines' }, seq: Date.now(),
      }) }));
    });
    await expect.poll(() => refreshCalls).toBeGreaterThan(0);
    await expect(picker(page).locator('[data-provider="codex"]')).toHaveAttribute('aria-selected', 'true');
    await expect(modelRows(page)).not.toContainText('Neutral Balanced');
    await expect(modelRows(page)).not.toContainText('Neutral Fast');
    release();
    await expectCatalog(page, ['Configured New']);
    await expect(modelRows(page)).not.toContainText('Neutral Balanced');
    await screenshot(page, info, 'model-cache-config-invalidated');
  } finally { release(); }
});

test('stale Codex rows remain usable during revalidation and failure, then Retry refreshes them', async ({ page, baseURL }, info) => {
  await page.addInitScript(({ key, catalog }) => {
    localStorage.setItem(key, JSON.stringify({ version: 1, entries: [{ catalog, fetchedAt: Date.now() - 60_000 }] }));
  }, { key: CACHE_KEY, catalog: CODEX_MODELS });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const revalidations: string[] = [];
  const retries: string[] = [];
  await page.route('**/api/engines/codex/models**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('refresh') === '1') {
      retries.push(url.href);
      return route.fulfill({ json: {
        ...CODEX_MODELS,
        models: [...CODEX_MODELS.models, { modelId: 'neutral-recovered', name: 'Neutral Recovered' }],
      } });
    }
    revalidations.push(url.href);
    await held;
    await route.fulfill({ status: 502, json: { error: 'Catalog adapter temporarily unavailable' } }).catch(() => undefined);
  });
  try {
    await loadHome(page, baseURL);
    const panel = await openDraft(page);
    await openCodexPicker(page, panel);
    await expect.poll(() => revalidations.length).toBeGreaterThan(0);
    await expectCatalog(page);
    await model(page, 'Neutral Fast').click();
    await expect(draftModelPill(panel)).toHaveAttribute('data-model', 'neutral-fast');
    await expectCatalog(page);
    await screenshot(page, info, 'model-cache-stale-held');

    release();
    await expect(picker(page)).toContainText('Catalog adapter temporarily unavailable');
    await expectCatalog(page);
    await expect(picker(page).getByTestId('acp-catalog-retry')).toBeVisible();
    await model(page, 'Neutral Careful').click();
    await expect(draftModelPill(panel)).toHaveAttribute('data-model', 'neutral-careful');
    await screenshot(page, info, 'model-cache-stale-failed');
    await picker(page).getByTestId('acp-catalog-retry').click();
    await expect.poll(() => retries.length).toBe(1);
    await expectCatalog(page, ['Neutral Balanced', 'Neutral Fast', 'Neutral Careful', 'Neutral Recovered']);
    await expect(picker(page)).not.toContainText('Catalog adapter temporarily unavailable');
    await model(page, 'Neutral Recovered').click();
    await expect(draftModelPill(panel)).toHaveAttribute('data-model', 'neutral-recovered');
    await screenshot(page, info, 'model-cache-retry-recovered');
  } finally { release(); }
});
