/**
 * "Load earlier messages" on a transcript past the full read's byte ceiling.
 *
 * Reported 2026-10-04: a 38 MB session showed "Load earlier messages", and clicking
 * it did nothing, forever. The server could only serve the 4 MB tail of such a file,
 * so every click re-served the same rows. The older part now comes a page at a time
 * (GET /api/sessions/:id/history?before=<oldest row held>), through the real server,
 * the real daemon and the real panel. The fixture (whale-history-fixture.ts) is a
 * ~17 MB transcript under a 8 MB ceiling, with a tail of fewer than 400 rows, the
 * shape of the report.
 *
 * What is pinned: a click shows older rows at once and the reader keeps their place;
 * paging to the start yields every turn exactly once, in order; a new turn after
 * paging extends the array without a rebuild and without losing the pages; a failed
 * page can be retried; a transcript that cannot be paged says so instead of showing
 * a dead button; the pages survive leaving the session and coming back.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { WHALE_SESSION, WHALE_TASK, WHALE_TURNS } from './whale-history-fixture';

test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
// Serial on one fixture record; the budget is wide because a 2,800-row transcript is real DOM work on a loaded machine.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const HISTORY = `**/api/sessions/${WHALE_SESSION}/history**`;

async function openWhale(page: Page, baseURL: string): Promise<Locator> {
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.locator('.todo-search-input').fill(WHALE_SESSION);
  const task = page.locator(`.todo-panel-item[data-task-id="${WHALE_TASK}"]`);
  await expect(task).toBeVisible();
  await task.locator('.todo-item-title').click();
  const panel = page.locator(`.main-page-session-column [data-session-id="${WHALE_SESSION}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('.session-history')).toContainText(`whale reply ${WHALE_TURNS - 1}`, { timeout: 60_000 });
  return panel;
}

const earlierBtn = (panel: Locator) => panel.locator('.session-show-earlier-btn');

/**
 * Scroll the timeline to its top with a REAL wheel. Programmatic scrollTop/scrollIntoView on
 * .session-history is snapped back to the bottom while the timeline follows the tail; the first
 * real wheel releases that pin, after which a direct write holds (WebKit also drops later synthetic
 * wheels, so a wheel that did not move it is followed by a direct write).
 */
async function scrollToTop(panel: Locator): Promise<void> {
  const page = panel.page();
  const history = panel.locator('.session-history');
  const box = (await history.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60; i++) {
    const top = await history.evaluate((el) => el.scrollTop);
    if (top <= 1) return;
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(120);
    if ((await history.evaluate((el) => el.scrollTop)) === top) {
      await history.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 4000); });
    }
  }
}

/** Click the button at the top of the timeline whose label matches, after a real scroll to it. */
async function clickTopButton(panel: Locator, label: RegExp): Promise<boolean> {
  await scrollToTop(panel);
  const btn = panel.locator('.session-show-earlier-btn', { hasText: label }).first();
  if ((await btn.count()) === 0) return false;
  await btn.click();
  return true;
}

/** Render every row already held: the panel shows the newest 30 and reveals the rest in batches. */
async function expandHeld(panel: Locator): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (!(await clickTopButton(panel, /^Show \d+ earlier/))) return;
  }
}

/** The "Load earlier messages" button, with all held rows rendered above the reader. */
async function loadEarlierBtn(panel: Locator): Promise<Locator> {
  await expandHeld(panel);
  await scrollToTop(panel);
  return panel.locator('.session-show-earlier-btn', { hasText: /earlier messages/ }).first();
}

/** Every `whale ask N` / `whale reply N` the panel shows, in DOM order. */
async function markers(panel: Locator): Promise<string[]> {
  return panel.locator('.session-history').evaluate((el) =>
    [...(el as HTMLElement).innerText.matchAll(/whale (ask|reply) (\d+)/g)].map((m) => `${m[1]}:${m[2]}`));
}

/** Click whichever "earlier" button is showing until the start is reached. */
async function readToTheStart(panel: Locator): Promise<number> {
  let clicks = 0;
  for (; clicks < 80; clicks++) {
    if (!(await clickTopButton(panel, /earlier/))) break;
    // A page in flight disables the button and relabels it; wait that out.
    await expect(panel.locator('.session-show-earlier-btn:disabled')).toHaveCount(0, { timeout: 90_000 });
  }
  return clicks;
}

function expectedTurns(from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = from; t < to; t++) out.push(`ask:${t}`, `reply:${t}`);
  return out;
}

