import { test, expect, type Locator, type Page } from '@playwright/test';
import { openAskWalnutDrawer, openChatOnLoad } from './draft-helpers';

const SESSION_ID = 'pw-vscode-session';
const TASK_ID = 'pw-task-vscode';
const TOTAL_MESSAGES = 150;

test.use({ deviceScaleFactor: 1 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname === '/ws') {
          (window as Window & { historyTestSocket?: WebSocket }).historyTestSocket = this;
        }
      }
    };
  });
});

function historyRows(total: number) {
  return Array.from({ length: total }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `history-${i}`,
    text: i % 2 === 0
      ? `History message ${i}: \u68c0\u67e5\u5e03\u5c40\u4e0e\u9605\u8bfb\u4f4d\u7f6e\u3002 Keep the last line visible while the panel changes size.` // mixed CJK text: "Check the layout and reading position."
      : `## History message ${i}\n\nThe conversation contains paragraphs, tables, and code.\n\n| Check | Result |\n| --- | --- |\n| \u4e2d\u6587 | Ready |\n| Layout | Visible |\n\n\`\`\`ts\nconst message = ${i};\n\`\`\`\n\nFinal line ${i}.`, // CJK table cell ("Chinese")
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

async function mockHistory(page: Page, total: number) {
  const messages = historyRows(total);
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, (route) =>
    route.fulfill({ json: { messages, cursor: messages.length, total, delta: false } }));
}

async function openSession(page: Page, baseURL: string, sessionId = SESSION_ID, taskId = TASK_ID) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.locator('.todo-search-input').fill(sessionId);
  const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`);
  await expect(task).toBeVisible();
  await task.locator('.todo-item-title').click({ timeout: 10_000 });
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sessionId}"]`);
  await expect(panel).toBeVisible();
  return panel;
}

async function wheelToTop(page: Page, history: Locator) {
  const box = (await history.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -1_000_000);
  await history.evaluate(el => { el.scrollTop = 0; });
  await expect.poll(() => history.evaluate(el => el.scrollTop)).toBeLessThanOrEqual(1);
}

async function expectBottom(panel: Locator) {
  await expect.poll(() => panel.locator('.session-history').evaluate(el =>
    el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
}

test('10 initial turns and 20-turn batches preserve the reading anchor across repeated expansion', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await mockHistory(page, TOTAL_MESSAGES);
  const panel = await openSession(page, baseURL!);
  const history = panel.locator('.session-history');
  await expect(history.locator('[data-msg-index="149"]')).toBeAttached();
  await expect(history.locator('[data-msg-index]')).toHaveCount(20);
  await expectBottom(panel);

  for (const [anchor, revealed, nextCount] of [[130, 90, 90], [90, 50, 50], [50, 10, 10], [10, 0, 0]]) {
    await wheelToTop(page, history);
    const button = history.locator('.session-show-earlier-btn');
    await expect(button).toHaveText('Load earlier turns');
    const style = await button.evaluate(el => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, border: css.borderTopWidth, fontSize: css.fontSize };
    });
    expect(style).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px', fontSize: '12px' });
    const previous = history.locator(`[data-msg-index="${anchor}"]`);
    const before = (await previous.boundingBox())!;
    const started = Date.now();
    await button.click();
    await expect(history.locator(`[data-msg-index="${revealed}"]`)).toBeAttached({ timeout: 15_000 });
    const elapsedMs = Date.now() - started;
    await testInfo.attach(`expand-${revealed}`, { body: JSON.stringify({ elapsedMs }), contentType: 'application/json' });
    expect(elapsedMs).toBeLessThan(15_000);
    await expect.poll(async () => Math.abs((await previous.boundingBox())!.y - before.y)).toBeLessThanOrEqual(30);
    await expect(history.locator('[data-msg-index]')).toHaveCount(TOTAL_MESSAGES - revealed);
    if (nextCount) await expect(button).toHaveText('Load earlier turns');
    else await expect(button).toHaveCount(0);
  }

  const arrow = await panel.getByRole('button', { name: 'Scroll to bottom', exact: true }).boundingBox();
  const composer = await panel.locator('.session-panel-input').boundingBox();
  expect(arrow).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(arrow!.y + arrow!.height).toBeLessThanOrEqual(composer!.y);
  await panel.screenshot({ path: testInfo.outputPath('expanded-arrow.png'), scale: 'css' });
  await panel.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  await expectBottom(panel);
  await expect(history.getByText('Final line 149.', { exact: true })).toBeVisible();
});

