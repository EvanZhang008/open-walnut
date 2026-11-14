/**
 * Playwright browser test: two sends Claude Code merged into ONE line never leave
 * a "Delivered ✓" bubble at the bottom of the chat.
 *
 * THE BUG (inc-1794638780357, 2026-11-14, "the last message keeps showing as the
 * last one, it is like 5 messages old"): while a turn ran the user sent
 * "cr why is it neede" and "is the draft cr done". Claude Code 2.1.322 drained both
 * into one user line, "cr why is it neede\nis the draft cr done", written under the
 * SECOND send's uuid with the first one's in `mergedSendUuids`. The bubble dedup
 * proved the second bubble by that uuid and retired the line, so nothing could
 * prove the first: it stayed "Delivered ✓" below every later turn until a reload.
 *
 * Replays that session's shape through the REAL composer against a mocked
 * history/WS transport: a turn runs, two sends land and are delivered, the turn
 * ends and history holds the merged line; then three more sends, each its own
 * turn and row. After every turn no bubble may stay pending, the first send's
 * words show exactly once (inside the merged line), and the newest send is the
 * last user message on screen. Run twice: with the row's `mergedUuids` (this
 * build's parse) and without (a host daemon still on the older parser).
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-merged-sends-session';
const TASK_ID = 'pw-merged-sends-task';
test.use({ viewport: { width: 1280, height: 860 } });

type Row = { role: string; text: string; timestamp: string; msgId?: string; mergedUuids?: string[] };
const T0 = Date.UTC(2026, 10, 14, 6, 30, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function baseHistory(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ role: 'user', text: `earlier question ${i}`, timestamp: at(i * 10 - 1000), msgId: `u-old-${i}` });
    rows.push({ role: 'assistant', text: `earlier answer ${i}`, timestamp: at(i * 10 - 995), msgId: `a-old-${i}` });
  }
  rows.push({ role: 'user', text: 'bor why u add this?', timestamp: at(0), msgId: 'u-bor' });
  return rows;
}

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    if (!ws) throw new Error('No captured WebSocket — did addInitScript run?');
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }));
  }, { name, data });
}

async function waitForWs(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 15000 });
}

/** Each intercepted send: the qm id the mock answered and the uuid the client pre-assigned. */
async function sends(page: Page): Promise<Array<{ messageId: string; userUuid?: string; text: string }>> {
  return page.evaluate(() => (window as any).__sends ?? []);
}

async function sendViaUi(page: Page, text: string) {
  const input = page.locator('textarea[placeholder*="Send a message to this session"]').first();
  await input.click();
  await input.pressSequentially(text, { delay: 8 });
  await input.press('Enter');
}

/** The user messages on screen, top to bottom, with whether each still wears a pending badge. */
async function userTimeline(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.session-history .session-msg-user'))
    .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim()));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((enqueueBase: number) => {
    (window as any).__sends = [];
    // The test server is not a secure context, where crypto.randomUUID is missing and
    // a send carries no pre-assigned uuid; the Mac app and the phone always have it.
    if (typeof crypto.randomUUID !== 'function') {
      (crypto as any).randomUUID = () => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      };
    }
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this;
          const origSend = this.send.bind(this);
          let n = 0;
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:send') {
                intercepted = true;
                const messageId = `qm-pw${++n}`;
                (window as any).__sends.push({ messageId, userUuid: parsed.payload?.userUuid, text: parsed.payload?.message });
                const payload = { messageId, enqueuedAt: new Date(enqueueBase + n * 7000).toISOString() };
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload }) }));
                }, 10);
              }
              if (parsed.type === 'req' && (parsed.method === 'session:stream-subscribe' || parsed.method === 'session:get-queue')) {
                intercepted = true;
                const payload = parsed.method === 'session:get-queue' ? { messages: [] } : { blocks: [], isStreaming: false };
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload }) }));
                }, 10);
              }
            } catch { /* non-JSON */ }
            if (!intercepted) origSend(data);
          };
        }
      }
    } as any;
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]; } catch { /* read-only */ }
      }
    }
  }, T0 + 20_000);
});