test('the tail is a bounded window, and the panel offers an uncounted Load earlier', async ({ page, baseURL, request }) => {
  const panel = await openWhale(page, baseURL!);
  const res = await request.get(`/api/sessions/${WHALE_SESSION}/history?tail=400`);
  const body = await res.json() as { windowed?: boolean; messages: unknown[]; total: number };
  expect(body.windowed, 'the fixture must be past the ceiling or nothing below proves anything').toBe(true);
  expect(body.total, 'a tail under 400 rows is the reported shape').toBeLessThan(400);
  await expect(await loadEarlierBtn(panel)).toHaveText(/^Load earlier messages$/);
});

test('a click shows older rows at once and the reader keeps their place', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const panel = await openWhale(page, baseURL!);
  const history = panel.locator('.session-history');
  const btn = await loadEarlierBtn(panel);
  await expect(btn).toHaveText(/^Load earlier messages$/);
  const before = await markers(panel);
  const firstHeld = Number(before[0].split(':')[1]);
  // The row right under the button is the reader's place.
  const anchorText = await history.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const rows = [...el.querySelectorAll<HTMLElement>('.session-msg-content')];
    const row = rows.find((r) => r.getBoundingClientRect().top >= top + 40 && /whale (ask|reply) \d+/.test(r.innerText));
    return row ? (row.innerText.match(/whale (ask|reply) \d+/) ?? [''])[0] : '';
  });
  expect(anchorText).toMatch(/^whale (ask|reply) \d+$/);
  const yOf = (text: string) => history.evaluate((el, t) => {
    const row = [...el.querySelectorAll<HTMLElement>('.session-msg-content')].find((r) => r.innerText.includes(t));
    return row ? row.getBoundingClientRect().top : null;
  }, text);
  const y0 = await yOf(anchorText);
  expect(y0).not.toBeNull();

  const pageReq = page.waitForResponse((r) => r.url().includes('/history') && r.url().includes('before='));
  await btn.click();
  const resp = await pageReq;
  expect(resp.status()).toBe(200);
  const pageBody = await resp.json() as { messages: Array<{ timestamp: string }>; reachedStart: boolean };
  expect(pageBody.messages.length).toBeGreaterThan(0);

  // Older turns than anything held are on screen now, not behind another click.
  await expect.poll(async () => {
    const now = await markers(panel);
    return Number(now[0].split(':')[1]);
  }, { timeout: 30_000 }).toBeLessThan(firstHeld);
  const y1 = await yOf(anchorText);
  expect(y1, 'the row the reader was on is still rendered').not.toBeNull();
  expect(Math.abs((y1 as number) - (y0 as number)), 'and did not move under the reader').toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('paging to the start yields every turn exactly once, in order, then the button is gone', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pageReqs: Array<{ status: number; reachedStart: boolean | undefined }> = [];
  page.on('response', async (r) => {
    if (r.url().includes(`/api/sessions/${WHALE_SESSION}/history`) && r.url().includes('before=')) {
      const j = await r.json().catch(() => ({})) as { reachedStart?: boolean };
      pageReqs.push({ status: r.status(), reachedStart: j.reachedStart });
    }
  });
  const panel = await openWhale(page, baseURL!);

  const clicks = await readToTheStart(panel);
  expect(clicks).toBeGreaterThan(3);

  expect(pageReqs.length, 'a 17 MB file takes several bounded pages').toBeGreaterThanOrEqual(2);
  expect(pageReqs.every((p) => p.status === 200)).toBe(true);
  expect(pageReqs[pageReqs.length - 1].reachedStart).toBe(true);
  expect(await earlierBtn(panel).count()).toBe(0);

  // Every turn once, in order: no hole at a window seam, no row doubled.
  const got = await markers(panel);
  expect(got).toEqual(expectedTurns(0, WHALE_TURNS));
  expect(errors).toEqual([]);
});

