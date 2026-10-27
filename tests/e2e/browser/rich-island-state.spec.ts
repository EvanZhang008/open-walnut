/**
 * An html-app island keeps where the user got to, and hands a result back only
 * when the user presses Send (web/src/components/chat/island-runtime.ts,
 * island-store.ts, IslandResultCard.tsx).
 *
 * 2026-10-27, the user, halfway through a 15-question quiz in a reply: "when new
 * thing start, the html just get reset". The frame is built again whenever its
 * message is mounted again (a folded question, the stream copy giving way to the
 * saved one, a moved column, a reload), and a sandboxed frame has no storage of
 * its own, so the quiz started over. Pinned here, in the real client against an
 * archived reply:
 *   1. new content streaming in leaves the frame alone, and a reload brings the
 *      quiz back on the question the user was on;
 *   2. a finished quiz shows its exact result under the frame, nothing is sent
 *      until the user presses Send to AI, the press sends exactly that text, and a
 *      reload remembers it was sent;
 *   3. a result message that does not come from the island's own frame is ignored.
 *
 * Same WS harness as rich-html-streaming.spec.ts; `session:send` is answered here
 * and recorded, so the test reads exactly what the button sent.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const TASK_ID = 'pw-task-rich-island';
const SHOT_DIR = '/tmp/rich-island-e2e';

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

/** A three-question quiz that keeps its state the way the skill tells a model to. */
function quizIsland(marker: string): string {
  return [
    '```html-app',
    `<div id="q" style="padding:8px"></div><button id="right">Right</button> <button id="wrong">Wrong</button> <button id="restart">Restart</button>`,
    '<script>',
    `var Q=['${marker}-ONE','${marker}-TWO','${marker}-THREE'];`,
    'var fresh=function(){return {i:0,picks:[]}};',
    "var s=JSON.parse(localStorage.getItem('quiz')||'null')||fresh();",
    'function draw(){',
    "  var ok=s.picks.filter(function(p){return p==='right'}).length;",
    "  if(s.i>=Q.length){q.textContent='DONE '+ok+'/3';",
    "    walnut.report('Quiz result: '+ok+'/3 right.\\n'+s.picks.map(function(p,k){return Q[k]+': '+p}).join('\\n'));return}",
    "  q.textContent=Q[s.i]+' score '+ok;",
    '}',
    "function pick(p){s.picks.push(p);s.i++;localStorage.setItem('quiz',JSON.stringify(s));draw()}",
    "right.onclick=function(){pick('right')};wrong.onclick=function(){pick('wrong')};",
    'restart.onclick=function(){s=fresh();localStorage.setItem("quiz",JSON.stringify(s));draw()};',
    'draw();',
    '</script>',
    '```',
  ].join('\n');
}