test('tool-heavy history opens ten whole turns instead of thirty raw rows', async ({ page, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const panel = await openSession(page, baseURL!, 'pw-history-turns-session', 'pw-task-history-turns');
  const history = panel.locator('.session-history');
  await expect(history.locator('[data-msg-index][data-msg-role="user"]')).toHaveCount(10);
  await expect(history.getByText('Dense question 35', { exact: true })).toBeAttached();
  await expect(history.getByText('Dense question 34', { exact: true })).toHaveCount(0);
  await expect(history.getByText('Dense answer 44', { exact: true })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await wheelToTop(page, history);
    await expect(history.getByRole('button', { name: 'Load earlier turns', exact: true })).toBeVisible();
    await panel.screenshot({ path: `/tmp/history-control/${testInfo.project.name}-dense-${theme}.png`, scale: 'css' });
  }
  const anchor = history.getByText('Dense question 35', { exact: true });
  const before = (await anchor.boundingBox())!.y;
  await history.getByRole('button', { name: 'Load earlier turns', exact: true }).click();
  await expect(history.locator('[data-msg-index][data-msg-role="user"]')).toHaveCount(30);
  await expect(history.getByText('Dense question 15', { exact: true })).toBeAttached();
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThanOrEqual(30);
  expect(errors).toEqual([]);
});

test('bottom content stays above the fog through tool and composer resizing', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const messages = [...historyRows(60), {
    role: 'assistant', msgId: 'tail-tools', text: '',
    timestamp: '2026-01-01T01:00:00.000Z',
    tools: Array.from({ length: 4 }, (_, i) => ({
      name: 'Bash', toolUseId: `tail-tool-${i}`,
      input: { command: `printf 'check ${i}'`, description: `Check ${i}` },
      result: `Check ${i} passed.`,
    })),
  }, {
    role: 'assistant', msgId: 'tail-text',
    text: 'Final result: all four checks are complete.\n\n\u6700\u540e\u4e00\u884c\u5e94\u8be5\u5b8c\u6574\u53ef\u8bfb\u3002', // CJK line: "The last line should be fully readable."
    timestamp: '2026-01-01T01:00:01.000Z',
  }];
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, route =>
    route.fulfill({ json: { messages, cursor: messages.length, total: messages.length, delta: false } }));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openSession(page, baseURL!);
  const history = panel.locator('.session-history');
  const last = history.locator('[data-msg-index="61"]');
  await expect(last).toBeAttached();

  async function checkBottom(label: string) {
    const box = (await history.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 1_000_000);
    await expectBottom(panel);
    const geometry = await panel.evaluate(el => {
      const input = el.querySelector('.session-panel-input')!;
      const tail = el.querySelector('[data-msg-index="61"]')!;
      const scroller = el.querySelector('.session-history')!;
      const fogTop = input.getBoundingClientRect().top;
      return {
        fogTop, tailBottom: tail.getBoundingClientRect().bottom,
        gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
        padding: getComputedStyle(scroller).paddingBottom,
      };
    });
    await testInfo.attach(label, { body: JSON.stringify(geometry), contentType: 'application/json' });
    await panel.screenshot({ path: testInfo.outputPath(`${label}.png`), scale: 'css' });
    expect.soft(geometry.tailBottom, label).toBeLessThanOrEqual(geometry.fogTop - 7);
  }

  await checkBottom('collapsed');
  for (let i = 0; i < 2; i++) {
    await panel.locator('.tool-run-toggle').filter({ hasText: 'Ran 4 tools' }).click();
    await expect(panel.locator('.tool-run-body')).toBeVisible();
    await checkBottom(`tools-open-${i}`);
    await panel.locator('.tool-run-toggle').filter({ hasText: 'Ran 4 tools' }).click();
    await expect(panel.locator('.tool-run-body')).toHaveCount(0);
    await checkBottom(`tools-closed-${i}`);
  }
  await panel.getByRole('button', { name: 'Expand session to full screen', exact: true }).click();
  await checkBottom('fullscreen');
  await panel.getByRole('button', { name: 'Collapse session', exact: true }).click();
  await checkBottom('restored');
  const input = panel.locator('.session-panel-input textarea');
  await input.fill(Array.from({ length: 8 }, (_, i) => `Draft line ${i}`).join('\n'));
  await checkBottom('tall-composer');
  await input.fill('');
  await checkBottom('empty-composer');
  await wheelToTop(page, history);
  const before = await history.evaluate(el => el.scrollTop);
  await input.fill('Draft while reading earlier messages\nSecond line\nThird line');
  await expect.poll(() => history.evaluate((el, top) => Math.abs(el.scrollTop - top), before)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('new output follows the bottom but never pulls an earlier-history reader down', async ({ page, baseURL }) => {
  await mockHistory(page, 60);
  const panel = await openSession(page, baseURL!);
  const history = panel.locator('.session-history');
  await expectBottom(panel);
  await page.waitForFunction(() =>
    (window as Window & { historyTestSocket?: WebSocket }).historyTestSocket?.readyState === WebSocket.OPEN);
  async function append(index: number) {
    await page.evaluate(({ sessionId, index }) => {
      const socket = (window as Window & { historyTestSocket?: WebSocket }).historyTestSocket!;
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'event', name: 'session:text-delta', seq: Date.now(),
        data: { sessionId, msgId: `live-${index}`, delta: `Live result ${index}\n\n${'Output continues. '.repeat(30)}` },
      }) }));
    }, { sessionId: SESSION_ID, index });
    await expect(history.getByText(`Live result ${index}`, { exact: true })).toBeVisible();
  }
  await append(1);
  await expectBottom(panel);
  await wheelToTop(page, history);
  const anchor = history.locator('[data-message-id="history-40"]');
  const before = (await anchor.boundingBox())!.y;
  await append(2);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  await expect.poll(() => history.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(500);
  await panel.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  await expectBottom(panel);
  await append(3);
  await expectBottom(panel);
});

