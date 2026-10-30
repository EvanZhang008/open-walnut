/**
 * An html-app block shows its layout while it streams, runs no script until it is
 * complete, and becomes the running block in place (web/src/components/chat/
 * IslandPreview.tsx, island-preview.ts, RichBlocks.tsx AppChunk).
 *
 * 2026-10-29, the user, watching a reply's interactive block sit as an empty
 * "building interactive block…" box for the whole stream: make it show live, the
 * way the rest of the reply does. Pinned here, in the real client with streamed
 * deltas:
 *   1. a whole-document block: its heading and list show while it arrives; its
 *      script, an `onerror` image and an inline handler never run in the preview,
 *      not even once the script text is complete but the fence is not; closing the
 *      fence runs the script exactly once, the block keeps its height through the
 *      swap (sampled every frame), and the running block still saves its state
 *      and offers its result;
 *   2. a fragment block: its leading `<style>` styles the preview as it arrives;
 *   3. a block that was already complete when it mounted (a saved reply) is the
 *      running block straight away, with no preview frame.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const TASK_ID = 'pw-task-rich-island-live';
const SHOT_DIR = '/tmp/rich-island-live-e2e';

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    if (!ws) throw new Error('No captured WebSocket');
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data });
}

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 10000 });
}

/** `saved.reply` may be set later: the turn's saved row, read by the next history fetch. */
function mockSession(page: Page, sessionId: string, reply: string | null, saved?: { reply?: string; msgId?: string }) {
  const record = {
    claudeSessionId: sessionId, taskId: TASK_ID, project: 'Walnut', process_status: 'idle', mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 2,
    title: 'Rich island live session',
  };
  const messages = [
    { role: 'user', text: 'Build me a widget', timestamp: '2026-01-01T00:00:00.000Z' },
    ...(reply === null ? [] : [{ role: 'assistant', text: reply, timestamp: '2026-01-01T00:00:01.000Z', msgId: `msg-${sessionId}` }]),
  ];
  return Promise.all([
    page.route(`**/api/sessions/${sessionId}`, (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      return route.fulfill({ json: { session: record } });
    }),
    page.route(`**/api/sessions/${sessionId}/history**`, (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      const all = saved?.reply
        ? [...messages, { role: 'assistant', text: saved.reply, timestamp: '2026-01-01T00:00:02.000Z', msgId: saved.msgId }]
        : messages;
      if (since !== null && !saved?.reply) return route.fulfill({ json: { messages: [], cursor: all.length, delta: true } });
      return route.fulfill({ json: { messages: all, cursor: all.length, delta: false } });
    }),
  ]);
}

async function openSession(page: Page, sessionId: string) {
  const origin = test.info().project.use.baseURL;
  await page.setContent(`<a href="${origin}/sessions?id=${sessionId}">Open session</a>`);
  await page.getByRole('link', { name: 'Open session', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await waitForWs(page);
  await page.waitForSelector('.session-msg', { timeout: 15000 });
}

async function stream(page: Page, sid: string, text: string, size = 60) {
  for (let i = 0; i < text.length; i += size) {
    await injectEvent(page, 'session:text-delta', {
      sessionId: sid, taskId: TASK_ID, msgId: `msg-live-${sid}`, delta: text.slice(i, i + size),
    });
  }
}

/** Wait until the element stops moving (two reads 250 ms apart agree). */
async function settled(loc: Locator) {
  let prev = '';
  for (let i = 0; i < 40; i++) {
    const box = JSON.stringify(await loc.boundingBox());
    if (box === prev) return;
    prev = box;
    await loc.page().waitForTimeout(250);
  }
}

/** Messages any frame posted that say a model script ran. */
const ranProbes = (page: Page) => page.evaluate(() => (window as any).__ran as string[]);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__ran = [];
    window.addEventListener('message', (e) => {
      const d = e.data as { probe?: string } | null;
      if (d && typeof d.probe === 'string') (window as any).__ran.push(d.probe);
    });
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                })), 10);
                return;
              }
            } catch { /* non-JSON */ }
            origSend(data);
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

