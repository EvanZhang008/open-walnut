/**
 * A browser under automation is never the person, through the real server (2026-11-16: a
 * proof-video task typed into another task's composer through headless Chromium on the user's
 * own Walnut, and both rows read `sentBy: "person"`). Real sockets and real HTTP, the same doors the
 * web app uses: the console's `session:send` over /ws and the phone's POST .../messages.
 *
 * A throwaway server lets the automation stand in for the person (core/sessions/automated-client.ts),
 * so this one turns the rule on with WALNUT_AUTOMATED_CLIENT_AGENT=1, as the user's own install does.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-automated-client-sender'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { getQueue } from '../../src/core/session-message-queue.js';
import { readsAsPerson } from '../../src/core/sessions/send-frame.js';
import { transcriptSentBy } from '../../src/core/sessions/transcript-sent-by.js';

let port = 0;
const HEADLESS_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.0 Safari/537.36';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

function connect(query: string, ua: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws${query}`, { headers: { 'user-agent': ua } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}

function rpc(ws: WebSocket, method: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 20_000);
    const onMessage = (raw: Buffer | string) => {
      const frame = JSON.parse(raw.toString()) as { type: string; id?: string; ok?: boolean; error?: string };
      if (frame.type !== 'res' || frame.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve({ ok: !!frame.ok, error: frame.error });
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method, payload }));
  });
}

let n = 0;
async function session(): Promise<string> {
  const sid = `7a1e0c55-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  // A real task, made the way the person's console makes it: a send stamps its session.
  const res = await fetch(`http://localhost:${port}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `Automated probe ${n}`, project: 'Probe' }),
  });
  expect(res.status).toBe(201);
  const taskId = ((await res.json()) as { task: { id: string } }).task.id;
  await createSessionRecord(sid, taskId, 'Probe', WALNUT_HOME);
  await updateSessionRecord(sid, { process_status: 'stopped' });
  return sid;
}

/** A person's send to a fresh session, stamped; then `sid` (sent to before it) still is not. */
async function expectNoStampAfterControl(sid: string): Promise<void> {
  const control = await session();
  const ws = await connect('', SAFARI_UA);
  await rpc(ws, 'session:send', { sessionId: control, message: 'control words' });
  await vi.waitFor(async () => expect((await getSessionByClaudeId(control))?.humanInputAt).toBeTruthy(), { timeout: 10_000 });
  ws.close();
  expect((await getSessionByClaudeId(sid))?.humanInputAt).toBeUndefined();
}

/** The queue row a send left: who it says sent it, and the text the CLI gets. */
async function row(sid: string, words: string) {
  let found: { sentBy?: string; message: string } | undefined;
  await vi.waitFor(async () => {
    found = (await getQueue(sid)).find((m) => m.message.includes(words));
    expect(found).toBeTruthy();
  }, { timeout: 10_000 });
  return { sentBy: found!.sentBy, text: found!.message, transcript: transcriptSentBy({ role: 'user', text: found!.message }) };
}

beforeAll(async () => {
  process.env.WALNUT_AUTOMATED_CLIENT_AGENT = '1';
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  const server = await startServer({ port: 0, dev: true });
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await stopServer();
  delete process.env.WALNUT_AUTOMATED_CLIENT_AGENT;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
}, 20_000);

describe('the console composer (session:send over /ws)', () => {
  it('a window under automation (navigator.webdriver) sends as an agent, framed', async () => {
    const sid = await session();
    const ws = await connect('?lean=0&automated=webdriver', SAFARI_UA);
    expect((await rpc(ws, 'session:send', { sessionId: sid, message: 'Video step: start a subagent' })).ok).toBe(true);
    const r = await row(sid, 'Video step: start a subagent');
    expect(r.sentBy).toBe('agent');
    expect(readsAsPerson(r.text)).toBe(false);
    expect(r.text).toContain('browser automation (webdriver)');
    expect(r.transcript).toBe('agent');
    // The "a person wrote in it" stamp task_complete reads (transfer/source-in-use.ts) stays off,
    // though the send's own events run after the call answered: a person's send right after it
    // is stamped first, so this one had its turn.
    await expectNoStampAfterControl(sid);
    ws.close();
  }, 30_000);

  it('headless Chromium is an agent even when it declares nothing (CDP)', async () => {
    const sid = await session();
    const ws = await connect('', HEADLESS_UA);
    await rpc(ws, 'session:send', { sessionId: sid, message: 'typed over CDP' });
    const r = await row(sid, 'typed over CDP');
    expect(r.sentBy).toBe('agent');
    expect(r.transcript).toBe('agent');
    ws.close();
  }, 30_000);

  it('the person\'s own window still sends as the person, unframed', async () => {
    const sid = await session();
    const ws = await connect('?lean=0', SAFARI_UA);
    await rpc(ws, 'session:send', { sessionId: sid, message: 'My own question' });
    const r = await row(sid, 'My own question');
    expect(r.sentBy).toBe('person');
    // Typed words as typed (message hints may follow them), no Walnut envelope around them.
    expect(readsAsPerson(r.text)).toBe(true);
    expect(r.text).not.toContain('<walnut-message');
    expect(r.transcript).toBe('person');
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.humanInputAt).toBeTruthy(), { timeout: 10_000 });
    ws.close();
  }, 30_000);

  it('one automated socket does not taint the person\'s socket open beside it', async () => {
    const sid = await session();
    const bot = await connect('?automated=webdriver', SAFARI_UA);
    const me = await connect('', SAFARI_UA);
    await Promise.all([
      rpc(bot, 'session:send', { sessionId: sid, message: 'bot words' }),
      rpc(me, 'session:send', { sessionId: sid, message: 'my words' }),
    ]);
    expect((await row(sid, 'bot words')).sentBy).toBe('agent');
    expect((await row(sid, 'my words')).sentBy).toBe('person');
    bot.close(); me.close();
  }, 30_000);
});