test('real stored history stays readable after reopening and viewport changes', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  let panel = await openSession(page, baseURL!);
  for (const [index, [width, height]] of [[1280, 900], [1000, 720], [1280, 900]].entries()) {
    await page.setViewportSize({ width, height });
    const history = panel.locator('.session-history');
    await expect(history.locator('[data-msg-index]').last()).toBeAttached();
    await expectBottom(panel);
    const geometry = await panel.evaluate(el => {
      const input = el.querySelector('.session-panel-input')!;
      const tail = Array.from(el.querySelectorAll('.session-history [data-msg-index]')).at(-1)!;
      return {
        fogTop: input.getBoundingClientRect().top,
        tailBottom: tail.getBoundingClientRect().bottom,
      };
    });
    expect(geometry.tailBottom).toBeLessThanOrEqual(geometry.fogTop - 7);
    await panel.screenshot({ path: testInfo.outputPath(`stored-${index}-${width}.png`), scale: 'css' });
  }
  await panel.getByRole('button', { name: 'Close session panel', exact: true }).click();
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`);
  const bounds = (await task.boundingBox())!;
  await task.click({ position: { x: bounds.width - 2, y: bounds.height / 2 } });
  panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`);
  await expectBottom(panel);
  await expect(panel.locator('.session-history')).toContainText('lazy-grammar.go');
});