test('a turn after paging extends the view by delta and keeps the pages', async ({ page, baseURL }) => {
  const panel = await openWhale(page, baseURL!);
  await readToTheStart(panel);
  const held = await markers(panel);
  expect(held[0]).toBe('ask:0');

  const fetches: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes(`/api/sessions/${WHALE_SESSION}/history`) && r.request().method() === 'GET') fetches.push(r.url());
  });
  const prompt = `whale followup ${Date.now()}`;
  const box = panel.locator('.chat-input-textarea').first();
  await box.click();
  await box.fill(prompt);
  await box.press('Enter');
  await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 60_000 });

  // The pages are still there, untouched, and the new turn arrived once.
  await expect.poll(async () => (await markers(panel)).length).toBe(held.length);
  expect(await markers(panel)).toEqual(expectedTurns(0, WHALE_TURNS));
  // The mock CLI echoes the words in its reply, so count the user's own bubble, not the text.
  await expect(panel.locator('.session-msg-user', { hasText: prompt }), 'the new turn is shown once').toHaveCount(1);
  // It got there by delta, not by a full rebuild that would have dropped the pages.
  // The delta request follows the stream's batch-completed event, so wait for it.
  await expect.poll(() => fetches.some((u) => u.includes('since=')), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(1500);
  expect(fetches.filter((u) => !u.includes('since=') && !u.includes('before='))).toEqual([]);
  expect(await markers(panel)).toEqual(expectedTurns(0, WHALE_TURNS));
  await expect(panel.locator('.session-msg-user', { hasText: prompt })).toHaveCount(1);
  expect(await earlierBtn(panel).count()).toBe(0);
});

test('a failed page keeps the button and a retry pages normally', async ({ page, baseURL }) => {
  const panel = await openWhale(page, baseURL!);
  const btn = await loadEarlierBtn(panel);
  let failed = 0;
  await page.route(HISTORY, async (route) => {
    if (route.request().url().includes('before=') && failed === 0) {
      failed++;
      await route.fulfill({ status: 502, json: { error: 'Remote read timeout (30s)' } });
      return;
    }
    await route.fallback();
  });
  await btn.click();
  await expect.poll(() => failed).toBe(1);
  await expect(btn).toBeEnabled();
  await expect(btn).toHaveText(/^Load earlier messages$/);
  const firstBefore = Number((await markers(panel))[0].split(':')[1]);

  await btn.click();
  await expect.poll(async () => Number((await markers(panel))[0].split(':')[1]), { timeout: 30_000 }).toBeLessThan(firstBefore);
  await page.unroute(HISTORY);
});