describe('HTTP (the web app\'s fetch carries x-walnut-automated)', () => {
  const post = (sid: string, text: string, headers: Record<string, string>) => fetch(`http://localhost:${port}/api/v1/sessions/${sid}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text }),
  });

  it('a call from an automated window is an agent\'s and stamps nobody; the person\'s call is the person\'s', async () => {
    const botSid = await session();
    const mySid = await session();
    expect((await post(botSid, 'automated http words', { 'x-walnut-automated': 'webdriver', 'user-agent': SAFARI_UA })).status).toBeLessThan(300);
    const bot = await row(botSid, 'automated http words');
    expect(bot.sentBy).toBe('agent');
    expect(bot.transcript).toBe('agent');
    expect((await post(mySid, 'person http words', { 'user-agent': SAFARI_UA })).status).toBeLessThan(300);
    const me = await row(mySid, 'person http words');
    expect(me.sentBy).toBe('person');
    expect(me.transcript).toBe('person');
    await vi.waitFor(async () => expect((await getSessionByClaudeId(mySid))?.humanInputAt).toBeTruthy(), { timeout: 10_000 });
    expect((await getSessionByClaudeId(botSid))?.humanInputAt).toBeUndefined();
  }, 30_000);

  it('a task calling the same route is no person either', async () => {
    const sid = await session();
    expect((await post(sid, 'task via person route', { 'x-walnut-caller-sid': '00000000-0000-4000-8000-00000000abcd' })).status).toBeLessThan(300);
    expect((await row(sid, 'task via person route')).sentBy).toBe('agent');
    await expectNoStampAfterControl(sid);
  }, 30_000);
});

// Approvals are a tap on any device the person is signed in on (2026-11-21): a window under
// automation (an agent's Playwright, headless Chromium) is not one of them.
describe('the person-only doors of approvals (routes/approvals-v1.ts, routes/config.ts)', () => {
  const headersOf = (ua: string, automated = false) => ({ 'content-type': 'application/json', 'user-agent': ua, ...(automated ? { 'x-walnut-automated': 'webdriver' } : {}) });
  it('a window under automation can neither answer an approval nor move the switch; the person\'s window answers', async () => {
    const base = `http://localhost:${port}`;
    const made = await (await fetch(`${base}/api/v1/approvals`, { method: 'POST', headers: headersOf(SAFARI_UA), body: JSON.stringify({ what: 'Automated probe: approve me' }) })).json() as { approval: { id: string; digest: string } };
    const askMe = ((await (await fetch(`${base}/api/v1/approvals`, { headers: headersOf(SAFARI_UA) })).json()) as { askMe: boolean }).askMe;
    for (const headers of [headersOf(SAFARI_UA, true), headersOf(HEADLESS_UA)]) {
      const r = await fetch(`${base}/api/v1/approvals/${made.approval.id}/answer`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', digest: made.approval.digest }) });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { code: string }).code).toBe('human_only');
      const flip = await fetch(`${base}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ approvals: { ask_me: !askMe } }) });
      expect(flip.status).toBe(403);
    }
    expect(((await (await fetch(`${base}/api/v1/approvals`, { headers: headersOf(SAFARI_UA) })).json()) as { askMe: boolean }).askMe).toBe(askMe);
    const tap = await fetch(`${base}/api/v1/approvals/${made.approval.id}/answer`, { method: 'POST', headers: headersOf(SAFARI_UA), body: JSON.stringify({ decision: 'approve', digest: made.approval.digest }) });
    expect(tap.status).toBe(200);
  }, 30_000);
});