test('late archive and failed backfill preserve the reader until retry succeeds', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const total = 120;
  const messages = historyRows(total);
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
  let failBackfill = true;
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async route => {
    const url = new URL(route.request().url());
    const streams = url.searchParams.get('source') === 'streams';
    if (!streams) await archiveGate;
    const full = !streams && !url.searchParams.has('tail');
    if (full && failBackfill) {
      await route.fulfill({ status: 503, json: { error: 'Temporary history read failure' } });
      return;
    }
    const take = full ? total : streams ? 41 : 60;
    await route.fulfill({ json: {
      messages: messages.slice(-take), total, delta: false,
      ...(streams ? {} : { cursor: total }),
    } });
  });
  try {
    const panel = await openSession(page, baseURL!);
    const history = panel.locator('.session-history');
    const anchor = history.locator('[data-message-id="history-100"]');
    await expect(anchor).toBeAttached();
    await wheelToTop(page, history);
    const before = (await anchor.boundingBox())!.y;
    releaseArchive();
    await expect(history.locator('[data-msg-index="40"]')).toBeAttached();
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThanOrEqual(30);
    await history.getByRole('button', { name: 'Load earlier turns', exact: true }).click();
    await expect(history.locator('[data-message-id="history-60"]')).toBeAttached();
    await wheelToTop(page, history);
    const load = history.getByRole('button', { name: 'Load earlier turns', exact: true });
    const failed = page.waitForResponse(response =>
      response.url().includes(`/api/sessions/${SESSION_ID}/history`) && response.status() === 503);
    await load.click();
    await failed;
    await expect(load).toBeEnabled();
    await expect(history.locator('[data-message-id="history-60"]')).toBeAttached();
    failBackfill = false;
    const backfillAnchor = history.locator('[data-message-id="history-60"]');
    const backfillY = (await backfillAnchor.boundingBox())!.y;
    await load.click();
    await expect(history.locator('[data-message-id="history-20"]')).toBeAttached();
    await expect(history.locator('[data-msg-index]')).toHaveCount(100);
    await expect.poll(async () => Math.abs((await backfillAnchor.boundingBox())!.y - backfillY)).toBeLessThanOrEqual(30);
    await wheelToTop(page, history);
    await history.getByRole('button', { name: 'Load earlier turns', exact: true }).click();
    await expect(history.locator('[data-msg-index]')).toHaveCount(total);
  } finally {
    releaseArchive();
  }
});

test('a delayed backfill preserves the newer answer that arrived during the request', async ({ page, baseURL }) => {
  const rows = historyRows(120);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let asked = false;
  let grown = false;
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('since')) {
      const messages = grown ? historyRows(122).slice(120) : [];
      await route.fulfill({ json: { messages, cursor: grown ? 122 : 120, total: grown ? 122 : 120, delta: true } });
      return;
    }
    if (!url.searchParams.has('tail') && url.searchParams.get('source') !== 'streams') {
      asked = true;
      await gate;
      await route.fulfill({ json: { messages: rows, cursor: 120, total: 120, delta: false } });
      return;
    }
    await route.fulfill({ json: { messages: rows.slice(-20), cursor: 120, total: 120, delta: false } });
  });
  try {
    const panel = await openSession(page, baseURL!);
    const history = panel.locator('.session-history');
    await expect(history.getByText('Final line 119.', { exact: true })).toBeAttached();
    await wheelToTop(page, history);
    await history.getByRole('button', { name: 'Load earlier turns', exact: true }).click();
    await expect.poll(() => asked).toBe(true);
    grown = true;
    await page.waitForFunction(() =>
      (window as Window & { historyTestSocket?: WebSocket }).historyTestSocket?.readyState === WebSocket.OPEN);
    await page.evaluate(sessionId => {
      const socket = (window as Window & { historyTestSocket?: WebSocket }).historyTestSocket!;
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'event', name: 'session:batch-completed', seq: Date.now(), data: { sessionId },
      }) }));
    }, SESSION_ID);
    await expect(history.getByText('Final line 121.', { exact: true })).toBeAttached();
    release();
    await expect(history.getByText('History message 60:', { exact: false }).first()).toBeAttached();
    await expect(history.getByText('Final line 121.', { exact: true })).toHaveCount(1);
    await expect(history.locator('[data-message-id="history-120"]')).toHaveCount(1);
  } finally {
    release();
  }
});