test('a transcript that cannot be paged says so instead of showing a dead button', async ({ page, baseURL }) => {
  const panel = await openWhale(page, baseURL!);
  const btn = await loadEarlierBtn(panel);
  let asked = 0;
  await page.route(HISTORY, async (route) => {
    if (route.request().url().includes('before=')) {
      asked++;
      await route.fulfill({ json: { messages: [], reachedStart: false, unavailable: 'fork' } });
      return;
    }
    await route.fallback();
  });
  await btn.click();
  await expect(panel.getByTestId('session-earlier-unavailable')).toBeVisible();
  await expect(earlierBtn(panel)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(asked, 'and asks the server once, not in a loop').toBe(1);
  await page.unroute(HISTORY);
});

test('the pages survive leaving the session and coming back', async ({ page, baseURL }) => {
  const panel = await openWhale(page, baseURL!);
  const btn = await loadEarlierBtn(panel);
  await btn.click();
  await expect(panel.locator('.session-show-earlier-btn:disabled')).toHaveCount(0, { timeout: 60_000 });
  await expandHeld(panel);
  const first = Number((await markers(panel))[0].split(':')[1]);
  expect(first).toBeLessThan(WHALE_TURNS - 100);

  // Another session's column, then back to this one.
  await page.locator('.todo-search-input').fill('Outline window fixture task');
  await page.locator('.todo-panel-item[data-task-id="pw-task-outline-window"] .todo-item-title').click();
  await expect(page.locator('.main-page-session-column [data-session-id="pw-outline-window-session"]')).toBeVisible();
  await page.locator('.todo-search-input').fill(WHALE_SESSION);
  await page.locator(`.todo-panel-item[data-task-id="${WHALE_TASK}"] .todo-item-title`).click();
  const back = page.locator(`.main-page-session-column [data-session-id="${WHALE_SESSION}"]`);
  await expect(back.locator('.session-history')).toContainText(`whale reply ${WHALE_TURNS - 1}`, { timeout: 60_000 });
  await page.waitForTimeout(2500);

  // The cached pages plus the verifying fetch's fresh tail: still one unbroken run.
  await expandHeld(back);
  const after = await markers(back);
  expect(Number(after[0].split(':')[1]), 'the pages loaded before are still above the tail').toBeLessThanOrEqual(first);
  const turns = after.filter((m) => m.startsWith('ask:')).map((m) => Number(m.split(':')[1]));
  for (let i = 1; i < turns.length; i++) expect(turns[i], 'no hole and no repeat').toBe(turns[i - 1] + 1);
});

test('once the start is reached, leaving and coming back shows no Load earlier again', async ({ page, baseURL }) => {
  const panel = await openWhale(page, baseURL!);
  await readToTheStart(panel);
  expect(await earlierBtn(panel).count()).toBe(0);

  await page.locator('.todo-search-input').fill('Outline window fixture task');
  await page.locator('.todo-panel-item[data-task-id="pw-task-outline-window"] .todo-item-title').click();
  await expect(page.locator('.main-page-session-column [data-session-id="pw-outline-window-session"]')).toBeVisible();
  await page.locator('.todo-search-input').fill(WHALE_SESSION);
  await page.locator(`.todo-panel-item[data-task-id="${WHALE_TASK}"] .todo-item-title`).click();
  const back = page.locator(`.main-page-session-column [data-session-id="${WHALE_SESSION}"]`);
  await expect(back.locator('.session-history')).toContainText(`whale reply ${WHALE_TURNS - 1}`, { timeout: 60_000 });
  // Let the cache-verifying fetch land, then scroll to the very top: no dead button.
  await page.waitForTimeout(2500);
  await expandHeld(back);
  await scrollToTop(back);
  expect(await earlierBtn(back).count()).toBe(0);
  expect((await markers(back))[0]).toBe('ask:0');
});

test('an outline pin on the first turns pages all the way back and lands on it', async ({ page, baseURL, request }) => {
  const EARLY = 5;
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
  const pin = (t: number) => ({
    msgId: `msg_whale_${t}_a`, role: 'assistant', label: `whale reply ${t}`,
    timestamp: twoDaysAgo, pinnedAt: new Date().toISOString(),
  });
  const set = async (pins: unknown[]) => {
    const res = await request.patch(`/api/sessions/${WHALE_SESSION}`, { data: { pinned_messages: pins } });
    expect(res.ok(), await res.text()).toBe(true);
  };
  // Set, never cleared: the chromium and webkit projects share this one fixture record
  // and run at the same time, so clearing would pull the pin out from under the other.
  await set([pin(EARLY)]);
  {
    const panel = await openWhale(page, baseURL!);
    const history = panel.locator('.session-history');
    const target = panel.locator(`[data-message-id="msg_whale_${EARLY}_a"]`);
    await expect(target, 'turn 5 is a dozen pages above the tail').toHaveCount(0);

    // Failure-only diagnostics: what the timeline did after the click, so a miss names its cause.
    const consoleLines: string[] = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/pin jump|older page|older history/.test(t)) consoleLines.push(t.slice(0, 220));
    });
    await history.evaluate((el) => {
      const w = window as unknown as { __scrollTrace: string[] };
      w.__scrollTrace = [];
      const t0 = performance.now();
      const stamp = () => Math.round(performance.now() - t0);
      el.addEventListener('scroll', () => {
        if (w.__scrollTrace.length < 300) w.__scrollTrace.push(`${stamp()}ms scroll top=${Math.round(el.scrollTop)} h=${el.scrollHeight}`);
      });
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]) {
        w.__scrollTrace.push(`${stamp()}ms scrollIntoView ${JSON.stringify(args)}`);
        return (orig as (...a: unknown[]) => void).apply(this, args);
      } as typeof Element.prototype.scrollIntoView;
    });

    const toc = panel.locator('.session-toc');
    await toc.locator('.session-toc-rail').hover();
    await toc.locator('.session-toc-row').first().click();

    // One click, several bounded pages: the jump keeps paging until the row lands.
    try {
      await expect(target).toBeAttached({ timeout: 90_000 });
      await expect.poll(async () => history.evaluate((el, id) => {
        const box = el.getBoundingClientRect();
        const node = el.querySelector(`[data-message-id="${id}"]`);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return Math.abs((r.top + r.height / 2) - (box.top + box.height / 2)) / box.height;
      }, `msg_whale_${EARLY}_a`), { timeout: 20_000 }).toBeLessThan(0.5);
    } catch (err) {
      const trace = await history.evaluate(() => (window as unknown as { __scrollTrace?: string[] }).__scrollTrace ?? []).catch(() => []);
      const head = trace.slice(0, 25).join('\n');
      const tail = trace.slice(-25).join('\n');
      throw new Error(`${(err as Error).message}\n--- console ---\n${consoleLines.join('\n')}\n--- scroll trace (${trace.length}) head ---\n${head}\n--- tail ---\n${tail}`);
    }
  }
});
