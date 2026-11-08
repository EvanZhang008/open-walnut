import { test, expect, type Route, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { isolateUiPrefs } from './todo-panel-helpers';
import { withCssColor } from './css-color';

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

const SESSION = 'pw-vscode-session';
const TASK = 'pw-task-vscode';

async function openHomePanel(page: Page, baseURL: string | undefined): Promise<Locator> {
  await isolateUiPrefs(page);
  await page.addInitScript(() => localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0'));
  await page.setContent(`<a href="${baseURL}/?s1=${SESSION}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION}"]`);
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.locator('[data-header-id="fork"] button')).toBeAttached();
  return panel;
}

// Real files in the fixture server's throwaway HOME, never the developer's HOME.
// The HOME is shared by every worker (fullyParallel), so each test gets its own
// folder: one shared `Documents` was removed by a test that finished while another
// still read it (2026-11-07 WebKit run: "Couldn't find …/Documents", 0 of 100 rows).
async function denseHome(page: Page) {
  const response = await page.request.get('/api/files/list?path=~');
  expect(response.ok()).toBe(true);
  const listing = await response.json() as { path: string; entries: Array<{ name: string; type: string }> };
  expect(listing.path).toMatch(/^\/tmp\/walnut-pw-/);
  const documents = `${listing.path}/Documents-${test.info().testId}`;
  mkdirSync(documents, { recursive: true });
  for (let i = 1; i <= 100; i++) {
    const project = `${documents}/Project-${String(i).padStart(3, '0')}`;
    mkdirSync(project, { recursive: true });
    writeFileSync(`${project}/readme.txt`, `Project ${i}\nDirectory restore fixture.\n`);
  }
  return { home: listing.path, documents, project: `${documents}/Project-001`, cleanup: () => rmSync(documents, { recursive: true, force: true }) };
}

async function seedHomeCache(page: Page, home: string) {
  const response = await page.request.get(`/api/files/list?path=${encodeURIComponent(home)}&noCache=1`);
  expect(response.ok()).toBe(true);
  const listing = await response.json();
  await page.evaluate(async listing => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('walnut-dirlist-cache', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('listings').createIndex('updatedAt', 'updatedAt');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('listings', 'readwrite');
      const record = { ...listing, host: null, updatedAt: Date.now() };
      transaction.objectStore('listings').put(record, 'local ~');
      transaction.objectStore('listings').put(record, `local ${listing.path}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, listing);
}

async function delayHome(page: Page, fail = false) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  let answered = false;
  const handler = async (route: Route) => {
    if (new URL(route.request().url()).searchParams.get('path') !== '~') return route.fallback();
    reads++;
    const response = await route.fetch();
    await held;
    if (fail) await route.fulfill({ status: 503, json: { error: 'Fixture host unavailable', code: 'host_reconnecting' } });
    else await route.fulfill({ response });
    answered = true;
  };
  await page.route('**/api/files/list?**', handler);
  return { release, reads: () => reads, answered: () => answered, cleanup: async () => { release(); await page.unroute('**/api/files/list?**', handler); } };
}

/** Back, the way the bar offers it: its ‹ button, or its ⋯ row once a long name folded ‹ › into the menu. */
async function pressBack(page: Page, explorer: Locator) {
  const back = explorer.getByRole('button', { name: 'Back to the previously viewed file' });
  const row = page.getByTestId('fv-more-menu').getByRole('menuitem', { name: /^Back to / });
  await expect.poll(async () => {
    if (await back.isVisible().catch(() => false)) { await back.click(); return true; }
    await explorer.getByRole('button', { name: 'More file actions' }).click();
    if (await row.isVisible({ timeout: 1_000 }).catch(() => false)) { await row.click(); return true; }
    await page.keyboard.press('Escape');
    return false;
  }, { message: 'Back: pressed on the bar or in its menu', timeout: 20_000 }).toBe(true);
}

// Hold the reset effect's HOME alias transaction. loadDir's independent cache
// read can still paint the canonical root while this expanded-folder restore waits.
async function delayHomeCacheRestore(page: Page, denyPersistence: boolean) {
  await page.evaluate(deny => {
    const nativeGet = IDBObjectStore.prototype.get;
    const nativeSet = Storage.prototype.setItem;
    const nativeRead = Storage.prototype.getItem;
    let homeReads = 0;
    const state = { blocked: false, released: false, expandedReads: 0, release: () => {}, denyWrites: () => {}, restore: () => {} };
    Storage.prototype.getItem = function(key) {
      if (key.startsWith('open-walnut-file-explorer-expanded:')) state.expandedReads++;
      return nativeRead.call(this, key);
    };
    const pending: Array<() => void> = [];
    IDBObjectStore.prototype.get = function(key) {
      if (this.transaction.db.name === 'walnut-dirlist-cache' && key === 'local ~' && ++homeReads % 2 === 1) {
        const transaction = this.transaction;
        const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
        Object.defineProperty(transaction, 'oncomplete', {
          configurable: true,
          set(handler) {
            descriptor.set!.call(transaction, (event: Event) => {
              state.blocked = true;
              pending.push(() => handler.call(transaction, event));
            });
          },
        });
      }
      return nativeGet.call(this, key);
    };
    state.denyWrites = () => {
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('open-walnut-file-explorer-expanded:')) throw new DOMException('Fixture quota reached', 'QuotaExceededError');
        return nativeSet.call(this, key, value);
      };
    };
    if (deny) state.denyWrites();
    state.release = () => { for (const complete of pending.splice(0)) complete(); state.released = true; };
    state.restore = () => { state.release(); IDBObjectStore.prototype.get = nativeGet; Storage.prototype.setItem = nativeSet; Storage.prototype.getItem = nativeRead; };
    (window as unknown as { __directoryRestoreFault: typeof state }).__directoryRestoreFault = state;
  }, denyPersistence);
}

for (const choice of ['click', 'history', 'none']) {
  test(`late deleted-file validation ${choice === 'none' ? 'prunes the owned selection' : `preserves a newer ${choice} selection`}`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    const panel = await openHomePanel(page, baseURL);
    const listing = await (await page.request.get('/api/files/list?path=~')).json();
    const home = listing.path as string;
    expect(home).toMatch(/^\/tmp\/walnut-pw-/);
    // Per-test names: the three variants run at once in the shared HOME (see denseHome).
    const dead = `${home}/restore-deleted-a-${testInfo.testId}.txt`;
    const live = `${home}/restore-current-b-${testInfo.testId}.txt`;
    writeFileSync(dead, 'Deleted restore fixture A.\n');
    writeFileSync(live, 'Current selection B must keep its memory.\n');
    await seedHomeCache(page, home);
    unlinkSync(dead);
    const delay = await delayHome(page);
    try {
      await page.evaluate(({ dead, live }) => {
        const scope = 'local:session:pw-vscode-session';
        localStorage.setItem(`open-walnut-file-explorer-selected:${scope}`, dead);
        localStorage.setItem(`open-walnut-file-explorer-history:${scope}`, JSON.stringify({ entries: [{ path: live }, { path: dead }], index: 1 }));
      }, { dead, live });
      await panel.getByRole('button', { name: 'Files', exact: true }).click();
      const explorer = panel.locator('.session-file-explorer');
      const preview = explorer.locator('.session-file-explorer-preview');
      await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', home);
      await expect(preview).toHaveAttribute('data-time-file', dead);
      expect(delay.answered()).toBe(false);
      if (choice === 'click') await explorer.locator(`.session-file-explorer-node[title="${live}"]`).click();
      else if (choice === 'history') await pressBack(page, explorer);
      if (choice !== 'none') await expect(explorer.locator('.file-content-view')).toContainText('Current selection B must keep its memory');
      delay.release();
      await expect.poll(delay.answered).toBe(true);
      await expect(explorer.locator('.sfe-root-header').first().locator('.sfe-arrow')).toHaveAttribute('data-state', 'open');
      const stored = () => page.evaluate(() => {
        const scope = 'local:session:pw-vscode-session';
        return {
          selected: localStorage.getItem(`open-walnut-file-explorer-selected:${scope}`),
          history: JSON.parse(localStorage.getItem(`open-walnut-file-explorer-history:${scope}`) || '{"entries":[]}'),
        };
      });
      await expect.poll(async () => (await stored()).history.entries.some((entry: { path: string }) => entry.path === dead)).toBe(false);
      const after = await stored();
      await testInfo.attach('late-selection-prune', { body: JSON.stringify({ choice, dead, live, after }), contentType: 'application/json' });
      if (choice === 'none') {
        await expect(explorer.locator('.sfe-preview-empty')).toBeVisible();
        expect(after.selected).toBeNull();
      } else {
        await expect(preview).toHaveAttribute('data-time-file', live);
        expect(after.selected).toBe(live);
      }
      await panel.getByRole('button', { name: 'Files', exact: true }).click();
      await expect(explorer).toHaveCount(0);
      await panel.getByRole('button', { name: 'Files', exact: true }).click();
      if (choice === 'none') await expect(explorer.locator('.sfe-preview-empty')).toBeVisible();
      else {
        await expect(preview).toHaveAttribute('data-time-file', live);
        await expect(explorer.locator('.file-content-view')).toContainText('Current selection B must keep its memory');
      }
    } finally {
      await delay.cleanup();
      for (const path of [dead, live]) rmSync(path, { force: true });
    }
  });
}

for (const denyPersistence of [false, true]) {
  test(`late HOME cache restore respects directory clicks with ${denyPersistence ? 'denied' : 'working'} persistence`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const panel = await openHomePanel(page, baseURL);
    const fixture = await denseHome(page);
    const delay = await delayHome(page);
    try {
      await seedHomeCache(page, fixture.home);
      await page.evaluate(home => localStorage.setItem(`open-walnut-file-explorer-expanded:local:${home}`, '[]'), fixture.home);
      await delayHomeCacheRestore(page, denyPersistence);
      await panel.getByRole('button', { name: 'Files', exact: true }).click();
      const explorer = panel.locator('.session-file-explorer');
      const row = (path: string) => explorer.locator(`.session-file-explorer-node[title="${path}"]`);
      await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.home);
      await expect.poll(() => page.evaluate(() => (window as any).__directoryRestoreFault.blocked)).toBe(true);
      await row(fixture.documents).click();
      await expect(explorer.locator('.sfe-name').filter({ hasText: /^Project-\d{3}$/ })).toHaveCount(100);
      await row(fixture.project).click();
      await expect(row(`${fixture.project}/readme.txt`)).toBeVisible();
      expect(delay.answered()).toBe(false);
      // Repeated real clicks finish in both states before either restore lands.
      for (let round = 0; round < 3; round++) {
        await row(fixture.project).click();
        await expect(row(`${fixture.project}/readme.txt`)).toHaveCount(0);
        await row(fixture.project).click();
        await expect(row(`${fixture.project}/readme.txt`)).toBeVisible();
      }
      const before = await row(fixture.project).locator('.sfe-arrow').getAttribute('data-state');
      const expandedReads = await page.evaluate(() => (window as any).__directoryRestoreFault.expandedReads);
      await page.evaluate(() => (window as any).__directoryRestoreFault.release());
      // The delayed HOME alias read is followed by a canonical IDB read before
      // expandedHome is read. Observe that continuation, not an arbitrary delay.
      await expect.poll(() => page.evaluate(() => (window as any).__directoryRestoreFault.expandedReads)).toBeGreaterThan(expandedReads);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const after = await row(fixture.project).locator('.sfe-arrow').getAttribute('data-state');
      await testInfo.attach('directory-restore-order', { body: JSON.stringify({ before, after, denyPersistence, rootFetchStillHeld: !delay.answered() }), contentType: 'application/json' });
      await expect(row(`${fixture.project}/readme.txt`)).toBeVisible();
      delay.release();
      await expect.poll(delay.answered).toBe(true);
      await expect(explorer.locator('.sfe-root-header').first().locator('.sfe-arrow')).toHaveAttribute('data-state', 'open');
      await expect(row(`${fixture.project}/readme.txt`)).toBeVisible();
      await explorer.screenshot({ path: `/tmp/tree-restore-repair/${denyPersistence ? 'denied' : 'working'}-persistence-expanded.png` });
      if (!denyPersistence) {
        await panel.getByRole('button', { name: 'Files', exact: true }).click();
        await expect(explorer).toHaveCount(0);
        await panel.getByRole('button', { name: 'Files', exact: true }).click();
        await expect(row(`${fixture.project}/readme.txt`)).toBeVisible();
        // Last collapsed state is remembered too, not just last expanded state.
        await row(fixture.project).click();
        await expect(row(`${fixture.project}/readme.txt`)).toHaveCount(0);
        await panel.getByRole('button', { name: 'Files', exact: true }).click();
        await panel.getByRole('button', { name: 'Files', exact: true }).click();
        await expect(row(fixture.project).locator('.sfe-arrow')).toHaveAttribute('data-state', 'closed');
      }
      expect(errors).toEqual([]);
    } finally {
      await page.evaluate(() => (window as any).__directoryRestoreFault?.restore());
      await delay.cleanup();
      fixture.cleanup();
    }
  });
}

for (const fail of [false, true]) {
 test(`a delayed HOME ${fail ? 'failure' : 'fetch'} cannot reclaim an explicit file root`, async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const panel = await openHomePanel(page, baseURL);
  const fixture = await denseHome(page);
  const delay = await delayHome(page, fail);
  try {
    await seedHomeCache(page, fixture.home);
    await page.evaluate(({ home, remembered }) => localStorage.setItem(`open-walnut-file-explorer-selected:local:session:pw-vscode-session`, remembered), { home: fixture.home, remembered: `${fixture.home}/projects/editor-fixture/incident-report.md` });
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    const explorer = panel.locator('.session-file-explorer');
    await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.home);
    await expect.poll(delay.reads).toBeGreaterThan(0);
    await expect(explorer.locator('.file-content-view')).toContainText('Controller restart loop');
    await explorer.locator('.sfe-root-path').click();
    const input = explorer.locator('.sfe-root-path-input');
    await input.fill(`${fixture.project}/readme.txt`);
    await input.press('Enter');
    await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.project);
    await expect(explorer.locator(`.session-file-explorer-node[title="${fixture.project}/readme.txt"]`)).toBeVisible();
    await expect(explorer.locator('.file-content-view')).toContainText('Project 1');
    delay.release();
    await expect.poll(delay.answered).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await testInfo.attach('root-restore-order', { body: JSON.stringify({ chosen: fixture.project, after: await explorer.locator('.sfe-root-section').first().getAttribute('data-root-path') }), contentType: 'application/json' });
    await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.project);
    await expect(explorer.locator('.file-content-view')).toContainText('Project 1');
    await expect(explorer.locator('.sfe-error')).toHaveCount(0);
    await explorer.getByRole('button', { name: 'Go to parent directory' }).click();
    await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.documents);
    await expect(explorer.locator('.sfe-name').filter({ hasText: /^Project-\d{3}$/ })).toHaveCount(100);
    await expect(explorer.locator('.file-content-view')).toContainText('Project 1');
  } finally {
    await delay.cleanup();
    fixture.cleanup();
  }
 });
}

for (const kind of ['File', 'Folder']) {
  test(`an unsubmitted New ${kind} stays visible after late HOME restores`, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const panel = await openHomePanel(page, baseURL);
    const fixture = await denseHome(page);
    const delay = await delayHome(page);
    try {
      await seedHomeCache(page, fixture.home);
      // New itself opens a closed directory. No earlier directory click may
      // invalidate either pending restore, and both remembered sets are empty.
      await page.evaluate(home => {
        localStorage.setItem('open-walnut-file-explorer-expanded:local:~', '[]');
        localStorage.setItem(`open-walnut-file-explorer-expanded:local:${home}`, '[]');
      }, fixture.home);
      await delayHomeCacheRestore(page, false);
      await panel.getByRole('button', { name: 'Files', exact: true }).click();
      const explorer = panel.locator('.session-file-explorer');
      const documents = explorer.locator(`.session-file-explorer-node[title="${fixture.documents}"]`);
      await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.home);
      await expect(documents).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).__directoryRestoreFault.blocked)).toBe(true);
      expect(delay.answered()).toBe(false);
      await page.evaluate(() => (window as any).__directoryRestoreFault.denyWrites());
      await documents.click({ button: 'right' });
      await page.getByRole('menuitem', { name: `New ${kind}…`, exact: true }).click();
      const input = explorer.getByRole('textbox', { name: `New ${kind.toLowerCase()} name` });
      await input.fill('unsubmitted-draft');
      await expect(input).toBeVisible();
      const reads = await page.evaluate(() => (window as any).__directoryRestoreFault.expandedReads);
      await page.evaluate(() => (window as any).__directoryRestoreFault.release());
      await expect.poll(() => page.evaluate(() => (window as any).__directoryRestoreFault.expandedReads)).toBeGreaterThan(reads);
      await expect(input).toHaveValue('unsubmitted-draft');
      delay.release();
      await expect.poll(delay.answered).toBe(true);
      await expect(explorer.locator('.sfe-root-header').first().locator('.sfe-arrow')).toHaveAttribute('data-state', 'open');
      await expect(input).toHaveValue('unsubmitted-draft');
      await expect(documents.locator('.sfe-arrow')).toHaveAttribute('data-state', 'open');
      await expect(explorer.locator('.sfe-name').filter({ hasText: /^Project-\d{3}$/ })).toHaveCount(100);
      await input.press('Escape');
      await expect(input).toHaveCount(0);
      const disk = await (await page.request.get(`/api/files/list?path=${encodeURIComponent(fixture.documents)}`)).json();
      expect(disk.entries.map((entry: { name: string }) => entry.name)).not.toContain('unsubmitted-draft');
    } finally {
      await page.evaluate(() => (window as any).__directoryRestoreFault?.restore());
      await delay.cleanup();
      fixture.cleanup();
    }
  });
}

test('rapid file A to directory B to file A starts a new root read', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const panel = await openHomePanel(page, baseURL);
  const fixture = await denseHome(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const file = `${fixture.project}/readme.txt`;
  const handler = async (route: Route) => {
    if (new URL(route.request().url()).searchParams.get('path') !== file) return route.fallback();
    const read = ++reads;
    const response = await route.fetch();
    if (read === 1) await held;
    await route.fulfill({ response });
  };
  await page.route('**/api/files/list?**', handler);
  try {
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    const explorer = panel.locator('.session-file-explorer');
    await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.home);
    const jump = async (target: string) => {
      await explorer.locator('.sfe-root-path').click();
      await explorer.locator('.sfe-root-path-input').fill(target);
      await explorer.locator('.sfe-root-path-input').press('Enter');
    };
    await jump(file);
    await expect.poll(() => reads).toBe(1);
    await jump(fixture.documents);
    await expect(explorer.locator('.sfe-name').filter({ hasText: /^Project-\d{3}$/ })).toHaveCount(100);
    await jump(file);
    await expect.poll(() => reads).toBe(2);
    await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', fixture.project);
    await expect(explorer.locator('.file-content-view')).toContainText('Project 1');
    release();
    await expect(explorer.locator(`.session-file-explorer-node[title="${file}"]`)).toBeVisible();
    await explorer.getByRole('button', { name: 'Refresh file panel' }).click();
    await expect(explorer.locator('.file-content-view')).toContainText('Project 1');
  } finally {
    release();
    await page.unroute('**/api/files/list?**', handler);
    fixture.cleanup();
  }
});

test('closing the HOME section during restore stays closed while fresh rows land', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const panel = await openHomePanel(page, baseURL);
  const fixture = await denseHome(page);
  const delay = await delayHome(page);
  try {
    await seedHomeCache(page, fixture.home);
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    const explorer = panel.locator('.session-file-explorer');
    const header = explorer.locator('.sfe-root-header').first();
    await expect(explorer.locator(`.session-file-explorer-node[title="${fixture.documents}"]`)).toBeVisible();
    await header.click();
    await expect(explorer.locator(`.session-file-explorer-node[title="${fixture.documents}"]`)).toHaveCount(0);
    delay.release();
    await expect.poll(delay.answered).toBe(true);
    await expect(header.locator('.sfe-arrow')).toHaveAttribute('data-state', 'closed');
    await expect(explorer.locator(`.session-file-explorer-node[title="${fixture.documents}"]`)).toHaveCount(0);
    await header.click();
    await expect(explorer.locator(`.session-file-explorer-node[title="${fixture.documents}"]`)).toBeVisible();
  } finally {
    await delay.cleanup();
    fixture.cleanup();
  }
});

test('Files starts at the host home and preserves a chosen file across reopening', async ({ page, baseURL }, testInfo) => {
  await isolateUiPrefs(page);
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0');
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const notesNetwork: unknown[] = [];
  const networkReads: Promise<void>[] = [];
  const errorDetails: unknown[] = [];
  page.on('pageerror', error => errorDetails.push({ name: error.name, message: error.message, stack: error.stack }));
  page.on('response', response => {
    if (!new URL(response.url()).pathname.startsWith('/api/notes-v2/')) return;
    networkReads.push(Promise.all([response.allHeaders(), response.request().allHeaders(), response.text().catch(() => '[unavailable during reload]')])
      .then(([headers, requestHeaders, body]) => { notesNetwork.push({ url: response.url(), status: response.status(), headers, requestHeaders, body }); }));
  });
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.startsWith('/api/notes-v2/')) notesNetwork.push({ url: request.url(), failure: request.failure(), headers: request.headers() });
  });
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 });
  await page.locator('.todo-search-input').fill(SESSION);
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK}"]`);
  await expect(task).toBeVisible();
  await task.locator('.todo-item-title').click();
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-header-id="fork"] button')).toBeAttached();
  const rootRead = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/files/list' && url.searchParams.get('path') === '~';
  });
  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  const response = await rootRead;
  expect(response.ok()).toBe(true);
  const listing = await response.json() as { path: string };
  const session = await (await page.request.get(`/api/sessions/${SESSION}`)).json();
  expect(listing.path).not.toBe(session.session.cwd);
  expect(session.session.cwd).toBe(`${listing.path}/projects/editor-fixture`);
  const explorer = panel.locator('.session-file-explorer');
  await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', listing.path);
  const row = (name: string) => explorer.locator('.sfe-name').filter({ hasText: name }).filter({ hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }).first();
  await row('projects').click();
  await row('editor-fixture').click();
  await row('incident-report.md').click();
  await expect(explorer.locator('.file-content-view')).toContainText('Controller restart loop');
  const backgrounds = await explorer.locator('.fv-html-toolbar').evaluate(withCssColor(toRgba => (toolbar: HTMLElement) => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    const colors = ['dark', 'light'].map(theme => {
      root.setAttribute('data-theme', theme);
      return { theme, toolbar: toRgba(getComputedStyle(toolbar).backgroundColor), background: toRgba(getComputedStyle(root).getPropertyValue('--bg')) };
    });
    if (previous === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', previous);
    return colors;
  }));
  for (const colors of backgrounds) expect(colors.toolbar, colors.theme).toEqual(colors.background);
  expect(backgrounds[0].toolbar).not.toEqual(backgrounds[1].toolbar);
  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(explorer).toHaveCount(0);
  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', listing.path);
  await expect(explorer.locator('.file-content-view')).toContainText('Controller restart loop');
  await expect(explorer.locator('.session-file-explorer-node.selected')).toContainText('incident-report.md');
  await page.reload();
  await expect(panel.locator('.session-file-explorer .file-content-view')).toContainText('Controller restart loop', { timeout: 60_000 });
  await Promise.all(networkReads);
  await testInfo.attach('reload-network-evidence', { body: JSON.stringify({ errors, errorDetails, notesNetwork }), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

test('Files reopens HOME and its expanded folders from cache during a host outage', async ({ page, baseURL }) => {
  await isolateUiPrefs(page);
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0');
    (window as unknown as { __filesRetryMs: number }).__filesRetryMs = 500;
  });
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 });
  await page.locator('.todo-search-input').fill(SESSION);
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK}"]`);
  await expect(task).toBeVisible();
  await task.locator('.todo-item-title').click();
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-header-id="fork"] button')).toBeAttached();
  const homeRead = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/files/list' && url.searchParams.get('path') === '~';
  });
  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  const response = await homeRead;
  expect(response.ok()).toBe(true);
  const home = (await response.json()).path as string;
  expect(home).toBeTruthy();
  const explorer = panel.locator('.session-file-explorer');
  const row = (name: string) => explorer.locator('.sfe-name').filter({ hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }).first();
  await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', home);
  for (const name of ['projects', 'editor-fixture', 'report']) {
    await expect(row(name)).toBeVisible();
    await row(name).click();
  }
  await expect(row('summary.html')).toBeVisible();
  await row('summary.html').click();
  await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report');

  let down = true;
  let heldReads = 0;
  const sentence = 'Reconnecting to Cloud';
  const listFault = async (route: Route) => {
    if (!down) return route.fallback();
    heldReads += 1;
    await route.fulfill({ status: 503, json: { error: sentence, code: 'host_reconnecting' } });
  };
  const batchFault = async (route: Route) => {
    if (!down) return route.fallback();
    heldReads += 1;
    const { paths } = route.request().postDataJSON() as { paths: string[] };
    await route.fulfill({ json: {
      listings: paths.map(path => ({ path, error: sentence, code: 'host_reconnecting' })),
      truncated: false, timedOut: false,
    } });
  };
  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(explorer).toHaveCount(0);
  await page.route('**/api/files/list?**', listFault);
  await page.route('**/api/files/list-many', batchFault);
  try {
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    // No successful listing can answer now: these rows can only be the cache.
    await expect(row('projects')).toBeVisible();
    await expect(row('summary.html')).toBeVisible();
    await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', home);
    await expect.poll(() => heldReads).toBeGreaterThan(0);
    await expect(explorer.locator('.sfe-notice').filter({ hasText: 'Showing the last known contents' })).toHaveCount(4);
    await expect(explorer.locator('.sfe-error')).toHaveCount(0);
    await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Verification report');

    down = false;
    await expect(explorer.locator('.sfe-notice').filter({ hasText: 'Showing the last known contents' })).toHaveCount(0, { timeout: 15_000 });
    await expect(row('summary.html')).toBeVisible();
    await row('details.html').click();
    await expect(page.frameLocator('iframe.fv-html-preview').locator('h1')).toHaveText('Details page');
  } finally {
    down = false;
    await page.unroute('**/api/files/list?**', listFault);
    await page.unroute('**/api/files/list-many', batchFault);
  }
});