test('embedded Ask conversation keeps the same bottom clearance in both themes', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await page.route('**/api/tasks?*', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const body = await response.json();
    for (const task of body.tasks) {
      if (task.id === TASK_ID) task.project = 'Ask Walnut';
    }
    await route.fulfill({ response, json: body });
  });
  // The embedded Ask conversation is the Ask Walnut slot's, and the shared fixture
  // boots with the chat closed (it remembers a closed chat), so open it.
  await openChatOnLoad(page);
  const column = await openSession(page, baseURL!);
  // The slot opens on Main: pick this ask from its drawer.
  await (await openAskWalnutDrawer(page)).locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${TASK_ID}"]`).click();
  const panel = page.locator(`.ask-walnut-session .session-panel[data-session-id="${SESSION_ID}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await column.getByRole('button', { name: 'Close session panel', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await expectBottom(panel);
    const clearance = await panel.evaluate(el => {
      const input = el.querySelector('.session-panel-input')!;
      const tail = Array.from(el.querySelectorAll('.session-history [data-msg-index]')).at(-1)!;
      return input.getBoundingClientRect().top
        - tail.getBoundingClientRect().bottom;
    });
    expect(clearance).toBeGreaterThanOrEqual(7);
    await panel.screenshot({ path: testInfo.outputPath(`ask-${theme}.png`), scale: 'css' });
  }
});

for (const readingEarlier of [false, true]) {
  test(`late image preserves ${readingEarlier ? 'earlier reading position' : 'bottom follow'}`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    const messages = historyRows(60);
    messages[57].text += '\n\n![Delayed chart](/api/images/history-growth.png)';
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, route =>
      route.fulfill({ json: { messages, cursor: 60, total: 60, delta: false } }));
    let release!: () => void;
    const imageGate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/images/history-growth.png', async route => {
      await imageGate;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#4a78aa"/></svg>',
      });
    });
    try {
      const panel = await openSession(page, baseURL!);
      const history = panel.locator('.session-history');
      const image = history.getByRole('img', { name: 'Delayed chart' });
      await expect(image).toBeAttached();
      await wheelToTop(page, history);
      const anchor = history.locator('[data-message-id="history-40"]');
      const before = (await anchor.boundingBox())!.y;
      if (!readingEarlier) {
        await panel.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
        await expectBottom(panel);
      }
      const heightBefore = await history.evaluate(el => el.scrollHeight);
      release();
      await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(640);
      await expect.poll(() => history.evaluate(el => el.scrollHeight)).toBeGreaterThan(heightBefore + 100);
      if (readingEarlier) {
        await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
      } else {
        await expectBottom(panel);
      }
    } finally {
      release();
    }
  });
}

for (const total of [0, 1, 20, 21, 59, 60, 61]) {
  test(`history expansion boundary: ${total} messages`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    await mockHistory(page, total);
    const panel = await openSession(page, baseURL!);
    const history = panel.locator('.session-history');
    if (total) await expect(history.locator(`[data-msg-index="${total - 1}"]`)).toBeAttached();
    else await expect(history).toContainText('No conversation history found');
    const button = history.locator('.session-show-earlier-btn');
    const firstTurn = Math.max(0, total % 2 === 0 ? total - 20 : total - 19);
    if (firstTurn === 0) {
      await expect(button).toHaveCount(0);
      return;
    }
    await wheelToTop(page, history);
    await expect(button).toHaveText('Load earlier turns');
    await button.click();
    await expect(history.locator('[data-msg-index]')).toHaveCount(total - Math.max(0, firstTurn - 40));
    if (firstTurn > 40) await expect(button).toHaveText('Load earlier turns');
    else await expect(button).toHaveCount(0);
  });
}