const DOC_HEAD = [
  'Here is the planner.',
  '',
  '```html-app',
  '<!doctype html><html><head><style>',
  'body{font-family:system-ui;margin:0;padding:12px;background:#fff8e6;color:#3a2a00}',
  'h2{margin:0 0 8px;font-size:18px;color:#9a5b00}',
  '#out{height:20px;font-weight:600}',
  '</style></head><body>',
  '<h2 id="title">Week planner LIVE</h2>',
  '<ul id="days"><li>Monday: review</li><li>Tuesday: build</li><li>Wednesday: ship</li></ul>',
  '<img src="x-missing.png" onerror="parent.postMessage({probe:\'onerror\'},\'*\')" alt="" width="1" height="1">',
  '<button id="pick" onclick="parent.postMessage({probe:\'inline\'},\'*\')">Pick Tuesday</button>',
  '<div id="out"></div>',
].join('\n');

const DOC_SCRIPT = [
  '<script>',
  "parent.postMessage({probe:'script'},'*');",
  "var n=Number(localStorage.getItem('picks')||'0');",
  "out.textContent='Picks '+n;",
  "pick.addEventListener('click',function(){n++;localStorage.setItem('picks',String(n));out.textContent='Picks '+n;walnut.report('Picked Tuesday '+n+' times')});",
  '</script>',
  '</body></html>',
].join('\n');