test('phone Back stays on the tree when a delayed HOME restore finishes', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await isolateUiPrefs(page);
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0');
  });
  // A real session deep link, then the phone menu's ordinary Files action.
  await page.setContent(`<a href="${baseURL}/?s1=${SESSION}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const panel = page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${SESSION}"]`);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const bar = page.locator('.phone-topbar');
  const back = bar.getByRole('button', { name: 'Back', exact: true });
  await bar.getByRole('button', { name: 'More actions', exact: true }).click();
  const homeRead = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/files/list' && url.searchParams.get('path') === '~';
  });
  await page.getByTestId('phone-row-files').click();
  const response = await homeRead;
  expect(response.ok()).toBe(true);
  const home = (await response.json()).path as string;
  const explorer = panel.locator('.session-file-explorer');
  const body = explorer.locator('.session-file-explorer-body');
  const tree = explorer.locator('.session-file-explorer-tree');
  const preview = explorer.locator('.session-file-explorer-preview');
  const row = (name: string) => tree.locator('.sfe-name').filter({ hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }).first();
  await expect(body).toHaveClass(/is-phone-tree/);
  await expect(explorer.locator('.sfe-root-section').first()).toHaveAttribute('data-root-path', home);
  for (const name of ['projects', 'editor-fixture']) {
    await expect(row(name)).toBeVisible();
    await row(name).click();
  }
  await row('incident-report.md').click();
  await expect(body).toHaveClass(/is-phone-file/);
  await expect(preview).toContainText('Controller restart loop');
  await expect(bar.locator('.phone-topbar-title-text')).toHaveText('editor-fixture');
  await expect(preview.locator('.fv-doc-bar .sfe-crumb.is-last')).toHaveText('incident-report.md');

  // Back closes the file layer, then the Files layer, without clearing its memory.
  await back.click();
  await expect(body).toHaveClass(/is-phone-tree/);
  await back.click();
  await expect(explorer).toHaveCount(0);

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let heldReads = 0;
  let answered = false;
  const delayRoot = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('path') !== '~') return route.fallback();
    heldReads += 1;
    const response = await route.fetch({ timeout: 15_000 });
    await held;
    await route.fulfill({ response });
    answered = true;
  };
  await page.route('**/api/files/list?**', delayRoot);
  try {
    await bar.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByTestId('phone-row-files').click();
    await expect.poll(() => heldReads).toBeGreaterThan(0);
    // The fresh root answer is still held, so the restored preview came from cache.
    await expect(body).toHaveClass(/is-phone-file/);
    await expect(preview).toContainText('Controller restart loop');
    expect(answered).toBe(false);
    await expect(bar.locator('.phone-topbar-title-text')).toHaveText('editor-fixture');
    await expect(preview.locator('.fv-doc-bar .sfe-crumb.is-last')).toHaveText('incident-report.md');
    await back.click();
    await expect(body).toHaveClass(/is-phone-tree/);
    await expect(tree).toBeVisible();
    await expect(preview).toBeHidden();

    release();
    await expect.poll(() => answered).toBe(true);
    // The fresh answer has been applied, not just delivered to the browser.
    await expect(explorer.locator('.sfe-root-header').first().locator('.sfe-arrow')).toHaveAttribute('data-state', 'open');
    await expect(explorer.locator('.sfe-notice').filter({ hasText: 'Showing the last known contents' })).toHaveCount(0);
    await expect(body).toHaveClass(/is-phone-tree/);
    await expect(tree).toBeVisible();
    await expect(preview).toBeHidden();
    await expect(bar.locator('.phone-topbar-title-text')).toHaveText('Files');

    // A new explicit choice still opens normally after the ignored restore.
    await row('second-doc.md').click();
    await expect(body).toHaveClass(/is-phone-file/);
    await expect(preview).toContainText('Second doc');
    await expect(bar.locator('.phone-topbar-title-text')).toHaveText('editor-fixture');
    await expect(preview.locator('.fv-doc-bar .sfe-crumb.is-last')).toHaveText('second-doc.md');
  } finally {
    release();
    await page.unroute('**/api/files/list?**', delayRoot);
  }
});