function mockSession(page: Page, sessionId: string, reply: string) {
  const record = {
    claudeSessionId: sessionId, taskId: TASK_ID, project: 'Walnut', process_status: 'idle', mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 3,
    title: 'Rich island session',
  };
  const messages = [
    { role: 'user', text: 'Quiz me', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', text: `Here is a quiz.\n\n${reply}`, timestamp: '2026-01-01T00:00:01.000Z', msgId: `msg-${sessionId}` },
  ];
  return Promise.all([
    page.route(`**/api/sessions/${sessionId}`, (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      return route.fulfill({ json: { session: record } });
    }),
    page.route(`**/api/sessions/${sessionId}/history**`, (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) return route.fulfill({ json: { messages: [], cursor: messages.length, delta: true } });
      return route.fulfill({ json: { messages, cursor: messages.length, delta: false } });
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

const sends = (page: Page) => page.evaluate(() => (window as any).__sends as Array<{ sessionId: string; message: string }>);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    (window as any).__sends = [];
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let reply: unknown;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') reply = { blocks: [], isStreaming: false };
              if (parsed.type === 'req' && parsed.method === 'session:send') {
                (window as any).__sends.push(parsed.payload ?? parsed.params);
                reply = { messageId: `qm-test-${Date.now()}` };
              }
              if (reply !== undefined) {
                setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: reply }),
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

test.describe('Rich island state and result', () => {
  test('1. new content leaves the quiz alone, and a reload brings it back where the user was', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const sid = `pw-island-state-${testInfo.project.name}-${Date.now()}`;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockSession(page, sid, quizIsland('KEEP'));
    await openSession(page, sid);
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    const island = panel.locator('iframe.rich-island');
    await expect(island).toHaveCount(1);
    const frame = panel.frameLocator('iframe.rich-island');
    await expect(frame.locator('#q')).toHaveText('KEEP-ONE score 0');
    await frame.locator('#right').click();
    await expect(frame.locator('#q')).toHaveText('KEEP-TWO score 1');

    // Mark the live document: a rebuilt frame would lose it.
    const handle = await island.elementHandle();
    const contentFrame = await handle!.contentFrame();
    await contentFrame!.evaluate(() => { (window as any).__alive = 'same-document'; });

    // New content streams into the session (the moment of the report).
    for (const delta of ['Next, a follow-up ', 'with more text ', 'and <b>some HTML</b>.']) {
      await injectEvent(page, 'session:text-delta', { sessionId: sid, taskId: TASK_ID, msgId: 'msg-new-turn', delta });
    }
    await expect(panel.locator('.session-history')).toContainText('some HTML');
    expect(await contentFrame!.evaluate(() => (window as any).__alive)).toBe('same-document');
    await expect(frame.locator('#q')).toHaveText('KEEP-TWO score 1');

    // Give the coalesced write time to land, then reload: the quiz is where it was.
    await page.waitForTimeout(400);
    await page.reload();
    await waitForWs(page);
    await expect(panel.frameLocator('iframe.rich-island').locator('#q')).toHaveText('KEEP-TWO score 1', { timeout: 15000 });
    await settled(panel.locator('iframe.rich-island'));
    await panel.frameLocator('iframe.rich-island').locator('#wrong').click();
    await expect(panel.frameLocator('iframe.rich-island').locator('#q')).toHaveText('KEEP-THREE score 1');

    mkdirSync(SHOT_DIR, { recursive: true });
    await panel.locator('iframe.rich-island').screenshot({ path: `${SHOT_DIR}/restored-${testInfo.project.name}.png` });
    expect(errors).toEqual([]);
  });

  test('2. the result is shown exactly, sent only on Send to AI, and remembered as sent', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const sid = `pw-island-result-${testInfo.project.name}-${Date.now()}`;
    await mockSession(page, sid, quizIsland('SEND'));
    await openSession(page, sid);
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    const frame = panel.frameLocator('iframe.rich-island');
    await expect(panel.locator('.island-result')).toHaveCount(0);
    await frame.locator('#right').click();
    await frame.locator('#wrong').click();
    await frame.locator('#right').click();
    await expect(frame.locator('#q')).toHaveText('DONE 2/3');

    const expected = 'Quiz result: 2/3 right.\nSEND-ONE: right\nSEND-TWO: wrong\nSEND-THREE: right';
    const card = panel.locator('.island-result');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.island-result-text')).toHaveText(expected);
    await expect(card).toContainText('Nothing is sent until you press Send.');
    // Offered, not sent.
    await page.waitForTimeout(500);
    expect(await sends(page)).toEqual([]);

    mkdirSync(SHOT_DIR, { recursive: true });
    await card.screenshot({ path: `${SHOT_DIR}/result-card-${testInfo.project.name}.png` });

    await card.getByRole('button', { name: 'Send to AI' }).click();
    await expect(card.locator('.island-result-title')).toHaveText('Sent to the AI');
    await expect(card.getByRole('button', { name: 'Send to AI' })).toHaveCount(0);
    const sent = await sends(page);
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe(sid);
    expect(sent[0].message).toBe(expected);
    // The user's own bubble carries the same text.
    await expect(panel.locator('.session-msg-user').last()).toContainText('Quiz result: 2/3 right.');

    // A reload: the finished quiz reports again on load, and is not offered twice.
    await page.waitForTimeout(400);
    await page.reload();
    await waitForWs(page);
    const card2 = panel.locator('.island-result');
    await expect(card2.locator('.island-result-title')).toHaveText('Sent to the AI', { timeout: 15000 });
    await expect(card2.getByRole('button', { name: 'Send to AI' })).toHaveCount(0);
    expect(await sends(page)).toEqual([]);

    // Retake: a new result is a new offer.
    const frame2 = panel.frameLocator('iframe.rich-island');
    await expect(frame2.locator('#q')).toHaveText('DONE 2/3');
    // After a reload the timeline scrolls to its end as history lands; a WebKit
    // click computed before that lands where the button used to be.
    await settled(panel.locator('iframe.rich-island'));
    await frame2.locator('#restart').click();
    await expect(frame2.locator('#q')).toHaveText('SEND-ONE score 0');
    for (let i = 0; i < 3; i++) await frame2.locator('#right').click();
    await expect(frame2.locator('#q')).toHaveText('DONE 3/3');
    await expect(card2.locator('.island-result-text')).toHaveText('Quiz result: 3/3 right.\nSEND-ONE: right\nSEND-TWO: right\nSEND-THREE: right');
    await expect(card2.getByRole('button', { name: 'Send to AI' })).toBeVisible();
    await card2.getByRole('button', { name: 'Dismiss result' }).click();
    await expect(panel.locator('.island-result')).toHaveCount(0);
    expect(await sends(page)).toEqual([]);
  });

  test('3. a result or state posted by another island, or the page, is ignored', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const sid = `pw-island-spoof-${testInfo.project.name}-${Date.now()}`;
    const other = '```html-app\n<p id="other">OTHER ISLAND</p>\n```';
    await mockSession(page, sid, `${quizIsland('SPOOF')}\n\nAnd another block:\n\n${other}`);
    await openSession(page, sid);
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    const islands = panel.locator('iframe.rich-island');
    await expect(islands).toHaveCount(2);
    await expect(panel.frameLocator('iframe.rich-island').first().locator('#q')).toHaveText('SPOOF-ONE score 0');
    const srcdoc = (await islands.first().getAttribute('srcdoc')) ?? '';
    const key = /var K="([^"]+)"/.exec(srcdoc)?.[1];
    expect(key).toBeTruthy();
    const forge = (k: string) => {
      const target = window === window.parent ? window : window.parent;
      target.postMessage({ t: 'wn-island-result', k, text: 'forged' }, '*');
      target.postMessage({ t: 'wn-island-state', k, items: { quiz: '{"i":2,"picks":["x","y"]}' } }, '*');
    };
    // From the page itself, and from the OTHER island's frame naming the quiz's key.
    await page.evaluate(forge, key!);
    const otherFrame = await (await islands.nth(1).elementHandle())!.contentFrame();
    await otherFrame!.evaluate(forge, key!);
    await page.waitForTimeout(800);
    await expect(panel.locator('.island-result')).toHaveCount(0);
    await page.reload();
    await waitForWs(page);
    await expect(panel.frameLocator('iframe.rich-island').first().locator('#q')).toHaveText('SPOOF-ONE score 0', { timeout: 15000 });
  });
});