test.describe('Rich island live preview', () => {
  test('1. a document block shows while it streams, runs nothing early, and hands over in place', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const sid = `pw-island-live-${testInfo.project.name}-${Date.now()}`;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const saved: { reply?: string; msgId?: string } = {};
    await mockSession(page, sid, null, saved);
    await openSession(page, sid);
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    mkdirSync(SHOT_DIR, { recursive: true });

    // Only the fence opener so far: the block says it is building.
    await stream(page, sid, 'Here is the planner.\n\n```html-app\n');
    const live = panel.locator('[data-testid="rich-app-live"]');
    await expect(live).toHaveCount(1);
    await expect(live.locator('.rich-app-live-empty')).toBeVisible();

    // The layout arrives: it is drawn while the block is still open.
    await stream(page, sid, DOC_HEAD.slice('Here is the planner.\n\n```html-app\n'.length) + '\n');
    const preview = panel.frameLocator('[data-testid="rich-app-live"] iframe');
    await expect(preview.locator('#title')).toHaveText('Week planner LIVE');
    await expect(preview.locator('#days li')).toHaveCount(3);
    await expect(live.locator('.rich-app-live-empty')).toHaveCount(0);
    await expect(live.locator('.rich-app-live-badge')).toBeVisible();
    // Its head styles apply.
    await expect(preview.locator('h2')).toHaveCSS('color', 'rgb(154, 91, 0)');
    await live.screenshot({ path: `${SHOT_DIR}/streaming-${testInfo.project.name}.png` });
    // Nothing of the model's ran: not the handler, not the broken image's onerror.
    await expect(preview.locator('#pick')).toHaveCount(1);
    expect(await preview.locator('#pick').getAttribute('onclick')).toBeNull();
    await page.waitForTimeout(300);
    expect(await ranProbes(page)).toEqual([]);
    expect(await panel.locator('iframe.rich-island').count()).toBe(0);

    // The whole script arrives, the fence is still open: still nothing runs.
    await stream(page, sid, DOC_SCRIPT + '\n');
    await page.waitForTimeout(400);
    expect(await ranProbes(page)).toEqual([]);
    await expect(preview.locator('script')).toHaveCount(1); // only the preview's own

    // Sample the block's height every frame through the swap.
    const block = panel.locator('.rich-app-stream');
    const before = (await block.boundingBox())!.height;
    await block.evaluate((el) => {
      const hs: number[] = [];
      (window as any).__hs = hs;
      const t0 = performance.now();
      const tick = () => { hs.push(el.getBoundingClientRect().height); if (performance.now() - t0 < 3000) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await stream(page, sid, '```\n');

    const island = panel.locator('iframe.rich-island');
    await expect(island).toHaveCount(1);
    const app = panel.frameLocator('iframe.rich-island');
    await expect(app.locator('#out')).toHaveText('Picks 0');
    await expect(live).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(3200);
    const hs = await page.evaluate(() => (window as any).__hs as number[]);
    const seen = `before ${before}, heights ${[...new Set(hs.map(Math.round))].join(',')}`;
    expect(hs.length, seen).toBeGreaterThan(10);
    expect(Math.min(...hs), seen).toBeGreaterThanOrEqual(before - 2);
    expect(Math.max(...hs), seen).toBeLessThanOrEqual(before + 2);
    // The script ran once, in the running block; the image's onerror is the page's
    // own now and may fire there, never in the preview.
    expect((await ranProbes(page)).filter((p) => p === 'script')).toEqual(['script']);

    // The running block keeps its state and offers its result.
    await settled(island);
    await app.locator('#pick').click();
    await expect(app.locator('#out')).toHaveText('Picks 1');
    const card = panel.locator('.island-result');
    await expect(card.locator('.island-result-text')).toHaveText('Picked Tuesday 1 times');
    await panel.locator('.rich-app-stream').screenshot({ path: `${SHOT_DIR}/running-${testInfo.project.name}.png` });

    // The turn ends and the saved reply takes the streamed copy's place: the island
    // is mounted again, opens at its own height (never back at the 40px floor) and
    // where the user left it.
    const islandH = (await island.boundingBox())!.height;
    await page.evaluate(() => {
      const hs: number[] = [];
      (window as any).__swap = hs;
      const t0 = performance.now();
      const tick = () => {
        const f = document.querySelector('.main-page-session-column iframe.rich-island');
        if (f) hs.push(f.getBoundingClientRect().height);
        if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    saved.msgId = `msg-live-${sid}`;
    saved.reply = `${DOC_HEAD}\n${DOC_SCRIPT}\n\`\`\``;
    await injectEvent(page, 'session:result', { sessionId: sid, taskId: TASK_ID, isError: false });
    await expect(panel.locator('.rich-app-stream')).toHaveCount(0, { timeout: 15000 });
    await expect(panel.frameLocator('iframe.rich-island').locator('#out')).toHaveText('Picks 1', { timeout: 15000 });
    await page.waitForTimeout(3200);
    const swap = await page.evaluate(() => (window as any).__swap as number[]);
    const swapSeen = `island ${islandH}, heights ${[...new Set(swap.map(Math.round))].join(',')}`;
    expect(Math.min(...swap), swapSeen).toBeGreaterThanOrEqual(islandH - 2);
    expect(errors).toEqual([]);
  });

  test('2. a fragment block takes its leading style while it streams', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const sid = `pw-island-live-frag-${testInfo.project.name}-${Date.now()}`;
    await mockSession(page, sid, null);
    await openSession(page, sid);
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    await stream(page, sid, [
      'A chart:', '', '```html-app',
      '<style>.bar{background:rgb(20, 120, 200);color:#fff;padding:4px;margin:2px 0}</style>',
      '<div class="bar" style="width:40%">Alpha 40</div>', '<div class="bar" style="width:70%">Beta 70</div>',
      '<div class="bar" style="width:5', // a tag still arriving
    ].join('\n'), 25);
    const preview = panel.frameLocator('[data-testid="rich-app-live"] iframe');
    await expect(preview.locator('.bar')).toHaveCount(2);
    await expect(preview.locator('.bar').first()).toHaveCSS('background-color', 'rgb(20, 120, 200)');
    await stream(page, sid, '0%">Gamma 50</div>\n<script>parent.postMessage({probe:"frag"},"*")</script>\n```\n');
    const app = panel.frameLocator('iframe.rich-island');
    await expect(app.locator('.bar')).toHaveCount(3);
    await expect(panel.locator('[data-testid="rich-app-live"]')).toHaveCount(0, { timeout: 5000 });
    expect(await ranProbes(page)).toEqual(['frag']);
  });

  test('3. a block complete when it mounts is the running block, with no preview', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const sid = `pw-island-live-saved-${testInfo.project.name}-${Date.now()}`;
    await mockSession(page, sid, `${DOC_HEAD}\n${DOC_SCRIPT}\n\`\`\``);
    await openSession(page, sid);
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    const app = panel.frameLocator('iframe.rich-island');
    await expect(app.locator('#out')).toHaveText('Picks 0');
    await expect(panel.locator('[data-testid="rich-app-live"]')).toHaveCount(0);
    await expect(panel.locator('.rich-app-building')).toHaveCount(0);
  });
});