async function mockSession(page: Page, rows: Row[]) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
          process_status: 'running', mode: 'bypass',
          startedAt: at(-2000), lastActiveAt: new Date().toISOString(),
          messageCount: rows.length, title: 'Merged sends replay',
        },
      },
    });
  });
  // A server-like history: the full array, or the rows past the client's cursor.
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null && Number(since) <= rows.length) {
      return route.fulfill({ json: { messages: rows.slice(Number(since)), cursor: rows.length, delta: true } });
    }
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
}

for (const listed of [true, false]) {
  test(`merged mid-turn sends collapse into their line (${listed ? 'row lists mergedUuids' : 'older parse, line uuid only'})`, async ({ page }, testInfo) => {
    const rows = baseHistory();
    await mockSession(page, rows);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');
    await waitForWs(page);
    const history = page.locator('.session-history');
    await expect(history).toContainText('bor why u add this?', { timeout: 15000 });
    const shot = (name: string) => page.screenshot({ path: `/tmp/merged-sends-bubble/${listed ? 'listed' : 'unlisted'}-${name}.png` });

    // ── Turn 1 runs; two sends land while it runs and are delivered together ──
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Checking why that was added', taskId: TASK_ID });
    const A = 'cr why is it neede';
    const B = 'is the draft cr done';
    await sendViaUi(page, A);
    await page.waitForTimeout(300);
    await sendViaUi(page, B);
    await page.waitForTimeout(300);
    const [sa, sb] = await sends(page);
    expect(sa?.userUuid, 'the client pre-assigns a uuid to each send').toBeTruthy();
    expect(sb?.userUuid).toBeTruthy();
    await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 2, messageIds: [sa.messageId, sb.messageId], taskId: TASK_ID });
    await expect(page.locator('.session-msg-delivered')).toHaveCount(2);
    await shot('1-two-delivered-midturn');

    // The CLI writes turn 1's answer, then ONE line for both sends, under B's uuid.
    rows.push({ role: 'assistant', text: 'Checking why that was added', timestamp: at(42), msgId: 'a-1' });
    rows.push({
      role: 'user', text: `${A}\n${B}`, timestamp: at(43), msgId: sb.userUuid!,
      ...(listed ? { mergedUuids: [sa.userUuid!] } : {}),
    });
    rows.push({ role: 'assistant', text: 'The draft CR is done.', timestamp: at(61), msgId: 'a-2' });
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });
    await expect(history).toContainText('The draft CR is done.', { timeout: 15000 });
    await expect(page.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 15000 });
    await shot('2-merged-line-absorbed-both');

    // ── Three more sends, each its own turn and row (the incident's later messages) ──
    const later = ['I meanwhy i create it', 'what is the problem', 'what is this tim fix why he ask u i am confused'];
    for (const [k, text] of later.entries()) {
      await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: `answer to later send ${k}`, taskId: TASK_ID });
      await sendViaUi(page, text);
      await page.waitForTimeout(300);
      const s = (await sends(page))[2 + k];
      await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [s.messageId], taskId: TASK_ID });
      rows.push({ role: 'user', text, timestamp: at(130 + k * 30), msgId: s.userUuid! });
      rows.push({ role: 'assistant', text: `answer to later send ${k}`, timestamp: at(140 + k * 30), msgId: `a-l${k}` });
      await injectEvent(page, 'session:result', { sessionId: SESSION_ID, taskId: TASK_ID, isError: false });
      await expect(history).toContainText(`answer to later send ${k}`, { timeout: 15000 });
      await expect(page.locator('.session-msg-delivered')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('.session-msg-queued')).toHaveCount(0);
    }
    await shot('3-after-five-sends-no-pinned-bubble');

    // The first send's words render once (inside the merged line), and the last
    // user message on screen is the newest send, not the old merged one.
    const users = await userTimeline(page);
    expect(users.filter((t) => t.includes(A)), `"${A}" shows exactly once`).toHaveLength(1);
    expect(users.at(-1)).toContain(later.at(-1)!);
    // textContent carries each row's action labels ("MD", "Rich", its age): match by words.
    const tail = users.slice(-4);
    expect(tail[0]).toContain(`${A}`);
    expect(tail[0]).toContain(B);
    later.forEach((text, k) => expect(tail[k + 1]).toContain(text));
    // Hold the final state a moment so the proof video shows it.
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(800);
    testInfo.annotations.push({ type: 'timeline', description: JSON.stringify(users.slice(-4)) });
  });
}
